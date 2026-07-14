# 07 — User Roles, Permissions & Security

> **Scope of this document.** Authorization model for UMMS: the role catalogue, the module-by-module
> permission matrix, segregation-of-duties (SoD) rules, the site-based row-level visibility model,
> and the audit of approvals, reversals and price/cost edits.
> **Conformance:** all identities, roles, permissions and site scope live in the contract security
> tables `sec_user`, `sec_role`, `sec_user_role`, `sec_permission`, `sec_role_permission`,
> `sec_user_site` (see design-contract §3.7). Approval actions are logged in `apr_action`
> (§3.6). Every table carries the standard audit columns and `site_id` (§1.3). This document does
> **not** redefine those structures — it defines the *policy* wired on top of them.

---

## 1. Security Model — Layers

```
                         ┌──────────────────────────────────────────────┐
   who you are  ───────► │ 1. AUTHENTICATION   sec_user (login, status)  │
                         └──────────────────────────────────────────────┘
                                          │
                         ┌──────────────────────────────────────────────┐
   what role  ─────────► │ 2. ROLE BINDING     sec_user_role (N:N)       │
                         └──────────────────────────────────────────────┘
                                          │
                         ┌──────────────────────────────────────────────┐
   what you may do  ───► │ 3. CAPABILITY       sec_role_permission       │
                         │    (module × verb)  → sec_permission          │
                         └──────────────────────────────────────────────┘
                                          │
                         ┌──────────────────────────────────────────────┐
   on whose data  ─────► │ 4. ROW-LEVEL SCOPE  sec_user_site (site_id)   │
                         │    filters every tx_*/mv_*/inv_* by site_id   │
                         └──────────────────────────────────────────────┘
                                          │
                         ┌──────────────────────────────────────────────┐
   which fields  ──────► │ 5. FIELD-LEVEL      price/cost columns gated  │
                         │    + full field-change audit                  │
                         └──────────────────────────────────────────────┘
                                          │
                         ┌──────────────────────────────────────────────┐
   proven later  ──────► │ 6. AUDIT            apr_action + change log   │
                         └──────────────────────────────────────────────┘
```

**Composition rule:** an action is permitted **only if** the user passes *all five gates* —
active login (1) **AND** a role (2) that grants the module-verb capability (3) **AND** the target
row's `site_id` is in the user's `sec_user_site` scope (4) **AND**, for price/cost fields, the
field-level grant (5). Every write leaves a trail in gate 6.

| Model term | Contract table | Key columns (illustrative) |
|------------|----------------|-----------------------------|
| User | `sec_user` | `user_id`, `username`, `employee_id`→`md_employee`, `is_locked`, `is_active` |
| Role | `sec_role` | `role_id`, `role_code`, `role_name`, `is_approval_role`→`md_approval_role` |
| User↔Role | `sec_user_role` | `user_id`, `role_id`, `valid_from`, `valid_to` (time-boxed delegation) |
| Permission | `sec_permission` | `permission_id`, `module`, `action` (Create/Approve/…/Admin) |
| Role↔Permission | `sec_role_permission` | `role_id`, `permission_id`, `condition_note` |
| Site scope | `sec_user_site` | `user_id`, `site_id`→`md_location`(SITE), `scope_type` {SINGLE, MULTI, ALL}, `is_override`, `override_by`, `override_reason`, `valid_from`, `valid_to` |

---

## 2. Role Catalogue

> Roles map 1:1 to `sec_role.role_code`; approval-capable roles also exist in `md_approval_role`
> and are referenced by `sys_workflow_step.required_role`. A person (`md_employee`) may hold more
> than one role via `sec_user_role`, **subject to the SoD rules in §4**.

