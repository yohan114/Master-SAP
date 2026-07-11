# UMMS — Database Design (Section 03)

> **Scope:** the physical data backbone for the four consolidated operations —
> (A) Stores/material, (B) Oil/lubricant stock book, (C) Battery serial stock book,
> (D) Workshop job card + job costing — on **one** schema with **shared masters**.
> **Authority:** all names, prefixes, column conventions, numbering, status vocabularies,
> audit fields and the MWAC valuation are defined in
> [`00-design-contract.md`](./00-design-contract.md). This document does **not** restate
> the contract; it materialises it as tables, keys, the append-only ledger, serial history
> and indexes. Runnable DDL: [`../sql/schema.sql`](../sql/schema.sql) (PostgreSQL 14+,
> verified to load clean: 75 tables, 408 FKs, 185 indexes).

---

## 1. ER Overview (family map)

The schema is grouped into ten families. Arrows show the dominant FK direction
(`child ──▶ parent`). Every stock-affecting line, in every module, funnels into the single
`mv_stock_ledger`; every serialized battery movement funnels into `hist_battery_event`.

```
                                 ┌──────────────────────────────────────────────┐
     SECURITY                    │                 SYSTEM / CONFIG               │
  sec_user ◀── sec_user_role     │  sys_status  sys_code  sys_setting            │
     ▲   ▲     sec_role ──▶ sec_role_permission ──▶ sec_permission               │
     │   └── sec_user_site ──▶ md_location        sys_number_series ──▶ md_location
     │                          sys_workflow ──▶ sys_workflow_step               │
     │ (audit created_by/updated_by/approved_by on EVERY table point here)       │
     └───────────────────────────────────────────────────────────────────────────┘
                                          │
        ┌─────────────────────────────────┴───────────── MASTERS (md_) ──────────────────────┐
        │  md_location(SITE▸STORE▸BIN, self-parent)   md_uom ◀ md_uom_conversion              │
        │  md_item_category▸self   md_item_group                                              │
        │  md_item ──▶ {category, group, base_uom, default_supplier}   ← THE unified item     │
        │  md_supplier   md_department▸self  md_cost_center  md_project                       │
        │  md_asset ──▶ md_location        md_asset_vehicle ─1:1─ md_asset ─1:1─ md_asset_machine
        │  md_employee ──▶ {grade, dept, site}   md_employee_grade ◀ md_labour_rate           │
        │  md_warranty_term   md_approval_role ──▶ sec_role                                   │
        │  md_battery ──▶ {md_item, orig_asset, current_asset, current_location, warranty}    │
        │  md_price ──▶ md_price_history   (effective-dated; costing reads AS-OF date)        │
        └───────┬───────────────────────────────────────────────────────┬────────────────────┘
                │                                                         │
   ┌────────────▼───────────── TRANSACTIONS (tx_/txl_) ──────────────────▼───────────────┐
   │  STORES : tx_mrn▸txl_mrn  tx_po▸txl_po  tx_grn▸txl_grn  tx_issue▸txl_issue            │
   │           tx_transfer▸txl_transfer  tx_adjustment▸txl_adjustment  tx_return▸txl_return│
   │  LUBE   : tx_lube_issue▸txl_lube_issue   (asset_id + meter_reading mandatory)          │
   │  BATTERY: tx_battery_issue  tx_battery_transfer  tx_battery_return                     │
   │  WORKSHOP: tx_jobcard▸txl_jobcard_task  tx_job_progress                                │
   │            tx_job_material_req▸txl_job_material_req  tx_job_parts                       │
   │            tx_job_labour  tx_job_outside_repair                                        │
   └───────┬───────────────────────────────┬──────────────────────────┬────────────────────┘
           │ every stock line              │ every serialized move     │ job cost source docs
           ▼                               ▼                           ▼
   ┌───────────────── MOVEMENTS ─────┐ ┌──── HISTORY ────┐   ┌──────── COSTING (cost_) ───────┐
   │  mv_stock_ledger (APPEND-ONLY)  │ │ hist_battery_   │   │ cost_job_summary ─1:1─ tx_jobcard│
   │   one row / stock-affecting line│ │ event           │   │ cost_job_line ──▶ summary        │
   │   two rows for a transfer       │ │ (APPEND-ONLY,   │   │ cost_variance ──▶ summary        │
   └───────┬─────────────────────────┘ │  per-serial seq)│   └──────────────────────────────────┘
           │ derives / keeps in sync    └────────┬────────┘
           ▼                                     │ md_battery.last_event_id ▲
   ┌──────── INVENTORY STATE (inv_) ────────────┐│
   │ inv_stock_balance (item×location, MWAC)    ││
   │ inv_valuation_layer (optional FIFO)        ││
   │ inv_reservation (soft allocation ▸ jobcard)││
   │ inv_pending_price (un-priced GRN queue)    ││
   │ inv_lube_monthly_balance (period snapshot) ││
   └────────────────────────────────────────────┘│
                                                  │
   ┌──────────── APPROVAL / WORKFLOW (apr_) ──────▼──────────┐   ┌──── ATTACHMENTS ────┐
   │ apr_request ──▶ sys_workflow   (bound to any source doc)│   │ doc_attachment      │
   │ apr_step ──▶ apr_request, sys_workflow_step             │   │ (GRN scan, battery  │
   │ apr_action (APPEND-ONLY log of every approve/reject/…)  │   │  serial photo, …)   │
   └─────────────────────────────────────────────────────────┘   └─────────────────────┘

   MIGRATION (stg_/map_) — staging & xref buffers, see §12 (not in core DDL).
```

**Reading the map**
| Family | Prefix | Mutability | Row identity |
|--------|--------|-----------|--------------|
| Masters | `md_` | Mutable (soft-delete `is_active`) | `<root>_id` + business `<root>_no`/code |
| Transactions | `tx_`/`txl_` | Mutable until POSTED, then void/reverse | header `<root>_id` + `<root>_no`; line `<root>_line_id` |
| Movements | `mv_` | **Append-only** | `ledger_id` + `movement_no` |
| History | `hist_` | **Append-only** | `event_id` + `(battery_id, event_seq)` |
| Inventory state | `inv_` | Mutable (derived/materialised) | surrogate + natural unique |
| Costing | `cost_` | Recomputed roll-up | surrogate + `jobcard_id` |
| Approval | `apr_` | Instances mutable; `apr_action` append-only | surrogate |
| System | `sys_` | Config | surrogate + code |
| Security | `sec_` | Config | surrogate + code |
| Attachments | `doc_` | Append-mostly | surrogate |

---

## 2. Table Catalog

> Families: **MD**=master, **SYS**=system, **SEC**=security, **TX**=transaction,
> **MV**=movement, **HIST**=history, **INV**=inventory state, **COST**=costing,
> **APR**=approval, **DOC**=attachment. Audit columns (§4) are on every table and omitted
> from the "Key business fields" column. All 74 core tables are in `sql/schema.sql`.

### 2.1 Security & System

| Table | Family | PK | Important FKs | Key business fields | Notes |
|-------|--------|----|---------------|--------------------|-------|
| `sec_user` | SEC | `user_id` | `employee_id`, `home_site_id`, self `created_by` | `username`⊕, `full_name`, `email`, `is_locked` | Audit FK target for every table; self-ref `created_by` is `DEFERRABLE` to allow bootstrap |
| `sec_role` | SEC | `role_id` | — | `role_code`⊕, `role_name` | |
| `sec_permission` | SEC | `permission_id` | — | `permission_code`⊕, `module`, `action` | module ∈ STORES/LUBE/BATTERY/WORKSHOP/ADMIN |
| `sec_user_role` | SEC | `user_role_id` | `user_id`, `role_id` | unique(`user_id`,`role_id`) | |
| `sec_role_permission` | SEC | `role_permission_id` | `role_id`, `permission_id` | unique pair | |
| `sec_user_site` | SEC | `user_site_id` | `user_id`, `site_id`→`md_location` | `access_level` READ/WRITE/APPROVE | Row-level site visibility |
| `sys_status` | SYS | `status_id` | — | `status_group`,`status_code`,`is_terminal` | Label master for all vocabularies; unique(`group`,`code`) |
| `sys_code` | SYS | `code_id` | — | `code_group`,`code_value`,`code_label` | Generic pick-lists |
| `sys_setting` | SYS | `setting_id` | `site_id` | `setting_key`⊕site, `setting_value` | Global or per-site config |
| `sys_number_series` | SYS | `series_id` | `site_id`→`md_location` | `doc_type`,`year_yy`,`current_no`,`padding_width` | Yearly reset per site per type; unique(`doc_type`,`site_id`,`year_yy`) |
| `sys_workflow` | SYS | `workflow_id` | — | `workflow_code`⊕, `doc_type` | e.g. JOBCARD_APPROVAL |
| `sys_workflow_step` | SYS | `step_id` | `workflow_id`, `approval_role_id`, `required_role_id` | `step_no`, `min/max_amount`, `is_final` | Ordered; unique(`workflow_id`,`step_no`) |

### 2.2 Masters (shared by ALL four modules)

