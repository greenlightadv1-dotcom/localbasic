-- =============================================================================
-- LOCAL BASIC — 0047 Record the cost on every stock movement
--
-- `retail_stock_movements.unit_cost_cents` has existed since 0012, described
-- there as "cost at the time of the movement, for valuation and margin
-- reporting". Purchasing (0045) fills it, because the supplier's price is the
-- whole point of a receipt. Nothing else did: a POS sale, a return and a
-- storefront order all left it null.
--
-- That only became visible when retail analytics tried to report gross profit.
-- Cost of goods came out as zero, so every sale looked like a 100% margin — a
-- number that is not merely missing but actively misleading, which is worse
-- than showing nothing.
--
-- The fix is a trigger rather than a rewrite of retail_create_sale,
-- retail_create_return and retail_place_order. One rule in one place applies
-- to every writer including future ones, and it cannot be forgotten by the
-- next function that moves stock.
--
-- Two deliberate limits:
--
--   * It only fills a NULL. A caller that knows the real cost — purchasing —
--     keeps saying so, and is never overwritten.
--
--   * It does not touch history. Movements written before this migration keep
--     their null, and the report excludes them from cost rather than guessing
--     a cost they never had. A margin figure over old data is therefore
--     incomplete, not wrong.
-- =============================================================================

create or replace function app.stamp_stock_movement_cost()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.unit_cost_cents is null then
    -- The catalog's current cost, which purchasing keeps up to date as goods
    -- are received. Recorded on the movement so the figure survives the next
    -- price change: what a sale cost is what it cost on the day.
    select v.cost_cents into new.unit_cost_cents
      from public.retail_variants v
     where v.id = new.variant_id;
  end if;
  return new;
end;
$$;

-- Order does not matter here: the projection trigger from 0012
-- (`retail_movements_apply`) maintains quantities and never reads the cost, so
-- whichever of the two BEFORE triggers PostgreSQL runs first, the stamped
-- value is on the row by the time it is written.
create trigger retail_stock_movements_cost
  before insert on public.retail_stock_movements
  for each row execute function app.stamp_stock_movement_cost();

revoke all on function app.stamp_stock_movement_cost() from public, anon, authenticated;