| Role (`role_code`) | Core responsibilities | Modules | Typical transactions / actions |
|--------------------|-----------------------|---------|--------------------------------|
| **Store Keeper** (`STORE_KEEPER`) | Physical custody of main-store stock; raise indents, issue material, run cycle counts | Stores, Lubricant, Battery | Create `tx_mrn`, `tx_issue`, `tx_transfer`, `tx_adjustment` (draft), `tx_return`; receive at bin; view `inv_stock_balance` |
| **Site Store Keeper** (`SITE_STORE_KEEPER`) | Same as Store Keeper but **hard-restricted to one site** via `sec_user_site.scope_type=SINGLE` | Stores, Lubricant, Battery | Same verbs as Store Keeper, only for own `site_id`; cannot see other sites' stock or docs |
| **Receiving Clerk** (`RECV_CLERK`) | Goods inward: match PO, book GRN, record QC | Stores, Lubricant, Battery | Create/Edit `tx_grn`, move GRN `RECEIVED→QC_PENDING→QC_PASSED`; attach `doc_` (packing note, serial photo). **Cannot Price.** |
| **Pricing Officer** (`PRICE_OFFICER`) | Enter/confirm purchase price; clear `inv_pending_price`; maintain `md_price` | Stores, Lubricant, Battery, Masters(price only) | **Price** `tx_grn` lines, set `md_price_history`, drive `PRICE: PENDING→PROVISIONAL→CONFIRMED`; trigger MWAC revaluation |
| **Transport Officer** (`TRANSPORT_OFFICER`) | Front-line fleet defect intake; open job cards; issue lubricant/battery to assets | Job Card, Lubricant, Battery | Create `tx_jobcard` (draft/submit), `tx_lube_issue`, `tx_battery_issue`; record `meter_reading`; log `tx_job_progress` |
| **Transport Manager** (`TRANSPORT_MGR`) | First approval of job cards; owns fleet cost; **multi-site** | Job Card, Costing, Stores(view), Reports | **Approve** step 1 (`PENDING_TM_APPROVAL`); return/reject; approve issue overrides; review `cost_job_summary` |
| **Operational Manager** (`OPS_MGR`) | Final approval of job cards & high-value docs; **all-site** oversight | Job Card, Costing, Stores, Reports | **Approve** step 2 (`PENDING_OM_APPROVAL`); approve closure; authorise reversals; sign off variances |
| **Workshop Supervisor** (`WS_SUPERVISOR`) | Assign & schedule jobs; manage bays/technicians; confirm work complete | Job Card, Costing(input) | Move `ASSIGNED_WORKSHOP→IN_PROGRESS→WORK_COMPLETED`; raise `tx_job_material_req` (MRQ), `tx_job_outside_repair` (OSR); assign technicians |
| **Technician** (`TECHNICIAN`) | Perform repair; log labour hours & task progress | Job Card (restricted) | Record `tx_job_labour` (own hours), update `txl_jobcard_task` status, add `tx_job_progress` notes. **No approvals, no material pricing, no closure.** |
| **Finance Reviewer** (`FINANCE_REVIEWER`) | Independent price/cost assurance; post to GL; confirm valuation | Costing, Stores, Lubricant, Battery, Reports | **Price/Post** confirm, review revaluations, approve `tx_adjustment` write-offs, lock closed jobs, run financial reports |
| **System Administrator** (`SYS_ADMIN`) | Platform admin: users, roles, masters, number series, workflow config, migration | Masters, Migration, Security, (all view) | **Admin** on `sec_*`, `sys_*`, `md_*`; manage `sys_number_series`, `sys_workflow`; run migration load/post. **Cannot approve business docs or Price** (SoD). |
| **Management / Executive** (`MGMT_READONLY`) | Read-only dashboards & KPIs across the group | ALL (read) | **Report/View only**: all-site dashboards, cost, stock, consumption, ageing. **Zero write verbs.** |

---

## 3. Permission Matrix (Role × Module × Verb)

**Verb legend:** `C`=Create · `A`=Approve · `E`=Edit · `Rv`=Reverse/Void · `Cl`=Close · `Po`=Post ·
`Pr`=Price · `Rp`=Report/View · `Ad`=Admin.
**Cell legend:** ✔ full · ▲ conditional (see note) · — none.
Modules: **STO**=Stores · **LUB**=Lubricant · **BAT**=Battery · **JC**=Job Card · **CST**=Costing ·
**MST**=Masters · **MIG**=Migration · **SEC**=Security.

### 3.1 Consolidated grid (verb set per module)

