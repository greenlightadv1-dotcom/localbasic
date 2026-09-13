-- =============================================================================
-- LOCAL BASIC — 0010 Explicit privilege grants
--
-- Supabase grants ALL on new public tables to anon/authenticated by default.
-- That default is too generous to rely on, so this migration states the grants
-- deliberately:
--   * anon gets NOTHING on tenant tables. Public storefronts reach data only
--     through the narrow SECURITY DEFINER functions in 0006 / retail.
--   * authenticated gets DML, which RLS then constrains row by row.
--   * append-only tables do not grant UPDATE or DELETE at all, so the
--     append-only guarantee holds even if a policy is added by mistake later.
-- =============================================================================

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;

-- anon may read only the public plan catalog (RLS still applies).
grant select on public.plans to anon;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Append-only ledgers: no UPDATE, no DELETE privilege for anyone but the
-- service role. Belt and braces alongside the missing RLS policies.
revoke update, delete on public.payments               from authenticated;
revoke update, delete on public.treasury_transactions  from authenticated;
revoke update, delete on public.audit_logs             from authenticated;
revoke insert, update, delete on public.audit_logs     from authenticated;
revoke all on public.document_counters                 from authenticated;
revoke all on public.permissions                       from authenticated;
grant select on public.permissions                     to authenticated;
revoke insert, update, delete on public.plans          from authenticated;
revoke insert, update, delete on public.subscriptions  from authenticated;
-- Invoices are never hard-deleted; voiding is an UPDATE.
revoke delete on public.invoices                       from authenticated;
revoke delete on public.customers                      from authenticated;
revoke delete on public.organizations                  from authenticated;
revoke delete on public.branches                       from authenticated;
