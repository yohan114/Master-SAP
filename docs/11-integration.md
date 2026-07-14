# 11 — Integration & Future‑Readiness

> **Scope of this section.** How UMMS exposes and ingests data so that the transport
> fleet + workshop + stores business can (a) live inside spreadsheets today, (b) run
> barcode/QR on the shop floor, (c) attach photographic proof to every serial, (d) push
> WhatsApp/email alerts, (e) be consumed by REST clients and Power BI, and (f) later
> federate with SAP MM/PM/CO **without rework**.
>
> This document **reuses** the canonical backbone in [`00-design-contract.md`](00-design-contract.md):
> the `doc_` attachment family, the `stg_`/`map_` migration pipeline, the `mv_stock_ledger`
> append‑only ledger, `sys_number_series`, the `apr_*` engine, the MWAC valuation rule, and
> the `TYPE-SITE-YY-NNNNNN` numbering format. New tables introduced here follow the contract's
> prefix + column conventions (`*_id`, `*_no`, `*_at`, `is_*`, audit block, `site_id`) and are
> flagged **[NEW]**.

---

## 11.0 Integration map (one picture)

```
                         ┌─────────────────────────────────────────────┐
   Excel templates ──▶   │  stg_*  →  validate  →  map_*  →  POST        │  (bulk in)
                         │                     │                          │
   Barcode / QR scan ─▶  │   scan resolver  →  tx_grn / tx_issue /        │  (shop floor)
                         │                     tx_battery_* / tx_jobcard  │
                         │                     │                          │
   REST clients  ◀──▶    │   /api/v1/*  (token/OAuth2, idempotency-key)   │  (system-to-system)
                         │                     │                          │
                         │        DOMAIN CORE  (event-driven postings)    │
                         │   every POST → mv_stock_ledger + inv_* +       │
                         │                 sys_event  (outbox)            │
                         └───────┬───────────────┬───────────────┬────────┘
                                 │               │               │
                    doc_ store   │      sys_event outbox         │  read-only BI views
                 (attachments,    │   ┌───────────┴─────────┐    │  (star schema)
                  serial photos)  │   │ notif engine        │    ▼
                                  │   │  in-app / email /   │  fact_stock_movement
                                  ▼   │  WhatsApp adapters  │  fact_job_cost  → Power BI
                          shown on md_battery,             │  dim_item/asset/…
                          hist_battery_event, grids        ▼
                                              webhooks → external subscribers → (future) SAP
```

**One rule underpins all of it:** every state change is a *posting* that (1) writes its
domain rows, (2) appends to `mv_stock_ledger` / `hist_battery_event` where stock or serials
move, and (3) emits a `sys_event` row in the **same transaction** (transactional outbox).
Excel import, scanning, REST and SAP are all just *different front doors to the same POST*.

---

## 11.1 Excel Import / Export

### 11.1.1 Design principle

- **Import = the migration pipeline, reused for BAU.** The contract's `stg_<entity>_raw` →
  `stg_<entity>_clean` → `map_<entity>_xref` → POST flow (contract §3.8) is **not** a one‑off
  migration tool; it is the permanent bulk‑entry channel. A month‑end lubricant issue upload
  and the initial data migration run the **same** validators and land in the **same** staging
  tables under a `stg_load_batch`.
- **Export = every grid is exportable.** No screen is a dead end. Any list/report grid exposes
  one‑click **Excel** and **CSV** export of the *currently filtered* rows, plus a "template"
  export that emits the empty upload template for that entity.

### 11.1.2 Template‑driven import — supported entities

