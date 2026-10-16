-- =============================================================================
-- LOCAL BASIC — executive analytics & BI: market basket, live food-cost
-- variance, speed of service, RFM, margin alerts, re-engagement campaigns
-- =============================================================================
-- READ FUNCTIONS (restaurant.analytics.executive; organization- or branch-wide)
--   restaurant_market_basket()      pairs of products bought in the same
--                                   completed order: support, confidence, lift.
--   restaurant_food_cost_variance() each dish's recipe priced three ways —
--                                   at the last purchase price before the
--                                   period, at the books' average cost, and at
--                                   the LATEST purchase price ("live") — with
--                                   the margin each gives; and each item's
--                                   purchase-price change.
--   restaurant_sos_stages()         per order: accept (placed → confirmed),
--                                   queue (confirmed → first KDS start), cook
--                                   (→ ready), hand-off (ready → served or
--                                   driver dispatch), delivery (dispatch →
--                                   delivered); count / avg / p50 / p90 by
--                                   order type; restaurant_sos_hourly() the
--                                   placed → ready time per hour of day.
--   restaurant_rfm_customers()      per customer phone (last 9 digits, the
--                                   0095 key): recency, frequency, monetary
--                                   over completed orders. Scoring and segments
--                                   are computed by the app (one tested rule).
--   restaurant_executive_kpis()     net revenue, COGS from the consumption
--                                   ledger, waste, labour (salary + driver
--                                   commission), other opex, net profit,
--                                   inventory value and turnover.
--
-- MARGIN ALERTS (restaurant_margin_alerts). A dish whose gross margin at book
-- cost falls below the organization's floor (default 65%) opens an alert and
-- an in-app notification to everyone who can see the dashboard. Triggers
-- re-evaluate the affected dishes when an ingredient's average cost changes
-- (every stock-in), when a price changes and when a recipe changes; the alert
-- resolves itself when the margin recovers.
--
-- CAMPAIGNS. restaurant_campaign_send() creates a one-off promo code (0107
-- 'code' promotion, capped at the number of recipients), records the
-- recipients and queues one SMS/WhatsApp message each in the 0050 outbox.
-- Recipients must be real customers of this organization (they ordered), and
-- anyone messaged in the last 7 days is skipped. The outbox reports delivery
-- honestly: without an SMS/WhatsApp provider the worker marks them failed.
-- restaurant_reengagement_run() is the automated version for customers lapsed
-- `lapse_days` (default 14) with 2+ orders — OFF until the owner enables it —
-- driven by the service-role worker (restaurant_analytics_worker()).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (key, group_key, module_key, description, is_elevated) values
  ('restaurant.analytics.executive', 'restaurant', 'restaurant', 'Executive dashboard: profit, basket, speed of service, customer segments', true),
  ('restaurant.campaign.send',       'restaurant', 'restaurant', 'Send promotional campaigns to customer segments', true)
on conflict (key) do update
  set description = excluded.description, group_key = excluded.group_key, module_key = excluded.module_key;

insert into public.role_permissions (role_id, permission_key)
select r.id, k
  from public.roles r cross join unnest(array['restaurant.analytics.executive', 'restaurant.campaign.send']) k
 where r.organization_id is null and r.key in ('manager', 'admin')
   and (r.module_key is null or r.module_key = 'restaurant')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select org_role.id, tp.permission_key
  from public.roles org_role
  join public.roles tpl on tpl.organization_id is null and tpl.is_system and tpl.key = org_role.key
                       and tpl.module_key is not distinct from org_role.module_key
  join public.role_permissions tp on tp.role_id = tpl.id
 where org_role.organization_id is not null
   and tp.permission_key in ('restaurant.analytics.executive', 'restaurant.campaign.send')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
 where r.is_owner and r.organization_id is not null
on conflict do nothing;

