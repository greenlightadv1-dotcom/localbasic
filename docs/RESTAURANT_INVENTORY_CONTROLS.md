# Restaurant inventory, custody, cashier hierarchy and reconciliation — architecture

Status: **design, not yet built.** Written against the codebase as of migration 0101.
Every table below follows the repo's existing rules: tenant-scoped by
`organization_id`, RLS enabled **and forced**, no direct table grants to client
roles, all writes through `SECURITY DEFINER` functions with a pinned
`search_path`, a permission check, and an `audit_logs` row. `tests/33` already
fails the build if any of that is skipped.

---

## 0. What exists today, and what this replaces

| Today | Gap | This design |
|---|---|---|
| `restaurant_branch_stock` (0094): one counter per **finished menu item** per branch, decremented on confirm | No ingredients, no recipes, no locations inside a branch, no movement history | Ingredient ledger per **location** (warehouse / kitchen / bar), recipe-driven consumption |
| Retail ledger (0012/0047/0052): append-only `retail_stock_movements`, trigger-maintained `retail_stock_levels`, paired two-leg transfers | Retail only | **Same pattern**, reused for restaurant ingredients |
| Stations (0071/0080): kitchen/bar routing per product | Stations hold no stock | Each station is bound to a stock location; it consumes from it and is accountable for it |
| Roles: owner / manager / cashier / waiter / kitchen / chef / barista; branch scoping via `member_branches` | No cashier tiers, no zones inside a branch, no second approver | Main vs sub-cashier, section/channel scopes, manager step-up approvals |
| `treasury_accounts` / `treasury_transactions`, `payments` | No cashier shift / drawer | Cashier shifts with blind close |
| Order audit trail (0089) | No period close, no variance | Shift and business-day reconciliation, period lock |

The old per-product counter stays for menus that don't use recipes (simple cafés). A
product is either **counted** (0094 behaviour) or **recipe-based**, never both.

---

## 1. Core principle: three ledgers, one truth each

1. **Stock ledger** — every gram that moves, why, by whom, approved by whom.
2. **Money ledger** — existing `invoices` / `payments` / `treasury_transactions`.
3. **Audit log** — existing `audit_logs`, immutable.

Balances are **projections**, maintained only by triggers on the ledger. Nothing
UPDATEs or DELETEs a ledger row; a correction is a new reversing row that points
at the original. This is what makes the system fraud-resistant: there is no way
to make stock "not have happened", only to record, visibly, that it was
corrected and by whom.

---

## 2. Inventory data model

### 2.1 Units

```
inventory_units            -- seeded, global: g, kg, ml, l, piece
  key text pk, dimension text check (dimension in ('mass','volume','count')),
  to_base numeric          -- kg → 1000 (base g); l → 1000 (base ml); piece → 1
```

Every quantity is stored in the item's **base unit** as `numeric(14,3)`. Purchase
and issue screens accept any unit of the same dimension and convert server-side.
Pack sizes ("carton = 24 bottles") live on the item:

```
inventory_item_packs (item_id, name, base_qty numeric(14,3))  -- e.g. 'كرتونة', 24
```

### 2.2 Items (raw ingredients and prepared items)

```
inventory_items
  id, organization_id,
  name, sku null, category_id null,
  base_unit text  -> inventory_units.key,
  kind text check (kind in ('raw','prepared')),   -- prepared = made in-house (sauce batch)
  avg_cost_cents numeric(14,4) not null default 0, -- moving average per base unit
  is_active, created_at, ...
```

### 2.3 Locations — where stock physically is

```
inventory_locations
  id, organization_id, branch_id,
  kind text check (kind in ('warehouse','kitchen','bar','transit','waste')),
  name, station_id null -> restaurant_stations(id),  -- kitchen/bar locations bind to a station
  is_active
  unique (branch_id, kind) where kind in ('transit','waste')   -- one virtual each per branch
```

`transit` and `waste` are **virtual locations**. Stock in transit belongs to no
department until it is received. Waste is a sink with its own balance, so
"how much did we throw away" is a ledger query, not a guess.

### 2.4 The stock ledger

