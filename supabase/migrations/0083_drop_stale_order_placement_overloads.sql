-- ---------------------------------------------------------------------------
-- 0083: drops the stale pre-0081 overloads of restaurant_place_public_order
-- and restaurant_place_online_order left behind when `create or replace
-- function` appended new parameters instead of replacing them (see 0082).
-- Nothing in this codebase calls these signatures any more.
-- ---------------------------------------------------------------------------

drop function if exists public.restaurant_place_public_order(text, jsonb, text, text, text);
drop function if exists public.restaurant_place_online_order(text, text, jsonb, text, text, text, text, jsonb, text, uuid);
