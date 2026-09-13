-- =============================================================================
-- LOCAL BASIC — 0027 The kitchen can read the floor plan
--
-- Found while looking at the kitchen display: every ticket read "سفري"
-- (takeaway) because the kitchen role could not read restaurant_tables, so the
-- table name resolved to null. A kitchen has to know which table a dish is for.
--
-- restaurant.table.read is a read-only permission over the floor plan. It grants
-- no financial access and no ability to change a table's state.
-- =============================================================================

insert into public.role_permissions (role_id, permission_key)
select r.id, 'restaurant.table.read'
from public.roles r
where r.key = 'kitchen'
on conflict do nothing;
