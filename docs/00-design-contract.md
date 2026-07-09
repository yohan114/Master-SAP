# Master‑SAP — Design Contract (Canonical Backbone)

> **Product name:** UMMS — *Unified Master Management System* (repository: `Master-SAP`).
> **Purpose of this document:** This is the single source of truth for naming, shared master
> data, document numbering, status vocabularies, audit fields, and valuation method. **Every
> other blueprint document (architecture, database, workflows, costing, dashboards, migration,
> UI, reports) must conform to the names and codes defined here.** If any downstream document
> needs a new table, status, or number series, it must follow the conventions below.

---

## 1. Naming Standards

### 1.1 Table name prefixes (domain families)

| Prefix   | Family                         | Contents / rule                                                    |
|----------|--------------------------------|--------------------------------------------------------------------|
| `md_`    | Master data                    | Slow‑changing reference entities (item, asset, supplier, employee) |
| `tx_`    | Transaction header             | One row per business document                                      |
| `txl_`   | Transaction line               | Child lines of a `tx_` header                                      |
| `inv_`   | Inventory state                | Balances, valuation layers, reservations, pending‑price queue      |
| `mv_`    | Movement / ledger (append‑only)| Immutable stock and value movements                                |
| `hist_`  | Entity history / lifecycle     | Append‑only event log for serialized/tracked assets                |
| `apr_`   | Approval / workflow instance   | Requests, steps, actions                                           |
| `cost_`  | Costing                        | Job cost roll‑ups, cost lines, variance                            |
| `stg_`   | Migration staging              | Raw + cleansed import buffers                                      |
| `map_`   | Migration mapping / xref       | Legacy‑key → master‑key cross reference                            |
| `sys_`   | System / configuration         | Number series, codes, status master, workflow definitions          |
| `sec_`   | Security                       | Users, roles, permissions, site access                             |
| `doc_`   | Attachments                    | Files, images (battery serial proof), scanned GRNs                 |

### 1.2 Column conventions

| Concept              | Convention                    | Example                              |
|----------------------|-------------------------------|--------------------------------------|
| Surrogate primary key| `<root>_id` `BIGINT IDENTITY` | `item_id`, `jobcard_id`              |
| Human document number| `<root>_no` `VARCHAR(30)` uniq| `mrn_no`, `jobcard_no`               |
| Foreign key          | `<referenced_root>_id`        | `supplier_id`, `location_id`         |
| FK constraint name   | `fk_<table>_<ref>`            | `fk_txl_grn_item`                    |
| Boolean              | `is_*` / `has_*`              | `is_serial_tracked`, `is_active`     |
| Date (no time)       | `*_date`                      | `grn_date`, `effective_date`         |
| Timestamp            | `*_at`                        | `created_at`, `approved_at`          |
| Quantity             | `*_qty` `DECIMAL(18,4)`       | `received_qty`, `issue_qty`          |
| Unit rate / price    | `*_rate` / `unit_price`       | `labour_rate`, `unit_price`          |
| Money amount         | `*_amt` `DECIMAL(18,2)`       | `line_amt`, `total_amt`              |
| Cost                 | `*_cost`                      | `material_cost`, `total_job_cost`    |
| Status code          | `*_status` (FK `sys_status`)  | `doc_status`, `jobcard_status`       |
| Percentage           | `*_pct`                       | `variance_pct`                       |

### 1.3 Standard audit columns (on **every** table)

```
created_by      BIGINT   NOT NULL   -- sec_user.user_id
created_at      DATETIME NOT NULL
updated_by      BIGINT   NULL
updated_at      DATETIME NULL
row_version     ROWVERSION/INT      -- optimistic concurrency
is_active       BIT      DEFAULT 1  -- soft delete
```
Additional on all **approvable document** tables (`tx_*`, job/battery docs):
```
approved_by     BIGINT   NULL       -- final approver
approved_at     DATETIME NULL
site_id         BIGINT   NOT NULL   -- md_location(site) for row‑level security
```

### 1.4 Rules

- **No physical deletes** on masters, movements, ledgers, history or approvals — use `is_active`
  or a reversing/void document. Movement tables (`mv_*`, `hist_*`) are strictly append‑only.
- Every stock‑affecting line **must** write to `mv_stock_ledger` in the same transaction.
- Every FK must be enforced; no orphan lines.
- All money in base currency (`LKR`) with `currency_code` where multi‑currency is possible.

