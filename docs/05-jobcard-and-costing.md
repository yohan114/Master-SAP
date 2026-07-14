# 05 — Workshop Job Card Lifecycle & Costing Engine (Phase 3)

> **Scope:** Operation (D) — WORKSHOP JOB CARD + JOB COSTING of the UMMS platform.
> Conforms to `/docs/00-design-contract.md`. All table names, column conventions
> (`*_id`, `*_no`, `*_qty`, `*_amt`, `*_cost`, `*_status`, audit + `site_id`),
> the `TYPE-SITE-YY-NNNNNN` numbering, the `JOBCARD` status vocabulary, the shared
> masters (`md_asset`, `md_item`, `md_employee`, `md_labour_rate`, `md_price_history`,
> `mv_stock_ledger`, `inv_stock_balance`, `inv_reservation`, `inv_pending_price`) and
> the generic approval engine (`sys_workflow`, `apr_request/step/action`) are used
> **as defined in the contract** — this document does not re‑define them.

**Master document type:** `JC` → `JC-<SITE>-<YY>-NNNNNN` (e.g. `JC-CMB-26-000502`).
Child docs raised from a job card: `MRQ` (job material request), `LAB` (labour sheet),
`OSR` (outside repair). All draw their running number from `sys_number_series`.

---

## 0. End-to-End Lifecycle Map (one screen)

```
 TRANSPORT OFFICE                 MANAGEMENT              WORKSHOP                       COSTING / CLOSE
 ────────────────                 ──────────              ────────                       ───────────────
 [create JC]                                                                             
   DRAFT ──submit──► PENDING_TM_APPROVAL ──TM approve──► PENDING_OM_APPROVAL             
                                                │                                        
                              TM/OM reject ─────┴──► REJECTED (back to office)           
                                                                                         
                          OM approve ──► APPROVED ──assign──► ASSIGNED_WORKSHOP          
                                                                     │                   
                                                          supervisor accepts            
                                                                     ▼                   
                                                              IN_PROGRESS ◄───────┐      
                                                              │   │   │           │      
                                                MRQ raised ──►│   │   │◄── parts issued  
                                                              ▼   ▼   ▼           │      
                                     AWAITING_PARTS   AWAITING_OUTSIDE_REPAIR ────┘      
                                        (sub-state)         (sub-state)                  
                                                                     │                   
                                                          all tasks done                 
                                                                     ▼                   
                                                            WORK_COMPLETED ──► PENDING_COSTING
                                                                                     │   
                                              cost engine rolls up labour+material+   │   
                                              general+outside → cost_job_summary      │   
                                                                                     ▼   
                                                                          PENDING_CLOSURE
                                                                                     │   
                                                     CLOSE GATE (Section 10) all TRUE │   
                                                                                     ▼   
                                                                                  CLOSED 
 Side states (from most active states): ON_HOLD, CANCELLED
```

---

## 1. Job Card Header + Line Structure

### 1.1 `tx_jobcard` — header (Numbering type `JC`)

| Column | Type | Notes / Rule |
|--------|------|--------------|
| `jobcard_id` | BIGINT IDENTITY PK | Surrogate key |
| `jobcard_no` | VARCHAR(30) UNIQ | `JC-<SITE>-<YY>-NNNNNN` from `sys_number_series` on submit |
| `site_id` | BIGINT NOT NULL FK→`md_location(SITE)` | Row-level security; drives `SITE` in number |
| `asset_id` | BIGINT NOT NULL FK→`md_asset` | The vehicle/machine under repair (`asset_class` VEHICLE/MACHINE/EQUIPMENT) |
| `meter_reading` | DECIMAL(18,4) | Odometer/hour-meter at booking; validated ≥ last known meter on `md_asset` |
| `job_type` | VARCHAR(20) FK→`sys_code` | BREAKDOWN / PREVENTIVE / ACCIDENT / RUNNING_REPAIR / INSPECTION / GENERAL |
| `priority` | VARCHAR(10) FK→`sys_code` | LOW / NORMAL / HIGH / VOR (Vehicle-Off-Road) |
| `reported_defect` | VARCHAR(1000) | Driver/officer reported fault/complaint (free text) |
| `reported_by_employee_id` | BIGINT FK→`md_employee` | Driver/officer who reported the fault |
| `jobcard_date` | DATE | When fault reported |
| `reported_by_employee_id` | BIGINT FK→`sec_user` | Transport officer who created the JC |
| `estimated_cost` | DECIMAL(18,2) | Officer/manager estimate; baseline for `cost_variance` |
| `promised_date` | DATE | SLA target return-to-service date (used by Delayed logic, §11) |
| `location_id` | BIGINT FK→`md_location` | Store/workshop bay handling the job |
| `assigned_to_employee_id` | BIGINT NULL FK→`md_employee` | Workshop supervisor (workshop owner); assigned on ASSIGNED_WORKSHOP |
| `assigned_to_employee_id` | BIGINT NULL FK→`md_employee` | Lead technician (`is_technician=1`); same assignment field |
| `work_started_at` | DATE NULL | Actual work start (set at IN_PROGRESS) |
| `work_completed_at` | DATE NULL | Set at WORK_COMPLETED |
| `jobcard_status` | VARCHAR(30) FK→`sys_status(JOBCARD)` | See §0 / §2 |
| `hold_reason` | VARCHAR(500) NULL | Populated when → ON_HOLD |
| `tm_approved_by` / `tm_approved_at` | BIGINT / DATETIME NULL | Transport Manager sign-off (mirrors `apr_action`) |
| `om_approved_by` / `om_approved_at` | BIGINT / DATETIME NULL | Operational Manager sign-off |
| `approved_by` / `approved_at` | BIGINT / DATETIME NULL | Final approver (= OM) per contract §1.3 |
| `project_id` / `department_id` / `cost_center_id` | BIGINT NULL | Cost dimensions from shared masters |
| **audit** | — | `created_by/at`, `updated_by/at`, `row_version`, `is_active` per contract §1.3 |

