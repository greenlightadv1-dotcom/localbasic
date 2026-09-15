-- =============================================================================
-- LOCAL BASIC — 0035 Platform-scoped audit
--
-- Platform events — a lead moving through the pipeline, a service withdrawn
-- from sale, a promo code created — belong in the audit trail, but they have no
-- organization. audit_logs.organization_id was NOT NULL, which forced a choice
-- between inventing a second audit table and attributing platform actions to an
-- unrelated tenant.
--
-- Making the column nullable is the smaller, safer change, and it lands exactly
-- right against the two existing policies:
--   * audit_select compares organization_id, so a NULL row is never true for a
--     tenant and stays invisible to every organization;
--   * audit_logs_platform_read does not reference it, so an admin sees it.
--
-- Existing rows are unaffected: nothing is rewritten and no policy changes.
-- =============================================================================

alter table public.audit_logs alter column organization_id drop not null;

-- A tenant event must still name its organization. Only platform actions may
-- omit it, and those are exactly the ones written by the function below.
alter table public.audit_logs
  add constraint audit_logs_platform_scope
  check (organization_id is not null or action like 'platform.%');

create or replace function public.write_platform_audit(
  p_action      text,
  p_entity_type text,
  p_entity_id   text default null,
  p_after       jsonb default null,
  p_org         uuid default null
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_platform_admin();

  -- The prefix is forced rather than trusted, so this function can never be
  -- used to forge a tenant-looking audit line.
  if p_action !~ '^platform\.' then
    raise exception 'platform audit actions must be prefixed platform.'
      using errcode = '22023';
  end if;

  insert into public.audit_logs
    (organization_id, actor_id, actor_label, action, entity_type, entity_id, after)
  values (
    p_org, auth.uid(),
    (select p.full_name from public.profiles p where p.id = auth.uid()),
    p_action, p_entity_type, p_entity_id, p_after
  );
end;
$$;

revoke all on function public.write_platform_audit(text, text, text, jsonb, uuid) from public, anon;
grant execute on function public.write_platform_audit(text, text, text, jsonb, uuid) to authenticated;
