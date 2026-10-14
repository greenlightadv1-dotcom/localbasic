-- ---------------------------------------------------------------------------
-- 0097: restaurant customer directory + customer / device reset.
--
-- GUESTS are not rows in `customers`: an online or table-QR guest exists only
-- as a name and phone on their orders (and a verified device in
-- restaurant_guest_devices). The directory therefore groups orders by phone
-- (last nine digits, so 010…, +2010… and 2010… are one person) and merges in
-- any staff-created `customers` row.
--
--   orders       non-cancelled orders that were released from verification
--   spent        sum of COMPLETED orders (what actually closed)
--   points       the loyalty balance (0095's rule: floor(spent / cents_per_point)
--                minus points spent on coupons) — computed in one pass, not
--                one query per customer
--   devices      verified device bindings for the number
--
-- RESET removes every verified device binding for a phone, so the guest's next
-- order and the next opening of their profile require WhatsApp verification
-- again, and (optionally) soft-deletes their staff-created customer record.
-- Order history is NEVER deleted: invoices and takings stay intact, and the
-- history reappears for the number once it is verified again.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_customer_directory(p_org uuid, p_limit int default 1000)
returns table (
  out_phone           text,
  out_name            text,
  out_orders          int,
  out_spent_cents     bigint,
  out_points          int,
  out_loyalty_enabled boolean,
  out_last_order_at   timestamptz,
  out_devices         int,
  out_customer_id     uuid
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'customer.read') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  return query
  with s as (
    select coalesce((select cents_per_point from public.restaurant_loyalty_settings where organization_id = p_org), 1000) as cpp,
           coalesce((select enabled from public.restaurant_loyalty_settings where organization_id = p_org), false) as enabled
  ),
  o as (
    select app.phone_key(x.guest_phone) as k,
           (array_agg(x.guest_phone order by x.placed_at desc))[1] as phone,
           (array_agg(x.guest_name order by x.placed_at desc) filter (where x.guest_name is not null))[1] as name,
           count(*) filter (where x.status not in ('cancelled', 'pending_verification'))::int as orders,
           coalesce(sum(x.total_cents) filter (where x.status = 'completed'), 0)::bigint as spent,
           max(x.placed_at) filter (where x.status <> 'pending_verification') as last_at
      from public.restaurant_orders x
     where x.organization_id = p_org
       and x.guest_phone is not null
       and length(app.phone_key(x.guest_phone)) >= 7
     group by 1
    having count(*) filter (where x.status <> 'pending_verification') > 0
  ),
  c as (
    select distinct on (app.phone_key(cu.phone))
           app.phone_key(cu.phone) as k, cu.id, cu.name, cu.phone
      from public.customers cu
     where cu.organization_id = p_org and cu.deleted_at is null
       and cu.phone is not null and length(app.phone_key(cu.phone)) >= 7
     order by app.phone_key(cu.phone), cu.created_at desc
  ),
  d as (
    select app.phone_key(g.phone) as k, count(*)::int as n
      from public.restaurant_guest_devices g
     where g.organization_id = p_org and g.verified_at is not null
     group by 1
  ),
  cp as (
    select lc.phone_key as k, sum(lc.points_cost)::int as used
      from public.restaurant_loyalty_coupons lc
     where lc.organization_id = p_org and lc.status <> 'void'
     group by 1
  ),
  keys as (select o.k from o union select c.k from c)
  select coalesce(o.phone, c.phone),
         coalesce(o.name, c.name, ''),
         coalesce(o.orders, 0),
         coalesce(o.spent, 0),
         greatest(floor(coalesce(o.spent, 0)::numeric / (select cpp from s))::int - coalesce(cp.used, 0), 0),
         (select enabled from s),
         o.last_at,
         coalesce(d.n, 0),
         c.id
    from keys k
    left join o  on o.k  = k.k
    left join c  on c.k  = k.k
    left join d  on d.k  = k.k
    left join cp on cp.k = k.k
   order by o.last_at desc nulls last, coalesce(o.name, c.name)
   limit greatest(least(coalesce(p_limit, 1000), 5000), 1);
end;
$$;

create or replace function public.restaurant_customer_reset(
  p_org uuid, p_phone text, p_remove_customer boolean default true
) returns table (out_devices_removed int, out_customers_removed int)
language plpgsql security definer set search_path = '' as $$
declare
  v_user      uuid := auth.uid();
  v_key       text := app.phone_key(p_phone);
  v_devices   int := 0;
  v_customers int := 0;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  -- Editing a customer is the privilege this needs: it is destructive to the
  -- guest's trust relationship, so it is not part of just viewing the list.
  if not app.has_permission(p_org, 'customer.update') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if length(v_key) < 7 then
    raise exception 'رقم الهاتف غير صالح' using errcode = 'check_violation';
  end if;

  delete from public.restaurant_guest_devices
   where organization_id = p_org and app.phone_key(phone) = v_key;
  get diagnostics v_devices = row_count;

  if p_remove_customer then
    update public.customers
       set deleted_at = now()
     where organization_id = p_org and deleted_at is null
       and phone is not null and app.phone_key(phone) = v_key;
    get diagnostics v_customers = row_count;
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v_user, 'restaurant.customer.reset', 'organization', p_org::text,
          -- Only the last four digits: the log records WHO was reset, not a contact list.
          jsonb_build_object('phone_tail', right(v_key, 4), 'devices_removed', v_devices,
                             'customers_removed', v_customers, 'removed_customer', p_remove_customer));

  return query select v_devices, v_customers;
end;
$$;

revoke all on function public.restaurant_customer_directory(uuid, int) from public, anon;
revoke all on function public.restaurant_customer_reset(uuid, text, boolean) from public, anon;
grant execute on function public.restaurant_customer_directory(uuid, int) to authenticated;
grant execute on function public.restaurant_customer_reset(uuid, text, boolean) to authenticated;
