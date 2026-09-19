# The Supabase project

LocalBasic has one dedicated Supabase project. It holds **no demo data** — the
Arabic demo restaurant is a local-development fixture only.

| | |
|---|---|
| Project | `localbasic` |
| Ref | `sztwmzwoxogxyabipwyo` |
| Region | `eu-central-1` |
| PostgreSQL | 17.6 |
| API URL | `https://sztwmzwoxogxyabipwyo.supabase.co` |

## Environment

`.env.local` is **not** committed. Copy `.env.example` and fill in:

```bash
LOCALBASIC_LOCAL_DB=0
NEXT_PUBLIC_SUPABASE_URL=https://sztwmzwoxogxyabipwyo.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key — Supabase dashboard → API>
```

The anon key is public by design; every table it can reach is protected by RLS
and it holds no privileges beyond `plans`. `SUPABASE_SERVICE_ROLE_KEY` is
optional, server-only, and must never be prefixed `NEXT_PUBLIC_` or committed —
only the admin client (background workers) reads it, and it throws if unset when
actually called.

Set `LOCALBASIC_LOCAL_DB=1` to switch back to the offline adapter against
`LOCAL_DATABASE_URL`; the SQL suite always runs against that local database.

## Migrations

`supabase/migrations/0001` … `0028` are applied to the project in order. They
are the single source of truth: the live schema and a freshly built local
database are byte-identical (same 479 public columns, same checksum), which is
what lets `scripts/gen-db-types.py` generate `src/types/database.ts` locally.

> **The deployed database is behind the repository.** As of 2026-09-18 the
> `localbasic` project still stops at `0028` — 43 tables, no `platform_admins`.
> Migrations `0029`–`0050` exist here and have never been applied, so everything
> they carry (the Platform Admin roster, billing, leads and onboarding, the
> platform audit log, online ordering, the website builder, custom domains,
> customer accounts, retail purchasing, the store, shipping, notifications and
> invitations) is absent in production. `/admin` cannot answer anything but 404
> there, because the table its gate reads does not exist. Applying them in
> filename order closes the gap; they are additive only and a full ordered run
> from empty was verified clean. Do this before the Platform Admin bootstrap
> below — the bootstrap has nothing to insert into until then.

Two portability points the migrations account for:

* `pgcrypto` lives in `extensions` on Supabase and in `public` on a plain
  PostgreSQL, so `app.new_public_token()` sets `search_path = extensions,
  public` — unquoted, since a quoted list is parsed as one schema name.
* PostgreSQL grants `EXECUTE` on every new function to `PUBLIC`, so granting to
  `authenticated` never removed `anon`. `0028` revokes it explicitly; only the
  five guest-facing token functions stay anon-callable.

## Verified state

43 tables, **0 without RLS, 0 without FORCE RLS**, 96 policies, 26 `app`
functions, 15 public functions, 41 triggers, 52 permissions, 10 role templates,
4 plans, 0 organizations. `anon` holds table privileges on exactly one table
(`plans`). Auth is live with the `on_auth_user_created` trigger installed.
Storage is provisioned with no buckets — the app stores no files yet.

Two advisor notices are expected and intentional:

* `public.document_counters` has RLS enabled with no policy **by design** — it
  is reachable only through the `SECURITY DEFINER` `next_document_number()`.
* `citext` is installed in `public`; relocating it would rewrite every `citext`
  column's type reference for no security gain.

## Platform Admin

**Every `/admin` route answers 404 until this is done.** The gate returns
not-found rather than forbidden on purpose, so a fresh deployment where nobody
is on the roster looks exactly like a deployment with no console at all. If
`/admin/customers` shows the LocalBasic 404 page, check this table first.

The first Platform Admin is created out-of-band, on purpose — a self-service
path on an empty roster would let the first person through the door claim the
platform. The account must already exist, so sign in once (or create the user in
Dashboard → Authentication → Users), then run this with a privileged connection
(SQL editor or service role). Never from the browser, and never with the
service-role key in a `NEXT_PUBLIC_*` variable.

```sql
do $$
declare
  v_email text := 'you@example.com';   -- <- the only line to edit
  v_user  uuid;
begin
  select u.id into v_user
    from auth.users u
   where lower(u.email::text) = lower(trim(v_email));

  if v_user is null then
    raise exception
      'No auth user exists for %. Create the account first, then re-run.', v_email
      using errcode = 'check_violation';
  end if;

  insert into public.profiles (id) values (v_user) on conflict (id) do nothing;

  insert into public.platform_admins (user_id, role, is_active, note)
  values (v_user, 'owner', true, 'initial platform owner (bootstrap)')
  on conflict (user_id) do update
     set role = 'owner', is_active = true;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
  values (v_user, 'platform.admin.bootstrapped', 'platform_admin', v_user::text,
          jsonb_build_object('email', lower(trim(v_email)), 'role', 'owner'));

  raise notice 'Platform owner ready: % (%)', v_email, v_user;
end;
$$;
```

