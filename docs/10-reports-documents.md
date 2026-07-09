# UMMS — Reports & Printable Documents Catalog

> **Scope of this document (Section 10).** The complete catalogue of reports and printable
> documents for **UMMS — Unified Master Management System** across all four operations: (A) Stores /
> Material, (B) Oil / Lubricant, (C) Battery (serial-tracked), (D) Workshop Job Card & Job Costing.
> Every report reads from the canonical tables defined in `00-design-contract.md` — this document does
> **not** redefine schema; it defines *what is printed / analysed*, *from which contract tables*, *with
> which filters*, and *who may run it*. All numbering follows `TYPE-SITE-YY-NNNNNN`; all valuation is
> **Moving Weighted Average Cost (MWAC)** read as-of transaction date via `md_price_history`.

---

## 0. Conventions Used In This Catalogue

| Aspect | Rule (per design contract) |
|--------|-----------------------------|
| **Site scoping** | Every report is filtered by `site_id` and intersected with the caller's `sec_user_site` rows. A user never sees a site they are not granted. `HO0` finance/admin roles may select "All Sites". |
| **Effective-date awareness** | Any report touching cost/price uses `md_price_history` *as-of* the transaction date (contract §6, §7.6). "As-at date" params snapshot balances from `mv_stock_ledger` cumulatively, not from live `inv_stock_balance`. |
| **Valuation** | Value columns = qty × `moving_avg_cost` from `inv_stock_balance`, or the ledger's captured `unit_cost` at movement time for historic rows. Provisional lines (in `inv_pending_price`) are flagged `~` and shown at provisional cost. |
| **Money / qty formatting** | Money `DECIMAL(18,2)` in `LKR`; qty `DECIMAL(18,4)`; rates `*_rate`/`unit_price`. |
| **Report type** | **Printable doc** = single-document reprint (legal/operational form). **Analytical** = multi-row MIS/decision report. **Statutory** = period register kept for audit/finance/tax. |
| **Output formats** | Screen (grid) / PDF (print) / Excel (.xlsx) / CSV. Printable docs are PDF-primary. |
| **Permissions** | Enforced via `sec_permission` + `sec_role_permission`. Export (Excel/CSV) is a *separate* permission from view. Cost-bearing columns are masked for roles without `COST_VIEW`. |
| **Audit** | Every report execution logs to the audit trail (who / when / params / row count). The **Audit Trail report itself is Admin + Finance only.** |

---

## 1. MASTER REPORT CATALOG

> Legend — **Type**: PD = Printable doc · AN = Analytical · ST = Statutory register.
> **Fmt**: S = Screen · P = PDF · X = Excel · C = CSV.

### 1.1 Stores / Material Management (Operation A)

