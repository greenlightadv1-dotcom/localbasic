# Restaurant staging — setup requirements

Nothing in this document has been executed. No Vercel project was created, no
Supabase project was created or modified, and no deployment exists. It is the
list of what has to be true before a staging smoke test is meaningful, and the
exact steps to make it so.

Read `DEPLOY_VERCEL.md` first — this document only covers what is specific to
standing up a *staging* environment from nothing.

---

## 1. Why the existing project cannot be used

The only Supabase project on the account besides `green-light` is `localbasic`
(`sztwmzwoxogxyabipwyo`). It is **not** usable as staging:

**It holds real tenant data.** Read via `list_tables` on 2026-09-21: one
organization, one member, one platform admin, ten restaurant tables, ten QR
codes, ten `public_links`, one treasury transaction, nine audit-log rows. A
staging smoke test writes orders and payments; those would land in a real
tenant's books.

**Its schema is behind this repository.** 62 tables against the 66 that the 54
committed migrations produce. Missing, confirmed by diffing the hosted table
list against a freshly migrated local database:

| Table | From migration |
|---|---|
| `platform_websites` | `0051_platform_website_builder.sql` |
| `platform_website_versions` | `0051_platform_website_builder.sql` |
| `retail_stock_transfers` | `0052_retail_stock_transfers.sql` |
| `retail_stock_transfer_lines` | `0052_retail_stock_transfers.sql` |

**Two further migrations cannot be checked at all.** `0053_rbac_escalation_guards`
and `0054_restaurant_payment_lock` change functions, policies and triggers, not
tables, so a table listing cannot see them. Verifying them needs `execute_sql`
against the project, which this environment is not authorised to use.

`0054` is the one that matters most for a Restaurant smoke test: it is the lock
that stops two cashiers taking payment for the same order at the same moment.
Without it, reproduced against a real database, one order of 10 000 was taken
twice — two completed payments, two invoices, both reporting nothing due. **A
payment smoke test against a project where 0054's state is unknown is not a
test; it is a risk.**

## 2. What a dedicated staging project needs

### 2.1 The project

A Supabase project separate from `localbasic` and from `green-light`. Same
region as production (`eu-central-1`) so timing behaviour is comparable.
Creating it is a paid action and has not been taken.

### 2.2 Schema

All 54 migrations in `supabase/migrations/`, applied **in filename order**,
`0001` through `0054`. They are append-only; never edit one that has shipped.

```
supabase link --project-ref <staging-ref>
supabase db push
```

Then confirm the result rather than assuming it:

```sql
-- expect 66
select count(*) from information_schema.tables
 where table_schema = 'public' and table_type = 'BASE TABLE';

-- expect zero rows: every tenant table has RLS enabled AND forced
select relname from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and (not c.relrowsecurity or not c.relforcerowsecurity);

-- expect zero rows: the append-only ledgers grant no UPDATE or DELETE
select table_name, privilege_type from information_schema.table_privileges
 where grantee = 'authenticated'
   and table_name in ('payments','treasury_transactions','retail_stock_movements')
   and privilege_type in ('UPDATE','DELETE');

-- expect both present: the guards a table listing cannot see
select proname from pg_proc where proname = 'restaurant_pay_order';
select tgname  from pg_trigger where not tgisinternal and tgname like '%escalat%';
```

The first three are the ones to insist on. A staging database that fails any of
them is not representing production.

### 2.3 Seed data — test data only

Staging must not be a copy of production. Provision a throwaway workspace
through the application's own path (`/admin/onboard`, or `provision_workspace`)
so roles, permissions and counters are built the way a real tenant's are.
`supabase/seed/restaurant_demo.sql` is the Arabic demo restaurant used locally
and is suitable.

Never restore a production backup into staging.

### 2.4 Auth configuration

