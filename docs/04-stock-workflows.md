# 04 — Stock Transaction Engine (STORES + LUBRICANT + BATTERY)

> **Scope (Phase 2):** End-to-end transaction workflows for domains **(A) STORES/material**, **(B) OIL/LUBRICANT**, **(C) BATTERY (serial-tracked)**. Job-card material consumption (`tx_job_material_req`, `tx_job_parts`) and job costing are covered in the workshop/costing sections — this document ends at the point stock leaves stores (issue) and appends the ledger.
>
> **Contract binding:** All table names, column conventions (`*_id`/`*_no`/`*_qty`/`*_rate`/`*_amt`/`*_cost`, audit + `site_id`), numbering (`TYPE-SITE-YY-NNNNNN`), status vocabularies (`DOC`, `GRN`, `PRICE`, `MVDIR`, `BATTERY`), shared masters (`md_item`, `md_asset`, `md_battery`, `md_location`, `md_price_history`), the ledger (`mv_stock_ledger`), balance (`inv_stock_balance`), pending-price queue (`inv_pending_price`), history (`hist_battery_event`) and **MWAC** valuation are as defined in `00-design-contract.md §1–§7`. This document does **not** restate them; it applies them.

---

## 0. Engine Invariants (apply to EVERY process below)

| # | Invariant | Enforced by |
|---|-----------|-------------|
| I1 | Every stock-affecting line writes **exactly one** `mv_stock_ledger` row (transfer = two rows) in the same DB transaction as the balance update. | Contract §7.1, §7.3 |
| I2 | `inv_stock_balance(item_id, location_id)` `on_hand_qty` + `moving_avg_cost` update atomically with the ledger append. | Contract §7.1 |
| I3 | No `OUT`/`XFER_OUT`/`RET_OUT` when `available_qty < requested_qty` **unless** `override_by` + `override_reason` captured on the line. | Contract §7.2 |
| I4 | Priced receipt recomputes MWAC: `new_avg = (on_hand_qty × old_avg + received_qty × unit_price) / (on_hand_qty + received_qty)`. | Contract §6 |
| I5 | Un-priced receipt → stock IN at **last known / provisional** price, line queued in `inv_pending_price`, `price_status = PROVISIONAL`. | Contract §6 |
| I6 | Battery movement → append `hist_battery_event` + update `md_battery.current_asset_id` & `battery_status` same transaction. | Contract §7.4 |
| I7 | Lubricant issue requires `asset_id` **or** (`site_id` + `department_id`) **and** `meter_reading`. | Contract §7.5 |
| I8 | Costing reads price **as-of transaction date** via `md_price_history`. | Contract §6, §7.6 |
| I9 | No physical deletes — reverse/void document only; `mv_*` and `hist_*` are append-only. | Contract §1.4 |

**Ledger row anatomy (referenced throughout):** `mv_stock_ledger(ledger_id, movement_date, item_id, location_id, mv_direction[MVDIR], qty, unit_cost, value_amt, source_doc_type, source_doc_id, source_line_id, asset_id?, battery_id?, running_balance_qty, running_avg_cost, created_by, created_at)`.

**Signed-quantity convention used in all matrices:** `IN`, `XFER_IN`, `ADJ_IN`, `RET_IN` = **+qty**; `OUT`, `XFER_OUT`, `ADJ_OUT`, `RET_OUT` = **−qty**. `running_balance_qty` = balance AFTER the movement.

---

# PART A — STORES / MATERIAL PROCESSES

## A1. MRN → Receipt → Stock (Indent to On-Hand)

*Internal indent that is fulfilled from existing on-hand stock at a store (no purchase). Requesting site raises an MRN; issuing store fulfils via an issue against the MRN.*

### Step Table

| Step | Actor / Role | Action | System effect | Stock-ledger effect (table + mv_direction) | Status transition |
|------|--------------|--------|---------------|--------------------------------------------|-------------------|
| 1 | Site Requestor / User | Raise `tx_mrn` header + `txl_mrn` lines (`item_id`, `required_qty`, `need_by_date`, `location_id`=requesting site). | Numbering `MRN-<SITE>-YY-NNNNNN` from `sys_number_series`; header persisted. | none | `DRAFT` |
| 2 | Site Requestor | Submit for approval. | `apr_request` opened on workflow `MRN_APPROVAL`. | none | `DRAFT → SUBMITTED` |
| 3 | Stores Officer / Storekeeper | Review need vs on-hand at issuing store (`inv_stock_balance`). | Availability read; reservation optional via `inv_reservation`. | none | `SUBMITTED → APPROVED` |
| 4 | Storekeeper | Create `tx_issue` (`issue_type = MRN_FULFIL`) referencing `mrn_id`; enter `issue_qty` per line. | Availability check I3; if short → override capture. | none yet (draft issue) | Issue `DRAFT` |
| 5 | Storekeeper | **Post issue** — goods leave issuing store to requesting location. | `inv_stock_balance` at source **−issue_qty**; MRN line `fulfilled_qty` incremented. | `mv_stock_ledger` **OUT** (−qty) at issuing store, `unit_cost = moving_avg_cost` | Issue `DRAFT → POSTED`; MRN `APPROVED → POSTED` (or `PARTIAL`) |
| 6 | System | If `sum(fulfilled_qty) = required_qty` all lines → close MRN. | MRN closed; residual lines may spawn a PO (see A2). | none | MRN `POSTED → CLOSED` |

> **Note:** MRN itself never posts a ledger row — it is a demand document. The **issue** posted against it moves stock. An MRN not fulfillable from stock is converted to a `tx_po` (LOCAL) — see A2.

### Status Flow Map

```
tx_mrn (DOC):     DRAFT → SUBMITTED → APPROVED → POSTED → CLOSED
                              │            │        │
                              └─REJECTED   └─PARTIAL └─(residual → tx_po LOCAL)
                                           (some lines short)
tx_issue (DOC):   DRAFT → POSTED            [ISS mv_direction = OUT]
```

---

## A2. Local Purchase → PO → GRN → Pricing (price received date) → Issue

*The core buy-to-consume cycle for locally procured stores/spares/lubricant. Demonstrates provisional vs confirmed pricing and the MWAC recompute.*

### Step Table

