# Site Engine — Architecture Review & Customer Experience Modules

**Phase S — architecture discovery and planning.**
Branch: `claude/site-engine-architecture-review`. Base: `d7b760f` (`claude/site-template-renderer`).
Reference experience: **Lavechi Café**.

This document is a review. It proposes no schema change, changes no production
data, and merges no existing system into another.

---

## 1. Executive Summary

LocalBasic already contains **three separate website systems**, built in three
different phases for three different reasons. They are not duplicates by
accident — each answers a question the others do not — but nothing in the
repository states which one owns what, and the newest one (the Site Engine)
currently overlaps the oldest one (the restaurant website) in intent while
overlapping it in capability almost not at all.

| System | Migration | Shape | Public today? | Editor? |
|---|---|---|---|---|
| **A. Restaurant website** | 0039, 0042, 0043 | `restaurant_website_sections` + revisions + custom domains, one website per organization | **Yes** — `/r/<org>`, `/r/<org>/<branch>`, and custom hostnames | Yes (`/settings/website/builder`) |
| **B. Platform websites** | 0051 | `platform_websites` + versions, one JSONB definition per site, AI-assisted | No — slug reserved, never served | Yes, platform-admin only (`/admin/websites`) |
| **C. Site Engine** | 0055 | `sites` / `site_pages` / `site_sections` / `site_settings`, normalized rows | **No** | **No** — create + read + preview only |

The single most important finding is this: **the restaurant website is not a
website builder that happens to know about menus. It is a read surface over
data the restaurant already owns** — menu, branches, opening hours, branding,
ordering availability — and it copies none of it. Every value it shows is
resolved live through `SECURITY DEFINER` functions at render time. That is the
correct pattern and it is the pattern the Site Engine must adopt rather than
replace.

The Site Engine's own gap is narrower than it looks. It has schema, RLS, a
template, a renderer and a preview. It has **no update path, no delete path, no
publish path and no public route**. It is a foundation, not a half-built
product — and that is why it is cheap to point in the right direction now.

For Lavechi Café specifically: the customer-facing restaurant experience
(menu, cart, checkout, delivery/pickup, order tracking, customer accounts,
saved addresses, favourites, QR table ordering) **already exists and is live**.
What Lavechi is missing is not an ordering engine. It is a *brand surface* — a
site the café controls that sits in front of the ordering engine it already
has — plus a small number of genuinely absent capabilities (reservations,
loyalty, gallery/story content, reviews).

**Recommended posture:** keep the three systems separate, give each an explicit
written owner, and make the Site Engine the **presentation layer** — never a
second source of truth for menus, orders, hours or branches.

---

## 2. Repository Findings

Verified by reading the files, not inferred.

### 2.1 Site Engine (new)

| Path | What it is |
|---|---|
| `supabase/migrations/0055_site_engine.sql` | `sites`, `site_pages`, `site_sections`, `site_settings`; 4 `app.site_*` helpers; 16 policies; `public.site_provision()` (SECURITY INVOKER) |
| `src/modules/sites/schemas.ts` | `SECTION_TYPES`, `createSiteSchema`, slug suggestion |
| `src/modules/sites/types.ts` | `Site`, `SitePage`, `SiteSection`, `SiteSettings`, `SiteDetail` |
| `src/modules/sites/service.ts` | `listSites`, `getSiteDetail`, `createSite`, `requireSiteDetail`, private `seedTemplate` |
| `src/modules/sites/sections/content.ts` | Per-type Zod schemas; `parseSectionContent` is total; link allow-list (`/path`, `mailto:`, `tel:`) |
| `src/modules/sites/templates/{types,business,index}.ts` | `themeSchema`, `siteSettingsSchema`, `businessTemplate` (6 sections), closed `TEMPLATES` registry |
| `src/modules/sites/renderer.tsx` | Switch dispatch with `never` exhaustiveness guard; `--site-*` CSS variables |
| `src/app/(app)/[orgSlug]/[branchSlug]/settings/sites/**` | List, create form, detail, preview, `loading`, `error`, `actions.ts` |
| `supabase/tests/28_site_engine.sql` | 10 checks, 2 orgs, 4 users |

