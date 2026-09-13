# LOCAL BASIC — TECHNICAL BLUEPRINT

**Powered by Green Light.**

Status: proposal — awaiting approval before implementation.

---

## 1. Architecture

```
Green Light (company)
└── LocalBasic (SaaS platform — one deployment, one Supabase project)
    └── Core  (tenancy, auth, RBAC, billing, money, audit, branding, public links, QR)
        └── Organization  (the tenant; has exactly one vertical)
            └── Branch    (physical location; all operational data is branch-scoped)
                └── Vertical Module  (medical | workshop | restaurant | retail)
```

Two hard rules that everything else follows from:

1. **The Core owns every concept shared by more than one vertical.** Customers, invoices,
   payments, treasury, notifications, reports, settings, branding live in Core and are used —
   never re-implemented — by modules. A vertical may extend a Core entity with a satellite
   table (e.g. `medical_patient_profiles` keyed by `customers.id`), never fork it.
2. **A module may depend on Core; Core may never depend on a module.** Adding a vertical is
   additive: new tables with a `_` prefix, new routes under a segment, new permission keys,
   a registry entry. No Core file is edited to add a vertical except the registry.

Layering, enforced by the directory structure and lint boundaries:

```
UI (server components / client islands)
  → Server Action or Route Handler   ← the only entry points; do auth + Zod parse, nothing else
    → Service (src/modules/*/services) ← business rules, authorization checks, transactions
      → Repository / Supabase client  ← SQL, RLS-enforced
        → PostgreSQL
```

Services never read cookies or `request`; they take a resolved `TenantContext`. That keeps them
testable and makes it impossible to "forget" the tenant.

---

## 2. Stack

| Concern | Choice | Note |
|---|---|---|
| Framework | Next.js (App Router) | Server Components default, Server Actions for mutations |
| Language | TypeScript `strict` + `noUncheckedIndexedAccess` | no `any` in `src/modules/**` |
| UI | Tailwind CSS + shadcn/ui (Radix) | tokens driven by CSS variables (§12) |
| DB | Supabase / PostgreSQL | one project, RLS on every table |
| Auth | Supabase Auth (email+password, magic link, OTP later) | SSR cookie session via `@supabase/ssr` |
| Validation | Zod | one schema per action, shared client/server |
| Data fetch | Server Components + `revalidateTag` | TanStack Query only for POS/Kitchen live screens |
| Realtime | Supabase Realtime | kitchen tickets, POS drawer, order status |
| Tests | Vitest (unit/service) + Playwright (E2E) + pgTAP-style SQL tests for RLS | |
| Money | integer minor units (`bigint` cents) + `currency` code | never floats |
| Errors | typed `Result`-style service returns; `AppError` with safe public message | |

No ORM. A thin typed repository layer over `supabase-js` with generated DB types keeps RLS in
force (an ORM with a pooled superuser connection would silently bypass it).

---

## 3. Folder structure

```
src/
  app/
    (marketing)/                  # public site, pricing
    (auth)/                       # sign-in, sign-up, reset, callback
    (onboarding)/                 # vertical pick → provisioning wizard
    (app)/[orgSlug]/[branchSlug]/ # authenticated workspace shell
      dashboard/  customers/  invoices/  payments/  treasury/
      reports/  settings/         # Core screens — shared by all verticals
      m/                          # vertical screens, mounted by registry
    (public)/p/[token]/           # public links: store, portal, booking, menu
    api/                          # webhooks, QR resolve, health; route handlers only
  components/ui/                  # shadcn primitives (no business logic)
  components/patterns/            # DataTable, PageHeader, EmptyState, Money, Confirm
  features/                       # cross-module UI compositions (e.g. invoice editor)
  modules/
    core/
      auth/  tenancy/  rbac/  customers/  invoices/  payments/  treasury/
      notifications/  audit/  subscriptions/  branding/  settings/
      public-links/  qr/  reports/
      └─ each: schemas.ts  service.ts  repository.ts  types.ts  permissions.ts
    medical/  workshop/  restaurant/  retail/
      └─ same shape + ui/ and registry.ts
  services/                       # infra adapters: mail, sms/whatsapp, storage, payments, shipping
  lib/                            # supabase clients, action wrapper, errors, money, rate-limit
  hooks/  types/  utils/  config/  styles/
supabase/
  migrations/                     # numbered, forward-only SQL
  tests/                          # RLS + isolation SQL tests
  seed/
docs/
```

