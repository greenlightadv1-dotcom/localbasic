-- =============================================================================
-- 0104: undo 0103's cross-module role grants.
--
-- `cashier` and `storekeeper` each exist twice as templates — one RETAIL, one
-- RESTAURANT (unique per key + module). 0103 matched templates by key alone,
-- so on databases where it already ran:
--   * the retail cashier template got restaurant.order.cancel / pos.discount,
--   * the retail storekeeper template got the restaurant inventory.* keys and
--     restaurant.menu.read,
--   * the new main_cashier template copied the RETAIL cashier's keys too,
--   * restaurant organizations' storekeeper copies got the retail storekeeper's
--     retail.* keys.
-- A new retail store would have inherited the first two at sign-up. 0103 is
-- corrected for fresh installs; this removes exactly those grants elsewhere.
-- Every statement is a no-op where 0103 ran in its corrected form, so this is
-- safe to run more than once.
-- =============================================================================

-- 1. Retail templates: nothing 0103 introduced belongs there.
delete from public.role_permissions rp
 using public.roles r
 where rp.role_id = r.id and r.organization_id is null and r.module_key = 'retail'
   and (   (r.key = 'cashier' and rp.permission_key in ('restaurant.order.cancel', 'restaurant.pos.discount'))
        or (r.key = 'storekeeper' and (rp.permission_key like 'inventory.%' or rp.permission_key = 'restaurant.menu.read')));

-- 2. main_cashier template: the restaurant cashier's keys plus the oversight
-- keys, nothing from the retail cashier.
delete from public.role_permissions rp
 using public.roles r
 where rp.role_id = r.id and r.organization_id is null and r.key = 'main_cashier'
   and rp.permission_key not in ('restaurant.order.cancel', 'restaurant.pos.discount',
                                 'restaurant.pos.oversee', 'approval.grant')
   and not exists (select 1 from public.roles c join public.role_permissions cp on cp.role_id = c.id
                    where c.organization_id is null and c.key = 'cashier' and c.module_key = 'restaurant'
                      and cp.permission_key = rp.permission_key);

-- 3. Organization copies of the two roles 0103 created, and of the retail
-- roles it touched: drop the keys their own template does not have. Only the
-- keys 0103 could have added are considered, so anything an owner granted by
-- hand on purpose stays.
delete from public.role_permissions rp
 using public.roles r
 where rp.role_id = r.id and r.organization_id is not null and not r.is_owner
   and (   (r.key in ('main_cashier', 'storekeeper') and r.module_key = 'restaurant' and rp.permission_key like 'retail.%')
        or (r.key in ('cashier', 'storekeeper') and r.module_key = 'retail'
            and (rp.permission_key like 'inventory.%'
                 or rp.permission_key in ('restaurant.order.cancel', 'restaurant.pos.discount', 'restaurant.menu.read'))))
   and not exists (select 1 from public.roles t join public.role_permissions tp on tp.role_id = t.id
                    where t.organization_id is null and t.key = r.key
                      and t.module_key is not distinct from r.module_key
                      and tp.permission_key = rp.permission_key);