Section types stored: `hero`, `about`, `services`, `testimonials`, `contact`, `footer`.

### 2.2 Restaurant website (existing, live)

| Path | What it is |
|---|---|
| `supabase/migrations/0039_restaurant_website.sql` | `app.restaurant_website_org()`, `public.restaurant_website()`, `public.restaurant_website_branches()`; settings-key validation extended in `app.check_restaurant_setting()` |
| `supabase/migrations/0042_website_builder.sql` | `restaurant_website_sections` (types `hero,about,menu,gallery,contact,hours,branches,cta`), `restaurant_website_revisions` (append-only, one live per org), per-type config **key allow-list** enforced by trigger |
| `supabase/migrations/0043_website_domains.sql` (+ `0044`) | `restaurant_website_domains`, DNS-TXT verification, token stored only as SHA-256 |
| `src/modules/restaurant/website/{service,builder,builder-shared,domains,domain-verifier,settings,shared}.ts` | Read service, builder service, domain service |
| `src/app/(public)/r/[orgSlug]/{page,page-shell,parts}.tsx` | The public site; `page-shell` is the single renderer |
| `src/app/(public)/site/[host]/[[...segments]]/page.tsx` | Custom-domain entry; **delegates to the same `page-shell`** — no second renderer |
| `src/middleware.ts` | Host rewrite + session refresh + CSP. `HOST_NEUTRAL_PREFIXES` keeps `/order`, `/p/`, `/r/`, `/api`, `/account/join` meaning the same on every hostname |

Website content lives in `public.settings` under `restaurant.website_*` keys
(tagline, about, hero URL, opening hours, enabled flag) — deliberately reusing
the audited settings store rather than adding a second one.

### 2.3 Platform websites (existing, not served)

`supabase/migrations/0051_platform_website_builder.sql` + `src/modules/platform/websites/**`
+ `/admin/websites/**`. Whole-site JSONB definition validated by
`app.check_site_definition()`; `app.check_platform_website()` **forces**
`created_by`/`updated_by` to `auth.uid()` and **forbids re-parenting** to
another organization. Published history is append-only. An AI provider
interface exists with a mock implementation.

### 2.4 Customer experience already shipped

- **Ordering:** `restaurant_orders` (channels `qr | cashier | waiter | online`;
  types `dine_in | takeaway | pickup | delivery`), `restaurant_order_items`,
  `restaurant_order_item_modifiers`, `restaurant_order_deliveries`.
- **Public ordering surfaces:** `/order/<org>/<branch>` (online),
  `/p/<token>` (QR table), `/order/track/<token>` (guest tracking).
- **Customer accounts (0040):** `customer_addresses`,
  `restaurant_customer_favorites`, and 16 `public.customer_*` RPCs — profile,
  orders, order detail/items, favourites, addresses, `customer_claim_order`.
  Routes under `/r/<org>/account/**` (orders, addresses, favourites, settings,
  sign-in, sign-up).
- **Menu:** `restaurant_categories`, `restaurant_products`,
  `restaurant_variants`, `restaurant_modifier_groups`, `restaurant_modifiers`.
- **QR:** `public_links` — 32-byte base64url token, revocable, `target` carries
  `{entity_type, entity_id}` so Core never learns the vertical.

### 2.5 Not present anywhere

Reservations/bookings. Loyalty or points. Customer reviews or ratings. Online
*payment* for restaurant orders (`payments.method` supports `online`, but the
restaurant online flow has no gateway — retail's store is
`cash_on_delivery | pay_on_collection`). Public hosting for `sites`.
`promo_codes` exists but is **platform subscription billing**, not a customer
discount system.

---

## 3. Current Architecture Map