| Step | Actor / Role | Action | System effect | Stock-ledger effect (table + mv_direction) | Status transition |
|------|--------------|--------|---------------|--------------------------------------------|-------------------|
| 1 | Procurement Officer | Create `tx_po` (`po_type = LOCAL`, `supplier_id` of `supplier_type=LOCAL`) from approved MRN residual or ad-hoc. | `PO-<SITE>-YY-NNNNNN`; `txl_po` lines carry `ordered_qty`, `agreed_rate` (may be blank → price-on-receipt). | none | PO `DRAFT` |
| 2 | Procurement Manager | Approve PO. | `apr_request` on `PO_APPROVAL`; PO printable/emailable. | none | `DRAFT → SUBMITTED → APPROVED` |
| 3 | Storekeeper | Goods arrive; create `tx_grn` referencing `po_id`; enter `received_qty` per line, supplier DO/invoice no, **`price_received_date`** (date price/invoice is available). | `GRN-<SITE>-YY-NNNNNN`; lines match PO lines; short/over flagged. | none yet | GRN `DRAFT → RECEIVED` |
| 4 | QC Inspector (if `is_qc_required`) | Inspect; pass/fail per line. | QC result on line; failed qty routed to return (A7). | none (failed qty not stocked) | `RECEIVED → QC_PENDING → QC_PASSED` (or `QC_FAILED`) |
| 5a | System (price **known** on GRN) | `unit_price` present → **priced receipt**. | `inv_stock_balance` **+received_qty**; MWAC recompute (I4); write `md_price_history` (`effective_date = price_received_date`), `price_status = CONFIRMED`. | `mv_stock_ledger` **IN** (+qty), `unit_cost = unit_price` | `QC_PASSED → PRICED → POSTED` |
| 5b | System (price **unknown** on GRN) | Receive at last-known/provisional cost. | Stock **+received_qty** at provisional cost; line inserted into `inv_pending_price`; `price_status = PROVISIONAL`. | `mv_stock_ledger` **IN** (+qty), `unit_cost = provisional_cost` | `QC_PASSED → POSTED` (price pending) |
| 6 | Accounts / Pricing Clerk | Later enter confirmed invoice price against `inv_pending_price` row (with `price_received_date`). | `md_price_history` written; **revaluation movement** posted for the price delta; balance `moving_avg_cost` corrected; dependent job costs flagged for recompute (I5). | `mv_stock_ledger` **ADJ_IN/ADJ_OUT** (0 qty, value-only revaluation row) | `price_status PROVISIONAL → CONFIRMED`; queue row cleared |
| 7 | Storekeeper | Issue stock to consumer via `tx_issue` (`issue_type = STORE_ISSUE`) — to asset/job/site. | Availability I3; balance **−issue_qty** at `moving_avg_cost`. | `mv_stock_ledger` **OUT** (−qty), `unit_cost = current moving_avg_cost` | Issue `DRAFT → POSTED` |

### Status Flow Map

```
tx_po (DOC):    DRAFT → SUBMITTED → APPROVED → POSTED → CLOSED
                            └─REJECTED           (fully received)

tx_grn (GRN):   DRAFT → RECEIVED → QC_PENDING → QC_PASSED → PRICED → POSTED
                                        └─QC_FAILED→(RET)   │
                                                            └─(no price)→POSTED (PROVISIONAL)
price (PRICE):  PENDING → PROVISIONAL → CONFIRMED
                              └────── REVISED ──────┘   (revaluation mv row)

tx_issue (DOC): DRAFT → POSTED            [ISS mv_direction = OUT]
```

---

## A3. Head-Office Purchase → Receipt → Stock (Inter-company / HO-Supplied)

*Goods procured centrally by Head Office and pushed to a site store. Price is carried from HO (transfer/inter-company price), so receipt is typically priced on arrival; PO is HO-issued.*

### Step Table

| Step | Actor / Role | Action | System effect | Stock-ledger effect (table + mv_direction) | Status transition |
|------|--------------|--------|---------------|--------------------------------------------|-------------------|
| 1 | HO Procurement | Create `tx_po` (`po_type = HEAD_OFFICE`, `supplier_id` of `supplier_type=HEAD_OFFICE`, `SITE=HO0`). | `PO-HO0-YY-NNNNNN`; HO-supplied flag on lines. | none | PO `DRAFT → APPROVED` |
| 2 | HO Stores | Dispatch to site with HO invoice / inter-company note carrying `unit_price`. | Dispatch reference recorded on PO line. | none | PO `APPROVED → POSTED (in-transit)` |
| 3 | Site Storekeeper | Create `tx_grn` at receiving site referencing HO `po_id`; enter `received_qty`, HO invoice no, `price_received_date`. | `GRN-<SITE>-YY-NNNNNN`; HO price defaults into `unit_price`. | none yet | GRN `DRAFT → RECEIVED` |
| 4 | QC (optional) | Inspect. | Pass/fail per line. | none | `RECEIVED → QC_PASSED` |
| 5 | System | HO price present → priced receipt. | Balance **+received_qty**; MWAC recompute (I4); `md_price_history` (`effective_date = price_received_date`, source=HO), `price_status = CONFIRMED`. | `mv_stock_ledger` **IN** (+qty), `unit_cost = HO unit_price`, `source_doc_type=GRN` | `QC_PASSED → PRICED → POSTED` |
| 6 | System (edge: HO price absent) | Provisional path as A2 step 5b. | `inv_pending_price` row; provisional cost. | `mv_stock_ledger` **IN** (+qty) provisional | `POSTED` (price pending) |

> **Traceability:** HO-supplied lines carry `supplier_type = HEAD_OFFICE` on `mv_stock_ledger.source_doc_id → tx_grn → tx_po(HEAD_OFFICE)`, so the inter-company origin of any on-hand unit is provable from the ledger back to the HO PO.

### Status Flow Map

```
tx_po(HEAD_OFFICE): DRAFT → APPROVED → POSTED(in-transit) → CLOSED
tx_grn (GRN):       DRAFT → RECEIVED → QC_PASSED → PRICED → POSTED
                                                     └─(no HO price)→POSTED(PROVISIONAL)
```

---

## A4. General Item Receipt & General Item Issue

*Low-value / non-critical `item_type = GENERAL` or `CONSUMABLE` items (rags, cleaning fluid, stationery for workshop). Same ledger discipline, lighter approval, no QC.*

### A4a. General Item Receipt — Step Table

| Step | Actor / Role | Action | System effect | Stock-ledger effect (table + mv_direction) | Status transition |
|------|--------------|--------|---------------|--------------------------------------------|-------------------|
| 1 | Storekeeper | Create `tx_grn` (`grn_type = GENERAL`, may be **PO-less** — direct receipt against a cash/petty purchase). | `GRN-<SITE>-YY-NNNNNN`; lines `item_type ∈ {GENERAL, CONSUMABLE}`. | none | `DRAFT → RECEIVED` |
| 2 | Storekeeper | Enter `unit_price` (cash bill). | Priced receipt. | `mv_stock_ledger` **IN** (+qty), `unit_cost = unit_price`; MWAC recompute; `md_price_history` written. | `RECEIVED → PRICED → POSTED` |

### A4b. General Item Issue — Step Table

| Step | Actor / Role | Action | System effect | Stock-ledger effect (table + mv_direction) | Status transition |
|------|--------------|--------|---------------|--------------------------------------------|-------------------|
| 1 | Storekeeper | Create `tx_issue` (`issue_type = GENERAL`); enter cost dimension (`department_id`/`cost_center_id`, optional `asset_id`). | Availability check I3. | none yet | Issue `DRAFT` |
| 2 | Storekeeper | Post issue. | Balance **−issue_qty** at `moving_avg_cost`. | `mv_stock_ledger` **OUT** (−qty). | `DRAFT → POSTED` |