```
inventory_movements                       -- append-only: no UPDATE, no DELETE grant, ever
  id bigserial, organization_id, branch_id,
  item_id, location_id,
  qty numeric(14,3) not null check (qty <> 0),   -- signed, base units
  unit_cost_cents numeric(14,4) not null,        -- cost at the moment of the movement
  reason text not null check (reason in (
     'purchase_receipt',   -- supplier → warehouse
     'issue_out',          -- warehouse → transit
     'issue_in',           -- transit → kitchen/bar   (only on receiver confirmation)
     'return_out','return_in',   -- kitchen/bar → warehouse, same two-step custody
     'consumption',        -- recipe deduction for a sold order line
     'consumption_reversal',
     'production_out','production_in',  -- raw → prepared item (yield)
     'waste',              -- to the waste sink, with a reason code
     'count_adjustment',   -- physical count difference, approved
     'manual_adjustment',  -- approved correction
     'opening_balance')),
  doc_type text, doc_id uuid,          -- the transfer / order line / count / waste record behind it
  reverses_id bigint null -> inventory_movements(id),
  actor_id uuid not null,              -- from the session, never from the client
  approved_by uuid null,               -- the manager who stepped up, when required
  business_day date not null,          -- see §7.1
  created_at timestamptz not null default now()

inventory_levels                          -- projection, written ONLY by the movement trigger
  location_id, item_id, qty numeric(14,3), updated_at,
  primary key (location_id, item_id)
```

Concurrency is the same as retail 0012: the trigger upserts the level row,
which row-locks it for the rest of the transaction, so two simultaneous
movements on the same item and location serialise.

**Negative stock.** Warehouse and transit may never go negative (CHECK). Kitchen
and bar **may**: book stock is a model of reality, and refusing to sell a dish
because the books are off by 20 g would stop service. A negative station
balance is an alert and a variance, not a block. (Decision D2, §10.)

### 2.5 Recipes (bill of materials)

```
recipes
  id, organization_id,
  product_id, variant_id null,           -- per size when sizes differ
  version int not null,                  -- immutable once used
  status text check (status in ('draft','active','retired')),
  yield_qty numeric(14,3) default 1,     -- portions this recipe makes
  approved_by uuid, approved_at,
  unique (variant_id, version)

recipe_lines
  recipe_id, item_id,
  qty numeric(14,3) not null check (qty > 0),   -- base units per yield
  waste_pct numeric(5,2) default 0,             -- trim/evaporation allowance, part of theoretical cost
  station_override_location_id null             -- e.g. garnish comes from the bar even on a kitchen dish

modifier_recipe_lines                    -- "extra cheese" adds, "no onion" removes
  modifier_id, item_id, qty numeric(14,3)   -- signed: negative = removes from the base recipe
```

**Versioning is the anti-tampering control.** Editing a recipe creates a new
draft version. Activating it needs `inventory.recipe.approve` and is audited.
Every consumption movement records `recipe_id`/version, so a "reduce the
cheese on paper, pocket the rest" change is visible as a dated version switch
with a named approver.

Sub-recipes: a `prepared` item (house sauce) has its own recipe. A production
record (`production_out` raw, `production_in` prepared, with the actual yield)
turns raw into prepared. Dishes then consume the prepared item. Yield below
the recipe's expected yield is itself a variance line.

---

## 3. The consumption engine

### 3.1 When stock is deducted

The order line is consumed when it is **sent to its station** (order status
`confirmed`, which already exists in `check_order_transition`), not when it is
paid. That is the moment the ingredients start being used, and it is when a
cashier can no longer quietly delete the line.

```
order line confirmed
   └─ for each recipe line of the line's active recipe version (+ modifier lines):
        qty_base = recipe_line.qty × line.quantity / recipe.yield_qty
        location = station_override_location_id
                   ?? location bound to the line's snapshotted station
        insert inventory_movement(reason='consumption', qty = -qty_base,
                                  doc_type='order_item', doc_id=line.id,
                                  unit_cost = item.avg_cost_cents)
```

It runs in the same transaction as the status change, inside the definer
function, so an order can never be "sent to the kitchen" without its
consumption, and never consumed twice: `unique (doc_type, doc_id, item_id, reason)`
on consumption rows makes a retried request a no-op.

### 3.2 Cancellations and voids

| When | Stock effect | Approval |
|---|---|---|
| Before `confirmed` | nothing was consumed; nothing to reverse | none (cashier) |
| After `confirmed`, **not** prepared | `consumption_reversal`, back to the station | manager step-up |
| After `preparing`/`ready` | **no reversal**; the food exists. Recorded as `waste` with reason `order_cancelled`, linked to the order | manager step-up, mandatory reason |
| After payment | refund through treasury (existing), plus the row above | manager step-up, and the refund appears in the shift report |