| # | Report | Type | Purpose | Key filters / parameters | Key columns | Source tables (contract) | Fmt | Audience / role |
|---|--------|------|---------|--------------------------|-------------|--------------------------|-----|-----------------|
| A1 | **Stock Ledger report** | ST | Immutable running movement of an item at a location; the audit backbone of on-hand & value | `site_id`, `location_id`, `item_id`/category, date range, `mv_direction` (`MVDIR`) | Date, `mv_no`, Doc type & no, `mv_direction`, In qty, Out qty, `unit_cost`, Running bal qty, `moving_avg_cost`, Running value | `mv_stock_ledger`, `inv_stock_balance`, `md_item`, `md_location` | S/P/X/C | Store Keeper, Stores Manager, Finance |
| A2 | **Item Movement report** | AN | All movements of one item across locations; fast/slow, in vs out totals | `item_id`, date range, movement type, group by location/month | Item, Location, Opening, Total IN, Total OUT, Net, Closing, Value closing, Turns | `mv_stock_ledger`, `md_item`, `md_item_group` | S/X/C | Stores Manager, Materials Planner |
| A3 | **MRN report** | PD/AN | Reprint & register of Material Request Notes (indents), open vs fulfilled | `mrn_no`, `site_id`, requester, `doc_status` (`DOC`), date range | `mrn_no`, Date, Requested by, Dept/`cost_center`, Item, `requested_qty`, `issued_qty`, Balance, `doc_status` | `tx_mrn`, `txl_mrn`, `md_item`, `md_department` | S/P/X | Store Keeper, Section Head |
| A4 | **GRN report** | PD/ST | Goods receipt register + GRN reprint; QC & pricing state | `grn_no`, `po_no`, `supplier_id`, `site_id`, GRN status (`GRN`), date range | `grn_no`, `grn_date`, `po_no`, Supplier, Item, `received_qty`, `unit_price`, `line_amt`, GRN status, Priced? | `tx_grn`, `txl_grn`, `tx_po`, `md_supplier`, `md_item` | S/P/X/C | Store Keeper, Stores Manager, Finance |
| A9 | **Purchase Register** | ST | Statutory purchase log by supplier/period (feeds finance) | `site_id`, `supplier_id`, `supplier_type`, date range, PO type | `grn_no`, Date, Supplier, `po_no`, Item, Qty, `unit_price`, `line_amt`, Tax, Total, `cost_center` | `tx_grn`, `txl_grn`, `tx_po`, `md_supplier` | P/X/C | Finance, Procurement |
| A10 | **Supplier Spend report** | AN | Spend concentration, top suppliers, category spend | date range, `supplier_type`, category, `site_id` | Supplier, # GRNs, # Items, Total spend, % of spend, Avg lead time, On-time % | `tx_grn`, `txl_grn`, `md_supplier`, `md_item_category` | S/X/C | Procurement, Management |
| A11 | **Monthly Stock Balance report** | ST | Month-end on-hand qty & value snapshot per item/location | `as_at_month`, `site_id`, `location_id`, category | Item, Location, Closing qty, `moving_avg_cost`, Closing value, Slow-moving flag | `mv_stock_ledger` (period cut), `inv_stock_balance`, `md_item` | P/X/C | Stores Manager, Finance |
| A12 | **Reorder / Low-stock report** | AN | Items at/below reorder level; suggested order qty | `site_id`, category, "below reorder only", supplier | Item, Location, On-hand, Reserved, Available, Reorder level, ROQ suggestion, Preferred supplier, Last price | `inv_stock_balance`, `inv_reservation`, `md_item`, `md_price` | S/X/C | Store Keeper, Materials Planner |
| A13 | **Transfer register** | ST | Inter-location transfers (both legs), in-transit tracking | `site_id`/from-to location, `trf_no`, date range, `doc_status` | `trf_no`, Date, From loc, To loc, Item, `transfer_qty`, `unit_cost`, `mv_direction` (XFER_OUT/IN), Status | `tx_transfer`, `txl_transfer`, `mv_stock_ledger`, `md_location` | S/P/X | Stores Manager, Store Keeper |
| A14 | **Stock Adjustment / Count report** | ST | Adjustments & physical-count variances with reason | `site_id`, `adj_no`, date range, reason code | `adj_no`, Date, Item, System qty, Counted qty, Variance qty, Variance value, Reason, Approver | `tx_adjustment`, `txl_adjustment`, `mv_stock_ledger` | S/P/X | Stores Manager, Finance, Audit |
| A15 | **Return register** | ST | Returns to supplier / store-backs | `site_id`, `ret_no`, `supplier_id`, date range | `ret_no`, Date, Supplier/Requester, Item, `return_qty`, `unit_cost`, Reason, Status | `tx_return`, `txl_return`, `md_supplier` | S/P/X | Store Keeper, Finance |
| A16 | **Pending Pricing report** | AN | Received-but-un-priced lines (provisional cost exposure) | `site_id`, `supplier_id`, age bucket, item | `grn_no`, Date, Item, `received_qty`, Provisional cost, Days pending, Linked jobs affected | `inv_pending_price`, `tx_grn`, `txl_grn`, `md_item` | S/X | Finance, Stores Manager |

### 1.2 Oil / Lubricant Stock Book (Operation B)

| # | Report | Type | Purpose | Key filters / parameters | Key columns | Source tables | Fmt | Audience / role |
|---|--------|------|---------|--------------------------|-------------|---------------|-----|-----------------|
| B1 | **Lubricant Issue report** | PD/AN | Register & voucher reprint of lubricant issues to assets/sites with meter reading | `site_id`, `lub_no`, `asset_id`, `item_id` (grade), date range | `lub_no`, Date, Asset/Reg no, Grade (`md_item`), `issue_qty`, `meter_reading`, `uom`, `unit_cost`, `line_amt`, Issued by | `tx_lube_issue`, `txl_lube_issue`, `md_asset`, `md_item` | S/P/X | Store Keeper, Workshop, Transport Mgr |
| B2 | **Vehicle/Machine-wise Lubricant Consumption** | AN | Consumption per asset with distance/hours; L/100km or L/hr efficiency & outlier detection | `asset_id`/`asset_class`, grade, date range, `site_id` | Asset, Reg/Plant no, Grade, Total issued qty, Meter start→end, Distance/Hours, **L per 100km / L per hr**, vs fleet avg, Cost | `tx_lube_issue`, `mv_stock_ledger` (LUBRICANT), `md_asset_vehicle`, `md_asset_machine` | S/X/C | Transport Mgr, Maintenance, Management |
| B3 | **Monthly Lubricant Balance report** | ST | Month-end lubricant stock book (opening/receipts/issues/closing per grade) | `as_at_month`, `site_id`, grade | Grade, Opening qty/val, Receipts, Issues, Adjust, Closing qty, `moving_avg_cost`, Closing value | `inv_lube_monthly_balance`, `mv_stock_ledger`, `md_item` | P/X/C | Stores Manager, Finance |
| B4 | **Lubricant Consumption vs Norm** | AN | Actual consumption against defined norm per asset class; over-consumption alerts | `asset_class`, grade, date range, threshold % | Asset, Norm (L/100km or L/hr), Actual, Variance %, Flag, # top-ups | `tx_lube_issue`, `md_asset`, `sys_setting` (norms) | S/X | Maintenance, Management |

### 1.3 Battery Stock Book — Serial Tracked (Operation C)

