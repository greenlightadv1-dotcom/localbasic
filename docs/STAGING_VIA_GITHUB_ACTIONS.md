# Applying staging migrations from GitHub Actions

The repository lives on GitHub and there is no local checkout to work from.
This is the remote path: a manually triggered workflow runs the migrations on a
GitHub runner, which can reach Supabase.

**Why a runner and not the agent:** the agent sandbox cannot reach
`api.supabase.com` or `*.supabase.co` — both are blocked at its proxy — and its
Supabase credential is scoped to an organization that does not contain the
staging project. A GitHub runner has neither limitation. Nothing about the
migrations needs a local machine.

**Workflow:** `.github/workflows/staging-migrate.yml`
**Verification script:** `supabase/scripts/staging_verify.sql`
**Staging project:** `kcnzqqejqpcgqqkivcyq`
**Production, never a target:** `sztwmzwoxogxyabipwyo`

---

## 1. One-time setup on GitHub

### 1.1 Create the environment

**Settings → Environments → New environment → `staging`**

The job binds to it, so the secrets below are scoped to that environment rather
than the whole repository. Adding **Required reviewers** there makes every
migration run wait for a human approval — worth doing.

### 1.2 Add one variable

**Settings → Secrets and variables → Actions → Variables → New**

| Name | Value |
|---|---|
| `STAGING_PROJECT_REF` | `kcnzqqejqpcgqqkivcyq` |

A variable, not a secret: it is not sensitive, and the guard compares it
against what you type when starting the run. Secrets are masked in logs, which
would make that comparison impossible to debug.

### 1.3 Add three secrets

**Settings → Environments → staging → Environment secrets**

| Name | Where to get it | Notes |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com/dashboard/account/tokens → Generate new token | A personal access token. Scope it to the account that owns the staging project |
| `STAGING_DB_PASSWORD` | Staging project → Project Settings → Database → Database password | Reset it there if you no longer have it |
| `STAGING_DATABASE_URL` | Staging project → Project Settings → Database → Connection string → **URI** | Used only by the verification step. Embeds the password, hence a secret. Prefer the **Session pooler** URI — runners reach it more reliably than a direct connection |

Paste each straight into the GitHub form. **None of them should be sent in
chat, pasted into a file, or committed.** GitHub masks them in run logs.

> If the account that owns the staging project is not the one you normally use,
> generate the access token while signed into *that* account. A token from the
> wrong account is the likeliest cause of a `link` failure.

---

## 2. Run it — dry run first

**Actions → Staging migrate → Run workflow**

| Field | First run | Real run |
|---|---|---|
| Branch | `claude/localbasic-saas-foundation-8h4zya` | same |
| `project_ref` | `kcnzqqejqpcgqqkivcyq` | same |
| `dry_run` | **true** | **false** |

The dry run links to the project and lists what `db push` would apply, without
applying anything. Read that list before the real run: it should be 54 files,
`0001_core_tenancy.sql` through `0054_restaurant_payment_lock.sql`, in order.

Then run again with `dry_run` **false**.

### What the run does, in order

1. **Refuse anything that is not staging** — three independent checks
2. **Verify the migration set** — count, first, last, and contiguous numbering
3. Install the Supabase CLI
4. **Link, then read `supabase/.temp/project-ref` back** and fail if it is not
   what was asked for
5. `supabase db push --dry-run`
6. `supabase db push` *(skipped on a dry run)*
7. `supabase migration list` *(skipped on a dry run)*
8. **Run the seven verification checks** *(skipped on a dry run)*

### The guards, and what each one stops

| Guard | Stops |
|---|---|
| Typed ref equals the production ref | Pasting production into the box |
| `STAGING_PROJECT_REF` equals the production ref | The variable being set wrong once and forgotten |
| Typed ref ≠ `STAGING_PROJECT_REF` | A typo reaching a real database by coincidence |
| Ref is not 20 lowercase letters | A truncated or half-pasted value |
| Linked ref ≠ requested ref | The CLI linking something other than what it was told |
| Duplicate migration prefix | Two files claiming one position, order undefined |
| Gap in the numbering | A migration missing from the checkout |

Each was tested before this was committed, including the cases where the
production ref arrives through the repository variable rather than the input.

There is **no `push` trigger**. The workflow runs only when someone starts it.
`concurrency` prevents two runs at once and deliberately does **not** cancel an
in-flight one: a half-cancelled `db push` is worse than a queued one.

---

## 3. Reading the result

A successful verification step prints:

```
OK 1  table count = 66
OK 2  RLS enabled AND forced on every public table
OK 3a permission catalog = 53 rows
OK 3b RLS policies in public = 137
OK 3c permission catalog is read-only to tenants
OK 4  payments / treasury / stock movements / audit_logs grant no UPDATE or DELETE
OK 5  restaurant_pay_order() present
OK 6  0053 present: app.role_grantable(), both write policies, both guard triggers
OK 7  0054 payment lock present on every restaurant_pay_order overload
INFO  organizations present = 0 (expect 0 before seeding, 1 after)
STAGING VERIFICATION: all checks passed
```

`organizations present = 0` is the expected value on a fresh staging database,
and a sanity signal in itself: anything above zero on a database nobody has
seeded means it is not the database you think it is.

Any `ERROR:` line fails the step and names what is wrong. **Check 7 is the one
to care about most** — it is the lock that stops two cashiers taking the same
payment twice, and a payment smoke test against a database that fails it proves
nothing.

## 4. If you would rather not use Actions

The same verification runs in the dashboard, with no CLI and no secrets in
GitHub: **staging project → SQL Editor**, paste the whole of
`supabase/scripts/staging_verify.sql`, Run, and read the **Notices** pane. The
file is free of psql meta-commands specifically so that it pastes cleanly.

That covers verification only. Applying the migrations still needs either this
workflow or a CLI somewhere with network access — pasting 54 files into the SQL
Editor by hand is possible but records nothing in the migration history, so the
project would not know what it has and `db push` would later try to apply them
again.

## 5. After a green run

Stop. Seeding a throwaway workspace, creating the Vercel project and any
payment or customer test all wait for an explicit go-ahead.