| Template | Lands in staging | Maps via | Posts to | Numbering |
|----------|------------------|----------|----------|-----------|
| Item master | `stg_item_raw/clean` | `map_item_xref` | `md_item` (+ category/uom/group) | — |
| Supplier master | `stg_supplier_raw/clean` | `map_supplier_xref` | `md_supplier` | — |
| Asset / vehicle | `stg_asset_raw/clean` | `map_asset_xref` | `md_asset` (+ `md_asset_vehicle`/`_machine`) | — |
| Opening stock | `stg_opening_raw/clean` | `map_item_xref` + `map_location_xref` | `mv_stock_ledger` (`ADJ_IN`) + `inv_stock_balance` | `ADJ` |
| Price list | `stg_price_raw/clean` | `map_item_xref` | `md_price` + `md_price_history` | — |
| Battery serial register | `stg_battery_raw/clean` | `map_battery_xref` | `md_battery` (+ `hist_battery_event` `IN_STOCK`) | — |
| GRN bulk (backlog) | `stg_grn_raw/clean` | item + supplier xref | `tx_grn`/`txl_grn` | `GRN` |
| Lubricant issue (monthly) | `stg_lube_raw/clean` | item + asset xref | `tx_lube_issue` | `LUB` |
| Labour timesheet | `stg_labour_raw/clean` | employee + jobcard xref | `tx_job_labour` | `LAB` |

### 11.1.3 Import workflow (actor · action · effect · ledger · status)

| # | Actor / role | Action | System effect | Stock/costing effect | Status (`MIGR`) |
|---|--------------|--------|---------------|----------------------|-----------------|
| 1 | Stores clerk | Download template from target grid | Emits `.xlsx` with typed headers, dropdown‑validated code columns, hidden `map_` hint columns | none | — |
| 2 | Stores clerk | Upload filled file | Rows land in `stg_<entity>_raw` under a new `stg_load_batch`; file itself stored in `doc_` and linked to the batch | none | `IMPORTED` |
| 3 | System | Structural + business validation | Type/UoM/duplicate/FK checks; failures written to `stg_reject` with reason | none | `VALIDATED` / rejects flagged |
| 4 | System | Key resolution | Legacy codes resolved to master `*_id` via `map_<entity>_xref`; unmatched keys queued for manual map | none | `MAPPED` |
| 5 | Data steward | Review & approve batch | Diff preview (new vs update vs reject); approver recorded | none | `APPROVED` |
| 6 | System | Commit batch | Rows posted to real `tx_*`/`md_*`; **stock‑affecting rows post `mv_stock_ledger` + update `inv_stock_balance` atomically** (contract §7.1) | MWAC recalculated on priced receipts | `POSTED` |

- **Idempotency:** each staging row carries a `source_row_hash`; re‑uploading the same file
  under the same batch key is a no‑op (dedup → `DUPLICATE`). Aligns with the REST idempotency
  model (§11.7).
- **Partial commit:** a batch with rejects can post the clean rows and leave rejects in
  `stg_reject`; nothing is silently dropped.

### 11.1.4 Export — universal behaviour

| Trigger | Output | Notes |
|---------|--------|-------|
| Grid "Export" button | `.xlsx` / `.csv` of filtered, sorted, column‑selected rows | respects `sec_user_site` row‑level security — never exports beyond the user's sites |
| Report "Export" | formatted `.xlsx` (headers, totals, as‑of date stamp) | e.g. Stock Balance, Job Cost Sheet, Battery Register, Pending‑Price queue |
| "Blank template" | empty upload template for that entity | closes the import↔export loop |
| Scheduled export | drops file to `doc_` + optional email (§11.6) | e.g. nightly stock‑balance snapshot |

> **Non‑negotiable:** exports and reports read from the **read‑only reporting views**
> (§11.8), never by ad‑hoc querying transactional tables, so heavy exports never lock postings.

---

## 11.2 Barcode / QR

### 11.2.1 What gets encoded

| Symbol carrier | Encodes | Symbology | Where printed |
|----------------|---------|-----------|---------------|
| Item / bin label | `item_no` (+ `location_id` bin) | Code‑128 / QR | shelf‑edge, bin face |
| GRN label | `grn_no` | QR | printed on GRN acceptance |
| Battery serial tag | battery serial (`md_battery.battery_serial_no`) + `item_no` | QR (durable) | on each physical battery |
| Job card traveller | `jobcard_no` | QR | job card printout / vehicle |
| Asset plate | `asset_no` (reg no for vehicles) | QR | vehicle / machine |
| Issue / picklist | `issue_no` / `mrq_no` | Code‑128 | picking slip |

> Encoding **the human document/master number** (`*_no`), not the surrogate `*_id`, keeps
> labels stable across environments and readable by humans if the scanner fails.

### 11.2.2 Scan resolver

