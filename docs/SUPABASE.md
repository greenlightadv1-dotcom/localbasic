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
