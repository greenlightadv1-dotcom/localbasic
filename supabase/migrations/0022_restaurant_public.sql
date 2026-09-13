-- =============================================================================
-- LOCAL BASIC — 0022 Restaurant public surface (QR menu + guest ordering)
--
-- A guest is anonymous. They hold an opaque token and nothing else: no
-- organization id, no branch id, no table id, no session.
--
-- The anon role has no privilege on any restaurant table. Everything below is
-- SECURITY DEFINER and returns a narrow projection — menu text, prices,
-- availability — and never costs, staff, customers or other orders.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Resolve a table QR token to its restaurant, branch and table.
--
-- Returns nothing for a revoked, expired or unknown token, so an invalid QR is
-- indistinguishable from one that never existed.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_public_context(p_token text)
returns table (
  organization_name text,
  branch_name       text,
  table_name        text,
  currency          char(3),
  locale            text,
  logo_url          text,
  primary_color     text,
  secondary_color   text,
  white_label       boolean,
  phone             text,
  whatsapp          text,
  ordering_enabled  boolean
)
language sql stable security definer set search_path = '' as $$
  select
    coalesce(bs.display_name, o.name),
    b.name,
    t.name,
    o.currency,
    o.default_locale,
    bs.logo_url,
    coalesce(bs.primary_color, '#1E2FC8'),
    coalesce(bs.secondary_color, '#6B8BFA'),
    coalesce(bs.white_label, false),
    bs.phone,
    bs.whatsapp,
    -- A restaurant can turn guest ordering off and use the QR as a menu only.
    coalesce(
      (select (s.value #>> '{}')::boolean from public.settings s
        where s.organization_id = o.id and s.branch_id is null
          and s.key = 'restaurant.public_ordering_enabled'),
      true)
  from public.public_links pl
  join public.organizations o on o.id = pl.organization_id
  join public.branches b      on b.id = pl.branch_id
  join public.restaurant_tables t
    on t.id = (pl.target ->> 'entity_id')::uuid
   and t.branch_id = pl.branch_id
  left join public.branding_settings bs on bs.organization_id = o.id
  where pl.token = p_token
    and pl.kind = 'menu'
    and pl.is_active and pl.revoked_at is null
    and (pl.expires_at is null or pl.expires_at > now())
    and o.status = 'active' and o.deleted_at is null
    and b.is_active and b.deleted_at is null
    and t.is_active and t.deleted_at is null;
$$;

grant execute on function public.restaurant_public_context(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The menu a guest sees.
--
-- Only what belongs on a menu: names, descriptions, images, prices and
-- modifier choices. Cost prices, internal ids of other entities, stock,
-- staff and customers are all absent by construction.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_public_menu(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org    uuid;
  v_branch uuid;
  v_menu   jsonb;
begin
  select pl.organization_id, pl.branch_id into v_org, v_branch
  from public.public_links pl
  join public.organizations o on o.id = pl.organization_id
  join public.branches b on b.id = pl.branch_id
  where pl.token = p_token
    and pl.kind = 'menu'
    and pl.is_active and pl.revoked_at is null
    and (pl.expires_at is null or pl.expires_at > now())
    and o.status = 'active' and o.deleted_at is null
    and b.is_active and b.deleted_at is null;

  if v_org is null then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(category order by category_sort, category_name), '[]'::jsonb)
    into v_menu
  from (
    select
      c.sort_order as category_sort,
      c.name as category_name,
      jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'description', c.description,
        'image_url', c.image_url,
        'products', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', p.id,
              'name', p.name,
              'description', p.description,
              'image_url', p.image_url,
              'variants', coalesce((
                select jsonb_agg(
                  jsonb_build_object(
                    'id', v.id,
                    'name', v.name,
                    'price_cents', v.price_cents,
                    'available', not exists (
                      select 1 from public.restaurant_branch_availability a
                      where a.branch_id = v_branch and a.variant_id = v.id
                        and not a.is_available
                    )
                  ) order by v.sort_order, v.name)
                from public.restaurant_variants v
                where v.product_id = p.id and v.is_active and v.deleted_at is null
              ), '[]'::jsonb),
              'modifier_groups', coalesce((
                select jsonb_agg(
                  jsonb_build_object(
                    'id', g.id,
                    'name', g.name,
                    'min_select', g.min_select,
                    'max_select', g.max_select,
                    'modifiers', coalesce((
                      select jsonb_agg(
                        jsonb_build_object('id', m.id, 'name', m.name, 'price_cents', m.price_cents)
                        order by m.sort_order, m.name)
                      from public.restaurant_modifiers m
                      where m.group_id = g.id and m.is_active
                    ), '[]'::jsonb)
                  ) order by g.sort_order, g.name)
                from public.restaurant_modifier_groups g
                where g.product_id = p.id and g.is_active
              ), '[]'::jsonb)
            ) order by p.sort_order, p.name)
          from public.restaurant_products p
          where p.category_id = c.id and p.is_active and p.deleted_at is null
        ), '[]'::jsonb)
      ) as category
    from public.restaurant_categories c
    where c.organization_id = v_org and c.is_active
  ) rows;

  return v_menu;
