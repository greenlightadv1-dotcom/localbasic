-- ---------------------------------------------------------------------------
-- 0089: who handled each order stage, and per-employee monthly performance.
--
-- NO NEW TRACKING. Every order lifecycle step already writes an audit_logs row
-- whose actor_id is taken from the session and cannot be forged (app.write_audit
-- / the definer RPCs):
--     restaurant.order.created | restaurant.online_order.created  (creation)
--     restaurant.order.status   after.status = confirmed|preparing|ready|served|
--                                               completed|cancelled
--     restaurant.order.paid     (payment / settlement, with amount_cents)
-- so these two READ-ONLY functions derive the trail and the analytics from that
-- history. Orders placed before this migration are covered too.
--
-- Both are SECURITY DEFINER because audit_logs is readable only with audit.read
-- at organization level; each re-checks its own permission, branch by branch.
-- ---------------------------------------------------------------------------

-- ----- 1. The staff trail of one order ------------------------------------
-- One row per stage, with the person who performed it. 'created' is the first
-- occurrence; every other stage is the LAST occurrence (a payment split over
-- two cashiers reports the one who cleared it).
create or replace function public.restaurant_order_staff_trail(p_org uuid, p_order uuid)
returns table (out_stage text, out_actor_id uuid, out_actor_name text, out_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_branch uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select o.branch_id into v_branch
    from public.restaurant_orders o
   where o.id = p_order and o.organization_id = p_org;
  if v_branch is null then
    raise exception 'order not found' using errcode = '22023';
  end if;
  if not app.has_branch_permission(p_org, v_branch, 'audit.read') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  return query
  with ev as (
    select al.created_at, al.actor_id, al.actor_label,
           case
             when al.action in ('restaurant.order.created', 'restaurant.online_order.created') then 'created'
             when al.action = 'restaurant.order.paid' then 'paid'
             when al.action = 'restaurant.order.status' then al.after ->> 'status'
           end as stage
      from public.audit_logs al
     where al.organization_id = p_org
       and al.entity_type = 'restaurant_order'
       and al.entity_id = p_order::text
  )
  select distinct on (ev.stage)
         ev.stage, ev.actor_id, coalesce(p.full_name, ev.actor_label), ev.created_at
    from ev
    left join public.profiles p on p.id = ev.actor_id
   where ev.stage is not null
   order by ev.stage,
            case when ev.stage = 'created' then extract(epoch from ev.created_at)
                 else -extract(epoch from ev.created_at) end;
end;
$$;

revoke all on function public.restaurant_order_staff_trail(uuid, uuid) from public, anon;
grant execute on function public.restaurant_order_staff_trail(uuid, uuid) to authenticated;

-- ----- 2. One employee's month ---------------------------------------------
-- p_month is any date inside the month wanted; the window is that calendar
-- month in the ORGANIZATION'S timezone. Rows outside the branches the caller
-- may report on are left out, so a branch manager never sees another branch.
--
--   handled            distinct orders the person touched at any stage
--   created/confirmed/prepared/served/paid   stage counts (prepared = marked ready)
--   avg_prep_seconds   ready time minus the LAST 'preparing' before it, falling
--                      back to the confirmation, then the arrival time. Only
--                      durations up to 4 hours count: a ticket left open
--                      overnight is a forgotten ticket, not preparation time —
--                      those are reported separately as prep_outliers.
--   collected_cents    sum of payments the person took
--   created_sales_cents  total of the non-cancelled orders the person created
create or replace function public.restaurant_staff_performance(
  p_org uuid, p_user uuid, p_month date
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz     text;
  v_from   timestamptz;
  v_to     timestamptz;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not (app.has_permission(p_org, 'report.read') or app.has_permission(p_org, 'member.manage')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organization_members m
     where m.organization_id = p_org and m.user_id = p_user
  ) then
    raise exception 'member not found' using errcode = '22023';
  end if;

  select coalesce(o.timezone, 'Africa/Cairo') into v_tz
    from public.organizations o where o.id = p_org;
  v_from := date_trunc('month', coalesce(p_month, current_date))::timestamp at time zone v_tz;
  v_to   := (date_trunc('month', coalesce(p_month, current_date)) + interval '1 month')::timestamp at time zone v_tz;

  with st as (
    select al.entity_id,
           al.created_at as at,
           (al.created_at at time zone v_tz)::date as day,
           case
             when al.action in ('restaurant.order.created', 'restaurant.online_order.created') then 'created'
             when al.action = 'restaurant.order.paid' then 'paid'
             when al.action = 'restaurant.order.status' then al.after ->> 'status'
           end as stage,
           case when al.action = 'restaurant.order.paid'
                then coalesce((al.after ->> 'amount_cents')::bigint, 0) else 0 end as amount
      from public.audit_logs al
     where al.organization_id = p_org
       and al.actor_id = p_user
       and al.entity_type = 'restaurant_order'
       and al.created_at >= v_from and al.created_at < v_to
       and (app.has_branch_permission(p_org, al.branch_id, 'report.read')
            or app.has_branch_permission(p_org, al.branch_id, 'member.manage'))
  ),
  st2 as (
    select s.*, o.total_cents, o.status as order_status,
           case when s.stage = 'ready' then
             extract(epoch from (s.at - coalesce(
               (select max(a2.created_at)
                  from public.audit_logs a2
                 where a2.organization_id = p_org
                   and a2.entity_type = 'restaurant_order'
                   and a2.entity_id = s.entity_id
                   and a2.action = 'restaurant.order.status'
                   and a2.after ->> 'status' = 'preparing'
                   and a2.created_at <= s.at),
               o.confirmed_at, o.placed_at)))
           end as prep_secs
      from st s
      left join public.restaurant_orders o on o.id = s.entity_id::uuid
     where s.stage is not null
  ),
  agg as (
    select day,
           count(distinct entity_id)                                              as handled,
           count(*) filter (where stage = 'created')                              as created,
           count(*) filter (where stage = 'confirmed')                            as confirmed,
           count(*) filter (where stage = 'ready')                                as prepared,
           count(*) filter (where stage = 'served')                               as served,
           count(distinct entity_id) filter (where stage = 'paid')                as paid,
           coalesce(sum(amount) filter (where stage = 'paid'), 0)                 as collected_cents,
           coalesce(sum(total_cents) filter (where stage = 'created'
                                              and order_status <> 'cancelled'), 0) as created_sales_cents,
           round(avg(prep_secs) filter (where stage = 'ready' and prep_secs between 0 and 14400))::bigint as avg_prep_seconds,
           count(*) filter (where stage = 'ready' and prep_secs > 14400)          as prep_outliers
      from st2
     group by grouping sets ((day), ())
  )
  select jsonb_build_object(
           'month_start', v_from,
           'month_end', v_to,
           'timezone', v_tz,
           'totals', coalesce((select to_jsonb(a) - 'day' from agg a where a.day is null),
                              jsonb_build_object('handled', 0, 'created', 0, 'confirmed', 0, 'prepared', 0,
                                                 'served', 0, 'paid', 0, 'collected_cents', 0,
                                                 'created_sales_cents', 0, 'avg_prep_seconds', null,
                                                 'prep_outliers', 0)),
           'days', coalesce((select jsonb_agg(to_jsonb(a) order by a.day) from agg a where a.day is not null),
                            '[]'::jsonb)
         )
    into v_result;

  return v_result;
end;
$$;

revoke all on function public.restaurant_staff_performance(uuid, uuid, date) from public, anon;
grant execute on function public.restaurant_staff_performance(uuid, uuid, date) to authenticated;