```
                          ┌──────────────── PUBLIC ────────────────┐
  custom hostname ──► middleware (host rewrite, CSP, session)
                          │
                          ├─ /site/[host]/[[...segments]] ─┐
                          ├─ /r/[orgSlug]                  ├─► page-shell.tsx  (ONE renderer)
                          ├─ /r/[orgSlug]/[branchSlug]  ───┘        │
                          │                                         ├─ getWebsite()      → public.restaurant_website()
                          │                                         ├─ getBranches()     → public.restaurant_website_branches()
                          │                                         ├─ getMenu()         → live menu tables
                          │                                         └─ getPublishedLayout() → restaurant_website_revisions (live)
                          │
                          ├─ /order/[org]/[branch]  ─► online/service ─► restaurant_place_online_order()
                          ├─ /p/[token]             ─► public/service ─► public_links → table → order
                          ├─ /order/track/[token]   ─► getOrderByToken()
                          └─ /r/[org]/account/**    ─► account/service ─► customer_* RPCs (RLS by auth.uid())

                          ┌──────────── AUTHENTICATED (app) ───────────┐
  /[orgSlug]/[branchSlug]/settings/website/**  ─► builder.ts   ─► settings.manage   ─► restaurant_website_sections
  /[orgSlug]/[branchSlug]/settings/website/domains ─► domains.ts ─► settings.manage ─► restaurant_website_domains
  /[orgSlug]/[branchSlug]/settings/sites/**    ─► sites/service ─► site.read/manage ─► sites / site_pages / site_sections
                                                                                       (preview only — no public route)

                          ┌──────────── PLATFORM (admin) ──────────────┐
  /admin/websites/**  ─► platform/websites/service ─► platform_admins ─► platform_websites + versions
```

**Authorization layering, consistently applied:**
1. Route resolves tenant context from the **URL** (`resolveTenantContext`), never from a payload.
2. Service calls `requirePermission(ctx, …)` — produces a 403/404 rather than a bare policy error.
3. RLS + **FORCE RLS** is the boundary that a forgotten filter cannot bypass.
4. Public surfaces go through `SECURITY DEFINER` functions with `search_path = ''` that re-check "is this organization active, restaurant-enabled, and published".

---

## 4. Recommended Architecture

### Core (shared, vertical-agnostic)
- `sites` / `site_pages` / `site_sections` / `site_settings` — **presentation only**
- Template registry + renderer + section content schemas
- Theming (`--site-*`), RTL/locale, publishing state
- Hostname/slug resolution (to be shared, see §10 Phase 5)

### Business modules (own their data, expose read APIs)
- **Restaurant** — menu, orders, tables, kitchen, reservations (future), delivery
- **Retail** — products, inventory, store, shipping
- **Core** — branding, branches, customers, settings, notifications

### Existing systems (keep, do not merge)
- **Restaurant website (A)** — stays as-is. It is live, has custom domains, and
  is the only thing serving real restaurant traffic today.
- **Platform websites (B)** — stays as-is. It is the *agency* workflow: LocalBasic
  staff building a site on a customer's behalf, with AI assistance and
  publish history. Different actor, different authorization, different lifecycle.
- **Site Engine (C)** — becomes the **self-serve, multi-vertical** site product.

### The rule that keeps them from colliding

> A site **section** may declare *that* it shows the menu. It may never store
> *what* the menu is.

Concretely: a `menu` section stores `{ categoryIds?: string[], layout: 'grid' }`
and the renderer resolves the menu live, exactly as `page-shell.tsx` does today.
Copying menu rows into `site_sections.content` would create a second source of
truth for prices — the one thing this codebase has been careful never to do.

---

## 5. Capability Classification

### Shared Core
Site/page/section storage · templates · renderer · theming · publishing state ·
slug & hostname resolution · SEO metadata · preview · media references ·
RBAC (`site.read` / `site.manage`) · audit

