# 08 — Data Migration Strategy

> **Scope:** Migrating the legacy fleet + workshop + stores operation into **UMMS**
> (repo `Master-SAP`) from three real-world source classes: **(1) Excel/CSV workbooks**
> (stores stock sheets, oil stock book, battery register, supplier lists),
> **(2) old-system database backups** (whatever prior stores/costing package exists), and
> **(3) manual/paper data** (opening counts, battery serials keyed by hand, price lists).
>
> This document conforms to the **Design Contract** (`00-design-contract.md`). It reuses the
> contract's `stg_` (staging), `map_` (xref), `sys_number_series`, `mv_stock_ledger`,
> `inv_stock_balance`, `inv_pending_price`, `md_*` masters, MWAC valuation, and the **`MIGR`**
> status group `IMPORTED → VALIDATED → MAPPED → APPROVED → POSTED` (+ `REJECTED`, `DUPLICATE`).
> It does **not** re-define any of them. New objects introduced here follow contract prefix rules
> and are flagged **[NEW]**.

---

## 1. Migration Principles (non-negotiable)

| # | Principle | What it means for UMMS | Enforcement |
|---|-----------|------------------------|-------------|
| P1 | **Masters before transactions** | No `md_item`, no `inv_stock_balance` row. No `md_supplier`, no PO/GRN. No `md_asset`, no lubricant/battery issue. Order is fixed (see §4). | Load sequencer refuses a stage whose FK-parent stage is not `POSTED`. |
| P2 | **Opening balances, not dirty history** | Where legacy movement history is incomplete/untrustworthy, migrate **on-hand qty + value as a single opening `ADJ_IN`** per item×location — not thousands of legacy issues/receipts. Full history only where source is clean and explicitly signed off (Stage 6, optional). | Default path = opening balance; history path is opt-in per site. |
| P3 | **Validate before post** | Every row passes `stg_<entity>_clean` validation (§5) and mapping (§6) before it touches a live table. `IMPORTED` rows can never post. | Post job selects only `status=MAPPED/APPROVED`. |
| P4 | **Reversible by batch** | Every load carries a `load_batch_id`. Any batch can be reversed by a single reversing action (masters → `is_active=0`; opening stock → reversing `ADJ_OUT`) without touching other batches. | `stg_load_batch` + `load_batch_id` stamped on every posted master row / ledger row. |
| P5 | **Reconcile to control totals** | Source → staged → posted must tie on row counts, sum of quantities and opening stock **value**. No stage goes live until control totals reconcile and are signed. | §7 reconciliation gate is a hard Go/No-go. |
| P6 | **No silent transforms** | Every cleanse/normalize step is recorded (old value → new value) so an auditor can explain any changed serial, UoM or price. | `stg_<entity>_clean` keeps `raw_*` columns beside cleansed columns. |
| P7 | **Idempotent re-runs** | Re-importing the same source file must not double-post. Natural/legacy key + `load_batch_id` dedupe guarantees at-most-once posting. | Unique index on `(legacy_key, entity)` in `map_<entity>_xref`. |

---

## 2. Staging Architecture

### 2.1 Pipeline (text diagram)