### 1.2 `txl_jobcard_task` — defect / task lines (no own number)

| Column | Type | Notes |
|--------|------|-------|
| `task_id` | BIGINT IDENTITY PK | |
| `jobcard_id` | BIGINT NOT NULL FK→`tx_jobcard` | `fk_txl_jobcard_task_hdr` |
| `line_no` | INT | Sequence within JC |
| `task_code` | VARCHAR(20) FK→`sys_code` | Standard job/operation code (e.g. BRAKE-OH, ENG-TUNE) |
| `task_description` | VARCHAR(500) | Defect / work description |
| `symptom_code` / `system_group` | VARCHAR(20) | Analytics: engine/brakes/electrical/hydraulics |
| `estimated_hours` | DECIMAL(18,4) | Labour estimate per task |
| `assigned_to_employee_id` | BIGINT NULL FK→`md_employee` | Task-level technician |
| `task_status` | VARCHAR(20) FK→`sys_status` | PENDING → IN_PROGRESS → COMPLETED (+ CANCELLED) |
| `is_warranty` | BIT | Task claimable under `md_warranty_term` |
| **audit** | — | standard |

**Links to `md_asset`:** every JC binds to exactly one `asset_id`. History/analytics
(“repeat repair on same system within X km/days”) join `tx_jobcard.asset_id + meter_reading`
with `txl_jobcard_task.system_group`. Vehicle vs machine attributes resolve through
`md_asset_vehicle` / `md_asset_machine`.

---

## 2. Approval Workflow (Office → TM → OM → Workshop)

Bound to generic engine: `sys_workflow.workflow_code = 'JOBCARD_APPROVAL'` with ordered
`sys_workflow_step` rows; an `apr_request` is created per JC on submit; each step writes an
`apr_step` (state) and every human decision writes an immutable `apr_action`.

### 2.1 Step table

| Seq | Actor / role (`md_approval_role`) | Action | System effect | Ledger/cost effect | Status transition |
|----|-----------------------------------|--------|---------------|--------------------|-------------------|
| — | Transport Officer (`reported_by_employee_id`) | Create JC + tasks | Row in `tx_jobcard` + `txl_jobcard_task`, `jobcard_no` NOT yet assigned | none | `DRAFT` |
| 0 | Transport Officer | Submit | `apr_request` opened; `jobcard_no` assigned; `apr_step[0]` PENDING | none | `DRAFT → PENDING_TM_APPROVAL` |
| 1 | **Transport Manager** | Approve | `apr_action`=APPROVED; `tm_approved_by/at` set; `apr_step[1]` opens | none | `PENDING_TM_APPROVAL → PENDING_OM_APPROVAL` |
| 1 | Transport Manager | Reject / Return | `apr_action`=REJECTED/RETURNED | none | `→ REJECTED` (or back to `DRAFT` on RETURN) |
| 2 | **Operational Manager** | Approve | `apr_action`=APPROVED; `om_approved_by/at` + `approved_by/at` set; request CLOSED | none | `PENDING_OM_APPROVAL → APPROVED` |
| 2 | Operational Manager | Reject / Return | `apr_action`=REJECTED/RETURNED | none | `→ REJECTED` (or `PENDING_TM_APPROVAL`) |
| 3 | Workshop Controller | Assign supervisor + bay | `assigned_to_employee_id` (supervisor = workshop owner and lead technician), `location_id` set | none | `APPROVED → ASSIGNED_WORKSHOP` |

### 2.2 Status map (approval band)

```
DRAFT ──submit──► PENDING_TM_APPROVAL ──TM approve──► PENDING_OM_APPROVAL ──OM approve──► APPROVED ──assign──► ASSIGNED_WORKSHOP
   ▲                    │  reject/return           │ reject/return
   └── RETURN ──────────┘                          └──────► REJECTED
```

### 2.3 Engine mapping

| Contract table | Populated with |
|----------------|----------------|
| `apr_request` | 1 row: `source_doc_type='JC'`, `source_doc_id=jobcard_id`, `workflow_code='JOBCARD_APPROVAL'`, `current_step_no`, `apr_status` (APR group) |
| `apr_step` | 1 row per `sys_workflow_step` (TM step, OM step): `step_status` PENDING/APPROVED/REJECTED/RETURNED, `assigned_role_id` |
| `apr_action` | append-only: one row per decision — `action_type` (APR group: APPROVED/REJECTED/RETURNED/ESCALATED/DELEGATED), `acted_by`, `acted_at`, `comment` |