This removes the classic fraud of "cancel after serving, keep the cash": the
food still leaves the books, the cancellation needs a second person, and both
show up on the day's report against the cashier.

### 3.3 Availability ("86") from ingredients

When a station's balance of an item drops below what one portion of a dish
needs, the engine can set `restaurant_branch_availability` for the affected
variants. This is optional per branch (D3), because book stock can be wrong.
When on, it uses the same mechanism the kitchen already uses to 86 a dish by
hand, so every guest surface already respects it.

---

## 4. Chain of custody: warehouse → kitchen / bar

### 4.1 The issue document

```
inventory_transfers
  id, organization_id, branch_id, number,           -- e.g. ISS-000123 via document_counters
  from_location_id, to_location_id,
  kind text check (kind in ('issue','return')),
  status text check (status in ('draft','issued','received','disputed','resolved','cancelled')),
  requested_by null, issued_by, issued_at,
  received_by null, received_at,
  resolved_by null, resolved_at, resolution_note

inventory_transfer_lines
  transfer_id, item_id,
  issued_qty numeric(14,3) check (issued_qty > 0),
  received_qty numeric(14,3) null,        -- entered by the receiver, line by line
  discrepancy_reason text null
```

### 4.2 State machine (enforced in the database)

```
            ┌──────── cancel (issuer, before issued) ───────► cancelled
 draft ─────┤
            └─ issue (inventory.issue on FROM location) ─► issued
                   movements: issue_out  from warehouse
                              +qty into transit
                                   │
         receive (inventory.receive on TO location, receiver ≠ issuer)
                                   │
          all received_qty = issued_qty ─────────────► received
                   movements: −qty transit, issue_in +qty into kitchen/bar
                                   │
          any received_qty < issued_qty ─────────────► disputed
                   movements: received part moves in; the SHORT part stays in transit
                                   │
         resolve (manager step-up): "found" → move in
                                    "lost"  → waste, reason transit_loss, charged to the ISSUER side
                                   ▼
                                resolved
```

Rules that make it hold:

- **Two people.** `received_by <> issued_by`, checked in the function. Owner
  included; a one-person shop can turn custody off per branch (D4), which is
  visible in reports.
- **The receiver counts blind.** The receive screen shows item names, not the
  issued quantities. The receiver types what they physically have. This is what
  stops "just tap confirm".
- **Received more than issued** is refused. Surplus is a count adjustment, not
  a transfer.
- **Nothing is consumed from transit.** Until the kitchen confirms, the kitchen
  balance doesn't include it, so the kitchen can't be blamed for stock it never
  accepted, and the warehouse can't claim it delivered what it didn't.
- **Pending issues age.** An `issued` transfer not received within N hours
  (default 2) raises an alert for the manager (§6).
- Returns (kitchen → warehouse) are the same document with `kind='return'` and
  the roles reversed.

### 4.3 Accountability, per department

For any location and period:

```
expected_close = open_count + received_in − issued_out − theoretical_consumption − recorded_waste
variance       = actual_close_count − expected_close
```

A kitchen is accountable only for what it **received and signed for**. The
warehouse is accountable for purchases received minus what the kitchen signed
for. Transit losses land on whoever the manager's resolution names. Every
number traces back to signed documents.

### 4.4 Physical counts

```
inventory_counts (id, location_id, status 'open'|'submitted'|'approved', counted_by, approved_by, business_day)
inventory_count_lines (count_id, item_id, counted_qty, expected_qty_snapshot)
```

- **Blind:** the counter never sees `expected_qty` (it's snapshotted server-side
  when the count opens, and only shown to the approver).
- A line with variance above a threshold (default ±5 % or a cost amount) needs a
  **second count by a different person** before it can be approved.
- Approval (manager step-up) writes one `count_adjustment` movement per
  differing line. That is the variance, recorded and attributed.

### 4.5 Waste (هالك)

```
inventory_waste (id, location_id, item_id null, order_item_id null, qty, reason_code,
                 note, photo_path null, recorded_by, approved_by null, business_day)
reason_code in ('expired','spoiled','dropped','overcooked','returned_by_guest',
                'order_cancelled','transit_loss','staff_meal','other')
```

Recording waste needs `inventory.waste.record`. Above a per-branch value
threshold it needs manager step-up. `other` always needs a note. Staff meals are
waste with their own code, so they're visible and capped rather than hidden.