| Table | Family | PK | Important FKs | Key business fields | Notes |
|-------|--------|----|---------------|--------------------|-------|
| `md_location` | MD | `location_id` | self `parent_location_id` | `location_code`⊕,`location_type` SITE/STORE/BIN,`site_code` | 3-letter `site_code` feeds numbering |
| `md_uom` | MD | `uom_id` | — | `uom_code`⊕,`uom_type`,`decimals`,`is_base` | |
| `md_uom_conversion` | MD | `conversion_id` | `item_id`,`from_uom_id`,`to_uom_id` | `factor` | item-specific or global; unique triple |
| `md_item_category` | MD | `category_id` | self `parent_category_id` | `category_code`⊕ | Hierarchy |
| `md_item_group` | MD | `group_id` | — | `group_code`⊕ | Fast-moving analysis |
| **`md_item`** | MD | `item_id` | `category_id`,`group_id`,`base_uom_id`,`default_supplier_id` | `item_no`⊕,`item_type`,`is_serial_tracked`,`is_batch_tracked`,`valuation_method` | **Unified item** for store/lube/battery/spare/general |
| `md_supplier` | MD | `supplier_id` | — | `supplier_no`⊕,`supplier_type`,`currency_code` | LOCAL/HEAD_OFFICE/SUBCONTRACTOR |
| `md_department` | MD | `department_id` | self | `department_code`⊕ | Cost dimension |
| `md_cost_center` | MD | `cost_center_id` | — | `cost_center_code`⊕ | Finance dimension |
| `md_project` | MD | `project_id` | — | `project_code`⊕ | Optional cost dimension |
| **`md_asset`** | MD | `asset_id` | `site_id`,`department_id`,`cost_center_id` | `asset_no`⊕,`asset_class` VEHICLE/MACHINE/EQUIPMENT | **Unified asset** — lube & battery issue target |
| `md_asset_vehicle` | MD | `asset_id`=FK`md_asset` | 1:1 `md_asset` | `reg_no`⊕,`chassis_no`,`meter_type` KM/HR,`current_meter` | Vehicle extension |
| `md_asset_machine` | MD | `asset_id`=FK`md_asset` | 1:1 `md_asset` | `plant_no`,`capacity`,`hour_meter` | Plant extension |
| `md_employee_grade` | MD | `grade_id` | — | `grade_code`⊕ | Drives labour rate |
| `md_employee` | MD | `employee_id` | `grade_id`,`department_id`,`site_id` | `employee_no`⊕,`is_technician`,`designation` | Technician list = costing labour source |
| `md_labour_rate` | MD | `labour_rate_id` | `grade_id` | `effective_date`,`hourly_rate`,`ot_multiplier` | Effective-dated; unique(`grade_id`,`effective_date`) |
| `md_warranty_term` | MD | `warranty_term_id` | — | `term_code`⊕,`duration_months`,`meter_limit` | Battery/asset warranty |
| `md_approval_role` | MD | `approval_role_id` | `sec_role_id` | `role_code`⊕ | Maps approval role → security role |
| **`md_battery`** | MD | `battery_id` | `item_id`,`original_asset_id`,`current_asset_id`,`current_location_id`,`warranty_term_id`,`purchase_grn_id`,`last_event_id` | `battery_serial_no`⊕,`battery_status`,`acquisition_cost`,`warranty_end_date` | **Serial register** — one row per physical battery |
| `md_price` | MD | `price_id` | `item_id`,`supplier_id`,`site_id`,`uom_id`,`price_history_id` | `unit_price`,`effective_date`,`price_status` | Current active price; unique(`item`,`supplier`,`site`) |
| `md_price_history` | MD | `price_history_id` | `item_id`,`supplier_id`,`site_id`,`uom_id` | `unit_price`,`effective_date`,`end_date`,`price_status` | **Immutable** effective-dated history — costing reads AS-OF date |

### 2.3 Movements, Inventory State & Costing

| Table | Family | PK | Important FKs | Key business fields | Notes |
|-------|--------|----|---------------|--------------------|-------|
| **`mv_stock_ledger`** | MV | `ledger_id` | `item_id`,`location_id`,`battery_id`,`valuation_layer_id`,self `reval_of_ledger_id` | `movement_no`⊕,`mv_direction`,`qty`,`unit_cost`,`value_amt`,`running_balance_qty`,`running_avg_cost`,`source_doc_type/_id/_line_id`,`is_provisional` | **Append-only spine**; one row per stock-affecting line |
| `inv_stock_balance` | INV | `balance_id` | `item_id`,`location_id`,`last_movement_id` | `on_hand_qty`,`reserved_qty`,`available_qty`(gen),`moving_avg_cost`,`stock_value` | Materialised from ledger; unique(`item`,`location`) |
| `inv_valuation_layer` | INV | `layer_id` | `item_id`,`location_id`,`receipt_ledger_id` | `orig_qty`,`remaining_qty`,`unit_cost`,`is_open` | Optional FIFO layers |
| `inv_reservation` | INV | `reservation_id` | `item_id`,`location_id`,`jobcard_id` | `reserved_qty`,`reservation_status`,`source_doc_type/_id` | Soft allocation to job/issue |
| `inv_pending_price` | INV | `pending_id` | `grn_id`,`grn_line_id`,`item_id`,`confirmed_price_history_id`,`reval_ledger_id` | `received_qty`,`provisional_unit_cost`,`confirmed_unit_cost`,`price_status`,`variance_amt` | Un-priced receipt queue; job-close gate |
| `inv_lube_monthly_balance` | INV | `lube_bal_id` | `item_id`,`location_id` | `period_yyyymm`,`opening/receipt/issue/closing_qty`,`avg_cost` | Month-end lube snapshot; unique triple |
| `cost_job_summary` | COST | `summary_id` | `jobcard_id` | `material/labour/outside_repair/general/overhead_cost`,`total_job_cost`,`variance_amt/_pct`,`is_provisional`,`cost_status` | 1:1 with job card |
| `cost_job_line` | COST | `cost_line_id` | `jobcard_id`,`summary_id`,`item_id`,`employee_id`,`task_id` | `cost_element`,`qty`,`unit_cost`,`line_cost`,`is_provisional` | Detail per cost element |
| `cost_variance` | COST | `variance_id` | `jobcard_id`,`summary_id` | `cost_element`,`estimated_amt`,`actual_amt`,`variance_amt/_pct`,`is_flagged_recompute` | Estimate vs actual |

### 2.4 Stores / Lube / Battery / Workshop Transactions

| Table | Family | PK | Important FKs | Key business fields | Numbering |
|-------|--------|----|---------------|--------------------|-----------|
| `tx_mrn` / `txl_mrn` | TX | `mrn_id` / `mrn_line_id` | `location_id`,`asset_id`,`jobcard_id` / `mrn_id`,`item_id` | `mrn_no`⊕,`required_date`,`priority` / `requested/approved/issued/po_qty` | `MRN` |
| `tx_po` / `txl_po` | TX | `po_id` / `po_line_id` | `supplier_id`,`location_id`,`mrn_id` / `po_id`,`item_id`,`mrn_line_id` | `po_no`⊕,`po_type` / `order/received_qty`,`unit_price` | `PO` |
| `tx_grn` / `txl_grn` | TX | `grn_id` / `grn_line_id` | `po_id`,`supplier_id`,`location_id` / `grn_id`,`item_id`,`po_line_id`,`ledger_id` | `grn_no`⊕,`grn_status` / `received/accepted/rejected_qty`,`unit_price`,`is_priced`,`batch_no`,`serial_count` | `GRN` |
| `tx_issue` / `txl_issue` | TX | `issue_id` / `issue_line_id` | `location_id`,`asset_id`,`jobcard_id`,`mrn_id` / `issue_id`,`item_id`,`reservation_id`,`ledger_id` | `issue_no`⊕,`issue_type`,`override_by/reason` / `issued_qty`,`unit_cost` | `ISS` |
| `tx_transfer` / `txl_transfer` | TX | `transfer_id` / `transfer_line_id` | `from/to_location_id`,`from/to_site_id` / `transfer_id`,`item_id`,`out_ledger_id`,`in_ledger_id` | `transfer_no`⊕,`in_transit` / `transfer/received_qty` | `TRF` |
| `tx_adjustment` / `txl_adjustment` | TX | `adjustment_id` / `adjustment_line_id` | `location_id` / `adjustment_id`,`item_id`,`ledger_id` | `adjustment_no`⊕,`adjustment_type` / `system/counted/adjust_qty`,`mv_direction` | `ADJ` |
| `tx_return` / `txl_return` | TX | `return_id` / `return_line_id` | `supplier_id`,`location_id`,`grn_id` / `return_id`,`item_id`,`grn_line_id`,`ledger_id` | `return_no`⊕,`return_type` SUPPLIER\|STORE_BACK / `return_qty`,`mv_direction` RET_OUT\|RET_IN | `RET` |
| `tx_lube_issue` / `txl_lube_issue` | TX | `lube_issue_id` / `lube_line_id` | `location_id`,`asset_id`,`department_id`,`jobcard_id` / `lube_issue_id`,`item_id`,`ledger_id` | `lube_issue_no`⊕,`meter_reading`,`meter_type` / `issue_qty`,`prev_meter`,`consumption_since_last` | `LUB` |
| `tx_battery_issue` | TX | `battery_issue_id` | `battery_id`,`item_id`,`from_location_id`,`to_asset_id`,`jobcard_id`,`ledger_id`,`hist_event_id` | `battery_issue_no`⊕,`meter_reading`,`warranty_start_date`,`battery_status_after` | `BAT` |
| `tx_battery_transfer` | TX | `battery_transfer_id` | `battery_id`,`from_asset_id`,`to_asset_id`,`hist_event_id` | `battery_transfer_no`⊕,`from/to_meter`,`reason` | `BTR` |
| `tx_battery_return` | TX | `battery_return_id` | `battery_id`,`from_asset_id`,`to_location_id`,`replacement_battery_id`,`warranty_term_id`,`ledger_id`,`hist_event_id` | `battery_return_no`⊕,`return_type`,`warranty_claim_no`,`battery_status_after` | `BRT` |
| `hist_battery_event` | HIST | `event_id` | `battery_id`,`from/to_asset_id`,`from/to_location_id`,`replacement_battery_id` | `event_seq`,`event_type`,`from/to_status`,`source_doc_type/_id/_no` | append-only; unique(`battery_id`,`event_seq`) |
| `tx_jobcard` | TX | `jobcard_id` | `asset_id`,`location_id`,`project_id`,`department_id`,`cost_center_id` | `jobcard_no`⊕,`job_type`,`jobcard_status`,`promised_date`,`reported_defect`,`meter_reading`,`hold_reason`,`tm/om_approved_*` | `JC` |
| `txl_jobcard_task` | TX | `task_id` | `jobcard_id`,`assigned_to_employee_id` | `task_description`,`task_status`,`estimated/actual_hours` | unique(`jobcard_id`,`line_no`) |
| `tx_job_progress` | TX | `progress_id` | `jobcard_id`,`task_id` | `progress_date`,`work_done`,`pct_complete`,`hours_spent` | Daily log |
| `tx_job_material_req` / `txl_*` | TX | `mrq_id` / `mrq_line_id` | `jobcard_id`,`location_id` / `mrq_id`,`item_id`,`task_id`,`reservation_id` | `mrq_no`⊕,`req_type` / `requested/approved/issued_qty` | `MRQ` |
| `tx_job_parts` | TX | `job_part_id` | `jobcard_id`,`task_id`,`item_id`,`issue_line_id`,`mrq_id`,`ledger_id` | `qty`,`unit_cost`,`part_cost`,`source_type`,`is_returned`,`is_general`,`is_provisional` | Links GRN/issue → job |
| `tx_job_labour` | TX | `labour_id` | `jobcard_id`,`task_id`,`employee_id`,`grade_id`,`labour_rate_id` | `labour_no`⊕,`hours`,`ot_hours`,`hourly_rate`,`labour_cost` | `LAB` |
| `tx_job_outside_repair` | TX | `osr_id` | `jobcard_id`,`task_id`,`subcontractor_id`,`po_id`,`grn_id` | `osr_no`⊕,`sent/return_date`,`estimated/actual_cost`,`osr_status` | `OSR` |