> **Auto-escalation:** if an `apr_step` sits PENDING beyond its SLA (`sys_setting`), the engine
> writes an `apr_action`=ESCALATED and re-routes to the next `md_approval_role` — JC stays in the
> same `jobcard_status`.

---

## 3. Workshop Execution Workflow

| Step | Actor | Action | System effect | Ledger/cost effect | Status transition |
|------|-------|--------|---------------|--------------------|-------------------|
| E1 | Workshop Controller | Assign | set `assigned_to_employee_id` (supervisor/lead technician)/`location_id` | none | `APPROVED → ASSIGNED_WORKSHOP` |
| E2 | Supervisor | Accept & start | set `work_started_at=today`; task lines PENDING→IN_PROGRESS | none | `ASSIGNED_WORKSHOP → IN_PROGRESS` |
| E3 | Technician | Need internal/external parts | raise `MRQ` (§5); reserve stock | `inv_reservation` soft-alloc (no ledger yet) | `IN_PROGRESS → AWAITING_PARTS` (sub-state) |
| E4 | Storekeeper | Issue parts to job | post issue | **`mv_stock_ledger` OUT** + `inv_stock_balance` ↓; `tx_job_parts` linked | `AWAITING_PARTS → IN_PROGRESS` |
| E5 | Supervisor | Send to subcontractor | raise `OSR` (§6) | none (until service GRN) | `IN_PROGRESS → AWAITING_OUTSIDE_REPAIR` (sub-state) |
| E6 | Storekeeper | Receive service back | GRN of service | OSR cost captured (feeds costing) | `AWAITING_OUTSIDE_REPAIR → IN_PROGRESS` |
| E7 | Technician | Log daily work | `tx_job_progress` row (§4) | none | (stays `IN_PROGRESS`) |
| E8 | Supervisor | All tasks COMPLETED | all `txl_jobcard_task.task_status=COMPLETED`; `work_completed_at=today` | none | `IN_PROGRESS → WORK_COMPLETED` |
| E9 | System / Cost clerk | Trigger roll-up | build `cost_job_summary`/`_line`/variance (§8) | reads ledger/labour/OSR | `WORK_COMPLETED → PENDING_COSTING → PENDING_CLOSURE` |

**Sub-state rules (`AWAITING_PARTS` / `AWAITING_OUTSIDE_REPAIR`)**
- Both are **re-entrant sub-states of `IN_PROGRESS`** (contract §5). A JC may bounce
  IN_PROGRESS ⇄ AWAITING_* multiple times.
- Time spent in a sub-state accrues against `promised_date` for Delayed monitoring (§11).
- A JC with any task still `PENDING`/`IN_PROGRESS` **cannot** be forced to `WORK_COMPLETED`.

---

## 4. Daily Progress Log Model

### 4.1 `tx_job_progress` (no own document number — child event log)

| Column | Type | Notes |
|--------|------|-------|
| `progress_id` | BIGINT IDENTITY PK | |
| `jobcard_id` | BIGINT FK→`tx_jobcard` | `fk_tx_job_progress_hdr` |
| `task_id` | BIGINT NULL FK→`txl_jobcard_task` | Optional task-level tagging |
| `progress_date` | DATE NOT NULL | One or more rows per day |
| `logged_by_employee_id` | BIGINT FK→`md_employee` | Who logged |
| `work_done` | VARCHAR(1000) | Narrative of the day’s work |
| `hours_spent` | DECIMAL(18,4) | Informational; **binding labour** is `tx_job_labour` (§7) |
| `pct_complete` | DECIMAL(5,2) | Cumulative JC completion 0–100 |
| `next_action` | VARCHAR(500) | Planned next step / blocker |
| `blocker_code` | VARCHAR(20) NULL | AWAITING_PARTS / AWAITING_OSR / AWAITING_APPROVAL |
| **audit** | — | standard |

### 4.2 Accumulation logic

```
Latest pct_complete   = MAX(progress_date) row's pct_complete   → drives Workshop board bar
Cumulative log hours  = Σ hours_spent (indicative only)
Days-in-workshop      = today − work_started_at
Idle/stall flag       = MAX(progress_date) < today − N days  (N from sys_setting)  → "stalled job"
```

> Progress rows are **append-only in spirit** (correct via new row, not edit). `hours_spent` here
> is a supervisor’s running note; costing never reads it — it reads `tx_job_labour` (§7) to avoid
> double counting.

---

## 5. Material Request + Reservation + Issue

### 5.1 `tx_job_material_req` / `txl_job_material_req` (Numbering type `MRQ`)

**Header `tx_job_material_req`**