```
                         ┌──────────────────────────────────────────────────────────┐
                         │  stg_load_batch  (one row per file/sheet load attempt)    │
                         │  batch_no · source_type · entity · file_name · row_count  │
                         │  hash · loaded_by · loaded_at · migr_status · asof_date   │
                         └───────────────┬──────────────────────────────────────────┘
                                         │ load_batch_id stamped on EVERY row below
   SOURCES                               ▼
 ┌───────────────┐   RAW (as-is)   ┌──────────────────┐  CLEANSE/  ┌──────────────────┐
 │ Excel / CSV   │ ───────────────▶│ stg_<entity>_raw │  TRANSFORM │ stg_<entity>_clean│
 │ (stock sheets,│   text-only,    │  every col VARCHAR│──────────▶│ typed, normalized │
 │  oil book,    │   no typing,    │  + raw_line_no    │  trim,     │ raw_* kept beside │
 │  battery reg) │   no rejects    │  + load_batch_id  │  upper,    │ cleansed values   │
 ├───────────────┤                 └──────────────────┘  date-fix   └────────┬─────────┘
 │ Old-system    │                                                            │
 │ DB backup     │─────────────────────────────────────┐              VALIDATE│(§5)
 ├───────────────┤                                      │                     │
 │ Manual / paper│─────────────────────────────────────┘        ┌────────────┴───────────┐
 └───────────────┘                                              PASS                    FAIL
                                                                 │                        │
                                                     MAP (§6)     ▼                        ▼
                                          ┌───────────────────────────────┐      ┌──────────────────┐
                                          │ map_<entity>_xref             │      │   stg_reject     │
                                          │ legacy_key → new *_id         │      │ row · rule · msg │
                                          │ survivor/duplicate flags      │      │ severity · batch │
                                          └───────────────┬───────────────┘      └────────┬─────────┘
                                                          │ POST (§8/§9)                   │ fix & re-load
                                                          ▼                                │ (loop §11)
              ┌────────────────────────────────────────────────────────────┐              │
              │ LIVE:  md_uom · md_item · md_supplier · md_asset · md_battery│◀─────────────┘
              │        md_price_history                                      │
              │ OPENING STOCK:  mv_stock_ledger (ADJ_IN)  →  inv_stock_balance│
              │ OPEN DOCS:  tx_po/tx_grn/tx_jobcard (open only)              │
              └────────────────────────────────────────────────────────────┘
```

### 2.2 Staging object catalogue

| Object | Prefix | Purpose | Key columns (beyond audit) | MIGR status held |
|--------|--------|---------|----------------------------|------------------|
| `stg_load_batch` | `stg_` | One row per physical load (file/sheet/table). Anchors reversibility & reconciliation. | `batch_no`, `source_type` {EXCEL, CSV, DB_BACKUP, MANUAL}, `entity`, `file_name`, `sheet_name`, `source_hash`, `asof_date`, `src_row_count`, `raw_row_count`, `clean_row_count`, `posted_row_count`, `reject_row_count`, `migr_status` | batch-level rollup |
| `stg_<entity>_raw` | `stg_` | Verbatim source, all columns `VARCHAR`. Never edited. | `raw_line_no`, `load_batch_id`, `src_*` columns as-is | `IMPORTED` |
| `stg_<entity>_clean` | `stg_` | Typed, trimmed, normalized. Keeps `raw_*` beside cleansed. | cleansed typed cols + `raw_*` + `migr_status` + `reject_reason` | `IMPORTED→VALIDATED→MAPPED` |
| `map_<entity>_xref` | `map_` | Legacy key → new `*_id`. Survivor/loser for dedupe. | `legacy_key`, `legacy_key2`, `entity`, `new_id`, `is_survivor`, `merged_into_id`, `match_method` {EXACT, FUZZY, MANUAL}, `load_batch_id` | `MAPPED→APPROVED→POSTED` |
| `stg_reject` | `stg_` | Every failed row from any validation. Drives the reject loop (§11). | `entity`, `raw_line_no`, `load_batch_id`, `rule_code`, `severity` {ERROR, WARN}, `field_name`, `bad_value`, `message`, `resolved_at`, `resolved_by` | `REJECTED` / `DUPLICATE` |

> **Convention note:** `<entity>` ∈ {`uom`, `category`, `location`, `supplier`, `employee`,
> `item`, `asset`, `battery`, `price`, `openstock`, `po`, `grn`, `jobcard`, `movement`}.
> Example concrete tables: `stg_item_raw`, `stg_item_clean`, `map_item_xref`,
> `stg_openstock_clean`, `map_asset_xref`.

---

## 3. Source Inventory (what the business actually hands over)

