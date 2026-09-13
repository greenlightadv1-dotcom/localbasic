# LOCAL BASIC — TODO

Ordered. Work top to bottom; check items off as they land.

## Phase 2 — Retail: catalog and inventory — DONE
- [x] Migration: categories, products, variants, suppliers
- [x] Migration: stock levels (projection) + stock movements (ledger)
- [x] Concurrency-safe stock application + non-negative CHECK
- [x] RLS policies + grants; movements append-only
- [x] Services: product, inventory, POS
- [x] Screens: products list, new product, inventory with adjustment
- [x] POS till and sale/return transactions
- [ ] Product edit screen (create and list exist; edit not built)
- [ ] Supplier screens (table and policies exist)

## Phase 3 — Retail: purchasing
- [ ] Migration: `retail_purchases`, `retail_purchase_items`
- [ ] Receiving a purchase writes stock movements and a treasury entry
- [ ] Screens: purchase list, create, receive

## Phase 4 — Retail: POS — MOSTLY DONE
- [x] Sale transaction: invoice + items + payment + stock + treasury + audit
- [x] Prices and totals recomputed server-side; the cart never dictates money
- [x] Barcode-first cashier screen with the scan field always refocused
- [x] Returns: linked negative payment + reversing stock movements
- [ ] Receipt view suitable for a thermal printer (`getReceipt` service
      exists; no print route yet)
- [ ] Returns UI (the action and database function exist)
- [ ] Customer attach at the till (search action exists, not wired in)

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
