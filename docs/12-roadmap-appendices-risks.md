# 12 — Implementation Roadmap, Appendices & Risk Register

> **Scope of this document.** Delivery sequencing, navigation, master hierarchy, numbering recap,
> alerts/exceptions, MVP-vs-Advanced phasing, and the risk register for **UMMS — Unified Master
> Management System**. All table names, codes, status vocabularies, numbering (`TYPE-SITE-YY-NNNNNN`)
> and MWAC valuation are defined in [`00-design-contract.md`](./00-design-contract.md) and are **referenced**, not restated, here.
> Business context: real transport fleet + workshop + stores operator running **STORES**, **LUBRICANT**,
> **BATTERY (serial)** and **JOB CARD + COSTING** on ONE platform over shared masters.

---

## 1. IMPLEMENTATION ROADMAP

### 1.0 Phasing principle

```
 Nothing is issued before it exists (masters) → nothing is costed before it is priced (valuation)
 → nothing is closed before it is approved (workflow). Each phase leaves a WORKING, POSTABLE system.

 P1 FOUNDATION + STORES ──► P2 LUBRICANT + BATTERY ──► P3 JOB CARD + COSTING ──► P4 ANALYTICS ──► P5 INTEGRATION
   shared masters, ledger      consumption + serial       approvals, reservations,   dashboards,     barcode/QR, WhatsApp,
   GRN/ISS/TRF, MWAC           warranty lifecycle          labour, outside repair     alerts, KPIs    API, BI, optional SAP
```

### 1.1 Phase 1 — Foundation Masters + Stores

| Field | Detail |
|-------|--------|
| **Phase** | **P1 — Foundation Masters + Stores** |
| **Scope** | Shared master data, security & sites, number series, append-only stock ledger, core stores documents (MRN → PO → GRN → Issue → Transfer → Adjustment → Return), MWAC valuation with pending-price handling, basic stores dashboards. |
| **Key deliverables** | `md_location` (Site>Store>Bin), `md_item` + `md_item_category` + `md_item_group`, `md_uom`/`md_uom_conversion`, `md_supplier`, `md_price`/`md_price_history`; `sys_number_series`, `sys_status`, `sys_code`; `sec_user`/`sec_role`/`sec_user_site`; `tx_mrn`, `tx_po`, `tx_grn`, `tx_issue`, `tx_transfer`, `tx_adjustment`, `tx_return` (+ `txl_*`); `mv_stock_ledger`, `inv_stock_balance`, `inv_pending_price`; GRN status flow `DRAFT→RECEIVED→QC→PRICED→POSTED`; Stock Balance / Stock Ledger / Pending-Price / Reorder screens. |
| **Data migrated** | Site/store/bin tree; item master (STORE/SPARE/GENERAL/CONSUMABLE first); supplier master; opening stock quantities **and** opening MWAC per `item_id × location_id` (loaded as an `ADJ_IN`/opening layer); last-known purchase prices into `md_price_history`. |
| **Exit criteria** | Every posted stores document writes `mv_stock_ledger` + updates `inv_stock_balance` atomically; opening stock reconciled to legacy trial balance ±0; a GRN→Issue→Balance chain is traceable end-to-end; number series issue correct `TYPE-SITE-YY-NNNNNN` with per-site/per-year reset; no negative stock without recorded override. |
| **Dependencies** | None (root phase). Requires cleansed location + item + supplier lists and signed-off opening balances. |
| **Success metric** | **100% of stores issues valued at a non-zero MWAC** and stock-on-hand accuracy ≥ 98% on first physical count after go-live. |
| **Indicative duration** | 8–10 weeks. |

### 1.2 Phase 2 — Lubricant + Battery