---

## 5. Roles, cashier hierarchy and step-up approval

### 5.1 New permissions

| Key | Who by default |
|---|---|
| `inventory.read` | manager, inventory officer, chef, barista (own location) |
| `inventory.item.manage`, `inventory.recipe.manage` | manager, inventory officer |
| `inventory.recipe.approve` | manager |
| `inventory.issue` | inventory officer |
| `inventory.receive` | chef (kitchen), barista (bar) — **location-scoped**, see 5.2 |
| `inventory.count` | inventory officer, chef, barista |
| `inventory.count.approve`, `inventory.adjust` | manager |
| `inventory.waste.record` | chef, barista, inventory officer |
| `restaurant.pos.oversee` | main cashier |
| `restaurant.shift.close_any` | main cashier, manager |
| `approval.grant` | manager (who can approve the step-ups in 5.4) |

New system role: **inventory officer** (أمين المخزن). Existing roles get only
the keys above that match their job. All keys go into the permission catalog,
so `scripts/check-permissions.mjs` keeps the TS union and SQL seed in sync.

### 5.2 Scopes: who can act where

Today a member is scoped to branches (`member_branches`). Add two finer scopes:

```
member_locations (member_id, location_id)   -- chef ↔ kitchen location, barista ↔ bar location
member_sections  (member_id, section_id)    -- sub-cashier ↔ floor / zone (restaurant_sections)
member_channels  (member_id, channel)       -- optional: 'cashier','qr','online','delivery'
```

`app.has_location_permission(org, location, perm)` = has the permission **and**
(no location rows for the member, or the location is listed). Same pattern as
`has_branch_permission`.

### 5.3 Main cashier vs sub-cashiers

- **Sub-cashier** (`restaurant.pos.use` + section/channel scopes): opens their
  own shift, sees and settles only orders for their sections or channels, and
  can't see other cashiers' takings.
- **Main cashier** (`restaurant.pos.oversee`): sees every open shift and order
  on every floor live, can take over a table from a sub-cashier (audited
  hand-over), closes sub-cashiers' shifts (`shift.close_any`), and receives cash
  drops. The main cashier can't approve their own sensitive actions; that
  still needs a manager (5.4).
- **Cashier shift:**

```
cashier_shifts (id, branch_id, member_id, opened_at, opening_float_cents,
                closed_at, closed_by, counted_cash_cents, expected_cash_cents, variance_cents,
                status 'open'|'closed'|'reviewed')
cash_drops (shift_id, amount_cents, received_by, at)      -- mid-shift to the main cashier / safe
```

  Every payment row gets `shift_id`. Close is **blind**: the cashier enters
  counted cash per denomination before seeing the expected figure. Variance
  beyond a threshold needs manager review. One open shift per member per branch.

### 5.4 Step-up approval: PIN or passkey

Sensitive actions require a **second, distinct person** who holds
`approval.grant`, proven at the moment of the action.

```
member_approval_credentials (member_id, kind 'pin'|'passkey',
                             pin_hash text,            -- crypt(pin, gen_salt('bf', 10)), never readable
                             webauthn_credential jsonb, -- public key only
                             failed_attempts int, locked_until timestamptz)

approval_grants (id, organization_id, branch_id,
                 action text, payload_hash text,      -- sha256 of the exact action + arguments
                 requested_by, approved_by,
                 expires_at  default now() + interval '2 minutes',
                 consumed_at null)
```

Flow (one round trip each, all inside definer functions):

1. The cashier attempts "cancel order 0123". The server answers
   `approval_required` with the action and a `payload_hash`.
2. The manager types their PIN on the same device (a PIN pad modal), **or**
   approves from their own phone (a request pushed in realtime, confirmed by
   passkey: Face ID / fingerprint through WebAuthn).
3. `approval_grant(action, payload_hash, pin)` checks the PIN, the
   `approval.grant` permission, and `approver ≠ requester`. It returns a
   single-use grant id. Five failed PINs lock the credential for 15 minutes,
   using the existing DB limiter (0100).
4. The sensitive function takes the grant id, re-computes the payload hash from
   its own arguments, and consumes the grant in the same transaction
   (`consumed_at is null and expires_at > now() and payload_hash = …`). A grant
   for "cancel order 0123" can't be reused for 0124, or for a bigger refund.
