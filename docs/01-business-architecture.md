# UMMS — Business Architecture

> **Scope of this document:** Business-level target state, silo-to-target mapping, solution
> architecture layers, module connectivity through shared masters + the stock ledger, one
> end-to-end cross-module scenario, and the design principles honored.
> **Governing contract:** All table names, numbering (`TYPE-SITE-YY-NNNNNN`), status vocabularies,
> shared masters and Moving Weighted Average Cost (MWAC) valuation are defined in
> [`00-design-contract.md`](./00-design-contract.md) and are reused verbatim here.

---

## 1. Executive Summary — The Target State in Plain Business Language

UMMS replaces four disconnected books-of-record (stores system, oil/lube stock book, battery
tracking, workshop job cards) plus their surrounding Excel files and old backups with **ONE
platform on ONE database**. The business runs a transport fleet, a repair workshop, and stores
that feed both — today the same vehicle, the same supplier, the same oil grade and the same
mechanic are re-typed into four systems and never reconcile. UMMS ends that.

| What the operator gets | How UMMS delivers it |
|------------------------|----------------------|
| **One vehicle, entered once** | Every truck, bowser, generator and workshop press is one row in `md_asset` — job cards, lubricant issues and batteries all point at the *same* asset_id. |
| **One item list** | An oil grade, a brake pad, a battery model and a nut/bolt are all rows in `md_item` discriminated by `item_type` — no separate "oil master" vs "spares master". |
| **One supplier, one employee, one location tree** | `md_supplier`, `md_employee`, `md_location` are shared; the mechanic who logs labour is the same record that receives the GRN. |
| **Linked transactions** | A job card's part request (`MRQ`) reserves stock, an issue (`ISS`) consumes it, the ledger records it, and the cost lands on the *same* job — one unbroken chain of document numbers. |
| **Approvals built in** | Transport Manager (TM) → Operational Manager (OM) job-card approval and stores/purchase approvals run on ONE generic `apr_*` engine, not paper signatures. |
| **Live dashboards** | Exec, Workshop, Stores, Lubricant and Battery dashboards read the same ledger and costing tables — no month-end spreadsheet stitching. |
| **Full traceability** | From an exec cost figure you can drill: `cost_job_summary` → cost line → `ISS`/`LUB`/`BAT`/`LAB`/`OSR` → `mv_stock_ledger` → GRN → supplier → price-as-of-date. |
| **Final job costing** | Labour + material + general + outside-repair roll up into `cost_job_summary.total_job_cost` before a job can close — the true cost of every repair, valued at MWAC. |

**One sentence:** *Enter the master once, transact against it everywhere, let every stock and money
movement hit one append-only ledger, and read the truth off shared dashboards.*

---

## 2. From Today (Silos) to Target (UMMS)

| # | Legacy silo (today) | Master/records it kept privately | Target UMMS module | What stops being duplicated / re-keyed |
|---|---------------------|----------------------------------|--------------------|----------------------------------------|
| 1 | **Stores / material system** | Own item list, own suppliers, own GRN book, own issue register | **(A) Stores / Material Management** — `tx_mrn`, `tx_po`, `tx_grn`, `tx_issue`, `tx_transfer`, `tx_adjustment`, `tx_return` | Item master, supplier list and on-hand balances now come from `md_item` / `md_supplier` / `inv_stock_balance`; no private copies. |
| 2 | **Oil / lubricant stock book** | Separate oil product list, hand-written vehicle-wise issue pages, monthly balance recalculated by hand | **(B) Oil / Lubricant** — `tx_lube_issue` (`LUB`), `inv_lube_monthly_balance` | Oil grades become `md_item` rows (`item_type=LUBRICANT`); vehicle-wise history and monthly balance derive from `mv_stock_ledger`, not a manual book. |
| 3 | **Battery tracking sheet** | Serial list in Excel, warranty dates, which vehicle it "is on" (often stale) | **(C) Battery** — `md_battery` serial register, `tx_battery_issue`(`BAT`) / `tx_battery_transfer`(`BTR`) / `tx_battery_return`(`BRT`), `hist_battery_event` | One serial register; current vs original vehicle and warranty status are live, not a spreadsheet someone forgot to update. |
| 4 | **Workshop job cards (paper / standalone)** | Vehicle re-typed, parts written on paper, labour guessed, no real cost | **(D) Job Card / Workshop** — `tx_jobcard`(`JC`), `txl_jobcard_task`, `tx_job_progress`, `tx_job_material_req`(`MRQ`), `tx_job_parts`, `tx_job_labour`(`LAB`), `tx_job_outside_repair`(`OSR`) + `cost_*` | Vehicle comes from `md_asset`; parts link to real `ISS`/GRN; labour uses `md_labour_rate`; cost is computed, not estimated. |
| 5 | **Excel files & old backups** | Prices, reorder levels, "who approved", ad-hoc reports | Absorbed across all modules + `md_price_history`, `apr_*`, `sys_number_series`, dashboards | Effective-dated prices live in `md_price_history`; approvals in `apr_action`; document numbers in `sys_number_series` — the spreadsheets are retired (migrated via `stg_*`/`map_*`). |