| Field | Detail |
|-------|--------|
| **Phase** | **P2 — Lubricant Stock Book + Battery Serial Register** |
| **Scope** | Lubricant issue to asset/site with meter reading, month-end lubricant balance snapshot; battery serial lifecycle (issue → in-service → transfer → return/warranty/scrap) with full event log and warranty tracking. |
| **Key deliverables** | `tx_lube_issue`/`txl_lube_issue` (mandatory `asset_id` or `site_id`+`department_id`, `meter_reading`), `inv_lube_monthly_balance`; `md_battery` serial register, `tx_battery_issue` (`BAT`), `tx_battery_transfer` (`BTR`), `tx_battery_return` (`BRT`), `hist_battery_event`, `md_warranty_term`; lubricant consumption-per-asset and battery-serial-history screens; warranty due/expiry alerts (seed). |
| **Data migrated** | Lubricant items flagged `item_type=LUBRICANT`; opening lubricant balances per store; existing battery population into `md_battery` with serial, model (`item_id`), current asset, purchase date, warranty term, and current `battery_status`; historical battery fitments seeded into `hist_battery_event` where records exist. |
| **Exit criteria** | Every lube issue traceable by asset + meter + date; month-end snapshot reproducible from ledger; each physical battery has exactly ONE `md_battery` row (no duplicate serials); every battery movement appends `hist_battery_event` AND updates `md_battery.current_asset_id` + `battery_status` in one transaction; warranty age computed correctly. |
| **Dependencies** | P1 (`md_item`, `md_asset`, `mv_stock_ledger`, valuation, sites). |
| **Success metric** | **Zero duplicate/unmatched battery serials** and 100% of lube issues carrying a valid meter reading (enables L/1000km and cost-per-asset analytics). |
| **Indicative duration** | 6–8 weeks. |

### 1.3 Phase 3 — Job Card + Costing

| Field | Detail |
|-------|--------|
| **Phase** | **P3 — Workshop Job Card + Job Costing** |
| **Scope** | Multi-step job card approval (TM → OM), workshop execution & daily progress, labour capture, material request/reservation against job (internal issue + external PO), outside/subcontract repair, close-gating, and cost roll-up with estimate-vs-actual variance. |
| **Key deliverables** | `tx_jobcard` (`JC`) + `txl_jobcard_task`, `tx_job_progress`; approval engine `sys_workflow`/`sys_workflow_step`/`apr_request`/`apr_step`/`apr_action` (workflow `JOBCARD_APPROVAL`); `tx_job_material_req` (`MRQ`) + `inv_reservation`; `tx_job_parts`, `tx_job_labour` (`LAB`) + `md_labour_rate`; `tx_job_outside_repair` (`OSR`); `cost_job_summary`, `cost_job_line`, `cost_variance`; JOBCARD status flow to `CLOSED` with close-gate enforcement. |
| **Data migrated** | Open/WIP job cards from legacy (header + tasks + already-consumed parts + labour to date); technician grades & effective labour rates into `md_labour_rate`; open outside-repair commitments. |
| **Exit criteria** | Job card cannot reach `CLOSED` while any row exists in `inv_pending_price` for the job, parts unaccounted, labour uncaptured, outside-repair cost missing, or approvals incomplete (contract §7.7); material reservation decrements availability without double-issuing; `cost_job_summary` = Σ material (MWAC) + labour + outside + general; variance computed vs estimate. |
| **Dependencies** | P1 (items, ledger, issue, pending-price), P2 (asset/battery/lube consumption feeds cost), approval engine. |
| **Success metric** | **100% of closed job cards fully costed with no un-priced parts**, and estimate-vs-actual variance available on every closed job. |
| **Indicative duration** | 10–12 weeks. |

### 1.4 Phase 4 — Dashboards, Analytics, Automation, Alerts

| Field | Detail |
|-------|--------|
| **Phase** | **P4 — Dashboards, Analytics & Automation** |
| **Scope** | Role/site dashboards, KPI analytics (fast/slow/dead stock, cost-per-asset, workshop throughput, variance), the full alert/exception engine (Appendix D), and automation (auto-reorder suggestion, auto-escalation of overdue approvals/jobs). |
| **Key deliverables** | Materialized KPI views over `mv_stock_ledger`/`cost_job_summary`; scheduled exception scanner writing to an alert queue; dashboards per role (Storekeeper, Workshop Foreman, TM, OM, Cost Controller); slow/dead-stock and reorder analytics; automated escalation on `apr_step` SLA breach. |
| **Data migrated** | None new — reads P1–P3 transactional data; back-fills KPI history from posted ledger. |
| **Exit criteria** | Every alert in Appendix D fires on a seeded test case; dashboards reconcile to underlying ledger/costing to the cent; overdue approvals auto-escalate per `sys_workflow_step` SLA. |
| **Dependencies** | P1–P3 (needs live transactional volume to be meaningful). |
| **Success metric** | **Mean time-to-detect for low-stock / pending-price / overdue-job exceptions < 24h** (vs manual monthly review today). |
| **Indicative duration** | 6–8 weeks. |

