# 14 — Material Request: General vs Other item selection

**Problem.** A material request (MRN) must let a requester pick **common/general stock items from the
item master**, but type **rare, project-specific, or one-time items by hand**. It isn't practical to
maintain minimum stock, reorder level, and stock control for every item variation — only general items
get stock control; everything else is a typed, non-stock request that goes to purchase.

This is implemented in the platform's **Requisitions (MRN)** module (`app/routes/mrn.js`,
`app/public/app.js`) on `tx_mrn` / `txl_mrn`. The design below is also portable to Power Apps, an
Excel-based book, or any custom web app.

---

## 1. Core principle — the two-mode line

Every request line carries `item_source`, the single source of truth that drives UI, validation, stock
control, approval, and reporting.

| `item_source` | Chosen how | Stock-controlled? | Links to master? |
|---|---|---|---|
| **`GENERAL`** | Picked from item master | **Yes** — availability, min/reorder | `item_id → md_item` |
| **`OTHER`** | Typed free-text | **No** — bypasses stock | `item_id = NULL`, `item_description` text |

**A "general item" is a data rule, not a habit:** it's selectable only if
`md_item.is_active = TRUE AND md_item.is_stockable = TRUE`. Everything else is entered as **Other**.
`is_stockable` is precisely the flag that says "keep stock control for this item," so min/reorder/
availability naturally apply to general items only.

---

## 2. UI structure of the "Items Requested" section

A **repeating line grid**, one row per item, with a **per-line mode toggle**. Header fields (site,
job card, need-by date, priority) sit above the grid.

```
┌──────────────────────────── Items Requested ────────────────────────────┐
│  Type      Item                              Qty  Unit  Availability  Line │
│  ─────────────────────────────────────────────────────────────────────────│
│  General ▼ ▼ GN-0007 · Cotton Rag             20  NOS   🟢 145 avail  OPEN  │
│  General ▼ ▼ GN-0012 · Grease EP2 400g         6  NOS   🔴 2 avail    OPEN  │
│  Other   ▼ ✎ Hydraulic seal kit (Cat 320)      1  SET   — n/a —       P.PO  │
│            reason: seal failure, not stocked                               │
└───────────────────────────────────────────────────────────────────────────┘
```

- **General** → the Item cell is a **type-ahead master picker** filtered to `is_stockable`; unit
  auto-fills from `md_item.base_uom_id` and is locked; an **availability badge** is shown.
- **Other** → the Item cell is a **free-text description**; unit becomes a **dropdown** (`md_uom`);
  **reason is mandatory**; availability shows "n/a".
- Switching the toggle re-renders the row's editor and clears the previous mode's fields.

---

## 3. Field-level design

### General line
| Field | Control | Source | Required |
|---|---|---|---|
| Type | Segmented | `GENERAL` | ✔ |
| Item | Type-ahead select | `md_item` where `is_stockable & is_active` | ✔ |
| Quantity | Numeric > 0 | — | ✔ |
| Unit | Read-only | `md_item.base_uom_id` | auto |
| Availability | Read-only badge | `inv_stock_balance` at the requesting store | auto |
| Reason | Text | optional | ✖ |

### Other line
| Field | Control | Column | Required |
|---|---|---|---|
| Type | Segmented | `OTHER` | ✔ |
| Description | Free text ≤200 | `item_description` | ✔ |
| Quantity | Numeric > 0 | `requested_qty` | ✔ |
| Unit | Dropdown (`md_uom`) | `uom_id` | ✔ |
| Reason / justification | Text ≤300 | `request_reason` | ✔ |
| Suggested category | Dropdown (`md_item_category`) | `suggested_category_id` | recommended |
| Est. unit price | Numeric | `est_unit_price` | ✖ |

---

## 4. Validation rules

**Both** — quantity > 0, numeric; at least one valid line.

**General** — `item_id` resolves to an active, **stockable** master item; unit locked to base UoM;
availability is **advisory only** (never blocks a request — reorder handles shortage).

**Other** — description ≥ 3 chars; unit required; **reason required**; description **must not match** an
existing stockable item (see §9).

