-- =============================================================================
-- LOCAL BASIC — 0026 Order totals are derived, not stored input
--
-- Payment already recomputes what to charge from the order's lines, so money
-- was never at risk. But a member holding restaurant.order.update could still
-- write a false total onto the order row, and every screen reading that order
-- would show it. A guest could be told a figure the till would not charge.
--
-- The fix matches how treasury balances and invoice paid_cents already work in
-- Core: the total is a projection of the lines, maintained by the database, so
-- there is nothing to tamper with. Only `discount_cents` remains an input.
-- =============================================================================

create or replace function app.restaurant_sync_order_totals()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_subtotal bigint;
  v_tax      bigint;
begin
  select coalesce(sum(line_total_cents
           - round((line_total_cents * tax_rate_bp)::numeric / (10000 + tax_rate_bp))), 0),
         coalesce(sum(round((line_total_cents * tax_rate_bp)::numeric / (10000 + tax_rate_bp))), 0)
    into v_subtotal, v_tax
    from public.restaurant_order_items
   where order_id = new.id;

  new.subtotal_cents := v_subtotal;
  new.tax_cents      := v_tax;
  new.total_cents    := greatest(v_subtotal + v_tax - coalesce(new.discount_cents, 0), 0);

  return new;
end;
$$;

create trigger restaurant_orders_totals
  before update on public.restaurant_orders
  for each row execute function app.restaurant_sync_order_totals();

-- The lines themselves move the totals: adding, editing or removing an item
-- on an unconfirmed order re-derives the order it belongs to.
create or replace function app.restaurant_touch_order_from_item()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.restaurant_orders
     set updated_at = now()
   where id = coalesce(new.order_id, old.order_id);
  return coalesce(new, old);
end;
$$;

create trigger restaurant_order_items_resync
  after insert or update or delete on public.restaurant_order_items
  for each row execute function app.restaurant_touch_order_from_item();