### 2.5 Approval & Attachments

| Table | Family | PK | Important FKs | Key business fields | Notes |
|-------|--------|----|---------------|--------------------|-------|
| `apr_request` | APR | `request_id` | `workflow_id`,`requested_by`,`site_id` | `source_doc_type/_id/_no`,`current_step_no`,`apr_status`,`amount` | One instance per approvable document |
| `apr_step` | APR | `apr_step_id` | `request_id`,`workflow_step_id`,`assigned_role_id`,`assigned_user_id` | `step_no`,`step_status`,`acted_by`,`due_at` | unique(`request_id`,`step_no`) |
| `apr_action` | APR | `action_id` | `request_id`,`apr_step_id`,`action_by`,`delegated_to` | `action_type`,`from/to_status`,`comments` | **Append-only** audit of every decision |
| `doc_attachment` | DOC | `attachment_id` | `site_id` | `source_doc_type/_id`,`doc_category`,`file_name`,`file_url`,`mime_type`,`file_size`,`checksum_sha256`,`link_role`,`is_primary` | **SINGLE polymorphic attachment table** (GRN scan, battery serial photo, invoice, warranty) — `doc_category` GRN_SCAN\|BATTERY_SERIAL_PHOTO\|INVOICE\|WARRANTY\|OTHER; `link_role` PRIMARY\|SUPPORTING\|PROOF\|SIGNATURE |

> ⊕ = column carries a `UNIQUE` constraint. **Migration** family (`stg_*`, `map_*`) is
> documented in §12 and lives outside the core `schema.sql`.

---

## 3. Detailed Field Lists (key tables)

> Types shown as PostgreSQL. `Key` column: **PK**, **FK→table**, **U**=unique,
> **CK**=check-constrained, **GEN**=generated. The standard audit block (§4) —
> `created_by, created_at, updated_by, updated_at, row_version, is_active` — plus, on
> approvable docs, `approved_by, approved_at, site_id` — applies to every table and is
> listed once here, not repeated per table.

### 3.1 `md_item` — the unified item master

| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `item_id` | BIGINT IDENTITY | N | PK | |
| `item_no` | VARCHAR(30) | N | U | Item code, human key |
| `item_name` | VARCHAR(150) | N | | |
| `item_type` | VARCHAR(12) | N | CK | STORE\|LUBRICANT\|BATTERY\|SPARE\|GENERAL\|CONSUMABLE |
| `category_id` | BIGINT | Y | FK→md_item_category | |
| `group_id` | BIGINT | Y | FK→md_item_group | Analytical grouping |
| `base_uom_id` | BIGINT | N | FK→md_uom | Stock-keeping UoM |
| `is_stockable` | BOOLEAN | N | | Default TRUE |
| `is_serial_tracked` | BOOLEAN | N | | TRUE for BATTERY models → forces `md_battery` rows |
| `is_batch_tracked` | BOOLEAN | N | | TRUE for lubricants with batch/expiry |
| `valuation_method` | VARCHAR(6) | N | CK | MWAC (default) \| FIFO |
| `reorder_level` / `reorder_qty` | NUMERIC(18,4) | N | | Replenishment triggers |
| `min_qty` / `max_qty` | NUMERIC(18,4) | Y | | |
| `shelf_life_days` | INTEGER | Y | | Lubricant/battery expiry driver |
| `default_supplier_id` | BIGINT | Y | FK→md_supplier | |
| `barcode` / `tax_code` | VARCHAR | Y | | |
| `specification` | VARCHAR(400) | Y | | Free spec text |

### 3.2 `md_asset` (+ subtype extensions)

**`md_asset`**
| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `asset_id` | BIGINT IDENTITY | N | PK | |
| `asset_no` | VARCHAR(30) | N | U | |
| `asset_name` | VARCHAR(150) | N | | |
| `asset_class` | VARCHAR(12) | N | CK | VEHICLE\|MACHINE\|EQUIPMENT |
| `site_id` | BIGINT | N | FK→md_location | Home site (RLS) |
| `department_id` | BIGINT | Y | FK→md_department | |
| `cost_center_id` | BIGINT | Y | FK→md_cost_center | |
| `asset_status` | VARCHAR(12) | N | | ACTIVE\|IDLE\|DISPOSED |
| `acquisition_date` | DATE | Y | | |

**`md_asset_vehicle`** (1:1, `asset_id` is PK **and** FK→`md_asset`)
| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `asset_id` | BIGINT | N | PK, FK→md_asset | |
| `reg_no` | VARCHAR(20) | N | U | Registration plate |
| `chassis_no` / `engine_no` | VARCHAR(40) | Y | | |
| `make` / `model` | VARCHAR(60) | Y | | |
| `model_year` | SMALLINT | Y | | |
| `fuel_type` | VARCHAR(15) | Y | | |
| `meter_type` | VARCHAR(4) | N | CK | KM\|HR |
| `current_meter` | NUMERIC(18,2) | N | | Latest odometer/hour reading |
| `tyre_size` | VARCHAR(30) | Y | | |

**`md_asset_machine`** (1:1, `asset_id` PK+FK): `plant_no`, `make`, `model`,
`capacity` NUMERIC(18,2), `capacity_uom`, `meter_type` CK KM/HR, `hour_meter` NUMERIC(18,2).

### 3.3 `md_battery` — serial register (current-state master)

| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `battery_id` | BIGINT IDENTITY | N | PK | |
| `battery_serial_no` | VARCHAR(50) | N | U | Physical serial (etched/label) |
| `item_id` | BIGINT | N | FK→md_item | The battery **model** (item_type=BATTERY) |
| `manufacturer` | VARCHAR(80) | Y | | |
| `capacity_ah` / `voltage` | NUMERIC | Y | | 12V / Ah rating |
| `manufacture_date` | DATE | Y | | |
| `purchase_grn_id` | BIGINT | Y | FK→tx_grn | Receiving GRN (deferred FK) |
| `purchase_date` | DATE | Y | | |
| `acquisition_cost` | NUMERIC(18,2) | N | | **Serial-level valuation** (contract §6) |
| `warranty_term_id` | BIGINT | Y | FK→md_warranty_term | |
| `warranty_start_date` / `warranty_end_date` | DATE | Y | | Claim eligibility window |
| `original_asset_id` | BIGINT | Y | FK→md_asset | **First** asset installed on (never changes) |
| `current_asset_id` | BIGINT | Y | FK→md_asset | **Current** asset (NULL when in stock/scrapped) |
| `current_location_id` | BIGINT | Y | FK→md_location | Store/bin when in stock |
| `battery_status` | VARCHAR(22) | N | CK | IN_STOCK…SCRAPPED/REPLACED/LOST (contract §5 BATTERY) |
| `install_meter` | NUMERIC(18,2) | Y | | Asset meter at install |
| `last_event_id` | BIGINT | Y | FK→hist_battery_event | Pointer to newest lifecycle row (deferred FK) |
| `site_id` | BIGINT | N | FK→md_location | Current owning site |

### 3.4 `md_supplier`

| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `supplier_id` | BIGINT IDENTITY | N | PK | |
| `supplier_no` | VARCHAR(30) | N | U | |
| `supplier_name` | VARCHAR(150) | N | | |
| `supplier_type` | VARCHAR(15) | N | CK | LOCAL\|HEAD_OFFICE\|SUBCONTRACTOR |
| `tax_id` | VARCHAR(30) | Y | | |
| `contact_person`/`phone`/`email`/`address`/`city` | VARCHAR | Y | | |
| `payment_terms` | VARCHAR(60) | Y | | |
| `currency_code` | CHAR(3) | N | | Default LKR |
| `is_subcontractor` | BOOLEAN | N | | Convenience flag for OSR selection |