| Column | Type | Notes |
|--------|------|-------|
| `mrq_id` | BIGINT PK | |
| `mrq_no` | VARCHAR(30) UNIQ | `MRQ-<SITE>-<YY>-NNNNNN` |
| `jobcard_id` | BIGINT FK→`tx_jobcard` | Parent JC |
| `site_id` | BIGINT | |
| `request_date` | DATE | |
| `requested_by` | BIGINT FK→`md_employee` | Technician/supervisor |
| `matreq_status` | VARCHAR(20) FK→`sys_status` | DRAFT→SUBMITTED→APPROVED→PARTIALLY_ISSUED→ISSUED→CLOSED |
| **audit + approved_by/at** | — | standard |

**Line `txl_job_material_req`**

| Column | Type | Notes |
|--------|------|-------|
| `mrq_line_id` | BIGINT PK | |
| `mrq_id` | BIGINT FK | |
| `item_id` | BIGINT FK→`md_item` | Any `item_type` (SPARE/CONSUMABLE/GENERAL/LUBRICANT/BATTERY) |
| `source_type` | VARCHAR(10) | **INTERNAL** (ex-stock) / **EXTERNAL** (buy against JC) |
| `requested_qty` | DECIMAL(18,4) | |
| `reserved_qty` | DECIMAL(18,4) | Soft-alloc created (INTERNAL only) |
| `issued_qty` | DECIMAL(18,4) | Rolled up from issues |
| `location_id` | BIGINT FK→`md_location` | Issuing store/bin |
| `line_status` | VARCHAR(20) | OPEN/RESERVED/ISSUED/PURCHASED/CANCELLED |

### 5.2 Internal vs External source

| Aspect | INTERNAL (ex-stock) | EXTERNAL (purchase against JC) |
|--------|---------------------|-------------------------------|
| Reservation | `inv_reservation` soft-alloc at approval | none (nothing on hand) |
| Procurement | none | `tx_po` (LOCAL) → supplier |
| Receipt | not required | `tx_grn` → **`mv_stock_ledger` IN** + `inv_stock_balance` ↑ (may enter `inv_pending_price`) |
| Issue to job | `tx_issue` (`ISS`) OUT → `tx_job_parts` | `tx_issue` OUT after GRN, **or** direct receipt-to-job |
| Cost basis | MWAC as-of issue date (§8/§9) | GRN price (or provisional) as-of issue date |

### 5.3 Reservation → Issue posting

```
Approve MRQ (INTERNAL)          Issue to job (storekeeper)
──────────────────────         ───────────────────────────
inv_reservation:               tx_issue / txl_issue (ISS-…)   ── posts ──►
  item_id, location_id,          mv_stock_ledger  (mv_direction = OUT)
  jobcard_id, reserved_qty,      inv_stock_balance.on_hand_qty  ↓
  status = ACTIVE                unit_cost = inv_stock_balance.moving_avg_cost (as-of issue date)
                                 inv_reservation.status ACTIVE → CONSUMED (reduce reserved_qty)
                                 tx_job_parts row created & linked to jobcard_id + issue line
```

**`tx_job_parts`** (parts consumed/received against the job — links GRN/issue per contract §3.5)

| Column | Type | Notes |
|--------|------|-------|
| `job_part_id` | BIGINT PK | |
| `jobcard_id` | BIGINT FK | |
| `item_id` | BIGINT FK→`md_item` | |
| `source_doc_type` | VARCHAR(10) | ISS (ex-stock) / GRN (received-against-JC) |
| `source_doc_id` | BIGINT | FK to `tx_issue`/`tx_grn` line |
| `ledger_id` | BIGINT FK→`mv_stock_ledger` | The OUT movement that costs the part |
| `qty` | DECIMAL(18,4) | |
| `unit_cost` | DECIMAL(18,2) | Valuation cost as-of movement date (MWAC/provisional) |
| `part_cost` | DECIMAL(18,2) | `qty × unit_cost` |
| `is_provisional` | BIT | 1 if priced from `inv_pending_price` provisional (§9) |
| `is_general` | BIT | 1 → general item bucket in costing (§8) |
| **audit** | — | standard |

### 5.4 “Parts received against job card” (external / purchased)

```
Technician raises MRQ (EXTERNAL) ► PO (tx_po LOCAL) ► supplier delivers
  ► GRN (tx_grn) posts mv_stock_ledger IN + inv_stock_balance ↑
      └─ if un-priced: row in inv_pending_price (provisional cost)  ── blocks CLOSE (§10)
  ► Issue to job (tx_issue OUT) → tx_job_parts (source_doc_type=GRN, ledger_id set)
```

---

## 6. Outside (Subcontract) Repair Process

### 6.1 `tx_job_outside_repair` (Numbering type `OSR`)