end;
$$;

grant execute on function public.restaurant_public_menu(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Guest order placement.
--
-- No account required. The token identifies the branch and table; everything
-- else the guest sends is either validated or ignored. Prices come from the
-- database via the same line builder the staff path uses.
--
-- An order arrives as 'new' and waits for the till or the floor to confirm it,
-- so a scan can never push work into the kitchen on its own.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_place_public_order(
  p_token       text,
  p_items       jsonb,
  p_guest_name  text default null,
  p_guest_phone text default null,
  p_note        text default null
)
returns table (out_order_number text, out_total_cents bigint, out_status_token text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_branch   uuid;
  v_table    uuid;
  v_currency char(3);
  v_enabled  boolean;
  v_order    uuid;
  v_number   text;
  v_total    bigint;
  v_open     int;
begin
  select pl.organization_id, pl.branch_id, t.id, o.currency
    into v_org, v_branch, v_table, v_currency
  from public.public_links pl
  join public.organizations o on o.id = pl.organization_id
  join public.branches b on b.id = pl.branch_id
  join public.restaurant_tables t
    on t.id = (pl.target ->> 'entity_id')::uuid and t.branch_id = pl.branch_id
  where pl.token = p_token
    and pl.kind = 'menu'
    and pl.is_active and pl.revoked_at is null
    and (pl.expires_at is null or pl.expires_at > now())
    and o.status = 'active' and o.deleted_at is null
    and b.is_active and b.deleted_at is null
    and t.is_active and t.deleted_at is null;

  if v_org is null then
    raise exception 'this QR code is no longer active' using errcode = 'check_violation';
  end if;

  select coalesce((select (s.value #>> '{}')::boolean from public.settings s
                    where s.organization_id = v_org and s.branch_id is null
                      and s.key = 'restaurant.public_ordering_enabled'), true)
    into v_enabled;
  if not v_enabled then
    raise exception 'ordering from the QR code is disabled' using errcode = 'check_violation';
  end if;

  -- A table cannot accumulate unbounded unconfirmed orders from a scan; this
  -- caps the damage a single token can do between rate-limit windows.
  select count(*) into v_open
  from public.restaurant_orders
  where table_id = v_table and status = 'new' and placed_at > now() - interval '1 hour';
  if v_open >= 10 then
    raise exception 'too many open orders for this table' using errcode = 'check_violation';
  end if;

  v_number := app.next_document_number(v_org, v_branch, 'restaurant_order');

  insert into public.restaurant_orders
    (organization_id, branch_id, table_id, number, channel, type, status,
     guest_name, guest_phone, note, currency, created_by)
  values
    (v_org, v_branch, v_table, v_number, 'qr', 'dine_in', 'new',
     nullif(trim(coalesce(p_guest_name, '')), ''),
     nullif(trim(coalesce(p_guest_phone, '')), ''),
     nullif(trim(coalesce(p_note, '')), ''),
     v_currency, null)
  returning id into v_order;

  perform app.restaurant_build_order_lines(v_org, v_branch, v_order, p_items);

  select total_cents into v_total from public.restaurant_orders where id = v_order;

  update public.restaurant_tables
     set status = 'occupied'
   where id = v_table and status in ('available', 'reserved');

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (v_org, v_branch, null, 'restaurant.order.created', 'restaurant_order', v_order::text,
     jsonb_build_object('number', v_number, 'channel', 'qr', 'total_cents', v_total));

  -- The guest gets the order number to follow, never the order's id.
  return query select v_number, v_total, v_number;
end;
$$;

grant execute on function public.restaurant_place_public_order(text, jsonb, text, text, text)
to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Order status for a guest following their order.
--
-- Scoped to the same token, so a guest can only see orders for the table they
-- are sitting at, and only the parts of them that concern the guest.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_public_order_status(
  p_token text, p_number text
)
returns table (number text, status text, total_cents bigint, placed_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.number, o.status, o.total_cents, o.placed_at
  from public.public_links pl
  join public.restaurant_tables t
    on t.id = (pl.target ->> 'entity_id')::uuid and t.branch_id = pl.branch_id
  join public.restaurant_orders o
    on o.table_id = t.id and o.number = p_number
  where pl.token = p_token
    and pl.kind = 'menu'
    and pl.is_active and pl.revoked_at is null
    and o.placed_at > now() - interval '12 hours';
$$;

grant execute on function public.restaurant_public_order_status(text, text) to anon, authenticated;