-- Organization or one branch: the read gate every function below uses.
create or replace function app.analytics_can_read(p_org uuid, p_branch uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case when p_branch is null then app.has_permission(p_org, 'restaurant.analytics.executive')
              else app.has_branch_permission(p_org, p_branch, 'restaurant.analytics.executive') end;
$$;

create or replace function app.analytics_window_check(p_from timestamptz, p_to timestamptz)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'الفترة غير صالحة' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create table public.restaurant_analytics_settings (
  organization_id      uuid primary key references public.organizations(id) on delete cascade,
  -- Gross margin floor in basis points: 6500 = a dish must keep 65% of its price after ingredients.
  margin_floor_bp      int not null default 6500 check (margin_floor_bp between 0 and 10000),
  lapse_days           int not null default 14 check (lapse_days between 3 and 365),
  auto_reengage        boolean not null default false,
  reengage_channel     text not null default 'whatsapp' check (reengage_channel in ('sms', 'whatsapp')),
  reengage_discount_bp int not null default 1000 check (reengage_discount_bp between 100 and 5000),
  reengage_valid_days  int not null default 14 check (reengage_valid_days between 1 and 90),
  reengage_message     text check (length(reengage_message) <= 500),
  last_reengage_run_at timestamptz,
  updated_by           uuid references auth.users(id),
  updated_at           timestamptz not null default now()
);

create or replace function app.analytics_settings(p_org uuid)
returns public.restaurant_analytics_settings language plpgsql stable security definer set search_path = '' as $$
declare v public.restaurant_analytics_settings%rowtype;
begin
  select * into v from public.restaurant_analytics_settings where organization_id = p_org;
  if v.organization_id is null then
    v.organization_id := p_org; v.margin_floor_bp := 6500; v.lapse_days := 14; v.auto_reengage := false;
    v.reengage_channel := 'whatsapp'; v.reengage_discount_bp := 1000; v.reengage_valid_days := 14;
  end if;
  return v;
end;
$$;

create or replace function public.restaurant_analytics_settings_save(
  p_org uuid, p_margin_floor_bp int, p_lapse_days int, p_auto boolean, p_channel text,
  p_discount_bp int, p_valid_days int, p_message text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'restaurant.analytics.executive') then raise exception 'not permitted' using errcode = '42501'; end if;
  -- Turning on automatic messages to customers is a campaign decision.
  if coalesce(p_auto, false) and not app.has_permission(p_org, 'restaurant.campaign.send') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  insert into public.restaurant_analytics_settings as s
    (organization_id, margin_floor_bp, lapse_days, auto_reengage, reengage_channel, reengage_discount_bp, reengage_valid_days, reengage_message, updated_by, updated_at)
  values (p_org, p_margin_floor_bp, p_lapse_days, coalesce(p_auto, false), p_channel, p_discount_bp, p_valid_days,
          nullif(trim(coalesce(p_message, '')), ''), auth.uid(), now())
  on conflict (organization_id) do update set
    margin_floor_bp = excluded.margin_floor_bp, lapse_days = excluded.lapse_days, auto_reengage = excluded.auto_reengage,
    reengage_channel = excluded.reengage_channel, reengage_discount_bp = excluded.reengage_discount_bp,
    reengage_valid_days = excluded.reengage_valid_days, reengage_message = excluded.reengage_message,
    updated_by = excluded.updated_by, updated_at = now();
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, auth.uid(), 'restaurant.analytics.settings', 'organization', p_org::text,
          jsonb_build_object('margin_floor_bp', p_margin_floor_bp, 'lapse_days', p_lapse_days, 'auto_reengage', p_auto,
                             'channel', p_channel, 'discount_bp', p_discount_bp));
  -- A new floor re-evaluates every dish at once.
  perform app.margin_check(p_org, null, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Market basket
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_market_basket(
  p_org uuid, p_branch uuid, p_from timestamptz, p_to timestamptz, p_min_together int default 2
) returns table (out_a_product uuid, out_a_name text, out_b_product uuid, out_b_name text,
                 out_together int, out_a_orders int, out_b_orders int, out_total_orders int,
                 out_support numeric, out_conf_a_b numeric, out_conf_b_a numeric, out_lift numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.analytics_can_read(p_org, p_branch) then raise exception 'not permitted' using errcode = '42501'; end if;
  perform app.analytics_window_check(p_from, p_to);
  return query
  with baskets as (
    select distinct o.id as order_id, v.product_id
      from public.restaurant_orders o
      join public.restaurant_order_items i on i.order_id = o.id
      join public.restaurant_variants v on v.id = i.variant_id
     where o.organization_id = p_org and o.status = 'completed'
       and o.completed_at >= p_from and o.completed_at < p_to
       and (p_branch is null or o.branch_id = p_branch)
  ), total as (select count(distinct order_id)::int as n from baskets),
  single as (select product_id, count(*)::int as n from baskets group by product_id),
  pairs as (
    select a.product_id as a, b.product_id as b, count(*)::int as n
      from baskets a join baskets b on a.order_id = b.order_id and a.product_id < b.product_id
     group by a.product_id, b.product_id
    having count(*) >= greatest(coalesce(p_min_together, 2), 1)
  )
  select p.a, pa.name, p.b, pb.name, p.n, sa.n, sb.n, t.n,
         round(p.n::numeric / nullif(t.n, 0), 4),
         round(p.n::numeric / nullif(sa.n, 0), 4),
         round(p.n::numeric / nullif(sb.n, 0), 4),
         round((p.n::numeric * t.n) / nullif(sa.n::numeric * sb.n, 0), 3)
    from pairs p cross join total t
    join single sa on sa.product_id = p.a
    join single sb on sb.product_id = p.b
    join public.restaurant_products pa on pa.id = p.a
    join public.restaurant_products pb on pb.id = p.b
   order by (p.n::numeric * t.n) / nullif(sa.n::numeric * sb.n, 0) desc, p.n desc
   limit 60;
end;
$$;

-- ---------------------------------------------------------------------------
-- Live food-cost variance
-- ---------------------------------------------------------------------------
-- An item's purchase price: the unit cost of its latest stock-in at or before a moment.
create or replace function app.item_purchase_price(p_item uuid, p_at timestamptz)
returns numeric language sql stable security definer set search_path = '' as $$
  select m.unit_cost_cents from public.inventory_movements m
   where m.item_id = p_item and m.reason = 'stock_in' and m.created_at <= p_at
   order by m.created_at desc, m.id desc limit 1;
$$;

create or replace function public.restaurant_food_cost_variance(p_org uuid, p_since timestamptz)
returns table (out_variant_id uuid, out_product_name text, out_variant_name text, out_category_name text,
               out_price_cents bigint, out_baseline_cost numeric, out_book_cost numeric, out_live_cost numeric,
               out_lines int, out_missing boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.analytics_can_read(p_org, null) then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_since is null or p_since > now() then raise exception 'التاريخ غير صالح' using errcode = '22023'; end if;
  return query
  with priced as (
    select rl.variant_id, rl.qty, ii.avg_cost_cents as book,
           coalesce(app.item_purchase_price(rl.item_id, now()), ii.avg_cost_cents) as live,
           coalesce(app.item_purchase_price(rl.item_id, p_since), app.item_purchase_price(rl.item_id, now()), ii.avg_cost_cents) as base
      from public.restaurant_recipe_lines rl
      join public.inventory_items ii on ii.id = rl.item_id
     where rl.organization_id = p_org
  )
  select v.id, p.name, v.name, c.name, v.price_cents::bigint,
         sum(pr.qty * pr.base)::numeric, sum(pr.qty * pr.book)::numeric, sum(pr.qty * pr.live)::numeric,
         count(*)::int, bool_or(pr.live = 0)
    from priced pr
    join public.restaurant_variants v on v.id = pr.variant_id and v.is_active and v.deleted_at is null
    join public.restaurant_products p on p.id = v.product_id and p.is_active and p.deleted_at is null
    left join public.restaurant_categories c on c.id = p.category_id
   group by v.id, p.name, v.name, c.name, v.price_cents
   order by p.name, v.name;
end;
$$;

-- Purchase-price movement per item since a date (only items bought in the period).
create or replace function public.restaurant_ingredient_price_changes(p_org uuid, p_since timestamptz)
returns table (out_item_id uuid, out_name text, out_unit text, out_price_before numeric, out_price_now numeric,
               out_avg_cost numeric, out_purchases int, out_used_in int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.analytics_can_read(p_org, null) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query
  select ii.id, ii.name, ii.unit, app.item_purchase_price(ii.id, p_since), app.item_purchase_price(ii.id, now()),
         ii.avg_cost_cents,
         (select count(*)::int from public.inventory_movements m where m.item_id = ii.id and m.reason = 'stock_in' and m.created_at > p_since),
         (select count(distinct rl.variant_id)::int from public.restaurant_recipe_lines rl where rl.item_id = ii.id)
    from public.inventory_items ii
   where ii.organization_id = p_org
     and exists (select 1 from public.inventory_movements m where m.item_id = ii.id and m.reason = 'stock_in' and m.created_at > p_since)
   order by ii.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Speed of service
-- ---------------------------------------------------------------------------
create or replace function app.sos_orders(p_org uuid, p_branch uuid, p_from timestamptz, p_to timestamptz)
returns table (order_id uuid, order_type text, placed_hour int,
               accept_s numeric, queue_s numeric, cook_s numeric, handoff_s numeric, delivery_s numeric, total_s numeric)
language sql stable security definer set search_path = '' as $$
  with o as (
    select o.id, o.type, o.placed_at, o.confirmed_at, o.ready_at, o.served_at,
           (select min(i.prep_started_at) from public.restaurant_order_items i where i.order_id = o.id) as kds_at,
           j.dispatched_at, j.delivered_at,
           extract(hour from o.placed_at at time zone coalesce(nullif(org.timezone, ''), 'Africa/Cairo'))::int as hr
      from public.restaurant_orders o
      join public.organizations org on org.id = o.organization_id
      left join public.restaurant_delivery_jobs j on j.order_id = o.id
     where o.organization_id = p_org and (p_branch is null or o.branch_id = p_branch)
       and o.placed_at >= p_from and o.placed_at < p_to
       and o.status in ('served', 'completed')
  )
  select id, type, hr,
         extract(epoch from (confirmed_at - placed_at)),
         extract(epoch from (kds_at - confirmed_at)),
         extract(epoch from (ready_at - coalesce(kds_at, confirmed_at))),
         extract(epoch from (coalesce(dispatched_at, served_at) - ready_at)),
         extract(epoch from (delivered_at - dispatched_at)),
         extract(epoch from (coalesce(delivered_at, served_at, ready_at) - placed_at))
    from o;
$$;

create or replace function public.restaurant_sos_stages(p_org uuid, p_branch uuid, p_from timestamptz, p_to timestamptz)
returns table (out_type text, out_stage text, out_n int, out_avg_s numeric, out_p50_s numeric, out_p90_s numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.analytics_can_read(p_org, p_branch) then raise exception 'not permitted' using errcode = '42501'; end if;
  perform app.analytics_window_check(p_from, p_to);
  return query
  with s as (
    select x.order_type, st.stage, st.secs
      from app.sos_orders(p_org, p_branch, p_from, p_to) x
      cross join lateral (values ('accept', x.accept_s), ('queue', x.queue_s), ('cook', x.cook_s),
                                 ('handoff', x.handoff_s), ('delivery', x.delivery_s), ('total', x.total_s)) st(stage, secs)
     where st.secs is not null and st.secs >= 0 and st.secs < 86400
  )
  select order_type, stage, count(*)::int, round(avg(secs), 1),
         round(percentile_cont(0.5) within group (order by secs)::numeric, 1),
         round(percentile_cont(0.9) within group (order by secs)::numeric, 1)
    from s group by order_type, stage
   order by order_type, array_position(array['accept', 'queue', 'cook', 'handoff', 'delivery', 'total'], stage);
end;
$$;

create or replace function public.restaurant_sos_hourly(p_org uuid, p_branch uuid, p_from timestamptz, p_to timestamptz)
returns table (out_hour int, out_orders int, out_avg_ready_s numeric, out_p90_ready_s numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.analytics_can_read(p_org, p_branch) then raise exception 'not permitted' using errcode = '42501'; end if;
  perform app.analytics_window_check(p_from, p_to);
  return query
  select x.placed_hour, count(*)::int,
         round(avg(coalesce(x.accept_s, 0) + coalesce(x.queue_s, 0) + coalesce(x.cook_s, 0)), 1),
         round(percentile_cont(0.9) within group (order by coalesce(x.accept_s, 0) + coalesce(x.queue_s, 0) + coalesce(x.cook_s, 0))::numeric, 1)
    from app.sos_orders(p_org, p_branch, p_from, p_to) x
   where x.cook_s is not null and x.cook_s >= 0
   group by x.placed_hour
   order by x.placed_hour;
end;
$$;

-- ---------------------------------------------------------------------------
-- RFM base data
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_rfm_customers(p_org uuid, p_days int default 365)
returns table (out_phone_key text, out_phone text, out_name text, out_first_order_at timestamptz, out_last_order_at timestamptz,
               out_orders int, out_monetary_cents bigint, out_delivery_orders int, out_last_contacted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.analytics_can_read(p_org, null) then raise exception 'not permitted' using errcode = '42501'; end if;
  return query
  with o as (
    select app.phone_key(coalesce(nullif(o.guest_phone, ''), c.phone)) as k,
           coalesce(nullif(o.guest_phone, ''), c.phone) as phone, coalesce(nullif(o.guest_name, ''), c.name) as name,
           o.placed_at, o.total_cents, o.type
      from public.restaurant_orders o
      left join public.customers c on c.id = o.customer_id
     where o.organization_id = p_org and o.status = 'completed'
       and o.placed_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 365), 30), 730))
  )
  select o.k, (array_agg(o.phone order by o.placed_at desc))[1], (array_agg(o.name order by o.placed_at desc) filter (where o.name is not null))[1],
         min(o.placed_at), max(o.placed_at), count(*)::int, sum(o.total_cents)::bigint,
         count(*) filter (where o.type = 'delivery')::int,
         (select max(r.created_at) from public.restaurant_campaign_recipients r where r.organization_id = p_org and r.phone_key = o.k)
    from o
   where length(o.k) >= 9
   group by o.k
   order by max(o.placed_at) desc
   limit 5000;
end;
$$;

-- ---------------------------------------------------------------------------
-- Executive KPIs
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_executive_kpis(p_org uuid, p_branch uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_gross bigint; v_tax bigint; v_disc bigint; v_orders int; v_refunds bigint;
  v_cogs numeric; v_waste_all numeric; v_waste_manual numeric;
  v_labor bigint; v_opex bigint; v_supplies bigint;
  v_inv_now numeric; v_inv_signed numeric; v_inv_delta numeric; v_inv_start numeric;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.analytics_can_read(p_org, p_branch) then raise exception 'not permitted' using errcode = '42501'; end if;
  perform app.analytics_window_check(p_from, p_to);

  select coalesce(sum(total_cents), 0), coalesce(sum(tax_cents), 0), coalesce(sum(discount_cents), 0), count(*)
    into v_gross, v_tax, v_disc, v_orders
    from public.restaurant_orders
   where organization_id = p_org and status = 'completed' and completed_at >= p_from and completed_at < p_to
     and (p_branch is null or branch_id = p_branch);

  select coalesce(sum(case direction when 'out' then amount_cents else 0 end) filter (where category = 'refund'), 0),
         coalesce(sum(amount_cents) filter (where direction = 'out' and category in ('salary', 'driver_commission')), 0),
         coalesce(sum(amount_cents) filter (where direction = 'out' and category in ('maintenance', 'utilities', 'rent', 'other', 'driver_shortage')), 0),
         coalesce(sum(amount_cents) filter (where direction = 'out' and category = 'supplies'), 0)
    into v_refunds, v_labor, v_opex, v_supplies
    from public.treasury_transactions
   where organization_id = p_org and occurred_at >= p_from and occurred_at < p_to
     and (p_branch is null or branch_id = p_branch);

  -- COGS: what the consumption ledger took out (net of what was given back).
  select coalesce(sum(-m.qty * m.unit_cost_cents) filter (where m.reason in ('consumption', 'consumption_reversal')), 0)
    into v_cogs
    from public.inventory_movements m
   where m.organization_id = p_org and m.created_at >= p_from and m.created_at < p_to
     and (p_branch is null or m.branch_id = p_branch);

  select coalesce(sum(cost_cents), 0), coalesce(sum(cost_cents) filter (where moved_stock), 0)
    into v_waste_all, v_waste_manual
    from public.inventory_waste
   where organization_id = p_org and created_at >= p_from and created_at < p_to
     and (p_branch is null or branch_id = p_branch);

  -- Inventory value now (positive balances at average cost) and at the start
  -- of the period (now, minus what moved in or out of the stock-holding
  -- locations since).
  select coalesce(sum(greatest(lv.qty, 0) * ii.avg_cost_cents), 0), coalesce(sum(lv.qty * ii.avg_cost_cents), 0)
    into v_inv_now, v_inv_signed
    from public.inventory_levels lv
    join public.inventory_locations l on l.id = lv.location_id and l.kind in ('warehouse', 'kitchen', 'bar', 'transit')
    join public.inventory_items ii on ii.id = lv.item_id
   where lv.organization_id = p_org and (p_branch is null or lv.branch_id = p_branch);
  select coalesce(sum(m.qty * m.unit_cost_cents), 0) into v_inv_delta
    from public.inventory_movements m
    join public.inventory_locations l on l.id = m.location_id and l.kind in ('warehouse', 'kitchen', 'bar', 'transit')
   where m.organization_id = p_org and m.created_at >= p_from and (p_branch is null or m.branch_id = p_branch);
  -- From the signed balance: a station below zero (book stock lagging a
  -- delivery) must not count as stock that was there at the start.
  v_inv_start := greatest(v_inv_signed - v_inv_delta, 0);

  return jsonb_build_object(
    'orders', v_orders,
    'gross_cents', v_gross, 'tax_cents', v_tax, 'discount_cents', v_disc, 'refund_cents', v_refunds,
    'net_revenue_cents', v_gross - v_tax - v_refunds,
    'cogs_cents', round(v_cogs), 'waste_cents', round(v_waste_all), 'waste_manual_cents', round(v_waste_manual),
    'labor_cents', v_labor, 'opex_cents', v_opex, 'supplies_cents', v_supplies,
    'inventory_now_cents', round(v_inv_now), 'inventory_start_cents', round(v_inv_start),
    'days', round(extract(epoch from (least(p_to, now()) - p_from)) / 86400.0, 2));
end;
$$;

-- ---------------------------------------------------------------------------
-- Margin alerts
-- ---------------------------------------------------------------------------
create table public.restaurant_margin_alerts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  variant_id       uuid not null references public.restaurant_variants(id) on delete cascade,
  status           text not null default 'open' check (status in ('open', 'resolved')),
  price_cents      bigint not null,
  cost_cents       numeric(14, 2) not null,
  margin_bp        int not null,
  floor_bp         int not null,
  -- The margin when the alert opened, to show how far it has moved since.
  opened_margin_bp int not null,
  cause_item_id    uuid references public.inventory_items(id) on delete set null,
  opened_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  acknowledged_by  uuid references auth.users(id),
  acknowledged_at  timestamptz
);
create unique index restaurant_margin_alerts_open_uq on public.restaurant_margin_alerts(variant_id) where status = 'open';
create index restaurant_margin_alerts_org_idx on public.restaurant_margin_alerts(organization_id, status, opened_at desc);

-- Re-evaluates the dishes using p_item (or one variant, or all) against the floor.
create or replace function app.margin_check(p_org uuid, p_item uuid, p_variant uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare
  s public.restaurant_analytics_settings%rowtype := app.analytics_settings(p_org);
  r record;
  v_alert uuid;
  v_opened int := 0;
begin
  for r in
    select v.id as variant_id, v.price_cents, coalesce(sum(rl.qty * ii.avg_cost_cents), 0) as cost,
           p.name as product_name, v.name as variant_name
      from public.restaurant_variants v
      join public.restaurant_products p on p.id = v.product_id
      join public.restaurant_recipe_lines rl on rl.variant_id = v.id
      join public.inventory_items ii on ii.id = rl.item_id
     where v.organization_id = p_org and v.deleted_at is null and v.is_active and p.deleted_at is null and p.is_active
       and v.price_cents > 0
       and (p_variant is null or v.id = p_variant)
       and (p_item is null or exists (select 1 from public.restaurant_recipe_lines x where x.variant_id = v.id and x.item_id = p_item))
     group by v.id, v.price_cents, p.name, v.name
  loop
    if round((r.price_cents - r.cost) * 10000.0 / r.price_cents) < s.margin_floor_bp then
      update public.restaurant_margin_alerts
         set price_cents = r.price_cents, cost_cents = round(r.cost, 2),
             margin_bp = round((r.price_cents - r.cost) * 10000.0 / r.price_cents), floor_bp = s.margin_floor_bp,
             cause_item_id = coalesce(p_item, cause_item_id), updated_at = now()
       where variant_id = r.variant_id and status = 'open'
      returning id into v_alert;
      if v_alert is null then
        insert into public.restaurant_margin_alerts
          (organization_id, variant_id, price_cents, cost_cents, margin_bp, floor_bp, opened_margin_bp, cause_item_id)
        values (p_org, r.variant_id, r.price_cents, round(r.cost, 2), round((r.price_cents - r.cost) * 10000.0 / r.price_cents),
                s.margin_floor_bp, round((r.price_cents - r.cost) * 10000.0 / r.price_cents), p_item)
        returning id into v_alert;
        v_opened := v_opened + 1;
        -- Tell everyone who watches margins, once per alert.
        insert into public.notifications (organization_id, user_id, channel, template, payload, dedupe_key)
        select p_org, m.user_id, 'inapp', 'restaurant.margin.below_floor',
               jsonb_build_object('product', r.product_name, 'variant', r.variant_name,
                                  'margin_pct', round((r.price_cents - r.cost) * 100.0 / r.price_cents, 1),
                                  'floor_pct', round(s.margin_floor_bp / 100.0, 1), 'alert_id', v_alert),
               'margin:' || v_alert::text || ':' || m.user_id::text
          from public.organization_members m
         where m.organization_id = p_org and m.status = 'active'
           and exists (select 1 from public.user_roles ur
                         join public.role_permissions rp on rp.role_id = ur.role_id
                        where ur.member_id = m.id and rp.permission_key = 'restaurant.analytics.executive')
        on conflict do nothing;
      end if;
      v_alert := null;
    else
      update public.restaurant_margin_alerts set status = 'resolved', resolved_at = now(), updated_at = now(),
             margin_bp = round((r.price_cents - r.cost) * 10000.0 / r.price_cents)
       where variant_id = r.variant_id and status = 'open';
    end if;
  end loop;
  -- A dish whose recipe was emptied, or that left the menu, has no margin to watch.
  if p_variant is not null and not exists (select 1 from public.restaurant_recipe_lines where variant_id = p_variant) then
    update public.restaurant_margin_alerts set status = 'resolved', resolved_at = now(), updated_at = now()
     where variant_id = p_variant and status = 'open';
  end if;
  return v_opened;
end;
$$;

create or replace function app.margin_on_item_cost()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.avg_cost_cents is distinct from old.avg_cost_cents then
    perform app.margin_check(new.organization_id, new.id, null);
  end if;
  return null;
end;
$$;
create trigger inventory_items_margin_check after update of avg_cost_cents on public.inventory_items
  for each row execute function app.margin_on_item_cost();

create or replace function app.margin_on_price()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.price_cents is distinct from old.price_cents or new.is_active is distinct from old.is_active
     or new.deleted_at is distinct from old.deleted_at then
    perform app.margin_check(new.organization_id, null, new.id);
    if not new.is_active or new.deleted_at is not null then
      update public.restaurant_margin_alerts set status = 'resolved', resolved_at = now(), updated_at = now()
       where variant_id = new.id and status = 'open';
    end if;
  end if;
  return null;
end;
$$;
create trigger restaurant_variants_margin_check after update on public.restaurant_variants
  for each row execute function app.margin_on_price();

create or replace function app.margin_on_recipe()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform app.margin_check(coalesce(new.organization_id, old.organization_id), null, coalesce(new.variant_id, old.variant_id));
  return null;
end;
$$;
-- Deferred to commit: a recipe save replaces every line (delete + insert), and
-- the dish must be judged on the saved recipe, not on the empty one between.
create constraint trigger restaurant_recipe_lines_margin_check after insert or update or delete on public.restaurant_recipe_lines
  deferrable initially deferred
  for each row execute function app.margin_on_recipe();

create or replace function public.restaurant_margin_alert_ack(p_org uuid, p_alert uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.analytics_can_read(p_org, null) then raise exception 'not permitted' using errcode = '42501'; end if;
  update public.restaurant_margin_alerts set acknowledged_by = auth.uid(), acknowledged_at = now()
   where id = p_alert and organization_id = p_org;
  if not found then raise exception 'التنبيه غير موجود' using errcode = 'check_violation'; end if;
end;
$$;

create or replace function public.restaurant_margin_scan(p_org uuid)
returns int language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.analytics_can_read(p_org, null) then raise exception 'not permitted' using errcode = '42501'; end if;
  return app.margin_check(p_org, null, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------
create table public.restaurant_campaigns (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 120),
  segment          text not null check (segment in ('vip', 'loyal', 'active', 'new', 'at_risk', 'lapsed', 'custom')),
  channel          text not null check (channel in ('sms', 'whatsapp')),
  message          text not null check (length(trim(message)) between 1 and 500),
  promotion_id     uuid references public.restaurant_promotions(id) on delete set null,
  promo_code       text,
  recipients       int not null default 0,
  skipped_recent   int not null default 0,
  auto_generated   boolean not null default false,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now()
);
create index restaurant_campaigns_org_idx on public.restaurant_campaigns(organization_id, created_at desc);

create table public.restaurant_campaign_recipients (
  id               bigint generated always as identity primary key,
  campaign_id      uuid not null references public.restaurant_campaigns(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  phone_key        text not null,
  phone            text not null,
  name             text,
  notification_id  uuid references public.notifications(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (campaign_id, phone_key)
);
create index restaurant_campaign_recipients_key_idx on public.restaurant_campaign_recipients(organization_id, phone_key, created_at desc);

-- The shared engine: a promo code, the recipients, one outbox message each.
create or replace function app.campaign_create(
  p_org uuid, p_name text, p_segment text, p_channel text, p_message text, p_phones jsonb,
  p_discount_bp int, p_valid_days int, p_auto boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id    uuid;
  v_promo uuid;
  v_code  text;
  v_org   text;
  v_p     jsonb;
  v_key   text;
  v_phone text;
  v_n     int := 0;
  v_skip  int := 0;
  v_notif uuid;
  v_msg   text := trim(coalesce(p_message, ''));
  v_keys  text[];
begin
  if p_channel not in ('sms', 'whatsapp') then raise exception 'قناة غير معروفة' using errcode = '22023'; end if;
  if length(v_msg) not between 1 and 500 then raise exception 'نص الرسالة مطلوب (حتى 500 حرف)' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_phones, 'null')) <> 'array' or jsonb_array_length(p_phones) = 0 or jsonb_array_length(p_phones) > 2000 then
    raise exception 'لا يوجد مستلمون' using errcode = '22023';
  end if;
  if p_discount_bp is not null and (p_discount_bp < 100 or p_discount_bp > 5000) then
    raise exception 'نسبة الخصم بين 1%% و 50%%' using errcode = '22023';
  end if;
  select name into v_org from public.organizations where id = p_org;
  -- This organization's customers: anyone with a completed order here.
  select array_agg(distinct k) into v_keys from (
    select app.phone_key(o.guest_phone) as k from public.restaurant_orders o
     where o.organization_id = p_org and o.status = 'completed' and nullif(o.guest_phone, '') is not null
    union
    select app.phone_key(c.phone) from public.restaurant_orders o join public.customers c on c.id = o.customer_id
     where o.organization_id = p_org and o.status = 'completed' and nullif(c.phone, '') is not null
  ) x;

  insert into public.restaurant_campaigns (organization_id, name, segment, channel, message, auto_generated, created_by)
  values (p_org, left(trim(p_name), 120), p_segment, p_channel, v_msg, coalesce(p_auto, false), auth.uid())
  returning id into v_id;

  for v_p in select * from jsonb_array_elements(p_phones) loop
    v_phone := trim(coalesce(v_p ->> 'phone', ''));
    v_key := app.phone_key(v_phone);
    continue when length(v_key) < 9;
    -- Only this organization's own customers.
    continue when not (v_key = any (coalesce(v_keys, array[]::text[])));
    -- Nobody hears from us twice in a week.
    if exists (select 1 from public.restaurant_campaign_recipients r
                where r.organization_id = p_org and r.phone_key = v_key and r.created_at > now() - interval '7 days') then
      v_skip := v_skip + 1;
      continue;
    end if;
    insert into public.restaurant_campaign_recipients (campaign_id, organization_id, phone_key, phone, name)
    values (v_id, p_org, v_key, v_phone, left(nullif(trim(v_p ->> 'name'), ''), 120))
    on conflict (campaign_id, phone_key) do nothing;
    if found then v_n := v_n + 1; end if;
  end loop;

  if v_n = 0 then
    delete from public.restaurant_campaigns where id = v_id;
    return jsonb_build_object('campaign_id', null, 'recipients', 0, 'skipped_recent', v_skip, 'code', null);
  end if;

  if p_discount_bp is not null then
    for i in 1..5 loop
      v_code := 'BACK-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
      begin
        insert into public.restaurant_promotions (organization_id, name, kind, is_active, starts_at, ends_at, percent_bp, code, max_uses)
        values (p_org, left('حملة: ' || trim(p_name), 120), 'code', true, now(),
                now() + make_interval(days => greatest(coalesce(p_valid_days, 14), 1)), p_discount_bp, v_code, v_n)
        returning id into v_promo;
        exit;
      exception when unique_violation then v_code := null;
      end;
    end loop;
    update public.restaurant_campaigns set promotion_id = v_promo, promo_code = v_code where id = v_id;
  end if;

  for v_key, v_phone in select r.phone_key, r.phone from public.restaurant_campaign_recipients r where r.campaign_id = v_id loop
    insert into public.notifications (organization_id, recipient, channel, template, payload, dedupe_key)
    values (p_org, v_phone, p_channel, 'restaurant.campaign',
            jsonb_build_object('organization', v_org, 'message', v_msg, 'code', v_code, 'campaign_id', v_id),
            'campaign:' || v_id::text || ':' || v_key)
    on conflict do nothing
    returning id into v_notif;
    update public.restaurant_campaign_recipients set notification_id = v_notif where campaign_id = v_id and phone_key = v_key;
  end loop;

  update public.restaurant_campaigns set recipients = v_n, skipped_recent = v_skip where id = v_id;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, auth.uid(), case when p_auto then 'restaurant.campaign.auto' else 'restaurant.campaign.sent' end,
          'restaurant_campaign', v_id::text,
          jsonb_build_object('segment', p_segment, 'channel', p_channel, 'recipients', v_n, 'skipped', v_skip, 'code', v_code));
  return jsonb_build_object('campaign_id', v_id, 'recipients', v_n, 'skipped_recent', v_skip, 'code', v_code);
end;
$$;

create or replace function public.restaurant_campaign_send(
  p_org uuid, p_name text, p_segment text, p_channel text, p_message text, p_phones jsonb, p_discount_bp int, p_valid_days int
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'restaurant.campaign.send') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_segment not in ('vip', 'loyal', 'active', 'new', 'at_risk', 'lapsed', 'custom') then
    raise exception 'شريحة غير معروفة' using errcode = '22023';
  end if;
  perform app.rate_limit('rl_campaign_send', p_org::text, 20, 86400);
  return app.campaign_create(p_org, coalesce(nullif(trim(p_name), ''), 'حملة'), p_segment, p_channel, p_message, p_phones,
                             p_discount_bp, p_valid_days, false);
end;
$$;

-- Lapsed regulars (2+ orders, none for lapse_days), not messaged in 30 days:
-- one automatic campaign per organization per day, only when switched on.
create or replace function app.reengagement_run(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.restaurant_analytics_settings%rowtype := app.analytics_settings(p_org);
  v_phones jsonb;
  v_res jsonb;
begin
  if not s.auto_reengage then return jsonb_build_object('skipped', 'disabled'); end if;
  if s.last_reengage_run_at is not null and s.last_reengage_run_at > now() - interval '20 hours' then
    return jsonb_build_object('skipped', 'ran_recently');
  end if;
  update public.restaurant_analytics_settings set last_reengage_run_at = now() where organization_id = p_org;

  with c as (
    select app.phone_key(o.guest_phone) as k, (array_agg(o.guest_phone order by o.placed_at desc))[1] as phone,
           (array_agg(o.guest_name order by o.placed_at desc))[1] as name, max(o.placed_at) as last_at, count(*) as n
      from public.restaurant_orders o
     where o.organization_id = p_org and o.status = 'completed' and nullif(o.guest_phone, '') is not null
       and o.placed_at > now() - interval '365 days'
     group by app.phone_key(o.guest_phone)
  )
  select coalesce(jsonb_agg(jsonb_build_object('phone', c.phone, 'name', c.name)), '[]'::jsonb) into v_phones
    from c
   where c.n >= 2 and c.last_at < now() - make_interval(days => s.lapse_days) and length(c.k) >= 9
     and not exists (select 1 from public.restaurant_campaign_recipients r
                      where r.organization_id = p_org and r.phone_key = c.k and r.created_at > now() - interval '30 days');
  if jsonb_array_length(v_phones) = 0 then return jsonb_build_object('recipients', 0); end if;

  v_res := app.campaign_create(p_org, 'استرجاع العملاء — تلقائي', 'lapsed', s.reengage_channel,
             coalesce(s.reengage_message, 'وحشتنا! اطلب الآن واستخدم الكود للحصول على خصم.'),
             v_phones, s.reengage_discount_bp, s.reengage_valid_days, true);
  return v_res;
end;
$$;

-- The service worker: re-engagement for organizations that switched it on.
create or replace function public.restaurant_analytics_worker()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; v_out jsonb := '[]'::jsonb; v jsonb;
begin
  for r in select organization_id from public.restaurant_analytics_settings where auto_reengage loop
    v := app.reengagement_run(r.organization_id);
    v_out := v_out || jsonb_build_object('organization_id', r.organization_id, 'result', v);
  end loop;
  return jsonb_build_object('organizations', jsonb_array_length(v_out), 'runs', v_out);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['restaurant_analytics_settings', 'restaurant_margin_alerts', 'restaurant_campaigns', 'restaurant_campaign_recipients'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

create policy restaurant_analytics_settings_select on public.restaurant_analytics_settings for select to authenticated
  using (app.has_permission(organization_id, 'restaurant.analytics.executive'));
create policy restaurant_margin_alerts_select on public.restaurant_margin_alerts for select to authenticated
  using (app.has_permission(organization_id, 'restaurant.analytics.executive') or app.has_permission(organization_id, 'inventory.manage'));
create policy restaurant_campaigns_select on public.restaurant_campaigns for select to authenticated
  using (app.has_permission(organization_id, 'restaurant.analytics.executive') or app.has_permission(organization_id, 'restaurant.campaign.send'));
create policy restaurant_campaign_recipients_select on public.restaurant_campaign_recipients for select to authenticated
  using (app.has_permission(organization_id, 'restaurant.campaign.send'));

do $$
declare f text;
begin
  foreach f in array array[
    'app.analytics_can_read(uuid, uuid)', 'app.analytics_window_check(timestamptz, timestamptz)',
    'app.analytics_settings(uuid)', 'app.item_purchase_price(uuid, timestamptz)',
    'app.sos_orders(uuid, uuid, timestamptz, timestamptz)', 'app.margin_check(uuid, uuid, uuid)',
    'app.margin_on_item_cost()', 'app.margin_on_price()', 'app.margin_on_recipe()',
    'app.campaign_create(uuid, text, text, text, text, jsonb, integer, integer, boolean)', 'app.reengagement_run(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  foreach f in array array[
    'public.restaurant_analytics_settings_save(uuid, integer, integer, boolean, text, integer, integer, text)',
    'public.restaurant_market_basket(uuid, uuid, timestamptz, timestamptz, integer)',
    'public.restaurant_food_cost_variance(uuid, timestamptz)',
    'public.restaurant_ingredient_price_changes(uuid, timestamptz)',
    'public.restaurant_sos_stages(uuid, uuid, timestamptz, timestamptz)',
    'public.restaurant_sos_hourly(uuid, uuid, timestamptz, timestamptz)',
    'public.restaurant_rfm_customers(uuid, integer)',
    'public.restaurant_executive_kpis(uuid, uuid, timestamptz, timestamptz)',
    'public.restaurant_margin_alert_ack(uuid, uuid)',
    'public.restaurant_margin_scan(uuid)',
    'public.restaurant_campaign_send(uuid, text, text, text, text, jsonb, integer, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  revoke all on function public.restaurant_analytics_worker() from public, anon, authenticated;
  grant execute on function public.restaurant_analytics_worker() to service_role;
end $$;