| Role \ Module | STO | LUB | BAT | JC | CST | MST | MIG | SEC |
|---------------|-----|-----|-----|-----|-----|-----|-----|-----|
| **Store Keeper** | C E Rp | C E Rp | C E Rp | — | — | Rp | — | — |
| **Site Store Keeper** ▲site | C E Rp | C E Rp | C E Rp | — | — | Rp | — | — |
| **Receiving Clerk** | C E Rp | C E Rp | C E Rp | — | — | Rp | — | — |
| **Pricing Officer** | Pr Rp | Pr Rp | Pr Rp | — | Rp | ▲Pr | — | — |
| **Transport Officer** | Rp | C E Rp | C E Rp | C E Rp | Rp | Rp | — | — |
| **Transport Manager** | Rp | A Rp | A Rp | **A** E Rp | Rp | Rp | — | — |
| **Operational Manager** | ▲A Rp | A Rp | A Rp | **A** Cl Rp | A Rp | Rp | — | — |
| **Workshop Supervisor** | Rp | Rp | Rp | C E Rp | C E Rp | Rp | — | — |
| **Technician** ▲own | — | — | — | ▲E Rp | ▲C | — | — | — |
| **Finance Reviewer** | ▲A Pr Po Rp | Pr Po Rp | Pr Po Rp | Rp | **A Po** Rp | Rp | — | — |
| **System Administrator** | Rp | Rp | Rp | Rp | Rp | **Ad** | **Ad** | **Ad** |
| **Management / Executive** | Rp | Rp | Rp | Rp | Rp | Rp | — | — |

### 3.2 Reverse / Close / Post authority (high-impact verbs)

| Verb | Who holds it | Guard / condition |
|------|--------------|-------------------|
| **Reverse/Void** any posted stock doc (`Rv`) | Operational Manager, Finance Reviewer | Requires `reversal_reason` + creates a reversing `mv_stock_ledger` pair; never a physical delete (contract §1.4) |
| **Close** job card (`Cl`) | Operational Manager (final), auto-gated | Blocked unless job passes closure checklist (§7 below / contract §7 rule 7) |
| **Post** to ledger/GL (`Po`) | Finance Reviewer; system auto-post on approval | Manual post only for corrections; always audited |
| **Price** (`Pr`) | **Pricing Officer, Finance Reviewer only** | No other role — including Admin — may edit price/cost fields (§6) |
| **Admin** (`Ad`) | System Administrator only | Masters/Security/Migration structural changes; **no business approval rights** |

### 3.3 Conditional cell notes

| Ref | Rule |
|-----|------|
| **▲site** (Site Store Keeper) | All verbs constrained to the single `site_id` in `sec_user_site`; every listing/dashboard force-filtered; no ALL/MULTI scope obtainable without SoD-logged override |
| **▲Pr** (Pricing Officer → Masters) | May edit **only** price masters (`md_price`, `md_price_history`); no rights on item/asset/supplier/location masters |
| **▲A** (Ops Mgr → Stores) | Approves only high-value / write-off stock docs (adjustments, returns above threshold in `sys_setting`); routine issues need no OM approval |
| **▲A / ▲Po** (Finance → Stores/Costing) | Approves valuation-affecting docs (revaluation, write-off) and posts costing; does **not** create operational stock docs |
| **▲own** (Technician) | `tx_job_labour` and `txl_jobcard_task`/`tx_job_progress` rows only where `technician_id = self` **and** job is `IN_PROGRESS`/`ASSIGNED_WORKSHOP`; `▲C` on CST = may originate own labour cost lines, never edit rates or material cost |
| **A** (TM & OM → Job Card) | Two mandatory sequential approvals: TM at `PENDING_TM_APPROVAL`, OM at `PENDING_OM_APPROVAL`; neither can substitute for the other |

---

## 4. Segregation of Duties (SoD)

> Enforced two ways: **(a) design-time** — mutually exclusive verbs never granted to the same
> `role_id`; **(b) run-time** — even where one *person* holds two roles, the engine blocks the same
> `user_id` from performing both sides of a controlled pair on the **same document**, comparing
> `created_by` / `approved_by` / pricing user / reversing user on the row.

### 4.1 Forbidden combinations (same user, same document)

