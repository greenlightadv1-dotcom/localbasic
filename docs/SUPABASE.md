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
