-- =============================================================================
-- LOCAL BASIC — 0034 Onboard a customer in one transaction
--
-- platform_create_workspace() provisions for an owner who already has a
-- profile. Selling to a new customer needs more than that: the workspace, the
-- chosen plan, a real subscription term, and the link back to the lead — and
-- if any step fails, none of it should survive.
--
-- A single plpgsql function IS the transaction. There is no partial state to
-- clean up: a failure anywhere rolls the whole thing back, so there can be no
-- orphan workspace and no orphan subscription.
--
-- What this function deliberately does NOT do is create the auth user. Minting
-- an identity requires the service-role admin API, which lives outside the
-- database. The application creates or invites the user first and passes the
-- resulting id here, so the database never needs a credential it cannot check.
-- =============================================================================

create or replace function public.platform_onboard_customer(
  p_owner_user_id uuid,
  p_org_name      text,
  p_slug          text,
  p_module        text,
  p_plan_id       uuid,
  p_billing_period text default 'month',
  p_promo_code    text default null,
  p_payment_method text default 'cash',
  p_branch_name   text default null,
  p_lead_id       uuid default null,
  p_note          text default null
)
returns table (
  out_organization_id uuid,
  out_customer_code   text,
  out_slug            text,
  out_branch_id       uuid,
  out_event_id        bigint
)
language plpgsql security definer set search_path = '' as $$
declare
  v_org    uuid;
  v_branch uuid;
  v_slug   text;
  v_event  bigint;
begin
  perform app.require_platform_admin();

  -- Only a service the platform is actually selling. The catalog is the single
  -- list; provisioning does not carry its own copy of what exists.
  if not exists (
    select 1 from public.platform_services s
     where s.module_key = p_module and s.is_available and s.is_built
  ) then
    raise exception 'service % is not available for provisioning', p_module
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_owner_user_id) then
    raise exception 'owner profile not found' using errcode = '22023';
  end if;

  -- Refuse a second workspace for the same owner under the same slug rather
  -- than letting the unique index surface as an opaque constraint error.
  if exists (select 1 from public.organizations o where o.slug = lower(p_slug)) then
    raise exception 'slug % is already taken', p_slug using errcode = '23505';
  end if;

  select w.out_organization_id, w.out_organization_slug, w.out_branch_id
    into v_org, v_slug, v_branch
    from app.provision_workspace_for(
      p_owner_user_id, p_org_name, p_slug, p_module, p_branch_name
    ) as w;

  -- Move the workspace straight onto the sold plan and term. Reuses the same
  -- pricing path an ordinary renewal takes, so a first sale and a renewal can
  -- never disagree about what a year costs.
  v_event := public.platform_renew_subscription(
    v_org, p_plan_id, p_billing_period, p_promo_code, p_payment_method,
    coalesce(p_note, 'أول اشتراك')
  );

  if p_lead_id is not null then
    update public.platform_leads
       set status = 'won', organization_id = v_org
     where id = p_lead_id;
  end if;

  perform app.write_audit(
    v_org, null, 'platform.customer_onboarded', 'organization', v_org::text, null,
    jsonb_build_object(
      'owner_user_id', p_owner_user_id, 'module', p_module,
      'plan_id', p_plan_id, 'billing_period', p_billing_period,
      'lead_id', p_lead_id
    ),
    null, null
  );

  return query
    select v_org, o.customer_code, v_slug, v_branch, v_event
      from public.organizations o where o.id = v_org;
end;
$$;

revoke all on function public.platform_onboard_customer(
  uuid, text, text, text, uuid, text, text, text, text, uuid, text
) from public, anon;
grant execute on function public.platform_onboard_customer(
  uuid, text, text, text, uuid, text, text, text, text, uuid, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Look an owner up by email.
--
-- profiles has no email column — the address lives on auth.users, which is not
-- readable through PostgREST. This SECURITY DEFINER function is the narrow
-- window: it answers "is there an account for this address, and what is its
-- id", for Platform Admins only, and returns nothing else about the user.
-- ---------------------------------------------------------------------------
create or replace function public.platform_find_user_by_email(p_email text)
returns table (user_id uuid, full_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_platform_admin();
  return query
    select u.id, p.full_name
      from auth.users u
      left join public.profiles p on p.id = u.id
     where lower(u.email) = lower(trim(p_email))
     limit 1;
end;
$$;

revoke all on function public.platform_find_user_by_email(text) from public, anon;
grant execute on function public.platform_find_user_by_email(text) to authenticated;