**Net effect:** four private item lists → one `md_item`; four private "which vehicle" notions →
one `md_asset`; four supplier lists → one `md_supplier`; four ways of counting stock → one
`mv_stock_ledger` + `inv_stock_balance`.

---

## 3. Solution Architecture — Layers

```
+-----------------------------------------------------------------------------------+
| 7. INTEGRATION LAYER                                                              |
|    Migration (stg_*/map_*), number series (sys_number_series), external feeds,   |
|    fuel/telematics meter import, HO purchase interface, document store (doc_*)    |
+-----------------------------------------------------------------------------------+
| 6. REPORTING / DASHBOARD LAYER                                                   |
|    Exec | Workshop | Stores | Lubricant | Battery dashboards; movement history,   |
|    stock-by-location, pending price, job cost, consumption/forecast reports      |
+-----------------------------------------------------------------------------------+
| 5. APPROVAL / WORKFLOW LAYER                                                      |
|    sys_workflow / sys_workflow_step + apr_request / apr_step / apr_action         |
|    (JOBCARD_APPROVAL TM->OM, PO approval, adjustment approval, battery scrap)     |
+-----------------------------------------------------------------------------------+
| 4. COSTING LAYER                                                                 |
|    cost_job_summary / cost_job_line / cost_variance — rolls up labour+material+  |
|    general+outside; reads price as-of date; gates job closure                    |
+-----------------------------------------------------------------------------------+
| 3. STOCK LEDGER & VALUATION LAYER                                                |
|    mv_stock_ledger (append-only) | inv_stock_balance (MWAC) |                     |
|    inv_reservation | inv_pending_price | inv_valuation_layer                      |
+-----------------------------------------------------------------------------------+
| 2. TRANSACTION LAYER                                                              |
|    Stores: MRN/PO/GRN/ISS/TRF/ADJ/RET | Lube: LUB | Battery: BAT/BTR/BRT |        |
|    Workshop: JC/MRQ/LAB/OSR + tx_job_progress / tx_job_parts                      |
+-----------------------------------------------------------------------------------+
| 1. MASTER DATA LAYER (shared, single source, never duplicated)                   |
|    md_item | md_asset(+vehicle/+machine) | md_battery | md_supplier | md_employee |
|    md_location | md_uom | md_price/md_price_history | md_labour_rate | md_project   |
+-----------------------------------------------------------------------------------+
```

