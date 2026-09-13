# LOCAL BASIC — TODO

Ordered. Work top to bottom; check items off as they land.

## Phase 2 — Retail: catalog and inventory
- [ ] Migration: `retail_categories`, `retail_products`, `retail_variants`
      (SKU, barcode, price_cents, cost_cents), `retail_suppliers`
- [ ] Migration: `retail_stock_levels` (projection) + `retail_stock_movements`
      (the ledger: variant, branch, qty_delta, reason, ref, user, timestamp)
- [ ] `apply_stock_movement()` — `SELECT … FOR UPDATE` on the stock row inside
      the transaction, plus `CHECK (quantity >= 0)` as the backstop
- [ ] RLS policies + grants for every retail table; movements append-only
- [ ] Regenerate `src/types/database.ts`
- [ ] Services: product, variant, inventory, supplier
- [ ] Screens: products list/create/edit, inventory, stock adjustment

## Phase 3 — Retail: purchasing
- [ ] Migration: `retail_purchases`, `retail_purchase_items`
- [ ] Receiving a purchase writes stock movements and a treasury entry
- [ ] Screens: purchase list, create, receive

## Phase 4 — Retail: POS
- [ ] Sale service: one transaction → invoice + items + payment + stock
      movements + treasury entry
- [ ] Prices and totals recomputed server-side; the cart never dictates money
- [ ] Barcode-first cashier screen, keyboard-only path, numeric keypad
- [ ] Returns: linked negative payment + reversing stock movements
- [ ] Receipt view suitable for a thermal printer

## Phase 5 — Core screens still missing
- [ ] Customers: list, create, edit, detail
- [ ] Invoices: list, detail, void
- [ ] Payments: list, record, refund
- [ ] Treasury: accounts, ledger, expenses
- [ ] Settings: branches, members + invitations, roles, branding
- [ ] Audit log viewer
- [ ] Invitation accept flow (function + UI)

## Phase 6 — Online store
- [ ] Migration: `retail_store_settings`, `retail_orders`,
      `retail_order_items`, `retail_shipments`
- [ ] `public_store_*` SECURITY DEFINER projections — anon never reads a
      tenant table
- [ ] Storefront, cart, checkout, order confirmation, order status by token
- [ ] Online orders decrement the same inventory as the POS
- [ ] Shipping abstraction: carrier, tracking number, status, waybill data

## Phase 7 — Analytics and notifications
- [ ] Retail analytics: sales, revenue, best sellers, slow movers, low stock,
      by branch / cashier / channel, returns, discounts, average order value
- [ ] Notification sender worker (service role) + templates

## Phase 8 — Hardening
- [ ] Vitest unit tests: money maths, permission resolution, action wrapper
- [ ] SQL tests: inventory concurrency (two concurrent sales, no oversell),
      financial integrity, retail tenant isolation
- [ ] Playwright: sign-up → provision → add product → POS sale → receipt
- [ ] CI workflow running typecheck, lint, build, SQL suite, unit tests
- [ ] Documentation: architecture, database, security, deployment,
      adding a vertical, adding permissions
