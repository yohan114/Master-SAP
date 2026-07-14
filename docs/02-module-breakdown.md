# UMMS — Module Breakdown

> **Governing contract:** [`00-design-contract.md`](./00-design-contract.md). All table names,
> numbering codes (`TYPE-SITE-YY-NNNNNN`), status vocabularies, shared masters and MWAC valuation
> are reused verbatim. This document enumerates every submodule, its masters, transaction types,
> approvals, reports, alerts and dashboards. New objects introduced here follow the contract's
> prefix + naming rules and are flagged **[NEW]**.

**Legend for transaction codes:** `MRN` `PO` `GRN` `ISS` `TRF` `ADJ` `RET` `LUB` `BAT` `BTR`
`BRT` `JC` `MRQ` `LAB` `OSR` — see contract §4.

---

## Module 0 — Shared Masters & Admin

The foundation. Every other module reads these; none re-creates them.

| Submodule | Purpose | Masters used | Transaction types | Approvals | Key reports | Alerts | Dashboard(s) |
|-----------|---------|--------------|-------------------|-----------|-------------|--------|--------------|
| Item master | Unified catalogue for STORE/LUBRICANT/BATTERY/SPARE/GENERAL/CONSUMABLE | `md_item`, `md_item_category`, `md_item_group`, `md_uom`, `md_uom_conversion` | — (master maintenance) | Item create/deactivate approval (optional workflow) | Item catalogue, category tree, duplicate-item check | Missing UoM/category; inactive item still transacting | Admin / data-quality |
| Asset master | Unified fleet + plant register | `md_asset`, `md_asset_vehicle`, `md_asset_machine` | — | Asset onboarding sign-off | Fleet list, meter register, asset-by-site | Asset with no meter type; duplicate reg no | Admin |
| Supplier / vendor | One supplier list incl. subcontractors | `md_supplier` (`LOCAL/HEAD_OFFICE/SUBCONTRACTOR`) | — | Vendor approval | Supplier directory, vendor-by-type | Blocked/inactive vendor on open PO | Admin |
| People & rates | Technicians and hourly rates | `md_employee`, `md_labour_rate`, `md_approval_role` | — | Rate change approval | Technician list, effective labour rates | Rate expired / none effective on date | Admin |
| Location tree | Site → store → bin hierarchy for stock + RLS | `md_location` (`SITE/STORE/BIN`) | — | — | Location hierarchy, bin map | Store with no bins; site code missing | Admin |
| Pricing | Current + effective-dated price | `md_price`, `md_price_history` | — (fed by GRN/price entry) | Price confirm approval | Price list, price change history, as-of price | Provisional prices outstanding | Stores / Admin |
| Dimensions | Cost analysis dimensions | `md_project`, `md_department`, `md_cost_center` | — | — | Cost-by-project/dept/CC | Unmapped transactions | Exec |
| Warranty terms | Warranty definitions (battery/asset) | `md_warranty_term` | — | — | Warranty catalogue | Term unassigned on serialized item | Battery |
| System & security | Numbering, statuses, users, roles, sites | `sys_number_series`, `sys_status`, `sys_code`, `sys_setting`, `sec_user`, `sec_role`, `sec_user_role`, `sec_permission`, `sec_role_permission`, `sec_user_site` | — | Role/permission change approval | User-access matrix, number-series usage, status master | Number series near exhaustion; user without site access | Admin |
| Attachments | Files, serial photos, scanned GRNs | `doc_*` | — | — | Document register | Missing mandatory attachment (e.g., battery serial photo) | Admin |

---

## Module A — Stores / Material Management

Covers indenting, purchasing (local + HO), receiving, valuation, issues, transfers, adjustments,
returns, balances and pending-price tracking.

