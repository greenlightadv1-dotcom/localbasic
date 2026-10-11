-- ---------------------------------------------------------------------------
-- 0082: fixes a mistake in 0081.
--
-- `create or replace function` only replaces a function with the SAME
-- argument types. Appending three new parameters to
-- restaurant_place_public_order/restaurant_place_online_order did not
-- replace the original 5-arg/10-arg functions at all — it created a second
-- overload alongside them. Two consequences, both real:
--
--   1. The old overloads are still callable, with none of 0081's geofencing
--      or device-verification logic. Nothing in this codebase calls them any
--      more (public/service.ts and online/service.ts both send every
--      parameter now), but they are dead weight sitting in the schema.
--   2. Postgres grants EXECUTE to PUBLIC on every new function by default.
--      0081 never ran its own `revoke ... / grant ... to anon, authenticated`
--      for the new overloads the way 0028 ("harden_function_execute_grants")
--      requires for everything else in this schema — they ended up reachable
--      only because PUBLIC happened to cover them, not because anyone
--      decided that on purpose.
--
-- This migration fixes (2): the new overloads' grants are made explicit,
-- matching 0028's convention everywhere else in this file. Dropping the
-- stale old-signature overloads from (1) is 0083 — it is a separate
-- migration because, on this project, DROP FUNCTION needed more than one
-- attempt to apply cleanly where REVOKE/GRANT did not.
-- ---------------------------------------------------------------------------

revoke all on function public.restaurant_place_public_order(text, jsonb, text, text, text, text, numeric, numeric)
  from public;
grant execute on function public.restaurant_place_public_order(text, jsonb, text, text, text, text, numeric, numeric)
  to anon, authenticated;

revoke all on function public.restaurant_place_online_order(
  text, text, jsonb, text, text, text, text, jsonb, text, uuid, text, numeric, numeric
) from public;
grant execute on function public.restaurant_place_online_order(
  text, text, jsonb, text, text, text, text, jsonb, text, uuid, text, numeric, numeric
) to anon, authenticated;