### 1.5 Phase 5 — Integrations & Mobile

| Field | Detail |
|-------|--------|
| **Phase** | **P5 — Integrations, Mobile & Optional SAP** |
| **Scope** | Barcode/QR for bin/item/battery-serial scanning, WhatsApp/email notification channel, external REST API, BI export, and optional SAP FI/CO or master-data integration. |
| **Key deliverables** | Barcode/QR encode-decode on `md_item.item_no`, `md_location` bin, `md_battery` serial; mobile stores/workshop capture (GRN receive, issue, stock count, job labour clock, battery scan-to-fit); WhatsApp/email dispatch bound to Appendix D alerts; versioned REST API; BI/warehouse feed; optional SAP outbound (GL postings from `mv_stock_ledger` value + `cost_job_summary`) and inbound master sync. |
| **Data migrated** | None new — generates barcode/QR symbologies for existing masters; maps UMMS GL/cost dimensions to SAP account/cost-center chart if SAP in scope. |
| **Exit criteria** | Scan-driven GRN & issue post identically to keyed entry; every alert deliverable via WhatsApp/email with recipient-role routing; API contract versioned & authenticated per site scope; SAP interface (if enabled) reconciles UMMS stock value to SAP GL. |
| **Dependencies** | P1–P4 (stable masters, ledger, costing, alert engine). |
| **Success metric** | **≥ 70% of stores/workshop floor transactions captured via scan/mobile** within 3 months of rollout; notification delivery success ≥ 99%. |
| **Indicative duration** | 8–10 weeks (SAP scope adds 6–10 weeks). |

### 1.6 Roadmap dependency map

```
 P1 Foundation+Stores ─┬─────────────► P2 Lube+Battery ─┐
        (masters,      │                                 ├──► P3 JobCard+Costing ──► P4 Analytics+Alerts ──► P5 Integration+Mobile
         ledger, MWAC) └──────────────────────────────────────────────────────────► (P3 also needs P1 directly)
```

---

## APPENDIX A — RECOMMENDED MENU STRUCTURE