Hard limits: no file over ~300 lines; a module's `service.ts` splitting means splitting the
module, not adding a 900-line file.

---

## 4. Database structure

All tables: `id uuid primary key default gen_random_uuid()`, `created_at`, `updated_at`
(trigger-maintained), `created_by uuid references profiles(id)`. Tenant tables also carry
`organization_id`; operational tables carry `branch_id`. Deletion of financial, medical, and
audit rows is **soft** (`deleted_at`, `voided_at` + `void_reason`) — invoices are voided or
credited, never deleted.

**Core**

```
profiles(id→auth.users, full_name, phone, avatar_url, locale)
organizations(id, slug UNIQUE, name, vertical, status, plan_id, country, currency, timezone)
branches(id, organization_id, slug, name, address, phone, is_active)   UNIQUE(organization_id, slug)
organization_members(id, organization_id, user_id, status, all_branches bool, invited_by)
                                                     UNIQUE(organization_id, user_id)
member_branches(member_id, branch_id)                 -- scope when all_branches = false
roles(id, organization_id NULLABLE, key, name, is_system)  -- NULL org = platform template
permissions(key PK, group, description)               -- global catalog, seeded
role_permissions(role_id, permission_key)
user_roles(member_id, role_id, branch_id NULLABLE)    -- NULL branch = org-wide grant
plans(id, key, name, price_cents, interval, limits jsonb, features jsonb)
subscriptions(id, organization_id, plan_id, status, current_period_end, provider_ref)
customers(id, organization_id, branch_id NULLABLE, name, phone, email, tax_id, notes)
                                                     UNIQUE(organization_id, phone)
invoices(id, organization_id, branch_id, number, customer_id, status, subtotal_cents,
         discount_cents, tax_cents, total_cents, paid_cents, currency, source, voided_at)
                                                     UNIQUE(organization_id, branch_id, number)
invoice_items(id, invoice_id, description, ref_type, ref_id, qty numeric, unit_price_cents,
              discount_cents, tax_rate, total_cents)
payments(id, organization_id, branch_id, invoice_id, method, amount_cents, status,
         treasury_account_id, provider_ref, refunded_from_id)
treasury_accounts(id, organization_id, branch_id, name, type, currency, is_active)
treasury_transactions(id, organization_id, branch_id, account_id, direction, amount_cents,
                      category, reason, ref_type, ref_id, occurred_at, created_by)
notifications(id, organization_id, user_id NULLABLE, channel, template, payload jsonb,
              status, scheduled_for, sent_at)
audit_logs(id, organization_id, branch_id, actor_id, action, entity_type, entity_id,
           before jsonb, after jsonb, ip, user_agent, created_at)
branding_settings(organization_id PK, logo_url, primary_color, secondary_color, phone,
                  whatsapp, email, white_label bool)
settings(id, organization_id, branch_id NULLABLE, key, value jsonb)  UNIQUE(org, branch, key)
public_links(id, organization_id, branch_id, kind, token UNIQUE, target jsonb, is_active,
             expires_at, revoked_at)
qr_codes(id, organization_id, branch_id, public_link_id, label, entity_type, entity_id,
         is_active, printed_at)
```

Balances are **derived** (`sum(treasury_transactions)`), never stored as a mutable column; a
materialized/rollup table may cache them but corrections happen only as new transactions.

**Vertical tables** (prefixed, listed as concepts; detailed in the phase that builds them)

- medical: `medical_specialties, medical_doctors, medical_schedules, medical_slots,
  medical_appointments, medical_patient_profiles, medical_visits, medical_diagnoses,
  medical_prescriptions, medical_treatment_plans`
- workshop: `workshop_vehicles, workshop_work_orders, workshop_wo_items, workshop_inspections,
  workshop_approvals, workshop_services, workshop_parts, workshop_reminders`
