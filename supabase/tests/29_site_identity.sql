-- =============================================================================
-- LOCAL BASIC — 0056 site identity integrity
--
-- 28_site_engine.sql proves the POLICIES: who may reach a site at all. This
-- file proves the TRIGGER: what a caller who is already allowed to write may
-- claim in the row they write.
--
-- Every write below is made by somebody who legitimately holds site.manage on
-- the organization involved. That is the point — a test that fails because the
-- caller lacked permission would prove nothing about the trigger.
--
--   1. created_by cannot be forged on INSERT.
--   2. created_by cannot be reassigned on UPDATE, in either direction, and
--      not in two steps through NULL.
--   3. A site cannot be re-parented by somebody who administers BOTH
--      organizations — the case the policy's WITH CHECK cannot catch.
--   4. Ordinary field updates still work and leave identity alone.
--   5. site_provision() still works and still records the real creator.
--   6. ON DELETE SET NULL still works: the trigger must not make a creator's
--      profile undeletable.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/29_site_identity.sql
-- =============================================================================

\set ON_ERROR_STOP on

do $$
declare
  u_owner_a uuid; u_other_a uuid; u_dual uuid; u_leaver uuid;
  org_a uuid; br_a uuid; org_c uuid; br_c uuid;
  m_other uuid; m_dual uuid; m_leaver uuid; r_site uuid;
  site_a uuid; site_dual uuid; site_leaver uuid; v_tmp uuid;
  ok boolean; n int; v_created uuid; v_org uuid; v_at timestamptz;
