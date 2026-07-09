# UMMS — Section 06: Dashboards & KPI Design

> **Scope:** Seven role-based dashboards, a consolidated KPI catalog, alert/exception monitoring, and site-restricted (row-level-security) visibility rules for the Unified Master Management System.
> **Conforms to:** `docs/00-design-contract.md` — all table names, `*_id`/`*_no`/`*_qty` columns, numbering `TYPE-SITE-YY-NNNNNN`, status vocabularies (`sys_status.status_group`), MWAC valuation, and the `apr_*` approval engine are reused verbatim. No parallel names are introduced. Two read-only reporting artifacts are proposed under the contract's prefix rules (see §9) and flagged as NEW.

---

## 0. Design Principles (read first)

| Principle | Rule in UMMS |
|-----------|--------------|
| One source per KPI | Every KPI reads canonical tables (`mv_stock_ledger`, `inv_stock_balance`, `inv_pending_price`, `tx_*`, `cost_*`). No shadow aggregates. |
| Site-scoped by default | Every card, chart and grid is filtered by `site_id ∈ sec_user_site` unless the user holds a roll-up role. See §8. |
| Drill-to-document | Every KPI card is a link: **card → filtered list (grid) → source document**. No dead-end numbers. |
| Costing honesty | Any value KPI that includes un-priced receipts shows a **provisional flag** and a companion "pending pricing" figure, because MWAC is provisional until `inv_pending_price` clears (contract §6). |
| Append-only truth | Trend/flow KPIs read `mv_stock_ledger` (immutable) and `hist_battery_event`, never mutable balances, so history never rewrites. |
| Refresh honesty | Each card states its refresh class (Real-time / 5-min / Hourly / Nightly). See catalog §7. |

**Reading key used in every KPI table below**

```
Source table(s)   = canonical contract tables the metric aggregates
Threshold/target  = value that flips the card color / raises an alert
Trend             = comparison shown on the card (sparkline / delta vs prior period)
```

Card color convention (all dashboards): `GREEN` = within target, `AMBER` = watch, `RED` = breach/alert. Colors are computed from the Threshold column.

---

## 1. Executive Dashboard

### 1.1 Audience & purpose

| Attribute | Value |
|-----------|-------|
| Audience | GM / Operational Manager (OM) / Finance Head |
| Role gate | `sec_role` ∈ {OM, GM, FIN_HEAD} — roll-up visibility across **all** sites |
| Purpose | One-screen health of inventory value, workshop throughput, spend and exceptions across every site; entry point that drills into the six operational dashboards |
| Refresh | Cards 5-min; value cards hourly; spend nightly |

### 1.2 KPI cards

| # | KPI name | Definition / formula | Source table(s) | Threshold / target | Trend |
|---|----------|----------------------|-----------------|--------------------|-------|
| E1 | Total Stock Value | `Σ (inv_stock_balance.on_hand_qty × moving_avg_cost)` across all `item_id × location_id` | `inv_stock_balance` | Info card; AMBER if MoM ↑ >10% | Sparkline, 12-month month-end snapshot |
| E2 | Pending Pricing (count + value) | `COUNT(*)` and `Σ(pending_qty × provisional_price)` where line still open | `inv_pending_price` | AMBER >0; RED if value > LKR 2.5M or age > 7 days | Delta vs yesterday |
| E3 | Open Job Cards | `COUNT(tx_jobcard)` where `jobcard_status NOT IN (CLOSED, CANCELLED, REJECTED)` | `tx_jobcard` | AMBER > site limit; RED trending up 3 days | Sparkline daily |
| E4 | Overdue Job Cards | `COUNT` where `promised_date < today` AND status not in terminal set | `tx_jobcard` | RED > 0 | Delta vs last week |
| E5 | WIP Job Value | `Σ cost_job_summary.total_job_cost` for jobs in {IN_PROGRESS, AWAITING_PARTS, AWAITING_OUTSIDE_REPAIR, WORK_COMPLETED, PENDING_COSTING} | `cost_job_summary`, `tx_jobcard` | Info; AMBER if > budget | Bar vs prior month |
| E6 | Purchase Spend (MTD) | `Σ txl_grn.line_amt` where `grn_date` in current month, priced | `tx_grn`, `txl_grn` | vs monthly budget in `sys_setting` | Bar vs prior month |
| E7 | Low-Stock Items | `COUNT DISTINCT item_id` where `on_hand_qty ≤ reorder_level` | `inv_stock_balance`, `md_item` | AMBER > 20; RED > 50 | Delta vs yesterday |
| E8 | Battery Warranty Due (30d) | `COUNT(md_battery)` where `warranty_end_date` within 30 days, `battery_status = IN_SERVICE` | `md_battery`, `md_warranty_term` | AMBER > 0 | Count trend |
| E9 | Open Exceptions | `COUNT` of active rows in exception feed (see §10) | exception feed (§9) | RED if any `CRITICAL` open | Delta 24h |
| E10 | Average Job Cost (30d) | `AVG(cost_job_summary.total_job_cost)` for jobs CLOSED in last 30d | `cost_job_summary` | vs 90-day baseline | Sparkline |

### 1.3 Charts & grids

| Object | Type | Shows | Drill-down target |
|--------|------|-------|-------------------|
| C-E1 | Stacked column | Stock value by `item_type` (STORE/LUBRICANT/BATTERY/SPARE/GENERAL/CONSUMABLE) per site | → Stores dashboard filtered by item_type + site |
| C-E2 | Line, dual-axis | Receipt vs Issue trend (12 mo): `Σ IN qty/value` vs `Σ OUT qty/value` from ledger | → Receipt/Issue grid filtered by month |
| C-E3 | Horizontal bar | Purchase spend by supplier (top 10) | → Supplier spend grid → PO/GRN docs |
| C-E4 | Bar | Job cost by vehicle (top 15 `md_asset` VEHICLE) | → Workshop dashboard filtered by asset |
| C-E5 | Site tiles | Per-site scorecard: stock value, open JCs, exceptions | → that site's Executive filter |
| G-E1 | Grid | Cross-site roll-up: site \| stock value \| pending price \| open JC \| overdue JC \| WIP value \| exceptions | click cell → relevant operational dashboard scoped to site |