- restaurant: `restaurant_tables, restaurant_menus, restaurant_categories, restaurant_products,
  restaurant_modifier_groups, restaurant_modifiers, restaurant_orders, restaurant_order_items,
  restaurant_kitchen_tickets`
- retail: `retail_products, retail_variants, retail_categories, retail_stock_levels,
  retail_stock_movements, retail_purchases, retail_orders, retail_order_items, retail_returns,
  retail_discounts, retail_shipments, retail_store_settings`

Indexes as a rule, not an afterthought: every FK, every `(organization_id, branch_id, created_at
desc)` listing path, `retail_variants(organization_id, sku)` and `(barcode)` unique per org,
partial indexes on `status` for hot queues (kitchen, work orders).

**Retail inventory invariant.** `retail_stock_levels` is a projection; the ledger is
`retail_stock_movements(variant_id, branch_id, qty_delta, reason, ref_type, ref_id, user_id,
occurred_at)`. POS and the online store both write movements through one `InventoryService`,
so a POS sale and a web sale decrement the same number. Overselling is prevented by a
`SELECT ... FOR UPDATE` on the stock row inside the sale transaction, plus a
`CHECK (quantity >= 0)` as the last line of defence.

---

## 5. Multi-tenancy

One platform, one Supabase project, many organizations. `organization_id` is on every tenant
row — no exceptions, no "reachable via join" shortcuts, because RLS policies must be cheap and
self-contained.

Request lifecycle:

1. Middleware refreshes the Supabase session cookie and resolves `orgSlug`/`branchSlug` from
   the URL.
2. `resolveTenantContext()` (server-only) loads membership, effective branch scope, and the
   permission set, and returns `{ userId, organizationId, branchId, branchIds, permissions,
   roleKeys }`. It throws `NotFound` — not `Forbidden` — when the user isn't a member, so slugs
   can't be probed.
3. Every service takes that context as its first argument. **Client-sent `organization_id`,
   `branch_id`, `role`, `price`, `permission`, and any money value are discarded**; prices come
   from the DB, totals are recomputed server-side.
4. RLS re-checks the same thing in Postgres. Application checks are for good errors; RLS is the
   actual boundary.

Branch access: a member is either `all_branches = true` or scoped via `member_branches`.
Org-wide roles (`user_roles.branch_id IS NULL`) apply everywhere the member can reach; a
branch-scoped grant applies only there — so a Cashier at Branch A is not a Cashier at Branch B.

---

## 6. RLS

Enabled and `FORCE`d on every table in `public`. No table ships without policies; a migration
test fails CI if one exists with `rowsecurity = false`.

Helper functions, `SECURITY DEFINER`, `STABLE`, `search_path = ''`, defined once:

```sql
auth_member_of(org uuid) returns boolean            -- active membership
auth_can_branch(branch uuid) returns boolean        -- all_branches OR listed in member_branches
auth_has(org uuid, perm text) returns boolean       -- permission via user_roles→role_permissions
auth_has_in_branch(branch uuid, perm text) boolean  -- org-wide grant OR grant on that branch
```

Policy shape, per table, per verb:

```sql
create policy invoices_select on invoices for select
  using (auth_member_of(organization_id)
         and auth_can_branch(branch_id)
         and auth_has_in_branch(branch_id, 'invoice.read'));

create policy invoices_insert on invoices for insert
  with check (auth_member_of(organization_id)
              and auth_can_branch(branch_id)
              and auth_has_in_branch(branch_id, 'invoice.create'));
```

`update` policies carry both `using` and `with check` so a row can't be moved to another org or
branch. `delete` is denied outright on financial, medical, and audit tables — `audit_logs` has
insert+select only, and even insert is via a `SECURITY DEFINER` writer so an actor can't forge
another actor's entry.

Public surfaces (store, menu, booking) never use the user's session. They resolve a token
server-side, then read through narrow `SECURITY DEFINER` functions that return exactly the
public projection (e.g. `public_menu(token)` → active products, no costs, no stock, no
customer data). The anon key never selects a base table directly.

The service-role key exists in exactly two places: provisioning and the notification worker,
both server-only, both behind explicit wrappers that log to `audit_logs`. It is never imported
in anything under `components/`, never in a client component, and CI greps for it.

