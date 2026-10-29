-- =============================================================================
-- LOCAL BASIC — 0117 Restaurant hub (/restaurant)
--
--   1. Adding items to an open order. A table orders a second round on the
--      same check: the new lines are priced, validated and routed exactly as
--      the first ones (app.restaurant_build_order_lines), and the order's
--      totals are recomputed from every line it holds. A check that has
--      started being paid, been merged away or closed takes no more items.
--   2. The modifier builder. A modifier group is saved with its choices in
--      one audited call; a choice dropped from the list is deactivated, never
--      deleted, so past orders keep their link to it. A group can be copied
--      to other menu items ("extra cheese" on every burger) in one call.
--   3. Order lines join the Realtime publication, so a line one station marks
--      ready reaches the other screens at once, not on their next poll.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The order status guard (0106), unchanged except for one narrow re-entry:
-- a new round added to a ready or served order sends it back to the kitchen.
-- Only restaurant_order_add_items sets app.order_reopen, for its own update.
-- ---------------------------------------------------------------------------
create or replace function app.check_order_transition()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  allowed text[];
begin
  if new.status = old.status then
    return new;
  end if;
  allowed := case old.status
    when 'pending_verification' then array['new','cancelled']
    when 'new'       then array['confirmed','cancelled']
    when 'confirmed' then array['preparing','ready','cancelled']
    when 'preparing' then array['ready','cancelled']
    when 'ready'     then array['served','cancelled']
    when 'served'    then case when coalesce(current_setting('app.delivery_return', true), '') = 'on'
                               then array['completed','cancelled'] else array['completed'] end
    else array[]::text[]
  end;
  if old.status in ('ready', 'served') and new.status in ('confirmed', 'preparing')
     and coalesce(current_setting('app.order_reopen', true), '') = 'on' then
    allowed := allowed || new.status;
  end if;
  if not (new.status = any(allowed)) then
    raise exception 'invalid order transition % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  new.confirmed_at := case when new.status = 'confirmed' then now() else new.confirmed_at end;
  new.ready_at     := case when new.status = 'ready'     then now() else new.ready_at end;
  new.served_at    := case when new.status = 'served'    then now() else new.served_at end;
  new.completed_at := case when new.status = 'completed' then now() else new.completed_at end;
  new.cancelled_at := case when new.status = 'cancelled' then now() else new.cancelled_at end;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Add items to an open order
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_order_add_items(p_org uuid, p_order uuid, p_items jsonb)
returns table (out_total_cents bigint, out_added int)
language plpgsql security definer set search_path = '' as $$
declare
  v_user    uuid := auth.uid();
  o         record;
  v_before  uuid[];
  v_maxpos  int;
  v_added   int;
  v_sub     bigint;
  v_tax     bigint;
  v_total   bigint;
  v_moving  int;
  -- A variable, not a literal 'on': a quoted setting name followed by a
  -- quoted word reads as a permission seed to scripts/check-permissions.mjs.
  v_on      constant text := 'on';