| # | Control | Cannot do BOTH | Enforcement point | Rationale |
|---|---------|----------------|-------------------|-----------|
| SoD-1 | **Create ≠ Approve** | Raise a job card / MRN / PO **and** approve it | `apr_step`: reject if `approver_user_id = source.created_by` | Prevents self-authorised spend |
| SoD-2 | **Receive ≠ Price** | Book the GRN **and** price its lines | `tx_grn.received_by ≠ pricing user on line` | Splits goods-in from valuation |
| SoD-3 | **Issue ≠ Adjust** | Issue stock **and** post the adjustment that hides the shortfall | On `tx_adjustment`: block if adjuster = last issuer for that `item_id×location_id` in window | Prevents theft concealment |
| SoD-4 | **Price ≠ Post** (independent review) | Enter price **and** be the sole finance poster confirming it (for high-value) | Finance Reviewer confirms Pricing Officer's price; same user on both requires OM override | Four-eyes on valuation |
| SoD-5 | **Labour ≠ Approve labour cost** | Technician logs own hours **and** approves the job cost | Technician has no `A` verb anywhere | Labour cost integrity |
| SoD-6 | **Admin ≠ Approve/Price** | Configure masters/users **and** approve or price business docs | `SYS_ADMIN` holds only `Ad`/`Rp` verbs | Prevents admin-driven fraud |
| SoD-7 | **TM step ≠ OM step** | Provide both job-card approvals | Distinct `sys_workflow_step` roles; step 2 rejects if actor = step-1 approver | Genuine two-level approval |
| SoD-8 | **Requester ≠ Custodian** | Raise MRQ against a job **and** issue the stock to it | Workshop Supervisor raises MRQ; Store Keeper issues | Segregates demand from custody |

### 4.2 Dual-role conflict handling

```
User assigned Role X (Create) + Role Y (Approve)?
        │
        ├─ Allowed to HOLD both (small sites)          ──► sec_user_role
        │
        └─ On a document where he is created_by:
                 approve action ─► ENGINE CHECK ─► BLOCK (SoD-1)
                                                     │
                                                     └─► routed to alternate approver
                                                         or escalated (apr_action = ESCALATED)
```

`sys_setting` flag `allow_dual_role_small_site` governs whether dual-hold is even permitted; the
run-time same-document block (SoD-1/2/3/7) is **never** waivable by that flag.

---

## 5. Site-Based Visibility Model (Row-Level Security)

### 5.1 Principle

Every approvable/transactional row carries `site_id` (contract §1.3). Read and write are filtered by
the caller's `sec_user_site` scope. The filter is applied server-side on **all** `tx_*`, `txl_*`,
`mv_stock_ledger`, `inv_*`, `cost_*`, `apr_*` queries and on every dashboard — never trusted to the UI.

### 5.2 Scope types

| `scope_type` | Meaning | Query filter applied | Typical roles |
|--------------|---------|----------------------|---------------|
| `SINGLE` | Exactly one site | `WHERE site_id = :user_site` | Site Store Keeper, Technician, Transport Officer (single depot) |
| `MULTI` | Enumerated set | `WHERE site_id IN (SELECT site_id FROM sec_user_site WHERE user_id=:u)` | Transport Manager, Workshop Supervisor (region), Pricing Officer |
| `ALL` | Whole group | no site filter (or `1=1`) | Operational Manager, Finance Reviewer, Management/Executive, System Administrator |

### 5.3 Default scope by role

| Role | Default scope | Notes |
|------|---------------|-------|
| Store Keeper | MULTI (assigned stores) | Usually main + linked bins |
| Site Store Keeper | **SINGLE** | Hard-locked; the defining constraint of the role |
| Receiving Clerk | SINGLE/MULTI | Sites where goods are received |
| Pricing Officer | MULTI/ALL | Pricing is often centralised at HO0 |
| Transport Officer | SINGLE | Home depot |
| Transport Manager | MULTI | Region / cluster |
| Operational Manager | ALL | Group oversight |
| Workshop Supervisor | SINGLE/MULTI | Workshop location(s) |
| Technician | SINGLE | Own workshop |
| Finance Reviewer | ALL | Group valuation |
| System Administrator | ALL (technical) | Data visibility, not approval authority |
| Management / Executive | ALL (read) | Dashboards only |

### 5.4 Visibility examples