| # | Report | Type | Purpose | Key filters / parameters | Key columns | Source tables | Fmt | Audience / role |
|---|--------|------|---------|--------------------------|-------------|---------------|-----|-----------------|
| C1 | **Battery Lifecycle report** | PD/AN | Full cradle-to-grave history of a battery serial (issue→service→transfer→return→warranty→scrap) | `battery_serial_no`/`battery_id`, `item_id` (model), `battery_status` (`BATTERY`), date range | Serial, Model, Event date, Event type, From asset→To asset, `battery_status`, Doc no (`BAT`/`BTR`/`BRT`), Meter, User | `hist_battery_event`, `md_battery`, `md_asset` | S/P/X | Workshop, Stores Manager, Audit |
| C2 | **Battery-by-Vehicle report** | AN | Which battery serial(s) are fitted on each asset now / historically | `asset_id`/`asset_class`, `site_id`, "current only" toggle | Asset, Reg/Plant no, Current serial(s), Model, Fitted date, Age in service, Warranty end, Status | `md_battery`, `md_asset`, `hist_battery_event` | S/X/C | Transport Mgr, Workshop |
| C3 | **Warranty Due / Expired report** | AN | Batteries approaching or past warranty; claim candidates | `site_id`, window (e.g. next 30/60/90 days), `warranty_term`, status | Serial, Model, Fitted asset, `warranty_end_date`, Days to expiry, In-claim?, Supplier | `md_battery`, `md_warranty_term`, `md_supplier`, `hist_battery_event` | S/X | Workshop, Procurement, Finance |
| C4 | **Battery Issue / Transfer register** | ST | Register of battery issues, transfers, returns (movement control) | `site_id`, doc type (`BAT`/`BTR`/`BRT`), date range | Doc no, Date, Serial, Model, From→To asset/loc, Movement type, `battery_status`, User | `tx_battery_issue`, `tx_battery_transfer`, `tx_battery_return`, `hist_battery_event` | S/P/X | Store Keeper, Workshop |
| C5 | **Battery Failure / Scrap analysis** | AN | Failure rate & average life by model/supplier; premature-failure detection | model, supplier, date range, `site_id` | Model, Supplier, # issued, # scrapped, Avg service life (days), % under warranty at fail, MTBF proxy | `hist_battery_event`, `md_battery`, `md_warranty_term` | S/X | Procurement, Management, Maintenance |

### 1.4 Workshop Job Card & Job Costing (Operation D)

| # | Report | Type | Purpose | Key filters / parameters | Key columns | Source tables | Fmt | Audience / role |
|---|--------|------|---------|--------------------------|-------------|---------------|-----|-----------------|
| D1 | **Open Job Card report** | AN | All jobs not yet `CLOSED`; current workshop load & status board | `site_id`, `jobcard_status` (`JOBCARD`), `asset_id`, technician, date range | `jobcard_no`, Asset/Reg no, Opened date, `jobcard_status`, Days open, Assigned tech, Est cost, Actual-to-date | `tx_jobcard`, `txl_jobcard_task`, `md_asset`, `md_employee` | S/X | Transport Mgr, Workshop Supervisor |
| D2 | **Delayed / Overdue Job report** | AN | Jobs exceeding target TAT or stuck in `AWAITING_PARTS`/`AWAITING_OUTSIDE_REPAIR` | `site_id`, aging bucket, stuck sub-state, min days | `jobcard_no`, Asset, Status, Days in status, Blocking reason (parts/OSR), Pending MRQ/OSR no, Owner | `tx_jobcard`, `tx_job_progress`, `tx_job_material_req`, `tx_job_outside_repair` | S/X | Workshop Supervisor, Transport Mgr |
| D3 | **Job Costing Sheet** ⭐ | PD | The flagship printable — full cost dossier of one job: tasks, parts, labour, outside repair, roll-up & variance | `jobcard_no` (single), optional cost as-of date | Header + task lines + material lines (qty×`unit_cost`) + labour lines (hrs×`labour_rate`) + OSR lines + roll-up + est-vs-actual variance | `tx_jobcard`, `txl_jobcard_task`, `tx_job_parts`, `tx_job_labour`, `tx_job_outside_repair`, `cost_job_summary`, `cost_job_line`, `cost_variance` | P/X | Workshop Supervisor, Transport Mgr, Finance |
| D4 | **Labour Summary** | AN | Labour hours & cost by technician / job / period; utilisation | `site_id`, `employee_id`, `jobcard_no`, date range | Technician, Grade, `labour_rate`, Jobs, Total hrs, Labour cost, Idle vs charged, Utilisation % | `tx_job_labour`, `md_employee`, `md_labour_rate` | S/X/C | Workshop Supervisor, HR, Finance |
| D5 | **Material Consumption by Job** | AN | Parts/material issued & consumed per job; material cost driver | `jobcard_no`, `site_id`, `item_id`, date range | `jobcard_no`, Asset, Item, `issue_qty`, `unit_cost`, `line_amt`, Source (GRN/issue), `mrq_no` | `tx_job_parts`, `tx_job_material_req`, `txl_job_material_req`, `mv_stock_ledger` | S/X/C | Workshop, Finance |
| D6 | **Variance report (Est vs Actual)** | AN | Estimated vs actual cost by job / cost element; overrun analysis | `site_id`, date range, `jobcard_status`, min variance % | `jobcard_no`, Asset, Est cost, Actual cost, Variance amt, `variance_pct`, By element (labour/material/OSR/general) | `cost_variance`, `cost_job_summary`, `cost_job_line`, `tx_jobcard` | S/X | Transport Mgr, Finance, Management |
| D7 | **Job Card print** | PD | Operational reprint of the job card (defects, tasks, approvals) — the shop-floor form | `jobcard_no` | Header, asset & meter, reported defects, task lines, assigned techs, approval trail | `tx_jobcard`, `txl_jobcard_task`, `apr_request`, `apr_action` | P | Workshop, Driver, Transport Mgr |
| D8 | **Outside Repair register** | ST | Subcontracted repairs; cost & TAT by vendor | `site_id`, `supplier_id` (subcontractor), date range, `osr_no` | `osr_no`, `jobcard_no`, Vendor, Description, Sent/Recv date, TAT, Cost, Status | `tx_job_outside_repair`, `md_supplier`, `tx_jobcard` | S/P/X | Workshop, Procurement, Finance |
| D9 | **Asset Maintenance History / Cost** | AN | Lifetime jobs & cost per vehicle/machine; cost-per-km / per-hour | `asset_id`, `asset_class`, date range | Asset, # jobs, Total labour, Total material, Total OSR, Total cost, Cost/km or Cost/hr, Last service | `tx_jobcard`, `cost_job_summary`, `md_asset`, `md_asset_vehicle` | S/X | Transport Mgr, Maintenance, Management |