A single **scan endpoint** parses a scanned string, classifies it by prefix pattern
(`GRN-…`, `JC-…`, `BAT`/serial mask, `item_no` mask) and routes to the right resolver →
returns the entity + allowed next actions for the current screen. One scanner, context‑aware.

### 11.2.3 Scan‑driven workflows

| Flow | Actor | Scan sequence | System effect | Ledger / serial effect | Status |
|------|-------|---------------|---------------|------------------------|--------|
| **Scan‑to‑receive** | Store keeper | scan `po_no` → scan each `item_no` → key qty → scan bin | Builds/updates `tx_grn`/`txl_grn`; bin = `location_id` | on post: `mv_stock_ledger` `IN`, `inv_stock_balance` + MWAC (or `inv_pending_price` if unpriced) | GRN `RECEIVED`→…→`POSTED` |
| **Scan‑to‑issue** | Store keeper | scan `issue_no`/`mrq_no` → scan `item_no` → scan bin | Confirms pick line; blocks if `available_qty < qty` w/o override (contract §7.2) | `mv_stock_ledger` `OUT`, balance ↓ | ISS/MRQ `POSTED` |
| **Scan battery (issue)** | Technician | scan `jobcard_no` → scan battery serial → scan target `asset_no` | Creates `tx_battery_issue`; `md_battery.current_asset_id` set | `hist_battery_event` (`ISSUED`→`IN_SERVICE`); balance ↓ | Battery `ISSUED`/`IN_SERVICE` |
| **Scan battery (return/warranty)** | Technician | scan battery serial → pick reason | `tx_battery_return`; warranty check vs `md_warranty_term` | `hist_battery_event` (`RETURNED`/`UNDER_WARRANTY_CLAIM`) | Battery `RETURNED`/`UNDER_WARRANTY_CLAIM` |
| **Scan for job parts** | Technician | scan `jobcard_no` → scan `item_no` | Adds line to `tx_job_material_req`/`tx_job_parts` | reservation `inv_reservation`; on issue `mv_stock_ledger` `OUT` | jobcard `IN_PROGRESS`/`AWAITING_PARTS` |
| **Stock count** | Counter | scan bin → scan `item_no` → key counted qty | `tx_adjustment` line auto‑built; variance vs on‑hand | on post `mv_stock_ledger` `ADJ_IN`/`ADJ_OUT` | ADJ `POSTED` |

- Every scan action still passes through the same **POST** path and its approvals — scanning
  is an *input accelerator*, never a bypass of stock/costing rules.
- **Offline scanning:** handheld buffers scans locally and replays them through the REST POST
  with idempotency keys (§11.7) so a lost connection never double‑issues.

### 11.2.4 Label formats

| Label | Fields on face | Format spec source |
|-------|----------------|--------------------|
| Bin/item | item_no, description, UoM, QR | `sys_setting` label template + `md_item` |
| Battery | serial, item_no (model), warranty‑to date, QR | `md_battery` + `md_warranty_term` |
| GRN | grn_no, supplier, date, QR | `tx_grn` |
| Job card | jobcard_no, asset/reg, open date, QR | `tx_jobcard` + `md_asset` |

---

## 11.3 Attachment Upload (`doc_` store)

### 11.3.1 Polymorphic attachment model **[NEW table, `doc_` family]**

`doc_attachment` is the single polymorphic attachment table for the whole platform: each row
carries the file metadata **and** attaches it to **any** source document polymorphically. This
is the one attachment mechanism for the whole platform.

```
doc_attachment (single polymorphic table)
──────────────
attachment_id     BIGINT PK
source_doc_type   VARCHAR(30)   -- 'GRN','JOBCARD','BATTERY',…
source_doc_id     BIGINT        -- the *_id in that table
doc_category      VARCHAR(30)   -- GRN_SCAN | BATTERY_SERIAL_PHOTO | INVOICE | WARRANTY | OTHER
file_name         VARCHAR(255)
file_url          VARCHAR(500)
mime_type         VARCHAR(100)
file_size         BIGINT
checksum_sha256   CHAR(64)
link_role         VARCHAR(30)   -- PRIMARY | SUPPORTING | PROOF | SIGNATURE
is_primary        BIT
+ audit block, site_id
```