```
Site Store Keeper @ KND  ─►  sees only site_id = KND
   inv_stock_balance:   rows WHERE location_id ∈ (KND stores/bins)
   tx_issue / tx_grn:   WHERE site_id = KND
   dashboards:          KND stock, KND lube consumption, KND job load
   OTHER SITES:         invisible — not in list, not searchable, not in totals

Transport Manager (region = CMB+KND) ─► scope MULTI
   job-card queue:      WHERE site_id IN (CMB, KND) AND status = PENDING_TM_APPROVAL
   cost dashboards:     rolled up across CMB+KND only

Operational Manager ─► scope ALL
   sees every site's queue, stock, cost, variance
```

### 5.5 Override (temporary cross-site access)

| Step | Actor | Action | System effect | Audit |
|------|-------|--------|---------------|-------|
| 1 | Requester (e.g. Store Keeper covering another depot) | Request cross-site access | Draft `sec_user_site` row `is_override=1`, `valid_from/valid_to` set | pending record |
| 2 | Operational Manager / System Administrator | Approve override | Row activated with `override_by`, `override_reason` (mandatory) | `apr_action` (APPROVED) + change log |
| 3 | System | Scope expands for the window only | Filter now includes granted `site_id` until `valid_to` | every cross-site read stamped in access log |
| 4 | System (on expiry) | Auto-revoke | Row `is_active=0` at `valid_to` | change log (auto-expire) |

**Rules:** an override is always time-boxed, always carries a reason, is never self-approved
(SoD-1 applies), and every action taken under override is tagged so reports can isolate
"acted outside home site" activity.

---

## 6. Field-Level Controls (Price & Cost)

> Price and cost columns are the highest-value fields in UMMS and are gated **independently** of the
> document-level Create/Edit verb. A Receiving Clerk can Edit a GRN's quantities and QC status but the
> `unit_price` / `line_amt` columns are read-only to him.

### 6.1 Protected fields and who may write them

| Field (examples) | Table | Writable by | Blocked for |
|------------------|-------|-------------|-------------|
| `unit_price`, `line_amt` (GRN line) | `txl_grn` | Pricing Officer, Finance Reviewer | everyone else (incl. Receiving Clerk, Admin) |
| `unit_price`, `price_status`, `effective_date` | `md_price`, `md_price_history` | Pricing Officer (create), Finance Reviewer (confirm) | all others |
| `moving_avg_cost`, revaluation | `inv_stock_balance`, `mv_stock_ledger` | **system only** (computed) — no manual edit | all users; overrides via reval doc |
| `labour_rate` | `md_labour_rate`, `tx_job_labour` | Finance Reviewer / Admin (rate master); system stamps rate onto labour | Technician (enters *hours*, not rate) |
| `material_cost`, `total_job_cost`, `variance_pct` | `cost_job_summary`, `cost_job_line` | **system-derived**; Finance Reviewer may post/confirm | Supervisor/Technician edit inputs, not cost |
| `provisional_cost` clear-down | `inv_pending_price` | Pricing Officer / Finance Reviewer | all others |

### 6.2 Enforcement

- Column-level grants in `sec_role_permission` carry `action = Pr`; the API rejects any write to a
  protected column when the caller lacks `Pr` on that module — even if the row-level Edit succeeds.
- `moving_avg_cost` is **never** user-writable: it is recomputed by the MWAC formula
  (contract §6) on every priced receipt; a price change posts a **revaluation movement**, not an
  in-place edit.
- Every write to a protected field is captured in the field-change log (§7.2) regardless of role.

---

## 7. Audit — Approvals, Reversals & Price/Cost Edits

### 7.1 Approval audit (`apr_action`)

Every approve / reject / return / escalate / delegate writes one immutable `apr_action` row
(contract §3.6, status group `APR`). Nothing about a document's approval history is editable or
deletable.

| Logged element | Source |
|----------------|--------|
| `apr_request_id` / `apr_step_id` | which document & step |
| `action` | APPROVED / REJECTED / RETURNED / ESCALATED / DELEGATED |
| `actor_user_id`, `acted_at` | who + when (server clock) |
| `from_status → to_status` | e.g. `PENDING_TM_APPROVAL → PENDING_OM_APPROVAL` |
| `action_reason` | **mandatory** for REJECT / RETURN / reversal-approval |
| `on_behalf_of` | populated when DELEGATED |