### 1.5 Cross-Module / Governance

| # | Report | Type | Purpose | Key filters / parameters | Key columns | Source tables | Fmt | Audience / role |
|---|--------|------|---------|--------------------------|-------------|---------------|-----|-----------------|
| G1 | **Audit Trail report** 🔒 | ST | Immutable who-did-what across documents, price/cost edits, approvals, overrides | entity/table, `user_id`, date range, action type, doc no | Timestamp, User, Role, Action, Table, Key/Doc no, Old→New value, Reason, Site | `apr_action`, audit columns on all `tx_*`/`md_*`, price/cost change log, `sec_user` | S/P/X | **Admin + Finance only** |
| G2 | **Approval Pending / SLA report** | AN | Documents stuck awaiting approval; who owns each step, ageing | workflow type, `apr_status` (`APR`), role, `site_id` | Doc type & no, Current step, Pending role/user, Days pending, Escalation due | `apr_request`, `apr_step`, `apr_action`, `sys_workflow_step` | S/X | Managers, Admin |
| G3 | **Price Change / Revaluation report** | ST | Effective-dated price changes & stock revaluations (provisional→confirmed) | `item_id`, date range, `price_status` (`PRICE`), `site_id` | Item, `effective_date`, Old price, New price, `price_status`, Reval qty, Reval value, Jobs recomputed | `md_price_history`, `md_price`, `inv_pending_price`, `mv_stock_ledger` | S/X | Finance, Stores Manager |
| G4 | **Stock Valuation Summary** | ST | Total inventory value by category/location for the balance sheet | `as_at_date`, `site_id`, `item_type`, category | Category, Location, On-hand qty, Value, % provisional, Slow/dead value | `inv_stock_balance`, `mv_stock_ledger`, `md_item_category` | P/X | Finance, Management |
| G5 | **Document Register (universal)** | ST | Any document series listing by type/site/year for sequence-integrity audit | `number_type` (MRN/PO/GRN/…), `site_id`, `YY` | Doc no, Type, Date, Status, Amount, Created by, Gaps flagged | `sys_number_series`, respective `tx_*` | S/X | Admin, Finance, Audit |

---

## 2. PRINTABLE DOCUMENT LAYOUTS (ASCII)

> All printable docs share a common **letterhead band** (site name & 3-letter code, address),
> a **document identity block** (doc no in `TYPE-SITE-YY-NNNNNN`, date, status), and a
> **signature band** (Prepared / Checked / Approved with `sec_user` name + role + `approved_at`).
> Cost columns are suppressed on copies printed by roles lacking `COST_VIEW`.

### 2.1 GRN Print — Goods Receipt Note