### Business Modules
Menu & catalogue (Restaurant/Retail) · cart, checkout & order placement ·
order status & tracking · tables & QR · kitchen & service displays ·
delivery/pickup rules & fees · customer accounts, addresses, favourites ·
reservations *(missing)* · loyalty *(missing)* · reviews *(missing)*

### External Systems
DNS & custom domains (`restaurant_website_domains`, DNS-TXT verification) ·
payment gateways *(not integrated for restaurant)* · shipping providers
(`retail_shipping_providers`) · email/SMS/WhatsApp delivery
(`notifications`) · AI content provider (`platform/websites/ai/provider.ts`)

---

## 6. Data Ownership Map

| Data | Owner | Read by | Written by | Should it be copied into `sites`? |
|---|---|---|---|---|
| Menu categories / products / variants / modifiers | Restaurant module | Public site, ordering, POS, kitchen | `restaurant.menu.manage` | **No** — resolve live. A copy is a second price. |
| Branches, addresses, phones | Core | Site, ordering, reports | `branch.manage` | **No** |
| Opening hours | Core `settings` (`restaurant.opening_hours`) | Site, ordering availability | `settings.manage` | **No** |
| Branding (logo, colours, display name, white-label) | Core `branding_settings` | Site, receipts, emails | `branding.manage` | **No** — reference it; a site *theme* may override presentation only |
| Orders, items, modifiers, deliveries | Restaurant module | Customer account, tracking, kitchen, reports | Ordering RPCs | **No** |
| Customers, addresses, favourites | Core / Restaurant (0040) | Customer account, checkout | Customer RPCs under `auth.uid()` | **No** |
| Ordering availability & delivery fee | Core `settings` | Site, checkout | `settings.manage` | **No** — the site must not be able to disagree with checkout |
| Site structure (pages, section order, visibility) | **Site Engine** | Renderer, preview | `site.manage` | n/a — this *is* its data |
| Marketing copy (headline, story, tagline) | **Site Engine** | Renderer | `site.manage` | n/a |
| Theme (colours, fonts, direction, locale) | **Site Engine** `site_settings` | Renderer | `site.manage` | n/a |
| Gallery images / press / awards | **Site Engine** (missing section types) | Renderer | `site.manage` | n/a |
| Custom domains | Restaurant website (A) today | Middleware, site routing | `settings.manage` | Should move to Core when the Site Engine publishes — see §10 Phase 5 |
| QR link tokens | Core `public_links` | QR routes | `publiclink.manage` | **No** — and the token format must not change |
| Published snapshots | A: `restaurant_website_revisions`; B: `platform_website_versions` | Public renderer | Publish RPCs | The Site Engine needs its **own** equivalent (Phase 4) |

**Verdict: nothing should be copied.** Every "should it be copied?" answer is
no. The Site Engine stores structure, copy and theme; everything else it
*references*.

---

## 7. Editor and Renderer Review

### Renderer (`src/modules/sites/renderer.tsx`)

**Good.** It is a closed switch with a `never` exhaustiveness guard, so adding a
section type to the database check constraint without adding a case is a
*compile* error, not a blank box in production. Content is parsed on read by
`parseSectionContent`, which is **total** — it never throws and never returns
null, falling back to `schema.parse({})`. Theme values are re-validated
(`themeSchema`, four `#rrggbb` fields with `.catch()`) before reaching a `style`
attribute. Links pass an allow-list of `/path`, `mailto:` and `tel:`. Semantics
are real (one `<h1>`, `<blockquote>/<cite>`, `<dl>/<dt>/<dd>`), tap targets are
`min-h-11`, and `dir="ltr"` is applied to phone/email *values* only inside an
RTL document.

**Gaps.** It renders one page (the homepage) and has no multi-page navigation.
It has no `menu`, `gallery`, `hours` or `branches` section types — precisely the
four that the restaurant website already has and that Lavechi needs. It has no
notion of "published" versus "draft" content.

### Editor