| Column | Type | Notes |
|--------|------|-------|
| `osr_id` | BIGINT PK | |
| `osr_no` | VARCHAR(30) UNIQ | `OSR-<SITE>-<YY>-NNNNNN` |
| `jobcard_id` | BIGINT FK→`tx_jobcard` | |
| `task_id` | BIGINT NULL FK→`txl_jobcard_task` | Which defect is subcontracted |
| `site_id` | BIGINT | |
| `supplier_id` | BIGINT FK→`md_supplier` | `supplier_type = SUBCONTRACTOR` |
| `description` | VARCHAR(1000) | Machining / rewind / body work etc. |
| `sent_date` | DATE | Item/assembly sent out |
| `expected_return_date` | DATE | For Delayed monitoring |
| `actual_return_date` | DATE NULL | Set on service GRN |
| `estimated_cost` | DECIMAL(18,2) | Quoted/agreed price (estimate basis) |
| `invoice_no` | VARCHAR(30) NULL | Supplier invoice ref |
| `actual_cost` | DECIMAL(18,2) NULL | Actual billed |
| `grn_id` | BIGINT NULL FK→`tx_grn` | **GRN of service** (receipt of the repaired item) |
| `osr_status` | VARCHAR(20) FK→`sys_status` | SENT → IN_PROGRESS → RECEIVED → INVOICED → CLOSED (+ CANCELLED) |
| **audit + approved_by/at** | — | standard |

### 6.2 Status + cost flow

| Step | Actor | Action | System effect | Cost effect | JC status |
|------|-------|--------|---------------|-------------|-----------|
| O1 | Supervisor | Create OSR, send item | `osr_status=SENT`; `sent_date` set | estimate = `estimated_cost` | `IN_PROGRESS → AWAITING_OUTSIDE_REPAIR` |
| O2 | Subcontractor | Working | `osr_status=IN_PROGRESS` | — | (sub-state) |
| O3 | Storekeeper | Receive back | **GRN of service** (`grn_id`), `actual_return_date`; `osr_status=RECEIVED` | actual = `actual_cost` when billed | `AWAITING_OUTSIDE_REPAIR → IN_PROGRESS` |
| O4 | Accounts | Enter invoice | `invoice_no`/`actual_cost`; `osr_status=INVOICED` | outside cost finalised | — |
| O5 | Cost engine | Roll up | `cost_job_line` (element=OUTSIDE) written; `osr_status=CLOSED` | `outside_repair_cost += actual_cost (or estimated_cost)` | feeds `PENDING_COSTING` |

> **Cost feed:** `outside_repair_cost = Σ COALESCE(actual_cost, estimated_cost)` over the JC’s OSRs.
> While an OSR is not yet RECEIVED/INVOICED the JC **cannot** pass the close gate (§10).

---

## 7. Labour Capture Model

### 7.1 `tx_job_labour` (Numbering type `LAB`)

| Column | Type | Notes |
|--------|------|-------|
| `labour_id` | BIGINT PK | |
| `labour_no` | VARCHAR(30) UNIQ | `LAB-<SITE>-<YY>-NNNNNN` (one sheet may cover many rows) |
| `jobcard_id` | BIGINT FK→`tx_jobcard` | |
| `task_id` | BIGINT NULL FK→`txl_jobcard_task` | Task-level labour |
| `employee_id` | BIGINT FK→`md_employee` | `is_technician=1`, has `grade_id` |
| `labour_date` | DATE NOT NULL | Drives which `md_labour_rate` applies |
| `hours` | DECIMAL(18,4) | Actual hours worked |
| `hourly_rate` | DECIMAL(18,2) | **Resolved** from `md_labour_rate` effective-dated as-of `labour_date` (by grade/technician) |
| `labour_rate_id` | BIGINT FK→`md_labour_rate` | The exact rate row used (auditability) |
| `labour_cost` | DECIMAL(18,2) | Computed `hours × hourly_rate` |
| `is_overtime` | BIT | OT multiplier from `sys_setting` if used |
| **audit** | — | standard |

### 7.2 Rate resolution (effective-dated)

```
hourly_rate = md_labour_rate.hourly_rate
              WHERE grade_id = md_employee(employee_id).grade_id
                AND effective_date <= tx_job_labour.labour_date
                AND (end_date IS NULL OR end_date >= labour_date)
              ORDER BY effective_date DESC LIMIT 1
labour_cost = hours × hourly_rate            (frozen at capture; stored, not re-derived at close)
```

---

## 8. Cost Formulas + Worked Example

### 8.1 Formulas

| Element | Formula | Source |
|---------|---------|--------|
| **Labour cost** | `Σ (hours × effective hourly_rate)` | `tx_job_labour.labour_cost` |
| **Material cost** | `Σ (qty × valuation_unit_cost as-of issue date)` | `tx_job_parts` where `is_general=0` (MWAC/provisional) |
| **General item cost** | `Σ (general qty × unit_cost)` | `tx_job_parts` where `is_general=1` |
| **Outside repair cost** | `Σ COALESCE(actual_cost, estimated_cost)` | `tx_job_outside_repair` |
| **Overhead (optional)** | `(labour + material + general) × overhead_pct` | `sys_setting.overhead_pct` |
| **Total job cost** | `labour + material + general + outside + overhead` | `cost_job_summary.total_job_cost` |
| **Variance amount** | `Actual − Estimated` = `total_job_cost − tx_jobcard.estimated_cost` | `cost_variance.variance_amt` |
| **Variance %** | `(Actual − Estimated) / Estimated × 100` | `cost_variance.variance_pct` |

### 8.2 Landing tables