- `source_doc_type` values are drawn from `sys_code` (`DOC_SOURCE_TYPE` group) so a new
  document type only needs a code row, not schema change.
- `checksum_sha256` detects identical uploads; a re‑attached invoice carries the same
  `checksum_sha256`.

### 11.3.2 Allowed types / limits (`sys_setting` driven)

| Setting | Default |
|---------|---------|
| Allowed MIME | `image/jpeg, image/png, image/webp, application/pdf, xlsx, csv` |
| Max size | 15 MB image / 25 MB PDF (per `sys_setting`) |
| Virus scan | required before `doc_attachment` marked `is_active` |
| Retention | never physically deleted; superseded files `is_active=0` (contract §1.4) |

### 11.3.3 What can be attached where

| Source document | `source_doc_type` | Typical `link_role` |
|-----------------|-------------------|---------------------|
| `tx_grn` | `GRN` | supplier invoice, delivery note, QC photo, scanned signed GRN |
| `tx_jobcard` | `JOBCARD` | defect photos, before/after, customer sign‑off, gate pass |
| `tx_job_outside_repair` | `OSR` | subcontractor invoice, quotation |
| `md_battery` / `hist_battery_event` | `BATTERY` | **serial image proof** (§11.4) |
| `md_asset` | `ASSET` | registration book, insurance, warranty card |
| `md_item` | `ITEM` | spec sheet, MSDS (lubricant) |
| `tx_adjustment` | `ADJ` | count sheet photo, approval note |
| `stg_load_batch` | `IMPORT` | the uploaded Excel file itself |

---

## 11.4 Battery Serial Image Proof

### 11.4.1 Principle

Every battery movement that changes custody **captures a photo of the physical serial** and
files it in `doc_attachment` with `doc_category='BATTERY_SERIAL_PHOTO'` and `link_role='PROOF'`, linked both to `md_battery` (latest
proof) and to the specific `hist_battery_event` row (proof *as at* that event). This gives an
auditable "who held which serial, when, with photographic evidence" trail — critical for
warranty disputes and theft/loss control.

### 11.4.2 Capture points

| Event | Actor | Photo captured | Linked to | Battery status |
|-------|-------|----------------|-----------|----------------|
| Receipt into stock | Store keeper | serial + case condition | `hist_battery_event` (`IN_STOCK`) + `md_battery` | `IN_STOCK` |
| Issue / punch to asset | Technician | serial on bench + fitted on asset | `hist_battery_event` (`ISSUED`) + `tx_battery_issue` | `ISSUED`→`IN_SERVICE` |
| Transfer asset→asset | Technician | serial at swap | `hist_battery_event` (`TRANSFERRED`) + `tx_battery_transfer` | `TRANSFERRED` |
| Return / warranty / scrap | Technician | serial + fault/label | `hist_battery_event` (`RETURNED`/`UNDER_WARRANTY_CLAIM`/`SCRAPPED`) | matching status |

### 11.4.3 Presentation

- `md_battery` detail screen shows the **latest** `BATTERY_SERIAL_PHOTO` thumbnail + full lifecycle
  gallery.
- Each `hist_battery_event` row is clickable → the proof photo *for that event* (the mobile
  capture flow makes the photo mandatory before the movement can POST, enforced in the same
  transaction that writes `hist_battery_event`).
- Warranty claim pack (export) bundles: `md_battery`, `md_warranty_term`, full
  `hist_battery_event` list, and all linked `BATTERY_SERIAL_PHOTO` images as a single PDF.

---

## 11.5 Notification Engine

### 11.5.1 Event → Rule → Channel model **[NEW tables, `sys_`/`notif_`]**

```
sys_event  (outbox, written in the posting txn)
   │  event_type, source_doc_type, source_doc_id, payload(json), site_id, created_at
   ▼
notif_rule           notif_template            notif_subscription        notif_outbound (queue)
──────────           ─────────────             ─────────────────         ──────────────
rule_id PK           template_id PK            subscription_id PK        outbound_id PK
event_type           channel (INAPP/EMAIL/WA)  user_id/role_id           template_id, channel
condition_json       subject_tmpl              event_type                to_address
channel_set          body_tmpl (mustache)      is_opt_in                 payload_json
digest_or_realtime   locale                    quiet_hours               status (PENDING/SENT/FAILED)
is_active            + audit                   + audit                   retry_count, next_attempt_at
                                                                         + audit
```

