-- =============================================================================
-- LOCAL BASIC — 0073 Cashier screen: live orders via postgres_changes
--
-- Unlike 0067 (an anonymous customer holding a capability token), the
-- audience here is signed-in staff — the exact case membership-watch.tsx
-- already established the pattern for: postgres_changes on a table that
-- already has correct RLS needs no new broadcast plumbing at all, because
-- Supabase Realtime only ever delivers a change to a subscriber whose own
-- session could SELECT that row directly. restaurant_orders' own
-- orders_select policy (0020) is exactly that gate — branch- and
-- permission-scoped — so adding the table to the publication is the whole
-- fix; no trigger, no hand-built payload, no separate topic-as-credential
-- scheme like 0067 needed for an anonymous holder.
-- =============================================================================

alter publication supabase_realtime add table public.restaurant_orders;