### Status Flow Map

```
GRN (GRN):   DRAFT → RECEIVED → PRICED → POSTED        [mv IN]
ISSUE (DOC): DRAFT → POSTED                            [mv OUT]
```

---

## A5. Material Transfer Between Locations (`tx_transfer`)

*Store-to-store / site-to-site movement. MUST produce two ledger rows: `XFER_OUT` at source and `XFER_IN` at destination (Contract §7.3). Cost is carried at source MWAC so no valuation is created or destroyed.*

### Step Table

| Step | Actor / Role | Action | System effect | Stock-ledger effect (table + mv_direction) | Status transition |
|------|--------------|--------|---------------|--------------------------------------------|-------------------|
| 1 | Source Storekeeper | Create `tx_transfer` (`from_location_id`, `to_location_id`); `txl_transfer` lines `transfer_qty`. | `TRF-<SITE>-YY-NNNNNN`. Availability I3 at source. | none | `DRAFT` |
| 2 | Stores Manager | Approve transfer. | `apr_request` on `TRANSFER_APPROVAL`. | none | `DRAFT → SUBMITTED → APPROVED` |
| 3 | Source Storekeeper | **Dispatch** — post OUT leg. | Source balance **−transfer_qty**; `transfer_cost = source moving_avg_cost` frozen onto line for the IN leg. | `mv_stock_ledger` **XFER_OUT** (−qty) at `from_location_id`, `unit_cost = source MWAC` | `APPROVED → POSTED (in-transit)` |
| 4 | Destination Storekeeper | **Receive** — post IN leg (confirm `received_qty`; short = A-exception). | Destination balance **+received_qty**; destination MWAC recompute using `transfer_cost` (I4). | `mv_stock_ledger` **XFER_IN** (+qty) at `to_location_id`, `unit_cost = transfer_cost` | `POSTED(in-transit) → CLOSED` |
| 5 | System | Reconcile OUT qty vs IN qty. | If mismatch → transit variance to `tx_adjustment` (A6) with reason `TRANSIT_LOSS`. | (adjustment path) | — |

> **Both legs share the same `transfer_id`**; `mv_stock_ledger` rows link via `source_doc_type=TRF, source_doc_id=transfer_id`. Net enterprise stock unchanged; net value unchanged (cost carried).

### Status Flow Map

```
tx_transfer (DOC): DRAFT → SUBMITTED → APPROVED → POSTED(in-transit) → CLOSED
                               └─REJECTED                    │
                                                 (short receipt → tx_adjustment TRANSIT_LOSS)

Ledger (paired):   [XFER_OUT −qty @source]  ═══ transit ═══►  [XFER_IN +qty @dest]
```

---

## A6. Stock Adjustment / Physical Count (`tx_adjustment`)

*Reconcile system on-hand to physically counted quantity. Positive count variance = `ADJ_IN`; negative = `ADJ_OUT`. Value impact at current MWAC (write-up/write-down).*

### Step Table

| Step | Actor / Role | Action | System effect | Stock-ledger effect (table + mv_direction) | Status transition |
|------|--------------|--------|---------------|--------------------------------------------|-------------------|
| 1 | Stores Officer | Freeze count; system snapshots `system_qty` from `inv_stock_balance` per `item_id × location_id`. | Count sheet generated. | none | `DRAFT` |
| 2 | Counter / Storekeeper | Enter `counted_qty`; system computes `variance_qty = counted − system`. | Variance per line; `adjustment_reason` mandatory (`COUNT`, `DAMAGE`, `SHRINKAGE`, `TRANSIT_LOSS`, `FOUND`). | none | `DRAFT` |
| 3 | Stores Manager / Controller | Approve adjustment (higher threshold if `abs(variance_amt) > limit`). | `apr_request` on `ADJUSTMENT_APPROVAL`. | none | `DRAFT → SUBMITTED → APPROVED` |
| 4 | System | Post positive variances. | Balance **+variance_qty**; MWAC unchanged (in at current avg) or per policy. | `mv_stock_ledger` **ADJ_IN** (+qty), `unit_cost = moving_avg_cost` | `APPROVED → POSTED` |
| 5 | System | Post negative variances. | Balance **−variance_qty**; write-down value at MWAC. | `mv_stock_ledger` **ADJ_OUT** (−qty), `unit_cost = moving_avg_cost` | `APPROVED → POSTED` |
| 6 | System | Close. | `inv_stock_balance` now equals counted. | none | `POSTED → CLOSED` |

### Status Flow Map

```
tx_adjustment (DOC): DRAFT → SUBMITTED → APPROVED → POSTED → CLOSED
                                └─REJECTED
Ledger:  +variance → ADJ_IN (+qty)   |   −variance → ADJ_OUT (−qty)
```

---

## A7. Return (to Supplier / Return to Store)

*Two flavours share `tx_return`: (a) **RET_OUT to supplier** — rejected/defective GRN qty or over-supply sent back; (b) **RET_IN to store** — unused issued material returned by asset/job/site.*

### A7a. Return to Supplier — Step Table

| Step | Actor / Role | Action | System effect | Stock-ledger effect (table + mv_direction) | Status transition |
|------|--------------|--------|---------------|--------------------------------------------|-------------------|
| 1 | Storekeeper | Create `tx_return` (`return_type = SUPPLIER`) referencing `grn_id`; lines `return_qty`, reason (`DEFECTIVE`, `SHORT_SPEC`, `OVER_SUPPLY`). | `RET-<SITE>-YY-NNNNNN`; return qty ≤ received qty (validation). | none | `DRAFT` |
| 2 | Stores Manager | Approve. | `apr_request` on `RETURN_APPROVAL`. | none | `DRAFT → SUBMITTED → APPROVED` |
| 3 | Storekeeper | Post — goods physically leave store to supplier. | Balance **−return_qty** at `moving_avg_cost`; debit note reference to supplier. | `mv_stock_ledger` **RET_OUT** (−qty), `unit_cost = MWAC`, `source_doc_type=RET` | `APPROVED → POSTED → CLOSED` |

### A7b. Return to Store (unused issue back) — Step Table

| Step | Actor / Role | Action | System effect | Stock-ledger effect (table + mv_direction) | Status transition |
|------|--------------|--------|---------------|--------------------------------------------|-------------------|
| 1 | Site User / Technician | Create `tx_return` (`return_type = STORE_BACK`) referencing original `issue_id`; `return_qty`. | Return qty ≤ issued qty (validation). | none | `DRAFT` |
| 2 | Storekeeper | Verify condition; accept. | Optional QC for reusability. | none | `DRAFT → SUBMITTED → APPROVED` |
| 3 | System | Post — goods back on-hand. | Balance **+return_qty**; returned at original issue cost (MWAC as-of issue) to avoid value distortion. | `mv_stock_ledger` **RET_IN** (+qty), `unit_cost = original issue cost` | `APPROVED → POSTED → CLOSED` |