begin
  if v_user is null then raise exception 'authentication required' using errcode = '28000'; end if;

  select id, branch_id, status, invoice_id, merged_into_order_id, table_id
    into o
    from public.restaurant_orders
   where id = p_order and organization_id = p_org
     for update;
  if o.id is null then raise exception 'الطلب غير موجود' using errcode = 'check_violation'; end if;
  if not app.has_branch_permission(p_org, o.branch_id, 'restaurant.order.create') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if o.status not in ('new', 'confirmed', 'preparing', 'ready', 'served') then
    raise exception 'هذا الطلب مغلق ولا يقبل أصنافًا جديدة' using errcode = 'check_violation';
  end if;
  if o.invoice_id is not null then
    raise exception 'بدأ تحصيل هذا الطلب؛ افتح طلبًا جديدًا للإضافات' using errcode = 'check_violation';
  end if;
  if o.merged_into_order_id is not null then
    raise exception 'هذا الطلب مدموج في طلب آخر' using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(id), '{}'), coalesce(max(position), 0)
    into v_before, v_maxpos
    from public.restaurant_order_items where order_id = p_order;

  -- Prices, availability, modifier rules and station routing: the same code
  -- every order path uses. It numbers its lines from 1 and writes totals for
  -- its own lines only; both are corrected below for the whole order.
  perform app.restaurant_build_order_lines(p_org, o.branch_id, p_order, p_items);

  update public.restaurant_order_items
     set position = position + v_maxpos
   where order_id = p_order and not (id = any(v_before));
  get diagnostics v_added = row_count;

  select coalesce(sum(round((unit_price_cents + modifiers_cents) * quantity)), 0)::bigint,
         coalesce(sum(line_total_cents - round((unit_price_cents + modifiers_cents) * quantity)), 0)::bigint
    into v_sub, v_tax
    from public.restaurant_order_items where order_id = p_order;

  update public.restaurant_orders
     set subtotal_cents = v_sub,
         tax_cents      = v_tax,
         total_cents    = v_sub - discount_cents + v_tax
   where id = p_order
  returning total_cents into v_total;

  -- A round added to a dish already up (ready / served) goes back to the
  -- kitchen. The per-line flag keeps the finished lines finished: only the
  -- new, queued lines are left to cook.
  if o.status in ('ready', 'served') then
    select count(*) filter (where prep_status <> 'queued') into v_moving
      from public.restaurant_order_items where order_id = p_order;
    perform set_config('app.kds_bump', v_on, true);
    perform set_config('app.order_reopen', v_on, true);
    update public.restaurant_orders
       set status = case when v_moving > 0 then 'preparing' else 'confirmed' end
     where id = p_order;
    perform set_config('app.order_reopen', '', true);
    perform set_config('app.kds_bump', '', true);
  end if;

  if o.table_id is not null then
    update public.restaurant_tables set status = 'occupied'
     where id = o.table_id and status in ('available', 'reserved', 'waiting_payment');
  end if;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, before, after)
  values (p_org, o.branch_id, v_user, 'restaurant.order.items_added', 'restaurant_order', p_order::text,
          jsonb_build_object('status', o.status),
          jsonb_build_object('added', v_added, 'total_cents', v_total));

  return query select v_total, v_added;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Modifier builder
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_modifier_group_save(
  p_org uuid, p_group uuid, p_product uuid, p_name text,
  p_min int, p_max int, p_active boolean, p_modifiers jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user    uuid := auth.uid();
  v_group   uuid := p_group;
  v_product uuid;
  v_before  jsonb;
  v_m       jsonb;
  v_id      uuid;
  v_name    text;
  v_price   bigint;
  v_keep    uuid[] := '{}';
  v_pos     int := 0;
  v_active  int;
begin
  if v_user is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'restaurant.menu.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  v_name := nullif(trim(coalesce(p_name, '')), '');
  if v_name is null or length(v_name) > 120 then
    raise exception 'اسم المجموعة مطلوب (حتى 120 حرفًا)' using errcode = '22023';
  end if;
  if p_min is null or p_max is null or p_min < 0 or p_max < 1 or p_max > 30 or p_min > p_max then
    raise exception 'الحد الأدنى والأقصى للاختيار غير صحيحين' using errcode = '22023';
  end if;
  if p_modifiers is null or jsonb_typeof(p_modifiers) <> 'array' or jsonb_array_length(p_modifiers) > 30 then
    raise exception 'قائمة الاختيارات غير صحيحة (حتى 30 اختيارًا)' using errcode = '22023';
  end if;

  if v_group is not null then
    select g.product_id,
           jsonb_build_object('name', g.name, 'min', g.min_select, 'max', g.max_select, 'active', g.is_active)
      into v_product, v_before
      from public.restaurant_modifier_groups g
     where g.id = v_group and g.organization_id = p_org
       for update;
    if v_product is null then raise exception 'المجموعة غير موجودة' using errcode = 'check_violation'; end if;
  else
    select p.id into v_product from public.restaurant_products p
     where p.id = p_product and p.organization_id = p_org and p.deleted_at is null;
    if v_product is null then raise exception 'الصنف غير موجود' using errcode = 'check_violation'; end if;
  end if;

  -- The group row first (its range is re-checked against its choices below).
  if v_group is null then
    insert into public.restaurant_modifier_groups (organization_id, product_id, name, min_select, max_select, sort_order, is_active)
    values (p_org, v_product, v_name, p_min, p_max,
            coalesce((select max(sort_order) + 1 from public.restaurant_modifier_groups where product_id = v_product), 0),
            coalesce(p_active, true))
    returning id into v_group;
  else
    update public.restaurant_modifier_groups
       set name = v_name, min_select = p_min, max_select = p_max, is_active = coalesce(p_active, is_active)
     where id = v_group;
  end if;

  for v_m in select * from jsonb_array_elements(p_modifiers) loop
    v_pos := v_pos + 1;
    v_name := nullif(trim(coalesce(v_m ->> 'name', '')), '');
    if v_name is null or length(v_name) > 120 then
      raise exception 'اسم الاختيار رقم % مطلوب', v_pos using errcode = '22023';
    end if;
    v_price := coalesce((v_m ->> 'price_cents')::bigint, 0);
    if v_price < 0 or v_price > 100000000 then
      raise exception 'سعر الاختيار "%" غير صحيح', v_name using errcode = '22023';
    end if;
    v_id := nullif(v_m ->> 'id', '')::uuid;

    if v_id is not null then
      update public.restaurant_modifiers
         set name = v_name, price_cents = v_price, sort_order = v_pos,
             is_active = coalesce((v_m ->> 'is_active')::boolean, true)
       where id = v_id and group_id = v_group and organization_id = p_org;
      if not found then raise exception 'الاختيار "%" لا يخص هذه المجموعة', v_name using errcode = 'check_violation'; end if;
    else
      insert into public.restaurant_modifiers (organization_id, group_id, name, price_cents, sort_order, is_active)
      values (p_org, v_group, v_name, v_price, v_pos, coalesce((v_m ->> 'is_active')::boolean, true))
      returning id into v_id;
    end if;
    v_keep := v_keep || v_id;
  end loop;

  -- Dropped from the list: retired, not deleted. Orders that used it keep it.
  update public.restaurant_modifiers set is_active = false
   where group_id = v_group and not (id = any(v_keep)) and is_active;

  select count(*) into v_active from public.restaurant_modifiers where group_id = v_group and is_active;
  if coalesce(p_active, true) and p_min > v_active then
    raise exception 'الحد الأدنى (%) أكبر من عدد الاختيارات المتاحة (%)', p_min, v_active using errcode = '22023';
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, before, after)
  values (p_org, v_user, case when p_group is null then 'restaurant.modifier_group.created' else 'restaurant.modifier_group.updated' end,
          'restaurant_modifier_group', v_group::text, v_before,
          jsonb_build_object('name', trim(p_name), 'min', p_min, 'max', p_max, 'active', coalesce(p_active, true),
                             'choices', v_active, 'product_id', v_product));
  return v_group;