**There is none.** `createSite` is the only write path in
`src/modules/sites/service.ts`. There is no `updateSite`, no section reorder, no
section content update, no delete, no publish. The RLS policies for update and
delete exist and are correct; nothing calls them.

This is the right time to decide the editor's shape, because nothing is
committed to yet. Recommendation: **form-based section editing, one section at
a time**, matching the existing restaurant builder at
`/settings/website/builder`. Not drag-and-drop (explicitly out of scope, and it
would force an optimistic-client model this codebase has no precedent for).

### Preview

`/settings/sites/[siteId]/preview` is behind the same tenant context and
`site.read` as the detail screen, and is visibly framed as a preview with a
server-rendered way back. It is not a leak path. It is also not a publish path
— a preview URL cannot be shared with a customer.

---

## 8. Lavechi Gap Analysis

Reference: a café that wants a branded site, a menu customers can browse, online
ordering for pickup and delivery, QR ordering at the table, and a way for
regulars to come back.

| Capability | Already exists | Partially exists | Missing | Recommended owner |
|---|---|---|---|---|
| Branded public page | ✅ `/r/<org>` (restaurant website) | | | Restaurant website → Site Engine (Phase 5) |
| Custom domain | ✅ `restaurant_website_domains` + DNS-TXT | | | Core (after Phase 5) |
| Menu browsing (public) | ✅ `getMenu()`, live | | | Restaurant module |
| Menu **section** in the Site Engine | | | ❌ no `menu` section type | Site Engine (section) + Restaurant (data) |
| Cart & checkout | ✅ `/order/<org>/<branch>`, `quoteCart`, `placeOnlineOrder` | | | Restaurant module |
| Pickup & delivery, delivery fee | ✅ per-branch settings, live availability | | | Restaurant module |
| QR table ordering | ✅ `/p/<token>`, `public_links` | | | Core (link) + Restaurant (order) |
| Guest order tracking | ✅ `/order/track/<token>` | | | Restaurant module |
| Customer accounts | ✅ sign-up/in, profile, settings | | | Core / Restaurant (0040) |
| Saved addresses | ✅ `customer_addresses` | | | Core |
| Favourites | ✅ `restaurant_customer_favorites` | | | Restaurant module |
| Claim a guest order into an account | ✅ `customer_claim_order` | | | Restaurant module |
| Opening hours (public) | ✅ `restaurant.opening_hours`, 7-day validated | | | Core settings |
| Branch list & picker | ✅ `restaurant_website_branches()` | | | Core |
| Gallery / story / about | | ⚠️ `gallery` exists in the **restaurant** builder only; Site Engine has `about` but no gallery | | Site Engine |
| SEO metadata & Open Graph | ✅ on `/r/<org>` | ⚠️ none for Site Engine sites | | Site Engine |
| Multi-page site | | ⚠️ `site_pages` modelled, renderer draws homepage only | | Site Engine |
| Publishing (draft → live snapshot) | ✅ for A and B | ⚠️ `sites.status` column only | | Site Engine |
| Public hosting for a Site Engine site | | | ❌ no route, slug is unique per **org** not globally | Site Engine (Phase 5) |
| Online payment | | ⚠️ `payments.method` supports `'online'`; no gateway wired for restaurant | ❌ | External + Restaurant |
| Table reservations | | | ❌ nothing | Restaurant module (new) |
| Loyalty / points | | | ❌ nothing | Restaurant or Core (new) |
| Customer reviews / ratings | | | ❌ nothing | Restaurant module (new) |
| Promotions & discount codes (customer-facing) | | ⚠️ `promo_codes` is **subscription billing**, not orders | ❌ | Restaurant module (new) |
| Push/WhatsApp order notifications | | ⚠️ `notifications` table + worker exist | | Core |

**Read this table as: Lavechi's ordering problem is solved. Lavechi's
*presentation* problem is not.**

---

## 9. Security Findings

