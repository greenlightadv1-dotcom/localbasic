-- Every table in this schema carries FORCE ROW LEVEL SECURITY (00_schema_guards.sql
-- asserts it with no exceptions) — 0081 enabled RLS on restaurant_guest_devices
-- but missed forcing it.
alter table public.restaurant_guest_devices force row level security;
