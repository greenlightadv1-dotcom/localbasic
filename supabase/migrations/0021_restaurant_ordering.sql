-- =============================================================================
-- LOCAL BASIC — 0021 Restaurant ordering
--
-- PRICES ARE NEVER TAKEN FROM THE CLIENT. Callers — staff screens and
-- anonymous guests alike — send variant ids, quantities and modifier ids.
-- Every price, tax rate and total is read back from the database here.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Shared line builder.
--
-- Inserts the order's items and modifiers with price SNAPSHOTS, validates the
-- menu selection, and writes the totals back onto the order. Used by both the
-- staff and the public order paths so the two can never price differently.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_build_order_lines(
  p_org uuid, p_branch uuid, p_order uuid, p_items jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_item      jsonb;
  v_variant   record;
  v_qty       numeric(10,3);
  v_mod_ids   uuid[];
  v_mod       record;
  v_mods_sum  bigint;
  v_item_id   uuid;
  v_gross     bigint;
  v_tax       bigint;
  v_subtotal  bigint := 0;
  v_tax_total bigint := 0;
  v_position  int := 0;
  v_group     record;
  v_chosen    int;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'an order needs at least one item' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'too many items in one order' using errcode = 'check_violation';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select v.id, v.price_cents, v.name as variant_name, v.product_id,
           p.name as product_name, p.tax_rate_bp
      into v_variant
      from public.restaurant_variants v
      join public.restaurant_products p on p.id = v.product_id
     where v.id = (v_item ->> 'variant_id')::uuid
       and v.organization_id = p_org
       and v.is_active and v.deleted_at is null
       and p.is_active and p.deleted_at is null;

    if v_variant.id is null then
      raise exception 'unknown or unavailable menu item' using errcode = 'check_violation';
    end if;

    -- Branch availability: absence of a row means available, so a branch only
    -- has to record what it has run out of.
    if exists (
      select 1 from public.restaurant_branch_availability a
      where a.branch_id = p_branch and a.variant_id = v_variant.id and not a.is_available
    ) then
      raise exception 'item is not available at this branch' using errcode = 'check_violation';
    end if;

    v_qty := coalesce((v_item ->> 'quantity')::numeric, 0);
    if v_qty <= 0 or v_qty > 999 then
      raise exception 'invalid quantity' using errcode = 'check_violation';
    end if;

    -- Modifiers must belong to this product, be active, and satisfy each
    -- group's min/max. The guest's UI enforces this too; this is the copy
    -- that counts.
    v_mod_ids := coalesce(
      (select array_agg((value #>> '{}')::uuid)
         from jsonb_array_elements(coalesce(v_item -> 'modifier_ids', '[]'::jsonb))),
      array[]::uuid[]);

    if array_length(v_mod_ids, 1) > 30 then
      raise exception 'too many modifiers on one item' using errcode = 'check_violation';
    end if;

    for v_group in
      select g.id, g.name, g.min_select, g.max_select
      from public.restaurant_modifier_groups g
      where g.product_id = v_variant.product_id and g.is_active
    loop
      select count(*) into v_chosen
      from public.restaurant_modifiers m
      where m.group_id = v_group.id and m.id = any(v_mod_ids);

      if v_chosen < v_group.min_select or v_chosen > v_group.max_select then
        raise exception 'invalid selection for group %', v_group.name
          using errcode = 'check_violation';
      end if;
    end loop;

    v_mods_sum := 0;
    v_position := v_position + 1;

    insert into public.restaurant_order_items
      (order_id, organization_id, variant_id, product_name, variant_name,
       quantity, unit_price_cents, modifiers_cents, tax_rate_bp, line_total_cents,
       note, position)
    values
      (p_order, p_org, v_variant.id, v_variant.product_name, v_variant.variant_name,
       v_qty, v_variant.price_cents, 0, v_variant.tax_rate_bp, 0,
       nullif(trim(coalesce(v_item ->> 'note', '')), ''), v_position)
    returning id into v_item_id;

    for v_mod in
      select m.id, m.name, m.price_cents
      from public.restaurant_modifiers m
      join public.restaurant_modifier_groups g on g.id = m.group_id
      where m.id = any(v_mod_ids)
        and g.product_id = v_variant.product_id
        and m.is_active and g.is_active
        and m.organization_id = p_org
    loop
      insert into public.restaurant_order_item_modifiers
        (order_item_id, organization_id, modifier_id, name, price_cents)
      values (v_item_id, p_org, v_mod.id, v_mod.name, v_mod.price_cents);
      v_mods_sum := v_mods_sum + v_mod.price_cents;
    end loop;

    -- Integer arithmetic; one rounding per line, and one for its tax.
    v_gross := round((v_variant.price_cents + v_mods_sum) * v_qty);
    v_tax   := round((v_gross * v_variant.tax_rate_bp)::numeric / 10000);

    update public.restaurant_order_items
       set modifiers_cents = v_mods_sum,
           line_total_cents = v_gross + v_tax
     where id = v_item_id;

    v_subtotal  := v_subtotal + v_gross;
    v_tax_total := v_tax_total + v_tax;
  end loop;

  update public.restaurant_orders
     set subtotal_cents = v_subtotal,
         tax_cents      = v_tax_total,
         total_cents    = v_subtotal - discount_cents + v_tax_total
   where id = p_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- Staff order creation (cashier or waiter).
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_create_order(
  p_org         uuid,
  p_branch      uuid,
  p_items       jsonb,
  p_table_id    uuid default null,
  p_type        text default 'dine_in',
  p_channel     text default 'cashier',
  p_customer_id uuid default null,
  p_note        text default null
)
returns table (out_order_id uuid, out_number text, out_total_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_user     uuid := auth.uid();
  v_currency char(3);
  v_order    uuid;
  v_number   text;
  v_total    bigint;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.order.create') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select o.currency into v_currency
    from public.organizations o
    join public.branches b on b.organization_id = o.id
   where o.id = p_org and b.id = p_branch and b.is_active and b.deleted_at is null;
  if v_currency is null then
    raise exception 'branch does not belong to organization' using errcode = 'check_violation';
  end if;

  if p_table_id is not null and not exists (
    select 1 from public.restaurant_tables t
    where t.id = p_table_id and t.branch_id = p_branch and t.deleted_at is null
  ) then
    raise exception 'table does not belong to this branch' using errcode = 'check_violation';
  end if;

  v_number := app.next_document_number(p_org, p_branch, 'restaurant_order');

  insert into public.restaurant_orders
    (organization_id, branch_id, table_id, number, channel, type, status,
     customer_id, note, currency, created_by)
  values
    (p_org, p_branch, p_table_id, v_number, p_channel, p_type, 'new',
     p_customer_id, nullif(trim(coalesce(p_note, '')), ''), v_currency, v_user)
  returning id into v_order;

  perform app.restaurant_build_order_lines(p_org, p_branch, v_order, p_items);

  select total_cents into v_total from public.restaurant_orders where id = v_order;

  -- Seating the table is part of taking the order, not a separate step the
  -- floor has to remember.
  if p_table_id is not null then
    update public.restaurant_tables
       set status = 'occupied'
     where id = p_table_id and status in ('available', 'reserved');
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'restaurant.order.created', 'restaurant_order', v_order::text,
     jsonb_build_object('number', v_number, 'channel', p_channel, 'total_cents', v_total));

  return query select v_order, v_number, v_total;
end;
$$;

grant execute on function public.restaurant_create_order(
  uuid, uuid, jsonb, uuid, text, text, uuid, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Order status transitions.
--
-- Each transition demands the permission that matches the job doing it:
-- the kitchen advances preparation, the floor serves, the till completes and
-- confirms. The state machine trigger on the table rejects anything invalid
-- regardless of who asks.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_set_order_status(
  p_org      uuid,
  p_order    uuid,
  p_status   text,
  p_reason   text default null
)
returns table (out_status text)
language plpgsql security definer set search_path = '' as $$
declare
  v_user   uuid := auth.uid();
  v_order  record;
  v_needed text;
  v_ok     boolean;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select id, branch_id, status, table_id, total_cents, invoice_id
    into v_order
    from public.restaurant_orders
   where id = p_order and organization_id = p_org;
  if v_order.id is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;

  -- Which permission this particular move requires.
  v_needed := case p_status
    when 'confirmed' then 'restaurant.order.update'
    when 'preparing' then 'restaurant.kitchen.use'
    when 'ready'     then 'restaurant.kitchen.use'
    when 'served'    then 'restaurant.service.use'
    when 'completed' then 'restaurant.pos.use'
    when 'cancelled' then 'restaurant.order.cancel'
    else null
  end;
  if v_needed is null then
    raise exception 'unknown order status %', p_status using errcode = '22023';
  end if;

  v_ok := app.has_branch_permission(p_org, v_order.branch_id, v_needed);
  -- The till and the floor both legitimately confirm an order they just took.
  if not v_ok and p_status = 'confirmed' then
    v_ok := app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.pos.use')
         or app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.service.use');
  end if;
  if not v_ok then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if p_status = 'cancelled' and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'a cancellation needs a reason' using errcode = 'check_violation';
  end if;

  -- An order that has been paid cannot be cancelled; refund it through Core
  -- instead, so the money and the order never disagree.
  if p_status = 'cancelled' and v_order.invoice_id is not null then
    raise exception 'a paid order cannot be cancelled — issue a refund'
      using errcode = 'check_violation';
  end if;

  -- Completion means the money is settled.
  if p_status = 'completed' and v_order.invoice_id is null and v_order.total_cents > 0 then
    raise exception 'the order must be paid before it is completed'
      using errcode = 'check_violation';
  end if;

  update public.restaurant_orders
     set status = p_status,
         cancel_reason = case when p_status = 'cancelled' then p_reason else cancel_reason end
   where id = p_order;

  -- Free the table once the party is done or gone.
  if v_order.table_id is not null and p_status in ('completed', 'cancelled') then
    update public.restaurant_tables
       set status = 'cleaning'
     where id = v_order.table_id and status in ('occupied', 'waiting_payment');
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, before, after)
  values
    (p_org, v_order.branch_id, v_user, 'restaurant.order.status', 'restaurant_order',
     p_order::text,
     jsonb_build_object('status', v_order.status),
     jsonb_build_object('status', p_status, 'reason', p_reason));

  return query select p_status;
end;
$$;

grant execute on function public.restaurant_set_order_status(uuid, uuid, text, text)
to authenticated;