| Submodule | Purpose | Masters used | Transaction types | Approvals | Key reports | Alerts | Dashboard(s) |
|-----------|---------|--------------|-------------------|-----------|-------------|--------|--------------|
| Material request (indent) | Raise demand for items (incl. MRN items from job/dept) | `md_item`, `md_location`, `md_department`, `md_project` | **MRN** (`tx_mrn`/`txl_mrn`) | Indent approval (dept/store) | Open indents, MRN aging | Overdue MRN not converted to PO | Stores |
| Local purchase | Buy from local suppliers | `md_supplier(LOCAL)`, `md_item`, `md_price` | **PO** (`tx_po`/`txl_po`, `po_type=LOCAL`) | PO approval (value threshold) | Local PO register, PO vs MRN | PO pending approval; price above last | Stores |
| HO purchase | Central / head-office procurement | `md_supplier(HEAD_OFFICE)`, `md_item` | **PO** (`po_type=HEAD_OFFICE`) | HO PO approval | HO PO register, HO vs local split | HO PO awaiting dispatch | Stores / Exec |
| Goods receiving & valuation | Receive against PO, QC, price, post to stock | `md_item`, `md_supplier`, `md_price`, `md_price_history` | **GRN** (`tx_grn`/`txl_grn`) | GRN posting / QC sign-off | GRN register, receipt-vs-order, valuation report | Receipt price ≠ PO price; QC failed | Stores |
| Price received / date tracking | Capture price + date; queue un-priced receipts | `md_price_history`, `inv_pending_price` | GRN (priced/un-priced) | Price confirm | Pending-price list, price-received-date report | Un-priced receipts aging in `inv_pending_price` | Stores |
| General items & issues | Issue stock / general items to dept, site, job | `md_item`, `md_location`, `md_department` | **ISS** (`tx_issue`/`txl_issue`) | Issue approval (for high value) | Issue register, issue-by-dept/asset | Issue below reorder; negative-stock override used | Stores / Workshop |
| Inter-location transfer | Move stock store↔store / bin↔bin | `md_location`, `md_item` | **TRF** (`tx_transfer`/`txl_transfer`) | Transfer approval | Transfer register, in-transit report | Transfer received short; in-transit aging | Stores |
| Stock adjustment / count | Cycle count, corrections | `md_item`, `md_location` | **ADJ** (`tx_adjustment`/`txl_adjustment`) | Adjustment approval (mandatory) | Count variance, adjustment log | Adjustment above tolerance | Stores |
| Return to supplier / store back | Return goods to vendor or unused parts to store | `md_supplier`, `md_item` | **RET** (`tx_return`/`txl_return`) | Return approval | Return register, supplier return summary | Return pending credit note | Stores |
| Stock balance & valuation | On-hand + MWAC by item/location/category/date | `md_item`, `md_location`, `md_item_category` | — (reads ledger) | — | Stock balance by item/location/category/date, valuation, dead/slow stock | Below-reorder; overstock; zero-movement | Stores / Exec |
| Movement history | Full audit of every in/out | — | — (reads `mv_stock_ledger`) | — | Item movement card, ledger by direction (`IN/OUT/XFER/ADJ/RET`) | — | Stores |

**Stores movement → ledger mapping:**

| Transaction | `mv_stock_ledger` direction | Valuation effect |
|-------------|-----------------------------|------------------|
| GRN (priced) | `IN` | Recompute `inv_stock_balance.moving_avg_cost` (MWAC) |
| GRN (un-priced) | `IN` at provisional | Row queued in `inv_pending_price`; revaluation on confirm |
| ISS | `OUT` | At current MWAC |
| TRF | `XFER_OUT` + `XFER_IN` | Cost carried to destination |
| ADJ | `ADJ_IN` / `ADJ_OUT` | Value change booked |
| RET | `RET_OUT` (to supplier) / `RET_IN` (store back) | Reverses at layer/MWAC |

---

## Module B — Oil / Lubricant

Lubricants are `md_item` rows (`item_type=LUBRICANT`) — no separate product master — but with
lube-specific issue, mapping, monthly balance and consumption planning.

| Submodule | Purpose | Masters used | Transaction types | Approvals | Key reports | Alerts | Dashboard(s) |
|-----------|---------|--------------|-------------------|-----------|-------------|--------|--------------|
| Lube product master | Oil/grease grades as items | `md_item(LUBRICANT)`, `md_item_group`, `md_uom` | — | Item approval | Lube product list, grade catalogue | Grade with no reorder level | Lubricant |
| Lube receipt | Receive lubricant stock (reuses stores GRN) | `md_supplier`, `md_item`, `md_price_history` | **GRN** | GRN posting | Lube GRN register | Price change vs last | Lubricant / Stores |
| Site / asset issue | Issue lube to vehicle/machine or site with meter | `md_asset`, `md_location`, `md_department`, `md_project` | **LUB** (`tx_lube_issue`/`txl_lube_issue`) | Issue approval (site) | Lube issue register | Issue without meter reading | Lubricant / Workshop |
| Vehicle/machine-wise history | Per-asset consumption over time | `md_asset` | — (reads ledger filtered LUBRICANT) | — | Vehicle-wise / machine-wise issue history, litres-per-meter | Abnormal consumption (leak?) | Lubricant |
| Mapping to dimensions | Attribute consumption to vehicle/machine/project/site/dept | `md_asset`, `md_project`, `md_location`, `md_department` | LUB (carries these keys) | — | Consumption by project/site/dept | Unmapped issue | Lubricant / Exec |
| Monthly balance | Month-end lubricant snapshot | `md_item`, `md_location` | — (`inv_lube_monthly_balance`) | Month-end lock | Monthly opening/receipt/issue/closing | Snapshot not run for period | Lubricant |
| Consumption planning / forecast | Forecast + reorder planning | `md_item`, `md_asset` | — | — | Forecast vs actual, consumption trend, reorder plan | Projected stock-out; below reorder | Lubricant |
| Lube price history | Effective-dated lube pricing | `md_price_history` | — | Price confirm | Lube price history, cost trend | Provisional lube price outstanding | Lubricant / Stores |