Flow: a POST writes `sys_event` → the **notification dispatcher** matches active `notif_rule`
whose `condition_json` passes → resolves recipients from `notif_subscription` (respecting
`is_opt_in`, role, site, quiet hours) → renders `notif_template` per channel → enqueues
`notif_outbound`. Delivery is handled by the channel adapters (§11.6).

### 11.5.2 Realtime vs digest

| Mode | Behaviour | Example |
|------|-----------|---------|
| `REALTIME` | one `notif_outbound` per event, immediately | job card returned for rework; battery warranty claim raised |
| `DIGEST` | events accumulate; a scheduled job rolls them into one message | daily "12 GRNs pending pricing", "5 job cards awaiting closure" |

### 11.5.3 Tie‑in to the alert list

The alert/exception list surfaced on dashboards is **generated by the same rules** — an alert
is a `REALTIME`/`INAPP` notification that is also pinned to the user's alert panel. Canonical
alerts and their triggering events:

| Alert | Triggering `event_type` | Default channels | Recipients |
|-------|-------------------------|------------------|------------|
| Pending‑price backlog | `INV.PENDING_PRICE.AGED` | in‑app + email digest | Stores officer, Accounts |
| Reorder / below min | `INV.STOCK.BELOW_MIN` | in‑app + WhatsApp | Stores officer |
| Job card awaiting approval | `JOBCARD.PENDING_APPROVAL` | in‑app + WhatsApp | TM / OM |
| Job cost variance breach | `COST.VARIANCE.EXCEEDED` | email | Workshop manager |
| Battery warranty expiring | `BATTERY.WARRANTY.EXPIRING` | email digest | Fleet manager |
| Negative / override issue | `INV.ISSUE.OVERRIDE` | in‑app | Stores manager |
| GRN QC failed | `GRN.QC_FAILED` | in‑app + email | QC, Stores |

---

## 11.6 WhatsApp / Email Hooks

### 11.6.1 Provider‑agnostic adapter

- The engine never calls a vendor SDK directly. It writes `notif_outbound`; a **channel
  adapter** per channel picks up the queue and calls the configured provider (SMTP/SendGrid for
  email; WhatsApp Business Cloud API / Twilio for WhatsApp). Provider config lives in
  `sys_setting`; swapping providers is config, not code.
- Adapter contract: `send(outbound) → {accepted, provider_msg_id, error}`. Provider message id
  is stored back on `notif_outbound` for delivery‑receipt reconciliation.

### 11.6.2 Queue, retry, opt‑in

| Concern | Design |
|---------|--------|
| Queued outbound | all sends go through `notif_outbound` (`PENDING`); never synchronous with the posting txn |
| Retry | exponential backoff via `retry_count` + `next_attempt_at`; move to `FAILED` after N attempts, raise an in‑app alert |
| Idempotency | one `notif_outbound` row per (event, recipient, channel) → provider dedup; retries reuse the same idempotency key |
| Opt‑in | `notif_subscription.is_opt_in` per user **and** per role; WhatsApp additionally honours channel‑level consent |
| Quiet hours | per‑subscription `quiet_hours`; realtime messages queued and released after the window |
| Delivery receipts | provider webhooks update `notif_outbound.status` (`SENT`→`DELIVERED`/`READ`) |
| Audit | every send logged with template id, rendered body hash, provider id (contract "audit everywhere") |

### 11.6.3 WhatsApp specifics

- Uses **pre‑approved message templates** mapped 1:1 to `notif_template` rows (channel `WA`)
  with placeholder variables filled from `sys_event.payload`.
- Inbound replies (e.g. "APPROVE JC‑CMB‑26‑000502") can be routed to the `apr_action` engine via
  the same webhook intake used for provider receipts — future‑optional, but the queue/adapter
  shape already supports it.

---

## 11.7 API Readiness (REST)

### 11.7.1 Resource model (nouns)