| Layer | In 2–3 lines |
|-------|--------------|
| **1. Master Data** | The single source for items, assets, batteries, suppliers, employees, locations, UoM, prices and labour rates. Every transaction references these by `*_id`; nothing is retyped. Slow-changing, soft-deleted (`is_active`), never physically deleted. |
| **2. Transaction** | One row per business document (`tx_*` header + `txl_*` lines), each carrying its own `*_no` from `sys_number_series`. Documents link to each other (MRN→PO→GRN, JC→MRQ→ISS) forming the operational chain. |
| **3. Stock Ledger & Valuation** | Every stock-affecting line writes an immutable `mv_stock_ledger` row and atomically updates `inv_stock_balance` (on-hand + `moving_avg_cost`). Un-priced receipts queue in `inv_pending_price`; reservations hold stock for jobs. |
| **4. Costing** | Aggregates job spend into `cost_job_summary` (material/labour/general/outside) with `cost_job_line` detail and `cost_variance`. Reads unit cost **as-of transaction date**, and blocks closure until fully costed. |
| **5. Approval / Workflow** | One generic engine (`sys_workflow`→`apr_request`/`apr_step`/`apr_action`) drives TM→OM job approval, PO approval, adjustment sign-off and battery scrap. Every approve/reject/return is an immutable action row. |
| **6. Reporting / Dashboard** | Role-based dashboards and reports read the ledger, balances and costing tables directly. No parallel data mart is authoritative; drill-down always resolves to a source document. |
| **7. Integration** | Migration staging (`stg_*`/`map_*`) loads the retired silos; `sys_number_series` issues document numbers; meter/fuel imports feed lubricant issues; `doc_*` stores battery serial photos and scanned GRNs. |

---

## 4. Module Connectivity Map — Everything Meets at the Masters and the Ledger

```
                         +---------------------------------------------+
                         |            SHARED MASTER DATA               |
                         |  md_item  md_asset  md_battery  md_supplier |
                         |  md_employee  md_location  md_price(_history)|
                         +----+-------------+------------+-------------+
                              |             |            |
        +---------------------+     +-------+-----+   +--+-----------------+
        |                           |             |   |                    |
   (A) STORES               (B) LUBRICANT   (C) BATTERY           (D) JOB CARD / WORKSHOP
   MRN->PO->GRN->ISS         LUB issue      BAT/BTR/BRT            JC->MRQ->(reserve)->ISS
   TRF/ADJ/RET               (asset+meter)  hist_battery_event     LAB / OSR / tx_job_parts
        |                           |             |                    |
        |  every stock-affecting line writes ->   |                    |
        +----------------+----------+-------------+--------------------+
                         v
              +---------------------------+          +--------------------------+
              |     mv_stock_ledger       |  feeds   |   cost_job_summary /     |
              | (append-only movements)   +--------->|   cost_job_line          |
              | inv_stock_balance (MWAC)  |          | (material/labour/general/|
              | inv_reservation           |          |  outside -> total_cost)  |
              | inv_pending_price         |          +------------+-------------+
              +-------------+-------------+                        |
                            |                                      v
                            +-----------------> DASHBOARDS (Exec, Workshop, Stores, Lube, Battery)
```

**Concrete linkages (who points at whom):**

| From (module/document) | Link column / mechanism | To (target) | Business meaning |
|------------------------|-------------------------|-------------|------------------|
| `tx_job_material_req` (MRQ) | `jobcard_id`, `item_id` | `tx_jobcard`, `md_item` | Job asks stores for parts |
| MRQ approved | `inv_reservation` (`jobcard_id`, `item_id`, `location_id`) | `inv_stock_balance` | Stock soft-allocated to the job |
| `tx_issue` (ISS) | `source_ref = MRQ`, `jobcard_id` | `tx_job_material_req`, `tx_jobcard` | Physical issue against the reservation |
| `tx_issue` line | one `mv_stock_ledger` row `direction=OUT` | `mv_stock_ledger` | Stock leaves store at MWAC |
| `mv_stock_ledger` OUT (job) | aggregated by `jobcard_id` | `cost_job_summary.material_cost` | Parts cost lands on the job |
| `tx_lube_issue` (LUB) | `asset_id`, `meter_reading`, `jobcard_id?` | `md_asset`, `mv_stock_ledger` OUT | Oil traceable to vehicle + meter; optionally to a job |
| `tx_battery_issue` (BAT) | `battery_id`, `asset_id` | `md_battery`, `hist_battery_event`, `md_asset` | Serial battery punched onto a vehicle |
| `tx_job_labour` (LAB) | `jobcard_id`, `employee_id`, `md_labour_rate` | `cost_job_summary.labour_cost` | Technician hours × effective rate |
| `tx_job_outside_repair` (OSR) | `jobcard_id`, `supplier_id` (SUBCONTRACTOR) | `cost_job_summary.outside_repair_cost` | Subcontract repair cost |
| `tx_grn` (GRN) | `item_id`, `supplier_id`, `grn_date`, `unit_price` | `md_price_history`, `inv_stock_balance`, `inv_pending_price` | Receipt sets/queues price, recomputes MWAC |

