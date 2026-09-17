# LOCAL BASIC — PROJECT STATUS

Updated at the end of every implementation batch. Read this first when
resuming work.

## Current phase

**Restaurant & Cafe shipped. Retail is the active vertical again.** Medical and
Workshop remain paused by decision.

- **Phase 1 — Core foundation: COMPLETE**, including the settings screens
  (branches, members, roles, branding, audit log).
- **Restaurant & Cafe: COMPLETE** — schema, ordering, payments, QR, all
  operational screens, online ordering, customer accounts, the public website,
  the website builder, and custom domains with DNS verification.
- **Platform Admin console: COMPLETE** — customers, search, subscriptions,
  provisioning, billing.
- **Retail: catalog, inventory, POS, returns, PURCHASING, the ONLINE STORE,
  ANALYTICS and SHIPPING complete.** Remaining for the retail vertical:
  notification delivery.

## Decisions in force

| # | Decision |
|---|---|
| 1 | Retail is the pilot vertical. |
| 2 | Multi-vertical ready: `organization_modules` is the authoritative list of enabled verticals; `organizations.primary_module` is a convenience pointer only. A second vertical for one organization is an extra row, not a migration. |
| 3 | Core never imports from a vertical module. Verticals use Core services (customers, invoices, payments, treasury, audit, public links). |
| 4 | All blueprint security decisions hold: RLS everywhere, append-only ledgers, integer money, 404-not-403, opaque public tokens. |

## What exists and works

### Database — `supabase/migrations/0001`–`0010`
Applied cleanly to PostgreSQL 16 and covered by tests.

- **0001** profiles, organizations, organization_modules, branches,
  organization_members, member_branches, invitations
- **0002** permissions, roles, role_permissions, user_roles + cross-tenant
  guard triggers
- **0003** RLS helper functions (`app.is_member_of`, `app.can_access_branch`,
  `app.has_permission`, `app.has_branch_permission`, `app.is_owner`)
- **0004** plans, subscriptions, branding_settings, settings, audit_logs,
  notifications
- **0005** customers, document_counters, invoices, invoice_items, payments,
  treasury_accounts, treasury_transactions
- **0006** public_links, qr_codes, `resolve_public_link()`
- **0007** RLS policies for every Core table
- **0008** permission catalog, role templates, plans seed
- **0009** `provision_workspace()` — the whole workspace in one transaction
- **0010** explicit privilege grants; anon revoked from all tenant tables

### Later migrations — `supabase/migrations/0027`–`0045`

Summarised; each file carries its own reasoning at the top.

- **0027–0028** kitchen table visibility; function EXECUTE grants hardened
  (PostgreSQL grants EXECUTE to PUBLIC on creation — always revoke first)
- **0029–0035** Platform Admin: admins, billing, plans, subscriptions, leads,
  services, customer onboarding, platform audit
- **0036–0038** restaurant online orders, their functions, and the settings
  that gate them
- **0039** public restaurant website
- **0040** customer accounts (optional, on top of guest ordering)
- **0041** platform console search and customer projections
- **0042** website builder: ordered sections, theme, draft vs published
- **0043** custom domains: normalized hostname identity, DNS-TXT verification,
  state machine, public resolver
- **0044** verification hardening: the write is `service_role` only, and the
  hostname to look up comes from the table rather than the browser
- **0045** retail purchasing: purchase orders, receiving into the stock ledger,
  supplier payment out of the treasury
- **0046** retail online store: orders, guest checkout, storefront projections,
  and completion into a Core receipt
- **0047** every stock movement records the cost it was made at, so margin
  reporting has a real figure instead of an implied 100%
- **0048** the Platform Admin roster can be managed in-product: an owner grants
  and revokes at `/admin/team`, staff may read it. The FIRST admin is still
  installed out-of-band on purpose — see docs/SUPABASE.md
- **0049** shipping: carriers per organization, a shipment per attempt, an
  enumerated parcel state machine, and the carrier's cost settled through the
  treasury. No courier is named in the schema

### Retail — `supabase/migrations/0011`–`0015`
- **0011** retail_categories, retail_suppliers, retail_products,
  retail_variants (SKU/barcode unique per organization)
- **0012** retail_stock_movements (the ledger) + retail_stock_levels
  (a projection written only by trigger), non-negative CHECK, row-lock
  update-then-insert so concurrent sales serialise
- **0013** retail RLS: sales need retail.pos.use, receiving needs
  retail.purchase.manage, everything else needs retail.inventory.adjust
- **0014** `retail_create_sale()` — invoice, items, stock, payment, treasury
  and audit in one transaction, priced entirely from the database
- **0015** `retail_create_return()` — linked negative payment, stock back,
  treasury withdrawal; the original sale is never edited
