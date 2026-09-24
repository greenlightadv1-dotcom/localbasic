-- =============================================================================
-- LOCAL BASIC — Realtime on organization_members, for instant sign-out
--
-- The server side of "removal takes effect immediately" was already true the
-- moment member_remove() (0064) commits: app.has_permission() reads
-- organization_members/user_roles live on every request, so the removed
-- member's very next action already fails authorization with no session or
-- cache to invalidate.
--
-- This is the UX half: a tab the removed member still has open should not
-- have to hit "save" and get a 403 to find out. Supabase Realtime, scoped by
-- the SAME RLS the table already carries (members_select_self, 0007) — a
-- postgres_changes subscription only ever receives rows the subscriber's own
-- session could SELECT directly, so this grants no read access beyond what
-- the table's policies already allow. It only makes existing, already-legal
-- reads (a member reading their own membership row) arrive as a push instead
-- of on the next poll.
-- =============================================================================

-- DELETE's old-row payload carries only the primary key under the default
-- replica identity, and the client filters this subscription by user_id, not
-- by the row id (TenantContext does not carry organization_members.id, and
-- widening it for one listener was worse than this). FULL is inexpensive
-- here: staff membership changes are rare, nothing like an orders table.
alter table public.organization_members replica identity full;

alter publication supabase_realtime add table public.organization_members;
