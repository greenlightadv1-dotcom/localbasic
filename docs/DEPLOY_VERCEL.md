# Restaurant launch on Vercel

Covers the Restaurant module and the shared Core it needs. Scope is Vercel
only — no other host is configured, and nothing here assumes one.

For a throwaway preview, `DEPLOY_PREVIEW.md` is shorter and enough. This
document is the one to follow when the deployment will have real tenants.

---

## 1. What runs where

Everything is the **Node.js runtime**. No route opts into Edge, and none
should without re-checking it: `pg`, the `crypto` token generator and the
Supabase admin client all assume Node.

Every tenant screen already declares `export const dynamic = 'force-dynamic'`,
which is correct — they read cookies and must never be served from the CDN.
Only the marketing pages are prerendered.

Node **20** is what CI builds and tests on. Set the same on Vercel
(**Settings → General → Node.js Version**). `package.json` pins no `engines`
field, so Vercel picks its own default otherwise, and that default moves.

## 2. Environment variables

`NEXT_PUBLIC_*` values are **inlined into the bundle at build time**. Adding
one after a deploy changes nothing until the next build. That is the single
most common way this app comes up subtly wrong.

### Required — the build fails without them

| Name | Scope | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public, build time | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public, build time | The `anon` key. Public by design; RLS is what protects the data |

Missing either one fails the build at `Failed to collect page data`, which is
the intended behaviour — `src/lib/env.ts` parses them at module load.

### Required for a real deployment — no error if missing

| Name | Scope | Why it matters |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | Public, build time | `https://<your-domain>`, no trailing slash. **Set this.** It is the origin printed into table QR codes, staff invitation links and password-recovery emails |
| `LOCALBASIC_LOCAL_DB` | Server | `0`. The local adapter refuses to run under `NODE_ENV=production` anyway, so this is belt and braces |

`NEXT_PUBLIC_APP_URL` has a zod default of `http://localhost:3000`, so leaving
it out raises **no error at all** — links are simply generated pointing at a
machine nobody can reach. `appOrigin()` (`src/lib/auth/redirects.ts`) softens
this by falling back to `VERCEL_PROJECT_PRODUCTION_URL`, which Vercel sets
itself at runtime, and every printed or emailed link goes through it. That is
a safety net, not a substitute: on a custom domain the fallback yields the
`.vercel.app` host, not yours.

Check it after deploying: `GET /api/diagnostics/app-origin` reports which
source won and whether the origin is a loopback. It emits booleans and the
public origin only — no secret, key, cookie or header value.

### Optional — each enables one feature, and nothing else breaks without it

| Name | Scope | Enables |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | **Server only** | Creating an owner account from Platform Admin → `/admin/onboard`, and background workers |
| `NOTIFICATION_WORKER_SECRET` | Server only | `/api/worker/notifications`. Without it the route answers 503 to everyone — closed by default |
| `RESEND_API_KEY`, `NOTIFICATION_FROM_EMAIL` | Server only | The email channel. Both together or neither |
| `ADMIN_BOOTSTRAP_SECRET` | Server only | `/api/admin-bootstrap`, a break-glass recovery link. The route 404s without it |
| `NEXT_PUBLIC_WHATSAPP_NUMBER`, `NEXT_PUBLIC_CONTACT_EMAIL` | Public | Override the defaults in `src/config/site.ts` |

`UPSTASH_REDIS_REST_URL` / `_TOKEN` are **reserved and not implemented**.
Setting them changes nothing — see §7.

**Never** give a server variable a `NEXT_PUBLIC_` prefix. The service-role key
bypasses RLS entirely; prefixing it would publish it to every visitor.

## 3. Supabase Auth configuration

Under **Authentication → URL Configuration**:

* **Site URL** — `https://<your-domain>`
* **Redirect URLs** — both of these, exactly:
  * `https://<your-domain>/callback`
  * `https://<your-domain>/callback/recovery`

The second is easy to miss and breaks password reset on its own. Supabase
matches the allow-list against the **whole URL**, so an entry of `/callback`
does not cover `/callback/recovery`; a failed match silently falls back to the
Site URL and the recovery token never reaches the page that redeems it. The
path is exported as `RECOVERY_CALLBACK_PATH` so the code, the email and this
list cannot drift apart.

For preview deployments the host changes per push, so add the project wildcard
as well.

## 4. Database migrations

Migrations are plain SQL in `supabase/migrations/`, applied **in filename
order**, and are **append-only**: never edit one that has shipped.

Vercel does not run them. Apply them to the Supabase project before the deploy
that needs them, from a machine with the CLI:

```
supabase link --project-ref <ref>
supabase db push
```

Order matters for a release: **migrate first, then deploy**. Every migration to
date is additive, so an older bundle keeps working against a newer schema for
the minutes in between; the reverse is not true.

Verify afterwards that RLS survived the push — `select relname, relrowsecurity,
relforcerowsecurity from pg_class` over the tenant tables — and that no table
grants `update` or `delete` on the append-only ledgers (`payments`,
`treasury_transactions`, `retail_stock_movements`).

