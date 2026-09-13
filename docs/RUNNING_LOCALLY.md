# Running LocalBasic locally

No Supabase project and no payment provider are involved. The app talks to a
local PostgreSQL directly through a development-only adapter
(`src/lib/supabase/local/`) that runs every query as the `authenticated` role
with the caller's id in `request.jwt.claims` — so RLS and every policy apply
exactly as they do in a deployed environment. Only the transport is replaced,
and the adapter refuses to load when `NODE_ENV=production`.

## 1. PostgreSQL

Any PostgreSQL 16 reachable on port 5433. On this machine:

```bash
export PATH=/usr/lib/postgresql/16/bin:$PATH
su postgres -c "pg_ctl -D /tmp/pgdata-lb -o '-p 5433 -k /tmp' -l /tmp/pg.log start"
```

## 2. Database and demo data

```bash
./scripts/dev-db.sh
```

Drops and recreates `localbasic_dev`, applies every committed migration, then
loads the Arabic demo restaurant: **مطعم الحارة الشامية**, two branches, 14
tables with QR codes, a 16-item menu with modifiers, staff on four roles,
orders at every stage, takings and expenses.

## 3. The app

```bash
npm run dev     # http://localhost:3000
```

`.env.local` already sets `LOCALBASIC_LOCAL_DB=1`.

## 4. Signing in

Go to **http://localhost:3000/dev** and pick a staff member. Each one shows the
product through their own permissions:

| Who | Sees |
|---|---|
| أبو محمود الحلبي — owner | everything |
| سامي الخوري — branch manager | full operations, no organization settings |
| ندى عبد الرحمن — cashier | orders, till, receipts; no menu management |
| الشيف عمّار — kitchen | kitchen display, menu, tables; **no money at all** |
| كريم السيد — waiter | floor and serving; **no money at all** |

## Guest QR page

Any table's QR resolves at `/p/<token>`. Get one with:

```bash
psql -h /tmp -p 5433 -U postgres -d localbasic_dev -tAc \
  "select pl.token from public_links pl
     join restaurant_tables t on t.public_link_id = pl.id
    where t.name = '3' and pl.is_active limit 1"
```

Or open **الطاولات** in the app and use the QR button on any table.

## Checks

```bash
npm run typecheck                  # tsc
npm run build                      # production build
npx vitest run                     # unit tests
node scripts/check-permissions.mjs # TS and SQL permission catalogs agree
(cd supabase && ./tests/run.sh)    # schema, isolation and flow suites
npx playwright test                # browser journey (needs the dev server up)
```

## Known local-only limitations

- The Cairo webfont is fetched from Google Fonts. Offline it falls back to the
  system Arabic face; the layout is unaffected.
- `/dev` sign-in does not check a password. It exists to inspect the UI and is
  unreachable unless `LOCALBASIC_LOCAL_DB=1`.
- Run `next build` only when the dev server is stopped — they share `.next`.