```
+===========================================================================================+
|  UMMS · UNIFIED MASTER MANAGEMENT SYSTEM              GOODS RECEIPT NOTE (GRN)             |
|  Site: COLOMBO CENTRAL STORES  [CMB]                                                       |
|  123 Fleet Road, Colombo 10                                                                |
+-------------------------------------------------------------------------------------------+
|  GRN No : GRN-CMB-26-000210        GRN Date : 2026-07-09      Status : QC_PASSED / PRICED  |
|  PO No  : PO-HO0-26-000045         PO Date  : 2026-06-28      GRN Type: LOCAL              |
|  Supplier : Lanka Lubricants (Pvt) Ltd   [SUP-0034]   Supplier Type: LOCAL                 |
|  Delivery Note / Invoice : DN-8891 / INV-5567          Received at Store/Bin: MAIN-STORE   |
+-------------------------------------------------------------------------------------------+
| Ln | Item Code | Description                | UoM | Ord Qty | Recv Qty | Unit Price |  Line Amt |
+----+-----------+----------------------------+-----+---------+----------+------------+-----------+
| 1  | LUB-15W40 | Engine Oil 15W40 (Diesel)  |  L  |  200.00 |  200.00  |    1,250.00|  250,000.00|
| 2  | FLT-OIL-1 | Oil Filter (Model X)       | NOS |   50.00 |   48.00  |      850.00|   40,800.00|
| 3  | SPR-BRK-9 | Brake Pad Set              | SET |   20.00 |   20.00  |    3,400.00|   68,000.00|
+----+-----------+----------------------------+-----+---------+----------+------------+-----------+
|                                                              Sub-total (LKR)   :   358,800.00 |
|                                                              Tax / VAT         :    (as cfg)  |
|                                                              GRAND TOTAL (LKR) :   358,800.00 |
+-------------------------------------------------------------------------------------------+
|  QC Result : PASSED (short-recv Ln2: 48/50 -> PARTIAL flag)     Pricing: CONFIRMED         |
|  Remarks   : 2 filters short-supplied; balance on back-order (see MRN-CMB-26-000123)       |
+-------------------------------------------------------------------------------------------+
|  Stock effect: each line -> mv_stock_ledger (mv_direction = IN); inv_stock_balance & MWAC |
|  recalculated. Un-priced lines would post to inv_pending_price (none here).                 |
+-------------------------------------------------------------------------------------------+
|  Prepared by: ______________  Checked (QC): ______________  Approved by: ______________    |
|  Store Keeper                  Stores Officer                Stores Manager  2026-07-09     |
+===========================================================================================+
  Source: tx_grn / txl_grn / tx_po / md_supplier / md_item / mv_stock_ledger
```

### 2.2 MRN / Indent Print — Material Request Note

```
+===========================================================================================+
|  UMMS                                             MATERIAL REQUEST NOTE (MRN / INDENT)     |
|  Site: KANDY WORKSHOP  [KND]                                                               |
+-------------------------------------------------------------------------------------------+
|  MRN No : MRN-KND-26-000123        Request Date : 2026-07-08     Status : APPROVED         |
|  Requested by : R. Perera  (Workshop Supervisor)     Department : WORKSHOP  [DEP-03]       |
|  Cost Center  : CC-WSHOP-KND        Required by : 2026-07-11      For Job : JC-KND-26-000502|
+-------------------------------------------------------------------------------------------+
| Ln | Item Code | Description                | UoM | Req Qty | Avail Qty | Iss Qty | Balance |
+----+-----------+----------------------------+-----+---------+-----------+---------+---------+
| 1  | SPR-BRK-9 | Brake Pad Set              | SET |   4.00  |   16.00   |   4.00  |   0.00  |
| 2  | LUB-15W40 | Engine Oil 15W40           |  L  |  30.00  |  150.00   |  30.00  |   0.00  |
| 3  | FLT-OIL-1 | Oil Filter (Model X)       | NOS |   2.00  |    0.00   |   0.00  |   2.00  |
+----+-----------+----------------------------+-----+---------+-----------+---------+---------+
|  Ln3 unavailable -> auto-suggest PO / back-order. Balance tracked until fulfilled.         |
+-------------------------------------------------------------------------------------------+
|  Justification : Scheduled brake service on lorry WP-CAB-4471 (JC-KND-26-000502)           |
|  Approval trail: SUBMITTED -> Section Head (APPROVED 2026-07-08) -> Stores (APPROVED)       |
+-------------------------------------------------------------------------------------------+
|  Requested by: ____________  Approved by: ____________  Issued by (Stores): ____________   |
+===========================================================================================+
  Source: tx_mrn / txl_mrn / md_item / md_department / md_cost_center / apr_request
  Note: MRN itself posts NO stock movement; the linked ISS/MRQ issue posts mv_stock_ledger (OUT).
```

### 2.3 Job Costing Sheet ⭐ (Flagship)