---

## 5. End-to-End Scenario — One Breakdown, All Four Modules

**Setting:** Tipper `LP-4521` (a `md_asset` of `asset_class=VEHICLE`, extended by
`md_asset_vehicle`) breaks down at site `CMB` — engine warning, weak cranking, hydraulic leak.

| Step | Actor / role | Action | System effect | Stock-ledger / costing effect | Status transition | Tables touched |
|------|--------------|--------|---------------|-------------------------------|-------------------|----------------|
| 1 | Transport dept | Raise job card for `LP-4521`, log 3 defect tasks (engine, battery, hydraulics), attach meter | `JC-CMB-26-000502` created; tasks added | — | `DRAFT → PENDING_TM_APPROVAL` | `tx_jobcard`, `txl_jobcard_task`, `md_asset` |
| 2 | Transport Manager (TM) | Approve job scope | `apr_step` for TM marked APPROVED | — | `PENDING_TM_APPROVAL → PENDING_OM_APPROVAL` | `apr_request`, `apr_step`, `apr_action` |
| 3 | Operational Manager (OM) | Final approve | Second `apr_step` APPROVED | — | `PENDING_OM_APPROVAL → APPROVED → ASSIGNED_WORKSHOP` | `apr_action`, `tx_jobcard` |
| 4 | Workshop supervisor | Route to bay, set start date, assign technician | Job accepted; `job_start_date` set | — | `ASSIGNED_WORKSHOP → IN_PROGRESS` | `tx_jobcard`, `tx_job_progress` |
| 5 | Technician | Request parts (oil filter, hydraulic hose) from stores | `MRQ-CMB-26-000488` raised, links `jobcard_id` | `inv_reservation` rows created (soft-allocate) | job → `AWAITING_PARTS` (sub-state of IN_PROGRESS) | `tx_job_material_req`, `txl_job_material_req`, `inv_reservation` |
| 6 | Storekeeper | Issue reserved parts | `ISS-CMB-26-001004` posted against MRQ | `mv_stock_ledger` OUT (2 lines) at MWAC; `inv_stock_balance` reduced; reservation released | `AWAITING_PARTS → IN_PROGRESS` | `tx_issue`, `txl_issue`, `mv_stock_ledger`, `inv_stock_balance`, `tx_job_parts` |
| 7 | Costing (auto) | Post issued parts to job | Material lines linked to job | `cost_job_summary.material_cost` += issued value | — | `tx_job_parts`, `cost_job_line`, `cost_job_summary` |
| 8 | Technician | Top up engine oil 15W-40, record meter reading | `LUB-CMB-26-000318` issued to `asset_id=LP-4521` | `mv_stock_ledger` OUT (LUBRICANT) at MWAC; consumption traceable by asset+meter+date | — | `tx_lube_issue`, `mv_stock_ledger`, `md_asset` |
| 9 | Costing (auto) | Oil value to job (issue carried `jobcard_id`) | Lube cost folded into material | `cost_job_summary.material_cost` += oil value | — | `cost_job_line`, `cost_job_summary` |
| 10 | Technician / stores | Failed battery `BAT-SN-77341` returned, new serial punched onto vehicle | `BRT-CMB-26-000006` (return failed) + `BAT-CMB-26-000077` (issue new) | New battery valued from `md_battery` acquisition cost; battery events logged | old battery `IN_SERVICE → RETURNED → UNDER_WARRANTY_CLAIM`; new `IN_STOCK → ISSUED → IN_SERVICE` | `tx_battery_return`, `tx_battery_issue`, `md_battery`, `hist_battery_event`, `md_asset` |
| 11 | Workshop supervisor | Hydraulic pump sent to outside specialist | `OSR-CMB-26-000031` raised to SUBCONTRACTOR supplier | Outside cost accrued | `IN_PROGRESS → AWAITING_OUTSIDE_REPAIR` | `tx_job_outside_repair`, `md_supplier` |
| 12 | Supplier / supervisor | Repaired pump returned, invoice priced | OSR closed with amount | `cost_job_summary.outside_repair_cost` += invoice | `AWAITING_OUTSIDE_REPAIR → IN_PROGRESS` | `tx_job_outside_repair`, `cost_job_line` |
| 13 | Technician | Log labour: 6.5 h across 2 technicians | `LAB-CMB-26-000771` captured; hours × `md_labour_rate` | `cost_job_summary.labour_cost` += labour | — | `tx_job_labour`, `md_labour_rate`, `md_employee`, `cost_job_line` |
| 14 | Workshop supervisor | Mark all tasks done | Work log finalized | — | `IN_PROGRESS → WORK_COMPLETED` | `tx_job_progress`, `txl_jobcard_task` |
| 15 | Costing | Verify no `inv_pending_price` rows for job; roll up totals | `total_job_cost = material + labour + general + outside`; variance computed | `cost_job_summary.total_job_cost` finalized; `cost_variance` written | `WORK_COMPLETED → PENDING_COSTING → PENDING_CLOSURE` | `cost_job_summary`, `cost_variance`, `inv_pending_price` |
| 16 | OM / workshop manager | Close job (gating checks pass) | Job locked; cost published | — | `PENDING_CLOSURE → CLOSED` | `tx_jobcard`, `apr_action` |
| 17 | System | Surface on dashboards | Exec sees cost per vehicle; Workshop sees closed job & turnaround | Reads `cost_job_summary` + `mv_stock_ledger` | — | Exec + Workshop dashboards |

