-- =============================================================================
-- LOCAL BASIC — RBAC reconciliation (READ ONLY)
--
-- Investigative report for the privilege-escalation paths that migration 0053
-- closed. It finds role/permission combinations that the product could not have
-- produced by itself, so an operator can look at them. It decides nothing and
-- changes nothing.
--
--   psql "$DATABASE_URL" -f supabase/scripts/rbac_reconciliation.sql
--
-- Narrow the window to the vulnerable period by passing the time 0053 was
-- deployed (anything created after it could not have used those paths):
--
--   psql "$DATABASE_URL" -v cutoff="2026-09-19T18:00:00Z" \
--        -f supabase/scripts/rbac_reconciliation.sql
--
-- SAFETY
--
-- The whole script runs inside `set transaction read only` and ends in
-- ROLLBACK. PostgreSQL refuses INSERT, UPDATE, DELETE, CREATE — including
-- temporary tables — inside such a transaction, so this is enforced by the
-- server rather than promised by the author. It is safe against production.
--
-- WHAT IT CANNOT PROVE
--
-- `role_permissions` carries `created_at` and NOTHING ELSE: no `granted_by`,
-- and no trigger writes an audit line when a permission is attached to a role.
-- So for the main escalation path the database can say WHEN a permission was
-- attached and never WHO attached it. No output of this script can therefore be
-- CONFIRMED; the strongest available verdict is SUSPICIOUS.
--
-- WHY A CUSTOM ROLE IS NOT A FINDING
--
-- An organization may create its own roles, and their permission sets were
-- never templated — divergence from a template is not even defined for them.
-- Only roles cloned from a template (`is_system = true`) have a baseline, and
-- only those are compared. Custom roles are counted in section 5 for context
-- and never reported as suspicious.
-- =============================================================================

\set ON_ERROR_STOP on

\if :{?cutoff}
\else
  -- No cutoff given: nothing can be ruled out on age, so put the boundary at
  -- the end of time. `-infinity` would be backwards — every row is after it,
  -- and the report would clear everything it found.
  \set cutoff 'infinity'
\endif

begin;
set transaction read only;

\echo ''
\echo '=== LOCAL BASIC — RBAC reconciliation (read only) ==========================='
\echo 'Cutoff (0053 deployment); rows at or after it could not have used the'
\echo 'vulnerable paths:'
\echo :'cutoff'
\echo ''

-- ---------------------------------------------------------------------------
-- 0. What provenance this database actually holds.
--
-- Printed first so nobody reads the sections below as more than they are.
-- ---------------------------------------------------------------------------
\echo '--- 0. Available evidence ---------------------------------------------------'
select
  'role_permissions.granted_by' as evidence,
  case when exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'role_permissions'
      and column_name = 'granted_by'
  ) then 'present' else 'ABSENT — who granted a permission is unknowable' end as status
union all
select 'role_permissions audit trigger',
  case when exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'role_permissions' and not t.tgisinternal
  ) then 'present' else 'ABSENT — permission grants leave no audit line' end
union all
select 'user_roles.granted_by',
  case when exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_roles'
      and column_name = 'granted_by'
  ) then 'present — role assignment has an actor' else 'ABSENT' end
union all
select 'invitations.invited_by',
  case when exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'invitations'
      and column_name = 'invited_by'
  ) then 'present — invitations have an actor' else 'ABSENT' end
union all
select 'previous organization owner',
  'ABSENT — organizations keeps no ownership history';