### Status Flow Map

```
tx_return (DOC): DRAFT → SUBMITTED → APPROVED → POSTED → CLOSED
                             └─REJECTED
SUPPLIER → RET_OUT (−qty)      |     STORE_BACK → RET_IN (+qty)
```

---

# PART B — LUBRICANT PROCESSES

## B1. Lubricant Issue by Vehicle / Machine / Site / Project (with Meter Reading)

*`tx_lube_issue` (`LUB`). A lubricant is a `md_item` with `item_type = LUBRICANT`. Every issue is a stock `OUT` but MUST carry consumption traceability: target asset (or site+department), meter reading, project. Enables L/100km and L/hour consumption analytics from `mv_stock_ledger` filtered `item_type=LUBRICANT`.*

### Step Table

| Step | Actor / Role | Action | System effect | Stock-ledger effect (table + mv_direction) | Status transition |
|------|--------------|--------|---------------|--------------------------------------------|-------------------|
| 1 | Storekeeper / Fuel-Oil Clerk | Create `tx_lube_issue`; select `item_id` (LUBRICANT), `issue_qty`, UoM (litres). | `LUB-<SITE>-YY-NNNNNN`. UoM validity check (must be volume UoM of the item). | none | `DRAFT` |
| 2 | Clerk | Enter **target**: `asset_id` (VEHICLE/MACHINE) **or** `site_id + department_id`; **mandatory `meter_reading`** (odometer km / hour-meter); `project_id` optional. | I7 enforced — save blocked without asset-or-site AND meter. Meter monotonic check vs last reading for that asset. | none | `DRAFT` |
| 3 | Storekeeper | Availability check. | I3; if short → override capture. | none | `DRAFT` |
| 4 | Supervisor (if `issue_qty > threshold`) | Approve high-volume issue. | `apr_request` on `LUBE_ISSUE_APPROVAL` (conditional). | none | `DRAFT → SUBMITTED → APPROVED` |
| 5 | System | **Post issue.** | Balance **−issue_qty** at lubricant `moving_avg_cost`; meter reading stored for consumption calc; `md_asset` last-meter updated. | `mv_stock_ledger` **OUT** (−qty), `unit_cost = MWAC`, `asset_id` set, `source_doc_type=LUB` | `APPROVED → POSTED` |
| 6 | System | Consumption derivation (analytics). | Δmeter since previous lube issue for same asset → L/100km (vehicle) or L/hr (machine) written to consumption view. | reads ledger | `POSTED` |

### B1 Status Flow Map

```
tx_lube_issue (DOC): DRAFT → [SUBMITTED → APPROVED] → POSTED
                        │        (conditional on volume)
                        └── save blocked unless (asset_id OR site+dept) AND meter_reading present
Ledger:  LUB → OUT (−qty), asset_id + meter carried for traceability
```

## B2. Monthly Lubricant Stock Balance Close (`inv_lube_monthly_balance`)

*Period-end snapshot per lubricant item × store. Freezes opening/receipts/issues/closing and cross-checks against `mv_stock_ledger`.*

### Step Table

| Step | Actor / Role | Action | System effect | Stock-ledger effect | Status transition |
|------|--------------|--------|---------------|---------------------|-------------------|
| 1 | Oil Clerk | Trigger month-end close for `period_yyyymm`, `location_id`. | Guard: no un-posted `tx_grn`/`tx_lube_issue` for the period (else block). | reads ledger | `OPEN` |
| 2 | System | Compute per `item_id`: `opening_qty` (prior close), `receipt_qty` (Σ IN in period), `issue_qty` (Σ OUT in period), `adjust_qty` (Σ ADJ), `closing_qty`. | Snapshot rows written to `inv_lube_monthly_balance`. | reads ledger (no new movement) | `OPEN → COMPUTED` |
| 3 | Oil Clerk | Reconcile `closing_qty` vs physical dip/measurement; variance → `tx_adjustment` (A6). | Variance ledgered via ADJ, not via this snapshot. | (via A6) `ADJ_IN/OUT` | `COMPUTED` |
| 4 | Stores Manager | Approve & lock period. | Period locked; back-dated postings into locked period blocked. | none | `COMPUTED → CLOSED` |
| 5 | System | Roll `closing_qty` → next period `opening_qty`. | Next period seeded. | none | `CLOSED` |

### B2 Status Flow Map

```
inv_lube_monthly_balance: OPEN → COMPUTED → CLOSED → (rolls to next period OPEN)
                                     └─ variance → tx_adjustment (ADJ_IN/ADJ_OUT)
```

---

# PART C — BATTERY PROCESSES (SERIAL-CONTROLLED)

> **Battery model = `md_item` (`item_type=BATTERY`, `is_serial_tracked=1`). Each physical unit = one `md_battery` row (unique `battery_serial_no`).** Batteries are valued at their own acquisition cost on `md_battery.acquisition_cost` (Contract §6), **not** blended into MWAC. **Every** battery movement appends `hist_battery_event` and updates `md_battery.current_asset_id` + `battery_status` in the same transaction (I6). `hist_battery_event` preserves the full lifecycle so **original asset** and **current asset** are always recoverable.

**`hist_battery_event` row anatomy (referenced below):** `(event_id, battery_id, event_type, event_date, from_asset_id, to_asset_id, from_status[BATTERY], to_status[BATTERY], source_doc_type, source_doc_id, meter_reading?, warranty_flag?, reason?, created_by, created_at)`.

## C0. Battery Receipt into Serial Register (prerequisite)

| Step | Actor / Role | Action | System effect | Ledger / history effect | Status transition |
|------|--------------|--------|---------------|-------------------------|-------------------|
| 1 | Storekeeper | Receive battery stock via `tx_grn` (serialized lines); scan/enter each `serial_no`. | One `md_battery` row per serial; `item_id`, `acquisition_cost = unit_price`, `warranty_term_id`, `warranty_start_date`. Serial uniqueness enforced. | `mv_stock_ledger` **IN** (+1 each, `battery_id` set, `unit_cost = acquisition_cost`); `hist_battery_event` `RECEIVED` (to_status `IN_STOCK`) | `md_battery.battery_status = IN_STOCK` |

## C1. Battery Issue — Punch to Vehicle (`tx_battery_issue`, `BAT`)

### Step Table