### 7.2 Field-level change log (price / cost / status edits)

A dedicated change-log entry is written for every edit to a **controlled field** (price, cost, rate,
status, quantity on posted docs, site scope). It records before/after values so a full field history
can be reconstructed.

| Column | Purpose |
|--------|---------|
| `table_name`, `record_id` | what row |
| `column_name` | which field (e.g. `unit_price`, `moving_avg_cost`, `jobcard_status`) |
| `old_value`, `new_value` | before → after |
| `changed_by`, `changed_at` | who + when |
| `change_reason` | mandatory for price/cost and reversal edits |
| `source_action` | e.g. PRICE_CONFIRM, REVALUATION, REVERSAL, OVERRIDE_GRANT |

### 7.3 Reversal / void controls

> No physical deletes (contract §1.4). A mistake is corrected by a **reversing document**, never by
> erasing the original.

| Rule | Detail |
|------|--------|
| Reason required | `reversal_reason` mandatory on every void/reverse; blank ⇒ rejected |
| Approver required | Reversal of a posted/approved doc needs an approver ≥ Ops Mgr (or Finance for valuation), and by SoD-1 the approver ≠ the reverser |
| Ledger effect | A reversing `mv_stock_ledger` pair backs out the original; MWAC recomputes; `inv_stock_balance` re-materialises |
| Traceability | Reversing doc stores `reverses_doc_id`; original stamped `is_reversed`, `reversed_by`; both surface in `apr_action` + change log |
| Cost knock-on | If a reversed/re-priced line feeds a job, dependent `cost_job_summary` rows are flagged for recompute (contract §6) |

### 7.4 What the audit answers (traceability paths)

| Question | Path |
|----------|------|
| Who approved job `JC-CMB-26-000502` and when? | `tx_jobcard` → `apr_request` → `apr_action` (TM then OM rows) |
| Why was GRN price changed after posting? | field-change log `table_name=txl_grn, column=unit_price` → `change_reason`, `changed_by` |
| Who granted cross-site access to a Site Store Keeper? | `sec_user_site` (`is_override`, `override_by`, `override_reason`) + `apr_action` |
| Who reversed an issue and on whose authority? | reversing `tx_issue` (`reverses_doc_id`, `reversed_by`) → `apr_action` (approver ≠ reverser) |
| Did anyone create-and-approve the same doc? | SoD-1 guarantees no; the block attempt (if any) is itself logged |

---

## 8. Worked Authorization Walkthroughs

> Format per step: **actor/role · action · system effect · stock-ledger/costing effect · status**.

### 8.1 GRN → Price (Receive ≠ Price, SoD-2)

| # | Actor / role | Action | System effect | Ledger / cost effect | Status |
|---|--------------|--------|---------------|----------------------|--------|
| 1 | Receiving Clerk | Book goods against PO | Create `tx_grn`/`txl_grn`; qty fields writable, price fields **locked** | none yet | `GRN: DRAFT→RECEIVED` |
| 2 | Receiving Clerk | Record QC | Set QC result; attach `doc_` serial photo (battery) | none | `RECEIVED→QC_PENDING→QC_PASSED` |
| 3 | **Pricing Officer** | Enter `unit_price` | Field-level `Pr` grant allows write; field-change log entry | queue `inv_pending_price` cleared for line | `PRICE: PENDING→PROVISIONAL/CONFIRMED`, GRN→`PRICED` |
| 4 | System | Post receipt | Ledger IN row; MWAC recompute | `mv_stock_ledger(IN)`, `inv_stock_balance.moving_avg_cost` updated | `PRICED→POSTED` |
| — | *Blocked* | Same user as step 1 tries step 3 | SoD-2 rejects (received_by = pricing user) | — | — |

### 8.2 Job Card two-level approval (SoD-1, SoD-7)