-- ---------------------------------------------------------------------------
-- 1. Template-cloned roles holding permissions their template never had.
--
-- This is the main report. Provisioning clones a template's permission set
-- exactly (0031), and the application contains NO write path to
-- role_permissions — the roles screen is read-only. A system role that differs
-- from its template was therefore written directly against the API or the
-- database: either by the pre-0053 escalation, or by an operator working by
-- hand. The database cannot tell those apart, which is why this is SUSPICIOUS
-- and never CONFIRMED.
-- ---------------------------------------------------------------------------
\echo ''
\echo '--- 1. System roles holding permissions their template lacks ----------------'
with template as (
  select r.id, r.key, coalesce(r.module_key, '') as module_key
  from public.roles r
  where r.organization_id is null
),
template_perm as (
  select t.key, t.module_key, rp.permission_key
  from template t
  join public.role_permissions rp on rp.role_id = t.id
),
org_role as (
  select r.id, r.organization_id, r.key, coalesce(r.module_key, '') as module_key,
         r.name_ar, r.created_at, r.updated_at, r.is_owner, r.is_system
  from public.roles r
  where r.organization_id is not null
    and r.is_system          -- cloned from a template; custom roles have no baseline
    and not r.is_owner       -- the owner role holds the whole catalog by design
)
select
  o.slug                                as organization,
  orr.key                               as role_key,
  orr.name_ar                           as role_name,
  rp.permission_key                     as permission,
  rp.created_at                         as permission_attached_at,
  orr.created_at                        as role_created_at,
  case
    when not exists (select 1 from template t
                     where t.key = orr.key and t.module_key = orr.module_key)
      then 'UNKNOWN'
    else 'SUSPICIOUS'
  end                                   as confidence,
  case
    when not exists (select 1 from template t
                     where t.key = orr.key and t.module_key = orr.module_key)
      then 'no template with this key/module exists now — no baseline to compare against'
    when rp.created_at >= :'cutoff'::timestamptz
      then 'not in the template; attached AFTER the cutoff, so not via the closed paths'
    else 'not in the template, and the product has no way to add it'
  end                                   as reason
from org_role orr
join public.organizations o on o.id = orr.organization_id
join public.role_permissions rp on rp.role_id = orr.id
where not exists (
  select 1 from template_perm tp
  where tp.key = orr.key and tp.module_key = orr.module_key
    and tp.permission_key = rp.permission_key
)
order by confidence, o.slug, orr.key, rp.permission_key;

-- ---------------------------------------------------------------------------
-- 2. Roles a member granted to themselves.
--
-- The signature of the user_roles escalation path. Exactly one legitimate case
-- exists and is excluded: provisioning gives the founding owner their own owner
-- role, in the same transaction that creates the organization — so the two rows
-- carry the identical now() timestamp, which is what identifies it here.
--
-- Matching on organizations.owner_user_id instead would be a mistake: that is
-- the field the fourth escalation path rewrites, so an attacker who took
-- ownership of record would erase their own entry from this report.
--
-- Owner-role self-grants are NOT excluded wholesale, because before 0053 a
-- member.manage holder could assign themselves the owner role — the worst case
-- this section exists to surface.
--
-- Accepting an invitation records the INVITER in granted_by, so a normal
-- invitation never looks like this.
--
-- ATTRIBUTION IS NOT TRUSTWORTHY HERE. `granted_by` has no default and the
-- pre-0053 policy never required it, so a direct API insert could omit it or
-- name somebody else. That is why this section also flags rows with no actor
-- and rows naming a non-member: a missing actor is itself the evidence, and
-- the name in the column is a lead rather than a fact.
-- ---------------------------------------------------------------------------
\echo ''
\echo '--- 2. Role assignments the product could not have produced -----------------'
select
  o.slug                     as organization,
  r.key                      as role_key,
  ur.created_at              as assigned_at,
  case
    when ur.created_at >= :'cutoff'::timestamptz then 'UNKNOWN'
    -- A missing actor proves the row was not written by the product. It does
    -- NOT prove escalation: a seed, a data migration or an operator working in
    -- SQL all look identical. That is UNKNOWN, not SUSPICIOUS.
    when ur.granted_by is null then 'UNKNOWN'
    else 'SUSPICIOUS'
  end                        as confidence,
  case
    when ur.granted_by is null
      then 'no actor recorded — written outside the product (escalation, seed, '
           || 'data migration or an operator in SQL are indistinguishable here)'
    when not exists (
      select 1 from public.organization_members gm
      where gm.organization_id = m.organization_id and gm.user_id = ur.granted_by
    ) then 'the recorded actor is not a member of this organization'
    else 'member assigned this role to themselves; only provisioning does that legitimately'
  end                        as reason