```
+===========================================================================================+
|  UMMS · WORKSHOP                                     J O B   C O S T I N G   S H E E T     |
|  Site: KANDY WORKSHOP  [KND]                                                               |
+-------------------------------------------------------------------------------------------+
|  Job Card No : JC-KND-26-000502            Opened : 2026-07-01    Status : PENDING_CLOSURE |
|  Asset : Lorry  WP-CAB-4471  (VEHICLE)     Make/Model : TATA LPT 1618   Meter : 184,320 km |
|  Job Type : Scheduled Service + Brake Job  Priority : HIGH        Closed : 2026-07-09      |
|  Reported by : Driver S. Silva   |  Assigned Supervisor : R. Perera                        |
+-------------------------------------------------------------------------------------------+
|  A. TASKS / DEFECTS (txl_jobcard_task)                                                      |
|  +----+--------------------------------------+-----------+-------------+------------------+ |
|  | T# | Task / Defect                        | Status    | Technician  | Std Hrs / Actual | |
|  +----+--------------------------------------+-----------+-------------+------------------+ |
|  | 1  | 10,000km scheduled service           | COMPLETED | K. Fernando |   3.0  /   3.5   | |
|  | 2  | Replace front brake pads             | COMPLETED | K. Fernando |   2.0  /   2.0   | |
|  | 3  | Diagnose & fix air-brake leak        | COMPLETED | M. Jayasin. |   4.0  /   5.5   | |
|  | 4  | Recondition brake drum (outside)     | COMPLETED |  (OSR)      |    -   /    -    | |
|  +----+--------------------------------------+-----------+-------------+------------------+ |
+-------------------------------------------------------------------------------------------+
|  B. PARTS / MATERIAL CONSUMED (tx_job_parts / mv_stock_ledger OUT)                          |
|  +----+-----------+------------------------+-----+--------+-----------+-----------+--------+ |
|  | Ln | Item Code | Description            | UoM | Qty    | Unit Cost | Line Amt  | Source | |
|  +----+-----------+------------------------+-----+--------+-----------+-----------+--------+ |
|  | 1  | SPR-BRK-9 | Brake Pad Set          | SET |  1.00  |  3,400.00 |  3,400.00 |MRQ..488| |
|  | 2  | LUB-15W40 | Engine Oil 15W40       |  L  | 24.00  |  1,250.00 | 30,000.00 |ISS OUT | |
|  | 3  | FLT-OIL-1 | Oil Filter (Model X)   | NOS |  1.00  |    850.00 |    850.00 |ISS OUT | |
|  | 4  | SPR-ABK-2 | Air-brake seal kit     | SET |  1.00  |  2,150.00~|  2,150.00~|PENDING | |
|  +----+-----------+------------------------+-----+--------+-----------+-----------+--------+ |
|  |  (~ = provisional cost; line in inv_pending_price — cost may revalue on price confirm)  | |
|  |                                          MATERIAL COST (LKR)      :        36,400.00    | |
+-------------------------------------------------------------------------------------------+
|  C. LABOUR (tx_job_labour · hrs x md_labour_rate as-of work date)                           |
|  +----+-------------+-------+--------+-----------+-----------+----------------------------+ |
|  | Ln | Technician  | Grade | Hours  | Rate/hr   | Line Amt  | Date                        | |
|  +----+-------------+-------+--------+-----------+-----------+----------------------------+ |
|  | 1  | K. Fernando |  G2   |  5.50  |    600.00 |  3,300.00 | 2026-07-02                  | |
|  | 2  | M. Jayasin. |  G3   |  5.50  |    750.00 |  4,125.00 | 2026-07-03                  | |
|  +----+-------------+-------+--------+-----------+-----------+----------------------------+ |
|  |                                          LABOUR COST (LKR)        :         7,425.00    | |
+-------------------------------------------------------------------------------------------+
|  D. OUTSIDE / SUBCONTRACT REPAIR (tx_job_outside_repair)                                    |
|  +----+-----------+--------------------------+--------------+------------+-----------------+ |
|  | Ln | OSR No    | Description              | Vendor       | Sent/Recv  | Cost (LKR)      | |
|  +----+-----------+--------------------------+--------------+------------+-----------------+ |
|  | 1  |OSR..0031  | Brake drum reconditioning| Kandy M/Works| 07-04/07-06|      8,500.00   | |
|  +----+-----------+--------------------------+--------------+------------+-----------------+ |
|  |                                          OUTSIDE REPAIR COST     :         8,500.00     | |
+-------------------------------------------------------------------------------------------+
|  E. GENERAL / OVERHEAD (cost_job_line, element = GENERAL)                                   |
|  |  Consumables & shop overhead (allocated)          :         1,200.00                    | |
+-------------------------------------------------------------------------------------------+
|  F. COST ROLL-UP & VARIANCE (cost_job_summary / cost_variance)                              |
|  +-------------------------+-------------+-------------+-------------+---------------------+ |
|  | Cost Element            | Estimated   | Actual      | Variance    | Variance %          | |
|  +-------------------------+-------------+-------------+-------------+---------------------+ |
|  | Material                |  34,000.00  |  36,400.00  |  +2,400.00  |     +7.06 %         | |
|  | Labour                  |   6,000.00  |   7,425.00  |  +1,425.00  |    +23.75 %  ⚠      | |
|  | Outside Repair          |   9,000.00  |   8,500.00  |    -500.00  |     -5.56 %         | |
|  | General / Overhead      |   1,000.00  |   1,200.00  |    +200.00  |    +20.00 %         | |
|  +-------------------------+-------------+-------------+-------------+---------------------+ |
|  | TOTAL JOB COST (LKR)    |  50,000.00  |  53,525.00  |  +3,525.00  |     +7.05 %         | |
|  +-------------------------+-------------+-------------+-------------+---------------------+ |
|  |  ⚠ Labour overrun > 20% threshold -> flagged for supervisor review before CLOSED.       | |
|  |  NOTE: 1 material line provisional (~) -> job cost may recompute on price confirmation.  | |
+-------------------------------------------------------------------------------------------+
|  Closure gate (contract §7.7): all parts accounted ✔ | no inv_pending_price for job ✘ (1)  |
|  labour captured ✔ | OSR costed ✔ | approvals complete ✔  =>  CANNOT CLOSE until price conf. |
+-------------------------------------------------------------------------------------------+
|  Costed by: ____________  Reviewed (Finance): ____________  Approved / Closed by: __________|
|  Cost Clerk               Finance Officer                  Transport Manager   2026-07-09   |
+===========================================================================================+
  Source: tx_jobcard · txl_jobcard_task · tx_job_parts · tx_job_labour ·
          tx_job_outside_repair · cost_job_summary · cost_job_line · cost_variance ·
          md_asset(_vehicle) · md_employee · md_labour_rate · md_price_history · inv_pending_price
```