| Source | Typical form | Feeds entity | Known dirt to expect |
|--------|--------------|--------------|----------------------|
| Stores stock sheet | Excel, one row per part, bin-wise | `md_item`, opening stock | Merged cells, part name typos, UoM in the name ("Filter 5L"), blank codes |
| Oil / lubricant stock book | Excel/paper ledger, monthly | `md_item` (LUBRICANT), opening stock | Qty in litres vs drums mixed, no code, brand+grade in one cell |
| Battery register | Excel/paper, serial per line | `md_battery`, opening stock | Duplicate/blank serials, serial with spaces/hyphens, no acquisition cost |
| Supplier list | Excel / old-system table | `md_supplier` | Same vendor spelled 3 ways, missing type |
| Vehicle/machine list | Excel / fleet card | `md_asset` (+ `md_asset_vehicle`/`_machine`) | Reg no format drift, plant no vs asset no confusion |
| Employee/technician list | Excel / HR export | `md_employee` | Non-technicians mixed in, no grade |
| Price list | Excel / supplier quote | `md_price_history` | Price with no effective date, per-pack vs per-unit |
| Old-system backup | `.bak`/dump | any of the above + open PO/GRN/Job | Encoded status codes, `0000-00-00` dates, soft-deleted rows |
| Manual opening count | Paper count sheets | opening stock | Counted qty ≠ system qty, unpriced items |

---

## 4. Entity Migration Order (masters → opening → open docs → history)

> **Golden rule (contract §2):** one item list, one supplier list, one asset list, one UoM list,
> one location tree — shared by all four modules. Migrate each **once**, in this order. A stage
> may not start until every parent stage is `POSTED` and reconciled.

| Seq | Entity | Live target(s) | Depends on (must be POSTED first) | Load style | Notes |
|-----|--------|----------------|-----------------------------------|-----------|-------|
| 1 | **UoM** | `md_uom`, `md_uom_conversion` | — | Full | Seed base UoM (EA, L, KG, DRUM) + conversions (1 DRUM = 200 L). All qty normalize to these. |
| 2 | **Categories / Groups** | `md_item_category`, `md_item_group` | — | Full | Build hierarchy first so items can attach `parent_category_id`. |
| 3 | **Locations / Sites** | `md_location` | — | Full | SITE → STORE → BIN tree. **3-letter site codes** (CMB/KND/HO0) drive all doc numbering (contract §4). |
| 4 | **Suppliers** | `md_supplier` | — | Full + dedupe | Fuzzy-merge duplicates (§6). Assign `supplier_type`. |
| 5 | **Employees / Technicians** | `md_employee`, `md_labour_rate` | Sites | Full | Flag `is_technician`, set `grade_id`; labour rate effective-dated. |
| 6 | **Items (unified)** | `md_item` | UoM, Categories | Full + dedupe | ALL of STORE/LUBRICANT/BATTERY/SPARE/GENERAL/CONSUMABLE as one master. Set flags `is_stockable`, `is_serial_tracked`, `is_batch_tracked`, `valuation_method`. |
| 7 | **Assets (vehicle/machine)** | `md_asset` + `md_asset_vehicle` / `md_asset_machine` | Sites | Full | `asset_class` VEHICLE/MACHINE/EQUIPMENT. Lubricant & battery issue target. |
| 8 | **Battery serials** | `md_battery` | Items (battery model), Assets | Full + serial-unique | One row per physical serial. Set `battery_status` (`IN_STOCK` if unissued, `IN_SERVICE` if on a vehicle) + `current_asset_id`, `acquisition_cost`. |
| 9 | **Price history** | `md_price_history` (→ `md_price` current) | Items, Suppliers, Sites | Full | Effective-dated. Costing reads price **as-of** (contract §6/§7.6). Un-dated prices rejected (§5). |
| 10 | **Opening stock balances** | `mv_stock_ledger` (`ADJ_IN`) → `inv_stock_balance` | Items, Locations, Price | **Opening only** | On-hand qty + value → one `ADJ_IN` per item×location; seeds `moving_avg_cost` (§9). |
| 11 | **Open PO / GRN** | `tx_po`/`txl_po`, `tx_grn`/`txl_grn` | Items, Suppliers, Sites, Opening stock | Open only | Only **un-received PO** and **received-but-unposted GRN**. Un-priced GRN lines → `inv_pending_price`. |
| 12 | **Open Job Cards** | `tx_jobcard` (+ tasks/labour/parts) | Assets, Items, Employees, Opening stock | Open only | Only jobs not `CLOSED`. Migrate at their current `JOBCARD` sub-state (e.g. `IN_PROGRESS`, `AWAITING_PARTS`). |
| 13 | **Historical movements** *(optional)* | `mv_stock_ledger`, `hist_battery_event` | Everything above | Opt-in per site | Only where legacy history is clean and signed off (P2). Default = **skip**; opening balance already carries value. |

