# LOCAL BASIC — PROJECT STATUS

Updated at the end of every implementation batch. Read this first when
resuming work.

## Current phase

**Phase 1 — Foundation: COMPLETE.**
Next: Phase 2 — Retail module (products → inventory → POS).

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
- `npx next build` — succeeds, 8 routes
- `supabase/tests/run.sh` — schema guards + tenant isolation, all assertions
  pass

## Known gaps (tracked in TODO.md)

- Retail module: not started
- Members/roles/branches/branding settings screens: routes not built yet
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