```
UMMS
├── 1. Dashboards
│   ├── 1.1 Storekeeper Dashboard        (on-hand, reorder, pending-price)
│   ├── 1.2 Workshop Dashboard           (open jobs, awaiting parts, overdue)
│   ├── 1.3 Manager Dashboard (TM/OM)    (approvals pending, cost variance)
│   ├── 1.4 Cost Controller Dashboard    (job costing, MWAC exceptions)
│   └── 1.5 Alerts & Exceptions Inbox    → Appendix D queue
│
├── 2. Masters
│   ├── 2.1 Locations (Site / Store / Bin)          → md_location
│   ├── 2.2 Item Master                             → md_item
│   │        ├── Item Groups                        → md_item_group
│   │        └── Item Categories                    → md_item_category
│   ├── 2.3 Units of Measure & Conversions          → md_uom / md_uom_conversion
│   ├── 2.4 Suppliers                               → md_supplier
│   ├── 2.5 Assets (Vehicles / Machines)            → md_asset (+_vehicle/_machine)
│   ├── 2.6 Battery Serial Register                 → md_battery
│   ├── 2.7 Employees / Technicians                 → md_employee
│   ├── 2.8 Prices & Price History                  → md_price / md_price_history
│   ├── 2.9 Labour Rates                            → md_labour_rate
│   ├── 2.10 Warranty Terms                         → md_warranty_term
│   └── 2.11 Cost Dimensions (Project/Dept/CC)      → md_project/md_department/md_cost_center
│
├── 3. Stores / Materials
│   ├── 3.1 Material Request Note (MRN)             → tx_mrn
│   ├── 3.2 Purchase Order (PO)                     → tx_po
│   ├── 3.3 Goods Receipt Note (GRN)                → tx_grn
│   ├── 3.4 Stock Issue                             → tx_issue
│   ├── 3.5 Inter-Location Transfer                 → tx_transfer
│   ├── 3.6 Stock Adjustment / Count                → tx_adjustment
│   ├── 3.7 Return (to Supplier / Store-back)       → tx_return
│   ├── 3.8 Pending Price Queue                     → inv_pending_price
│   ├── 3.9 Stock Balance                           → inv_stock_balance
│   └── 3.10 Stock Ledger (Movement)               → mv_stock_ledger
│
├── 4. Lubricants
│   ├── 4.1 Lubricant Issue (with meter)           → tx_lube_issue
│   ├── 4.2 Monthly Balance Snapshot               → inv_lube_monthly_balance
│   └── 4.3 Consumption by Asset / Site
│
├── 5. Batteries
│   ├── 5.1 Battery Issue (fit to asset)           → tx_battery_issue (BAT)
│   ├── 5.2 Battery Transfer (asset→asset)         → tx_battery_transfer (BTR)
│   ├── 5.3 Battery Return / Warranty / Scrap      → tx_battery_return (BRT)
│   ├── 5.4 Serial Lifecycle History               → hist_battery_event
│   └── 5.5 Warranty Tracker (due/expired)
│
├── 6. Workshop / Job Cards
│   ├── 6.1 Job Card                               → tx_jobcard (JC)
│   ├── 6.2 Job Tasks / Defects                    → txl_jobcard_task
│   ├── 6.3 Daily Progress Log                     → tx_job_progress
│   ├── 6.4 Job Material Request (MRQ)             → tx_job_material_req
│   ├── 6.5 Parts Consumed                         → tx_job_parts
│   ├── 6.6 Labour Capture                         → tx_job_labour (LAB)
│   ├── 6.7 Outside / Subcontract Repair           → tx_job_outside_repair (OSR)
│   └── 6.8 Job Costing & Variance                 → cost_job_summary / cost_variance
│
├── 7. Approvals
│   ├── 7.1 My Pending Approvals                    → apr_step (assigned to me)
│   ├── 7.2 Approval History / Audit               → apr_action
│   └── 7.3 Workflow Definitions                    → sys_workflow / sys_workflow_step
│
├── 8. Reports & Analytics
│   ├── 8.1 Stock Valuation (MWAC)
│   ├── 8.2 Fast / Slow / Dead Stock
│   ├── 8.3 Cost per Asset (fuel/lube/battery/repair)
│   ├── 8.4 Workshop Throughput & Ageing
│   ├── 8.5 Job Cost & Variance
│   └── 8.6 Warranty & Battery Life
│
├── 9. Administration
│   ├── 9.1 Users & Roles                           → sec_user / sec_role
│   ├── 9.2 Site Access                             → sec_user_site
│   ├── 9.3 Permissions                             → sec_permission / sec_role_permission
│   ├── 9.4 Number Series                           → sys_number_series
│   ├── 9.5 Status & Code Master                    → sys_status / sys_code
│   └── 9.6 System Settings                         → sys_setting
│
└── 10. Migration
    ├── 10.1 Staging & Load Batches                 → stg_*_raw / stg_load_batch
    ├── 10.2 Validation & Cleansing                 → stg_*_clean / stg_reject
    ├── 10.3 Key Mapping (Legacy→Master)            → map_*_xref
    └── 10.4 Migration Status & Reconciliation
```

---

## APPENDIX B — MASTER DATA HIERARCHY