| Resource | Backing tables | Read | Write (POST) |
|----------|----------------|------|--------------|
| `/api/v1/items` | `md_item` (+category/uom) | list/get | create/update master |
| `/api/v1/assets` | `md_asset` (+vehicle/machine) | list/get | create/update |
| `/api/v1/suppliers` | `md_supplier` | list/get | create/update |
| `/api/v1/grns` | `tx_grn`/`txl_grn` | list/get | create → POST (ledger `IN`) |
| `/api/v1/issues` | `tx_issue`/`txl_issue` | list/get | create → POST (ledger `OUT`) |
| `/api/v1/transfers` | `tx_transfer` | list/get | create → POST (`XFER_OUT`+`XFER_IN`) |
| `/api/v1/jobcards` | `tx_jobcard` (+tasks/parts/labour) | list/get | create/progress/close |
| `/api/v1/batteries` | `md_battery` + `hist_battery_event` | list/get/history | issue/transfer/return |
| `/api/v1/stock-balances` | `inv_stock_balance` (view) | list/get (as‑of) | *read‑only* |
| `/api/v1/ledger` | `mv_stock_ledger` (view) | list/get, filter by item/location/date | *read‑only append via postings* |
| `/api/v1/prices` | `md_price`/`md_price_history` | list/get as‑of | create effective‑dated |
| `/api/v1/attachments` | `doc_attachment` | get/download | upload + link |

**Conventions:** plural nouns; sub‑resources (`/jobcards/{id}/labour`,
`/batteries/{serial}/events`); filtering/paging via query params; every list respects
`sec_user_site` row‑level security from the token's identity.

### 11.7.2 Auth

| Aspect | Choice |
|--------|--------|
| Interactive apps | OAuth2 (authorization‑code + PKCE) → short‑lived bearer JWT |
| System‑to‑system | OAuth2 client‑credentials **or** long‑lived API token (`sec_*`), scoped |
| Scopes | per resource + verb, e.g. `grns:write`, `ledger:read`, `batteries:write` |
| Row security | token carries user → `sec_user_site` filters every response; no cross‑site leakage |
| Audit | every write records `created_by` from the token subject (contract §1.3) |

### 11.7.3 Idempotency for postings

> **The load‑bearing requirement.** A retried GRN or issue must **never** double‑post the ledger.

| Rule | Design |
|------|--------|
| Header | every POST that creates a stock/cost movement requires an `Idempotency-Key` header |
| Store | key + request‑hash persisted in `sys_idempotency` **[NEW `sys_` table]** with the resulting `*_no` |
| Replay | same key + same body → returns the original result (same `grn_no`), no new ledger row |
| Conflict | same key + different body → `409 Conflict` |
| Window | keys retained ≥ retry horizon; ties into Excel `source_row_hash` and offline‑scan replay |

### 11.7.4 Webhooks (outbound events)

- External subscribers register on `event_type` (the same taxonomy as `sys_event`).
- Delivery reuses the `notif_outbound` queue mechanics (queue + retry + signature), so events
  reach SAP/BI/3rd‑party the same reliable way alerts reach users.
- Payload is **signed** (HMAC over body) and carries `event_id` for subscriber‑side idempotency.

### 11.7.5 Versioning

| Aspect | Choice |
|--------|--------|
| Path version | `/api/v1/…`; breaking changes → `/v2` |
| Compatibility | additive fields only within a version; never repurpose a field |
| Deprecation | `Sunset` header + advance notice; old version runs in parallel |
| Contract | published OpenAPI 3 spec generated from the resource model above |

---

## 11.8 BI Integration (Power BI)

### 11.8.1 Read‑only semantic layer

BI **never** touches base transactional tables. A set of **read‑only reporting views /
materialized star schema** is the contract between UMMS and Power BI, isolating dashboards from
schema churn and from posting locks.

```
              dim_date ──┐
        dim_item ────────┤
        dim_asset ───────┤          ┌──────────────────────┐
        dim_supplier ────┼────────▶ │  fact_stock_movement  │  (grain: 1 mv_stock_ledger line)
        dim_location ────┤          │  qty, direction, value│
                         │          └──────────────────────┘
        dim_employee ────┤          ┌──────────────────────┐
        dim_cost_center ─┴────────▶ │  fact_job_cost        │  (grain: 1 cost_job_line)
                                    │  labour/material/     │
                                    │  outside/general cost │
                                    └──────────────────────┘
```

### 11.8.2 Fact / dimension mapping to canonical tables