## 5. Function limits and timeouts

Serverless functions have a wall-clock limit that depends on the plan — 10s on
Hobby by default, more on Pro. Relevant here because a report paginates: a
window of 50 000 rows is 50 sequential round trips. A month-wide report for a
busy branch is the case to watch. No route declares `maxDuration`; add one for
the report routes if a timeout is ever observed, rather than pre-emptively.

Nothing writes to the filesystem, holds a long-running process, or keeps
in-process state that has to survive a request — with the one exception in §7.

## 6. Scheduled work

`/api/worker/notifications` expects a scheduler. **No `vercel.json` exists, so
nothing calls it today.** That is currently harmless: the notification queue
has no producers — nothing in the Restaurant flow enqueues, and the SQL grep
for inserts into `notification_queue` finds none — so the queue is dormant
rather than backing up.

When a producer is added, a cron entry is needed. Vercel Cron sends
`Authorization: Bearer $CRON_SECRET`, which the route already accepts, so
setting `CRON_SECRET` to the same value as `NOTIFICATION_WORKER_SECRET` is
enough. Note the Hobby plan permits one cron run per day.

## 7. Rate limiting on serverless — read before relying on it

`src/lib/rate-limit.ts` is **in-memory only**. Each serverless instance keeps
its own counters, instances scale out under exactly the load an attacker
creates, and a cold start begins empty. The configured numbers are a brake on
casual abuse from one client, **not a guarantee**.

Partly compensating: `signIn`, `signUp` and `passwordReset` sit in front of
Supabase Auth, which applies its own per-project limits server-side.
`publicOrder` and `storeCheckout` — the QR ordering path — have no such
backstop. Database constraints reject invalid orders, not repeated ones.

Closing this properly needs a shared store. The env names are reserved; the
implementation is not written, and this document does not pretend otherwise.

## 8. Already handled in code — no action needed

* `/dev`, the demo sign-in, is refused in middleware whenever the local adapter
  is off, so it 404s on Vercel and its `pg`-backed module never loads.
* The local PostgreSQL adapter refuses to initialise under `NODE_ENV=production`
  regardless of `LOCALBASIC_LOCAL_DB`.
* Session cookies are `httpOnly`, `sameSite=lax`, and `secure` in production.
* CSP allows `https://*.supabase.co` for `connect-src` and `img-src`.
* Middleware treats `*.vercel.app` as a platform host, so preview deployments
  are not mistaken for tenant custom domains.
* Recovery links are built from configuration, never from the request `Host`
  header — a spoofed host cannot redirect a genuine reset token.
* Error boundaries show a correlation digest, never the underlying message.

## 9. Pre-launch checklist

Run in order. Each line is either verified or it is not; do not infer.

- [ ] Node.js version set to 20 in Vercel project settings
- [ ] `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` set, build green
- [ ] `NEXT_PUBLIC_APP_URL` set to the real origin, **and redeployed after setting it**
- [ ] `LOCALBASIC_LOCAL_DB=0`
- [ ] No server secret carries a `NEXT_PUBLIC_` prefix
- [ ] Supabase **Site URL** set
- [ ] Both `/callback` **and** `/callback/recovery` in the redirect allow-list
- [ ] Email confirmation switched back **on** for a real project
- [ ] Migrations applied to the target project, in order, before the deploy
- [ ] `GET /api/diagnostics/app-origin` reports `source: NEXT_PUBLIC_APP_URL` and `isLoopback: false`
- [ ] Sign in, take one payment, print one table QR, scan it, place one guest order
- [ ] Confirm the scanned QR opens **your** domain, not `.vercel.app` or localhost
- [ ] Password reset end to end, on the real domain
- [ ] Reports screen loads and its revenue matches a direct SQL sum for the same window
- [ ] Record the project's **Max rows** setting (Settings → API) — see §10

## 10. Hosted checks this repository cannot make

Outbound access to the Supabase project is blocked from the development
sandbox, so the following are **unverified against hosted PostgREST** and must
be confirmed on staging by hand. They are verified against real PostgreSQL and
against the installed `postgrest-js`, which is not the same thing.

- [ ] `.range()` paginates correctly over the hosted API
- [ ] `count: 'exact'` returns the **total**, unchanged across pages
- [ ] Ordering by a column absent from the select list is accepted
- [ ] `.in()` chunking returns each id exactly once
- [ ] RLS isolation holds on paginated reads for a member of another org
- [ ] The project's `db-max-rows` value — **not known, and not guessed here**

`SUPABASE.md` carries the detailed procedure for each.

## 11. Known limitation to decide before production

Reports paginate with OFFSET, which is **not snapshot-consistent**. A known
cross-page consistency risk remains for open, multi-page reporting windows and
requires an explicit product decision before production. It needs a window
holding more than 1 000 rows for one branch, plus a write committing between
two page requests; the error is bounded at one row per occurrence. Revenue and
expenses read append-only tables, so they can only be overstated, never
understated.

`SUPABASE.md` §"Report pagination" states the triggering conditions exactly and
compares the four candidate mitigations. None is implemented.