```
LOCATION (md_location, location_type SITE>STORE>BIN, self-parent parent_location_id)
└── Site (SITE)                       e.g. CMB, KND, HO0  → drives site_id row-level security
    └── Store (STORE)                 e.g. Main Store, Workshop Store
        └── Bin (BIN)                 e.g. Rack-A-03, Battery-Cage-1

ITEM (md_item, discriminator item_type)
├── Item Group (md_item_group)                  analytical grouping (fast-moving analysis)
│   └── Item Category (md_item_category, self-parent parent_category_id)
│       └── Item (md_item)
│           ├── item_type = STORE / SPARE / GENERAL / CONSUMABLE
│           ├── item_type = LUBRICANT           (is_stockable, consumption analytics)
│           └── item_type = BATTERY             (is_serial_tracked = 1)
│               └── Battery Serial (md_battery) one row per physical unit
│                   ├── item_id  → battery model in md_item
│                   ├── current_asset_id → md_asset (fitment)
│                   ├── warranty_term_id → md_warranty_term
│                   └── battery_status (IN_STOCK…SCRAPPED)
│                       └── hist_battery_event  (append-only lifecycle log)
│   └── UoM (md_uom base + alternate)
│       └── Conversion (md_uom_conversion: from_uom_id → to_uom_id × factor)

ASSET (md_asset, discriminator asset_class VEHICLE/MACHINE/EQUIPMENT)
├── Vehicle (md_asset_vehicle: reg_no, chassis, make, model, meter type)
│   └── Fitted components: current batteries (md_battery.current_asset_id)
├── Machine (md_asset_machine: capacity, plant_no, hour meter)
└── Equipment
        └── lubricant & battery issue TARGET; job cards raised against asset

SUPPLIER (md_supplier, supplier_type)
├── LOCAL            (local purchase, PO_type LOCAL)
├── HEAD_OFFICE      (inter-company / HO supply, PO_type HEAD_OFFICE)
└── SUBCONTRACTOR    (outside/repair vendor → tx_job_outside_repair)

EMPLOYEE (md_employee)
├── is_technician flag
└── grade_id → labour grade
        └── md_labour_rate (effective-dated hourly rate per grade)

PRICE
├── md_price              current active price (item × supplier × site, effective_date, price_status)
└── md_price_history      immutable effective-dated history (costing reads AS-OF txn date)

COST DIMENSIONS
├── md_project            (contract / project)
├── md_department
└── md_cost_center

WORKFLOW / APPROVAL
└── md_approval_role → sec_role  (maps required role to sys_workflow_step)
```

---

## APPENDIX C — TRANSACTION NUMBERING FORMATS

> Pattern (contract §4): **`<TYPE>-<SITE>-<YY>-<NNNNNN>`** — `SITE` = 3-letter `md_location` site code;
> `YY` = 2-digit year; `NNNNNN` = zero-padded running sequence. **Reset:** yearly, per site, per type.
> **Source:** every sequence is drawn atomically from `sys_number_series` (keyed `type × site × year`).

| Type code | Document | Pattern | Example | Reset rule | Source |
|-----------|----------|---------|---------|------------|--------|
| `MRN` | Material Request Note (indent) | `MRN-<SITE>-<YY>-<NNNNNN>` | `MRN-CMB-26-000123` | Yearly / site / type | `sys_number_series` |
| `PO`  | Purchase Order (LOCAL/HEAD_OFFICE) | `PO-<SITE>-<YY>-<NNNNNN>` | `PO-HO0-26-000045` | Yearly / site / type | `sys_number_series` |
| `GRN` | Goods Receipt Note | `GRN-<SITE>-<YY>-<NNNNNN>` | `GRN-CMB-26-000210` | Yearly / site / type | `sys_number_series` |
| `ISS` | Stock / General Issue | `ISS-<SITE>-<YY>-<NNNNNN>` | `ISS-CMB-26-001004` | Yearly / site / type | `sys_number_series` |
| `TRF` | Inter-Location Transfer | `TRF-<SITE>-<YY>-<NNNNNN>` | `TRF-CMB-26-000067` | Yearly / site / type | `sys_number_series` |
| `ADJ` | Stock Adjustment / Count | `ADJ-<SITE>-<YY>-<NNNNNN>` | `ADJ-CMB-26-000012` | Yearly / site / type | `sys_number_series` |
| `RET` | Return (supplier / store-back) | `RET-<SITE>-<YY>-<NNNNNN>` | `RET-CMB-26-000009` | Yearly / site / type | `sys_number_series` |
| `LUB` | Lubricant Issue (with meter) | `LUB-<SITE>-<YY>-<NNNNNN>` | `LUB-KND-26-000318` | Yearly / site / type | `sys_number_series` |
| `BAT` | Battery Issue (fit to asset) | `BAT-<SITE>-<YY>-<NNNNNN>` | `BAT-CMB-26-000077` | Yearly / site / type | `sys_number_series` |
| `BTR` | Battery Transfer (asset→asset) | `BTR-<SITE>-<YY>-<NNNNNN>` | `BTR-CMB-26-000014` | Yearly / site / type | `sys_number_series` |
| `BRT` | Battery Return / Warranty / Scrap | `BRT-<SITE>-<YY>-<NNNNNN>` | `BRT-CMB-26-000006` | Yearly / site / type | `sys_number_series` |
| `JC`  | Job Card | `JC-<SITE>-<YY>-<NNNNNN>` | `JC-CMB-26-000502` | Yearly / site / type | `sys_number_series` |
| `MRQ` | Job Material Request | `MRQ-<SITE>-<YY>-<NNNNNN>` | `MRQ-CMB-26-000488` | Yearly / site / type | `sys_number_series` |
| `LAB` | Labour Sheet | `LAB-<SITE>-<YY>-<NNNNNN>` | `LAB-CMB-26-000771` | Yearly / site / type | `sys_number_series` |
| `OSR` | Outside / Subcontract Repair | `OSR-<SITE>-<YY>-<NNNNNN>` | `OSR-CMB-26-000031` | Yearly / site / type | `sys_number_series` |