Chart data note: C-E2 aggregates `mv_stock_ledger` by `mv_direction` (IN/RET_IN/XFER_IN vs OUT/XFER_OUT), grouped on `posted_at` month — immutable and reconcilable.

### 1.4 Drill-down paths

```
E2 Pending Pricing card
   → inv_pending_price grid (filter site, sort age desc)
       → open source line txl_grn / txl_lube_issue
           → GRN doc tx_grn (status QC_PASSED→PRICED)  → md_price_history entry

E4 Overdue Job Cards card
   → tx_jobcard grid (promised_date < today, non-terminal)
       → Job Card doc JC-<SITE>-YY-NNNNNN
           → cost_job_summary + txl_jobcard_task + tx_job_progress

E6 Purchase Spend
   → Supplier spend grid (group md_supplier)
       → tx_grn list → GRN doc → txl_grn lines
```

---

## 2. Stores / Material Dashboard

### 2.1 Audience & purpose

| Attribute | Value |
|-----------|-------|
| Audience | Store Keeper, Stores In-charge, Site Manager |
| Role gate | `sec_role` ∈ {STORE_KEEPER, STORE_INCHARGE, SITE_MGR}; scoped to `sec_user_site` |
| Purpose | Day-to-day control of stockable items: on-hand value, reorder exposure, movement velocity, un-priced receipts, transfer activity |
| Scope filter | `item_type ∈ {STORE, SPARE, GENERAL, CONSUMABLE}` + `site_id ∈ sec_user_site` |

### 2.2 KPI cards

| # | KPI name | Definition / formula | Source table(s) | Threshold / target | Trend |
|---|----------|----------------------|-----------------|--------------------|-------|
| S1 | Stock Value (site) | `Σ(on_hand_qty × moving_avg_cost)` for this site | `inv_stock_balance` | Info; AMBER MoM ↑>10% | 12-mo sparkline |
| S2 | Low-Stock Items | `COUNT DISTINCT item_id` where `on_hand_qty ≤ md_item.reorder_level` and `>0` | `inv_stock_balance`, `md_item` | AMBER>10, RED>25 | delta vs yesterday |
| S3 | Out-of-Stock (stockable) | `COUNT` where `on_hand_qty = 0` and `is_stockable=1` | `inv_stock_balance`, `md_item` | RED>0 for critical group | delta |
| S4 | Pending Pricing (site) | count + `Σ(pending_qty×provisional_price)` | `inv_pending_price` | AMBER>0, RED age>7d | delta |
| S5 | Fast-Moving Items | `COUNT` where issue velocity in top quartile: `Σ OUT qty (90d)/avg on_hand` ≥ threshold | `mv_stock_ledger`, `inv_stock_balance` | Info | rank change |
| S6 | Slow-Moving / Dead Items | `COUNT` where no `OUT` movement in ≥ 180 days AND `on_hand_qty>0` | `mv_stock_ledger`, `inv_stock_balance` | AMBER value>LKR1M dead | value trend |
| S7 | Dead Stock Value | `Σ(on_hand_qty×moving_avg_cost)` for S6 set | `inv_stock_balance` | RED if > threshold in `sys_setting` | MoM |
| S8 | Open MRN (indents) | `COUNT(tx_mrn)` status in {SUBMITTED, APPROVED} not fully issued | `tx_mrn` | AMBER aging>3d | delta |
| S9 | GRN Awaiting QC/Price | `COUNT(tx_grn)` status in {RECEIVED, QC_PENDING, QC_PASSED} not PRICED | `tx_grn` | AMBER>0 | aging |
| S10 | Transfer Volume (site) | `Σ ABS(qty)` of `XFER_OUT`+`XFER_IN` this month | `mv_stock_ledger` | Info | MoM |

### 2.3 Charts & grids

| Object | Type | Shows | Drill-down |
|--------|------|-------|------------|
| C-S1 | Pareto (bar+cum line) | Stock value by `md_item_category` | → item list in category |
| C-S2 | Line dual-axis | Receipt vs Issue trend (this site, 12 mo) from ledger | → Receipt/Issue grid |
| C-S3 | Bar | Transfer volume by location (`md_location`) — out vs in | → `tx_transfer` list |
| C-S4 | Scatter/quadrant | ABC-velocity: value vs movement freq (fast vs dead quadrants) | → item drill |
| C-S5 | Donut | Stock value split STORE/SPARE/GENERAL/CONSUMABLE | → filtered item grid |
| G-S1 | Reorder grid | item_no \| description \| on_hand_qty \| reorder_level \| avg daily issue \| days-of-cover \| suggested order qty | → `md_item` → raise `tx_mrn` |
| G-S2 | Pending-price grid | grn_no \| item \| received_qty \| provisional_price \| age(days) \| source | → `txl_grn` → price entry |
| G-S3 | Dead-stock grid | item_no \| last issue date \| on_hand_qty \| value \| days idle | → item ledger `mv_stock_ledger` |

Days-of-cover formula (G-S1): `on_hand_qty ÷ (Σ OUT qty last 90d ÷ 90)`.

### 2.4 Drill-down paths

