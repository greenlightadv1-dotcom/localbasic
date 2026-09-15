# Vercel preview deployment (testing only)

Not production. No custom domain, no payment provider.

## 1. Create the project

Vercel → **Add New → Project** → import `greenlightadv1-dotcom/localbasic`.
Framework preset **Next.js** is auto-detected; leave the build settings alone.

The repository's default branch is `claude/localbasic-saas-foundation-8h4zya`,
so that is what gets built.

## 2. Environment variables (required — the build fails without them)

Add these under **Settings → Environment Variables**, scope **Preview**:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://sztwmzwoxogxyabipwyo.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the `anon` key from Supabase → Settings → API |
| `LOCALBASIC_LOCAL_DB` | `0` |

`NEXT_PUBLIC_*` values are inlined into the client bundle at build time, which
is why a build without them dies at `Failed to collect page data for /callback`.

Do **not** add `SUPABASE_SERVICE_ROLE_KEY`. It is optional, only the admin
client reads it, and nothing in the preview flow needs it. If it is ever added
it must stay server-scoped and must never be given a `NEXT_PUBLIC_` prefix.

## 3. Supabase Auth URLs

After the first deploy Vercel prints the preview host. In Supabase →
**Authentication → URL Configuration**:

* **Site URL** — `https://<preview-host>`
* **Redirect URLs** — add `https://<preview-host>/callback`

Preview hosts change per deployment, so also add the wildcard
`https://localbasic-*-greenlightadv1-6093.vercel.app/callback` to avoid
re-editing this on every push.

Without these, sign-up confirmation and sign-in redirects bounce to
`localhost:3000` and the session is never set.

## 4. Email confirmation

A fresh Supabase project requires email confirmation on sign-up. For preview
testing either confirm via the emailed link, or turn off **Confirm email** under
Authentication → Providers → Email. That setting is for the preview project
only — it must be back on before anything real.

## 5. What is already handled in code

* `/dev` — the demo sign-in that issues a session as any seeded staff member —
  is refused in middleware whenever the local adapter is off, so it 404s on
  Vercel and its `pg`-backed module never loads.
* The local PostgreSQL adapter refuses to initialise when `NODE_ENV=production`,
  independently of `LOCALBASIC_LOCAL_DB`.
* CSP already allows `https://*.supabase.co` for `connect-src` and `img-src`.