**Rules**
- The number is allocated at **first save (DRAFT)** and is immutable thereafter — a cancelled/void document keeps its number; no re-use, no gaps hidden.
- Concurrent allocation must be serialized on the `sys_number_series` row (row-lock / atomic increment) to avoid duplicate `*_no`.
- `SITE` is derived from the document's `site_id`, guaranteeing every number encodes the owning site for row-level security and audit.

---

## APPENDIX D — ALERTS & EXCEPTION LIST

> Fired by the P4 exception scanner; delivered in-app (Alerts Inbox, menu 1.5) and, from P5, via WhatsApp/email.
> Severity: **C**=Critical, **H**=High, **M**=Medium, **L**=Low.

| # | Alert / Exception | Module | Trigger condition | Sev | Channel | Recipient role | Suggested action |
|---|-------------------|--------|-------------------|-----|---------|----------------|------------------|
| 1 | Low stock / reorder | Stores | `inv_stock_balance.on_hand_qty ≤ reorder_level` for item×location | H | In-app + email | Storekeeper, Purchasing | Raise MRN → PO to supplier |
| 2 | Pending price (un-priced receipt) | Stores/Costing | Row open in `inv_pending_price` > SLA (e.g. 3 days) | H | In-app + email | Storekeeper, Cost Controller | Enter/confirm price in `md_price`; revalue |
| 3 | Negative stock | Stores | `inv_stock_balance.on_hand_qty < 0` after posting | C | In-app + WhatsApp | Storekeeper, Store Manager | Investigate mis-post; adjust/reverse |
| 4 | Unmatched / duplicate battery serial | Battery | Serial not in `md_battery`, or 2+ rows same serial | C | In-app + email | Store Manager, Data Steward | Merge/void duplicate; correct fitment |
| 5 | Warranty due (expiring) | Battery/Asset | `warranty_end_date − today ≤ 30 days` | M | In-app + email | Workshop Foreman, Store Manager | Plan replacement / pre-emptive claim |
| 6 | Warranty expired | Battery/Asset | `today > warranty_end_date` and unit still in service | L | In-app | Store Manager | Update status; no claim available |
| 7 | GRN not posted | Stores | `tx_grn` in `RECEIVED/QC_PASSED` but not `POSTED` > 2 days | H | In-app + email | Storekeeper | Complete QC/pricing and post GRN |
| 8 | Overdue job card | Workshop | `tx_jobcard` open past `promised_date` / SLA | H | In-app + WhatsApp | Workshop Foreman, TM | Expedite; update `tx_job_progress` |
| 9 | Job awaiting parts too long | Workshop | Status `AWAITING_PARTS` > SLA (e.g. 3 days) | H | In-app + email | Storekeeper, Foreman | Fulfil `inv_reservation`/MRQ or PO |
| 10 | Job awaiting outside repair too long | Workshop | Status `AWAITING_OUTSIDE_REPAIR` > SLA | M | In-app + email | Foreman, Purchasing | Chase subcontractor (`OSR`) |
| 11 | Unauthorized / override used | Stores/Security | Issue posted with `override_by` (stock < requested) | H | In-app + email | Store Manager, Auditor | Review override reason; validate |
| 12 | Price change (significant) | Stores/Costing | New `md_price_history` differs > threshold % from prior | M | In-app + email | Cost Controller, Purchasing | Confirm price; check supplier |
| 13 | Failed migration record | Migration | `stg_reject` row / status `REJECTED` or `DUPLICATE` | H | In-app + email | Data Steward, Project Lead | Cleanse in `stg_*_clean`; re-map/re-load |
| 14 | Reservation unfulfilled | Workshop/Stores | `inv_reservation` open past job need-date | M | In-app + email | Storekeeper, Foreman | Issue against reservation or release |
| 15 | Slow-moving stock | Stores/Analytics | No `OUT` movement in N days, on-hand > 0 | L | In-app | Store Manager, Cost Controller | Review reorder level; redistribute |
| 16 | Dead stock | Stores/Analytics | No movement > 365 days, on-hand > 0 | M | In-app + email | Store Manager, Finance | Write-down / transfer / dispose |
| 17 | Budget / cost variance exceeded | Costing | `cost_variance.variance_pct > threshold` on a job | H | In-app + email | Cost Controller, OM | Investigate labour/material overrun |
| 18 | Approval overdue (SLA breach) | Approvals | `apr_step` PENDING beyond step SLA | M | In-app + email | Next approver, then escalation role | Approve/reject or auto-escalate |
| 19 | Meter reading missing/regressed | Lubricant | Lube issue without valid/increasing `meter_reading` | M | In-app | Foreman, Store Manager | Correct reading; block bad analytics |
| 20 | Close-gate blocked | Workshop/Costing | Job close attempted with open pending-price/parts/labour | H | In-app | Foreman, Cost Controller | Resolve gate items (contract §7.7) |