```
S2 Low-Stock → G-S1 Reorder grid (on_hand ≤ reorder_level)
   → md_item detail → "Create MRN" → tx_mrn (DRAFT) → txl_mrn lines

S6 Slow/Dead → G-S3 Dead-stock grid
   → item ledger view (mv_stock_ledger filter item_id, all mv_direction)
       → last OUT movement doc (tx_issue / txl_issue)

S9 GRN Awaiting → tx_grn grid (status RECEIVED/QC_PENDING/QC_PASSED)
   → GRN doc → QC action → price → md_price_history (PRICE: PENDING→CONFIRMED)
```

---

## 3. Lubricant Dashboard

### 3.1 Audience & purpose

| Attribute | Value |
|-----------|-------|
| Audience | Lube Store Keeper, Workshop In-charge, Site Manager |
| Role gate | {LUBE_KEEPER, WORKSHOP_INCHARGE, SITE_MGR}; scoped to `sec_user_site` |
| Purpose | Lubricant/oil stock-book control: monthly consumption, usage per asset, days-of-cover, abnormal usage detection, month-end reconciliation |
| Scope filter | `md_item.item_type = LUBRICANT` + `site_id ∈ sec_user_site` |

### 3.2 KPI cards

| # | KPI name | Definition / formula | Source table(s) | Threshold / target | Trend |
|---|----------|----------------------|-----------------|--------------------|-------|
| L1 | Monthly Lubricant Consumption | `Σ txl_lube_issue.issue_qty` (or `mv_stock_ledger` OUT, item_type=LUBRICANT) current month, by UoM (L) | `tx_lube_issue`, `mv_stock_ledger` | vs 3-mo avg; AMBER ↑>15% | 12-mo bar |
| L2 | Lube Consumption Value (MTD) | `Σ OUT qty × moving_avg_cost` current month | `mv_stock_ledger`, `inv_stock_balance` | vs budget | MoM |
| L3 | Average Lube Usage per Asset | `Σ issue_qty ÷ COUNT DISTINCT asset_id` (period) | `tx_lube_issue`, `md_asset` | Info | trend |
| L4 | Days-of-Cover (per grade) | `on_hand_qty ÷ (avg daily consumption 90d)` | `inv_stock_balance`, `mv_stock_ledger` | AMBER<15d, RED<7d | sparkline |
| L5 | Lube Stock Value | `Σ(on_hand_qty×moving_avg_cost)` item_type=LUBRICANT | `inv_stock_balance` | Info | MoM |
| L6 | Top Consuming Assets (lube) | rank `md_asset` by `Σ issue_qty` (period) | `tx_lube_issue`, `md_asset` | Info | rank change |
| L7 | Abnormal Usage Flags | assets where L/1000km (or L/hr) > `md_asset` norm ×1.5 | `tx_lube_issue`, `md_asset_vehicle` | RED>0 | count |
| L8 | Month-End Variance | `book_balance − physical_balance` from monthly snapshot | `inv_lube_monthly_balance`, `inv_stock_balance` | AMBER any variance, RED>2% | MoM |

Consumption rate (L7): uses `meter_reading` delta between successive `tx_lube_issue` for same `asset_id` (contract §7.5 requires `meter_reading`) → litres per 1000 km (vehicle) or per running hour (machine, via `md_asset_machine` hour meter).

### 3.3 Charts & grids

| Object | Type | Shows | Drill-down |
|--------|------|-------|------------|
| C-L1 | Column | Monthly consumption by lube grade (item), 12 mo | → lube issue grid |
| C-L2 | Line | Days-of-cover per grade over time | → `inv_stock_balance` grade |
| C-L3 | Horizontal bar | Top 15 consuming assets (litres) | → asset lube history |
| C-L4 | Bar+control-limit | L/1000km per vehicle vs norm band | → asset detail / flag |
| C-L5 | Waterfall | Month-end reconciliation: open + receipts − issues ± adj = close | → `inv_lube_monthly_balance` |
| G-L1 | Consumption grid | asset_no \| reg \| grade \| litres \| meter delta \| L/1000km \| vs norm | → asset → `tx_lube_issue` list |
| G-L2 | Days-of-cover grid | grade item_no \| on_hand \| avg daily L \| days cover \| reorder flag | → `md_item` → MRN |

### 3.4 Drill-down paths

```
L1 Monthly Consumption card
   → G-L1 consumption grid (group asset_id)
       → asset lube history (tx_lube_issue where asset_id)
           → LUB-<SITE>-YY-NNNNNN doc (meter_reading, qty, cost)

L7 Abnormal Usage
   → G-L1 filtered (L/1000km > norm×1.5)
       → asset detail md_asset_vehicle (norm) vs actual → raise inspection JC (tx_jobcard)

L8 Month-End Variance
   → inv_lube_monthly_balance snapshot vs inv_stock_balance
       → adjustment doc tx_adjustment (ADJ_IN/ADJ_OUT) if reconciled
```

---

## 4. Battery Dashboard (serial-tracked)

### 4.1 Audience & purpose

| Attribute | Value |
|-----------|-------|
| Audience | Battery Store Keeper, Workshop In-charge, Warranty Officer, Site Manager |
| Role gate | {BATTERY_KEEPER, WARRANTY_OFFICER, WORKSHOP_INCHARGE, SITE_MGR}; scoped `sec_user_site` |
| Purpose | Serial-level battery control: warranty exposure, stock vs in-service population, transfers, returns/scrap, warranty-claim pipeline |
| Scope filter | `md_battery` joined to `md_item.item_type=BATTERY`; `site_id ∈ sec_user_site` |

### 4.2 KPI cards