---

## 7. RBAC

Permissions are strings in a seeded catalog, `resource.action` — `invoice.create`,
`treasury.withdraw`, `medical.record.read`, `retail.pos.discount`, `settings.manage`,
`member.invite`. Roles are rows, not enum branches in code; system role templates
(Owner, Admin, Manager, Receptionist, Cashier, Doctor, Technician, Kitchen, Waiter, Staff)
are cloned into the org at provisioning so the owner can edit them freely.

- **Owner** is the only role that can transfer ownership, manage billing, or delete the org, and
  an org must always have ≥1 Owner (DB constraint + service check).
- Privilege escalation is blocked by rule: you may only grant permissions you hold, and only
  Owner/Admin may grant role-management permissions at all.
- **Kitchen has no financial permission by default** — no `invoice.*`, no `payment.*`,
  no `treasury.*`. Enabling it is an explicit, audited change.
- Medical records sit behind their own `medical.record.*` permissions, not general
  `customer.read`, so a Cashier can bill a visit without reading a diagnosis.

In code, authorization appears in exactly two shapes:

```ts
// server: inside the action wrapper / service
requirePermission(ctx, 'invoice.void', { branchId });

// UI: declarative, never a source of truth
<Can I="invoice.void"><VoidButton/></Can>
```

No `if (user.role === 'admin')` anywhere. The UI hiding a button is cosmetics; the service and
RLS are the enforcement.

---

## 8. Authentication

Supabase Auth with `@supabase/ssr`; session in `httpOnly`, `secure`, `sameSite=lax` cookies,
refreshed in middleware. Three clients, distinct files, distinct rules:
`lib/supabase/client.ts` (browser, anon), `lib/supabase/server.ts` (RSC/actions, anon + user
session — the default), `lib/supabase/admin.ts` (service role, `import 'server-only'`, used by
provisioning and workers only).

- `profiles` row created by a trigger on `auth.users` insert.
- Invitations: email token → accept → `organization_members` row with the invited roles;
  invites expire and are single-use.
- Rate limits on sign-in, sign-up, password reset, invite accept, public booking/order
  submission, and QR resolution — per IP and per identifier, sliding window (Upstash-compatible
  adapter, in-memory in dev). Generic failure messages; no user enumeration.
- Security headers via middleware: strict CSP (nonce-based, no `unsafe-inline`), HSTS,
  `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy`. Server Actions are origin-checked by Next; mutating route handlers
  check `Origin` explicitly.