- **0045** purchasing: `retail_purchase_orders` + items, with totals derived by
  trigger, an enumerated state machine, and five functions —
  `retail_purchase_create`, `_submit`, `_receive`, `_cancel`, `_pay`.
  Receiving writes `retail_stock_movements` with reason `purchase`, so POS,
  the storefront and purchasing share one stock truth. Paying a supplier is a
  treasury `out` transaction, and `paid_cents` is recomputed from that ledger
  rather than incremented.
- **0046** online store: `retail_orders` + items + deliveries, totals derived by
  trigger, an enumerated state machine (placed → confirmed → packed →
  fulfilled → completed, cancellable until completed).
  **Stock is committed at checkout**, through the same ledger the POS writes —
  that is what stops the till and the storefront selling the same last unit.
  Cancelling writes a compensating movement.
  **An order is not an invoice**: `retail_order_complete` produces the Core
  invoice, payment and treasury entry, and only then does money exist.
  The anonymous surface is four SECURITY DEFINER projections
  (`retail_store_context`, `_catalog`, `retail_price_cart`,
  `retail_place_order`) plus two token-scoped readers; `anon` holds no
  privilege on any store table. No payment provider is invented — the
  storefront offers cash on delivery or pay on collection.
- **0049** shipping: `retail_shipping_providers` (the shop's own list of
  carriers) and `retail_shipments` (one row per ATTEMPT, so a failed delivery
  and its retry are both on the record). The parcel's address is COPIED from
  the order inside the database — `retail_shipment_create` has no argument
  through which a caller could name one. A tracking code is accepted, never
  generated. What the customer PAID for delivery stays the order's
  `delivery_fee_cents`; what the shop PAYS the carrier is a treasury `out`
  movement with category `shipping`, so margin stays honest.
  `src/modules/retail/shipping/carrier.ts` is the adapter boundary: an
  implementation reports what a carrier said and never decides a status, and
  `ManualCarrier` — the shop's own rider — books nothing and tracks nothing
  rather than faking either. A real courier is a class there and a row in the
  providers table, not a migration.

Retail application code: `src/modules/retail/{products,inventory,pos}`,
actions in the branch route, and screens for products, new product,
inventory (with stock adjustment) and the POS till.

### Restaurant — `supabase/migrations/0016`–`0026`
- **0016** sections and tables + table state machine
- **0017** menu: categories, products, variants, modifier groups, modifiers,
  per-branch availability
- **0018** orders, items, item modifiers, price snapshots, order state machine
- **0019** restaurant permissions + cashier/kitchen/waiter templates
- **0020** restaurant RLS and grants
- **0021** order creation and status transitions
- **0022** public surface: QR context, menu, guest ordering, order status
- **0023** payment (Core invoice + payment + treasury) and QR issuing
- **0024** Core module bootstrap hook (reusable, names no vertical)
- **0025** restaurant bootstrap: a section, six tables and a QR each
- **0026** order totals derived from lines by trigger

Restaurant application code: `src/modules/restaurant/{menu,tables,orders,public,reports}`,
`restaurant-actions.ts`, and screens for cashier, kitchen, waiter, orders,
tables + QR print, menu, reports, expenses and treasury, plus the public
guest menu at `/p/[token]`.

### Application
- `src/lib/` — env parsing, typed errors, integer money, rate limiting,
  opaque tokens, `cn`
- `src/lib/supabase/` — three clients: browser (anon), server (anon + user
  session, the default), admin (service role, `server-only`)
- `src/lib/action.ts` — `defineTenantAction` / `defineUserAction` /
  `definePublicAction`: the single choke point enforcing auth → rate limit →
  tenant context → permission → Zod → handler
- `src/modules/core/tenancy/` — `TenantContext`, `resolveTenantContext`,
  `requirePermission`, provisioning service
- `src/modules/core/rbac/permissions.ts` — typed permission keys
- `src/modules/core/branding/` — per-org branding; white-label gated by plan
- `src/modules/core/reports/` — dashboard summary
- `src/middleware.ts` — session refresh + nonce CSP + security headers
- `src/config/modules.tsx` — the module registry Core reads navigation from
- UI: design tokens from the logo, Logo/PoweredBy, Button, Field/Input/Select,
  Card, Badge, Alert, Money, PageHeader, and the four list states
  (Skeleton/TableSkeleton/EmptyState/ErrorState)
- Routes: sign-in, sign-up, auth callback, onboarding + provisioning,
  workspace shell with branch switcher, dashboard, error/not-found/loading

### Tooling
- `scripts/gen-db-types.py` — generates `src/types/database.ts` from the live
  schema, so types always match the committed migrations
- `supabase/tests/run.sh` — applies every migration to a throwaway database
  and runs the SQL suite