5. Both people are written to the audit row and to the ledger row's
   `approved_by`.

Biometrics never leave the device. WebAuthn gives the server a signature, so
"biometric" means "a passkey on the manager's phone". There's no fingerprint
database to protect.

**Actions behind step-up** (per-branch thresholds where it makes sense):
cancelling or voiding after `confirmed`; a discount above X %; refunds;
reopening a paid order; waste above value Y; any manual stock adjustment;
approving a count with variance; activating a recipe version; changing a menu
price; accepting a shift close with variance; a cash payout from the drawer;
resolving a disputed transfer.

---

## 6. Low-stock alarms

### 6.1 Thresholds

```
inventory_par_levels (location_id, item_id,
                      min_qty,          -- station: alarm before running out mid-service
                      reorder_qty,      -- warehouse: time to buy
                      par_qty)          -- target after restock
```

### 6.2 Detection, in the same trigger that maintains levels

After the level row updates, crossing **downward** through `min_qty` /
`reorder_qty` opens an alert. One open alert per (location, item, kind), so a
busy night doesn't produce a thousand rows:

```
inventory_alerts (id, location_id, item_id,
                  kind 'station_low'|'station_out'|'warehouse_reorder'|'transfer_unreceived'|'negative_balance',
                  opened_at, qty_at_open, acknowledged_by null, resolved_at null)
```

It resolves itself when stock goes back above the threshold (for example, the
kitchen receives an issue).

**Run-out forecast** (cheap, on the same trigger): average consumption of the
item at that location over the last 7 same-weekday service windows gives
"≈ 1.5 hours of stock left at current pace". That's what lets the kitchen ask
before it runs out, not after.

### 6.3 Delivery

- **Kitchen / bar display:** a realtime broadcast on
  `inventory-alerts:<location_id>` (the same broadcast mechanism order status
  uses), shown as a banner with a sound. One tap sends a "request issue" to the
  warehouse, a draft transfer pre-filled to `par_qty − on_hand − in_transit`.
- **Inventory module:** a reorder list. For warehouse alerts it shows
  suggested quantities and can create a draft purchase order (reusing the
  retail purchasing flow where possible).
- **Manager:** the existing `notifications` table and worker (0004, delivered by `/api/worker/notifications`) → WhatsApp / email for
  `station_out`, `negative_balance` and `transfer_unreceived`.

---

## 7. Shift and end-of-day reconciliation

### 7.1 Business day and period lock

A branch setting `day_cutoff` (default 04:00 local) defines `business_day`,
stamped on every ledger, payment and waste row. **Day close** (manager step-up):

1. requires all cashier shifts closed and every `issued` transfer received or
   disputed;
2. (optional, D5) requires end-of-day counts for "key items" at kitchen and bar;
3. generates the report snapshot below, stores it with a sha256 of its content,
   and **locks the day**. After that, no movement, payment or waste can carry
   that `business_day`. Corrections go into the next open day as adjustments,
   with a note pointing back.

### 7.2 The report (shift version = same sections, filtered to one shift)

**A. Sales**
- Gross, discounts, net by channel (cashier / QR / online / delivery), by section, by cashier.
- Payment methods; cash expected vs counted per shift; drops; variances.
- Voids, cancellations, refunds, re-opened orders: each with the requester and approver.

**B. Theoretical cost of what was sold**
- Σ over sold lines: recipe quantity × `avg_cost` → theoretical COGS.
- Theoretical food cost % = theoretical COGS / net food sales (same for the bar).
- Top items by contribution margin.

**C. Stock movement per location**

| Item | Open | +In (signed) | −Out | −Consumed (theory) | −Waste | = Expected | Counted | **Variance** | Variance cost |
|---|---|---|---|---|---|---|---|---|---|

  Rows sorted by variance cost. That's the list a manager reads first.

**D. Waste:** by reason, by person, by station, with value. Staff meals against their cap.

**E. Custody:** issues made / received / disputed, transit losses and who they were charged to.

**F. Actual vs theoretical:** actual COGS = opening value + purchases −
closing value. The gap between actual and theoretical food cost % is the single
best "is something wrong" number. The report flags it when it's above the
branch's tolerance (for example, 2 points).

**G. Control exceptions:** approvals granted (by whom, for whom, how many),
failed PIN attempts, counts with a second count, recipe versions activated,
negative balances, unreceived transfers.