---

## APPENDIX E — MVP vs ADVANCED VERSION

> Lets the client phase investment. **MVP** = minimum to run the operation correctly; **Advanced** = automation, analytics, integration.

### E.1 Stores / Materials

| Capability | MVP | Advanced |
|------------|-----|----------|
| Item / supplier / location masters | Manual entry, single source | De-dup rules, bulk import, approval on master change |
| MRN → PO → GRN → Issue → Transfer → Return | Keyed entry, full ledger | Barcode/QR scan capture, mobile GRN/issue |
| Valuation | MWAC per item×location | Optional FIFO layers (`inv_valuation_layer`) per item |
| Pending price | Queue + manual price entry | Auto-reminders, bulk price confirm, auto-revaluation cascade |
| Reorder | Manual reorder level, low-stock list | Auto-suggested PO, demand-based reorder point |
| Stock count | Adjustment document | Cycle-count scheduling, blind count via mobile |

### E.2 Lubricants

| Capability | MVP | Advanced |
|------------|-----|----------|
| Lube issue | With mandatory meter reading | Scan asset + auto-meter validation |
| Balance | Month-end snapshot | Real-time consumption trend, L/1000km per asset |
| Analytics | Consumption by asset/site report | Abnormal-consumption alerts, benchmarking |

### E.3 Batteries

| Capability | MVP | Advanced |
|------------|-----|----------|
| Serial register | One row per serial, status tracking | QR scan-to-fit, photo proof (`doc_*`) |
| Lifecycle | Issue/transfer/return + event log | Predictive replacement from age/failure history |
| Warranty | Due/expired tracking | Auto warranty-claim pack + supplier follow-up |

### E.4 Job Card + Costing

| Capability | MVP | Advanced |
|------------|-----|----------|
| Job card & tasks | Header + tasks + progress log | Templated jobs, checklist, photo/defect capture |
| Approval | TM → OM, sequential | Value-based routing, delegation, auto-escalation |
| Material to job | MRQ + issue, reservation | Live availability check, external PO auto-link |
| Labour | Manual hours × grade rate | Clock-in/out, mobile labour capture |
| Outside repair | OSR document + cost entry | Subcontractor portal, quote comparison |
| Costing | Roll-up + estimate-vs-actual variance | Real-time cost meter, budget alerts, cost-per-km |

### E.5 Cross-cutting

| Capability | MVP | Advanced |
|------------|-----|----------|
| Dashboards | Core operational lists | Role/site KPI dashboards, drill-down |
| Alerts | Low-stock + pending-price + overdue-job | Full Appendix D engine, multi-channel |
| Notifications | In-app only | WhatsApp + email routing |
| Access control | Role + site scope | Fine-grained permission, field-level audit |
| Integration | Standalone | REST API, BI export, optional SAP FI/CO |
| Capture | Keyboard | Barcode/QR + mobile |

---

## 2. RISK REGISTER

> Likelihood / Impact: **H/M/L**. Every control maps to a concrete UMMS mechanism (contract table, status gate, or phase).