| # | KPI name | Definition / formula | Source table(s) | Threshold / target | Trend |
|---|----------|----------------------|-----------------|--------------------|-------|
| B1 | Batteries In Stock | `COUNT(md_battery)` where `battery_status = IN_STOCK` | `md_battery` | AMBER < min holding | delta |
| B2 | Batteries In Service | `COUNT` where `battery_status = IN_SERVICE` | `md_battery` | Info | trend |
| B3 | Warranty Due (≤30d) | `COUNT` where `warranty_end_date` within 30d, status IN_SERVICE | `md_battery`, `md_warranty_term` | AMBER>0 | count |
| B4 | Warranty Expired (in service) | `COUNT` where `warranty_end_date < today`, status IN_SERVICE | `md_battery`, `md_warranty_term` | RED>0 | delta |
| B5 | Under Warranty Claim | `COUNT` where `battery_status = UNDER_WARRANTY_CLAIM` | `md_battery` | AMBER aging>14d | aging |
| B6 | Battery Stock Value | `Σ md_battery.acquisition_cost` where IN_STOCK (serialized valuation, contract §6) | `md_battery` | Info | MoM |
| B7 | Returns / Scrap (MTD) | `COUNT(tx_battery_return)` by disposition {RETURNED, SCRAPPED, REPLACED} | `tx_battery_return`, `hist_battery_event` | Info; RED early-failure spike | MoM |
| B8 | Early Failures | batteries SCRAPPED/RETURNED with `service_days < warranty_days×0.5` | `md_battery`, `hist_battery_event` | RED>0 | count |
| B9 | Avg Battery Service Life | `AVG(return_date − issue_date)` for terminated serials | `hist_battery_event` | vs expected | trend |
| B10 | Transfers (MTD) | `COUNT(tx_battery_transfer)` | `tx_battery_transfer`, `hist_battery_event` | Info | MoM |

### 4.3 Charts & grids

| Object | Type | Shows | Drill-down |
|--------|------|-------|------------|
| C-B1 | Donut | Population by `battery_status` (IN_STOCK/IN_SERVICE/UNDER_WARRANTY_CLAIM/…) | → serial grid by status |
| C-B2 | Timeline/Gantt | Warranty windows: due-soon & expired serials | → `md_battery` serial |
| C-B3 | Column | Returns/scrap by month, split by disposition | → `tx_battery_return` list |
| C-B4 | Histogram | Service-life distribution (days) | → early-failure serials |
| C-B5 | Bar | Battery count by asset/site | → asset battery history |
| G-B1 | Warranty grid | serial_no \| item \| current_asset \| issue_date \| warranty_end \| days left \| status | → `md_battery` → `hist_battery_event` |
| G-B2 | Serial ledger | serial_no \| event \| from_asset \| to_asset \| doc_no \| date | → BAT/BTR/BRT doc |

### 4.4 Drill-down paths

```
B3/B4 Warranty Due/Expired
   → G-B1 warranty grid (warranty_end_date filter)
       → md_battery serial register
           → hist_battery_event full lifecycle (IN_STOCK→ISSUED→IN_SERVICE→…)
               → originating BAT-<SITE>-YY-NNNNNN issue doc + md_warranty_term

B5 Under Warranty Claim
   → serial grid (status=UNDER_WARRANTY_CLAIM)
       → tx_battery_return (BRT) claim doc → doc_attachment (serial proof image)

B8 Early Failures
   → service-life histogram left tail
       → hist_battery_event (issue→return) → supplier md_supplier for claim
```

---

## 5. Workshop Dashboard (Job Card & Costing)

### 5.1 Audience & purpose

| Attribute | Value |
|-----------|-------|
| Audience | Workshop In-charge, Transport Manager (TM), Foreman, Costing Clerk |
| Role gate | {WORKSHOP_INCHARGE, TM, FOREMAN, COSTING_CLERK, SITE_MGR}; scoped `sec_user_site` |
| Purpose | Throughput and cost control of job cards: backlog, delays, labour utilization, WIP, cost by vehicle, average job cost, parts/outside-repair bottlenecks |
| Scope filter | `tx_jobcard.site_id ∈ sec_user_site` |

### 5.2 KPI cards

| # | KPI name | Definition / formula | Source table(s) | Threshold / target | Trend |
|---|----------|----------------------|-----------------|--------------------|-------|
| W1 | Open Job Cards | `COUNT` status not in {CLOSED, CANCELLED, REJECTED} | `tx_jobcard` | AMBER>capacity | daily sparkline |
| W2 | Overdue / Delayed | `COUNT` where `promised_date < today`, non-terminal | `tx_jobcard` | RED>0 | delta week |
| W3 | Awaiting Parts | `COUNT` status = AWAITING_PARTS | `tx_jobcard` | AMBER aging>2d | aging |
| W4 | Awaiting Outside Repair | `COUNT` status = AWAITING_OUTSIDE_REPAIR | `tx_jobcard`, `tx_job_outside_repair` | AMBER aging>3d | aging |
| W5 | Pending Approval | `COUNT` status in {PENDING_TM_APPROVAL, PENDING_OM_APPROVAL} | `tx_jobcard`, `apr_request` | AMBER aging>1d | count |
| W6 | Pending Costing/Closure | `COUNT` status in {PENDING_COSTING, PENDING_CLOSURE} | `tx_jobcard`, `cost_job_summary` | AMBER>0 | count |
| W7 | Labour Utilization | `Σ tx_job_labour.hours (booked) ÷ available tech-hours` | `tx_job_labour`, `md_employee`, `md_labour_rate` | target 70–85%; RED<50% or >100% | daily/weekly |
| W8 | WIP Job Value | `Σ cost_job_summary.total_job_cost` for non-closed jobs | `cost_job_summary` | Info; AMBER>threshold | trend |
| W9 | Average Job Cost | `AVG(total_job_cost)` jobs CLOSED last 30d | `cost_job_summary` | vs 90d baseline | sparkline |
| W10 | Avg Turnaround (TAT) | `AVG(closed_at − created_at)` CLOSED last 30d | `tx_jobcard` | target ≤ SLA days | trend |
| W11 | Cost Variance (est vs act) | `Σ actual − Σ estimate` over closed jobs; `variance_pct` | `cost_variance` | RED if `variance_pct` > 15% | trend |
| W12 | Cost Mix | share of labour / material / outside / general in `total_job_cost` | `cost_job_line` | Info | stacked |