| Star object | Sourced from | Grain / notes |
|-------------|--------------|---------------|
| `fact_stock_movement` | `mv_stock_ledger` (+ balance snapshot) | 1 row per ledger line; qty, `MVDIR` direction, MWAC value |
| `fact_job_cost` | `cost_job_line` / `cost_job_summary` | cost by element (labour/material/general/outside) per job card |
| `fact_lube_consumption` | `mv_stock_ledger` where `item_type=LUBRICANT` + `tx_lube_issue` meter | consumption per asset/site/date |
| `fact_battery_event` | `hist_battery_event` | serial lifecycle for MTBF/warranty analytics |
| `dim_item` | `md_item` (+category/group/uom) | type, category, group, serial/batch flags |
| `dim_asset` | `md_asset` (+vehicle/machine) | class, reg/plant no, make/model |
| `dim_supplier` | `md_supplier` | type (LOCAL/HEAD_OFFICE/SUBCONTRACTOR) |
| `dim_location` | `md_location` | SITE/STORE/BIN hierarchy |
| `dim_employee` | `md_employee` | technician, grade |
| `dim_cost_center` | `md_cost_center` / `md_department` / `md_project` | finance dimensions |
| `dim_date` | generated calendar | day/month/fiscal period |

### 11.8.3 Refresh strategy

| Layer | Strategy |
|-------|----------|
| Views | live views for small dims; **materialized** facts refreshed incrementally |
| Incremental key | `mv_stock_ledger` / `hist_battery_event` are append‑only → refresh by `created_at` watermark (append‑only = trivially incremental) |
| Cadence | facts refreshed on a schedule (e.g. 15‑min) or triggered by `sys_event` volume; dims on change |
| Power BI | import mode against the star views, or DirectQuery for near‑real‑time stock; row‑level security mirrors `sec_user_site` |
| Reconciliation | fact totals reconcile to `inv_stock_balance` and `cost_job_summary` as a nightly check |

---

## 11.9 Optional SAP Integration (future)

> **Stance:** UMMS is designed so a later SAP tie‑in is a *connector*, not a rebuild. Because
> every posting already emits `sys_event`, exposes REST, and keeps a clean master/ledger split,
> the SAP work is mapping + governance, not re‑plumbing.

### 11.9.1 Object mapping UMMS ↔ SAP

| UMMS object | SAP object (module) | Notes |
|-------------|---------------------|-------|
| `md_item` | Material master `MARA/MARC` (MM) | `item_type` → material type; UoM → base UoM |
| `md_supplier` | Vendor / Business Partner (MM) | supplier_type → account group |
| `md_asset` (vehicle/machine) | Equipment / Functional Location (PM) | asset_class → equipment category |
| `tx_grn` (GRN) | Goods Movement **MIGO** / `MSEG` (MM) | GRN post → 101 movement; MWAC ↔ SAP moving avg (V price) |
| `tx_issue` / job parts | Goods Issue **MIGO 261** to order (MM/PM) | issue to PM order = job card |
| `tx_job_outside_repair` | **Service Entry Sheet** (MM‑SRV) | subcontract repair confirmation |
| `tx_jobcard` | **PM Order** (Plant Maintenance) | tasks → operations; parts → components |
| `cost_job_summary` / `cost_job_line` | **Internal Order / Cost Center** (CO) | job cost settlement to CO object |
| `md_price_history` | Info record / condition (MM) | effective‑dated price ↔ condition validity |

### 11.9.2 Integration styles

| Style | Use for | Direction |
|-------|---------|-----------|
| OData / REST | master sync, on‑demand reads, low volume | both |
| BAPI / RFC | transactional posts (MIGO, PM order, service entry) | UMMS → SAP |
| IDoc | high‑volume async master + movement batches | both |
| Middleware (PI/PO, CPI, or an iPaaS) | routing, transformation, retry, monitoring | broker in the middle |

Recommended: **UMMS `sys_event`/webhooks → middleware → BAPI/IDoc → SAP**, so UMMS stays
provider‑agnostic (same pattern as the notification adapters).

### 11.9.3 Master‑data governance (system of record)