| # | Risk | Category | Likelihood | Impact | Mitigation / Control |
|---|------|----------|-----------|--------|----------------------|
| 1 | Dirty legacy data (mixed item names, no UoM, blank suppliers) | Data | H | H | Staging pipeline `stg_*_raw → stg_*_clean` with validation rules; `MIGR` status gate `IMPORTED→VALIDATED→MAPPED→APPROVED→POSTED`; reject to `stg_reject`; no load without sign-off. |
| 2 | Duplicate masters (same item/battery/supplier entered twice) | Data | H | H | Unique keys on `item_no`, battery `serial`, supplier code; `map_*_xref` legacy→master mapping; de-dup review before P1 cutover; duplicate-serial alert (App D #4). |
| 3 | Stock inaccuracy vs physical | Process | M | H | Every line posts `mv_stock_ledger` + `inv_stock_balance` atomically (contract §7.1); no negative stock without override; cycle counts via `tx_adjustment`; opening balance reconciled at P1 exit. |
| 4 | Un-priced receipts distort MWAC & job costing | Data | H | H | `inv_pending_price` queue + pending-price alert (App D #2); provisional cost then revaluation movement on confirm (contract §6); close-gate blocks job while pending price open (§7.7). |
| 5 | Missed / bypassed approvals | Process | M | H | Generic approval engine `apr_request/apr_step/apr_action`; JOBCARD status cannot skip `PENDING_TM_APPROVAL`/`PENDING_OM_APPROVAL`; immutable `apr_action` log; SLA escalation (App D #18). |
| 6 | Battery serial history gaps | Data | M | M | Every battery movement appends `hist_battery_event` + updates `md_battery` in one txn (§7.4); unmatched-serial alert (App D #4); seed historical fitments at P2. |
| 7 | Low user adoption by store/workshop clerks | Adoption | H | H | Phased go-live (P1 first, familiar stores flow); minimal-click MVP screens; barcode/mobile from P5 to cut keystrokes; role dashboards; on-site training + super-users per site. |
| 8 | Offline / poor connectivity at remote sites | Technical | M | M | Server-authoritative posting with retry; queued mobile capture (P5) that syncs when online; number allocation server-side to prevent duplicate `*_no`. |
| 9 | Permission / data leakage across sites | Security | M | H | `site_id` on every document + `sec_user_site` row-level visibility; number encodes site; RLS enforced in queries; override + cross-site actions logged. |
| 10 | Over-customization / bespoke drift | Technical | M | M | Configuration over code (`sys_setting`, `sys_status`, `sys_workflow`); changes to shared masters/valuation must conform to design contract; change-control board. |
| 11 | Scope creep across four modules | Process | H | M | Fixed phase exit criteria (§1); MVP vs Advanced split (App E) as the negotiation lever; anything new must follow contract prefix/naming rules and be logged. |
| 12 | Key-person dependency (single admin knows the system) | Adoption | M | H | Documented masters/numbering/workflow config; ≥2 trained admins per function; runbooks; no undocumented direct-DB edits (append-only ledgers enforce trail). |
| 13 | Backup / DR failure (loss of ledger & costing) | Technical | L | H | Append-only `mv_stock_ledger`/`hist_battery_event` are reconstructable; scheduled backups + tested restore; DR runbook; row-versioned optimistic concurrency prevents silent overwrite. |
| 14 | Meter readings unreliable (lube analytics wrong) | Data | M | M | Mandatory increasing `meter_reading` on `tx_lube_issue` (§7.5); regression/missing-reading alert (App D #19); validation at capture. |
| 15 | Cost variance undetected until month-end | Process | M | M | `cost_variance` per job + variance alert (App D #17); P4 real-time dashboards; close-gate forces full costing before `CLOSED`. |
| 16 | Slow / dead capital tied in dead stock | Process | M | M | Slow/dead-stock analytics (App D #15/#16); reorder-level tuning; write-down/transfer workflow via `tx_transfer`/`tx_adjustment`. |
| 17 | Unauthorized override abuse (issue below stock) | Security | M | M | Override requires `override_by` + `override_reason` (§7.2); override-used alert (App D #11); periodic audit report. |
| 18 | Migration cutover overrun / dual running | Process | M | M | Per-entity staged migration with reconciliation at each phase exit; freeze legacy writes at cutover; parallel-run only for P1 stores until balance confirmed. |
```
