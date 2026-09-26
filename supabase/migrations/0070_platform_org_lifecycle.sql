-- =============================================================================
-- LOCAL BASIC — 0070 Platform organization lifecycle
--
-- Four Platform Admin operations that did not exist before this migration:
--   * adjust the days left on an active term without a payment,
--   * switch a plan starting fresh from now — the opposite of a renewal,
--     which extends from whatever is left,
--   * reset a customer's transactional data, keeping their setup intact,
--   * delete a customer's workspace outright.
--
-- The last two are irreversible against production data, so both require:
--   1. app.is_platform_owner() — 'staff' admins cannot call them, only 'owner';
--   2. the caller to echo back the customer_code exactly, so a slip on the
--      wrong row in a long list cannot silently wipe the wrong customer.
-- =============================================================================

-- Adding 'days_adjusted' alongside the existing event types rather than a new
-- table: it is still one line in the same append-only ledger the renewal path
-- already writes to.
alter table public.subscription_events drop constraint subscription_events_event_type_check;
alter table public.subscription_events add constraint subscription_events_event_type_check
  check (event_type in (
    'created', 'renewed', 'plan_changed', 'trial_granted', 'cancelled', 'expired', 'days_adjusted'
  ));

-- ---------------------------------------------------------------------------
-- Adjust the remaining days on the live term. Positive extends, negative
-- shortens (including into the past, which effectively expires it now) — the
-- one guard is that the result cannot land before the term started.
-- ---------------------------------------------------------------------------
create or replace function public.platform_adjust_subscription_days(
  p_organization_id uuid,
  p_delta_days      int,
  p_note            text default null
)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_sub   public.subscriptions%rowtype;
  v_plan  public.plans%rowtype;
  v_new_end timestamptz;
  v_event bigint;
  v_actor uuid := auth.uid();
  v_label text;
begin
  perform app.require_platform_admin();

  if p_delta_days = 0 then
    raise exception 'delta must not be zero' using errcode = '22023';
  end if;

  select * into v_sub
    from public.subscriptions
   where organization_id = p_organization_id
     and status in ('trialing', 'active', 'past_due')
   for update;

  if not found then
    raise exception 'no active subscription for this organization' using errcode = '22023';
  end if;

  v_new_end := v_sub.current_period_end + make_interval(days => p_delta_days);
  if v_new_end <= v_sub.current_period_start then
    raise exception 'adjustment would end the term before it started' using errcode = '22023';
  end if;

  select * into v_plan from public.plans where id = v_sub.plan_id;
  select full_name into v_label from public.profiles where id = v_actor;

  update public.subscriptions set current_period_end = v_new_end where id = v_sub.id;

  insert into public.subscription_events (
    organization_id, subscription_id, event_type, plan_id, billing_period,
    period_start, period_end, gross_cents, discount_cents, net_cents, currency,
    payment_method, note, created_by, created_by_label
  ) values (
    p_organization_id, v_sub.id, 'days_adjusted', v_sub.plan_id, v_sub.billing_period,
    v_sub.current_period_start, v_new_end, 0, 0, 0, coalesce(v_plan.currency, 'EGP'),
    'none',
    coalesce(p_note, '') || format(' (%s%s يوم)', case when p_delta_days > 0 then '+' else '' end, p_delta_days),
    v_actor, v_label
  ) returning id into v_event;

  perform app.write_audit(
    p_organization_id, null, 'platform.subscription_days_adjusted', 'subscription',
    v_sub.id::text, jsonb_build_object('current_period_end', v_sub.current_period_end),
    jsonb_build_object('current_period_end', v_new_end, 'delta_days', p_delta_days, 'note', p_note),
    null, null
  );

  return v_event;
end;
$$;