**Traceability proof:** From the Exec dashboard cost figure for `LP-4521` you can drill
`cost_job_summary(JC-CMB-26-000502)` → `cost_job_line` → the `ISS`, `LUB`, `BAT/BRT`, `OSR`, `LAB`
documents → each `mv_stock_ledger` row → the originating `GRN` and `md_battery` serial → supplier
and the price effective on that date in `md_price_history`. **One connected chain, no dead ends.**

---

## 6. Design Principles Honored

| Principle | How it is enforced in UMMS |
|-----------|----------------------------|
| **No duplicate data** | One `md_item`, one `md_asset`, one `md_supplier`, one `md_employee`, one `md_location` — every module references, never copies. |
| **Shared masters** | Lubricants, spares, general items and battery models coexist in `md_item` (by `item_type`); vehicles + machines coexist in `md_asset`. |
| **Effective-date pricing** | Costing reads unit price **as of the transaction date** from `md_price_history`; MWAC recomputed on each priced receipt; un-priced receipts queue in `inv_pending_price`. |
| **Stock by location** | On-hand and MWAC held per `item_id × location_id` in `inv_stock_balance`; transfers post `XFER_OUT` + `XFER_IN`. |
| **Serial batteries** | Each physical battery is one `md_battery` serial with full lifecycle in `hist_battery_event`; original vs current vehicle always known. |
| **Audit everywhere** | Every table carries `created_by/at`, `updated_by/at`, `row_version`, `is_active`; approvable docs add `approved_by/at` + `site_id`; movements and approvals are append-only. |
| **One ledger** | Every stock-affecting line across all four modules writes `mv_stock_ledger` in the same transaction — the single truth for stock and value. |
| **Gated closure** | A job cannot reach `CLOSED` with open pending prices, missing parts, uncaptured labour or incomplete approvals (contract §7.7). |