| Step | Actor / Role | Action | System effect | Ledger + history effect | Status transition (battery) |
|------|--------------|--------|---------------|-------------------------|------------------------------|
| 1 | Storekeeper | Create `tx_battery_issue`; scan `serial_no` → resolve `battery_id`; select `to_asset_id` (VEHICLE/MACHINE); enter fitment `meter_reading`. | `BAT-<SITE>-YY-NNNNNN`. Validate battery `IN_STOCK`; serial match (else exception). | none yet | (still `IN_STOCK`, doc DRAFT) |
| 2 | Supervisor | Approve issue (asset assignment). | `apr_request` on `BATTERY_ISSUE_APPROVAL`. | none | `IN_STOCK` |
| 3 | System | **Post.** | `md_battery.current_asset_id = to_asset_id`; `original_asset_id` set **only if null** (first fitment preserved forever). | `mv_stock_ledger` **OUT** (−1, `battery_id`, `unit_cost = acquisition_cost`); `hist_battery_event` `ISSUED` (`from_status=IN_STOCK → to_status=ISSUED`, `to_asset_id`, `meter_reading`) | `IN_STOCK → ISSUED → IN_SERVICE` |

### C1 Status Flow Map

```
battery_status: IN_STOCK → ISSUED → IN_SERVICE
md_battery:     current_asset_id ← to_asset_id ; original_asset_id set once (immutable)
hist:           append ISSUED  |  Ledger: BAT → OUT (−1)
```

## C2. Battery Transfer asset→asset (`tx_battery_transfer`, `BTR`)

*Move an in-service battery from one asset to another. **No stock ledger movement** (battery never returns to store) — pure asset re-assignment, fully logged in history. Original asset stays visible in `md_battery.original_asset_id` and in `hist_battery_event`.*

### Step Table

| Step | Actor / Role | Action | System effect | Ledger + history effect | Status transition (battery) |
|------|--------------|--------|---------------|-------------------------|------------------------------|
| 1 | Workshop Supervisor | Create `tx_battery_transfer`; scan serial; `from_asset_id` (= current), `to_asset_id`; removal + fitment `meter_reading`. | `BTR-<SITE>-YY-NNNNNN`. Validate battery `IN_SERVICE` & `current_asset_id = from_asset_id`. | none | `IN_SERVICE` |
| 2 | Supervisor | Approve. | `apr_request` on `BATTERY_TRANSFER_APPROVAL`. | none | `IN_SERVICE` |
| 3 | System | **Post.** | `md_battery.current_asset_id = to_asset_id`; `original_asset_id` **unchanged**. | **No `mv_stock_ledger` row** (never re-entered stock); `hist_battery_event` `TRANSFERRED` (`from_asset_id`, `to_asset_id`, both meter readings) | `IN_SERVICE → TRANSFERRED → IN_SERVICE` (on new asset) |

### C2 Status Flow Map

```
battery_status: IN_SERVICE → TRANSFERRED → IN_SERVICE (on to_asset)
Original vs current:  original_asset_id = FIRST asset (unchanged) ; current_asset_id = to_asset_id
hist: append TRANSFERRED (from_asset → to_asset)   |   Ledger: NONE
```

## C3. Battery Replacement / Return / Scrap / Warranty Claim / Repair (`tx_battery_return`, `BRT`)

*Single document `tx_battery_return` with `return_type ∈ {RETURN, REPLACEMENT, SCRAP, WARRANTY, REPAIR, LOST}`. Each variant appends `hist_battery_event` and preserves full serial history; original vs current asset always shown.*

### C3 Step Table (variant matrix)

| Step | Actor / Role | Action | System effect (`md_battery`) | Ledger + history effect | Status transition (battery) |
|------|--------------|--------|------------------------------|-------------------------|------------------------------|
| **Common 1** | Workshop Supervisor | Create `tx_battery_return` (`BRT-<SITE>-YY-NNNNNN`); scan serial; `from_asset_id`, `return_type`, removal `meter_reading`, `reason`. | Validate current status/asset. | none | (current status) |
| **Common 2** | Stores/Workshop Mgr | Approve. | `apr_request` on `BATTERY_RETURN_APPROVAL`. | none | — |
| **RETURN 3** | System | Battery back to store as re-usable. | `current_asset_id = NULL`; `original_asset_id` unchanged. | `mv_stock_ledger` **RET_IN** (+1, `battery_id`, `unit_cost = acquisition_cost`); `hist_battery_event` `RETURNED` | `IN_SERVICE → RETURNED → IN_STOCK` |
| **REPLACEMENT 3** | System | Old unit out, new serial punched to same asset (chains to C1 for the new serial). | Old: `current_asset_id = NULL`. New `md_battery`: `current_asset_id = asset`. | Old: **RET_IN/SCRAP** per condition; `hist` `REPLACED` on old (+ `ISSUED` on new). New serial: **OUT**. | old: `→ REPLACED`; new: `IN_STOCK → IN_SERVICE` |
| **SCRAP 3** | System | Battery condemned. | `current_asset_id = NULL`; `is_active = 0` (soft). | **No positive stock** (write-off): `mv_stock_ledger` **ADJ_OUT** value write-off if it was on-hand, else history-only; `hist_battery_event` `SCRAPPED` | `→ SCRAPPED` |
| **WARRANTY 3** | System | Send to supplier under warranty (checks `warranty_start_date` + `md_warranty_term` still valid). | `current_asset_id = NULL`; claim ref recorded. | history-only (asset ownership retained by supplier during claim); `hist_battery_event` `WARRANTY` (`warranty_flag=1`) | `IN_SERVICE → UNDER_WARRANTY_CLAIM` |
| **WARRANTY resolve** | Storekeeper | Supplier returns replaced/repaired unit. | Back to stock or scrap per outcome. | `mv_stock_ledger` **RET_IN** (if unit returned) ; `hist` `RETURNED`/`REPAIRED` | `UNDER_WARRANTY_CLAIM → IN_STOCK` (or `SCRAPPED`) |
| **REPAIR 3** | System | Send for reconditioning (internal/external). | `current_asset_id = NULL`; repair cost captured. | history-only during repair; on return `RET_IN`; `hist_battery_event` `REPAIRED` | `IN_SERVICE → RETURNED → REPAIRED → IN_STOCK` |

### C3 Status Flow Map (full battery lifecycle — Contract `BATTERY`)

```
                 ┌───────────────────── C1 issue ──────────────────────┐
   IN_STOCK ──► ISSUED ──► IN_SERVICE ──┬─ C2 ─► TRANSFERRED ─► IN_SERVICE
      ▲   ▲                             │
      │   │                             ├─ RETURN ─► RETURNED ─► IN_STOCK
      │   │                             ├─ REPLACEMENT ─────► REPLACED   (new serial → IN_SERVICE)
      │   │                             ├─ WARRANTY ──► UNDER_WARRANTY_CLAIM ─┬─► IN_STOCK
      │   │                             │                                          └─► SCRAPPED
      │   └──── REPAIRED ◄── REPAIR ────┤
      └──────── RETURNED ◄──────────────┤
                                        └─ SCRAP ──────────► SCRAPPED (is_active=0)
   side: LOST (unrecoverable)

EVERY arrow above appends a hist_battery_event row.
original_asset_id = FIRST fitment (immutable) ; current_asset_id = live location (NULL when in store).
```