---

## 5. Validation Rules (`stg_<entity>_clean` gate)

> A row is promoted `IMPORTED → VALIDATED` only if it passes every `ERROR`-severity rule.
> `WARN` rows promote but are listed for review. Failures write to `stg_reject` with `rule_code`.

| Rule code | Applies to | Example failure | Severity | Action on fail |
|-----------|-----------|-----------------|----------|----------------|
| `V-DUP-KEY` | items, suppliers, assets, battery | Two rows with same normalized name+spec / same serial | ERROR | Route to dedupe (§6); loser → `stg_reject` `DUPLICATE`, mapped to survivor in xref |
| `V-MAND-KEY` | all | `md_item` row with blank part name / blank code | ERROR | Reject; cannot post without mandatory business key |
| `V-FK-SUPP` | items(price), po, grn | GRN line references supplier not in `map_supplier_xref` | ERROR | Reject as **orphan FK**; hold until supplier loaded |
| `V-FK-ITEM` | openstock, price, po, grn, jobcard | Stock row for item code with no `md_item` match | ERROR | Reject as orphan FK |
| `V-FK-ASSET` | battery, jobcard, lube | Battery assigned to vehicle reg not in `map_asset_xref` | ERROR | Reject as orphan FK (or set `current_asset_id=NULL`, `IN_STOCK`) |
| `V-DATE-BAD` | price, grn, jobcard, movement | `effective_date = '0000-00-00'` or `31/13/2025` | ERROR | Reject; date must be real & ≤ as-of date |
| `V-DATE-ASOF` | openstock, movement | Movement dated after opening-balance as-of date | WARN | Flag; exclude from opening, defer to history stage |
| `V-QTY-NUM` | openstock, grn, movement | Qty = "N/A", blank, or text | ERROR | Reject; qty must parse to `DECIMAL(18,4)` |
| `V-QTY-NEG` | openstock, grn | On-hand qty < 0 | ERROR (openstock) / WARN | Reject opening negative; require count recheck |
| `V-UOM-KNOWN` | items, openstock, grn | UoM "ltr"/"Ltrs"/"L." not in `md_uom` | ERROR | Reject until normalized to canonical UoM (map ltr→L) |
| `V-UOM-MATCH` | openstock, grn, price | Item base UoM = L but stock sheet qty in DRUM without conversion | ERROR | Reject; convert via `md_uom_conversion` or fix source |
| `V-SER-UNIQUE` | battery | Serial `N50-2231` appears twice / blank serial | ERROR | Reject duplicate; a serial-tracked item **must** have one unique serial |
| `V-SER-FMT` | battery | Serial with spaces/lowercase/`O`-vs-`0` | WARN | Auto-normalize (trim, upper, strip inner spaces); keep `raw_serial` |
| `V-PRICE-DATE` | price | Price value present but `effective_date` blank | ERROR | Reject; effective-dated price is mandatory for as-of costing |
| `V-PRICE-NUM` | price, openstock | Price/value not numeric or ≤ 0 for a stockable item | ERROR | Reject (or route to `inv_pending_price` if genuinely unknown) |
| `V-VAL-TIE` | openstock | `on_hand_qty × unit_cost ≠ stated stock value` (>tolerance) | WARN | Flag for reconciliation (§7); recompute unit cost = value/qty |
| `V-ASSET-CLASS` | asset | `asset_class` not in {VEHICLE, MACHINE, EQUIPMENT} | ERROR | Reject; must classify to route vehicle/machine extension row |
| `V-CAT-KNOWN` | items | Category not in `md_item_category` | ERROR | Reject or assign `UNCLASSIFIED` (config) |