---

## 2. Canonical Shared Masters (single source — never duplicated per module)

| Table                 | Represents                       | Key discriminators / notes                                                        |
|-----------------------|----------------------------------|-----------------------------------------------------------------------------------|
| `md_item`             | **Unified item master** for ALL materials | `item_type` ∈ {STORE, LUBRICANT, BATTERY, SPARE, GENERAL, CONSUMABLE}; flags `is_stockable`, `is_serial_tracked`, `is_batch_tracked` |
| `md_item_category`    | Category hierarchy               | self‑parent `parent_category_id`                                                  |
| `md_item_group`       | Analytical grouping              | for reporting/fast‑moving analysis                                                |
| `md_uom`              | Unit of measure                  | base + alternate                                                                  |
| `md_uom_conversion`   | UoM conversion factors           | `from_uom_id`, `to_uom_id`, `factor`                                              |
| `md_supplier`         | Supplier / vendor                | `supplier_type` ∈ {LOCAL, HEAD_OFFICE, SUBCONTRACTOR}                             |
| `md_asset`            | **Unified asset master** (fleet + plant) | `asset_class` ∈ {VEHICLE, MACHINE, EQUIPMENT}; lubricant & battery issue target  |
| `md_asset_vehicle`    | Vehicle‑specific attributes      | extends `md_asset` (reg no, chassis, make, model, meter type)                     |
| `md_asset_machine`    | Machine/equipment attributes     | extends `md_asset` (capacity, plant no, hour meter)                               |
| `md_battery`          | **Serial register** of battery units | one row per physical battery serial; links `item_id`, `current_asset_id`, status |
| `md_employee`         | Employee / technician            | `is_technician`, `grade_id`, links to labour rate                                 |
| `md_location`         | Site / store / bin hierarchy     | `location_type` ∈ {SITE, STORE, BIN}; self‑parent `parent_location_id`            |
| `md_project`          | Project / contract               | optional cost dimension                                                           |
| `md_department`       | Department                       | cost dimension                                                                    |
| `md_cost_center`      | Cost center                      | finance dimension                                                                 |
| `md_price`            | Current active price             | item × supplier × site, `effective_date`, `price_status`                         |
| `md_price_history`    | **Effective‑dated price history**| immutable; costing reads price as‑of transaction date                            |
| `md_labour_rate`      | Technician/grade hourly rate     | effective‑dated                                                                   |
| `md_warranty_term`    | Warranty definitions             | for battery/asset warranty tracking                                              |
| `md_approval_role`    | Approval role master             | maps to `sec_role`                                                                |

**Golden rule:** a lubricant, a spare part, a general item and a battery model are all rows in
`md_item`. A vehicle, a generator and a workshop press are all rows in `md_asset`. There is exactly
one supplier list, one employee list, one location tree, one UoM list — shared by every module.

---

## 3. Transaction, Movement, History, Approval & Costing Tables

### 3.1 Stores / Material transactions
| Table                | Document                              | Numbering type |
|----------------------|---------------------------------------|----------------|
| `tx_mrn` / `txl_mrn` | Material Request Note (indent)        | `MRN`          |
| `tx_po` / `txl_po`   | Purchase Order (`po_type` LOCAL/HEAD_OFFICE) | `PO`     |
| `tx_grn` / `txl_grn` | Goods Receipt Note                     | `GRN`          |
| `tx_issue` / `txl_issue` | Stock / general item issue         | `ISS`          |
| `tx_transfer` / `txl_transfer` | Inter‑location transfer      | `TRF`          |
| `tx_adjustment` / `txl_adjustment` | Stock adjustment / count   | `ADJ`          |
| `tx_return` / `txl_return` | Return to supplier / store back | `RET`         |

### 3.2 Lubricant
| Table                       | Document                                | Numbering type |
|-----------------------------|-----------------------------------------|----------------|
| `tx_lube_issue`/`txl_lube_issue` | Lubricant issue to asset/site (with meter reading) | `LUB` |
| `inv_lube_monthly_balance`  | Month‑end lubricant balance snapshot     | —              |
| Receipts of lubricant reuse `tx_grn`; consumption analytics read `mv_stock_ledger` filtered `item_type=LUBRICANT`. |