### 3.5 `md_location`

| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `location_id` | BIGINT IDENTITY | N | PK | |
| `location_code` | VARCHAR(20) | N | U | |
| `location_name` | VARCHAR(120) | N | | |
| `location_type` | VARCHAR(10) | N | CK | SITE\|STORE\|BIN |
| `site_code` | CHAR(3) | Y | | 3-letter code (SITE rows) used in `TYPE-SITE-YY-NNNNNN` |
| `parent_location_id` | BIGINT | Y | FK→md_location(self) | STORE▸SITE, BIN▸STORE |
| `address` | VARCHAR(300) | Y | | |

### 3.6 `md_employee`

| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `employee_id` | BIGINT IDENTITY | N | PK | |
| `employee_no` | VARCHAR(30) | N | U | |
| `employee_name` | VARCHAR(150) | N | | |
| `is_technician` | BOOLEAN | N | | TRUE = eligible for `tx_job_labour` |
| `grade_id` | BIGINT | Y | FK→md_employee_grade | Drives labour rate lookup |
| `department_id` | BIGINT | Y | FK→md_department | |
| `site_id` | BIGINT | N | FK→md_location | Home site |
| `designation` / `phone` | VARCHAR | Y | | |
| `hire_date` | DATE | Y | | |

### 3.7 `md_price` and `md_price_history`

**`md_price`** (current active — one row per item×supplier×site)
| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `price_id` | BIGINT IDENTITY | N | PK | |
| `item_id` | BIGINT | N | FK→md_item, U(comp) | |
| `supplier_id` | BIGINT | Y | FK→md_supplier, U(comp) | NULL = any supplier |
| `site_id` | BIGINT | Y | FK→md_location, U(comp) | NULL = all sites |
| `uom_id` | BIGINT | N | FK→md_uom | |
| `unit_price` | NUMERIC(18,4) | N | | |
| `currency_code` | CHAR(3) | N | | LKR |
| `effective_date` | DATE | N | | |
| `price_status` | VARCHAR(12) | N | CK | PENDING\|PROVISIONAL\|CONFIRMED\|REVISED |
| `price_history_id` | BIGINT | Y | FK→md_price_history | Source of current value |

**`md_price_history`** (immutable, effective-dated — costing reads AS-OF the txn date)
| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `price_history_id` | BIGINT IDENTITY | N | PK | |
| `item_id` | BIGINT | N | FK→md_item | Indexed `(item_id, effective_date DESC)` |
| `supplier_id` | BIGINT | Y | FK→md_supplier | |
| `site_id` | BIGINT | Y | FK→md_location | |
| `uom_id` | BIGINT | N | FK→md_uom | |
| `unit_price` | NUMERIC(18,4) | N | | |
| `currency_code` | CHAR(3) | N | | |
| `effective_date` | DATE | N | | Start of validity |
| `end_date` | DATE | Y | | NULL = open-ended |
| `price_status` | VARCHAR(12) | N | CK | PENDING\|PROVISIONAL\|CONFIRMED\|REVISED |
| `source_doc_type`/`source_doc_id` | VARCHAR/BIGINT | Y | | GRN\|PO\|MANUAL\|IMPORT provenance |
| `change_reason` | VARCHAR(200) | Y | | |
| *(only `created_by`/`created_at` — no update columns; append-only)* | | | | |

### 3.8 `sys_number_series`

| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `series_id` | BIGINT IDENTITY | N | PK | |
| `doc_type` | VARCHAR(5) | N | U(comp) | MRN\|PO\|GRN\|ISS\|TRF\|ADJ\|RET\|LUB\|BAT\|BTR\|BRT\|JC\|MRQ\|LAB\|OSR |
| `site_id` | BIGINT | N | FK→md_location, U(comp) | Per-site sequence |
| `year_yy` | SMALLINT | N | U(comp) | Yearly reset |
| `current_no` | BIGINT | N | | Last issued value; bump under `SELECT … FOR UPDATE` |
| `padding_width` | SMALLINT | N | | Default 6 → `000123` |
| `prefix` | VARCHAR(10) | Y | | Optional override |
| `format_mask` | VARCHAR(40) | N | | Default `{TYPE}-{SITE}-{YY}-{NNNNNN}` |

**Allocation:** `UPDATE sys_number_series SET current_no = current_no + 1 … RETURNING current_no`
inside the document's own transaction; render via `format_mask` using the SITE row's `site_code`.

### 3.9 `mv_stock_ledger` — append-only movement spine

| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `ledger_id` | BIGINT IDENTITY | N | PK | Global monotonic post order |
| `movement_no` | VARCHAR(30) | N | U | e.g. `MOV-CMB-26-000001` |
| `movement_date` | DATE | N | | Posting/effective date |
| `item_id` | BIGINT | N | FK→md_item | |
| `location_id` | BIGINT | N | FK→md_location | Store/bin the balance is kept at |
| `mv_direction` | VARCHAR(10) | N | CK | IN\|OUT\|XFER_IN\|XFER_OUT\|ADJ_IN\|ADJ_OUT\|RET_IN\|RET_OUT |
| `qty` | NUMERIC(18,4) | N | CK ≥0 | **Magnitude** (sign carried by direction) |
| `unit_cost` | NUMERIC(18,4) | N | | IN = receipt cost; OUT = MWAC at issue |
| `value_amt` | NUMERIC(18,2) | N | | **Signed** value delta (+in / −out) |
| `running_balance_qty` | NUMERIC(18,4) | N | | On-hand **after** this row (item×location) |
| `running_balance_value` | NUMERIC(18,2) | N | | Inventory value after |
| `running_avg_cost` | NUMERIC(18,4) | N | | MWAC after |
| `source_doc_type` | VARCHAR(10) | N | | GRN\|ISS\|TRF\|ADJ\|RET\|LUB\|BAT\|BRT\|JOB\|REVAL |
| `source_doc_id` | BIGINT | N | | Header id of originating document |
| `source_line_id` | BIGINT | Y | | Line id (for full drill-back) |
| `batch_no` | VARCHAR(40) | Y | | Batch-tracked items |
| `serial_no` | VARCHAR(50) | Y | | Battery serial |
| `battery_id` | BIGINT | Y | FK→md_battery | Serialized issue/return |
| `valuation_layer_id` | BIGINT | Y | FK→inv_valuation_layer | FIFO consumption link |
| `is_provisional` | BOOLEAN | N | | Posted at provisional cost (pending price) |
| `reval_of_ledger_id` | BIGINT | Y | FK→mv_stock_ledger(self) | Revaluation back-reference |
| `posted_by` / `posted_at` | BIGINT / TIMESTAMPTZ | N | | Poster + post time |
| `site_id` | BIGINT | N | FK→md_location | |
| *(append-only: `created_by`/`created_at` only; never UPDATE/DELETE — reverse with a new row)* | | | | |

### 3.10 `inv_stock_balance` — materialised on-hand + MWAC

| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `balance_id` | BIGINT IDENTITY | N | PK | |
| `item_id` | BIGINT | N | FK→md_item, U(comp) | |
| `location_id` | BIGINT | N | FK→md_location, U(comp) | |
| `on_hand_qty` | NUMERIC(18,4) | N | | = last ledger `running_balance_qty` |
| `reserved_qty` | NUMERIC(18,4) | N | | Σ active `inv_reservation` |
| `available_qty` | NUMERIC(18,4) | N | GEN | `on_hand_qty - reserved_qty` (STORED) |
| `moving_avg_cost` | NUMERIC(18,4) | N | | Current MWAC |
| `stock_value` | NUMERIC(18,2) | N | | `on_hand_qty × moving_avg_cost` |
| `last_movement_id` | BIGINT | Y | FK→mv_stock_ledger | Sync anchor |
| `last_movement_at` | TIMESTAMPTZ | Y | | |
| `last_receipt_date` / `last_issue_date` | DATE | Y | | Ageing/last-activity |

### 3.11 `inv_pending_price` — un-priced receipt queue

| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `pending_id` | BIGINT IDENTITY | N | PK | |
| `grn_id` | BIGINT | N | FK→tx_grn | |
| `grn_line_id` | BIGINT | N | FK→txl_grn | The specific un-priced line |
| `item_id` / `location_id` | BIGINT | N | FK | |
| `received_qty` | NUMERIC(18,4) | N | | |
| `provisional_unit_cost` | NUMERIC(18,4) | N | | Last/PO/manual estimate used for stock-in |
| `provisional_source` | VARCHAR(10) | N | | LAST\|PO\|MANUAL |
| `price_status` | VARCHAR(12) | N | CK | PENDING\|PROVISIONAL\|CONFIRMED |
| `confirmed_unit_cost` | NUMERIC(18,4) | Y | | Final price on confirmation |
| `confirmed_price_history_id` | BIGINT | Y | FK→md_price_history | |
| `reval_ledger_id` | BIGINT | Y | FK→mv_stock_ledger | The `REVAL` movement posted on confirm |
| `variance_amt` | NUMERIC(18,2) | Y | | (confirmed − provisional) × qty |
| `resolved_by` / `resolved_at` | BIGINT / TIMESTAMPTZ | Y | | |

### 3.12 `inv_reservation` — soft allocation

| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `reservation_id` | BIGINT IDENTITY | N | PK | |
| `item_id` / `location_id` | BIGINT | N | FK | |
| `reserved_qty` | NUMERIC(18,4) | N | CK >0 | Nets `available_qty` without moving stock |
| `source_doc_type` / `source_doc_id` | VARCHAR/BIGINT | N | | JC\|MRQ\|ISS |
| `source_line_id` | BIGINT | Y | | |
| `jobcard_id` | BIGINT | Y | FK→tx_jobcard | Convenience join for workshop |
| `reservation_status` | VARCHAR(12) | N | CK | ACTIVE\|RELEASED\|CONSUMED\|EXPIRED |
| `expiry_at` | TIMESTAMPTZ | Y | | Auto-release deadline |

### 3.13 GRN header/line — `tx_grn` / `txl_grn`

**`tx_grn`**
| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `grn_id` | BIGINT IDENTITY | N | PK | |
| `grn_no` | VARCHAR(30) | N | U | `GRN-CMB-26-000210` |
| `grn_date` | DATE | N | | |
| `po_id` | BIGINT | Y | FK→tx_po | NULL for direct receipt |
| `supplier_id` | BIGINT | N | FK→md_supplier | |
| `location_id` | BIGINT | N | FK→md_location | Receiving store |
| `supplier_dn_no` / `supplier_invoice_no` | VARCHAR(40) | Y | | |
| `grn_status` | VARCHAR(12) | N | CK | DRAFT→RECEIVED→QC_PENDING→QC_PASSED→PRICED→POSTED (+QC_FAILED,PARTIAL) |
| `total_qty` / `total_amt` | NUMERIC | N | | |
| `received_by` | BIGINT | Y | FK→md_employee | |

**`txl_grn`**
| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `grn_line_id` | BIGINT IDENTITY | N | PK | |
| `grn_id` | BIGINT | N | FK→tx_grn, U(comp) | |
| `line_no` | SMALLINT | N | U(comp) | |
| `item_id` / `uom_id` | BIGINT | N | FK | |
| `location_id` | BIGINT | Y | FK→md_location | Put-away bin |
| `ordered_qty`/`received_qty`/`accepted_qty`/`rejected_qty` | NUMERIC(18,4) | | | QC split |
| `unit_price` | NUMERIC(18,4) | Y | | **NULL while price pending** |
| `line_amt` | NUMERIC(18,2) | N | | |
| `is_priced` | BOOLEAN | N | | FALSE → row in `inv_pending_price` |
| `price_status` | VARCHAR(12) | N | | PENDING\|PROVISIONAL\|CONFIRMED |
| `batch_no`/`mfg_date`/`expiry_date` | | Y | | Batch-tracked receipts |
| `serial_count` | INTEGER | N | | Battery serials captured on this line |
| `po_line_id` | BIGINT | Y | FK→txl_po | |
| `ledger_id` | BIGINT | Y | FK→mv_stock_ledger | The IN movement posted |

### 3.14 Issue — `tx_issue` / `txl_issue`

**`tx_issue`**: `issue_id` PK · `issue_no` U · `issue_date` · `location_id` FK (from store) ·
`issue_type` CK STORE/GENERAL/JOB · `department_id`/`cost_center_id`/`asset_id` FK ·
`jobcard_id` FK→tx_jobcard · `mrn_id` FK · `issued_to_employee_id` FK ·
`override_by` FK→sec_user + `override_reason` (contract rule 2 negative-stock override) · `total_amt`.
**`txl_issue`**: `issue_line_id` PK · `issue_id` FK+U(comp) · `line_no` U(comp) · `item_id`/`uom_id` FK ·
`requested_qty` · `issued_qty` · `unit_cost` (MWAC at issue) · `line_amt` · `batch_no` ·
`reservation_id` FK→inv_reservation · `ledger_id` FK→mv_stock_ledger.

### 3.15 Transfer — `tx_transfer` / `txl_transfer`

**`tx_transfer`**: `transfer_id` PK · `transfer_no` U · `from_location_id`/`to_location_id` FK
(CK they differ) · `from_site_id`/`to_site_id` FK · `in_transit` · `received_date` · `total_amt`.
**`txl_transfer`**: line PK · `transfer_id` FK+U(comp) · `line_no` · `item_id`/`uom_id` FK ·
`transfer_qty` · `received_qty` · `unit_cost` · `line_amt` · `batch_no` ·
`out_ledger_id` FK (XFER_OUT) · `in_ledger_id` FK (XFER_IN) — **two ledger rows per line** (contract rule 3).

### 3.16 Lubricant issue — `tx_lube_issue` / `txl_lube_issue`

**`tx_lube_issue`**: `lube_issue_id` PK · `lube_issue_no` U (`LUB-KND-26-000318`) · `issue_date` ·
`location_id` FK (from store) · `asset_id` FK · `department_id` FK ·
**CK `asset_id IS NOT NULL OR department_id IS NOT NULL`** (contract rule 5) ·
`meter_reading` + `meter_type` CK KM/HR · `issued_to_employee_id` FK · `jobcard_id` FK · `total_qty`/`total_amt`.
**`txl_lube_issue`**: line PK · `lube_issue_id` FK+U(comp) · `line_no` · `item_id` FK (item_type=LUBRICANT) ·
`uom_id` FK · `issue_qty` · `unit_cost` (MWAC) · `line_amt` · `batch_no` ·
`prev_meter` + `consumption_since_last` (per-asset consumption analytics) · `ledger_id` FK.

### 3.17 Battery transactions

**`tx_battery_issue`** (`BAT`): `battery_issue_id` PK · `battery_issue_no` U · `battery_id` FK→md_battery ·
`item_id` FK · `from_location_id` FK · `to_asset_id` FK→md_asset · `meter_reading` ·
`installed_by_employee_id` FK · `jobcard_id` FK · `warranty_start_date` ·
`battery_status_after` (ISSUED/IN_SERVICE) · `ledger_id` FK (OUT of serialized stock) · `hist_event_id` FK.
**`tx_battery_transfer`** (`BTR`): `battery_transfer_id` PK · `battery_transfer_no` U · `battery_id` FK ·
`from_asset_id`/`to_asset_id` FK (CK differ) · `from_meter`/`to_meter` · `reason` ·
`battery_status_after` · `hist_event_id` FK.
**`tx_battery_return`** (`BRT`): `battery_return_id` PK · `battery_return_no` U · `battery_id` FK ·
`from_asset_id` FK · `to_location_id` FK · `return_type` CK RETURN/REPLACEMENT/SCRAP/WARRANTY/LOST/REPAIR ·
`replacement_battery_id` FK→md_battery · `warranty_term_id` FK · `warranty_claim_no` · `meter_reading` ·
`battery_status_after` CK · `ledger_id` FK (IN to stock if returned) · `hist_event_id` FK.

### 3.18 `hist_battery_event` — serial lifecycle log (append-only)

| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `event_id` | BIGINT IDENTITY | N | PK | |
| `battery_id` | BIGINT | N | FK→md_battery, U(comp) | |
| `event_seq` | INTEGER | N | U(comp) | Per-battery 1,2,3… → deterministic order |
| `event_type` | VARCHAR(15) | N | CK | RECEIVED\|ISSUED\|INSTALLED\|TRANSFERRED\|RETURNED\|WARRANTY_CLAIM\|REPAIRED\|SCRAPPED\|REPLACED\|LOST\|ADJUSTED |
| `event_date` | DATE | N | | |
| `from_asset_id`/`to_asset_id` | BIGINT | Y | FK→md_asset | Movement between assets |
| `from_location_id`/`to_location_id` | BIGINT | Y | FK→md_location | Stock ↔ asset |
| `meter_reading` | NUMERIC(18,2) | Y | | Asset meter at event |
| `from_status`/`to_status` | VARCHAR(22) | | | Status transition captured inline |
| `source_doc_type`/`source_doc_id`/`source_doc_no` | | | | GRN\|BAT\|BTR\|BRT\|ADJ back-reference |
| `replacement_battery_id` | BIGINT | Y | FK→md_battery | For REPLACED/warranty swaps |
| `event_value_amt` | NUMERIC(18,2) | Y | | Scrap/write-off/warranty credit |

### 3.19 Job card — `tx_jobcard` + children

**`tx_jobcard`** (`JC`)
| Column | Type | Null | Key | Notes |
|--------|------|------|-----|-------|
| `jobcard_id` | BIGINT IDENTITY | N | PK | |
| `jobcard_no` | VARCHAR(30) | N | U | `JC-CMB-26-000502` |
| `jobcard_date` | DATE | N | | |
| `promised_date` | DATE | Y | | SLA/promised completion; drives Overdue/Delayed KPI |
| `asset_id` | BIGINT | N | FK→md_asset | Vehicle/machine under repair |
| `location_id` | BIGINT | N | FK→md_location | Workshop |
| `job_type` | VARCHAR(14) | N | CK | BREAKDOWN\|PREVENTIVE\|ACCIDENT\|RUNNING_REPAIR\|INSPECTION\|GENERAL |
| `reported_defect` | TEXT | Y | | |
| `meter_reading`/`meter_type` | | Y | | Asset meter at open |
| `assigned_to_employee_id` | BIGINT | Y | FK→md_employee | |
| `project_id`/`department_id`/`cost_center_id` | BIGINT | Y | FK | Cost dimensions |
| `estimated_cost` / `total_job_cost` | NUMERIC(18,2) | N | | Estimate + rolled-up actual |
| `jobcard_status` | VARCHAR(28) | N | CK | Full JOBCARD vocab (contract §5) |
| `tm_approved_by/_at`, `om_approved_by/_at` | | Y | | Two-tier TM→OM sign-off |
| `opened_at`/`work_started_at`/`work_completed_at`/`closed_at` | TIMESTAMPTZ | Y | | Lifecycle timestamps |
| `hold_reason` | VARCHAR(300) | Y | | Reason captured when placed ON_HOLD |

