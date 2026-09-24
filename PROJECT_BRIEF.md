# LOCAL BASIC — Project Brief

## What this is
A production multi-tenant Arabic/RTL SaaS for restaurants and retail. Next.js 14 (App Router) + Supabase/PostgreSQL, with RLS + FORCE RLS, RBAC, tenant isolation and audit logs enforced in the database — the server is the security boundary, the UI only reflects it.

## What shipped: the Site Engine (V1, complete)
A website builder tenants use to publish their own site, built across six additive migrations (`0055`–`0060`):

- **Sites, pages, sections** with identity integrity — a site can't be re-parented to another org, and its creator can't be reassigned.
- **Exactly-one-homepage invariant**, held by a deferrable constraint trigger.
- **Data-bound sections** — a section declares *what* live data to show (e.g. the menu); it never copies business data into its own content. The resolver is org-scoped server-side, so a malicious payload can't redirect it to another tenant.
- **Page-aware renderer** kept deliberately free of Next.js coupling.
- **Publishing & revisions** — an append-only ledger (enforced by absent grants plus an immutability trigger), with rollback.
- **Form-based editor UI** plus an appearance editor, and **menu import** from Excel/CSV/Google Sheets (custom XLSX reader that never evaluates formulas or macros; SSRF-guarded fetching).

## State as of this session
The editor now runs end-to-end in a real browser locally and is ready for manual verification at `/{org}/{branch}/settings/sites`. One genuine bug was found and fixed while driving it: the local dev adapter returned `Date` objects where Supabase returns ISO strings, causing a React hydration mismatch. Fixed at the adapter, matching the precedent already there for `int8`/`numeric`.

**Verification:** 680 unit tests, 33 SQL suites, and the Site Engine e2e all pass. The full Playwright suite runs 180–181/182 — the rotating failures are pre-existing flakiness in restaurant/retail order flows, confirmed by running the baseline without my changes.

## Explicitly out of scope
Gallery, multi-template system, custom domains for sites, SEO, analytics, private Google Sheets OAuth, revision preview, new public hosting. Production data and the hosted project are never touched.

## Known open item
`menu/import/actions.ts` lines ~157 and ~188 have an unhandled `JSON.parse` — malformed input returns a 500 instead of the friendly error handled on the very next line. Small, isolated, not yet applied.
