# LOCAL BASIC — TODO

Restaurant & Cafe has shipped. Retail is the active vertical. Medical and
Workshop remain paused.

## Retail — remaining


## Remaining

Nothing from the foundation/MVP list is outstanding. The next work is product
decisions rather than gaps:

- [ ] A real SMS or WhatsApp provider (the boundary is in place; no adapter
      exists, and the worker refuses those channels rather than pretending)
- [ ] A courier integration (same shape: an adapter and a provider row)
- [ ] Egyptian e-invoicing, as an adapter, when the business decides to pursue
      it — deliberately not built into Core
- [ ] Medical and Workshop verticals, still paused

## Done

- [x] Core foundation: auth, organizations, branches, memberships, RBAC,
      TenantContext, audit logs, subscriptions/plans, branding, app shell
- [x] Core settings screens: branches, members, roles, branding, audit log
- [x] Retail: catalog, inventory ledger, POS, returns
- [x] Retail: suppliers and purchasing — orders, receiving, supplier payment
- [x] Retail: online store — storefront, cart, guest checkout, order lifecycle,
      completion into a Core receipt with payment and treasury
- [x] Retail: analytics — revenue, cost of goods, margin, channels, top
      products, low stock, purchasing and storefront counts
- [x] Retail: shipping — carriers, parcels per attempt, tracking, carrier cost
      settled through the treasury, behind an adapter boundary
- [x] Notification delivery worker — leased claim, dedupe key, backoff, a
      provider boundary that never claims delivery it did not make
- [x] Invitation accept flow — single-use, expiring, bound to the invited
      address, audited
- [x] Printable receipt carrying the required Egyptian e-invoice disclaimer
- [x] CI workflow: typecheck, permissions, unit tests, SQL suite, production
      build, browser suite
- [x] Restaurant: schema, ordering, payments, QR, operational screens
- [x] Restaurant: online ordering, customer accounts, public website,
      website builder, custom domains + DNS verification hardening
- [x] Platform Admin console: customers, search, billing, provisioning

## Paused — by decision

- Medical vertical (permission separation is preserved in the catalog for it)
- Workshop vertical
