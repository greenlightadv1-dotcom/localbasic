-- =============================================================================
-- LOCAL BASIC — 0031 Platform billing + provisioning functions
--
-- The whole point of this file: the browser sends an organization, a plan, a
-- term and possibly a promo code — four identifiers. Every price, discount,
-- date and status is derived here from the catalogue. A tampered client can
-- change WHAT is bought, never what it COSTS.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Validate a promo code and price a term. Pure read, so the admin UI can show
-- the same number the write path will charge, without a dry-run write.
--
-- Returns one row. `valid` false carries a reason rather than raising, because
-- "that code expired" is a normal answer to a lookup, not an error.
-- ---------------------------------------------------------------------------
create or replace function public.platform_quote_renewal(
  p_organization_id uuid,
  p_plan_id         uuid,
  p_billing_period  text,
  p_promo_code      text default null
)
returns table (
  valid           boolean,
  reason          text,
  months          int,
  trial_days      int,
  gross_cents     bigint,
  discount_cents  bigint,
  net_cents       bigint,
  currency        char(3),
  promo_code_id   uuid,
  period_start    timestamptz,
  period_end      timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_plan    public.plans%rowtype;
  v_promo   public.promo_codes%rowtype;
  v_months  int;
  v_start   timestamptz;
  v_paid    int;
begin
  perform app.require_platform_admin();

  select * into v_plan from public.plans where id = p_plan_id;
  if not found then
    raise exception 'unknown plan' using errcode = '22023';
  end if;

  if not exists (select 1 from public.organizations o where o.id = p_organization_id) then
    raise exception 'unknown organization' using errcode = '22023';
  end if;

  v_months := app.billing_period_months(p_billing_period);
  if v_months = 0 and p_billing_period <> 'trial' then
    raise exception 'unknown billing period' using errcode = '22023';
  end if;

  -- A renewal extends an unexpired term rather than truncating it, so nobody
  -- loses days by paying early.
  select greatest(coalesce(max(s.current_period_end), now()), now())
    into v_start
    from public.subscriptions s
   where s.organization_id = p_organization_id
     and s.status in ('trialing', 'active', 'past_due');
  v_start := coalesce(v_start, now());

  months         := v_months;
  trial_days     := 0;
  currency       := v_plan.currency;
  gross_cents    := v_plan.price_cents * v_months;
  discount_cents := 0;
  promo_code_id  := null;
  valid          := true;
  reason         := null;

  if p_promo_code is not null and length(trim(p_promo_code)) > 0 then
    -- lower(...::text) rather than relying on citext's case-insensitive `=`:
    -- under `search_path = ''` the citext operator is not resolvable, so the
    -- comparison would silently fall back to case-sensitive text equality.
    select * into v_promo from public.promo_codes pc
     where lower(pc.code::text) = lower(trim(p_promo_code));

    if not found then
      valid := false; reason := 'code_not_found';
    elsif not v_promo.is_active then
      valid := false; reason := 'code_inactive';
    elsif v_promo.starts_at > now() then
      valid := false; reason := 'code_not_started';
    elsif v_promo.ends_at is not null and v_promo.ends_at <= now() then
      valid := false; reason := 'code_expired';
    elsif v_promo.max_redemptions is not null
      and v_promo.redeemed_count >= v_promo.max_redemptions then
      valid := false; reason := 'code_exhausted';
    elsif v_promo.plan_id is not null and v_promo.plan_id <> p_plan_id then
      valid := false; reason := 'code_wrong_plan';
    elsif exists (
      select 1 from public.promo_redemptions r
       where r.promo_code_id = v_promo.id and r.organization_id = p_organization_id
    ) then
      valid := false; reason := 'code_already_used';
    else
      if v_promo.module_key is not null and not exists (
        select 1 from public.organization_modules m
         where m.organization_id = p_organization_id
           and m.module_key = v_promo.module_key and m.enabled
      ) then
        valid := false; reason := 'code_wrong_service';
      end if;

      if valid and v_promo.new_customers_only then
        select count(*) into v_paid
          from public.subscription_events e
         where e.organization_id = p_organization_id and e.net_cents > 0;
        if v_paid > 0 then
          valid := false; reason := 'code_new_customers_only';
        end if;
      end if;

      if valid then
        promo_code_id := v_promo.id;
        if v_promo.kind = 'percent' then
          -- floor() so rounding never favours the customer by a stray cent.
          discount_cents := floor(gross_cents * v_promo.percent_off / 100.0)::bigint;
        elsif v_promo.kind = 'fixed' then
          discount_cents := least(v_promo.amount_off_cents, gross_cents);
        else
          trial_days := v_promo.trial_days;
        end if;
      end if;
    end if;

    if not valid then
      promo_code_id := null;
      discount_cents := 0;
      trial_days := 0;
    end if;
  end if;

  net_cents    := gross_cents - discount_cents;
  period_start := v_start;
  period_end   := v_start
                  + make_interval(months => v_months)
                  + make_interval(days   => trial_days);
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Apply the renewal. Recomputes the quote rather than trusting one passed in,
-- so the price cannot be fixed by replaying a stale or edited quote.
-- ---------------------------------------------------------------------------
create or replace function public.platform_renew_subscription(
  p_organization_id uuid,
  p_plan_id         uuid,
  p_billing_period  text,
  p_promo_code      text default null,
  p_payment_method  text default 'cash',
  p_note            text default null
)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  q            record;
  v_sub        uuid;
  v_event      bigint;
  v_actor      uuid := auth.uid();
  v_label      text;
  v_status     text;
  v_event_type text;
begin
  perform app.require_platform_admin();

  if p_payment_method not in ('cash','card','wallet','transfer','gateway','none') then
    raise exception 'unsupported payment method' using errcode = '22023';
  end if;

  select * into q from public.platform_quote_renewal(
    p_organization_id, p_plan_id, p_billing_period, p_promo_code
  );

  -- A code that failed validation is refused outright rather than silently
  -- charging full price: the admin must see why before taking cash.
  if not q.valid then
    raise exception 'promo code rejected: %', q.reason using errcode = '22023';
  end if;

  select full_name into v_label from public.profiles where id = v_actor;

  v_status     := case when q.net_cents = 0 and q.trial_days > 0 then 'trialing' else 'active' end;
  v_event_type := case when v_status = 'trialing' then 'trial_granted' else 'renewed' end;

  -- Lock the live row so two admins renewing at once cannot both extend from
  -- the same starting point.
  select id into v_sub
    from public.subscriptions
   where organization_id = p_organization_id
     and status in ('trialing', 'active', 'past_due')
   for update;

  if v_sub is null then
    insert into public.subscriptions (
      organization_id, plan_id, status, billing_period,
      current_period_start, current_period_end
    ) values (
      p_organization_id, p_plan_id, v_status, p_billing_period,
      q.period_start, q.period_end
    ) returning id into v_sub;
    v_event_type := 'created';
  else
    update public.subscriptions
       set plan_id              = p_plan_id,
           status               = v_status,
           billing_period       = p_billing_period,
           current_period_start = q.period_start,
           current_period_end   = q.period_end,
           cancel_at_period_end = false
     where id = v_sub;
  end if;

  insert into public.subscription_events (
    organization_id, subscription_id, event_type, plan_id, billing_period,
    period_start, period_end, gross_cents, discount_cents, net_cents, currency,
    payment_method, promo_code_id, promo_code, note, created_by, created_by_label
  ) values (
    p_organization_id, v_sub, v_event_type, p_plan_id, p_billing_period,
    q.period_start, q.period_end, q.gross_cents, q.discount_cents, q.net_cents,
    q.currency, p_payment_method, q.promo_code_id, nullif(trim(p_promo_code), ''),
    p_note, v_actor, v_label
  ) returning id into v_event;

  if q.promo_code_id is not null then
    insert into public.promo_redemptions (
      promo_code_id, organization_id, subscription_event_id,
      discount_cents, trial_days_granted, redeemed_by
    ) values (
      q.promo_code_id, p_organization_id, v_event,
      q.discount_cents, q.trial_days, v_actor
    );
    update public.promo_codes
       set redeemed_count = redeemed_count + 1
     where id = q.promo_code_id;
  end if;

  perform app.write_audit(
    p_organization_id, null, 'platform.subscription_renewed', 'subscription',
    v_sub::text, null,
    jsonb_build_object(
      'plan_id', p_plan_id, 'billing_period', p_billing_period,
      'gross_cents', q.gross_cents, 'discount_cents', q.discount_cents,
      'net_cents', q.net_cents, 'payment_method', p_payment_method,
      'promo_code', nullif(trim(p_promo_code), ''), 'period_end', q.period_end
    ),
    null, null
  );

  return v_event;
end;
$$;

-- ---------------------------------------------------------------------------
-- Provisioning for another owner.
--
-- provision_workspace() makes auth.uid() the owner, which is right for
-- self-signup and wrong for a Platform Admin selling to someone else. Rather
-- than duplicating it, the body moves into app.provision_workspace_for(owner)
-- and both entry points call it — so there is still exactly one provisioning
-- implementation, and the module bootstrap hook keeps working unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.platform_create_workspace(
  p_owner_user_id uuid,
  p_org_name      text,
  p_slug          text,
  p_module        text,
  p_branch_name   text default null,
  p_country       text default 'EG',
  p_currency      char(3) default 'EGP',
  p_timezone      text default 'Africa/Cairo',
  p_locale        text default 'ar'
)
returns table (out_organization_id uuid, out_organization_slug text, out_branch_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  perform app.require_platform_admin();

  if not exists (select 1 from public.profiles p where p.id = p_owner_user_id) then
    raise exception 'owner profile not found' using errcode = '22023';
  end if;

  select * into out_organization_id, out_organization_slug, out_branch_id
    from app.provision_workspace_for(
      p_owner_user_id, p_org_name, p_slug, p_module,
      p_branch_name, p_country, p_currency, p_timezone, p_locale
    );

  v_org := out_organization_id;

  perform app.write_audit(
    v_org, null, 'platform.workspace_created', 'organization', v_org::text, null,
    jsonb_build_object('owner_user_id', p_owner_user_id, 'module', p_module, 'slug', p_slug),
    null, null
  );

  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Expiring-soon view, computed from current_period_end. The "3 days or less"
-- warning is derived server-side; no stored flag to drift.
-- ---------------------------------------------------------------------------
create or replace function public.platform_expiring_subscriptions(p_within_days int default 3)
returns table (
  organization_id    uuid,
  customer_code      text,
  organization_name  text,
  slug              text,
  plan_key          text,
  status            text,
  billing_period    text,
  current_period_end timestamptz,
  days_left         int
)
language sql stable security definer set search_path = '' as $$
  select o.id, o.customer_code, o.name, o.slug::text, p.key, s.status, s.billing_period,
         s.current_period_end,
         floor(extract(epoch from (s.current_period_end - now())) / 86400)::int
  from public.subscriptions s
  join public.organizations o on o.id = s.organization_id
  join public.plans p on p.id = s.plan_id
  where app.is_platform_admin()
    and s.status in ('trialing', 'active', 'past_due')
    and s.current_period_end <= now() + make_interval(days => greatest(p_within_days, 0))
  order by s.current_period_end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: authenticated only. Each function gates on require_platform_admin()
-- itself, so a signed-in tenant user calling one gets 42501.
-- ---------------------------------------------------------------------------
revoke all on function public.platform_quote_renewal(uuid, uuid, text, text) from public, anon;
revoke all on function public.platform_renew_subscription(uuid, uuid, text, text, text, text) from public, anon;
revoke all on function public.platform_create_workspace(uuid, text, text, text, text, text, char(3), text, text) from public, anon;
revoke all on function public.platform_expiring_subscriptions(int) from public, anon;

grant execute on function public.platform_quote_renewal(uuid, uuid, text, text) to authenticated;
grant execute on function public.platform_renew_subscription(uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.platform_create_workspace(uuid, text, text, text, text, text, char(3), text, text) to authenticated;
grant execute on function public.platform_expiring_subscriptions(int) to authenticated;
