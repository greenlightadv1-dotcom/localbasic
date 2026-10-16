-- =============================================================================
-- LOCAL BASIC — clean up before 0106/0107 (run ONCE, before 0106)
-- Removes six EMPTY tables (and two unused restaurant_orders columns) that
-- came from a schema outside this repository and block 0106/0107. Stops
-- without changing anything if any of them holds data. Not a migration: fresh
-- installs never had these tables (every statement is a no-op there).
-- =============================================================================
do $$
declare t text; n bigint;
begin
  foreach t in array array['restaurant_delivery_zones', 'restaurant_drivers', 'restaurant_house_accounts', 'restaurant_promotions',
                           'restaurant_driver_assignments', 'restaurant_house_account_transactions'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then raise exception 'public.% has % rows — cleanup stopped, nothing changed', t, n; end if;
    end if;
  end loop;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'restaurant_orders' and column_name = 'delivery_zone_id') then
    execute 'select count(*) from public.restaurant_orders where delivery_zone_id is not null' into n;
    if n > 0 then raise exception 'restaurant_orders.delivery_zone_id is used by % orders — cleanup stopped', n; end if;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'restaurant_orders' and column_name = 'driver_id') then
    execute 'select count(*) from public.restaurant_orders where driver_id is not null' into n;
    if n > 0 then raise exception 'restaurant_orders.driver_id is used by % orders — cleanup stopped', n; end if;
  end if;
end $$;

alter table public.restaurant_orders drop column if exists delivery_zone_id, drop column if exists driver_id;
drop table if exists public.restaurant_driver_assignments;
drop table if exists public.restaurant_house_account_transactions;
drop table if exists public.restaurant_drivers;
drop table if exists public.restaurant_delivery_zones;
drop table if exists public.restaurant_house_accounts;
drop table if exists public.restaurant_promotions;