---

## 6. Duplicate Detection & Survivor Logic

### 6.1 Match strategy per entity

| Entity | Exact-key match | Fuzzy match (candidate) | Uniqueness enforced |
|--------|-----------------|-------------------------|---------------------|
| **Items** | legacy item code | `normalize(name) + spec + base_uom` (lowercase, strip punctuation, collapse spaces, expand "flt"→"filter"); Levenshtein ≥ 0.90 | one `md_item` per real part |
| **Suppliers** | legacy supplier code / TIN | `normalize(name)` + phone/TIN token; ≥ 0.88 | one `md_supplier` per vendor |
| **Assets** | reg no / chassis / plant no | `normalize(reg_no)` (strip spaces/dashes) + chassis last-6 | one `md_asset` per physical unit |
| **Battery** | **serial (exact only)** | — (no fuzzy; serial is the identity) | **hard unique** on serial |

### 6.2 Normalization function (applied in `stg_*_clean`)

```
normalize(s) = UPPER(TRIM(collapse_spaces(strip_punct(expand_abbrev(s)))))
   e.g.  "  eng. oil 15w40 (4l) "  →  "ENGINE OIL 15W40 4L"
         "N50 - 2231"              →  "N502231"   (battery serial, inner sep stripped)
```

### 6.3 Survivor selection & loser mapping

```
For each fuzzy cluster:
  1. Rank candidates by:  (a) has legacy code  (b) most complete (UoM, category, price)
                          (c) most recent last-movement date  (d) highest on-hand qty
  2. SURVIVOR = rank #1  → gets the new *_id, is_survivor=1
  3. LOSERS   → map_<entity>_xref rows: legacy_key→survivor.new_id,
                is_survivor=0, merged_into_id=survivor.new_id, match_method=FUZZY
  4. Opening stock of losers is SUMMED into the survivor's opening ADJ_IN
     (qty added; value added; moving_avg_cost recomputed as weighted avg).
  5. All loser rows → stg_reject status=DUPLICATE (audit trail, not data loss).
  6. FUZZY matches below auto-threshold but above review floor → match_method=MANUAL,
     held for human confirm before survivor is finalized.
```

> **Result:** every legacy key — survivor or loser — has exactly one `map_<entity>_xref`
> row pointing at a live `*_id`. Downstream loads (opening stock, open PO, job cards) resolve
> legacy references through the xref, so merged duplicates never create orphans.

---

## 7. Reconciliation (hard Go/No-go gate)

### 7.1 Three-point control totals — **Source vs Staged vs Posted**

| Control total | Source (file/backup) | Staged (`stg_*_clean`) | Posted (live) | Must tie? |
|---------------|----------------------|------------------------|---------------|-----------|
| **Row count** | file `src_row_count` | `clean_row_count + reject_row_count` | `posted_row_count + duplicates_merged` | Exact |
| **Sum of qty** | Σ qty in sheet | Σ `on_hand_qty` clean | Σ `ADJ_IN.qty` in `mv_stock_ledger` | Exact (after UoM normalize) |
| **Opening stock value** | Σ stated value | Σ `qty × unit_cost` clean | Σ `ADJ_IN.value_amt` = Σ `inv_stock_balance` value | Within tolerance (rounding) |
| **Distinct items** | distinct codes | distinct after dedupe | distinct `item_id` in balance | Staged ≥ Posted (dupes merged) |
| **Battery serials** | serial count | unique serials | `md_battery` rows | Exact |
| **Supplier count** | distinct vendors | after merge | `md_supplier` active | Staged ≥ Posted |

### 7.2 Reconciliation formula (per batch)

```
src_row_count  ==  clean_row_count + reject_row_count           (nothing lost in RAW→CLEAN)
clean_row_count ==  posted_row_count + duplicates_merged
                     + still_rejected + deferred_to_history      (nothing lost CLEAN→POST)
Σ source_value  ==  Σ posted ADJ_IN value  ± rounding_tolerance
Σ posted ADJ_IN value  ==  Σ inv_stock_balance (on_hand_qty × moving_avg_cost)
```