Three things that block is doing deliberately. It **raises** when the address has
no account, because the obvious one-liner — `insert into platform_admins select
id from auth.users where email = '...'` — answers `INSERT 0 0` on a typo: it
reports success, changes nothing, and leaves you locked out of `/admin` with no
error to search for. It is **idempotent**, so re-running it is safe and also
repairs a roster row that was demoted or deactivated. And it writes its own
`audit_logs` line, because `write_platform_audit()` calls
`app.require_platform_admin()` first — it cannot record the grant that creates
the very first admin.

Verify it took:

```sql
select u.email, a.role, a.is_active
from public.platform_admins a join auth.users u on u.id = a.user_id;
```

`platform_admins` still has no INSERT, UPDATE or DELETE policy — RLS is enabled
and forced, so this only works over a connection that bypasses RLS. A tenant
user cannot promote themselves no matter what they send.

After that, admins manage each other at **`/admin/team`** — an owner may grant
and revoke, staff may read the roster. Migration 0048 added those functions;
before it, this sentence was aspirational and the roster could only be changed
with a database console.

### Auth URL configuration

Authentication → URL Configuration, for the production project:

* **Site URL** — `https://localbasic.vercel.app`, and nothing else. Paste the
  value only: a Site URL of `Site URL https://localbasic.vercel.app` is not a
  URL, so every verified link redirects to
  `<project>.supabase.co/auth/v1/Site%20URL%20https:/...` and answers 401 after
  a *successful* login. That failure looks exactly like a broken password.
* **Redirect URLs** — must include `https://localbasic.vercel.app/callback`.
  This is load-bearing, not decorative: `/forgot-password` sends an explicit
  `redirectTo`, and Supabase silently falls back to the Site URL when the value
  is not on the list. If a recovery link lands on the home page instead of
  `/reset-password`, check this list first.

Two flows reach the app and both are supported:

* **PKCE** — started by the app's own `/forgot-password`. Supabase returns
  `?code=`; `/callback` exchanges it server-side.
* **Implicit** — what a link generated from the Dashboard uses, because the
  recipient's browser holds no code verifier. Supabase returns the tokens in
  the URL *fragment* and redirects to the bare Site URL. Fragments never reach
  a server, so `RecoveryLinkHandler` on the marketing site posts them once to
  `/callback/token`, which calls `setSession()` and writes the same httpOnly
  cookies. Both flows then converge on `/reset-password`.

Set `NEXT_PUBLIC_APP_URL=https://localbasic.vercel.app` in the Vercel project.
The recovery action builds its link from that value — never from the request's
`Host` header, which an attacker controls — and refuses to send at all when it
resolves to localhost in production, rather than mailing a single-use token
pointing at a dead address.

### Owner account creation

`/admin/onboard` creates a workspace, applies the plan, opens the subscription
term and closes the lead in one database transaction. Inviting a *new* owner by
email additionally needs `SUPABASE_SERVICE_ROLE_KEY`, because minting an auth
identity is an Admin API call the database cannot make.

Set it in the server environment only. Never prefix it `NEXT_PUBLIC_`, and
never commit a value. Without it the screen still provisions for an owner who
already has an account, and states plainly that account creation is
unconfigured.

No password is ever handled by the application: the owner receives an
invitation and sets their own credentials through Supabase Auth.

## Platform Website Builder

Migration `0051_platform_website_builder.sql`. Platform Admin builds and
operates websites **for** customers, across every vertical, from a single
versioned document.

### Not the same thing as 0042

`0042_website_builder.sql` is a **tenant** feature: a restaurant edits its own
page under `settings.manage`, as section rows frozen into revisions. It is
untouched by 0051 and keeps working exactly as before.

0051 is **platform-operated** and **multi-vertical**. A Platform Admin is
deliberately not a member of any tenant, so tenant RBAC cannot gate it —
`app.is_platform_admin()` does. The two builders share no table and no policy.
They will converge in a later phase; until then, 0042 owns the restaurant's own
page and 0051 owns sites the platform builds.

### Tables

