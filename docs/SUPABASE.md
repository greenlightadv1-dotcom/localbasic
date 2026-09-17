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
platform. The account must already exist, so sign in once, then, with a
privileged connection (SQL editor or service role):

```sql
insert into public.platform_admins (user_id, role)
select id, 'owner' from auth.users where email = 'you@example.com';
```

Verify it took:

```sql
select u.email, a.role, a.is_active
from public.platform_admins a join auth.users u on u.id = a.user_id;
```

After that, admins manage each other at **`/admin/team`** — an owner may grant
and revoke, staff may read the roster. Migration 0048 added those functions;
before it, this sentence was aspirational and the roster could only be changed
with a database console.

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