**Contract rule honored:** every `LUB` issue requires `asset_id` (or `site_id`+`department_id`)
**and** `meter_reading` (contract §7.5) so consumption is traceable by asset, site and date; each
issue posts an `OUT` row to `mv_stock_ledger` at MWAC.

---

## Module C — Battery (Serial-Controlled)

Every physical battery is one serial row in `md_battery`. Battery models are `md_item`
(`item_type=BATTERY`, `is_serial_tracked=1`). All movements append to `hist_battery_event`.

| Submodule | Purpose | Masters used | Transaction types | Approvals | Key reports | Alerts | Dashboard(s) |
|-----------|---------|--------------|-------------------|-----------|-------------|--------|--------------|
| Battery master / serial register | Brand, type, serial, size, warranty, supplier, price, GRN date, image | `md_battery`, `md_item(BATTERY)`, `md_supplier`, `md_warranty_term`, `md_price_history`, `doc_*` (serial photo) | GRN on receipt | Serial register create | Serial register, battery-by-brand/size | Serial photo missing; warranty term unset | Battery |
| Serial tracking & location | Where each serial is now (asset or store) | `md_battery`, `md_asset`, `md_location` | — | — | Serial location, batteries-in-stock vs in-service | Serial with stale `current_asset_id` | Battery |
| Original vs current vehicle | Track first-fit vs present vehicle + transfer chain | `md_battery` (`original_asset_id`, `current_asset_id`), `md_asset` | BTR (drives change) | — | Original-vs-current, transfer history per serial | Current asset inactive | Battery |
| Punch / issue | Issue battery to a vehicle/machine | `md_battery`, `md_asset` | **BAT** (`tx_battery_issue`) | Issue approval | Issue register, in-service list | Issue to asset already having active battery | Battery / Workshop |
| Transfer asset→asset | Move a battery between vehicles | `md_battery`, `md_asset` | **BTR** (`tx_battery_transfer`) | Transfer approval | Transfer history | Frequent transfers (fault?) | Battery |
| Return / replacement / scrap / warranty / repair | End-of-life and RMA handling | `md_battery`, `md_supplier`, `md_warranty_term` | **BRT** (`tx_battery_return`) | Scrap/warranty approval (mandatory) | Return/scrap/warranty-claim register, RMA status | Warranty expiring; claim pending; scrap unapproved | Battery |
| Lifecycle log | Immutable full history per serial | `md_battery` | — (`hist_battery_event`) | — | Serial lifecycle timeline | — | Battery |

**Battery status flow (contract §5):**
`IN_STOCK → ISSUED → IN_SERVICE → TRANSFERRED → RETURNED → UNDER_WARRANTY_CLAIM → REPAIRED →
SCRAPPED` (+ `REPLACED`, `LOST`). Every `BAT/BTR/BRT` updates `md_battery.current_asset_id` +
`battery_status` and appends to `hist_battery_event` in the same transaction (contract §7.4).
Serialized batteries are valued at their own acquisition cost on `md_battery` (contract §6).

---

## Module D — Job Card / Workshop

The demand engine: creates work from transport, approves TM→OM, routes to the workshop, pulls
parts/lube/battery from the other modules, captures labour and outside repair, and rolls up the
final cost.