| Table | Purpose |
|---|---|
| `platform_websites` | One row per website. `draft_definition` and `published_definition` side by side, so editing a draft never touches what is live. |
| `platform_website_versions` | Append-only snapshot per publish. No update, delete or insert policy. The minimum that keeps rollback and compare possible later. |

`status` is `draft` / `published` / `archived`. A website is archived, never
deleted, so its published history stays attached to something.

### Site Definition

A website **is** a JSON document — `version: 1`, `metadata`, `theme`,
`navigation`, `pages[].sections[]`, `settings`. It describes a website; it does
not contain one. There is no stored markup, no CSS, no JavaScript, and no `html`
prop anywhere in the schema.

Validated in two places on purpose:

- **Zod** (`src/modules/platform/websites/definition.ts`) — full prop-level
  validation, and the message an operator actually reads.
- **PostgreSQL** (`app.check_site_definition`) — structure, the closed section
  list, and a recursive walk (`app.site_node_ok`) asserting every string is
  bounded and free of angle brackets, and every `*_url` / `*_image` / `logo` /
  `favicon` key is an https URL.

The database check is not redundancy. The application is not the only way in,
and "never trust model output" has to hold on a path a future refactor cannot
skip.

Refused outright, not sanitised: markup in any string, any non-https URL at any
depth, a navigation target that is not a path of the same site (an open redirect
on every generated page), a theme colour that is not a hex literal (it reaches a
`style` attribute), a font outside the fixed list, an unknown section type, and
an unrecognised `version`.

### Section registry

`src/modules/platform/websites/sections.ts` holds the closed list —
`hero`, `about`, `services`, `products`, `menu`, `gallery`, `testimonials`,
`features`, `contact`, `location`, `opening_hours`, `call_to_action`, `footer` —
with a Zod props schema and editor metadata for each. `app.site_section_types()`
holds the same list in SQL.

Adding a section means editing **both** lists and adding a case to the renderer.
That is the point: no section can reach a page without someone having drawn it.

`menu` and `opening_hours` render the customer's real data at serve time rather
than a copy inside the definition, so a published site cannot go stale against
the system.

### Brand identity precedence

```
website override  →  organization branding (branding_settings)  →  system default
```

Resolved by `resolveTheme()` at read time. The website stores only what it
overrides, so Core stays the single answer to "what colour is this customer".
A Core colour that is not a hex literal is ignored rather than passed through.

### Business data

`platform_website_business_profile(p_org)` — a narrow `SECURITY DEFINER`
projection, following 0041. `branding_settings` and `settings` are tenant tables
with no platform read policy, and they stay that way; the console gets the dozen
fields it displays and nothing more. No business entity is duplicated into the
builder.

### AI provider abstraction

```
route → service → WebsiteAIService → WebsiteAIProvider → (Claude | OpenAI | …)
                        ↓
            parseSiteDefinition()  ← the only door model output comes through
```

`WebsiteAIProvider.generateSite()` returns `{ raw: unknown }`. A provider cannot
assert that its own output is a SiteDefinition — only `WebsiteAIService`, by
parsing it, can. A model that invents a section type, smuggles markup into a
heading or returns prose produces a rejection, not a page. A provider that
throws is a failed generation, and the upstream message is not shown to the
operator.

`MockWebsiteAIProvider` builds a starting site from the customer's own data. It
calls nothing, so an operator can create a real draft before any AI is wired up.

**For the Claude phase:** construct the provider in
`websiteAIService()` (`ai/service.ts`) — server-side only. The key is read
there and never reaches a client component. No route, service or renderer
changes.

### Security model

- Every service function calls `requirePlatformAdmin()`; every table is behind
  `app.is_platform_admin()` in RLS, enabled **and** forced. The TypeScript gate
  is for a clean 404; RLS is the boundary.
- `created_by` / `updated_by` are **set** by a trigger from `auth.uid()`, never
  accepted. A forged value in an insert changes nothing.
- The organization is verified server-side and a website cannot be moved to
  another one.
- Audit is written by a trigger, not the service layer, so every path leaves a
  line: `platform.website_created` / `_updated` / `_published` / `_archived`,
  through the existing `audit_logs` and the `platform.` prefix 0035 requires.
  There is no second audit system.
- `anon` has no policy and no privilege. **Public serving is not built yet.**
  When it is, it will be a narrow `SECURITY DEFINER` projection of
  `published_definition` — the way 0042 serves its live revision — never a
  broadened policy on these tables. `slug` is reserved now so the entity does
  not have to change shape then.

### Tests