The report is a read-only definer function over the ledgers (like
`restaurant_staff_performance` in 0089), so it can never disagree with the data.
It's rendered as a printable page and a CSV export.

---

## 8. Fraud scenarios and the control that stops each

| Scenario | Control |
|---|---|
| Kitchen says it received less than it did, and keeps the difference | Blind per-line receipt; the short part stays in transit and becomes a dispute a manager must resolve; kitchen variance then shows it |
| Warehouse "issues" stock that never leaves | Kitchen balance only rises when the kitchen signs; the unreceived issue alarms |
| Cancel after serving, pocket the cash | Cancel after `confirmed` needs a manager; food still leaves the books as waste; it appears under the cashier on the day report |
| Manager approves their own action | `approver ≠ requester`, enforced in the database |
| PIN shared or shoulder-surfed | Lockout after 5 tries; every approval names the approver; passkey on the manager's own phone as the stronger option; the report counts approvals per manager |
| Inflate waste to hide theft | Reason codes, threshold approval, optional photo, waste by person in reports; a waste spike shows against the theoretical-vs-actual gap |
| Shrink a recipe on paper | Versioned recipes, activation needs approval, consumption records the version used |
| Tweak a count to hide a shortage | Blind counts; a second counter above the threshold; the approver sees expected vs counted |
| Back-date or delete a movement | Append-only ledger; no UPDATE/DELETE grants; locked business days; corrections are visible reversing rows |
| Ring an order on another cashier's shift | Payments carry `shift_id` from the session; sub-cashiers are confined to their sections or channels |
| Sell items "off-system" | Theoretical-vs-actual food cost gap and per-item variance expose it within a day |

---

## 9. Frontend

All screens are Arabic, RTL and touch-first, built from the existing component set.

| Screen | Who | Notes |
|---|---|---|
| Warehouse stock & issue | inventory officer | Stock by item; "issue to kitchen/bar" builder; alert list with one-click draft issue |
| Station inbox (kitchen/bar tablet) | chef, barista | Incoming issues to receive; blind quantity entry with a big numeric keypad; dispute per line; low-stock banner with "request" button |
| Recipes | manager, officer | Per variant; ingredient picker with unit conversion; live theoretical cost and food-cost %; draft → approve |
| Counts | officer, chef, barista | Blind count sheet; second-count queue |
| Waste | chef, barista, officer | Reason picker, quantity, optional photo; approval prompt above threshold |
| PIN pad / approvals | manager | Modal PIN pad on any POS device; approvals queue on the manager's phone with passkey confirm |
| Cashier shift | every cashier | Open with float; blind close by denomination |
| Main cashier board | main cashier | Live shifts and floors, hand-over, cash drops, close sub-shifts |
| Reconciliation | manager, owner | Shift and day reports, variance drill-down to the signed documents, day close |

---

## 10. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| D1 | Deduct ingredients when the order is sent to the station, or when paid? | **Sent to station** (`confirmed`): that's when food is used, and when cancellation becomes controlled |
| D2 | Block selling when book stock at the station is short? | **No:** alert and record the variance. Blocking service on book errors costs more than it saves |
| D3 | Auto-86 dishes when an ingredient hits zero? | Off by default, on per branch once recipes are trusted |
| D4 | Allow one-person custody for very small branches? | Allowed per branch, but flagged on every report |
| D5 | Require end-of-day counts? | Key items only (top ~15 by value) daily; full count weekly |
| D6 | PIN or passkey for approvals? | **PIN first** (works on shared tablets today); passkey on the manager's phone in phase 3 |
| D7 | Business-day cutoff | 04:00 |

---

## 11. Build plan

Each phase ships with migrations, SQL tests (positive, negative and cross-tenant,
following `tests/30`–`34`) and the invariant test kept green.

1. **Ledger & recipes:** units, items, locations, movements, levels, recipes,
   consumption on `confirmed`, reversal and cancel rules, recipe screen. Migrates
   0094 counted products untouched.
2. **Custody & counts & waste:** transfers with the state machine, station
   inbox, blind counts, waste, step-up approvals with PIN, the new permissions
   and scopes.
3. **Alarms & cashier hierarchy:** par levels, alerts and realtime banners,
   forecast, cashier shifts, sub-cashier scopes, main cashier board, passkey
   approvals.
4. **Reconciliation:** business day, shift and day reports, period lock,
   exports.

Phase 1 is a prerequisite for everything else. Phases 2 and 3 are independent of
each other.