- Uploads: size + MIME sniffing (magic bytes, not the client's `Content-Type`), extension
  allowlist, randomized keys, per-org storage prefix with storage RLS, images re-encoded to
  strip metadata. No SVG for user uploads.

---

## 9. Workspace provisioning

`POST → provisionWorkspace(input)` runs as **one Postgres function** (`provision_workspace`,
`SECURITY DEFINER`, single transaction) so a half-created workspace is impossible:

```
validate input (Zod)  →  reserve org slug (unique index, not a SELECT-then-INSERT race)
→ organizations        (vertical chosen here, immutable afterwards)
→ branches             (first branch)
→ organization_members (caller, all_branches = true)
→ roles                (clone system templates for this vertical)
→ role_permissions     (from the vertical's default matrix)
→ user_roles           (caller → Owner)
→ subscriptions        (trial plan)
→ branding_settings    (defaults + "Powered by LocalBasic — A Green Light Company")
→ settings             (currency, timezone, tax, invoice numbering)
→ module bootstrap     (vertical hook: e.g. restaurant seeds a menu + 1 table + its QR)
→ audit_logs           ('organization.provisioned')
```

Everything after the transaction (welcome email, logo processing) is a queued notification —
a failed email never leaves a broken org. The operation is idempotent per
`(user_id, idempotency_key)`, so a double-submit returns the existing workspace.

---

## 10. Module architecture

A vertical is a folder plus a registry entry:

```ts
export const restaurantModule: ModuleDefinition = {
  key: 'restaurant',
  name: 'Restaurant',
  navigation: [...],             // sidebar entries, each gated by a permission
  permissions: [...],            // contributed to the catalog
  roleTemplates: [...],          // Kitchen, Waiter, Cashier presets
  publicLinkKinds: ['menu', 'order-status'],
  onProvision: seedRestaurant,   // runs inside the provisioning transaction
  dashboardWidgets: [...],
};
```

`config/modules.ts` maps `organizations.vertical` → definition. The app shell renders navigation,
the `/m` segment, and dashboard widgets from that definition. Adding a fifth vertical =
new folder + migration + registry line; zero Core edits.

Integration points a module is allowed to use, and nothing else: `CustomerService`,
`InvoiceService`, `PaymentService`, `TreasuryService`, `NotificationService`, `AuditService`,
`PublicLinkService`, `QrService`. So a restaurant order, a work order, a clinic visit, and a POS
sale all end at the same invoice → payment → treasury pipeline, and reports work across
verticals for free.

---

## 11. QR and public links

One system, two layers.

**Public links.** `public_links` holds an opaque token (32 bytes, base64url, CSPRNG — not a
UUID, not a slug you can guess) plus a `kind` (`store`, `portal`, `booking`, `menu`, `order`,
`kitchen`) and a `target` jsonb naming the entity. `/(public)/p/[token]` resolves the token
server-side to `{ organization_id, branch_id, kind, target }` and renders the matching public
app. Internal UUIDs never appear in the URL. Tokens can be deactivated, expired, and rotated;
revoking is instant because resolution is a DB read, not a signature check.

**QR codes.** A QR encodes only `https://app.localbasic.com/p/<token>`. Nothing else — no org
id, no table id, no price, no secret. `qr_codes` binds a token to an entity
(`entity_type='restaurant_table'`, `entity_id=…`), so:

- Scanning identifies org → branch → table automatically, and the session is anonymous.
- The menu is resolved live at scan time, so **changing the menu never invalidates a printed QR**.
- Admin can create, label, assign, reassign (point the same printed sticker at another table),
  deactivate, and download print-ready PNG/SVG/PDF sheets.
- An inactive or revoked token renders a neutral "unavailable" page and is rate-limited, so
  tokens can't be enumerated.

Public order submission is rate-limited per token and per IP, validated with Zod, and prices are
always re-read server-side — a scanned cart never dictates a total.

---

## 12. UI/UX system

Derived from the logo: two blues on white, geometric rounded sans, generous whitespace, no
gradients, no decorative animation.

```css
--lb-primary:   #1E2FC8;  /* deep blue — "local" */
--lb-accent:    #6B8BFA;  /* mid blue  — "basic" */
--lb-accent-soft:#A9C7F5;  /* light blue — the dot */
--lb-fg: #0E1330; --lb-muted: #5B6480; --lb-bg: #FFFFFF; --lb-surface: #F6F8FC;
--lb-border: #E3E8F2; --lb-success:#127A56; --lb-warn:#B4690E; --lb-danger:#C22F3D;
--lb-radius: 12px;  --lb-radius-sm: 8px;
```

Every color is a CSS variable so **branding overrides `--lb-primary` / `--lb-accent` per
organization** at the layout level — one `<style>` block from `branding_settings`, no rebuild,
no per-tenant CSS files. Contrast is validated when an org picks a color (AA minimum);
if their brand color fails against white, the token falls back for text while keeping the fill.

Typography: one geometric sans (Poppins/Outfit-class) with a system fallback stack; weights
600/700 for headings, 400/500 for body; 4px spacing scale; two shadow levels only.

Components built once in `components/ui` + `components/patterns`: Button (4 variants), Input,
Select, Combobox, DataTable (sort/filter/paginate/empty/loading/error built in), Card, Modal,
Sheet, Tabs, Badge, Alert, Toast, EmptyState, Skeleton, Money, DateRangePicker, Confirm.
Every list screen ships all four states — loading, empty, error, populated — or it isn't done.

Surfaces, each tuned to its user:

- **Admin** — desktop-first, sidebar + breadcrumb, dense tables, keyboard-friendly.
- **Customer (store, booking, portal, menu)** — mobile-first, big tap targets, minimal chrome.
- **POS** — single screen, no modals in the hot path, barcode input always focused, numeric
  keypad, sale completable with keyboard alone. Target: scan → pay → print under 5 seconds.
- **Kitchen** — tablet, landscape, high contrast, ticket columns, large touch targets, realtime,
  readable at arm's length; no financial data on screen.

Accessibility: focus rings never removed, labels on every input, `aria-live` for toasts, color
never the only signal, full keyboard paths for POS and Kitchen.

Default footer everywhere: **Powered by LocalBasic — A Green Light Company**, removable only on
white-label plans (enforced server-side from `subscriptions`, not a client flag).

---

## 13. Security model

Defence in depth, in this order:

| Layer | Enforces |
|---|---|
| Middleware | session refresh, security headers, CSP nonce, origin check |
| Action wrapper | authenticated? Zod parse? tenant context resolved? rate limit? audit |
| Service | permission check, business invariants, server-side pricing and totals |
| Postgres RLS | tenant + branch + permission, again, authoritatively |
| Constraints | `CHECK`, unique, FK, non-negative stock, non-negative paid amounts |

Every Server Action goes through one wrapper — `defineAction({ schema, permission, handler })` —
so it is impossible to write an action that forgets auth, validation, or the audit trail.

OWASP mapping:

- **IDOR / broken access control** — RLS on every row; ids resolved within tenant scope; public
  surfaces use opaque tokens; unauthorized reads return 404, not 403.
- **Privilege escalation** — grant-only-what-you-hold, Owner invariant, role edits audited.
- **Injection** — parameterized queries only; no string-built SQL; Zod at every boundary.
- **XSS** — React escaping, no `dangerouslySetInnerHTML` (lint-banned), strict CSP, sanitized
  rich text, no SVG uploads.
- **Sensitive data exposure** — medical records behind dedicated permissions and their own
  audit trail; no PII in URLs, logs, or QR payloads; errors are typed with a safe public message
  and a correlation id, with details server-side only.
- **Brute force / abuse** — rate limits on auth, invites, public booking/order, QR resolve.
- **Financial integrity** — money as integers, totals recomputed server-side, treasury as an
  append-only ledger, invoices voided rather than deleted, refunds as linked negative payments.

Audit logs capture actor, org, branch, action, entity, before/after, IP, and timestamp for every
mutation of members, roles, invoices, payments, treasury, medical records, settings, and links.

**Never:** service-role key in client code, hardcoded tenant ids, RLS bypass "just for this
query", secrets in the repo, trusting a client-sent price, permission, role, org, or branch.

---

## 14. Development phases

| Phase | Deliverable | Done when |
|---|---|---|
| **1 — Foundation** | Next.js + TS strict + Tailwind + design tokens; Supabase clients; migrations for all Core tables; RLS helpers and policies; `.env.example`; CI (typecheck, lint, RLS tests) | every Core table has RLS + policies, and the isolation test suite runs in CI |
| **2 — Auth + Tenancy + RBAC** | sign-up/in/reset, profiles, provisioning transaction, org/branch switching, members + invites, roles/permissions UI, audit logging, action wrapper | a new user can register a business and land in a working, isolated workspace |
| **3 — Core modules** | customers, invoices, invoice items, payments, treasury, notifications, settings, branding, reports, public links, QR | a Core invoice can be created, paid, and reflected in treasury and reports |
| **4 — Pilot vertical: Retail** | products/variants/SKU/barcode, inventory ledger, POS, online store, orders, shipping abstraction, analytics | a POS sale and an online sale decrement the same stock, both produce invoices and treasury entries |
| **5 — Testing + security review** | RLS/isolation suite, financial-flow tests, POS/booking E2E, permission matrix tests, dependency + header audit, threat-model pass | **Org A cannot read, write, or infer any Org B row through any route, action, public link, or QR** |
| **6 — Remaining verticals** | Restaurant (QR → table → order → kitchen), Medical (booking, visits, records), Workshop (work orders) | each ships without modifying Core beyond its registry entry |

Retail is the pilot because it exercises the most Core surface — inventory, POS, an online
store, shipping, and analytics — so anything weak in the Core fails there first, while the
system is still cheap to change.

---

**LOCAL BASIC — Powered by Green Light.**