| Table | Grain | Key columns |
|-------|-------|-------------|
| `cost_job_line` | one row per cost element (or per source doc) | `jobcard_id`, `cost_element` (LABOUR/MATERIAL/GENERAL/OUTSIDE/OVERHEAD), `source_doc_type`, `source_doc_id`, `qty`, `unit_cost`, `line_cost`, `is_provisional` |
| `cost_job_summary` | one row per JC | `jobcard_id`, `labour_cost`, `material_cost`, `general_cost`, `outside_repair_cost`, `overhead_cost`, `total_job_cost`, `estimated_cost`, `is_provisional`, `calculated_at` |
| `cost_variance` | one row per JC | `jobcard_id`, `estimated_cost`, `actual_cost`, `variance_amt`, `variance_pct`, `variance_reason` |

### 8.3 Worked numeric example — `JC-CMB-26-000502` (estimated_cost = 240,000.00 LKR)

**Labour (`tx_job_labour`)**

| Technician (grade) | labour_date | hours | hourly_rate (as-of) | labour_cost |
|--------------------|-----------|-------|---------------------|------------|
| T-101 (G3) | 2026-07-02 | 8.00 | 900.00 | 7,200.00 |
| T-101 (G3) | 2026-07-03 | 6.00 | 900.00 | 5,400.00 |
| T-204 (G2, OT) | 2026-07-03 | 4.00 | 1,300.00 | 5,200.00 |
| **Labour cost** | | **18.00** | | **17,800.00** |

**Material — spares (`tx_job_parts`, is_general=0)**

| Item | qty | unit_cost (MWAC as-of) | part_cost | provisional? |
|------|-----------|------------------------|-----------|--------------|
| Brake pad set | 2.0000 | 12,500.00 | 25,000.00 | no |
| Oil seal | 4.0000 | 1,800.00 | 7,200.00 | no |
| Clutch plate | 1.0000 | 34,000.00 | 34,000.00 | **yes (provisional)** |
| **Material cost** | | | **66,200.00** | flagged |

**General items (`tx_job_parts`, is_general=1)**

| Item | qty | unit_cost | part_cost |
|------|-----------|-----------|-----------|
| Grease (kg) | 3.0000 | 950.00 | 2,850.00 |
| Cleaning rags | 10.0000 | 60.00 | 600.00 |
| **General cost** | | | **3,450.00** |

**Outside repair (`tx_job_outside_repair`)**

| OSR | supplier | estimated_cost | actual_cost | costed |
|-----|----------|--------|-------------|--------|
| OSR-CMB-26-000031 (crank grinding) | SUB-07 | 45,000.00 | 47,500.00 | 47,500.00 |
| **Outside cost** | | | | **47,500.00** |

**Roll-up → `cost_job_summary`**

| Element | Amount (LKR) |
|---------|-------------|
| Labour | 17,800.00 |
| Material | 66,200.00 |
| General | 3,450.00 |
| Outside | 47,500.00 |
| Subtotal | 134,950.00 |
| Overhead @ 8% (labour+material+general = 87,450) | 6,996.00 |
| **Total job cost** | **141,946.00** |

**Variance → `cost_variance`**

```
estimated_cost = 240,000.00
actual_cost    = 141,946.00
variance_amt   = 141,946.00 − 240,000.00 = −98,054.00   (under budget)
variance_pct   = −98,054.00 / 240,000.00 × 100 = −40.86 %
is_provisional = TRUE  (clutch plate priced provisionally → total flagged, subject to recompute)
```

> Because one line is provisional, `cost_job_summary.is_provisional=1`. When the clutch-plate
> price is CONFIRMED (§9) the engine recomputes material_cost, total_job_cost and the variance,
> writing a fresh `calculated_at`.

---

## 9. Price-Effective-Date in Costing

| Situation | Costing behaviour | Flag |
|-----------|-------------------|------|
| Price CONFIRMED as-of issue date | `unit_cost` = `md_price_history`/`inv_stock_balance.moving_avg_cost` **as-of the movement date** | `is_provisional=0` |
| Item still `PENDING`/`PROVISIONAL` (row in `inv_pending_price`) | Cost at **last known / provisional price**; part & summary flagged | `is_provisional=1` |
| Price later CONFIRMED | Revaluation movement posted; MWAC re-derived; dependent `cost_job_line`/`cost_job_summary` **recomputed**; `cost_variance` refreshed | flag cleared |

```
Costing price resolution (per issued part, per §7-contract rule "price as-of transaction date")
──────────────────────────────────────────────────────────────────────────────────────────────
IF item priced        → unit_cost = value from md_price_history WHERE effective_date <= issue_date
                                     (else inv_stock_balance.moving_avg_cost at issue_date)
IF inv_pending_price   → unit_cost = provisional; is_provisional=1; keep pointer to pending row
ON price CONFIRM       → recompute affected cost_job_line/summary/variance; log revaluation in ledger
```

> **Hard link to close gate:** any JC with `is_provisional=1` **or** with a row in
> `inv_pending_price` for its parts is blocked from `CLOSED` (§10).

---

## 10. Job Close Validations (HARD GATE — all must be TRUE to reach `CLOSED`)

Transition `PENDING_CLOSURE → CLOSED` is refused unless every check passes:

| # | Condition | System check (in words) | Blocks whom |
|---|-----------|-------------------------|-------------|
| 1 | All tasks completed | No `txl_jobcard_task` with status ∈ {PENDING, IN_PROGRESS} | Supervisor |
| 2 | Work completion recorded | `work_completed_at IS NOT NULL`, status ≥ WORK_COMPLETED | Supervisor |
| 3 | All approvals complete | `apr_request` for JC is CLOSED; `tm_approved_at` & `om_approved_at` set | Cost clerk |
| 4 | Labour captured | ≥1 `tx_job_labour` row for JC (or explicit `no_labour` flag with reason) | Supervisor |
| 5 | All requested parts issued or accounted | No `txl_job_material_req` line in {OPEN, RESERVED} for the JC (each ISSUED/PURCHASED/CANCELLED) | Storekeeper |
| 6 | External parts received | Every EXTERNAL line has a completed `tx_grn` (GRN status ≥ RECEIVED) | Storekeeper |
| 7 | **Zero pending prices** | `COUNT(inv_pending_price WHERE jobcard-linked part) = 0` **and** `cost_job_summary.is_provisional = 0` | Cost clerk |
| 8 | Outside repairs closed | Every `tx_job_outside_repair` status ∈ {RECEIVED, INVOICED, CLOSED}; none SENT/IN_PROGRESS | Supervisor / Accounts |
| 9 | Reservations resolved | No `inv_reservation` with status=ACTIVE for the JC (all CONSUMED/RELEASED) | Storekeeper |
| 10 | Cost roll-up done | `cost_job_summary` row exists with `calculated_at` after last cost-affecting change; `cost_variance` written | Cost clerk |
| 11 | Variance justified | If `ABS(variance_pct) > threshold` (`sys_setting`), `cost_variance.variance_reason` mandatory | Cost clerk / OM |
| 12 | GRN price complete | No parts sitting provisional pending revaluation (ties to #7) | Cost clerk |

```
CLOSE(jobcard_id):
   assert ALL(checks 1..12) == TRUE
   → jobcard_status = CLOSED ; approved close logged ; JC becomes read-only (correct via reversal only)
   else → raise gate failure listing the specific failing check(s)
```

---

## 11. Monitoring Logic (dashboard definitions)

| Bucket | Precise definition (in words) |
|--------|-------------------------------|
| **Open** | `jobcard_status NOT IN (CLOSED, CANCELLED, REJECTED)` — every live JC |
| **Pending approval** | `jobcard_status IN (PENDING_TM_APPROVAL, PENDING_OM_APPROVAL)` |
| **In workshop** | `jobcard_status IN (ASSIGNED_WORKSHOP, IN_PROGRESS, AWAITING_PARTS, AWAITING_OUTSIDE_REPAIR)` |
| **Awaiting parts** | `jobcard_status = AWAITING_PARTS` OR any `inv_reservation` ACTIVE unissued for the JC |
| **Awaiting outside repair** | `jobcard_status = AWAITING_OUTSIDE_REPAIR` OR any OSR in {SENT, IN_PROGRESS} |
| **Delayed** | `promised_date < today AND jobcard_status <> CLOSED` — OR — `age_days > SLA` where `age_days = today − COALESCE(work_started_at, jobcard_date)`; OSR overdue = `expected_return_date < today AND osr_status IN (SENT, IN_PROGRESS)` |
| **Stalled** | In workshop but `MAX(tx_job_progress.progress_date) < today − N` (no recent progress) |
| **Pending costing** | `jobcard_status = PENDING_COSTING` OR `cost_job_summary.is_provisional = 1` |
| **Pending closure** | `jobcard_status = PENDING_CLOSURE` AND one or more §10 checks still failing |
| **Completed** | `jobcard_status = CLOSED` — count/value from `cost_job_summary.total_job_cost` |

```
Delayed(JC) = (promised_date < today  AND status ≠ CLOSED)
           OR (today − COALESCE(work_started_at, jobcard_date) > SLA_days AND status ≠ CLOSED)
Age(JC)     = today − jobcard_date        (queue age, incl. approval time)
WIP value   = Σ cost_job_line.line_cost for JCs in workshop (not yet CLOSED)
```

---

## 12. Strong Controls

| Risk | Control mechanism | Enforced at | Who is blocked |
|------|-------------------|-------------|----------------|
| **Missing prices** | `inv_pending_price` rows / `is_provisional=1` hard-block `CLOSED`; provisional totals visibly flagged on cost tab | Close gate #7/#12; costing engine | Cost clerk (cannot close) |
| **Unreceived external parts** | Every EXTERNAL MRQ line needs GRN ≥ RECEIVED; no phantom parts costed | Close gate #6; §5.4 | Storekeeper / Cost clerk |
| **Unauthorized close** | Close is a permissioned action (`sec_permission JOBCARD_CLOSE`); atomic §10 assertion; post-close JC read-only, only reversal by OM | Close gate; `sec_role_permission` | Anyone lacking JOBCARD_CLOSE right |
| **Missing approvals** | No `jobcard_no` posting/assignment until `apr_request` progresses; workshop assignment blocked before APPROVED; close gate #3 | Approval engine + gate | Officer / Workshop controller |
| **Incomplete labour capture** | Gate #4 requires ≥1 `tx_job_labour` (or `no_labour` reason); labour frozen at `hours × effective rate` | Close gate #4; §7 | Supervisor |
| **Issue beyond stock** | Contract §7 rule: no issue when `available_qty < requested_qty` unless recorded override (`override_by`, `override_reason`) | `tx_issue` posting | Storekeeper |
| **Double-counting labour** | Costing reads `tx_job_labour` only, never `tx_job_progress.hours_spent` | Costing engine (§4/§7) | — (design guard) |
| **Variance not explained** | `ABS(variance_pct) > threshold` forces `cost_variance.variance_reason` | Close gate #11 | Cost clerk / OM |
| **Editing a closed job** | No physical deletes (contract §1.4); corrections via reversing document only | DB + app layer | Everyone |
| **Meter roll-back** | `meter_reading` validated ≥ last known on `md_asset` | JC create | Officer |

---

## 13. Suggested UI Screens

### 13.1 Job Card Cockpit (single asset-under-repair view)

```
┌ JC-CMB-26-000502   Asset: WP-CAB-1234 (Tipper)   Status: IN_PROGRESS ▸ AWAITING_PARTS ┐
│ Complaint: "Gearbox noise + brake bind"   Priority: HIGH   Promised: 2026-07-06        │
│ Booked: T.Officer  TM✔  OM✔   Meter: 148,320 km   Supervisor: S-12  Lead: T-101        │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ [Tasks] [Progress] [Parts] [Labour] [Outside] [Cost Summary] [Attachments]              │
│                                                                                         │
│ TASKS         line | task_description  | est hrs | tech  | status                        │
│               1    | Brake overhaul    | 6.0     | T-101 | IN_PROGRESS                    │
│               2    | Crank grind (OSR) | –       | –     | AWAITING_OUTSIDE_REPAIR        │
│                                                                                         │
│ PROGRESS ▸ timeline: 07-02 40% ─ 07-03 65% ─ 07-04 [awaiting clutch plate]              │
│ PARTS   ▸ Brake pad ×2  Oil seal ×4  Clutch ×1(prov⚠)   Grease 3kg (gen)                │
│ LABOUR  ▸ 18.0 hrs → 17,800.00                                                          │
│ OUTSIDE ▸ OSR-…031 crank grind → 47,500.00 (RECEIVED)                                   │
│ COST    ▸ Lab 17,800 | Mat 66,200⚠ | Gen 3,450 | OSR 47,500 | OH 6,996 = 141,946        │
│          Est 240,000  Var −98,054 (−40.9%)  [PROVISIONAL – 1 price pending]              │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### 13.2 Approval Screen (TM / OM inbox)

| Column | Purpose |
|--------|---------|
| JC No / Asset / Priority | Identify the request |
| Complaint + task summary | Decision context |
| Estimated cost | Budget sign-off basis |
| Current step / age | `apr_step` state + pending age (escalation cue) |
| Actions | **Approve / Reject / Return / Delegate** → writes `apr_action`, advances `jobcard_status` |

### 13.3 Workshop Board (Kanban by `jobcard_status`)

```
ASSIGNED      IN_PROGRESS      AWAITING_PARTS   AWAITING_OSR     WORK_COMPLETED   PENDING_CLOSURE
──────────    ───────────      ──────────────   ────────────     ──────────────   ──────────────
JC-…511       JC-…502  65%     JC-…502 clutch   JC-…498 crank    JC-…505          JC-…490 (gate:
 Tipper        Tipper           JC-…507          JC-…502 crank     Loader           price pending⚠)
[VOR]         JC-…509  30%                                                          JC-…487 (gate:
              [DELAYED⚠]                                                             OSR open⚠)

Card badges: [VOR] [DELAYED] [STALLED] [PROVISIONAL⚠]   Filters: site, supervisor, priority, delayed-only
```

---

## 14. Cross-References

| Concern | Owning document |
|---------|-----------------|
| `md_asset`, `md_item`, `md_employee`, `md_labour_rate`, `md_price_history` definitions | Design contract §2 + Master Data doc |
| `mv_stock_ledger`, `inv_stock_balance`, MWAC, `inv_pending_price`, `inv_reservation` | Design contract §4/§6 + Inventory/Stores doc |
| `tx_grn`, `tx_po`, `tx_issue` mechanics | Stores/Material Management doc |
| Generic approval engine (`sys_workflow`, `apr_*`) | Design contract §3.6 + Workflow doc |
| Dashboards / reporting surfaces | Monitoring & Reporting doc |

> **New objects introduced by this section** (all follow contract prefixes): `tx_job_parts`
> columns `is_general`, `is_provisional`, `ledger_id`; `cost_job_summary.is_provisional`;
> `cost_variance.variance_reason`; `sys_setting` keys `overhead_pct`, `variance_pct_threshold`,
> `stall_days`, `jobcard_sla_days`, `osr_sla_days`. No parallel names created for existing objects.
