-- =============================================================================
-- LOCAL BASIC — 0031a Provisioning takes an explicit owner
--
-- The body of provision_workspace() moves here unchanged except that the owner
-- is a parameter instead of auth.uid(). Both entry points call it, so there is
-- still exactly one provisioning implementation and the module bootstrap hook
-- is untouched.
--
-- It lives in `app`, which is not exposed through PostgREST, so it can never be
-- invoked directly as an RPC — the only ways in are the two public wrappers,
-- and each decides for itself who is allowed to name the owner.
-- =============================================================================

create or replace function app.provision_workspace_for(
  p_owner_user_id uuid,
  p_org_name    text,
  p_slug        text,
  p_module      text,
  p_branch_name text default null,
  p_country     text default 'EG',
  p_currency    char(3) default 'EGP',
  p_timezone    text default 'Africa/Cairo',
  p_locale      text default 'ar'
)
returns table (out_organization_id uuid, out_organization_slug text, out_branch_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_user     uuid := p_owner_user_id;
  v_org      uuid;
  v_branch   uuid;
  v_owner    uuid;
  v_member   uuid;
  v_plan     uuid;
  v_tpl      record;
  v_new_role uuid;
  v_bootstrap text;
begin
  if v_user is null then
    raise exception 'an owner is required' using errcode = '28000';
  end if;

  if p_module not in ('retail','restaurant','medical','workshop') then
    raise exception 'unknown module %', p_module using errcode = '22023';
  end if;

  insert into public.organizations
    (slug, name, primary_module, country, currency, timezone, default_locale, owner_user_id)
  values
    (lower(p_slug), trim(p_org_name), p_module, p_country, upper(p_currency),
     p_timezone, p_locale, v_user)
  returning id into v_org;

  insert into public.organization_modules (organization_id, module_key, is_primary)
  values (v_org, p_module, true);

  insert into public.branches (organization_id, slug, name)
  values (v_org, 'main', coalesce(nullif(trim(p_branch_name), ''), 'الفرع الرئيسي'))
  returning id into v_branch;

  insert into public.organization_members
    (organization_id, user_id, status, all_branches, joined_at)
  values (v_org, v_user, 'active', true, now())
  returning id into v_member;

  for v_tpl in
    select * from public.roles
    where organization_id is null
      and (module_key is null or module_key = p_module)
  loop
    insert into public.roles
      (organization_id, key, name_ar, name_en, description, is_system, is_owner, module_key)
    values
      (v_org, v_tpl.key, v_tpl.name_ar, v_tpl.name_en, v_tpl.description,
       true, v_tpl.is_owner, v_tpl.module_key)
    returning id into v_new_role;

    if v_tpl.is_owner then
      v_owner := v_new_role;
      insert into public.role_permissions (role_id, permission_key)
      select v_new_role, p.key from public.permissions p;
    else
      insert into public.role_permissions (role_id, permission_key)
      select v_new_role, rp.permission_key
      from public.role_permissions rp
      where rp.role_id = v_tpl.id;
    end if;
  end loop;

  insert into public.user_roles (member_id, role_id, branch_id, granted_by)
  values (v_member, v_owner, null, v_user);

  select id into v_plan from public.plans where key = 'trial';
  insert into public.subscriptions
    (organization_id, plan_id, status, billing_period, current_period_end)
  values (v_org, v_plan, 'trialing', 'trial', now() + interval '14 days');

  insert into public.branding_settings (organization_id, display_name)
  values (v_org, trim(p_org_name));

  insert into public.settings (organization_id, branch_id, key, value) values
    (v_org, null, 'tax.default_rate_bp', '0'::jsonb),
    (v_org, null, 'tax.prices_include_tax', 'false'::jsonb),
    (v_org, null, 'invoice.footer_note', '""'::jsonb);

  insert into public.document_counters (organization_id, branch_id, doc_type, prefix)
  values (v_org, v_branch, 'invoice', 'INV-'),
         (v_org, v_branch, 'purchase', 'PO-'),
         (v_org, v_branch, 'order', 'ORD-'),
         (v_org, v_branch, 'restaurant_order', '');

  insert into public.treasury_accounts
    (organization_id, branch_id, name, type, currency, is_default)
  values (v_org, v_branch, 'الخزينة الرئيسية', 'cash', upper(p_currency), true);

  -- Module bootstrap hook. Core does not name the vertical: it calls whatever
  -- function that module registered, if any. p_module is validated above, so
  -- the identifier interpolated here is from a fixed set.
  v_bootstrap := 'app.bootstrap_' || p_module || '(uuid,uuid)';
  if to_regprocedure(v_bootstrap) is not null then
    execute format('select app.bootstrap_%I($1, $2)', p_module) using v_org, v_branch;
  end if;

  -- The opening subscription is history too, so the ledger starts at day one
  -- rather than at the first renewal.
  insert into public.subscription_events (
    organization_id, subscription_id, event_type, plan_id, billing_period,
    period_start, period_end, gross_cents, discount_cents, net_cents, currency,
    payment_method, note, created_by
  )
  select v_org, s.id, 'created', s.plan_id, 'trial',
         s.current_period_start, s.current_period_end, 0, 0, 0, upper(p_currency),
         'none', 'workspace provisioned', auth.uid()
    from public.subscriptions s where s.organization_id = v_org;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (v_org, v_branch, auth.uid(), 'organization.provisioned', 'organization', v_org::text,
     jsonb_build_object('module', p_module, 'slug', lower(p_slug), 'owner_user_id', v_user));

  return query select v_org, lower(p_slug)::text, v_branch;
end;
$$;

-- Self-service entry point: the caller is always the owner. Unchanged contract.
create or replace function public.provision_workspace(
  p_org_name    text,
  p_slug        text,
  p_module      text,
  p_branch_name text default null,
  p_country     text default 'EG',
  p_currency    char(3) default 'EGP',
  p_timezone    text default 'Africa/Cairo',
  p_locale      text default 'ar'
)
returns table (out_organization_id uuid, out_organization_slug text, out_branch_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  return query select * from app.provision_workspace_for(
    auth.uid(), p_org_name, p_slug, p_module,
    p_branch_name, p_country, p_currency, p_timezone, p_locale
  );
end;
$$;

revoke all on function app.provision_workspace_for(uuid, text, text, text, text, text, char(3), text, text) from public, anon, authenticated;
revoke all on function public.provision_workspace(text, text, text, text, text, char(3), text, text) from public, anon;
grant execute on function public.provision_workspace(text, text, text, text, text, char(3), text, text) to authenticated;