### C3 — Original vs Current Asset Traceability (worked example)

| `event_date` | `event_type` | `from_asset_id` | `to_asset_id` | `to_status` | Source doc | `md_battery.original_asset_id` | `md_battery.current_asset_id` |
|--------------|--------------|-----------------|---------------|-------------|-----------|-------------------------------|-------------------------------|
| 2026-01-10 | RECEIVED | — | — | IN_STOCK | GRN-CMB-26-000210 | (null) | (null) |
| 2026-02-01 | ISSUED | — | LORRY-14 | IN_SERVICE | BAT-CMB-26-000077 | **LORRY-14** (set) | LORRY-14 |
| 2026-05-06 | TRANSFERRED | LORRY-14 | BUS-03 | IN_SERVICE | BTR-CMB-26-000014 | **LORRY-14** (unchanged) | BUS-03 |
| 2026-09-20 | WARRANTY | BUS-03 | — | UNDER_WARRANTY_CLAIM | BRT-CMB-26-000006 | **LORRY-14** | (null) |

> Full serial history is reconstructable from `hist_battery_event` ordered by `event_date`; the register (`md_battery`) always shows where the battery **started** (`original_asset_id`) and where it **is now** (`current_asset_id`).

---

# PART D — CROSS-CUTTING MATRICES

## D1. Stock Movement Logic Matrix

| Movement class | Source doc (type) | Qty sign | `mv_direction` (MVDIR) | `inv_stock_balance` effect | Valuation effect (MWAC / provisional / serial) |
|----------------|-------------------|----------|------------------------|----------------------------|------------------------------------------------|
| **Receipt (priced)** | GRN | **+** | `IN` | +qty at source store | Recompute MWAC (I4); write `md_price_history` CONFIRMED |
| **Receipt (un-priced)** | GRN | **+** | `IN` | +qty at provisional cost | Provisional cost; queue `inv_pending_price`; PRICE=PROVISIONAL |
| **Price confirm (reval)** | GRN (deferred) | 0 | `ADJ_IN`/`ADJ_OUT` (value-only) | qty unchanged | Value delta corrects `moving_avg_cost`; jobs flagged recompute |
| **Issue** | ISS / LUB | **−** | `OUT` | −qty | Consume at current `moving_avg_cost`; no avg change |
| **Transfer OUT** | TRF | **−** | `XFER_OUT` | −qty at source | Cost frozen (`transfer_cost` = source MWAC); no value created |
| **Transfer IN** | TRF | **+** | `XFER_IN` | +qty at destination | Dest MWAC recompute using `transfer_cost` |
| **Return to supplier** | RET | **−** | `RET_OUT` | −qty | Out at MWAC; supplier debit note |
| **Return to store** | RET | **+** | `RET_IN` | +qty | In at original issue cost (avoid distortion) |
| **Adjustment (+)** | ADJ | **+** | `ADJ_IN` | +qty | In at current MWAC (write-up) |
| **Adjustment (−)** | ADJ | **−** | `ADJ_OUT` | −qty | Out at current MWAC (write-down) |
| **Battery receipt** | GRN (serial) | **+** | `IN` | +1 per serial | At `md_battery.acquisition_cost` (NOT blended into MWAC) |
| **Battery issue** | BAT | **−** | `OUT` | −1 | At acquisition_cost; serial value leaves store |
| **Battery transfer** | BTR | 0 | — (no ledger row) | none | Asset re-assignment only; history-only |
| **Battery return-to-store** | BRT | **+** | `RET_IN` | +1 | Back at acquisition_cost |
| **Battery scrap** | BRT | **−** | `ADJ_OUT` (write-off) | −1 (if on-hand) | Value written off |
| **Lube issue** | LUB | **−** | `OUT` | −qty | At lubricant MWAC; carries `asset_id`+meter |

## D2. Validation Rules (per transaction type)