`supabase/tests/23_platform_websites.sql` — 11 checks, each verified against a
deliberately broken schema (broad read policy, neutered authorship trigger,
removed definition validation, dropped audit trigger, widened section list) to
confirm it is live. Unit tests in `src/modules/platform/websites/`.

## Retail stock transfers

Migration `0052_retail_stock_transfers.sql`.

### The problem it fixes

0012 listed `transfer_in` and `transfer_out` among the movement reasons, but
nothing ever paired them. Moving stock between branches meant two unrelated
manual adjustments, which left two real defects:

1. **Nothing tied the legs together.** Stock could be recorded leaving branch A
   and never arriving at branch B — or arriving in a different quantity. Each
   branch's ledger balanced; the organization's did not.
2. **`transfer_in` was unaudited stock creation.** Anyone holding
   `retail.inventory.adjust` could add any quantity to their own branch and call
   it an incoming transfer, with no source branch to reconcile against.

### The model

| Table | Purpose |
|---|---|
| `retail_stock_transfers` | The movement of goods as a document: organization, source branch, destination branch, note, actor. |
| `retail_stock_transfer_lines` | What moved, per variant. `unique (transfer_id, variant_id)`. |

`retail_stock_transfer(p_org, p_from_branch, p_to_branch, p_items, p_note)`
writes the header, the lines and **both** movement legs in one transaction.
0012's trigger takes the row lock and refuses to drive stock negative, so an
over-transfer aborts entirely — no partial move, no phantom arrival.

Transfers are **immediate**: stock leaves and arrives in the same commit. There
is no in-transit state, because modelling one means deciding who owns goods on a
van and what happens when they never arrive — a business decision nobody has
made. The document exists so an in-transit status can later be added *to* it
rather than replacing it.

### Permission

`retail.inventory.transfer`, seeded to the `admin`, `manager` and `storekeeper`
templates, with the same owner-role backfill 0019 used so existing organizations
are not locked out.

Deliberately **separate from `retail.inventory.adjust`**. Adjusting is a
statement about one branch's own shelves (a breakage, a recount). A transfer
reaches into a second branch and changes its stock. The function requires the
permission on **both** branches — holding it only at the source would let
someone inflate a branch's inventory from a distance.

`transfer_in` / `transfer_out` were removed from the manual-adjustment schema and
from the inventory UI's reason list.

### Constraint

```sql
check (reason not in ('transfer_in','transfer_out') or ref_type = 'transfer')
```

Added `NOT VALID` on purpose: rows written before this migration were legal when
they were written, and rejecting history to satisfy a new rule would be worse
than the rule not being retroactive. It is enforced on every row from here on.

### RLS

Read requires `retail.inventory.read` on **either** end — both branches took
part, and a branch manager needs to see what left as well as what arrived. There
is **no insert, update or delete policy at all**: the document is written solely
by the function, so a transfer cannot exist without its movements and a movement
cannot be edited to disagree with its document. `anon` gets nothing.

### Tests

`supabase/tests/24_retail_stock_transfers.sql` — 10 checks, each verified against
a deliberately broken schema (permission downgraded to `adjust`, the transfer
constraint dropped, a broad tenant read policy) to confirm it is live.
`src/modules/retail/inventory/transfers.test.ts` covers the service layer.

## RBAC escalation guards (security audit, 0053)

`src/modules/core/rbac/permissions.ts` has always stated the rule — *a member
may only grant a permission they themselves hold* — but **nothing enforced it**.
`ELEVATED_PERMISSIONS`, the constant written to express it, had no consumers
anywhere in the codebase. Four doors led from one manage-permission to the
entire catalog. All four were reproduced against a real database before being
fixed.

| # | Door | Proven escalation |
|---|---|---|
| 1 | `role_permissions` write policy asked only for `role.manage` | The **default `admin` template** holds `role.manage` and *not* `billing.manage`. It granted itself `billing.manage`, then all 53 permissions. |
| 2 | `user_roles` write policy asked only for `member.manage` | A role holding only `member.read` + `member.manage` assigned itself the `admin` role, gaining `role.manage`, `treasury.manage`, `payment.refund`, `invoice.void`. |
| 3 | `invitation_create` validated the role's *organization*, not its strength | `member.manage` could invite a new account as `admin`; the inviter controls the address. |
| 4 | `organizations.owner_user_id` writable under `organization.manage` | An admin could name itself the owner of record shown to platform operators. |

### The rule, once

`app.role_grantable(role)` answers "does the caller hold everything this role
holds?". One definition, used by the `user_roles` policy, the invitation trigger
and the tests, so the three cannot drift. The `role_permissions` policy applies
the same rule directly per permission key.

