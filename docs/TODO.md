# LOCAL BASIC — TODO

Restaurant & Cafe is the active vertical. Medical, Workshop and further Retail
work are paused until the Restaurant MVP passes its definition of done.

## Restaurant MVP — remaining

- [ ] Settings: staff/members list, invite and role assignment UI
- [ ] Settings: roles and permission editor
- [ ] Settings: branches, branding (logo upload, colours, contact)
- [ ] Audit log viewer
- [ ] Printable receipt page for a completed order (data and service exist)
- [ ] Opening hours setting, surfaced on the guest menu
- [ ] Customers screen (Core table, no screen yet)
- [ ] Notification delivery worker + templates for new/confirmed/ready/cancelled
      orders, behind a provider adapter (no provider hardcoded in Core)
- [ ] Playwright end-to-end: provision → menu → QR scan → guest order →
      cashier confirm → kitchen ready → waiter served → payment → receipt
- [ ] CI workflow running typecheck, lint, build, SQL suite, unit tests

## Done

- [x] Restaurant schema: sections, tables, menu, modifiers, orders
- [x] Table and order state machines, enforced by trigger
- [x] QR system on Core public links, opaque tokens, reissue and revoke
- [x] Guest menu and anonymous ordering
- [x] Cashier, kitchen display, waiter view
- [x] Payment through Core invoice + payment + treasury, partial payment
- [x] Expenses and treasury screens
- [x] Restaurant reports
- [x] Critical-flow and security test suites
- [x] Core foundation (phase 1), retail pilot

## Paused — do not start before Restaurant ships

- Retail purchasing, online store, shipping, retail analytics
- Medical vertical
- Workshop vertical