begin
  perform auth.as_admin();
  insert into auth.users (email) values ('si-owner-a@test.local') returning id into u_owner_a;
  insert into auth.users (email) values ('si-other-a@test.local') returning id into u_other_a;
  insert into auth.users (email) values ('si-dual@test.local')    returning id into u_dual;
  -- Owns no organization, so their profile is actually deletable: an owner's
  -- is not, because organizations.owner_user_id references it.
  insert into auth.users (email) values ('si-leaver@test.local')  returning id into u_leaver;

  perform auth.login_as(u_owner_a);
  select out_organization_id, out_branch_id into org_a, br_a
    from public.provision_workspace('SI Alpha', 'sialpha', 'restaurant');

  -- u_dual owns org C outright, so their site.manage there is genuine and
  -- comes from the owner role rather than anything this test grants.
  perform auth.login_as(u_dual);
  select out_organization_id, out_branch_id into org_c, br_c
    from public.provision_workspace('SI Gamma', 'sigamma', 'restaurant');

  perform auth.as_admin();

  -- A second real member of org A, to be the forged creator. They are an
  -- active member with no site permission: exactly the profile an attacker
  -- would reach for, since the foreign key demands a real profile id.
  insert into public.organization_members (organization_id, user_id, status, all_branches)
       values (org_a, u_other_a, 'active', true) returning id into m_other;

  -- u_dual is ALSO an administrator of org A. This is the scenario the
  -- architecture review named: one person, two organizations, site.manage in
  -- both, so sites_update's WITH CHECK passes on the new row as well as the
  -- old one and the policy alone cannot refuse the move.
  insert into public.organization_members (organization_id, user_id, status, all_branches)
       values (org_a, u_dual, 'active', true) returning id into m_dual;
  insert into public.roles (organization_id, key, name_ar, name_en, description)
       values (org_a, 'si_site', 'محرر المواقع', 'Site editor', 'test')
    returning id into r_site;
  insert into public.role_permissions (role_id, permission_key)
       values (r_site, 'site.read'), (r_site, 'site.manage');
  insert into public.user_roles (member_id, role_id) values (m_dual, r_site);

  insert into public.organization_members (organization_id, user_id, status, all_branches)
       values (org_a, u_leaver, 'active', true) returning id into m_leaver;
  insert into public.user_roles (member_id, role_id) values (m_leaver, r_site);

  -- ── 5. Provisioning regression ────────────────────────────────────────────
  -- Run first: if the trigger broke the only write path the application has,
  -- nothing below is worth measuring.
  perform auth.login_as(u_owner_a);
  select public.site_provision(org_a, 'Alpha Site', 'alpha-site') into site_a;

  select created_by, organization_id into v_created, v_org
    from public.sites where id = site_a;
  assert v_created = u_owner_a,
    'provisioning should record the authenticated creator';
  assert v_org = org_a,
    'provisioning should record the requested organization';
  select count(*) into n from public.site_pages where site_id = site_a and is_homepage;
  assert n = 1, 'provisioning no longer creates a homepage';
  select count(*) into n from public.site_settings where site_id = site_a;
  assert n = 1, 'provisioning no longer creates a settings row';
  raise notice 'OK 5  site_provision still works and records the real creator';

  -- ── 1. Forged created_by on INSERT ────────────────────────────────────────
  -- A direct table insert, bypassing site_provision() entirely, naming another
  -- real member as the creator. The caller genuinely holds site.manage on
  -- org A, so the policy admits the row; only the trigger decides what it says.
  --
  -- The trigger OVERWRITES rather than raises here, which is the convention
  -- app.check_platform_website() established: the claim is discarded, not
  -- argued with. So the assertion is on the stored value, and on the absence
  -- of any row attributed to the other member.
  insert into public.sites (organization_id, created_by, name, slug)
       values (org_a, u_other_a, 'Forged', 'forged-site')
    returning id into v_tmp;

  select created_by into v_created from public.sites where id = v_tmp;
  assert v_created = u_owner_a,
    'a forged created_by survived INSERT: got ' || coalesce(v_created::text, 'null');
  select count(*) into n from public.sites where created_by = u_other_a;
  assert n = 0, 'a site is attributed to a member who never created one';
  raise notice 'OK 1  created_by cannot be forged on INSERT';

  -- ── 2. created_by mutation on UPDATE ──────────────────────────────────────
  -- Reassignment is REFUSED, not coerced: unlike an insert, there is no
  -- legitimate caller echoing a field back, so a silent no-op would let a
  -- caller believe authorship moved when it did not.
  ok := false;
  begin
    update public.sites set created_by = u_other_a where id = site_a;
  exception when others then ok := true; end;
  assert ok, 'created_by was reassigned to another member';
  select created_by into v_created from public.sites where id = site_a;
  assert v_created = u_owner_a, 'created_by changed despite the refusal';

  -- The two-step forge: clear it, then claim it. Clearing is allowed — it is
  -- how ON DELETE SET NULL works — but the second step is still a change to a
  -- non-null value and is refused just the same.
  update public.sites set created_by = null where id = site_a;
  select created_by into v_created from public.sites where id = site_a;
  assert v_created is null, 'created_by could not be cleared';

  ok := false;
  begin
    update public.sites set created_by = u_other_a where id = site_a;
  exception when others then ok := true; end;
  assert ok, 'created_by was claimed after being cleared';

  ok := false;
  begin
    update public.sites set created_by = u_owner_a where id = site_a;
  exception when others then ok := true; end;
  assert ok, 'created_by was re-claimed by the original creator after clearing';
  select created_by into v_created from public.sites where id = site_a;
  assert v_created is null, 'created_by is no longer null after refused claims';
  raise notice 'OK 2  created_by may be cleared, never reassigned — not even in two steps';

  -- ── 3. Organization re-parenting by a dual administrator ──────────────────
  perform auth.login_as(u_dual);

  -- Both sides are genuinely theirs: prove it, so a later failure cannot be
  -- mistaken for a missing permission.
  select count(*) into n from public.sites where id = site_a;
  assert n = 1, 'the dual administrator cannot even see org A''s site';

  select public.site_provision(org_c, 'Gamma Site', 'gamma-site') into site_dual;
  select count(*) into n from public.sites where id = site_dual;
  assert n = 1, 'the dual administrator cannot see their own org C site';

  -- Their own site, out of org C and into org A. WITH CHECK passes — they hold
  -- site.manage on org A too. The trigger is the only thing that refuses.
  ok := false;
  begin
    update public.sites set organization_id = org_a where id = site_dual;
  exception when others then ok := true; end;
  assert ok, 'a dual administrator moved their site into their other organization';
  select organization_id into v_org from public.sites where id = site_dual;
  assert v_org = org_c, 'the site left org C despite the refusal';

  -- And the same move in the other direction, pulling org A's site into org C.
  ok := false;
  begin
    update public.sites set organization_id = org_c where id = site_a;
  exception when others then ok := true; end;
  assert ok, 'a dual administrator moved org A''s site into org C';
  select organization_id into v_org from public.sites where id = site_a;
  assert v_org = org_a, 'org A''s site was re-parented despite the refusal';
  raise notice 'OK 3  a site cannot be re-parented, even by someone who administers both';

  -- ── 4. Legitimate updates still work ──────────────────────────────────────
  select created_at into v_at from public.sites where id = site_dual;

  update public.sites set name = 'Gamma Site (renamed)', status = 'published'
   where id = site_dual;
  get diagnostics n = row_count;
  assert n = 1, 'an ordinary rename was blocked by the integrity trigger';

  select created_by, organization_id, created_at into v_created, v_org, v_at
    from public.sites where id = site_dual;
  assert v_created = u_dual,      'a rename changed created_by';
  assert v_org = org_c,           'a rename changed organization_id';
  select count(*) into n from public.sites
   where id = site_dual and name = 'Gamma Site (renamed)' and status = 'published';
  assert n = 1, 'the rename did not take effect';

  -- created_at is preserved silently, so a caller echoing it back neither
  -- fails nor rewrites history.
  update public.sites set created_at = now() - interval '10 years' where id = site_dual;
  get diagnostics n = row_count;
  assert n = 1, 'echoing created_at back was refused rather than ignored';
  select count(*) into n from public.sites
   where id = site_dual and created_at = v_at;
  assert n = 1, 'created_at was rewritten by an ordinary update';
  raise notice 'OK 4  ordinary updates still work and leave identity untouched';

  -- ── 6. ON DELETE SET NULL still works ─────────────────────────────────────
  -- The regression this trigger was most likely to cause. The foreign key's
  -- SET NULL is a real UPDATE and fires this trigger; had the rule been
  -- "created_by never changes", it would write back a profile id that no
  -- longer exists and make the profile undeletable.
  --
  -- The departing member is u_leaver, who owns no organization. An owner's
  -- profile cannot be deleted at all — organizations.owner_user_id references
  -- it — so using one here would test that foreign key instead of this trigger.
  -- The realistic case is the employee who built the site moving on.
  perform auth.login_as(u_leaver);
  select public.site_provision(org_a, 'Built by the leaver', 'leaver-site') into site_leaver;
  select created_by into v_created from public.sites where id = site_leaver;
  assert v_created = u_leaver, 'the fixture site is not attributed to the departing member';

  perform auth.as_admin();
  delete from public.profiles where id = u_leaver;

  select count(*) into n from public.sites where id = site_leaver;
  assert n = 1, 'the site was destroyed when its creator was removed';
  select created_by into v_created from public.sites where id = site_leaver;
  assert v_created is null,
    'created_by should be null after the creator is removed, got ' || coalesce(v_created::text, 'null');
  select organization_id into v_org from public.sites where id = site_leaver;
  assert v_org = org_a, 'the site changed organization when its creator left';
  select count(*) into n from public.site_pages where site_id = site_leaver;
  assert n = 1, 'the site lost its homepage when its creator was removed';
  raise notice 'OK 6  a creator''s profile can still be deleted, and the site survives';

  raise notice '';
  raise notice 'SITE IDENTITY: all assertions passed';
end $$;