**`txl_jobcard_task`**: `task_id` PK · `jobcard_id` FK+U(comp) · `line_no` · `task_description` ·
`defect_type` · `assigned_to_employee_id` FK · `task_status` CK PENDING/IN_PROGRESS/COMPLETED/CANCELLED ·
`estimated_hours`/`actual_hours` · `started_at`/`completed_at`.
**`tx_job_progress`**: `progress_id` PK · `jobcard_id` FK · `task_id` FK · `progress_date` ·
`work_done` · `pct_complete` · `hours_spent` · `logged_by_employee_id` FK · `status_snapshot` · `next_action`.

### 3.20 Job material request — `tx_job_material_req` / `txl_job_material_req`

**`tx_job_material_req`** (`MRQ`): `mrq_id` PK · `mrq_no` U · `jobcard_id` FK · `location_id` FK (store) ·
`req_type` CK INTERNAL/EXTERNAL · `requested_by` FK.
**`txl_job_material_req`**: `mrq_line_id` PK · `mrq_id` FK+U(comp) · `line_no` · `item_id`/`uom_id` FK ·
`task_id` FK · `requested_qty`/`approved_qty`/`issued_qty` · `reservation_id` FK→inv_reservation · `line_status`.

### 3.21 Job parts / labour / outside repair

**`tx_job_parts`**: `job_part_id` PK · `jobcard_id` FK · `task_id` FK · `item_id`/`uom_id` FK ·
`qty` · `unit_cost` · `part_cost` · `source_type` CK ISSUE/GRN/DIRECT · `source_doc_type/_id/_line_id` ·
`issue_line_id` FK→txl_issue · `mrq_id` FK · `ledger_id` FK · `is_returned` ·
`is_general` (TRUE = general item; rolls to `general_cost` not `material_cost`) ·
`is_provisional` (TRUE = valued at provisional price pending confirmation).
**`tx_job_labour`** (`LAB`): `labour_id` PK · `labour_no` U · `jobcard_id` FK · `task_id` FK ·
`employee_id` FK · `labour_date` · `start_time`/`end_time` · `hours`/`ot_hours` ·
`grade_id` FK · `labour_rate_id` FK→md_labour_rate · `hourly_rate` · `labour_cost`.
**`tx_job_outside_repair`** (`OSR`): `osr_id` PK · `osr_no` U · `jobcard_id` FK · `task_id` FK ·
`subcontractor_id` FK→md_supplier · `sent_date`/`expected_return_date`/`actual_return_date` ·
`po_id` FK · `grn_id` FK · `invoice_no` · `estimated_cost`/`actual_cost` ·
`osr_status` CK SENT/IN_PROGRESS/RECEIVED/INVOICED/CLOSED.

### 3.22 Costing — `cost_job_summary` / `cost_job_line` / `cost_variance`

**`cost_job_summary`** (1:1 job card): `summary_id` PK · `jobcard_id` FK+U ·
`material_cost`/`labour_cost`/`outside_repair_cost`/`general_cost`/`overhead_cost`/`total_job_cost` ·
`estimated_cost` · `variance_amt`/`variance_pct` · `is_provisional`
(TRUE while any provisional-priced cost line exists — blocks close) ·
`cost_status` CK DRAFT/CALCULATED/FINALIZED · `calculated_at` · `finalized_by`/`finalized_at`.
**`cost_job_line`**: `cost_line_id` PK · `jobcard_id` FK · `summary_id` FK ·
`cost_element` CK MATERIAL/LABOUR/OUTSIDE/GENERAL/OVERHEAD · `source_doc_type/_id/_line_id` ·
`item_id`/`employee_id`/`task_id` FK · `qty` · `unit_cost` · `line_cost` · `is_provisional`
(TRUE while any linked part still sits in `inv_pending_price`).
**`cost_variance`**: `variance_id` PK · `jobcard_id` FK · `summary_id` FK · `cost_element` ·
`estimated_amt`/`actual_amt` · `variance_amt`/`variance_pct` · `variance_reason` · `is_flagged_recompute`.

### 3.23 Workflow definition — `sys_workflow` / `sys_workflow_step`

**`sys_workflow`**: `workflow_id` PK · `workflow_code` U · `workflow_name` · `doc_type`.
**`sys_workflow_step`**: `step_id` PK · `workflow_id` FK+U(comp) · `step_no` U(comp) · `step_name` ·
`approval_role_id` FK→md_approval_role · `required_role_id` FK→sec_role ·
`min_amount`/`max_amount` (amount-banded routing) · `is_final` · `can_return` · `escalate_after_hours`.

### 3.24 Approval instance — `apr_request` / `apr_step` / `apr_action`

**`apr_request`**: `request_id` PK · `request_no` · `workflow_id` FK · `source_doc_type`/`source_doc_id`/`source_doc_no`
(polymorphic binding to any tx) · `current_step_no` · `apr_status` CK (APR vocab) · `amount` · `requested_by`/`requested_at`/`completed_at`.
**`apr_step`**: `apr_step_id` PK · `request_id` FK+U(comp) · `step_no` U(comp) · `workflow_step_id` FK ·
`assigned_role_id` FK · `assigned_user_id` FK · `step_status` CK · `acted_by`/`acted_at` · `due_at`.
**`apr_action`** (append-only): `action_id` PK · `request_id` FK · `apr_step_id` FK ·
`action_type` CK SUBMIT/APPROVE/REJECT/RETURN/ESCALATE/DELEGATE · `action_by` FK · `action_at` ·
`from_status`/`to_status` · `delegated_to` FK · `comments`.

### 3.25 Security — `sec_user` / `sec_role` / `sec_permission` / `sec_user_site`

**`sec_user`**: `user_id` PK · `username` U · `full_name` · `email` · `employee_id` FK→md_employee ·
`home_site_id` FK→md_location · `password_hash` · `auth_provider` · `is_locked` · `last_login_at`
(self-referential `created_by` is `DEFERRABLE INITIALLY DEFERRED` for first-row bootstrap).
**`sec_role`**: `role_id` PK · `role_code` U · `role_name`.
**`sec_permission`**: `permission_id` PK · `permission_code` U · `module` · `action`.
**`sec_user_role`** (`user_id`+`role_id` U) and **`sec_role_permission`** (`role_id`+`permission_id` U) are the join tables.
**`sec_user_site`**: `user_site_id` PK · `user_id` FK · `site_id` FK→md_location · `access_level` CK READ/WRITE/APPROVE ·
unique(`user_id`,`site_id`) — **the row-level site visibility filter** applied against every `site_id`-bearing document.

---

## 4. Standard Audit Columns (every table)

```
created_by   BIGINT       NOT NULL  REFERENCES sec_user(user_id)
created_at   TIMESTAMPTZ  NOT NULL  DEFAULT now()
updated_by   BIGINT       NULL      REFERENCES sec_user(user_id)
updated_at   TIMESTAMPTZ  NULL
row_version  INTEGER      NOT NULL  DEFAULT 1        -- optimistic concurrency (bump on UPDATE)
is_active    BOOLEAN      NOT NULL  DEFAULT TRUE     -- soft delete; NO physical DELETE on md_/mv_/hist_/apr_
```
Additional on every **approvable document** (`tx_*`, job/battery docs, costing, approvals):
```
approved_by  BIGINT       NULL      REFERENCES sec_user(user_id)
approved_at  TIMESTAMPTZ  NULL
site_id      BIGINT       NOT NULL  REFERENCES md_location(location_id)   -- row-level security anchor
```
Append-only tables (`mv_stock_ledger`, `hist_battery_event`, `md_price_history`, `apr_action`)
carry only `created_by`/`created_at` (+ `site_id` where relevant) — they are never updated.
`SQL Server ROWVERSION/BIT/DATETIME` in the contract map to PostgreSQL `INTEGER row_version` /
`BOOLEAN` / `TIMESTAMPTZ`.

> **Status columns.** The contract lists `*_status` as "FK `sys_status`". Because a status
> code is only unique **within** its `status_group`, we enforce the vocabulary at row level
> with a `CHECK (... IN (...))` (fast, no join, self-documenting) while `sys_status` remains
> the label/sort/i18n master keyed `(status_group, status_code)`. This is a deliberate,
> documented reconciliation of the two requirements — not a divergence.

---

## 5. How the Ledger Works (append-only `mv_stock_ledger`)

**Invariant (contract rule 1):** *every* stock-affecting line, in *every* module, writes exactly
one `mv_stock_ledger` row **in the same DB transaction** as its document, and updates
`inv_stock_balance` atomically. A transfer writes **two** rows (rule 3).

### 5.1 One posting = one row (per stock line)

```
 DOCUMENT LINE                         LEDGER ROW(S)                       BALANCE EFFECT
 ─────────────────────────────────────────────────────────────────────────────────────────
 txl_grn (receive)         ──▶  IN        qty=+recv  unit_cost=price   ▶  on_hand↑, MWAC recompute
 txl_issue (issue out)     ──▶  OUT       qty= issue unit_cost=MWAC    ▶  on_hand↓, MWAC unchanged
 txl_transfer (move)       ──▶  XFER_OUT @from  +  XFER_IN @to         ▶  from↓, to↑ (same unit_cost)
 txl_adjustment (count)    ──▶  ADJ_IN | ADJ_OUT                       ▶  on_hand ±, value ±
 txl_return (to supplier)  ──▶  RET_OUT (@store)                       ▶  on_hand↓
 txl_return (store back)   ──▶  RET_IN                                 ▶  on_hand↑
 txl_lube_issue            ──▶  OUT (source_doc_type=LUB)              ▶  on_hand↓ (+ meter capture)
 tx_battery_issue          ──▶  OUT (battery_id, serial_no, =BAT)     ▶  serialized unit leaves stock
 tx_battery_return (in)    ──▶  IN  (battery_id, serial_no, =BRT)     ▶  serialized unit re-enters stock
 price confirmation        ──▶  REVAL (reval_of_ledger_id set)        ▶  value & MWAC restated, qty=0
```

