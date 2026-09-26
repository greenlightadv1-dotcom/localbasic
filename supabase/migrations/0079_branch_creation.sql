-- =============================================================================
-- LOCAL BASIC — Branch creation, plan-limit enforced
--
-- Until now the only path that ever created a `branches` row was one-time
-- organization provisioning (0009/0031), which hardcodes exactly one branch
-- ('main'). There was no way for an existing organization to add a second
-- branch at all, and nothing anywhere compared a branch count against the
-- organization's plan limits (`plans.limits->>'branches'`, seeded in 0008)
-- even though that column's own comment already calls these "hard caps
-- enforced server-side at creation time" — the cap existed as data, with no
-- code ever reading it for this purpose.
--
-- This adds that missing creation path, gated the same way every other write
-- in this schema is: a narrow SECURITY DEFINER function, callable only by
-- someone holding branch.create on this organization (0007's own RLS insert
-- policy is re-checked here explicitly, since SECURITY DEFINER bypasses it),
-- and it is the ONLY path the application uses to create a branch after
-- onboarding — exactly as it never inserts a `sites` row directly instead of
-- calling site_provision() when that existed, or a `restaurant_website_*`
-- row instead of going through the builder's own functions.
--
-- No subscription row, or a plan whose `limits` jsonb has no "branches" key,
-- means no cap — never silently refuse a branch for a data shape a plan
-- might not carry, rather than treating an absent limit as "one".
-- =============================================================================

create or replace function public.branch_create(
  p_org     uuid,
  p_name    text,
  p_slug    text,
  p_address text default null,
  p_phone   text default null
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_slug   text := lower(trim(coalesce(p_slug, '')));
  v_name   text := trim(coalesce(p_name, ''));
  v_limit  int;
  v_count  int;
  v_branch uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'branch.create') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if length(v_name) < 1 or length(v_name) > 120 then
    raise exception 'اسم الفرع مطلوب' using errcode = '22023';
  end if;
  if v_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])$' then
    raise exception 'معرّف الفرع غير صالح — حروف إنجليزية صغيرة وأرقام وشرطات فقط' using errcode = '22023';
  end if;

  -- The organization's current plan, if it has one. Trialing/active/past_due
  -- mirrors the one-live-subscription partial unique index (0004): exactly
  -- the states that mean "this plan governs the account right now".
  select (p.limits ->> 'branches')::int into v_limit
    from public.subscriptions s
    join public.plans p on p.id = s.plan_id
   where s.organization_id = p_org
     and s.status in ('trialing', 'active', 'past_due')
   limit 1;

  select count(*) into v_count
    from public.branches b
   where b.organization_id = p_org and b.deleted_at is null;

  if v_limit is not null and v_count >= v_limit then
    raise exception 'وصلت لحد عدد الفروع المسموح في باقتك الحالية (% فرع). لإضافة المزيد، قم بترقية الباقة.', v_limit
      using errcode = 'P0001';
  end if;

  insert into public.branches (organization_id, slug, name, address, phone)
  values (p_org, v_slug, v_name, nullif(trim(p_address), ''), nullif(trim(p_phone), ''))
  returning id into v_branch;

  insert into public.audit_logs
    (organization_id, actor_id, actor_label, action, entity_type, entity_id, after)
  values
    (p_org, auth.uid(),
     (select full_name from public.profiles where id = auth.uid()),
     'branch.created', 'branch', v_branch::text,
     jsonb_build_object('name', v_name, 'slug', v_slug));

  return v_branch;
end;
$$;

revoke all on function public.branch_create(uuid, text, text, text, text) from public, anon;
grant execute on function public.branch_create(uuid, text, text, text, text) to authenticated;