| Transaction | Availability check | No-negative-stock rule + override | UoM validity | Duplicate GRN / serial | Bad dates | Asset+meter (lube) | Serial uniqueness (battery) |
|-------------|--------------------|-----------------------------------|--------------|-------------------------|-----------|--------------------|-----------------------------|
| **GRN (tx_grn)** | n/a (inbound) | n/a | Received UoM must be item base/alt UoM (`md_uom_conversion`) | Block duplicate `grn_no`; block re-receipt of same PO line beyond `ordered_qty`; serials must not already exist for serialized items | `grn_date` ≤ today; `price_received_date` ≥ `grn_date` | n/a | New serials unique in `md_battery` |
| **Issue (tx_issue)** | `available_qty ≥ issue_qty` per `item_id×location_id` | Block unless `override_by`+`override_reason` | Issue UoM valid for item | n/a | `issue_date` ≤ today, not in locked period | n/a | n/a |
| **Transfer (tx_transfer)** | Source availability I3 | Override at source dispatch | Same-item UoM both legs | n/a | dispatch ≤ receive date | n/a | n/a |
| **Adjustment (tx_adjustment)** | reads system_qty | negative allowed (that's the point) but ADJ_OUT below zero flagged | UoM valid | n/a | count date in open period | n/a | n/a |
| **Return (tx_return)** | SUPPLIER: on-hand ≥ return_qty | Override for SUPPLIER short | UoM valid | `return_qty ≤ received/issued qty` | return date ≥ source doc date | n/a | n/a |
| **Lube issue (tx_lube_issue)** | availability I3 | override capture | **must be volume UoM** | n/a | issue date ≤ today | **MANDATORY** `asset_id` OR `site+dept` AND monotonic `meter_reading` (I7) | n/a |
| **Battery issue (tx_battery_issue)** | battery must be `IN_STOCK` | n/a (unit level) | n/a | serial must resolve to one `md_battery`; not already issued | fitment meter ≥ last | n/a | **serial unique & matched** |
| **Battery transfer (tx_battery_transfer)** | battery `IN_SERVICE` & `current_asset_id=from_asset` | n/a | n/a | serial match | removal meter ≥ fitment meter | n/a | serial match |
| **Battery return (tx_battery_return)** | valid current status per return_type | n/a | n/a | serial match; warranty window check for WARRANTY | dates coherent | n/a | serial match |

## D3. Approval Points

| Document | Requires approval? | Workflow (`sys_workflow`) | Approver role(s) | Escalation / condition |
|----------|--------------------|---------------------------|------------------|------------------------|
| `tx_mrn` | Yes | `MRN_APPROVAL` | Stores Officer → Stores Manager | value/urgency threshold |
| `tx_po` (LOCAL) | Yes | `PO_APPROVAL` | Procurement Manager | escalate to Operational Manager above limit |
| `tx_po` (HEAD_OFFICE) | Yes (HO) | `PO_APPROVAL_HO` | HO Procurement Manager | — |
| `tx_grn` | Post-only (QC gate, no separate financial approval) | `GRN_QC` (if `is_qc_required`) | QC Inspector | QC_FAILED → return |
| `inv_pending_price` confirm | Yes | `PRICE_CONFIRM` | Accounts / Pricing Manager | reval triggers job-cost recompute flag |
| `tx_issue` (store/general) | Conditional | `ISSUE_APPROVAL` | Storekeeper self-post; Supervisor if over value/negative override | override always needs Supervisor |
| `tx_transfer` | Yes | `TRANSFER_APPROVAL` | Stores Manager | inter-site → both site managers |
| `tx_adjustment` | Yes | `ADJUSTMENT_APPROVAL` | Stores Manager; Controller if `abs(variance_amt)>limit` | high variance escalates |
| `tx_return` | Yes | `RETURN_APPROVAL` | Stores Manager | SUPPLIER needs debit-note auth |
| `tx_lube_issue` | Conditional | `LUBE_ISSUE_APPROVAL` | Supervisor if `issue_qty>threshold` | else auto-post |
| `tx_battery_issue` | Yes | `BATTERY_ISSUE_APPROVAL` | Workshop Supervisor | — |
| `tx_battery_transfer` | Yes | `BATTERY_TRANSFER_APPROVAL` | Workshop Supervisor | — |
| `tx_battery_return` | Yes | `BATTERY_RETURN_APPROVAL` | Stores/Workshop Manager | WARRANTY co-signed by Procurement |
| `inv_lube_monthly_balance` | Yes | `PERIOD_CLOSE` | Stores Manager | locks period |

*(All approvals run on the generic `apr_request`/`apr_step`/`apr_action` engine; every action is immutably logged in `apr_action`.)*

## D4. Exception Handling

| Exception | Where detected | System behaviour | Resolution path | Status effect |
|-----------|----------------|------------------|-----------------|----------------|
| **Short receipt** (received < ordered) | GRN entry | GRN posts `received_qty`; PO line stays open for balance | Follow-up GRN or PO close-short with reason | GRN `PARTIAL`; PO remains `APPROVED` |
| **Over supply** (received > ordered) | GRN entry | Block or flag; accept only with buyer approval | Excess → return (A7a) or PO amend | GRN flagged; RET if rejected |
| **Price mismatch** (invoice ≠ agreed) | Price confirm on `inv_pending_price` | Post revaluation for delta; PRICE→REVISED | Reval mv row; job costs flagged recompute | `PROVISIONAL→CONFIRMED (REVISED)` |
| **Damaged goods** | QC step | Fail qty not stocked; route to supplier return | `tx_return` SUPPLIER (RET_OUT) | GRN `QC_FAILED`; RET `POSTED` |
| **Un-priced receipt aging** | `inv_pending_price` monitor | Item sits at provisional cost; alert raised (D8) | Accounts enter price | stays PROVISIONAL until confirmed |
| **Unmatched battery serial** | Battery issue/transfer/return scan | Save blocked — serial not in `md_battery` or status wrong | Register via C0 receipt, or correct scan | doc stays `DRAFT` |
| **Duplicate serial on receipt** | Battery GRN | Reject serial (uniqueness) | Re-key correct serial | line rejected |
| **Negative balance attempt** | Any OUT/XFER_OUT/RET_OUT | Block per I3 unless `override_by`+`override_reason` captured; audit logged | Supervisor override or count first (A6) | doc holds until override or fix |
| **Transit loss** (transfer OUT≠IN) | Transfer receive (A5.5) | Variance to adjustment | `tx_adjustment` reason `TRANSIT_LOSS` | ADJ posted |
| **Stale balance** (no movement / mismatch) | Balance monitor | Flag for recount | `tx_adjustment` physical count | ADJ posted |
| **Reversal / wrong posting** | Any posted doc | **No delete** (I9) — issue reversing/void document that posts the opposite `mv_direction` | Void doc links to original | original `CANCELLED` via reversal, ledger keeps both rows |
| **Back-dated posting into locked period** | Any doc | Blocked by period lock (B2.4) | Post in open period or request unlock | rejected |

## D5. Suggested Forms / Screens (field-level layout)

### GRN — Goods Receipt Note
```
HEADER:  grn_no(auto) | grn_date | site_id/location_id | po_no(lookup) | supplier(from PO)
         supplier_do_no | supplier_invoice_no | price_received_date | grn_type[STD/GENERAL] | remarks
LINE GRID: # | item_no/desc(lookup) | po_ordered_qty | received_qty | uom | unit_price
           | is_qc_required | qc_result | serial_nos(serialized→sub-grid) | line_amt | pending_price(flag)
ACTIONS:  [Save Draft] [Receive] [Send QC] [Enter Price] [Post] [Print] [Return Rejected → RET]
```

### Issue — Stock / General Item Issue
```
HEADER:  issue_no(auto) | issue_date | from_location_id | issue_type[STORE/GENERAL/MRN_FULFIL]
         | mrn_no(ref) | asset_id? | department_id | cost_center_id | project_id? | requested_by
LINE GRID: # | item_no/desc | available_qty(live) | issue_qty | uom | unit_cost(MWAC,ro)
           | line_amt | override_reason(if short)
ACTIONS:  [Save Draft] [Check Availability] [Post] [Print Gate Pass]
```

### Transfer — Inter-location Transfer
```
HEADER:  transfer_no(auto) | transfer_date | from_location_id | to_location_id | reason | vehicle/carrier
LINE GRID: # | item_no/desc | available_qty@source | transfer_qty | uom | transfer_cost(ro)
           | received_qty(dest entry) | variance
ACTIONS:  [Save Draft] [Submit] [Approve] [Dispatch(XFER_OUT)] [Receive(XFER_IN)] [Raise ADJ on variance]
```

### Lube Issue — Lubricant Issue
```
HEADER:  lube_no(auto) | issue_date | from_location_id | target_type[ASSET/SITE]
         | asset_id(VEHICLE/MACHINE lookup) | site_id | department_id | project_id?
         | meter_type[ODO/HOUR] | meter_reading* | prev_meter(ro) | delta(ro)
LINE GRID: # | lube_item(desc, LUBRICANT only) | available_qty | issue_qty | uom(volume) | unit_cost(ro) | line_amt
ACTIONS:  [Save Draft] [Check Availability] [Submit(if>threshold)] [Post] [Print]
VALIDATION BANNER: "asset/site + meter required" if I7 unmet.
```

### Battery Issue — Punch to Vehicle
```
HEADER:  bat_no(auto) | issue_date | from_location_id | to_asset_id(lookup) | fitment_meter_reading | technician
LINE:    serial_no(scan)* → battery_id | item/model(ro) | acquisition_cost(ro) | warranty_end(ro) | current_status(ro=IN_STOCK)
ACTIONS:  [Scan Serial] [Validate] [Submit] [Approve] [Post] [Print Fitment Slip]
```

### Battery Transfer — asset→asset
```
HEADER:  btr_no(auto) | transfer_date | serial_no(scan) | from_asset_id(=current,ro) | to_asset_id
         | removal_meter | fitment_meter | reason
INFO PANEL: original_asset_id(ro) | current_asset_id(ro) | battery_status(ro) | full history link
ACTIONS:  [Scan] [Validate] [Submit] [Approve] [Post(history-only)] [Print]
```

### Battery Return — return/replace/scrap/warranty/repair
```
HEADER:  brt_no(auto) | return_date | serial_no(scan) | from_asset_id(=current) | return_type[RETURN/
         REPLACEMENT/SCRAP/WARRANTY/REPAIR/LOST] | removal_meter | reason | warranty_ref(if claim)
         | replacement_serial(if REPLACEMENT)
INFO PANEL: original_asset_id | current_asset_id | warranty_start/end | days_in_service(ro)
ACTIONS:  [Scan] [Validate warranty] [Submit] [Approve] [Post] [Print condemnation/claim note]
```

## D6. Required Reports (this domain)

| Report | Purpose (one line) |
|--------|--------------------|
| Stock Balance & Valuation | On-hand qty + MWAC value per `item_id × location_id`, live from `inv_stock_balance`. |
| Stock Ledger / Movement Card | Chronological IN/OUT/XFER/ADJ/RET per item with running balance from `mv_stock_ledger`. |
| GRN Register | All receipts by site/supplier/PO with priced/provisional flag. |
| Pending Valuation (un-priced) | Open `inv_pending_price` lines aged — receipts awaiting confirmed price. |
| Issue Analysis by Asset/Cost Centre | Consumption of stores/spares by `asset_id`, department, project. |
| Transfer Register & Transit Variance | Transfers with OUT vs IN reconciliation and losses. |
| Adjustment / Shrinkage Report | Count variances by reason and value impact. |
| Return Register | Returns to supplier (debit notes) and returns to store. |
| Reorder / Below-Minimum | Items where `on_hand_qty ≤ reorder_level`. |
| Slow / Non-Moving Stock | Items with no OUT movement over N days. |
| **Lubricant Consumption (L/100km, L/hr)** | Per vehicle/machine consumption from `mv_stock_ledger` LUBRICANT + meter deltas. |
| Lubricant Monthly Balance | `inv_lube_monthly_balance` opening/receipt/issue/closing per period. |
| **Battery Serial History** | Full `hist_battery_event` per serial — original vs current asset, all events. |
| Battery In-Service Register | Live `md_battery` by asset/status with age & warranty. |
| Battery Warranty Due / Claim Status | Batteries nearing warranty expiry and open `UNDER_WARRANTY_CLAIM` items. |
| Battery Failure / Life Analysis | Avg service life (issue→scrap) by model/asset for procurement planning. |

## D7. Alert Logic

| Alert | Trigger condition | Source | Notified role |
|-------|-------------------|--------|---------------|
| **Low stock / reorder** | `inv_stock_balance.on_hand_qty ≤ md_item.reorder_level` (per location) | balance monitor | Stores Officer, Procurement |
| **Missing price / pending valuation** | Row present in `inv_pending_price` (age > threshold) | queue monitor | Accounts / Pricing Clerk |
| **Unmatched serial** | Battery scan resolves no `md_battery` or wrong `battery_status` | battery txn | Storekeeper, Workshop Supervisor |
| **Duplicate serial** | Attempt to receive an existing `serial_no` | battery GRN | Storekeeper |
| **Pending receipts / GRN not posted** | `tx_grn` in `RECEIVED`/`QC_PASSED` beyond N days (not POSTED) | GRN monitor | Storekeeper, Stores Manager |
| **Negative / stale balance** | `on_hand_qty < 0` OR no movement + count mismatch | balance monitor | Stores Manager |
| **Override used** | Issue posted with `override_by` (below-zero override) | issue post | Stores Manager (audit) |
| **Warranty due** | `md_battery.warranty_end_date − today ≤ N days` and battery `IN_SERVICE` | warranty monitor | Workshop Supervisor, Procurement |
| **Transit variance open** | Transfer `POSTED(in-transit)` beyond N days (IN leg not received) | transfer monitor | Source + Dest Storekeepers |
| **Lube meter anomaly** | `meter_reading < prev_meter` or implausible Δ | lube issue | Fuel-Oil Clerk, Supervisor |
| **Period close blocked** | Un-posted GRN/issue in period being closed | period close | Oil Clerk, Stores Manager |
| **Reval impact on jobs** | Price confirm changed cost of item consumed by open job | price confirm | Costing Clerk |

---

## D8. New Objects Introduced (contract-compliant, flagged per §1.4 rule)

> The following are **not** pre-listed in the contract but are required by these workflows. All follow the contract prefix + naming rules; none duplicate an existing canonical name.

| Object | Type | Justification |
|--------|------|---------------|
| `inv_lube_monthly_balance` | table (already named in contract §3.2) | period snapshot — reused, not new. |
| `sys_workflow` rows: `MRN_APPROVAL`, `PO_APPROVAL`, `PO_APPROVAL_HO`, `GRN_QC`, `PRICE_CONFIRM`, `ISSUE_APPROVAL`, `TRANSFER_APPROVAL`, `ADJUSTMENT_APPROVAL`, `RETURN_APPROVAL`, `LUBE_ISSUE_APPROVAL`, `BATTERY_ISSUE_APPROVAL`, `BATTERY_TRANSFER_APPROVAL`, `BATTERY_RETURN_APPROVAL`, `PERIOD_CLOSE` | `sys_workflow` config rows | workflow definitions for the generic `apr_*` engine — data, not new tables. |
| `md_item.reorder_level` | column (attribute) | reorder alert; follows `*_level` numeric convention. |
| `md_battery.original_asset_id` | column | preserves first-fitment asset (immutable) alongside `current_asset_id`. |
| `md_battery.acquisition_cost`, `warranty_start_date`, `warranty_end_date` | columns | serial valuation + warranty per §6/§99. |
| `mv_stock_ledger.transfer_cost` handling | uses existing `unit_cost` | no new column — carried in `unit_cost` on XFER legs. |
| `tx_return.return_type` ∈ {SUPPLIER, STORE_BACK}; `tx_battery_return.return_type` ∈ {RETURN, REPLACEMENT, SCRAP, WARRANTY, REPAIR, LOST} | discriminator columns | follow `*_type` convention; drive variant logic. |
| Adjustment reason codes (`COUNT`, `DAMAGE`, `SHRINKAGE`, `TRANSIT_LOSS`, `FOUND`) | `sys_code` values | reason vocabulary. |

---

*End of 04 — Stock Transaction Engine. Job-card material request (`MRQ`), parts consumption and job costing continue in the workshop/costing sections; battery and lubricant consumption analytics read the same `mv_stock_ledger`.*