Severity is about the risk if the current design is built on, not about
anything exploitable in production today (the Site Engine has no public route,
so its blast radius is currently limited to members who already hold
`site.manage`).

### Medium — `sites.created_by` is forgeable on a direct write

`site_provision()` sets `created_by := auth.uid()`, but `sites` has **no
trigger** forcing it, and `sites_insert` / `sites_update` grant
`insert, update` on the table to `authenticated`. A member with `site.manage`
can insert a site via PostgREST attributing it to any profile id, or update an
existing row's `created_by`.

Compare `platform_websites`, which does this correctly:
`app.check_platform_website()` sets `created_by`/`updated_by` from `auth.uid()`
on every write and forbids re-parenting.

`supabase/tests/28_site_engine.sql` check 5 asserts that `created_by` *records*
the creator; it does not attempt a forged write. The test is not wrong — it
tests a different thing than the comment's "cannot be forged" implies.

**Fix:** a `before insert or update` trigger on `sites` that sets `created_by`
from `auth.uid()` on insert, preserves `old.created_by` on update, and raises
on an `organization_id` change. Additive migration. *This is the recommended
next task — see §11.*

### Medium — organization re-parenting between two orgs the caller administers

`sites_update`'s `WITH CHECK` tests `has_permission(organization_id, 'site.manage')`
against the **new** row. Someone who is an owner/admin of two organizations can
move a site from one to the other. Cross-tenant movement to an org they do not
control is correctly blocked. `platform_websites` forbids the move outright.
Same trigger fixes it.

### Medium — section content is validated in TypeScript only

`site_sections.content` and `site_settings.settings` are `jsonb not null` with
**no database validation**. The link allow-list, the section field shapes and
the theme colour format live entirely in `src/modules/sites/`. A member with
`site.manage` writing directly through PostgREST can store content that
violates every one of them.

This is **not exploitable today** because `parseSectionContent` and
`themeSchema` are applied on read and both fall back rather than pass a value
through. But the invariant exists in one layer, and both older systems put it
in two: `restaurant_website_sections` has a per-type **key allow-list** trigger,
and `platform_websites` has `app.check_site_definition()`.

**Fix:** a validation trigger mirroring `app.check_restaurant_website_section()`.
Defer to the phase that adds the editor, so the schema and the trigger are
written against the same field list.

### Low — `seedTemplate` is not transactional

`createSite` provisions atomically via RPC, then seeds sections and settings
outside that transaction, best-effort, logging failures. Documented in the code
as deliberate, and a site with a homepage and no sections is repairable. Worth
revisiting when the editor exists and "repair" becomes a user action rather than
a hope.

### Low — `sites.slug` is unique per organization, not globally

Correct for today (§2.1 comment says so explicitly). It becomes a **blocker** the
moment sites are publicly addressable by slug, and Phase 5 must resolve it
before writing a route — not after. Options: a global unique index on published
sites only, or address published sites by hostname exclusively (as the
restaurant website already does).

### Informational — pre-existing, unchanged by this review

- CSP uses `script-src 'unsafe-inline'` with a documented rationale in
  `src/middleware.ts` (static prerendering vs. per-request nonce).
- `restaurant_website_domains` stores only the SHA-256 of the verification
  challenge — the value is shown once and never stored. Good.
- Rate limiting is in-memory and therefore per-instance on serverless
  (previously documented).

---

## 10. Phased Roadmap

Each phase is independently shippable and leaves the system consistent.

### Phase 0 — Hardening (no new features)
- Trigger on `sites`: force `created_by`, forbid re-parenting.
- Extend `supabase/tests/28_site_engine.sql` with the two negative writes.
- Document the three-system split and the ownership rule in `docs/`.
- **Additive migration only. No behaviour change for any existing surface.**

### Phase 1 — Editor
- `updateSite` (name, status), `updateSection` (content, visibility),
  `reorderSections`, `deleteSection`, `deleteSite`.