Labour utilization detail (W7): denominator = `COUNT(md_employee where is_technician=1 & active) × standard_hours_per_day × working_days`; numerator from `tx_job_labour.hours`. Overtime (>100%) flags RED as a data-integrity / burnout signal.

### 5.3 Charts & grids

| Object | Type | Shows | Drill-down |
|--------|------|-------|------------|
| C-W1 | Funnel/stage bar | Job cards by status stage (DRAFT→…→CLOSED) | → JC grid at that status |
| C-W2 | Bar | Job cost by vehicle (`md_asset` VEHICLE, top 15) | → asset job history |
| C-W3 | Stacked bar | Cost mix (labour/material/outside/general) by month | → `cost_job_line` |
| C-W4 | Heatmap | Labour utilization by technician × day | → `tx_job_labour` |
| C-W5 | Line | Avg job cost & TAT trend 12 mo | → closed-jobs grid |
| C-W6 | Aging bar | Awaiting-parts / outside-repair aging buckets | → `tx_job_material_req` / `tx_job_outside_repair` |
| G-W1 | Open-jobs grid | jobcard_no \| asset/reg \| status \| age \| promised \| WIP cost \| assigned tech | → JC doc |
| G-W2 | Cost-by-vehicle grid | asset_no \| reg \| #jobs \| Σ cost \| avg cost \| labour% | → asset → JC list |
| G-W3 | Variance grid | jobcard_no \| estimate \| actual \| variance_amt \| variance_pct | → `cost_variance` → JC |

### 5.4 Drill-down paths

```
W2 Overdue → G-W1 (promised_date<today) → JC doc JC-<SITE>-YY-NNNNNN
   → txl_jobcard_task (defects) + tx_job_progress (daily log)
   → cost_job_summary → cost_job_line breakdown

W3 Awaiting Parts → jobs AWAITING_PARTS
   → tx_job_material_req (MRQ) → txl_job_material_req
       → inv_reservation / tx_issue / GRN status → clears back to IN_PROGRESS

W7 Labour Utilization → C-W4 heatmap cell (tech×day)
   → tx_job_labour lines (LAB-<SITE>-YY-NNNNNN) → md_employee → md_labour_rate

W11 Variance → G-W3 (variance_pct>15%)
   → cost_variance row → JC → cost_job_line (which element overran)
```

Costing integrity note: W8/W9/W11 are marked **provisional** on the card whenever the job has any line in `inv_pending_price` (contract §7.7 blocks CLOSED until pending price clears), so a job can never be "closed cheap" on a provisional cost.

---

## 6. Approval Queue Dashboard

### 6.1 Audience & purpose

| Attribute | Value |
|-----------|-------|
| Audience | Any approver — TM, OM, Store In-charge, Costing approver — plus a workflow-admin view |
| Role gate | rows filtered to requests where `apr_step.required_role ∈ user roles` AND (site scope OR delegated) |
| Purpose | Single actionable queue of everything awaiting **this** approver across all modules (MRN, PO, GRN pricing, Job Card TM/OM, Battery return, Adjustment), with aging and SLA |
| Backing engine | Generic `apr_*` (contract §3.6): `apr_request` → `apr_step` → `apr_action`, driven by `sys_workflow` / `sys_workflow_step` |

### 6.2 KPI cards

| # | KPI name | Definition / formula | Source table(s) | Threshold / target | Trend |
|---|----------|----------------------|-----------------|--------------------|-------|
| A1 | My Pending Approvals | `COUNT(apr_step)` where `step_status=PENDING` AND `required_role ∈ my roles` AND site in scope | `apr_step`, `apr_request`, `sec_user_role` | AMBER>0 | delta |
| A2 | Overdue Approvals (SLA) | subset of A1 where `age > sys_workflow_step.sla_hours` | `apr_step`, `sys_workflow_step` | RED>0 | delta |
| A3 | Avg Approval Time | `AVG(apr_action.acted_at − apr_step.assigned_at)` (30d, my role) | `apr_action`, `apr_step` | target ≤ SLA | trend |
| A4 | Escalated to Me | `COUNT(apr_step)` where last `apr_action.action = ESCALATED` to my role | `apr_action`, `apr_step` | AMBER>0 | delta |
| A5 | Returned by Me (open) | `COUNT` requests I set RETURNED still unresolved | `apr_action`, `apr_request` | Info | aging |
| A6 | Queue by Document Type | breakdown of A1 by source (`apr_request.source_type`: MRN/PO/GRN/JC/BRT/ADJ) | `apr_request` | Info | — |

### 6.3 Charts & grids

| Object | Type | Shows | Drill-down |
|--------|------|-------|------------|
| C-A1 | Stacked bar | Pending approvals by document type & aging bucket | → filtered queue |
| C-A2 | Line | Approval throughput (approved/day) vs incoming | → action log |
| G-A1 | Action queue | doc type \| doc_no \| requested_by \| site \| amount/value \| age \| SLA state \| step | inline **Approve / Reject / Return / Escalate** → writes `apr_action`, advances `apr_step`, transitions source `*_status` |

### 6.4 Drill-down & action paths