* **Site URL** — the staging origin, e.g. `https://<project>.vercel.app`
* **Redirect URLs** — both, exactly:
  * `https://<staging-origin>/callback`
  * `https://<staging-origin>/callback/recovery`

The second is not optional and is not covered by the first: Supabase matches
the allow-list against the whole URL, and a failed match falls back to the Site
URL silently, so password reset breaks with no error anywhere.

For a staging project, email confirmation may be turned off under
Authentication → Providers → Email to make test sign-ups quick. It must be on
before anything real.

## 3. Vercel project configuration

Not created. When it is, from `greenlightadv1-6093`:

* Import `greenlightadv1-dotcom/localbasic`, framework preset **Next.js**
* Branch: `claude/localbasic-saas-foundation-8h4zya`
* **Node.js Version: 20** (Settings → General) — `package.json` now pins
  `engines: 20.x`, which CI also builds on
* Build command, output and install command: leave at the Next.js defaults

### Environment variables, scope **Preview** (or a named Staging environment)

| Name | Value | Visibility | When it is read |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<staging-ref>.supabase.co` | Public | **Build time** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | staging project's `anon` key | Public by design | **Build time** |
| `NEXT_PUBLIC_APP_URL` | the staging origin, no trailing slash | Public | **Build time** |
| `LOCALBASIC_LOCAL_DB` | `0` | Server | Runtime |

Rules that are not negotiable:

* **No private secret may carry a `NEXT_PUBLIC_` prefix.** The service-role key
  bypasses RLS entirely; prefixing it publishes it to every visitor.
* `NEXT_PUBLIC_*` values are inlined into the bundle **at build time**. Adding
  or changing one does nothing until the next build — set them *before* the
  first deployment, and redeploy after any change.
* Do **not** set `SUPABASE_SERVICE_ROLE_KEY` unless staging needs
  `/admin/onboard` to create an owner account. Nothing else uses it.
* Scope the variables to Preview/Staging only. A value scoped to Production by
  accident is how a staging key reaches a production build.

Optional, each enabling exactly one thing and nothing else:
`NOTIFICATION_WORKER_SECRET`, `RESEND_API_KEY` + `NOTIFICATION_FROM_EMAIL`,
`ADMIN_BOOTSTRAP_SECRET`.

`UPSTASH_REDIS_REST_URL` / `_TOKEN` are reserved and **not implemented** —
setting them changes nothing. See §5.

## 4. Order of operations

The sequence matters; two of these cannot be done in the other order.

1. Create the staging Supabase project
2. Apply all 54 migrations, in order
3. Run the four verification queries in §2.2
4. Seed a throwaway workspace
5. Configure Supabase Auth Site URL and both redirect paths
6. Create the Vercel project, Node 20
7. Set the four environment variables **before the first build**
8. Deploy
9. Read the staging origin Vercel prints, and if it differs from what was set
   in step 7, correct `NEXT_PUBLIC_APP_URL` and **redeploy** — it is inlined
10. `GET /api/diagnostics/app-origin` → expect `source: "NEXT_PUBLIC_APP_URL"`,
    `isLoopback: false`. This endpoint emits booleans and the public origin
    only; no key, cookie or header value
11. Run the smoke test in §6
12. Run the hosted PostgREST checks in §7

## 5. Rate limiting on staging

`src/lib/rate-limit.ts` is **in-memory only**. It is not distributed and is not
production-grade. On Vercel each serverless instance keeps its own counters,
instances scale out under exactly the load an attacker applies, and a cold
start begins with an empty map.

For a controlled staging deployment that is acceptable: the traffic is yours.
Before the storefront is publicly reachable it is not. See the decision note in
the phase report; the short version is that `publicOrder` and `storeCheckout`
have no backstop, while `signIn`, `signUp` and `passwordReset` at least sit in
front of Supabase Auth's own per-project limits.

## 6. Staging smoke test

Record the HTTP status **and** what actually rendered. A 200 proves nothing on
its own — a Next.js not-found page returns 200 in some configurations, and an
error page is still a page.

| # | Step | Expected |
|---|---|---|
| 1 | Sign in as a seeded staff user | Session cookie set; lands in the workspace |
| 2 | Switch organization and branch | Branch name changes in the header and the data follows |
| 3 | Open Tables, inspect one | Floor plan renders |
| 4 | Generate a QR for a table | QR image renders |
| 5 | **Read the QR's target URL** | Starts with the staging origin — **not** `localhost`, not a stale `.vercel.app` |
| 6 | Scan/open the public menu at `/p/<token>` | Menu renders, no session required |
| 7 | Place a guest order | Order accepted; totals computed server-side |
| 8 | Check the order appears in the right branch | Present in that branch, absent from the other |
| 9 | Open the kitchen view | Ticket visible; **no price, total or invoice id anywhere in the page source** |
| 10 | As the kitchen user open `/reports`, `/treasury`, `/cashier`, `/invoices`, `/expenses` | The "الصفحة غير موجودة" page, and no figures in the HTML |
| 11 | Take payment as cashier | One payment, one invoice |
| 12 | Press payment twice quickly | Second attempt refused; still one payment and one invoice — **this is what 0054 buys** |
| 13 | Inspect the invoice/receipt | Numbered from the counter, totals match the order |
| 14 | Check treasury | One matching inbound entry |
| 15 | Open the reports screen | Revenue matches a direct SQL sum over the same window |
| 16 | Sign out | Session cleared; protected route redirects |
| 17 | Password reset, end to end on the staging domain | Email arrives, link returns to `/callback/recovery`, password changes |
| 18 | Open an invalid/revoked QR token | Refused cleanly, no stack trace, no internal detail |

Use test data only. No real customer or payment details.

## 7. Hosted PostgREST checks

These have never been run against hosted PostgREST from this environment —
outbound access to the project host is blocked at the proxy, and the
`execute_sql` tool is not authorised here. They are verified against real
PostgreSQL and the installed `postgrest-js`, which is a different thing.

Run against the **staging** project, as a member of the throwaway workspace.

| Check | Request | Expected |
|---|---|---|
| `.range()` | `?select=id&order=id.asc&offset=0&limit=2`, then `offset=2&limit=2` | Two rows each, disjoint, ascending |
| `count: exact` | both of the above with `Prefer: count=exact` | `Content-Range: 0-1/N` then `2-3/N`, **same N** |
| Past the end | `?offset=<N>&limit=10` | HTTP 200 and `[]` — not 416 |
| Non-selected ordering | `?select=amount_cents,method&order=id.asc` | 200, stable order across two identical calls |
| `.in()` chunking | 250 ids as 200 + 50 | 250 distinct rows, none twice |
| Empty result | a window with no rows | `[]`, `Content-Range: */0` |
| Tenant isolation | `?organization_id=eq.<other-org>` as the test member | `[]` — RLS, not a filter |
| Branch isolation | same for `branch_id` | `[]` |
| Unauthorised | anon key with no session on a tenant table | `[]` or 401, never rows |
| Row cap | Settings → API → **Max rows** | Record the number. Do not guess it |
| Report totals | reports screen vs `sum(amount_cents)` for the same absolute UTC window | Exact match, to the piastre |

If any of the first three behaves differently from the table, stop: the
pagination loop's termination condition depends on them.

## 8. Known limitation carried into staging

Reports paginate with OFFSET, which is not snapshot-consistent. A known
cross-page consistency risk remains for open, multi-page reporting windows and
requires an explicit product decision before production. It needs a window
holding more than 1 000 rows for one branch plus a write committing between two
page requests; the error is bounded at one row per occurrence, and because
revenue and expenses read append-only tables they can only be overstated, never
understated. `SUPABASE.md` states the triggering conditions exactly and compares
the four candidate mitigations. None is implemented.