Each row stamps `source_doc_type` + `source_doc_id` + `source_line_id`, so any balance figure
drills straight back to the originating GRN/issue/job line, and every document line carries the
reciprocal `ledger_id` FK (e.g. `txl_grn.ledger_id`, `txl_transfer.out_ledger_id`/`in_ledger_id`).

### 5.2 Posting algorithm (single line)

```
BEGIN;
  -- 1. lock the balance row for this item x location (or create it)
  SELECT * FROM inv_stock_balance
    WHERE item_id=:i AND location_id=:l FOR UPDATE;      -- serialises concurrent posts
  -- 2. compute new running figures (MWAC path shown; see §6)
  --    IN : new_qty = on_hand + q ; new_avg = (on_hand*avg + q*price)/(on_hand+q)
  --    OUT: new_qty = on_hand - q ; new_avg = avg (unchanged)
  -- 3. append the immutable ledger row with the POST-movement running_* values
  INSERT INTO mv_stock_ledger(movement_no, item_id, location_id, mv_direction, qty,
        unit_cost, value_amt, running_balance_qty, running_balance_value, running_avg_cost,
        source_doc_type, source_doc_id, source_line_id, site_id, posted_by, created_by, ...)
    VALUES (...) RETURNING ledger_id;
  -- 4. update the materialised balance to match the new running_* values
  UPDATE inv_stock_balance SET on_hand_qty=:new_qty, moving_avg_cost=:new_avg,
        stock_value=:new_val, last_movement_id=:ledger_id, last_movement_at=now(),
        row_version=row_version+1 WHERE item_id=:i AND location_id=:l;
  -- 5. write the reciprocal ledger_id back onto the document line
COMMIT;
```

### 5.3 Balance is derivable — rebuild from the ledger

`inv_stock_balance` is a **materialised cache**; the ledger is the source of truth. Any balance
(or the whole table) can be rebuilt deterministically:

```sql
-- On-hand + value + MWAC per item x location, straight from the append-only ledger.
-- The last row per partition (highest ledger_id) already carries the running_* snapshot:
SELECT DISTINCT ON (item_id, location_id)
       item_id, location_id,
       running_balance_qty   AS on_hand_qty,
       running_balance_value AS stock_value,
       running_avg_cost      AS moving_avg_cost,
       ledger_id             AS last_movement_id
FROM   mv_stock_ledger
ORDER  BY item_id, location_id, ledger_id DESC;
```
A reconciliation job compares this projection to `inv_stock_balance` and repairs drift; because
`ledger_id` is a global monotonic identity, replay order is unambiguous. `reserved_qty` is
recomputed as `Σ inv_reservation.reserved_qty WHERE reservation_status='ACTIVE'`, and
`available_qty` is the STORED generated column `on_hand_qty - reserved_qty`.

---

## 6. How Valuation Works (Moving Weighted Average Cost)

**Default per contract §6.** MWAC is held on `inv_stock_balance.moving_avg_cost` per
`item_id × location_id` and recomputed on every **priced receipt**:

```
new_avg = (on_hand_qty × old_avg + received_qty × unit_price) / (on_hand_qty + received_qty)
```
Issues leave `moving_avg_cost` unchanged and are costed **at** the current average.

### 6.1 Worked example — item `BRK-PAD-001` @ store `CMB-MAIN`

| # | Doc | Direction | Qty | Unit price/cost | Value Δ | On-hand after | Stock value after | MWAC after |
|---|-----|-----------|-----|-----------------|---------|---------------|-------------------|------------|
| 1 | GRN-…-001 | IN | 100 | 1,500.00 | +150,000.00 | 100 | 150,000.00 | **1,500.0000** |
| 2 | GRN-…-002 | IN | 50 | 1,800.00 | +90,000.00 | 150 | 240,000.00 | **1,600.0000** |
| 3 | ISS-…-010 | OUT | 60 | 1,600.00 | −96,000.00 | 90 | 144,000.00 | 1,600.0000 |
| 4 | GRN-…-003 | IN | 30 | 1,700.00 | +51,000.00 | 120 | 195,000.00 | **1,625.0000** |
| 5 | ISS-…-021 | OUT | 20 | 1,625.00 | −32,500.00 | 100 | 162,500.00 | 1,625.0000 |
| 6 | ADJ-…-004 | ADJ_OUT | 2 | 1,625.00 | −3,250.00 | 98 | 159,250.00 | 1,625.0000 |