**DB-level guarantee** (a bad row can't exist, even via import/API):
```sql
CONSTRAINT ck_txl_mrn_source CHECK (
    (item_source = 'GENERAL' AND item_id IS NOT NULL AND item_description IS NULL)
 OR (item_source = 'OTHER'   AND item_id IS NULL AND item_description IS NOT NULL AND request_reason IS NOT NULL)
)
```

---

## 5. Approval & review workflow implications

- **General-only** requests take the fast path (availability → issue, or shortage → reorder/PO).
- **Any `OTHER` line raises the review level** — a Stores/Procurement reviewer must, per Other line:
  approve as a **one-time buy** (PO, no master record), **promote to master** (create `md_item`, and the
  line converts to `GENERAL`), or **reject / redirect** to an existing general item.
- **Segregation of duties:** raising is `STORES.MRN`; approving/promoting should be a higher role
  (catalogue owner) — self-approval of one's own Other lines is prohibited.
- **Status vocabulary:** header `DRAFT → APPROVED → PARTIAL → CLOSED` (`CANCELLED`); an Other line sits
  at `PENDING_PO` until purchasing lands, so an MRN with Other lines settles at `PARTIAL`.

---

## 6. Stock control — general items only

For `md_item` rows with `is_stockable = TRUE`:

- **Availability** = `inv_stock_balance.available_qty` (a stored generated column = `on_hand − reserved`).
- **Reorder** when `available_qty ≤ md_item.reorder_level` → suggest a PO of `reorder_qty`.
- **Minimum breach** when `available_qty < md_item.min_qty` → priority replenishment.
- Fulfilment issues the general line at **MWAC** and links the issue back (`tx_issue.mrn_id`).

Other items touch none of this — no balance row, no reorder scan, no valuation — so you never maintain
min levels for the thousands of rare variations.

| Signal | Formula (general/stockable only) | Shown |
|---|---|---|
| Availability | `available_qty` at the store | line badge (🟢/🟡/🔴) |
| Below reorder | `available_qty ≤ reorder_level` | replenishment worklist |
| Below minimum | `available_qty < min_qty` | urgent replenishment |
| Suggested order | `reorder_qty` | PO draft |

---

## 7. How "Other" items bypass stock but stay disciplined

- **Bypass:** no availability check, no reorder/min, no reservation, no ledger post.
- **Still mandatory:** description + quantity + unit + reason (DB-enforced).
- **Fulfilment path:** Other lines are **not** issued from stock — they become a purchase / direct-charge
  to the job or project, and only enter inventory valuation if **promoted** to master first.

---

## 8. Clean reporting — separate stocked vs non-stock

`item_source` splits every report:
- **Stocked general** (`WHERE item_source='GENERAL'`) — consumption, stock turns, reorder performance,
  min-level compliance.
- **Non-stock / typed** (`WHERE item_source='OTHER'`) — off-catalogue spend, one-time buys, "Other %"
  per site/project/requester.
- **Promotion candidates** — recurring typed descriptions → recommend adding to master.
- Never mix them in a stock report.

---

## 9. Audit controls against "Other" overuse

- **Exact-match block** — a typed description equal to an active stockable `item_name`/`item_no` is
  rejected: *"…already exists as general item GN-0007. Please select it instead of typing it."*
  (implemented in `masterClash()`).
- **Fuzzy-match warning** at type-time — suggest the near-match with a one-click switch.
- **Duplicate-typed detection** — normalise + count; a description typed ≥ N times raises a
  "promote to master" task.
- **Requester scorecard** — % of lines that are Other, per requester/site/month; outliers get reviewed.
- **Reason mandatory** on every Other line (friction by design).
- **Promotion loop** — when an Other item is promoted, store `promoted_item_id` so future identical
  requests auto-suggest the new general item.

---

## 10. Database structure

Grounded in the platform schema (`sql/schema.sql`).

**Item master (`md_item`)** — one master for stock + non-stock definitions:
```
item_id (PK), item_no (UNIQUE), item_name, item_type,
is_stockable BOOLEAN,                       -- TRUE = selectable as General, stock-controlled
base_uom_id (FK md_uom),
reorder_level, reorder_qty, min_qty, max_qty,  -- meaningful ONLY when is_stockable
is_active
```

**Stock balances (general items only) — `inv_stock_balance`:**
```
item_id, location_id, on_hand_qty, reserved_qty,
available_qty  = on_hand_qty - reserved_qty,   -- generated/stored
moving_avg_cost, stock_value
```

**Request header — `tx_mrn`:** `mrn_id, mrn_no, mrn_date, location_id (requesting store), jobcard_id,
required_date, priority, doc_status, requested_by, approved_by, site_id`.

**Request line — `txl_mrn` (the two-mode line):**
```
mrn_line_id (PK), mrn_id (FK), line_no,
item_source            VARCHAR(10)  -- GENERAL | OTHER
item_id                (FK md_item, NULL for OTHER)
item_description        VARCHAR(200) -- OTHER only
request_reason          VARCHAR(300) -- OTHER only (required)
suggested_category_id   (FK md_item_category)
est_unit_price          NUMERIC(18,4)
promoted_item_id        (FK md_item) -- set when an OTHER item is added to the master
uom_id (FK md_uom), requested_qty, approved_qty, issued_qty, po_qty,
line_status  VARCHAR(15)  -- OPEN | PARTIAL | CLOSED | PENDING_PO | ...
+ CHECK ck_txl_mrn_source (see §4)
```

**Non-stock catalogue / promotion staging (optional) — `stg_other_item`:** `normalized_desc (UNIQUE),
times_requested, first_seen, last_seen, suggested_category_id, promoted_item_id`. Derivable from
`txl_mrn WHERE item_source='OTHER'`; materialise it to make the promotion worklist fast.

---

## 11. Dropdowns, labels, error messages

- **Type toggle:** `General item (from stock list)` · `Other item (type manually)`
- **Priority:** `Normal · Urgent · Breakdown`
- **Unit (Other):** `NOS · SET · PKT · LTR · KG · M · ROLL · PAIR · BOX`
- **Category (Other):** the `md_item_category` list.
- **Errors:**
  - `Select a general item or switch to "Other item".`
  - `Quantity must be greater than zero.`
  - `Only 2 available (below minimum) — this will trigger reordering.`
  - `Describe the other item (at least 3 characters).`
  - `Unit is required for an other item.`
  - `A reason is required for an other item.`
  - **(block)** `"Cotton Rag" already exists as general item GN-0007. Please select it instead of typing it.`

---

## 12. Process flow

```
Raise MRN
  └ per line: General or Other?
     ├ GENERAL → validate vs master (stockable) → show availability
     │            ├ in stock            → approve → ISSUE at MWAC → update balance/reservation
     │            └ short/below reorder → approve → raise PO (reorder_qty) → GRN → issue
     └ OTHER   → require desc+qty+unit+reason → exact-match block / fuzzy warn
                  → REVIEW → one-time buy (PO) | promote to master (→ GENERAL) | reject
Header: CLOSED when every line settled; PARTIAL while any general line is short or any Other line
is still PENDING_PO.
```

---

## 13. Business rules

- A line is **General** only if it maps to an **active, stockable** master item; everything else is **Other**.
- **Stock control (min/reorder/availability/reservation) applies to general items only.**
- Requesting is never hard-blocked by availability — shortage drives **reorder**, not rejection.
- **Other** lines always require **description + quantity + unit + reason** (DB-enforced).
- **You cannot type an item that already exists as a general item.**
- Any **Other** line escalates approval; self-approval of Other lines is prohibited.
- **Other** fulfils via **purchase/direct-charge**, never a stock issue, unless promoted to master first.
- Reporting is split by `item_source`; stock KPIs use general only.
- Recurring typed items are surfaced for **promotion to master** — Other is a funnel, not a dumping ground.

---

## 14. Platform notes

- **This UMMS app:** implemented — `txl_mrn.item_source` + the mode fields; `routes/mrn.js` branches
  create/approve/fulfil (general → `postIssue` at MWAC; other → `PENDING_PO`); the New-MRN form has the
  per-line General/Other toggle + master picker; `masterClash()` is the exact-match block. Verified in the
  end-to-end suite (`npm run smoke`) on both PostgreSQL and SQLite.
- **Power Apps / Dataverse:** header + line tables; `item_source` = a Choice column driving
  `Visible`/`Required`; General picker = a Lookup filtered `is_stockable`; availability = a related field;
  the exact-match block = a form rule on the description.
- **Excel:** a `Requests` sheet + a `Lines` sheet with an `Item_Source` column; Data-Validation dropdown
  (General from a filtered `Master` sheet) vs free text (Other); `VLOOKUP` availability from a `Balances`
  sheet; a helper column flags "typed item matches master."