### 3.3 Battery (serial‑controlled)
| Table                    | Document / purpose                          | Numbering type |
|--------------------------|---------------------------------------------|----------------|
| `tx_battery_issue`       | Punch/issue battery to asset                | `BAT`          |
| `tx_battery_transfer`    | Transfer battery asset→asset                | `BTR`          |
| `tx_battery_return`      | Return / replacement / scrap / warranty     | `BRT`          |
| `hist_battery_event`     | **Full serial lifecycle log** (append‑only) | —              |

### 3.4 Inventory state / ledger
| Table                | Purpose                                                                 |
|----------------------|-------------------------------------------------------------------------|
| `mv_stock_ledger`    | **Append‑only** master movement ledger: one row per stock‑affecting line |
| `inv_stock_balance`  | Materialized on‑hand qty + moving‑avg cost per `item_id × location_id`   |
| `inv_valuation_layer`| Optional FIFO cost layers                                               |
| `inv_reservation`    | Soft‑allocation of stock to a job card / issue                          |
| `inv_pending_price`  | **Pending valuation queue** — received but un‑priced lines              |

### 3.5 Job card / workshop
| Table                       | Purpose                                              | Numbering type |
|-----------------------------|------------------------------------------------------|----------------|
| `tx_jobcard`                | Job card header                                      | `JC`           |
| `txl_jobcard_task`          | Job tasks / defect lines                             | —              |
| `tx_job_progress`           | Daily work‑done log (ongoing jobs)                   | —              |
| `tx_job_material_req`/`txl_*` | Material request against job card (internal/external) | `MRQ`      |
| `tx_job_parts`              | Parts received/consumed against job (links GRN/issue)| —              |
| `tx_job_labour`             | Labour capture (technician, date, hours, rate)       | `LAB`          |
| `tx_job_outside_repair`     | Subcontract / outside repair                         | `OSR`          |
| `cost_job_summary`          | Job cost roll‑up (labour/material/general/outside)   | —              |
| `cost_job_line`             | Cost detail per cost element                          | —              |
| `cost_variance`             | Estimated vs actual variance                         | —              |

### 3.6 Approval / workflow (generic engine, reused by all modules)
| Table                | Purpose                                                            |
|----------------------|-------------------------------------------------------------------|
| `sys_workflow`       | Workflow definition (e.g., JOBCARD_APPROVAL)                      |
| `sys_workflow_step`  | Ordered steps + required role                                    |
| `apr_request`        | Approval instance bound to a source document                     |
| `apr_step`           | Per‑step state of a request                                      |
| `apr_action`         | Immutable log of each approve/reject/return/escalate action      |

### 3.7 System & security
`sys_number_series`, `sys_status`, `sys_code`, `sys_setting`, `sec_user`, `sec_role`,
`sec_user_role`, `sec_permission`, `sec_role_permission`, `sec_user_site` (site‑level visibility).

### 3.8 Migration
`stg_<entity>_raw`, `stg_<entity>_clean`, `map_<entity>_xref`, `stg_load_batch`, `stg_reject`.

---

## 4. Document Numbering Format

**Pattern:** `<TYPE>-<SITE>-<YY>-<NNNNNN>`

- `TYPE` — document type code (below)
- `SITE` — 3‑letter site code from `md_location` (e.g., `CMB`, `KND`, `HO0`)
- `YY` — 2‑digit year; sequence resets yearly, per site, per type
- `NNNNNN` — zero‑padded running sequence from `sys_number_series`

| Type code | Document              | Example                 |
|-----------|-----------------------|-------------------------|
| `MRN`     | Material Request Note | `MRN-CMB-26-000123`     |
| `PO`      | Purchase Order        | `PO-HO0-26-000045`      |
| `GRN`     | Goods Receipt Note    | `GRN-CMB-26-000210`     |
| `ISS`     | Issue                 | `ISS-CMB-26-001004`     |
| `TRF`     | Transfer              | `TRF-CMB-26-000067`     |
| `ADJ`     | Adjustment            | `ADJ-CMB-26-000012`     |
| `RET`     | Return                | `RET-CMB-26-000009`     |
| `LUB`     | Lubricant Issue       | `LUB-KND-26-000318`     |
| `BAT`     | Battery Issue         | `BAT-CMB-26-000077`     |
| `BTR`     | Battery Transfer      | `BTR-CMB-26-000014`     |
| `BRT`     | Battery Return        | `BRT-CMB-26-000006`     |
| `JC`      | Job Card              | `JC-CMB-26-000502`      |
| `MRQ`     | Job Material Request  | `MRQ-CMB-26-000488`     |
| `LAB`     | Labour Sheet          | `LAB-CMB-26-000771`     |
| `OSR`     | Outside Repair        | `OSR-CMB-26-000031`     |