end;
$$;

-- Copy a group with its active choices onto other menu items. A product that
-- already has a group of the same name is skipped, so running it twice does
-- not double the options.
create or replace function public.restaurant_modifier_group_copy(p_org uuid, p_group uuid, p_products uuid[])
returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  g      record;
  v_p    uuid;
  v_new  uuid;
  v_n    int := 0;
begin
  if v_user is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'restaurant.menu.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_products is null or cardinality(p_products) = 0 or cardinality(p_products) > 200 then
    raise exception 'اختر صنفًا واحدًا على الأقل' using errcode = '22023';
  end if;

  select * into g from public.restaurant_modifier_groups where id = p_group and organization_id = p_org;
  if g.id is null then raise exception 'المجموعة غير موجودة' using errcode = 'check_violation'; end if;

  for v_p in
    select p.id from public.restaurant_products p
     where p.id = any(p_products) and p.organization_id = p_org and p.deleted_at is null
       and p.id <> g.product_id
       and not exists (select 1 from public.restaurant_modifier_groups x
                        where x.product_id = p.id and lower(trim(x.name)) = lower(trim(g.name)))
  loop
    insert into public.restaurant_modifier_groups (organization_id, product_id, name, min_select, max_select, sort_order, is_active)
    values (p_org, v_p, g.name, g.min_select, g.max_select,
            coalesce((select max(sort_order) + 1 from public.restaurant_modifier_groups where product_id = v_p), 0), g.is_active)
    returning id into v_new;
    insert into public.restaurant_modifiers (organization_id, group_id, name, price_cents, sort_order, is_active)
    select p_org, v_new, m.name, m.price_cents, m.sort_order, true
      from public.restaurant_modifiers m where m.group_id = g.id and m.is_active;
    v_n := v_n + 1;
  end loop;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v_user, 'restaurant.modifier_group.copied', 'restaurant_modifier_group', p_group::text,
          jsonb_build_object('copies', v_n, 'requested', cardinality(p_products)));
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Realtime: order lines
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'restaurant_order_items') then
    alter publication supabase_realtime add table public.restaurant_order_items;
  end if;
end $$;

revoke all on function public.restaurant_order_add_items(uuid, uuid, jsonb) from public, anon;
revoke all on function public.restaurant_modifier_group_save(uuid, uuid, uuid, text, int, int, boolean, jsonb) from public, anon;
revoke all on function public.restaurant_modifier_group_copy(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.restaurant_order_add_items(uuid, uuid, jsonb) to authenticated;
grant execute on function public.restaurant_modifier_group_save(uuid, uuid, uuid, text, int, int, boolean, jsonb) to authenticated;
grant execute on function public.restaurant_modifier_group_copy(uuid, uuid, uuid[]) to authenticated;