from public.user_roles ur
join public.organization_members m on m.id = ur.member_id
join public.roles r on r.id = ur.role_id
join public.organizations o on o.id = m.organization_id
where (
    -- Self-assignment.
    ur.granted_by = m.user_id
    -- No actor at all. The column has no default and the policy never required
    -- it, so a direct API insert could simply omit it — and an attacker would.
    or ur.granted_by is null
    -- An actor who does not belong here.
    or not exists (
      select 1 from public.organization_members gm
      where gm.organization_id = m.organization_id and gm.user_id = ur.granted_by
    )
  )
  -- Provisioning's own owner grant: same transaction, same timestamp.
  and not (r.is_owner and ur.created_at = o.created_at)
order by confidence, o.slug, r.key;

-- ---------------------------------------------------------------------------
-- 3. Invitations carrying roles the inviter does not hold today.
--
-- `invited_by` and `role_ids` are recorded, so this path has an actor. The
-- comparison is against what the inviter holds NOW — permission history is not
-- kept, so an inviter who legitimately held more at the time will appear here.
-- Treat it as a pointer, not a verdict.
-- ---------------------------------------------------------------------------
\echo ''
\echo '--- 3. Invitations carrying roles the inviter does not currently hold -------'
select
  o.slug            as organization,
  i.created_at      as invited_at,
  i.accepted_at,
  r.key             as invited_role,
  'SUSPICIOUS'      as confidence,
  'the inviter does not hold every permission in this role today; '
  || 'they may have held it then — permission history is not kept' as reason
from public.invitations i
join public.organizations o on o.id = i.organization_id
cross join lateral unnest(i.role_ids) as role_id
join public.roles r on r.id = role_id
where i.invited_by is not null
  and exists (
    select 1
    from public.role_permissions rp
    where rp.role_id = r.id
      and not exists (
        select 1
        from public.organization_members m2
        join public.user_roles ur2 on ur2.member_id = m2.id
        join public.role_permissions rp2
          on rp2.role_id = ur2.role_id and rp2.permission_key = rp.permission_key
        where m2.organization_id = i.organization_id
          and m2.user_id = i.invited_by
          and m2.status = 'active'
      )
  )
order by o.slug, i.created_at;

-- ---------------------------------------------------------------------------
-- 4. Ownership of record.
--
-- Listed for completeness and deliberately unclassified. organizations keeps
-- no previous owner, so whether owner_user_id was ever reassigned cannot be
-- answered from the database at all. 0053 freezes it from here on.
-- ---------------------------------------------------------------------------
\echo ''
\echo '--- 4. Organization ownership (informational; history is not retained) ------'
select
  o.slug                        as organization,
  o.created_at                  as organization_created_at,
  o.updated_at                  as last_modified_at,
  case when exists (
    select 1 from public.organization_members m
    join public.user_roles ur on ur.member_id = m.id
    join public.roles r on r.id = ur.role_id and r.is_owner
    where m.organization_id = o.id and m.user_id = o.owner_user_id
  ) then 'owner of record also holds the owner role'
    else 'OWNER OF RECORD DOES NOT HOLD THE OWNER ROLE — worth a look'
  end                           as note
from public.organizations o
where o.deleted_at is null
order by o.slug;

-- ---------------------------------------------------------------------------
-- 5. Context: how much of the estate is custom by design.
--
-- A custom role is a supported product feature. This is here so nobody reads
-- section 1 as "every divergence in the system".
-- ---------------------------------------------------------------------------
\echo ''
\echo '--- 5. Role population (context, not findings) ------------------------------'
select
  case
    when r.organization_id is null then 'template'
    when r.is_owner                then 'owner role (holds the whole catalog by design)'
    when r.is_system               then 'cloned from a template (has a baseline)'
    else 'LEGITIMATE_CUSTOMIZATION — created by the organization, no baseline'
  end                as role_class,
  count(*)           as roles
from public.roles r
group by 1
order by 1;

rollback;

\echo ''
\echo '=== End of report. Nothing was modified (read-only transaction, rolled back).'
\echo ''