| Master | System of record (recommended) | Flow |
|--------|-------------------------------|------|
| Material / item | **SAP MM** (if SAP present) | SAP → UMMS via IDoc; `map_item_xref` holds SAP material ↔ `item_id` |
| Vendor | **SAP MM** | SAP → UMMS |
| Equipment / asset | **SAP PM** (fleet in PM) or UMMS | agree per rollout; xref in `map_asset_xref` |
| Cost center / internal order | **SAP CO** | SAP → UMMS |
| Battery serial register | **UMMS** (operational detail lives here) | UMMS → SAP as equipment/serial if needed |
| Stock balance & MWAC | dual: UMMS operational, SAP financial | reconcile via GRN/issue postings |

- The `map_*` xref family (contract §3.8) is the **crosswalk** carrying SAP keys ↔ UMMS `*_id`,
  so neither side's numbers are hard‑coded into the other.
- **One rule:** exactly one system of record per master; the other side is read‑only for that
  master and edits flow only from the owner.

---

## 11.10 Architecture Principles (so all of the above is achievable without rework)

| # | Principle | What it guarantees | Concrete anchor in UMMS |
|---|-----------|--------------------|-------------------------|
| 1 | **Event‑driven postings (transactional outbox)** | notifications, webhooks, BI refresh and SAP sync all hang off events with no dual‑write risk | every POST writes domain rows + `mv_stock_ledger`/`hist_battery_event` + `sys_event` in one txn |
| 2 | **API‑first** | Excel import, scanners, REST clients and SAP connectors are all just callers of the same POST endpoints | §11.7 resource model is the single write path |
| 3 | **Stateless services** | horizontal scale, safe retries, offline scan replay | no session state in the app tier; state lives in DB + queues |
| 4 | **Idempotent writes** | retries/replays never double‑post the ledger | `Idempotency-Key` + `sys_idempotency`; Excel `source_row_hash`; webhook `event_id` |
| 5 | **Audit everywhere** | full traceability for warranty, cost and stock disputes | contract audit block on every table; `apr_action`, `hist_battery_event`, `notif_outbound` logs, doc checksums |
| 6 | **Single source of truth / no parallel masters** | one item, supplier, asset, location list shared by all channels & SAP | canonical `md_*` (contract §2); `map_*` for external keys |
| 7 | **Append‑only ledgers** | trivially incremental BI, immutable financial trail | `mv_stock_ledger`, `hist_battery_event` never updated in place (contract §1.4) |
| 8 | **Read/write separation** | heavy exports & Power BI never lock postings | reporting views + star schema (§11.8); base tables only for transactional writes |
| 9 | **Provider‑agnostic adapters** | swap WhatsApp/email/SAP middleware vendors by config | channel adapters + `sys_setting`; `notif_outbound` queue |
| 10 | **Config over code** | new doc types, alerts, labels, templates without schema change | `sys_code`, `sys_setting`, `notif_rule`/`notif_template`, `sys_number_series` |
| 11 | **Polymorphic attachment & linkage** | any document can carry proof without new tables | `doc_attachment(source_doc_type, source_doc_id)` |
| 12 | **Versioned, backward‑compatible contracts** | integrations survive UMMS evolution | `/api/v1` + OpenAPI; additive‑only changes |

---

### New tables introduced by this section (all conform to contract prefixes + audit block)

| Table | Family | Purpose |
|-------|--------|---------|
| `doc_attachment` | `doc_` | single polymorphic attachment table: file metadata + checksum, attached to any source document |
| `sys_event` | `sys_` | transactional outbox — one row per state change |
| `sys_idempotency` | `sys_` | idempotency key ↔ result for safe retries |
| `notif_rule` | `notif_` (new subfamily under `sys_`) | event → condition → channel routing |
| `notif_template` | `notif_` | per‑channel message templates (in‑app/email/WhatsApp) |
| `notif_subscription` | `notif_` | per user/role opt‑in, quiet hours |
| `notif_outbound` | `notif_` | queued deliveries with retry/status/provider id |

> All other objects referenced here (`md_*`, `tx_*`, `mv_stock_ledger`, `inv_*`, `hist_battery_event`,
> `apr_*`, `stg_*`, `map_*`, `sys_number_series`, `sys_status`) are **reused as defined** in the
> design contract — no parallel names introduced.