### 2.4 Lubricant Issue Voucher

```
+===========================================================================================+
|  UMMS · OIL & LUBRICANT STORE                        L U B R I C A N T   I S S U E         |
|  Site: KANDY  [KND]                                                                        |
+-------------------------------------------------------------------------------------------+
|  Issue No : LUB-KND-26-000318      Issue Date : 2026-07-09     Status : POSTED             |
|  Issued to Asset : Lorry WP-CAB-4471 (VEHICLE)   Plant/Reg No : WP-CAB-4471                |
|  (or) Site/Dept  : —                             Meter Type : ODOMETER                     |
|  Meter Reading   : 184,320 km        Prev Reading : 174,100 km    Distance : 10,220 km     |
|  Linked Job Card : JC-KND-26-000502              Issued by : Store Keeper A. Bandara       |
+-------------------------------------------------------------------------------------------+
| Ln | Grade (Item)    | Item Code | UoM | Issue Qty | Unit Cost | Line Amt   |             |
+----+-----------------+-----------+-----+-----------+-----------+------------+             |
| 1  | Engine Oil 15W40| LUB-15W40 |  L  |   24.00   |  1,250.00 |  30,000.00 |             |
| 2  | Gear Oil 90     | LUB-GO90  |  L  |    4.00   |  1,480.00 |   5,920.00 |             |
+----+-----------------+-----------+-----+-----------+-----------+------------+             |
|                                             TOTAL (LKR)  :     35,920.00                   |
+-------------------------------------------------------------------------------------------+
|  Consumption note: 24 L over 10,220 km => 0.235 L/100km (vs fleet norm 0.25) — WITHIN NORM |
|  Stock effect: mv_stock_ledger OUT for each grade; inv_stock_balance reduced; feeds B2/B3. |
+-------------------------------------------------------------------------------------------+
|  Received by (Driver/Operator): ____________   Issued by: ____________   Auth: ____________|
+===========================================================================================+
  Source: tx_lube_issue / txl_lube_issue / md_asset(_vehicle) / md_item / mv_stock_ledger
  Rule (contract §7.5): asset_id (or site_id+department_id) AND meter_reading are MANDATORY.
```

### 2.5 Battery Issue / Transfer Note

```
+===========================================================================================+
|  UMMS · BATTERY STORE (SERIAL CONTROLLED)            B A T T E R Y   I S S U E / TRANSFER  |
|  Site: COLOMBO  [CMB]                                                                      |
+-------------------------------------------------------------------------------------------+
|  Doc No : BAT-CMB-26-000077   (Transfer -> BTR-... / Return -> BRT-...)                    |
|  Doc Date : 2026-07-09        Movement Type : ISSUE        Status : IN_SERVICE             |
|  Battery Serial : BATT-N150-88231     Model (Item) : Exide N150 12V  [BAT-N150]            |
|  Acquisition Cost (md_battery) : 42,500.00     Warranty End : 2028-07-09  (24 mo)          |
+-------------------------------------------------------------------------------------------+
|  FROM  : Battery Store  [CMB-BAT-BIN]   /  Asset : —                                       |
|  TO     : Asset  Bus NB-1234 (VEHICLE)  /  Position : Main   Meter : 210,540 km            |
|  (Transfer only) From Asset ______  ->  To Asset ______                                    |
+-------------------------------------------------------------------------------------------+
|  Prev battery on target asset : BATT-N150-77120 -> returned via BRT-CMB-26-000006 (SCRAP)  |
|  Reason : Previous unit failed (dead cell) — replacement under new issue                   |
+-------------------------------------------------------------------------------------------+
|  Lifecycle effect (contract §7.4):                                                         |
|   - hist_battery_event append: EVENT=ISSUE, from BIN -> asset NB-1234                       |
|   - md_battery.current_asset_id = NB-1234 ; battery_status IN_STOCK -> ISSUED -> IN_SERVICE |
|   - Serialized valuation: carried at md_battery acquisition cost (no MWAC blend)            |
+-------------------------------------------------------------------------------------------+
|  Issued by: ____________   Fitted by (Tech): ____________   Approved by: ____________      |
+===========================================================================================+
  Source: tx_battery_issue / tx_battery_transfer / tx_battery_return /
          hist_battery_event / md_battery / md_asset / md_warranty_term
```

---

## 3. REPORT CONTROLS & GOVERNANCE

### 3.1 Site scoping (default on every report)