---

## 5. Status Vocabularies (all held in `sys_status`, grouped by `status_group`)

**Generic document lifecycle (`DOC`):**
`DRAFT → SUBMITTED → APPROVED → POSTED → CLOSED`; side states `REJECTED`, `RETURNED`, `ON_HOLD`, `CANCELLED`.

**Approval action (`APR`):** `PENDING`, `APPROVED`, `REJECTED`, `RETURNED`, `ESCALATED`, `DELEGATED`.

**GRN (`GRN`):** `DRAFT → RECEIVED → QC_PENDING → QC_PASSED → PRICED → POSTED` (+ `QC_FAILED`, `PARTIAL`).

**Price (`PRICE`):** `PENDING → PROVISIONAL → CONFIRMED` (+ `REVISED`).

**Stock movement direction (`MVDIR`):** `IN`, `OUT`, `XFER_IN`, `XFER_OUT`, `ADJ_IN`, `ADJ_OUT`, `RET_IN`, `RET_OUT`.

**Job card (`JOBCARD`):**
`DRAFT → PENDING_TM_APPROVAL → PENDING_OM_APPROVAL → APPROVED → ASSIGNED_WORKSHOP → IN_PROGRESS → AWAITING_PARTS → AWAITING_OUTSIDE_REPAIR → WORK_COMPLETED → PENDING_COSTING → PENDING_CLOSURE → CLOSED`; side states `ON_HOLD`, `CANCELLED`, `REJECTED`.
*(TM = Transport Manager, OM = Operational Manager. `AWAITING_PARTS` / `AWAITING_OUTSIDE_REPAIR` are re‑entrant sub‑states of `IN_PROGRESS`.)*

**Battery lifecycle (`BATTERY`):**
`IN_STOCK → ISSUED → IN_SERVICE → TRANSFERRED → RETURNED → UNDER_WARRANTY_CLAIM → REPAIRED → SCRAPPED` (+ `REPLACED`, `LOST`).

**Migration record (`MIGR`):** `IMPORTED → VALIDATED → MAPPED → APPROVED → POSTED` (+ `REJECTED`, `DUPLICATE`).

---

## 6. Valuation Method

- **Default:** Moving **Weighted Average Cost (MWAC)** maintained per `item_id × location_id` in
  `inv_stock_balance.moving_avg_cost`. Recalculated on every priced receipt:
  `new_avg = (on_hand_qty × old_avg + received_qty × unit_price) / (on_hand_qty + received_qty)`.
- **Provisional costing:** if a receipt is un‑priced, stock is received at **last known / provisional
  price**, the line is queued in `inv_pending_price`, and issues/costing use provisional cost. When
  price is confirmed a **revaluation movement** is posted and dependent job costs are flagged for
  recompute.
- **Optional FIFO:** `inv_valuation_layer` supports FIFO where an item is configured `valuation_method = FIFO`.
- **Serialized items (battery):** valued at their own acquisition cost carried on `md_battery`.

---

## 7. Cross‑Module Integrity Rules (must hold everywhere)

1. Every issue/receipt/transfer/adjustment/return posts a `mv_stock_ledger` row **and** updates
   `inv_stock_balance` atomically.
2. No issue when `available_qty < requested_qty` unless a recorded override
   (`override_by`, `override_reason`) exists.
3. A transfer posts **two** ledger rows (`XFER_OUT` at source, `XFER_IN` at destination).
4. Battery movements always append to `hist_battery_event`; `md_battery.current_asset_id` and
   `battery_status` are updated in the same transaction.
5. Lubricant issues require `asset_id` (or `site_id`+`department_id`) and `meter_reading` so
   consumption is traceable by asset, site and date.
6. Costing reads price **as of the transaction date** via `md_price_history`.
7. Job cards cannot reach `CLOSED` until all parts received/accounted, prices entered
   (no rows in `inv_pending_price` for the job), labour captured, outside‑repair costs entered,
   and all approvals complete.
8. Every document carries the standard audit + `site_id`; edits to price/cost are logged.