| Submodule | Purpose | Masters used | Transaction types | Approvals | Key reports | Alerts | Dashboard(s) |
|-----------|---------|--------------|-------------------|-----------|-------------|--------|--------------|
| Job card creation (from transport) | Raise job for a vehicle/machine with defect tasks | `md_asset`, `md_location`, `md_project`, `md_department` | **JC** (`tx_jobcard`) + `txl_jobcard_task` | — (moves to approval) | Job register, jobs-by-asset | Repeat job for same defect | Workshop |
| TM approval | Transport Manager approves scope | `md_approval_role` | JC | **TM step** (`JOBCARD_APPROVAL`) | Pending-TM queue | Job stuck at TM | Workshop |
| OM approval | Operational Manager final approval | `md_approval_role` | JC | **OM step** | Pending-OM queue | Job stuck at OM | Workshop |
| Workshop routing & start | Assign bay/technician, set start date | `md_employee`, `md_location` | JC / `tx_job_progress` | — | Bay load, assignment board | Assigned but not started | Workshop |
| Daily work log / progress | Ongoing daily work-done entries | `md_employee` | `tx_job_progress` | — | Progress log, jobs-in-progress | No progress logged N days | Workshop |
| Internal parts request | Request + receive parts from own stores | `md_item`, `md_location` | **MRQ** (`tx_job_material_req`) → reserves → **ISS** | MRQ approval | Parts requested vs received | Reserved not issued; awaiting parts | Workshop / Stores |
| External parts request | Parts bought specifically for the job | `md_item`, `md_supplier` | **MRQ** → **PO** → **GRN** → **ISS** | MRQ + PO approval | External-parts status | GRN pending for job | Workshop / Stores |
| Parts received vs job card | Reconcile issued/consumed parts to the job | `md_item` | `tx_job_parts` (links ISS/GRN) | — | Parts-vs-jobcard reconciliation | Received ≠ consumed | Workshop |
| Lube on job | Oil top-up traceable to job + asset | `md_asset`, `md_item(LUBRICANT)` | **LUB** (carries `jobcard_id`) | Issue approval | Lube-on-job report | Missing meter on job lube | Workshop / Lubricant |
| Battery on job | Battery swap done under a job | `md_battery`, `md_asset` | **BAT/BTR/BRT** (carry `jobcard_id`) | Battery approval | Battery-on-job report | Warranty battery scrapped | Workshop / Battery |
| Outside / subcontract repair | Send components/vehicle to external specialist | `md_supplier(SUBCONTRACTOR)` | **OSR** (`tx_job_outside_repair`) | OSR approval | Outside-repair register | Overdue outside repair | Workshop |
| Labour entry | Technician, date, hours, rate | `md_employee`, `md_labour_rate` | **LAB** (`tx_job_labour`) | Labour approval | Labour-by-technician/job | Hours without effective rate | Workshop |
| Cost breakdown | Labour/material/general/outside → total | — | — (`cost_job_summary`, `cost_job_line`, `cost_variance`) | — | Job cost sheet, estimate-vs-actual variance | Variance above tolerance | Workshop / Exec |
| Close gating | Enforce closure preconditions | — | JC | Close approval | Closure checklist | Pending price/parts/labour block close | Workshop |
| Job dashboards | Open / pending / delayed / completed | `md_asset`, `md_location` | — | — | Open, pending, delayed, completed jobs; turnaround time | SLA breach; delayed jobs | Workshop / Exec |

**Job cost roll-up:**

```
cost_job_summary
  material_cost  <- sum(mv_stock_ledger OUT where jobcard_id)  [ISS parts + LUB oil]
  labour_cost    <- sum(tx_job_labour hours x md_labour_rate as-of date)
  general_cost   <- sum(general items / consumables issued to job)
  outside_repair_cost   <- sum(tx_job_outside_repair priced amounts)
  ------------------------------------------------------------------
  total_job_cost = material + labour + general + outside
cost_variance    = estimated vs actual (per element + total)
```

**Job card status flow (contract §5):**
`DRAFT → PENDING_TM_APPROVAL → PENDING_OM_APPROVAL → APPROVED → ASSIGNED_WORKSHOP → IN_PROGRESS
(⇄ AWAITING_PARTS / AWAITING_OUTSIDE_REPAIR) → WORK_COMPLETED → PENDING_COSTING → PENDING_CLOSURE
→ CLOSED`; side states `ON_HOLD`, `CANCELLED`, `REJECTED`.
**Closure gate (contract §7.7):** no rows in `inv_pending_price` for the job, all parts
received/accounted, labour captured, outside-repair costs entered, all approvals complete.

---

## Module E — Approvals / Workflow (Generic Engine, Reused Everywhere)

One engine drives every approval in UMMS — no module hard-codes its own sign-off.