### Deliberately still allowed

**Revoking.** The `USING` clauses are untouched: `role.manage` may still remove
a permission its holder does not have. Revocation is de-escalation, and
requiring the permission to take it away would let a stray grant become
permanent because nobody left is entitled to remove it.

Owner roles were already protected by `not r.is_owner` and remain so.
Provisioning is `SECURITY DEFINER` and is not subject to these policies, so no
legitimate flow changed — the suite asserts an admin still assigns the standard
templates, still grants what it holds, and that the owner can still grant
anything.

### Ownership

`owner_user_id` is written once by provisioning and read by the platform console.
No flow transfers it, so `app.freeze_organization_owner()` refuses any UPDATE
that changes it. The rest of the organization row stays editable under
`organization.manage`. A real transfer feature, if ever built, needs its own
audited function.

### Tests

`supabase/tests/25_rbac_escalation.sql` — 9 checks, each verified against a
schema with the corresponding guard reverted (both policies, both triggers) to
confirm it is live.

## RBAC reconciliation (read-only investigation)

`supabase/scripts/rbac_reconciliation.sql` — an investigative report for the
escalation paths migration 0053 closed. It **decides nothing and changes
nothing**. There is deliberately no remediation script: revoking a permission
from a live tenant is a business decision, not a query.

```bash
psql "$DATABASE_URL" -f supabase/scripts/rbac_reconciliation.sql

# Narrow to the vulnerable window by passing when 0053 was deployed:
psql "$DATABASE_URL" -v cutoff="2026-09-19T18:00:00Z" \
     -f supabase/scripts/rbac_reconciliation.sql
```

### Safety

The script runs inside `set transaction read only` and ends in `ROLLBACK`.
PostgreSQL refuses `INSERT`, `UPDATE`, `DELETE` and `CREATE` — including
temporary tables — inside such a transaction, so this is **enforced by the
server**, not promised by the author. `supabase/tests/26_rbac_reconciliation.sql`
asserts each of those four refusals.

### What it checks

| Section | Question |
|---|---|
| 0 | What provenance this database actually holds |
| 1 | Template-cloned roles holding permissions their template never had |
| 2 | Role assignments the product could not have produced |
| 3 | Invitations carrying roles the inviter does not currently hold |
| 4 | Organization ownership (informational only) |
| 5 | Role population, so section 1 is read in proportion |

Section 1 is the main report. Provisioning clones a template's permission set
exactly (0031), and **the application has no write path to `role_permissions` at
all** — the roles screen is read-only. A cloned role that differs from its
template was therefore written directly against the API or the database.

### What it cannot prove

**`role_permissions` carries `created_at` and nothing else** — no `granted_by`,
and no trigger writes an audit line when a permission is attached to a role. For
the main escalation path the database can say *when* and never *who*.

**No output of this script is ever CONFIRMED.** The strongest available verdict
is `SUSPICIOUS`. The classifications are:

- `SUSPICIOUS` — the product could not have produced this row.
- `UNKNOWN` — no baseline exists (template renamed or removed), the row
  postdates the cutoff, or no actor was recorded.
- `LEGITIMATE_CUSTOMIZATION` — counted in section 5, never reported.

`user_roles.granted_by` is **not trustworthy attribution**: the column has no
default and the pre-0053 policy never required it, so a direct API insert could
omit it or name somebody else. A missing actor proves only that the row was not
written by the product — a seed, a data migration and an operator working in SQL
are indistinguishable from an escalation, which is why that case is `UNKNOWN`.

Organization ownership history is **not retained at all**, so whether
`owner_user_id` was ever reassigned cannot be answered. 0053 freezes it going
forward.

### Why a custom role is not a finding

An organization may create its own roles, and their permission sets were never
templated — divergence from a template is not even *defined* for them. Only
roles with `is_system = true` have a baseline, and only those are compared. The
test suite asserts a custom role holding `payment.refund` produces no finding.

### How to review the output

1. Start with section 0. If `role_permissions.granted_by` is absent, no row
   below can name a person.
2. In section 1, check each permission against what that role is *for*. A
   `cashier` holding `treasury.manage` deserves attention; an `admin` holding
   one extra reporting permission probably does not.
3. Cross-reference `permission_attached_at` with the role's `created_at`. A
   permission attached long after provisioning is more interesting than one
   attached in the same second.
4. Treat section 2's `UNKNOWN` rows as questions for whoever administers the
   database, not as incidents.
5. Nothing here justifies revoking a permission on its own. Confirm with the
   organization before changing a live tenant.