-- ---------------------------------------------------------------------------
-- Switch plan, discarding whatever time was left on the old one. Unlike
-- platform_renew_subscription() — which extends from the later of "now" and
-- the current period end — this always starts the new term from now(), so a
-- downgrade/upgrade never carries over paid-for days from the previous plan.
-- ---------------------------------------------------------------------------
create or replace function public.platform_switch_plan(
  p_organization_id uuid,
  p_plan_id         uuid,
  p_billing_period  text,
  p_payment_method  text default 'cash',
  p_note            text default null
)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_plan   public.plans%rowtype;
  v_months int;
  v_start  timestamptz := now();
  v_end    timestamptz;
  v_old    public.subscriptions%rowtype;
  v_sub    uuid;
  v_event  bigint;
  v_actor  uuid := auth.uid();
  v_label  text;
  v_gross  bigint;
begin
  perform app.require_platform_admin();

  if p_payment_method not in ('cash','card','wallet','transfer','gateway','none') then
    raise exception 'unsupported payment method' using errcode = '22023';
  end if;

  select * into v_plan from public.plans where id = p_plan_id;
  if not found then
    raise exception 'unknown plan' using errcode = '22023';
  end if;

  v_months := app.billing_period_months(p_billing_period);
  if v_months = 0 then
    raise exception 'unknown billing period' using errcode = '22023';
  end if;

  v_end   := v_start + make_interval(months => v_months);
  v_gross := v_plan.price_cents * v_months;

  select full_name into v_label from public.profiles where id = v_actor;

  select * into v_old
    from public.subscriptions
   where organization_id = p_organization_id
     and status in ('trialing', 'active', 'past_due')
   for update;

  if not found then
    insert into public.subscriptions (
      organization_id, plan_id, status, billing_period,
      current_period_start, current_period_end
    ) values (
      p_organization_id, p_plan_id, 'active', p_billing_period, v_start, v_end
    ) returning id into v_sub;
  else
    v_sub := v_old.id;
    update public.subscriptions
       set plan_id              = p_plan_id,
           status               = 'active',
           billing_period       = p_billing_period,
           current_period_start = v_start,
           current_period_end   = v_end,
           cancel_at_period_end = false
     where id = v_sub;
  end if;

  insert into public.subscription_events (
    organization_id, subscription_id, event_type, plan_id, billing_period,
    period_start, period_end, gross_cents, discount_cents, net_cents, currency,
    payment_method, note, created_by, created_by_label
  ) values (
    p_organization_id, v_sub, 'plan_changed', p_plan_id, p_billing_period,
    v_start, v_end, v_gross, 0, v_gross, v_plan.currency, p_payment_method,
    coalesce(p_note, ''), v_actor, v_label
  ) returning id into v_event;

  perform app.write_audit(
    p_organization_id, null, 'platform.subscription_plan_switched', 'subscription',
    v_sub::text,
    case when v_old.id is not null then
      jsonb_build_object('plan_id', v_old.plan_id, 'period_end', v_old.current_period_end)
    else null end,
    jsonb_build_object('plan_id', p_plan_id, 'billing_period', p_billing_period, 'period_end', v_end),
    null, null
  );

  return v_event;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reset a customer's operational data: orders, invoices, payments, the