| Submodule | Purpose | Masters used | Transaction types | Approvals | Key reports | Alerts | Dashboard(s) |
|-----------|---------|--------------|-------------------|-----------|-------------|--------|--------------|
| Workflow definition | Define named workflows + ordered steps + roles | `md_approval_role`, `sec_role` | — (`sys_workflow`, `sys_workflow_step`) | Config change approval | Workflow catalogue | Step with no eligible approver | Admin |
| Approval instance | Bind a request to a source document | — | — (`apr_request`) | — | Requests by document/status | Request without approver | Admin / all |
| Step state | Per-step pending/approved state | — | — (`apr_step`) | — | Step aging | Step overdue (SLA) | All modules |
| Action log | Immutable approve/reject/return/escalate/delegate | `sec_user` | — (`apr_action`) | — | Approval audit trail, approver activity | Escalations rising | Admin / Exec |
| My approvals inbox | Role-based pending queue per user | `sec_user`, `sec_user_site` | — | — | My pending approvals, delegated items | Items pending > X days | All modules |

**Workflows in scope:**

| Workflow (`sys_workflow`) | Steps (`sys_workflow_step` → role) | Applies to |
|---------------------------|-------------------------------------|------------|
| `JOBCARD_APPROVAL` | 1: TM → 2: OM | `tx_jobcard` |
| `PO_APPROVAL` | value-threshold approver(s) | `tx_po` |
| `ADJUSTMENT_APPROVAL` | stores manager | `tx_adjustment` |
| `RETURN_APPROVAL` | stores manager | `tx_return` |
| `BATTERY_RETURN_APPROVAL` | workshop mgr → OM | `tx_battery_return` (scrap/warranty) |
| `PRICE_CONFIRM` | stores/finance | `md_price` / `inv_pending_price` |
| `MRQ_APPROVAL` | supervisor | `tx_job_material_req` |

**Approval action vocabulary (`APR`):** `PENDING`, `APPROVED`, `REJECTED`, `RETURNED`,
`ESCALATED`, `DELEGATED` — every action is an immutable `apr_action` row (contract §5, §3.6).

---

## Module → Shared Masters → Ledger Traceability Matrix

| Module / doc | Numbering | Shared masters referenced | Ledger / state effect | Costing effect |
|--------------|-----------|---------------------------|-----------------------|----------------|
| Stores — MRN | `MRN` | `md_item`, `md_location`, `md_department` | `inv_reservation` (optional) | — |
| Stores — PO | `PO` | `md_supplier`, `md_item`, `md_price` | — | — |
| Stores — GRN | `GRN` | `md_item`, `md_supplier`, `md_price_history` | `mv_stock_ledger` IN; `inv_stock_balance` MWAC; `inv_pending_price` if un-priced | Sets item cost basis |
| Stores — ISS | `ISS` | `md_item`, `md_location`, `md_asset?`, `md_department?` | `mv_stock_ledger` OUT at MWAC | → job `material_cost` if `jobcard_id` |
| Stores — TRF | `TRF` | `md_location`, `md_item` | `XFER_OUT` + `XFER_IN` | Cost carried |
| Stores — ADJ | `ADJ` | `md_item`, `md_location` | `ADJ_IN` / `ADJ_OUT` | Value change |
| Stores — RET | `RET` | `md_supplier`, `md_item` | `RET_OUT` / `RET_IN` | Reverses value |
| Lubricant — LUB | `LUB` | `md_item(LUBRICANT)`, `md_asset`, `md_location`, `md_project`, `md_department` | `mv_stock_ledger` OUT at MWAC (+ meter) | → job/asset consumption cost |
| Battery — BAT | `BAT` | `md_battery`, `md_item(BATTERY)`, `md_asset` | `hist_battery_event`; `md_battery` status/asset | → job cost (serial acquisition cost) |
| Battery — BTR | `BTR` | `md_battery`, `md_asset` | `hist_battery_event`; `current_asset_id` change | — |
| Battery — BRT | `BRT` | `md_battery`, `md_supplier`, `md_warranty_term` | `hist_battery_event`; status → RETURNED/SCRAPPED/WARRANTY | Scrap loss / warranty credit |
| Workshop — JC | `JC` | `md_asset`, `md_location`, `md_project` | — (drives all above via child docs) | `cost_job_summary` container |
| Workshop — MRQ | `MRQ` | `md_item`, `md_location` | `inv_reservation` on approval | — |
| Workshop — LAB | `LAB` | `md_employee`, `md_labour_rate` | — | → `labour_cost` |
| Workshop — OSR | `OSR` | `md_supplier(SUBCONTRACTOR)` | — | → `outside_repair_cost` |
| Approvals — apr | — | `md_approval_role`, `sec_user`, `sec_user_site` | — | Gates posting/closure |

**Single truth restated:** every stock-affecting line — regardless of module — writes exactly one
`mv_stock_ledger` row and atomically updates `inv_stock_balance` (contract §7.1); every battery
move appends to `hist_battery_event` (§7.4); every job cost reads price as-of date from
`md_price_history` (§6, §7.6); and nothing duplicates a master.