## Verified

- `npx tsc --noEmit` — clean
- `npx next build` — succeeds, 20 routes
- `node scripts/check-permissions.mjs` — TypeScript and SQL catalogs in sync
- `npx vitest run` — 9 tests pass (integer money arithmetic)
- `supabase/tests/run.sh` — all pass:
  - `00_schema_guards` structural invariants
  - `01_tenant_isolation` cross-tenant reads/writes/IDOR, append-only,
    branch scoping, privilege escalation, anonymous access
  - `02_retail_inventory` projection tracks ledger, oversell refused,
    permission separation
  - `03_inventory_concurrency` two real connections sell the last unit;
    exactly one commits
  - `04_retail_sale` database-authoritative pricing, mixed tax basket,
    tender/change, failed sale leaves nothing, discount privilege, returns
  - `05_restaurant_flow` the full 15-step journey end to end
  - `06_restaurant_security` cross-tenant and cross-branch isolation,
    kitchen/waiter financial lockout, invalid transitions, client price,
    total and discount manipulation, duplicate payment, public token scope
    and revocation
  - `07_permission_catalog` no orphan grants, owners hold the full catalog,
    kitchen and waiter templates hold nothing sensitive

## Known gaps (tracked in TODO.md)

Retail, in the order they are being built:

- Online store: storefront, cart, checkout, orders (schema and permission keys
  exist: `retail.order.*`, `retail.store.manage`)
- Shipping abstraction (a provider adapter, nothing hardcoded in Core)
- Notification delivery worker — the table and queue exist, there is no sender
- Retail analytics

Core, still open:

- Invitation accept flow: the table and policies exist, no UI or accept function
- Printable receipt page for a completed order (the data and service exist)
- CI workflow running typecheck, build, the SQL suite and the unit tests

## Gotchas worth remembering

1. **`RETURNING` applies SELECT policies.** An RLS helper must never re-read
   the table it guards, or `INSERT ... RETURNING` fails its own policy. This is
   why `can_access_branch` and `has_branch_permission` take `organization_id`
   explicitly instead of deriving it from `branches`.
2. **PL/pgSQL `RETURNS TABLE` output names shadow column names** inside the
   function body. `provision_workspace` prefixes its outputs `out_*`.
3. **postgrest-js type depth.** Emitting `Relationships` for all 26 tables
   exceeds TypeScript's instantiation depth and every query silently becomes
   `never`. The generator emits them only for tables in `EMBEDDED_TABLES`.
4. **`@supabase/ssr` must track `supabase-js`.** Version 0.5.x against
   supabase-js 2.116 produced `never` rows. Pinned to 0.12.x.
5. **`SET LOCAL ROLE` does not propagate out of a PL/pgSQL function.** The test
   harness uses `set_config('role', …)`, otherwise assertions run as the table
   owner and FORCE RLS is silently untested.
6. **A PL/pgSQL variable that shares a name with a column is ambiguous.** The
   restaurant flow test hit this with `order_id`; local variables are prefixed
   `v_` for that reason.
7. **A cap must discard the stalest rows, not the newest.** `listOrders` asked
   the database for oldest-first and then capped at 100, so a branch with more
   than a hundred open orders stopped seeing the ones it had just taken. The
   query now takes the most recent window and the queue order is restored in
   the service. Any list that pairs an ORDER BY with a LIMIT needs the same
   check.
8. **A 404 on `/admin/*` usually means an empty roster, not a broken route.**
   The Platform Admin gate answers not-found rather than forbidden, so a
   deployment where `platform_admins` has no rows is indistinguishable from one
   with no console. Nothing in migrations or the seed ever inserts that first
   row; it is installed out-of-band by design. Check the table before debugging
   routing. Everything after the first admin now happens at `/admin/team`.
9. **A column that exists is not a column that is filled.**
   `retail_stock_movements.unit_cost_cents` was defined in 0012 "for valuation
   and margin reporting" and only purchasing ever wrote it. Analytics then
   reported cost of goods as zero, which reads as a 100% margin — a number that
   misleads rather than merely missing. 0047 stamps it with a trigger, which
   covers every writer including future ones. History keeps its nulls and is
   excluded from cost rather than guessed.
10. **Parse once, at the action boundary.** `defineTenantAction` validates the
   payload; services take already-typed input. Parsing a second time inside a
   service is not harmless: the money transform turns `"30.00"` into `3000`
   minor units, and running it again reads that `3000` as a fresh amount and
   stores `300000`. Purchasing shipped with this bug for exactly one test run.
11. **Stored totals invite tampering.** Restaurant order totals are derived from
   the lines by trigger for the same reason treasury balances are derived from
   the ledger — if a number can be written directly, eventually something
   writes the wrong one.