```
Effective rows = report_rows
                 WHERE site_id IN (SELECT site_id FROM sec_user_site WHERE user_id = :caller)
                 [ AND site_id = :selected_site   -- when user narrows to one site ]

- Non-privileged roles: site picker limited to their sec_user_site grants.
- HO0 Finance / Admin (permission ALL_SITE_VIEW): may select "All Sites" or any single site.
- Cross-site reports (e.g. Supplier Spend, Stock Valuation) require ALL_SITE_VIEW to aggregate.
```

### 3.2 Effective-date awareness

| Report family | Date semantics |
|---------------|----------------|
| Balance / valuation (A11, B3, G4) | "As-at date" → cumulative from `mv_stock_ledger` up to date; does **not** trust live `inv_stock_balance` for historic dates. |
| Costing (D3, D6, D9) | Cost read **as-of transaction date** via `md_price_history` (contract §6, §7.6). Provisional (`~`) lines shown at provisional cost with recompute flag. |
| Price / reval (G3) | Ordered by `effective_date`; shows provisional→confirmed transitions and revaluation movements. |
| Movement / register (A1, A13, C4, G5) | Filter by document/movement date range; append-only sources guarantee reproducibility. |

### 3.3 Export & column permissions

| Permission (`sec_permission`) | Controls |
|-------------------------------|----------|
| `RPT_VIEW_<module>` | Right to open/run the report on screen |
| `RPT_EXPORT` | Right to export **any** report to Excel/CSV (separate from view) |
| `COST_VIEW` | Unmasks `unit_cost` / `*_amt` / `*_cost` / valuation columns; without it, cost columns render as `••••` |
| `ALL_SITE_VIEW` | Cross-site aggregation & "All Sites" selector |
| `RPT_AUDIT` | **Audit Trail report (G1) — Admin + Finance only** |
| `PRICE_EDIT` | Appears in Price Change report (G3) as an actor; edits logged |

### 3.4 Governance rules

| Rule | Enforcement |
|------|-------------|
| Audit Trail (G1) restricted | Only roles holding `RPT_AUDIT` (Admin, Finance). Attempted access by others is itself audit-logged. |
| Every run logged | Report id, params, `site_id` scope, `user_id`, `run_at`, row count → audit sink. |
| No live edits from reports | Reports are strictly read-only; corrections flow only through source documents (adjustment/return/void), never by editing a report. |
| Reprint watermarking | Printable docs (§2) re-printed after first print carry a `REPRINT / <count>` watermark and reprint is audit-logged. |
| Provisional disclosure | Any report showing cost must flag provisional (`~`) lines and disclose exposure (ties to A16 Pending Pricing). |
| Sequence integrity | Document Register (G5) flags gaps in `sys_number_series` per type/site/year for audit. |

### 3.5 Standard report footer (all outputs)

```
Generated: 2026-07-09 14:32 by A.Bandara (Store Keeper, CMB) | Site scope: CMB |
Params: {item_type=LUBRICANT, from=2026-07-01, to=2026-07-09} | Rows: 128 |
Valuation: MWAC as-of txn date | Provisional lines marked ~ | Page 1/3 | UMMS v1.0
```

---

## 4. Report-to-Source Traceability Matrix (quick index)

| Report ID | Primary source table(s) | Movement/ledger link | Costing/price link |
|-----------|-------------------------|----------------------|--------------------|
| A1 Stock Ledger | `mv_stock_ledger` | self | `inv_stock_balance.moving_avg_cost` |
| A4 GRN / A9 Purchase Reg | `tx_grn`,`txl_grn` | `mv_stock_ledger` IN | `md_price_history`, `inv_pending_price` |
| A11 Monthly Balance / G4 Valuation | `inv_stock_balance` + `mv_stock_ledger` cut | period | MWAC |
| A16 Pending Pricing | `inv_pending_price` | pending IN | provisional cost |
| B1/B2 Lubricant | `tx_lube_issue`,`txl_lube_issue` | `mv_stock_ledger` OUT (LUBRICANT) | MWAC |
| C1–C5 Battery | `hist_battery_event`,`md_battery` | battery docs (BAT/BTR/BRT) | `md_battery` acq. cost |
| C3 Warranty | `md_battery`,`md_warranty_term` | — | — |
| D3 Job Costing Sheet | `cost_job_summary`,`cost_job_line`,`cost_variance` | job parts → `mv_stock_ledger` OUT | `md_labour_rate`,`md_price_history` |
| D6 Variance | `cost_variance` | — | est vs actual |
| G1 Audit Trail 🔒 | `apr_action` + audit cols | all | price/cost edit log |
| G3 Price Change | `md_price_history` | reval movements | provisional→confirmed |

---

*End of Section 10 — Reports & Printable Documents. All names, prefixes, numbering
(`TYPE-SITE-YY-NNNNNN`), status groups (`DOC`/`GRN`/`PRICE`/`MVDIR`/`JOBCARD`/`BATTERY`/`APR`),
and MWAC valuation conform to `00-design-contract.md`. New permission codes introduced here
(`RPT_VIEW_*`, `RPT_EXPORT`, `COST_VIEW`, `ALL_SITE_VIEW`, `RPT_AUDIT`) follow the `sec_`
family and require registration in `sec_permission`.*
