# LOCAL BASIC — PROJECT STATUS

Updated at the end of every implementation batch. Read this first when
resuming work.

## Current phase

**Restaurant & Cafe is the active vertical.** Medical, Workshop and further
Retail work are paused by decision.

- **Phase 1 — Foundation: COMPLETE.**
- **Retail (earlier pilot): catalog, inventory, POS, returns — COMPLETE**, left
  in place and untouched. No further retail work until Restaurant ships.
- **Restaurant MVP: database, ordering, payments, QR, and all operational
  screens COMPLETE.** Remaining: staff/roles/branding settings screens,
  notification delivery, and an end-to-end browser test.

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

- Settings screens: staff/members, roles, branches, branding, audit viewer
- Notification delivery worker (queue and templates exist, no sender)
- Printable receipt page for a completed order (the data is all there)
- Browser end-to-end test of the guest → kitchen → payment journey
- Retail purchasing / online store: paused by decision, not abandoned
- Customers / invoices / payments / treasury screens: services exist only for
  the dashboard summary so far
- Notification delivery worker: table and queue exist, no sender
- Invitation accept flow: table and policies exist, no UI or accept function

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
7. **Stored totals invite tampering.** Restaurant order totals are derived from
   the lines by trigger for the same reason treasury balances are derived from
   the ledger — if a number can be written directly, eventually something
   writes the wrong one.