- Form-based section editing, one section at a time. No drag-and-drop.
- `app.check_site_section()` validation trigger, written against the final field list.
- Server actions via `defineTenantAction` with `permission: 'site.manage'`.

### Phase 2 — Multi-page
- Renderer draws any page, not only the homepage.
- Page create/rename/delete/reorder; navigation derived from `site_pages`.
- Preview gains a page switcher.

### Phase 3 — Data-bound sections
- New section types: `menu`, `hours`, `branches`, `gallery`.
- Each stores a **reference and a layout choice**, never the data.
- `menu` resolves live through the Restaurant module's existing read service.
- This is where the Site Engine gains parity with the restaurant website —
  without either one copying the other's rows.

### Phase 4 — Publishing
- `site_revisions` (append-only, one live per site) mirroring
  `restaurant_website_revisions`. Publish RPC, rollback by reference.
- `sites.status` starts meaning something enforceable.

### Phase 5 — Public hosting
- **Resolve the slug-uniqueness decision first (§9).**
- Public route + hostname resolution, sharing `middleware.ts`'s existing host
  rewrite rather than adding a second one.
- Move custom domains to a Core-owned table usable by both A and C.
- SEO metadata, Open Graph, `robots` — unpublished sites must not be indexable
  and must not confirm they exist, matching the restaurant website's behaviour.

### Out of scope for all phases above
Drag-and-drop editing · billing · autonomous execution · merging
`restaurant_website_sections` or `platform_websites` into `sites` · changing the
QR token format · changing canonical order status values · storing Arabic status
labels in the database.

---

## 11. Recommended Next Task

**One smallest safe change: an additive migration `0056` adding an integrity
trigger to `public.sites`, plus the two regression tests that prove it.**

Why this one:

- It closes the only finding where the database currently trusts the client
  (§9, both Medium items) — and it closes both with a single trigger.
- It is **additive**: a new migration, a new trigger, no change to any existing
  table, policy, route or service. `site_provision()` already sets
  `created_by := auth.uid()`, so the trigger agrees with every write the
  application makes today. Nothing changes behaviour for a legitimate caller.
- It copies a pattern that already exists and is already reviewed in this
  repository (`app.check_platform_website()`), rather than inventing one.
- It is verifiable: two negative writes added to
  `supabase/tests/28_site_engine.sql`, each proven to fail before the trigger
  and pass after.
- It is a prerequisite for the editor. Phase 1 adds update paths; adding them
  before the row's identity is pinned means writing the editor against a
  weaker invariant and re-testing it later.

Deliberately **not** recommended first: the editor (needs Phase 0's invariant),
the `menu` section (needs the editor), publishing (needs multi-page), public
hosting (needs the slug decision).

---

## 12. Validation and Git Report

**Branch:** `claude/site-engine-architecture-review`, created from `d7b760f`.
No work on `main`, no branch deleted.

**Changes in this commit:** this document only. No source file, migration, test,
route or configuration was modified. No production data was read or written. No
migration was created.

**Checks run:** none, and none claimed. This commit adds a Markdown file and
changes no code path, so there is nothing for the test suite, typecheck, build
or SQL suite to exercise that the previous commit did not already cover. The
last executed full verification was at `d7b760f`: 403 tests passed across 29
files, typecheck clean, SQL suite passed, production build succeeded, on Node
24.21.0. **That result belongs to `d7b760f` and is not re-asserted for this
commit.**

**What was inspected** (read-only, this session): `supabase/migrations/` —
0006, 0017, 0018, 0030, 0036, 0039, 0040, 0042, 0043, 0046, 0051, 0055;
`supabase/tests/28_site_engine.sql`; `src/modules/sites/**`;
`src/modules/restaurant/{website,online,public,account,menu}/**`;
`src/modules/platform/websites/**`; `src/modules/core/rbac/permissions.ts`;
`src/middleware.ts`; and the full route tree under `src/app/`.

**Nothing in §10 has been implemented.** Phase 0 awaits approval.
