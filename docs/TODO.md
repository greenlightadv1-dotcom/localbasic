# LOCAL BASIC — TODO

Restaurant & Cafe has shipped. Retail is the active vertical. Medical and
Workshop remain paused.

## Retail — remaining

- [ ] Notification delivery worker + templates, behind a provider adapter

## Core — remaining

- [ ] Invitation accept flow (table and policies exist; no UI, no accept function)
- [ ] Printable receipt page for a completed order (data and service exist)
- [ ] CI workflow: typecheck, build, SQL suite, unit tests, Playwright

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
- [x] Restaurant: schema, ordering, payments, QR, operational screens
- [x] Restaurant: online ordering, customer accounts, public website,
      website builder, custom domains + DNS verification hardening
- [x] Platform Admin console: customers, search, billing, provisioning

## Paused — by decision

- Medical vertical (permission separation is preserved in the catalog for it)
- Workshop vertical