Row-by-row MWAC:
- **#2:** `(100×1500 + 50×1800) / 150 = 240000/150 = 1600.0000`
- **#4:** `(90×1600 + 30×1700) / 120 = 195000/120 = 1625.0000`
- Issues (#3,#5) and adjustments (#6) consume **at** MWAC, so the average is unchanged; only
  qty and value move. Every row above is one `mv_stock_ledger` insert; `running_avg_cost`
  equals the "MWAC after" column.

### 6.2 Provisional cost + revaluation (un-priced receipts)

```
 STEP                          TABLE EFFECT                                     COST BASIS
 ────────────────────────────────────────────────────────────────────────────────────────
 GRN line received, no price   txl_grn.is_priced=FALSE, price_status=PENDING    provisional
   → stock still moves         mv_stock_ledger IN, is_provisional=TRUE          = last/PO/manual
   → queue the line            inv_pending_price(row, provisional_unit_cost)    provisional_unit_cost
 Issues before pricing         txl_issue.unit_cost = provisional MWAC           provisional
   (e.g. onto a job card)      cost_job_line.is_provisional=TRUE                provisional
 Price confirmed               md_price_history(effective_date, CONFIRMED)      confirmed
   → post revaluation          mv_stock_ledger REVAL (qty=0, value_amt=Δ,       restated MWAC
                               reval_of_ledger_id → original IN row)
   → restate balance           inv_stock_balance.moving_avg_cost & stock_value  confirmed
   → resolve queue             inv_pending_price.price_status=CONFIRMED,
                               confirmed_unit_cost, variance_amt, reval_ledger_id
   → flag dependents           cost_variance.is_flagged_recompute=TRUE for any
                               job that consumed the item at provisional cost
```
Revaluation `value_amt = (confirmed_unit_cost − provisional_unit_cost) × qty_still_on_hand`;
already-issued quantity is corrected through the flagged job-cost recompute (contract rule 7:
a job cannot CLOSE while it has any row in `inv_pending_price`).

### 6.3 Optional FIFO (`inv_valuation_layer`)

When `md_item.valuation_method = 'FIFO'`, each priced receipt opens a layer
(`orig_qty`, `remaining_qty`, `unit_cost`, `is_open`). Issues consume the **oldest open** layer
first (index `ix_inv_val_layer_fifo`), decrement `remaining_qty`, close the layer at zero, and
stamp `mv_stock_ledger.valuation_layer_id` on the OUT row so cost of issue traces to the exact
receipt layer. MWAC and FIFO are mutually exclusive per item; the ledger structure is identical.

### 6.4 Serialized (battery) valuation

Batteries are **not** MWAC-averaged. Each `md_battery.acquisition_cost` carries its own value;
issue/return ledger rows for a battery use that serial's cost as `unit_cost`, and scrap/write-off
value flows through `hist_battery_event.event_value_amt`.

---

## 7. How Serial Tracking Works (battery lifecycle)

Two structures cooperate: **`md_battery`** holds the *current* state (one row per physical serial),
**`hist_battery_event`** is the *append-only* per-serial event log. `md_battery.last_event_id`
points at the newest event for O(1) current-state reads; full history is the ordered event set.

### 7.1 `original_asset_id` vs `current_asset_id`

| Field | Meaning | Changes when? |
|-------|---------|---------------|
| `original_asset_id` | The **first** asset the battery was ever installed on | Set once at first INSTALL; immutable thereafter |
| `current_asset_id` | The asset it is on **right now** (NULL if in stock/scrapped/lost) | Every issue / transfer / return |
| `current_location_id` | Store/bin when not on an asset | Set on return-to-stock; cleared on issue |
| `battery_status` | Current lifecycle state (BATTERY vocab) | Every event, mirrored by `to_status` |

### 7.2 Event recording (each in one transaction, `event_seq` = prior max + 1)

```
 BUSINESS ACTION        DOCUMENT            hist_battery_event row              md_battery update
 ─────────────────────────────────────────────────────────────────────────────────────────────
 Receive new battery    tx_grn(+serial)     RECEIVED  to_status=IN_STOCK       row created, IN_STOCK,
                                            to_location_id=store               current_location set
 Issue to a vehicle     tx_battery_issue    ISSUED/INSTALLED                   current_asset_id=to_asset,
                        (BAT)               from_location→to_asset             original_asset if first,
                                            to_status=IN_SERVICE               status=IN_SERVICE, +mv OUT
 Move asset→asset       tx_battery_transfer TRANSFERRED                        current_asset_id=to_asset,
                        (BTR)               from_asset→to_asset                status=IN_SERVICE
 Return to store        tx_battery_return   RETURNED  to_status=RETURNED       current_asset_id=NULL,
                        (BRT, RETURN)       to_location_id=store               current_location set, +mv IN
 Warranty claim         tx_battery_return   WARRANTY_CLAIM                     status=UNDER_WARRANTY_CLAIM,
                        (BRT, WARRANTY)     to_status=UNDER_WARRANTY_CLAIM     warranty_claim_no set
 Replace (swap)         tx_battery_return   REPLACED (replacement_battery_id)  old→REPLACED (current_asset
                        (BRT, REPLACEMENT)                                     NULL); new battery gets its
                                                                              own ISSUED event
 Scrap / write-off      tx_battery_return   SCRAPPED  event_value_amt=loss     status=SCRAPPED, is_active
                        (BRT, SCRAP)                                          may stay TRUE (no phys delete)
 Lost                   tx_battery_return   LOST                               status=LOST
```
Contract rule 4 holds: the movement appends to `hist_battery_event` **and** updates
`md_battery.current_asset_id` + `battery_status` in the same transaction.

### 7.3 Reconstructing full serial history

```sql
-- Complete cradle-to-grave trace for one battery, in order:
SELECT event_seq, event_date, event_type, from_status, to_status,
       from_asset_id, to_asset_id, from_location_id, to_location_id,
       meter_reading, source_doc_type, source_doc_no, replacement_battery_id, event_value_amt
FROM   hist_battery_event
WHERE  battery_id = :b
ORDER  BY event_seq;              -- unique(battery_id, event_seq) guarantees a total order
```
Because every row records both `from_status → to_status` and the driving `source_doc_no`, the log
answers: *which vehicles has serial X lived on, for how long / how many km each, when was it under
warranty, and what replaced it* — without touching any transaction table. Cross-checks:
`mv_stock_ledger` (filtered `battery_id`) gives the value trail; `md_battery.original_asset_id`
vs the first `INSTALLED` event must agree.

---

## 8. Indexing & Performance Notes

| Hot path | Index (in `schema.sql`) | Why |
|----------|-------------------------|-----|
| Balance rebuild / drill-down | `ix_mv_ledger_item_loc (item_id, location_id, ledger_id)` | `DISTINCT ON` replay + per-bin history in ledger order |
| Document → movements | `ix_mv_ledger_source (source_doc_type, source_doc_id, source_line_id)` | Drill from GRN/issue/job line to its ledger row |
| Day-book / date scans | `ix_mv_ledger_date`, `ix_mv_ledger_location` | Movement registers by date/site |
| Revaluation worklist | `ix_mv_ledger_provisional` **partial** `WHERE is_provisional` | Only the small provisional set |
| On-hand/available lookup | `uq_inv_stock_balance (item_id, location_id)` + `ix_inv_balance_location` | O(1) balance read; reorder scans |
| FIFO consume | `ix_inv_val_layer_fifo` **partial** `WHERE is_open` ordered `receipt_date` | Oldest-open layer first |
| Un-priced queue / job gate | `ix_inv_pending_status` **partial** `WHERE price_status<>'CONFIRMED'` | Pricing worklist + close gate |
| **Price as-of date** | `ix_md_price_hist_asof (item_id, effective_date DESC)`, `ix_md_price_hist_scope (item, supplier, site, effective_date DESC)` | `… WHERE item_id=? AND effective_date<=:txn ORDER BY effective_date DESC LIMIT 1` |
| Serial current-state | `ix_md_battery_current_asset` **partial**, `ix_md_battery_status`, `ix_md_battery_item` | "batteries on asset X", stock counts by status |
| Serial history | `ix_hist_battery_serial (battery_id, event_seq)`, `ix_hist_battery_date` | Ordered lifecycle reconstruction |
| Reservation netting | `ix_inv_reservation_item (item_id, location_id, reservation_status)` | Availability = on-hand − active reservations |
| Approval inbox | `ix_apr_step_open` **partial** `WHERE step_status='PENDING'`, `ix_apr_request_source` | "my pending approvals"; doc → request |
| Job costing joins | `ix_tx_job_parts_job`, `ix_tx_job_labour_job`, `ix_cost_job_line_job (jobcard_id, cost_element)` | Roll-up per job |
| Numbering | `ix_sys_number_series_key (doc_type, site_id, year_yy)` | `SELECT … FOR UPDATE` allocation |

**Notes.** (1) The ledger is insert-mostly — avoid over-indexing; the composite
`(item_id, location_id, ledger_id)` covers both replay and drill-down. (2) Partial indexes keep
worklists (provisional, pending-price, open FIFO layers, pending approvals) tiny regardless of
history volume. (3) Consider **monthly range partitioning** of `mv_stock_ledger` on
`movement_date` once volume is high; `inv_lube_monthly_balance` already snapshots period closings
so lube analytics need not rescan the full ledger. (4) `inv_stock_balance` updates take a
`FOR UPDATE` row lock per item×location — the natural concurrency boundary for high-throughput
stores; hot items should be posted through a single queue to avoid lock contention.

---

## 9. Naming Standards (recap — authority is the contract)

All identifiers follow [`00-design-contract.md` §1](./00-design-contract.md): table prefixes
(`md_/tx_/txl_/inv_/mv_/hist_/apr_/cost_/stg_/map_/sys_/sec_/doc_`); surrogate keys `<root>_id`
BIGINT identity; human keys `<root>_no` VARCHAR(30) `UNIQUE`; FKs `<referenced_root>_id` with
constraint names `fk_<table>_<ref>`; booleans `is_*`/`has_*`; dates `*_date`, timestamps `*_at`;
quantities `*_qty` NUMERIC(18,4); money `*_amt`/`*_cost` NUMERIC(18,2) (costs/MWAC widened to
NUMERIC(18,4) for precision); statuses `*_status`; the standard audit block on every table; and
document numbers formatted `TYPE-SITE-YY-NNNNNN` via `sys_number_series`. New objects introduced
here (`md_employee_grade`, `doc_attachment`, `inv_lube_monthly_balance`) follow the same prefix +
column rules and are flagged as additions in §11.

---

## 10. Cross-Module Integrity (enforced in schema / posting layer)

| Contract rule | Where enforced |
|---------------|----------------|
| 1 — every stock line posts ledger + updates balance atomically | Posting transaction §5.2; `ledger_id` FK on every txl_ line |
| 2 — no issue when `available < requested` unless override | `available_qty` GEN column + `tx_issue.override_by/override_reason` |
| 3 — transfer posts two ledger rows | `txl_transfer.out_ledger_id` + `in_ledger_id`; `CHECK from<>to` |
| 4 — battery move appends event + updates md_battery | §7.2 transaction; `hist_battery_event` + `md_battery.last_event_id` |
| 5 — lube issue needs asset or site+dept + meter | `ck_tx_lube_target` CHECK + `meter_reading` |
| 6 — costing reads price as-of txn date | `md_price_history` + `ix_md_price_hist_asof` |
| 7 — job cannot CLOSE with pending price / missing parts / labour / approvals | `inv_pending_price` gate; `jobcard_status` CHECK ladder; `apr_*` |
| 8 — every doc carries audit + site_id; price/cost edits logged | Audit block; `md_price_history` (immutable); `cost_variance` |

---

## 11. Additions Beyond the Contract's Explicit List (contract-compliant)

| New table/column | Prefix rule | Reason |
|------------------|-------------|--------|
| `md_employee_grade` | `md_` | Contract references `md_employee.grade_id` and `md_labour_rate` keyed by grade; the grade master was implied but unnamed |
| `inv_lube_monthly_balance` | `inv_` | Named in contract §3.2 as the month-end lube snapshot; given full columns here |
| `doc_attachment` | `doc_` | Contract defines the `doc_` family (GRN scans, battery serial proof); materialised as **one** polymorphic table — now core |
| `doc_attachment.checksum_sha256`, `link_role`, `is_primary` | column conv. | Integrity/de-dup of proof files + primary/role tagging; part of the core schema |
| `md_battery.site_id`, `md_battery.last_event_id` | column conv. | RLS + O(1) current-event pointer |
| `tx_jobcard.promised_date`, `hold_reason` | column conv. | SLA/promised-completion (Overdue/Delayed KPI) + ON_HOLD audit; part of the core schema |
| `cost_job_summary.is_provisional`, `tx_job_parts.is_general`, `tx_job_parts.is_provisional` | column conv. | Provisional-priced close gate + general-vs-material cost split; part of the core schema |
| `mv_stock_ledger.running_balance_value`, `running_avg_cost` | `*_value`/`*_cost` | Make each row a self-contained snapshot for cheap balance rebuild |

---

## 12. Migration Family (staging — outside core `schema.sql`)

Per contract §3.8, load/cleanse/map buffers are generated per legacy entity and are **not** part of
the transactional backbone DDL:

| Pattern | Purpose |
|---------|---------|
| `stg_<entity>_raw` | Verbatim legacy import (item, asset, battery, supplier, stock, jobcard) |
| `stg_<entity>_clean` | Validated/typed rows; `migr_status` ∈ IMPORTED→VALIDATED→MAPPED→APPROVED→POSTED (+REJECTED, DUPLICATE) |
| `map_<entity>_xref` | Legacy key → UMMS `<root>_id` cross-reference (drives FK resolution on post) |
| `stg_load_batch` | One row per import run (file, counts, status) |
| `stg_reject` | Rejected rows + reason (referential/format/duplicate) |

Opening stock is posted as GRN-equivalent `IN` ledger rows (source_doc_type=`MIGR`) so day-one
`inv_stock_balance` and MWAC derive from the same ledger mechanics as live operations; battery
opening serials post a `RECEIVED` `hist_battery_event` and set `md_battery` current state.

---

*End of Section 03 — Database Design. DDL: [`../sql/schema.sql`](../sql/schema.sql).*
