# Staging migration runbook — Windows PowerShell

Run these on your own machine. This environment cannot reach the staging
project: its Supabase connection is scoped to a different organization, and
both `api.supabase.com` and `*.supabase.co` are blocked at the sandbox proxy.

**Target project (staging):** `kcnzqqejqpcgqqkivcyq`
**Never touch:** `sztwmzwoxogxyabipwyo` (production)

No command below asks you to paste a password, token or key into a chat. The
two secrets involved — your Supabase login and the database password — are
entered into your own terminal or browser, and nowhere else.

---

## 0. Get the repository at the right commit

```powershell
cd $HOME
git clone https://github.com/greenlightadv1-dotcom/localbasic.git
cd localbasic
git checkout claude/localbasic-saas-foundation-8h4zya
git log --oneline -1          # expect: c5a6321 (or newer)
```

If you already have a clone:

```powershell
cd <path-to>\localbasic
git fetch origin claude/localbasic-saas-foundation-8h4zya
git checkout claude/localbasic-saas-foundation-8h4zya
git pull origin claude/localbasic-saas-foundation-8h4zya
```

## 1. Supabase CLI — check, then install if missing

```powershell
supabase --version
```

If that errors, install with **one** of these:

```powershell
# Scoop (recommended on Windows)
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase

# or npm, if you have Node 18+
npm install -g supabase
```

Then confirm:

```powershell
supabase --version           # expect 2.x
```

> `npx supabase` also works without installing, but you must then prefix every
> command below with `npx`.

## 2. Log in

```powershell
supabase login
```

This opens a browser and completes the handshake itself. **Do not paste the
token anywhere.** If you are on a headless box and must use a token, set it as
an environment variable in your own shell — never in a message:

```powershell
$env:SUPABASE_ACCESS_TOKEN = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
```

Confirm the CLI can see the project:

```powershell
supabase projects list
```

You should see **localbasic-staging / kcnzqqejqpcgqqkivcyq** in the output. If
it is absent, you are logged into a different Supabase account than the one
that owns it — stop and fix that before going further.

## 3. Link to staging — and check what you linked

```powershell
supabase link --project-ref kcnzqqejqpcgqqkivcyq
```

It prompts for the database password. That prompt is local; the value is not
echoed and must not be shared.

**Verify the link before doing anything destructive:**

```powershell
Get-Content .\supabase\.temp\project-ref
```

This must print exactly:

```
kcnzqqejqpcgqqkivcyq
```

> If it prints `sztwmzwoxogxyabipwyo`, you are pointed at **production**. Stop,
> run `supabase unlink`, and repeat step 3. Do not run step 5.

## 4. Review what is about to be applied

```powershell
(Get-ChildItem .\supabase\migrations\*.sql).Count      # expect 54
Get-ChildItem .\supabase\migrations\*.sql | Select-Object -First 1 -ExpandProperty Name
Get-ChildItem .\supabase\migrations\*.sql | Select-Object -Last 1 -ExpandProperty Name
```

Expect `54`, `0001_core_tenancy.sql`, `0054_restaurant_payment_lock.sql`.

Dry run — shows what would be applied, changes nothing:

```powershell
supabase db push --dry-run
```

Expect all 54 listed, in filename order, against `kcnzqqejqpcgqqkivcyq`.

## 5. Apply the migrations

```powershell
supabase db push
```

The CLI applies them in filename order and stops at the first failure. If one
fails, **stop** — do not re-run, do not skip it. Send me the failing migration
name and the error text and I will work out why.

Confirm what the database now records as applied:

```powershell
supabase migration list
```

Every row should show both Local and Remote populated, `0001` through `0054`.

## 6. Run the verification script

Seven checks, read-only. **Do not seed anything, and do not run a payment test,
until this passes.**

### Option A — psql, if you have it

```powershell
psql --version
```

If that works, get the connection string from the Supabase dashboard
(Project Settings → Database → Connection string → URI), set it in your own
shell, and run:

```powershell
$env:STAGING_DATABASE_URL = Read-Host "Paste the staging connection URI"
psql $env:STAGING_DATABASE_URL -v ON_ERROR_STOP=1 -f .\supabase\scripts\staging_verify.sql
$env:STAGING_DATABASE_URL = $null
```

### Option B — no psql: the dashboard SQL Editor

The script is deliberately free of psql meta-commands, so it pastes in whole.

1. Supabase dashboard → the **localbasic-staging** project → **SQL Editor**
2. Open `supabase\scripts\staging_verify.sql`, copy all of it, paste, **Run**
3. Read the **Messages / Notices** pane, not the results grid — every check
   reports there

To put it on your clipboard:

```powershell
Get-Content .\supabase\scripts\staging_verify.sql -Raw | Set-Clipboard
```

### What a pass looks like

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

`organizations present = 0` is the expected value on a fresh staging database
and is a useful sanity signal in its own right: anything above zero on a
database you have not seeded means you are not looking at the database you
think you are.

Any `ERROR:` line is a failure. The message names what is wrong. Send it to me
verbatim — particularly check 7, which is the lock that stops two cashiers
taking the same payment twice.

## 7. Send back

* the tail of `supabase db push`
* the output of `supabase migration list`
* the full notice output from step 6

Then stop. Seeding, the Vercel project and any payment or customer test all
wait for your explicit go-ahead.
