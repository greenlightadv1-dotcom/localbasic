-- =============================================================================
-- LOCAL BASIC — 0056 Site identity integrity
--
-- 0055 gave public.sites correct policies and a correct provisioning function,
-- and then trusted the client for two columns the policies never look at.
--
-- app.has_permission(organization_id, 'site.manage') decides WHETHER a member
-- may write a site row. It says nothing about WHAT that row may claim. So a
-- member holding site.manage could, through PostgREST and without touching the
-- application at all:
--
--   * insert a site attributing authorship to any other profile, because
--     created_by is an ordinary writable column that only site_provision()
--     ever set correctly; and
--   * update a site's organization_id to a second organization they also
--     administer, because sites_update's WITH CHECK re-tests the permission
--     against the NEW row and passes when the caller administers both sides.
--
-- Neither is reachable from the product today — the Site Engine has no public
-- route and no update path — which is exactly why this is the moment to pin
-- the invariant, before the editor is written against a weaker one.
--
-- This migration is additive: one function, one trigger. No table, column,
-- policy, grant or permission is altered, and no existing row is touched.
-- The application's only write path, site_provision(), already sets
-- created_by to auth.uid(), so every legitimate write agrees with the trigger
-- and no behaviour changes for any caller acting in good faith.
--
-- -----------------------------------------------------------------------------
-- WHY created_by IS NOT SIMPLY IMMUTABLE
--
-- sites.created_by is `references public.profiles(id) on delete set null`, and
-- 0055 chose SET NULL deliberately: an organization's website must survive the
-- departure of the employee who created it. A referential action is a real
-- UPDATE and fires row triggers, so a trigger that restored old.created_by
-- unconditionally would fight the foreign key — it would write back a profile
-- id that no longer exists and fail the constraint, making it impossible to
-- delete any profile that had ever created a site.
--
-- The invariant is therefore narrower and exactly matches the threat:
--
--     created_by may be cleared. It may never be pointed at somebody else.
--
-- Clearing destroys attribution; it cannot manufacture it. A two-step forge
-- (set null, then set to self) is closed by the same rule, because the second
-- step is still a change to a non-null value.
-- -----------------------------------------------------------------------------
--
-- SECURITY INVOKER, deliberately. The function reads NEW, OLD and auth.uid()
-- and touches no table, so it needs no elevated rights — and a SECURITY
-- DEFINER trigger on a FORCE RLS table is a bypass waiting to be found. The
-- trigger constrains the CONTENT of a write; app.has_permission() and the
-- policies still decide whether the write happens at all. It is not, and must
-- not become, the authorization check.
-- =============================================================================

create or replace function app.check_site_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    -- SET, never accepted. Whatever the caller sent is discarded, so
    -- attribution cannot be forged through any path that reaches this table.
    --
    -- A caller with no authenticated identity (service_role, or a future
    -- maintenance job) records NULL rather than a value it supplied. The
    -- column is nullable and NULL is the honest answer: no user created this
    -- row. There is no such write path today — sites is granted to
    -- `authenticated` only, and both the insert policy and site_provision()
    -- require a live auth.uid() — so this is a floor, not a behaviour.
    new.created_by := auth.uid();

  else
    -- An organization's website is not portable. Moving one is a transfer:
    -- a distinct, audited, explicitly authorized operation that does not
    -- exist yet and must not be reachable as a side effect of an ordinary
    -- field update. Both columns are NOT NULL, so <> is total here.
    if new.organization_id <> old.organization_id then
      raise exception 'a site cannot be moved to another organization'
        using errcode = '22023';
    end if;

    -- Authorship may be cleared, never reassigned. `is distinct from` rather
    -- than <> so that a NULL on either side compares as a real difference;
    -- the null-safe form is what lets the ON DELETE SET NULL path through
    -- while still refusing a change to a different person.
    if new.created_by is distinct from old.created_by
       and new.created_by is not null then
      raise exception 'a site''s creator cannot be reassigned'
        using errcode = '22023';
    end if;

    -- Creation time is a fact about the row, not a field. Preserved silently
    -- rather than refused: nothing writes it, so a caller that echoes it back
    -- unchanged is the only realistic case and should not fail. Raising here
    -- would add a failure mode without closing an attack.
    new.created_at := old.created_at;
  end if;

  return new;
end;
$$;

-- BEFORE INSERT OR UPDATE, one trigger rather than two: the two branches share
-- the same subject — which row this is and whose it is — and splitting them
-- would mean two places to look when the answer is one rule with two halves.
--
-- Named so it sorts before sites_touch, which is also BEFORE UPDATE: identity
-- is settled first, then updated_at is stamped. The two touch disjoint columns
-- so the order is not load-bearing; it is merely the order that reads right.
--
-- sites.id needs no guard: site_pages.site_id references it with the default
-- NO ACTION on update, so changing a site's primary key already fails on the
-- foreign key.
create trigger sites_integrity
  before insert or update on public.sites
  for each row execute function app.check_site_identity();