```
A1 My Pending → G-A1 queue row
   → source document preview:
        MRN  → tx_mrn / txl_mrn          (DOC: SUBMITTED→APPROVED)
        PO   → tx_po / txl_po
        GRN  → tx_grn pricing            (GRN: QC_PASSED→PRICED)
        JC   → tx_jobcard                (JOBCARD: PENDING_TM_APPROVAL→PENDING_OM_APPROVAL→APPROVED)
        BRT  → tx_battery_return         (warranty/scrap authorization)
        ADJ  → tx_adjustment
   → action button → apr_action (APPROVED/REJECTED/RETURNED/ESCALATED/DELEGATED)
        → apr_step advances → next sys_workflow_step or source doc final status
```

Every action is immutable in `apr_action` (contract §1.4 append-only), giving a full who-approved-what audit for any document reached from any other dashboard.

---

## 7. Consolidated KPI Catalog

> Master registry. `Refresh` classes: **RT** real-time on posting, **5m**, **H** hourly, **N** nightly batch, **M** month-end snapshot. `Owner` = accountable role.

| KPI | Formula (short) | Source table(s) | Refresh | Target / threshold | Owner |
|-----|-----------------|-----------------|---------|--------------------|-------|
| Total Stock Value | `Σ on_hand_qty×moving_avg_cost` | `inv_stock_balance` | H | tracked; AMBER MoM>10% | Stores In-charge |
| Pending Pricing (cnt+val) | `COUNT`,`Σ pending_qty×prov_price` | `inv_pending_price` | RT | 0 open >7d | Costing Clerk |
| Low-Stock Items | `on_hand_qty ≤ reorder_level` | `inv_stock_balance`,`md_item` | H | AMBER>20 RED>50 | Store Keeper |
| Out-of-Stock | `on_hand_qty=0 & is_stockable` | `inv_stock_balance`,`md_item` | H | RED>0 critical | Store Keeper |
| Fast-Moving Items | top-quartile issue velocity 90d | `mv_stock_ledger`,`inv_stock_balance` | N | info | Stores In-charge |
| Slow-Moving/Dead | no OUT ≥180d & qty>0 | `mv_stock_ledger`,`inv_stock_balance` | N | AMBER dead value>1M | Stores In-charge |
| Dead Stock Value | `Σ qty×avg_cost` dead set | `inv_stock_balance` | N | RED>threshold | Stores In-charge |
| Transfer Volume by Location | `Σ|qty| XFER_IN/OUT` | `mv_stock_ledger` | H | info | Stores In-charge |
| Receipt vs Issue Trend | `Σ IN` vs `Σ OUT` qty/val by month | `mv_stock_ledger` | H | info | Stores In-charge |
| Monthly Lube Consumption | `Σ lube OUT qty` month | `tx_lube_issue`,`mv_stock_ledger` | H | AMBER ↑>15% vs 3m | Lube Keeper |
| Avg Lube Usage / Asset | `Σ qty ÷ #assets` | `tx_lube_issue`,`md_asset` | N | info | Workshop In-charge |
| Lube Days-of-Cover | `on_hand ÷ avg daily` | `inv_stock_balance`,`mv_stock_ledger` | H | AMBER<15 RED<7 | Lube Keeper |
| Abnormal Lube Usage | L/1000km > norm×1.5 | `tx_lube_issue`,`md_asset_vehicle` | N | RED>0 | Workshop In-charge |
| Lube Month-End Variance | `book − physical` | `inv_lube_monthly_balance` | M | RED>2% | Lube Keeper |
| Batteries In Stock/Service | `COUNT by battery_status` | `md_battery` | RT | min holding | Battery Keeper |
| Battery Warranty Due (30d) | `warranty_end ≤ +30d & IN_SERVICE` | `md_battery`,`md_warranty_term` | N | AMBER>0 | Warranty Officer |
| Battery Warranty Expired | `warranty_end<today & IN_SERVICE` | `md_battery`,`md_warranty_term` | N | RED>0 | Warranty Officer |
| Battery Early Failures | scrap/return < 50% warranty | `md_battery`,`hist_battery_event` | N | RED>0 | Warranty Officer |
| Avg Battery Service Life | `AVG(return−issue)` | `hist_battery_event` | N | vs expected | Warranty Officer |
| Open Job Cards | non-terminal count | `tx_jobcard` | 5m | ≤ capacity | Workshop In-charge |
| Overdue/Delayed Jobs | `promised_date<today` non-terminal | `tx_jobcard` | 5m | RED>0 | Workshop In-charge |
| Labour Utilization | `booked hrs ÷ available hrs` | `tx_job_labour`,`md_employee` | H | 70–85% | Foreman |
| Job Cost by Vehicle | `Σ total_job_cost` per asset | `cost_job_summary`,`md_asset` | H | info | Costing Clerk |
| Average Job Cost | `AVG(total_job_cost)` closed 30d | `cost_job_summary` | H | vs 90d base | Costing Clerk |
| WIP Job Value | `Σ total_job_cost` non-closed | `cost_job_summary` | H | AMBER>threshold | Workshop In-charge |
| Cost Variance | `actual−estimate`,`variance_pct` | `cost_variance` | H | RED>15% | Costing Clerk |
| Avg Turnaround (TAT) | `AVG(closed_at−created_at)` | `tx_jobcard` | H | ≤ SLA | Workshop In-charge |
| Top Consuming Assets | rank asset by `Σ OUT qty/val` | `mv_stock_ledger`,`md_asset` | N | info | Workshop In-charge |
| Purchase Spend by Supplier | `Σ txl_grn.line_amt` by supplier | `tx_grn`,`txl_grn`,`md_supplier` | N | vs budget | Procurement |
| My Pending Approvals | `apr_step PENDING & my role` | `apr_step`,`apr_request` | RT | 0 aged | each approver |
| Overdue Approvals (SLA) | `age > sla_hours` | `apr_step`,`sys_workflow_step` | RT | RED>0 | Workflow Admin |
| Open Exceptions | active exception rows | exception feed (§9) | RT | 0 CRITICAL | Site Manager |