### 7.3 Sign-off checklist (per stage, per site)

| ✔ | Check | Owner |
|---|-------|-------|
| ☐ | `asof_date` for opening balance agreed and locked | Finance + Stores Manager |
| ☐ | Row counts tie (src = clean+reject) | Migration lead |
| ☐ | Qty totals tie after UoM normalization | Stores Manager |
| ☐ | Opening stock **value** ties within tolerance | Finance |
| ☐ | Zero unresolved `ERROR` rows in `stg_reject` for the stage | Migration lead |
| ☐ | Duplicate merges reviewed & accepted | Data owner |
| ☐ | `inv_pending_price` count for un-priced GRN reviewed | Finance |
| ☐ | Sample audit: 20 random items src→live trace | Business QA |
| ☐ | Batch is reversible (single `load_batch_id`, reverse tested in staging) | Migration lead |

> **Opening-balance-as-of date:** stock value is frozen at `asof_date` (typically the day before
> go-live). All movements after `asof_date` are entered as **live UMMS transactions**, never as
> migration rows — this draws a clean line between migrated opening balance and live operations.

---

## 8. Posting Masters (VALIDATED/MAPPED → live)

| Step | Actor / role | Action | System effect | Ledger / cost effect | MIGR transition |
|------|--------------|--------|---------------|----------------------|-----------------|
| 8.1 | Migration lead | Run master post for entity (UoM→…→Price) | Insert into `md_*`, stamp `load_batch_id`, `created_by=MIGRATION` | none (masters don't move stock) | `MAPPED → POSTED` |
| 8.2 | System | Resolve every FK via `map_<entity>_xref` | Live rows carry new `*_id`; loser keys resolve to survivor | none | — |
| 8.3 | System | Write `new_id` back to xref | `map_*_xref.new_id` set for survivors | none | `POSTED` |
| 8.4 | Finance | Post `md_price_history` | Effective-dated prices live; `md_price` current row derived | Establishes as-of price for later costing (contract §6) | `POSTED` |

---

## 9. Opening Stock Loading (qty + value → `ADJ_IN` → MWAC seed)

> This is the heart of migration: legacy **on-hand quantity and value** become **one opening
> `ADJ_IN` movement** per `item_id × location_id`, which seeds `inv_stock_balance` and its
> `moving_avg_cost`. No fake receipts, no fabricated PO/GRN history.

### 9.1 Transform → post sequence

| Step | Actor | Action | System effect | Stock-ledger / costing effect | Status |
|------|-------|--------|---------------|-------------------------------|--------|
| 9.1 | Stores Mgr | Provide counted `on_hand_qty` + `stock_value` per item×location as-of `asof_date` | Rows land in `stg_openstock_clean` | — | `IMPORTED` |
| 9.2 | System | Validate (§5: `V-QTY-NUM`, `V-QTY-NEG`, `V-UOM-MATCH`, `V-VAL-TIE`) | Bad rows → `stg_reject` | — | `VALIDATED` |
| 9.3 | System | Compute `unit_cost = stock_value / on_hand_qty` (guard qty>0) | `unit_cost` stored in clean | Provisional MWAC seed value | `VALIDATED` |
| 9.4 | System | Resolve `item_id`/`location_id` via xref | Legacy code → live id | — | `MAPPED` |
| 9.5 | Finance | Approve opening-stock batch | Batch armed to post | — | `APPROVED` |
| 9.6 | System | **Post one `mv_stock_ledger` row per item×location** | Ledger row: `mv_direction=ADJ_IN`, `qty=on_hand_qty`, `unit_cost`, `value_amt=qty×unit_cost`, `source_doc_type='ADJ'`, `load_batch_id` | Append-only ledger entry (contract §7.1) | `POSTED` |
| 9.7 | System | **Seed `inv_stock_balance`** in same txn | `on_hand_qty` set; `moving_avg_cost = unit_cost` | MWAC initialized (contract §6) | `POSTED` |
| 9.8 | System | Route unpriced items | Items with qty but no reliable value → `inv_pending_price` | Later priced receipt triggers revaluation movement | `POSTED` |

### 9.2 MWAC seeding (contract §6 formula, opening case)

```
Opening (first movement for the item×location):
    on_hand_qty      = counted_qty
    moving_avg_cost  = stock_value / counted_qty        (= opening unit_cost)

First live priced receipt after go-live then follows the standard rule:
    new_avg = (on_hand_qty × moving_avg_cost + received_qty × unit_price)
              / (on_hand_qty + received_qty)
```

### 9.3 Battery / serialized items (special valuation)

- Serial-tracked batteries are **not** valued by MWAC; each carries its own `acquisition_cost`
  on `md_battery` (contract §6). Opening battery stock is loaded in **Stage 8** as `md_battery`
  rows (`IN_STOCK`/`IN_SERVICE`), not as an `ADJ_IN` value line — value = Σ `acquisition_cost`.
- A battery already fitted to a vehicle in the legacy register is loaded with
  `battery_status=IN_SERVICE`, `current_asset_id` = mapped asset, and an opening
  `hist_battery_event` (`event_type=OPENING`) seeds its lifecycle log.

---

## 10. Phased Migration Plan (Stage | Scope | Data | Validation | Reconciliation | Go/No-go)

| Stage | Scope | Data loaded | Key validation | Reconciliation | Go/No-go gate |
|-------|-------|-------------|----------------|----------------|---------------|
| **S0 — Prep** | Environments, code freeze on legacy, agree `asof_date` | `sys_number_series`, sites, UoM, categories | Config sanity | Site codes exist (CMB/KND/HO0) | Sandbox reversibility test passes |
| **S1 — Foundation masters** | UoM, Categories, Locations | `md_uom`, `md_uom_conversion`, `md_item_category/group`, `md_location` | `V-UOM-KNOWN`, `V-CAT-KNOWN` | Row counts tie | Hierarchies complete, zero ERROR rejects |
| **S2 — Party & people masters** | Suppliers, Employees | `md_supplier`, `md_employee`, `md_labour_rate` | `V-DUP-KEY` fuzzy merge, `V-MAND-KEY` | Supplier count (staged ≥ posted, merges logged) | Dedupe reviewed & signed |
| **S3 — Item master** | Unified items (all 6 `item_type`) | `md_item` | `V-DUP-KEY`, `V-UOM-MATCH`, flags set | Distinct item count | Item dedupe accepted; flags QA'd |
| **S4 — Asset & battery** | Vehicles, machines, battery serials | `md_asset`(+veh/mach), `md_battery`, opening `hist_battery_event` | `V-FK-ASSET`, `V-SER-UNIQUE`, `V-ASSET-CLASS` | Serial count exact; asset count | Zero duplicate serials; battery→asset links valid |
| **S5 — Prices** | Effective-dated price history | `md_price_history`, `md_price` | `V-PRICE-DATE`, `V-PRICE-NUM` | Price rows per item×supplier | No undated prices remain |
| **S6 — Opening stock** | On-hand qty+value → `ADJ_IN` | `mv_stock_ledger`, `inv_stock_balance`, `inv_pending_price` | `V-QTY-NEG`, `V-VAL-TIE`, `V-UOM-MATCH` | **Value tie src=posted; qty tie; MWAC seeded** | **Finance signs opening value** (hard gate) |
| **S7 — Open documents** | Un-received PO, unposted GRN, open Job Cards | `tx_po/grn`, `tx_jobcard`(+tasks/labour/parts) | `V-FK-*`, `V-DATE-BAD`, open-only filter | Open PO qty vs legacy; open job count | Only genuinely-open docs; costing consistent |
| **S8 — Historical movements** *(optional)* | Clean legacy history | `mv_stock_ledger`, `hist_battery_event` | `V-DATE-ASOF`, no double-count of opening | History Σ reconciles to opening | Per-site opt-in; default SKIP |
| **S9 — Cutover & go-live** | Freeze legacy, final delta count, switch users | delta opening top-up (movements between count and go-live) | Delta count vs live | Final `inv_stock_balance` = physical count | Business sign-off → **GO**; else fallback (§11) |

---

## 11. Cutover, Fallback & Reject-Handling Loop

### 11.1 Cutover sequence

```
T-7d   Freeze legacy MASTER edits → run S1–S5 to PRODUCTION (masters + prices)
T-2d   Stores physical count begins → captured to stg_openstock_*
T-1d   asof_date lock. Post S6 opening stock (ADJ_IN). Reconcile & Finance sign.
T-1d   Post S7 open PO/GRN/Job Cards.
T-0    Delta top-up: any movement between count and go-live entered as LIVE UMMS txns.
T-0    Final reconciliation = physical count. Business GO / NO-GO decision.
T+0    Legacy set READ-ONLY (retained for audit, not decommissioned).
```

### 11.2 Fallback (No-go)

| Trigger | Fallback action | Reversibility |
|---------|-----------------|---------------|
| Value totals don't tie / mass rejects | Do **not** flip legacy to read-only; keep operating on legacy | Reverse posted batches by `load_batch_id`: masters `is_active=0`; opening stock posts reversing `ADJ_OUT` (equal & opposite), zeroing `inv_stock_balance` |
| Partial failure (one site fails, others pass) | Go-live passing sites; re-run failed site next window | Per-batch/per-site reversal — passing sites untouched (P4) |
| Post-go-live defect found in a batch | Reverse just that batch, correct source, re-run through §11.3 loop | `stg_load_batch` + `load_batch_id` isolate blast radius |

### 11.3 Reject-handling loop

```
        ┌───────────────────────────────────────────────────────────────┐
        │  stg_reject  (rule_code, severity, field, bad_value, message)  │
        └───────────────┬───────────────────────────────────────────────┘
                        ▼
   (1) TRIAGE by rule_code + severity
        ERROR → must fix before stage posts     WARN → post + review list
                        │
        ┌───────────────┼─────────────────────────┐
        ▼               ▼                          ▼
  (2a) FIX AT SOURCE  (2b) FIX BY RULE/CONFIG  (2c) BUSINESS DECISION
   correct Excel/      add UoM synonym,          merge duplicate,
   backup, re-export   map category, add         set battery IN_STOCK,
                       conversion factor         accept value variance
                        │
                        ▼
   (3) RE-LOAD corrected rows under a NEW load_batch_id
        (original reject rows marked resolved_at/resolved_by; never edited in place)
                        │
                        ▼
   (4) RE-VALIDATE → RE-MAP → RE-RECONCILE
        loop until  ERROR rejects = 0  for the stage
                        │
                        ▼
   (5) STAGE PASSES → sign-off checklist (§7.3) → POST
```

> **Loop invariant:** rejects are never deleted or edited in place — they are **resolved** and the
> fix re-enters as a fresh batch. This preserves a complete `IMPORTED → REJECTED → (resolved) →
> POSTED` audit trail per the `MIGR` status group, so every live row is traceable back to a source
> file line, its cleansing steps, its dedupe decision, and its posting batch.

---

## 12. Traceability Summary (source line → live row)

```
Excel row 42 (stock sheet, CMB)
  └─ stg_item_raw.raw_line_no=42 (batch B-CMB-ITEM-01)         [IMPORTED]
      └─ stg_item_clean  normalize/UoM-fix, raw_* retained     [VALIDATED]
          └─ map_item_xref legacy="OILF-5L" → item_id=8123     [MAPPED→POSTED]
              └─ md_item (item_id=8123, LUBRICANT, base_uom=L)
                  └─ stg_openstock_clean qty=40 val=48,000
                      └─ mv_stock_ledger ADJ_IN qty=40 unit_cost=1,200  [POSTED]
                          └─ inv_stock_balance on_hand=40 moving_avg_cost=1,200
```

Any auditor can walk this chain in both directions using `load_batch_id`, `raw_line_no`, and
`map_item_xref` — satisfying the contract's audit and no-silent-transform requirements.