| # | Actor / role | Action | System effect | Cost effect | Status |
|---|--------------|--------|---------------|-------------|--------|
| 1 | Transport Officer | Raise job card | Create `tx_jobcard` + `txl_jobcard_task`; `created_by=self` | est. cost seeded | `DRAFT→PENDING_TM_APPROVAL` |
| 2 | **Transport Manager** | Approve step 1 | `apr_action(APPROVED)`; SoD-1 checks actor ≠ created_by | — | `→PENDING_OM_APPROVAL` |
| 3 | **Operational Manager** | Approve step 2 | `apr_action(APPROVED)`; SoD-7 checks actor ≠ step-1 approver | — | `→APPROVED→ASSIGNED_WORKSHOP` |
| 4 | Workshop Supervisor | Assign + start | Assign technicians; raise MRQ/OSR as needed | reservations via `inv_reservation` | `→IN_PROGRESS` |
| 5 | Technician | Log labour (own hours only) | Insert `tx_job_labour` where `technician_id=self`; rate stamped by system | labour cost accrues to `cost_job_line` | stays `IN_PROGRESS` |
| 6 | Workshop Supervisor | Confirm complete | — | roll-up | `→WORK_COMPLETED→PENDING_COSTING` |
| 7 | Finance Reviewer | Confirm/post cost | `Po` on Costing; `cost_variance` computed | `cost_job_summary` finalised | `→PENDING_CLOSURE` |
| 8 | **Operational Manager** | Close | Closure checklist gate (no `inv_pending_price`, all labour/parts/OSR in) | — | `→CLOSED` |

### 8.3 Cross-site override

| # | Actor / role | Action | System effect | Status/audit |
|---|--------------|--------|---------------|--------------|
| 1 | Store Keeper (home CMB) | Request access to KND for 3 days | Draft `sec_user_site` `is_override=1`, `valid_to=+3d` | pending |
| 2 | Operational Manager | Approve with reason | Row active; `override_by`, `override_reason` set | `apr_action(APPROVED)` + change log |
| 3 | Store Keeper | Acts on KND stock | Scope filter now includes KND; each read tagged | access log |
| 4 | System | Expire at `valid_to` | `is_active=0`; scope reverts to CMB | change log (auto-expire) |

---

## 9. Role ↔ Approval-Workflow Binding

`sys_workflow_step.required_role` points at `md_approval_role` (⇄ `sec_role`). Only a user holding the
step's role — and passing SoD + site scope — may action that step.

| Workflow (`sys_workflow`) | Step | Required role | Guard |
|---------------------------|------|---------------|-------|
| `JOBCARD_APPROVAL` | 1 | Transport Manager | actor ≠ creator (SoD-1) |
| `JOBCARD_APPROVAL` | 2 | Operational Manager | actor ≠ step-1 (SoD-7) |
| `PRICE_CONFIRM` | price | Pricing Officer | actor ≠ receiver (SoD-2) |
| `PRICE_CONFIRM` | confirm (high-value) | Finance Reviewer | actor ≠ pricer (SoD-4) |
| `ADJUSTMENT_APPROVAL` | approve | Operational Manager / Finance Reviewer | actor ≠ adjuster (SoD-3) |
| `DOC_REVERSAL` | approve | Ops Mgr / Finance Reviewer | actor ≠ reverser (§7.3) |
| `SITE_OVERRIDE` | approve | Ops Mgr / System Administrator | not self (SoD-1) |

---

## 10. New / Extended Names Introduced (contract-conformant)

> Per contract §1, anything not already named is proposed here following the prefix + naming rules,
> for ratification in the database document. No parallel names for existing structures.

| Proposed name | Prefix rule | Purpose |
|---------------|-------------|---------|
| `sec_field_change_log` | `sec_` (security/audit) | Field-level before/after change log (§7.2) — if not folded into a global `sys_audit_log` |
| `sec_access_log` | `sec_` | Login + row-access trail, incl. override-tagged reads (§5.5) |
| `sec_permission.action` values | existing column | Adds `Pr` (Price), `Po` (Post), `Rv` (Reverse), `Cl` (Close) to the verb vocabulary |
| `sec_user_site.scope_type` / `is_override` / `override_reason` | existing table, new columns | Encodes SINGLE/MULTI/ALL scope + audited override (§5) |
| `sys_setting: allow_dual_role_small_site`, `stock_writeoff_approval_threshold` | `sys_` | SoD tuning knobs (§4.2, §3.3 ▲A) |

*All statuses, numbering, masters and valuation remain exactly as defined in the design contract.*