-- treasury ledger, stock levels/movements, end-customer accounts and
-- notifications — everything that piles up from running the business.
--
-- Deliberately NOT touched: the organization itself, branches, staff and
-- roles, branding, subscription/billing history, and every module's *setup*
-- (menu, categories, retail catalogue, site content, domains, QR codes). A
-- "reset" clears what happened, not what the customer configured.
-- ---------------------------------------------------------------------------
create or replace function public.platform_reset_organization_data(
  p_organization_id      uuid,
  p_confirm_customer_code text
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org public.organizations%rowtype;
  v_counts jsonb;
begin
  if not app.is_platform_owner() then
    raise exception 'platform owner access required' using errcode = '42501';
  end if;

  select * into v_org from public.organizations where id = p_organization_id;
  if not found then
    raise exception 'unknown organization' using errcode = '22023';
  end if;

  if v_org.customer_code <> trim(p_confirm_customer_code) then
    raise exception 'confirmation code does not match this customer' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'restaurant_orders', (select count(*) from public.restaurant_orders where organization_id = p_organization_id),
    'retail_orders', (select count(*) from public.retail_orders where organization_id = p_organization_id),
    'invoices', (select count(*) from public.invoices where organization_id = p_organization_id),
    'customers', (select count(*) from public.customers where organization_id = p_organization_id)
  ) into v_counts;

  delete from public.restaurant_order_item_modifiers where organization_id = p_organization_id;
  delete from public.restaurant_order_items where organization_id = p_organization_id;
  delete from public.restaurant_order_deliveries where organization_id = p_organization_id;
  delete from public.restaurant_customer_favorites where organization_id = p_organization_id;
  delete from public.restaurant_orders where organization_id = p_organization_id;

  delete from public.retail_order_items where organization_id = p_organization_id;
  delete from public.retail_order_deliveries where organization_id = p_organization_id;
  delete from public.retail_orders where organization_id = p_organization_id;

  delete from public.retail_purchase_order_items where organization_id = p_organization_id;
  delete from public.retail_purchase_orders where organization_id = p_organization_id;

  delete from public.retail_stock_transfer_lines where organization_id = p_organization_id;
  delete from public.retail_stock_transfers where organization_id = p_organization_id;
  delete from public.retail_stock_movements where organization_id = p_organization_id;
  delete from public.retail_stock_levels where organization_id = p_organization_id;

  delete from public.invoice_items where organization_id = p_organization_id;
  delete from public.invoices where organization_id = p_organization_id;
  delete from public.payments where organization_id = p_organization_id;
  delete from public.treasury_transactions where organization_id = p_organization_id;

  delete from public.customer_addresses where organization_id = p_organization_id;
  delete from public.customers where organization_id = p_organization_id;

  delete from public.notifications where organization_id = p_organization_id;
  delete from public.document_counters where organization_id = p_organization_id;

  perform public.write_platform_audit(
    'platform.organization_data_reset', 'organization', p_organization_id::text,
    jsonb_build_object('customer_code', v_org.customer_code, 'name', v_org.name, 'counts_before', v_counts),
    p_organization_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Delete a customer's workspace outright. Every tenant table cascades from
-- organizations(id), so this one statement is the whole deletion — the audit
-- record is written first, with organization_id = NULL, so it is the only
-- trace of this customer that survives the cascade.
-- ---------------------------------------------------------------------------
create or replace function public.platform_delete_organization(
  p_organization_id       uuid,
  p_confirm_customer_code text
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org public.organizations%rowtype;
  v_branch_count int;
begin
  if not app.is_platform_owner() then
    raise exception 'platform owner access required' using errcode = '42501';
  end if;

  select * into v_org from public.organizations where id = p_organization_id;
  if not found then
    raise exception 'unknown organization' using errcode = '22023';
  end if;

  if v_org.customer_code <> trim(p_confirm_customer_code) then
    raise exception 'confirmation code does not match this customer' using errcode = '22023';
  end if;

  select count(*) into v_branch_count from public.branches where organization_id = p_organization_id;

  perform public.write_platform_audit(
    'platform.organization_deleted', 'organization', p_organization_id::text,
    jsonb_build_object(
      'customer_code', v_org.customer_code, 'name', v_org.name, 'slug', v_org.slug::text,
      'branch_count', v_branch_count, 'created_at', v_org.created_at
    ),
    null
  );

  delete from public.organizations where id = p_organization_id;
end;
$$;

revoke all on function public.platform_adjust_subscription_days(uuid, int, text) from public, anon;
revoke all on function public.platform_switch_plan(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.platform_reset_organization_data(uuid, text) from public, anon;
revoke all on function public.platform_delete_organization(uuid, text) from public, anon;

grant execute on function public.platform_adjust_subscription_days(uuid, int, text) to authenticated;
grant execute on function public.platform_switch_plan(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.platform_reset_organization_data(uuid, text) to authenticated;
grant execute on function public.platform_delete_organization(uuid, text) to authenticated;