---

## 8. Site-Restricted Dashboard Rules (Row-Level Security)

### 8.1 The security spine

Every approvable/transactional table carries `site_id` (contract §1.3). Visibility is granted through `sec_user_site` (contract §3.7), which lists the `site_id`s each `sec_user` may see. Roll-up is granted through role flags on `sec_role`.

### 8.2 Visibility tiers

| Tier | Who | What they see | Rule |
|------|-----|---------------|------|
| Site user | Store Keeper, Technician, Lube/Battery Keeper | Only their own site(s) | `doc.site_id ∈ (SELECT site_id FROM sec_user_site WHERE user_id=@me AND is_active=1)` |
| Multi-site user | Regional keeper posted to 2–3 sites | The specific sites in their `sec_user_site` | same rule; multiple rows in `sec_user_site` |
| Site Manager | SITE_MGR | Own site full roll-up (all modules) | site scope = their site(s); no cross-site |
| Roll-up manager | OM, GM, TM (fleet-wide), FIN_HEAD | **All** sites | role carries `has_global_scope=1` → RLS predicate bypassed to `1=1` |
| Approver | any approval role | Only requests routed to their role **and** in their site scope | `apr_step.required_role ∈ my roles AND apr_request.site_id ∈ my site scope` (unless delegated via `DELEGATED` action) |

### 8.3 Row-level-security rule (in words)

> For any dashboard query, the reporting layer appends a mandatory predicate:
> **"Return a row only if the row's `site_id` is a site the current user is granted in `sec_user_site` (and active), UNLESS the user holds a role flagged global-scope, in which case all sites are returned."**
> The predicate is applied at the **view / semantic-model layer**, not in the UI, so it cannot be bypassed by URL tampering or direct grid export. The same predicate governs cards, charts, grids and every drill-down target, so a site user who drills from a KPI card can never reach a document from another site.

### 8.4 Roll-up mechanics

```
Site user           SELECT ... WHERE site_id IN (my sec_user_site)         → one site's numbers
Site Manager        same, but sees ALL modules for that site               → site scorecard
OM/GM (global)      predicate = 1=1                                        → all sites
Executive dashboard GROUP BY site_id → per-site tiles + grand total        → C-E5 / G-E1
```

- **Aggregation:** roll-up cards (E1, E3, E5…) `SUM`/`COUNT` after the RLS predicate — so a manager's total is exactly the sum of the sites they are allowed to see. A site user's "Total Stock Value" is only their site; the OM's is the whole company; neither runs a different query — only the predicate differs.
- **Cross-site drill:** clicking a site tile on the Executive dashboard re-scopes the child dashboard to that single `site_id` (the manager temporarily narrows scope; a site user cannot widen it).

### 8.5 Exception dashboard aggregation

- The Exception dashboard (§9–10) is generated by a nightly + real-time job that scans all sites and writes rows tagged with their originating `site_id`.
- A **site user** viewing the Exception dashboard still gets the RLS predicate → sees only exceptions for their site.
- A **roll-up manager** sees all sites, grouped by `site_id` and severity, with per-site counts — enabling comparison ("KND has 5 overdue jobs, CMB has 1").
- Severity roll-up: the Executive **Open Exceptions** card (E9) counts post-predicate, so each viewer sees the exception load for exactly their scope.

---

## 9. Exception Feed — data source (NEW, contract-conformant)

> These KPIs need a persisted, drillable exception list. Following the contract's prefix rules (`sys_` for configuration/definitions, and a materialized read model), the following NEW artifacts are proposed. They store **no new truth** — every row references an existing canonical document — so they never compete with `mv_stock_ledger`/`inv_*` as source of record.

| NEW object | Prefix rationale | Purpose |
|------------|------------------|---------|
| `sys_alert_rule` | `sys_` = system/configuration (contract §1.1) | Definition of each alert: code, trigger SQL/predicate, severity, channel, recipient role, throttle. Editable by Workflow Admin. |
| `sys_alert_event` | `sys_` = system-generated event log, append-only | One row per fired alert: `alert_code`, `site_id`, `source_doc_type`, `source_doc_id`, `source_doc_no`, `severity`, `fired_at`, `state` (OPEN/ACK/RESOLVED), `acknowledged_by`. Feeds the Exception dashboard and E9. |

Both carry standard audit columns + `site_id` (contract §1.3). `sys_alert_event` is append-only like other system logs; resolution is a state change with `resolved_at`, never a delete.

---

## 10. Exception Dashboard & Alert / Exception Monitoring

### 10.1 Audience & purpose

| Attribute | Value |
|-----------|-------|
| Audience | Site Manager (own site), OM/GM (all sites), plus targeted keepers per alert |
| Purpose | Single monitored list of every breach across all four modules + approvals, with severity, aging, acknowledge/resolve workflow, and channel notification |
| Backing | `sys_alert_rule` (definitions) → `sys_alert_event` (fired instances), evaluated RT on posting + nightly sweep |

### 10.2 Exception dashboard layout

| Object | Type | Shows | Drill-down |
|--------|------|-------|------------|
| X1 cards | severity tiles | Open CRITICAL / HIGH / MEDIUM counts (post-RLS) | → filtered event grid |
| X2 grid | event grid | severity \| alert \| site \| doc_no \| age \| state \| owner | → source document via `source_doc_type`+`source_doc_id` |
| X3 chart | stacked bar | Open exceptions by module × severity | → module dashboard |
| X4 chart | aging bar | Unacknowledged events by age bucket | → oldest first |
| X5 heatmap | site × alert-type | Where breaches cluster | → site-scoped drill |

