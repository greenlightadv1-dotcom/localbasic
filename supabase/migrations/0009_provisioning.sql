-- =============================================================================
-- LOCAL BASIC — 0009 Workspace provisioning
--
-- One function, one transaction. Either a complete, usable workspace exists or
-- nothing does — a half-created organization is not reachable from here.
--
-- SECURITY DEFINER so it can write past RLS on tables the caller does not yet
-- have membership in, but the owner is always auth.uid(): the caller cannot
-- provision a workspace on someone else's behalf.
-- =============================================================================

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
-- Output columns are prefixed so they cannot shadow same-named table columns
-- inside the function body (PL/pgSQL resolves OUT parameters before columns).
returns table (out_organization_id uuid, out_organization_slug text, out_branch_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_user     uuid := auth.uid();
  v_org      uuid;
  v_branch   uuid;
  v_owner    uuid;
  v_member   uuid;
  v_plan     uuid;
  v_account  uuid;
  v_tpl      record;
  v_new_role uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_module not in ('retail','restaurant','medical','workshop') then
    raise exception 'unknown module %', p_module using errcode = '22023';
  end if;

  -- 1. organization -----------------------------------------------------------
  insert into public.organizations
    (slug, name, primary_module, country, currency, timezone, default_locale, owner_user_id)
  values
    (lower(p_slug), trim(p_org_name), p_module, p_country, upper(p_currency),
     p_timezone, p_locale, v_user)
  returning id into v_org;

  -- 2. enabled modules (multi-vertical ready: extra rows, no schema change) ----
  insert into public.organization_modules (organization_id, module_key, is_primary)
  values (v_org, p_module, true);

  -- 3. first branch -----------------------------------------------------------
  insert into public.branches (organization_id, slug, name)
  values (v_org, 'main', coalesce(nullif(trim(p_branch_name), ''), 'الفرع الرئيسي'))
  returning id into v_branch;

  -- 4. membership: the creator, with access to every branch -------------------
  insert into public.organization_members
    (organization_id, user_id, status, all_branches, joined_at)
  values (v_org, v_user, 'active', true, now())
  returning id into v_member;

  -- 5. clone the role templates that apply to this organization ---------------
  --    Core templates (module_key is null) plus this module's own templates.
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
      -- The owner role always holds the entire catalog, so a new permission
      -- introduced by a later migration is never locked away from the owner.
      insert into public.role_permissions (role_id, permission_key)
      select v_new_role, p.key from public.permissions p;
    else
      insert into public.role_permissions (role_id, permission_key)
      select v_new_role, rp.permission_key
      from public.role_permissions rp
      where rp.role_id = v_tpl.id;
    end if;
  end loop;

  -- 6. the creator becomes Owner, organization-wide ---------------------------
  insert into public.user_roles (member_id, role_id, branch_id, granted_by)
  values (v_member, v_owner, null, v_user);

  -- 7. trial subscription -----------------------------------------------------
  select id into v_plan from public.plans where key = 'trial';
  insert into public.subscriptions
    (organization_id, plan_id, status, current_period_end)
  values (v_org, v_plan, 'trialing', now() + interval '14 days');

  -- 8. branding ---------------------------------------------------------------
  insert into public.branding_settings (organization_id, display_name)
  values (v_org, trim(p_org_name));

  -- 9. operational defaults ---------------------------------------------------
  insert into public.settings (organization_id, branch_id, key, value) values
    (v_org, null, 'tax.default_rate_bp', '0'::jsonb),
    (v_org, null, 'tax.prices_include_tax', 'false'::jsonb),
    (v_org, null, 'invoice.footer_note', '""'::jsonb);

  insert into public.document_counters (organization_id, branch_id, doc_type, prefix)
  values (v_org, v_branch, 'invoice', 'INV-'),
         (v_org, v_branch, 'purchase', 'PO-'),
         (v_org, v_branch, 'order', 'ORD-');

  -- 10. default cash drawer ---------------------------------------------------
  insert into public.treasury_accounts
    (organization_id, branch_id, name, type, currency, is_default)
  values (v_org, v_branch, 'الخزينة الرئيسية', 'cash', upper(p_currency), true)
  returning id into v_account;

  -- 11. audit -----------------------------------------------------------------
  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (v_org, v_branch, v_user, 'organization.provisioned', 'organization', v_org::text,
     jsonb_build_object('module', p_module, 'slug', lower(p_slug)));

  return query select v_org, lower(p_slug)::text, v_branch;
end;
$$;

grant execute on function public.provision_workspace(
  text, text, text, text, text, char(3), text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Slug availability check for the onboarding form. Returns only a boolean, so
-- it cannot be used to enumerate existing organizations' details.
-- ---------------------------------------------------------------------------
create or replace function public.is_org_slug_available(p_slug text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.organizations o where o.slug = lower(p_slug));
$$;
grant execute on function public.is_org_slug_available(text) to authenticated;