### 10.3 Alert & exception monitoring logic

| # | Alert | Trigger condition | Severity | Channel | Recipient role |
|---|-------|-------------------|----------|---------|----------------|
| AL-01 | Negative / oversold stock | `inv_stock_balance.available_qty < 0` after any posting | CRITICAL | In-app + Email + SMS | Store In-charge, Site Mgr |
| AL-02 | Issue below zero blocked | issue attempted where `available_qty < requested_qty` without override (`override_by` null) | HIGH | In-app | Store Keeper |
| AL-03 | Pending price aging | `inv_pending_price` line age > 7 days | HIGH | In-app + Email | Costing Clerk, Stores In-charge |
| AL-04 | Pending price value spike | `Σ pending value > sys_setting threshold` | HIGH | Email | Costing Clerk, Finance |
| AL-05 | Low stock | `on_hand_qty ≤ reorder_level` (critical group) | MEDIUM | In-app | Store Keeper |
| AL-06 | Out of stock (critical item) | `on_hand_qty = 0` and item flagged critical | HIGH | In-app + Email | Store Keeper, Site Mgr |
| AL-07 | Dead stock threshold | dead-set value > threshold | MEDIUM | Email (weekly) | Stores In-charge |
| AL-08 | Lube days-of-cover low | days-of-cover < 7 for any grade | HIGH | In-app + Email | Lube Keeper |
| AL-09 | Abnormal lube usage | asset L/1000km > norm×1.5 | MEDIUM | In-app | Workshop In-charge |
| AL-10 | Lube month-end variance | `|book−physical| > 2%` | HIGH | Email | Lube Keeper, Site Mgr |
| AL-11 | Battery warranty due | `warranty_end_date ≤ +30d`, IN_SERVICE | MEDIUM | In-app + Email | Warranty Officer |
| AL-12 | Battery warranty expired in service | `warranty_end_date < today`, IN_SERVICE | HIGH | Email | Warranty Officer, Workshop In-charge |
| AL-13 | Battery early failure | scrap/return `service_days < warranty_days×0.5` | HIGH | Email | Warranty Officer, Procurement |
| AL-14 | Warranty claim aging | `battery_status=UNDER_WARRANTY_CLAIM` > 14d | MEDIUM | In-app | Warranty Officer |
| AL-15 | Job card overdue | `promised_date < today`, non-terminal | HIGH | In-app + Email | Workshop In-charge, TM |
| AL-16 | Job stuck awaiting parts | status AWAITING_PARTS > 2d | MEDIUM | In-app | Workshop In-charge, Store Keeper |
| AL-17 | Job stuck outside repair | status AWAITING_OUTSIDE_REPAIR > 3d | MEDIUM | In-app | Workshop In-charge |
| AL-18 | Job cost variance | `variance_pct > 15%` at costing | HIGH | Email | Costing Clerk, OM |
| AL-19 | Job close blocked by pending price | attempt to close with rows in `inv_pending_price` for the job | HIGH | In-app | Costing Clerk |
| AL-20 | Approval SLA breach | `apr_step` PENDING age > `sla_hours` | HIGH | In-app + Email + escalate | assigned approver → escalation role |
| AL-21 | Labour utilization anomaly | daily util <50% or >100% | MEDIUM | In-app | Foreman |
| AL-22 | Adjustment large value | `tx_adjustment` value > threshold | HIGH | Email | Site Mgr, Finance |

### 10.4 Alert lifecycle

```
sys_alert_rule (definition, enabled, throttle)
   │  evaluated: RT on document posting  +  nightly sweep
   ▼
sys_alert_event  (state = OPEN)  ──notify──► channel(s) to recipient role (site-scoped)
   │  user opens Exception dashboard → drill to source doc
   ▼
Acknowledge (state = ACK, acknowledged_by/at)  → work the source document
   ▼
Condition clears on next evaluation OR manual resolve → state = RESOLVED, resolved_at
   (row retained — append-only; re-breach fires a NEW event, subject to throttle)
```

- **Throttle:** each `sys_alert_rule` carries a re-fire window so a persistent low-stock item does not spam daily; a new event fires only after resolve or after the throttle window.
- **Escalation:** AL-20 (and any `HIGH` unacknowledged past its window) escalates by writing an `apr_action` of type `ESCALATED` and re-routing to the escalation role in `sys_workflow_step`, keeping approval and alerting on one audit trail.
- **Site scoping:** every `sys_alert_event.site_id` passes the §8.3 RLS predicate, so notifications and dashboard rows reach only in-scope users; roll-up managers receive the aggregated view.

---

## 11. Cross-dashboard drill map (summary)

```
EXECUTIVE ─┬─ E1 Stock Value      → STORES  (C-S1 category → item → mv_stock_ledger)
           ├─ E2 Pending Price    → STORES  G-S2 → txl_grn → md_price_history
           ├─ E3/E4 Jobs          → WORKSHOP G-W1 → tx_jobcard → cost_job_summary
           ├─ E6 Spend            → supplier grid → tx_grn/txl_grn
           ├─ E8 Warranty         → BATTERY G-B1 → md_battery → hist_battery_event
           └─ E9 Exceptions       → EXCEPTION X2 → sys_alert_event → source doc

APPROVAL QUEUE  → any module's source document (MRN/PO/GRN/JC/BRT/ADJ) → apr_action
EXCEPTION       → any KPI breach → owning module dashboard → document
```

Every terminal node is a **canonical contract document** (`tx_*`, `md_battery`, `mv_stock_ledger`, `cost_*`, `apr_action`) — no dashboard invents a number that cannot be traced to a posted movement, a serial event, a costing row, or an approval action.
