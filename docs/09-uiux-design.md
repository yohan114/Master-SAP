# UMMS — UI/UX Design Direction (09)

> **Scope of this document:** the visual & interaction blueprint for the UMMS web client — a single
> "workshop + fleet + stores command center" spanning Stores, Lubricant, Battery and Workshop.
> It defines design language, layout skeleton, the component inventory, semantic color/status tokens,
> annotated ASCII wireframes for the key screens, and interaction/accessibility rules.
> **This drives a real HTML prototype**, so every token, grid and status color below is meant to be
> lifted directly.
>
> Naming, statuses, numbering and valuation are governed by **`00-design-contract.md`** — this
> document does **not** redefine them; it *renders* them. Every status chip here maps to a
> `sys_status.status_group` value; every screen surfaces real transactions (`tx_grn`, `tx_lube_issue`,
> `tx_battery_issue`, `tx_jobcard`, `mv_stock_ledger`, `inv_pending_price`, `apr_request` …).

---

## 1. Design Language

### 1.1 Product personality

| Trait | What it means in UMMS | How it shows up |
|-------|-----------------------|-----------------|
| **Command center, not a form dump** | One operator watches 4 stock books + a workshop across sites | Dense dashboards, alert banners, live queues top-of-fold |
| **Fast for clerks** | GRN / issue / labour clerks enter 50–200 lines a day | Keyboard-first line grids, sticky headers, no modal-per-field |
| **Clear for managers** | TM/OM approve, read KPIs, drill to cause | Big KPI cards, plain-language status chips, one-click drill-down |
| **Traceable by design** | Every qty/cost must trace to a document + ledger row | "Open ledger", "Open source doc", "Open job" links everywhere |
| **Trustworthy** | Stock value & job cost are financial data | Reversals confirmed, audit stamps visible, no silent edits |

### 1.2 Density & rhythm

| Property | Value | Rationale |
|----------|-------|-----------|
| Base font | 14px / 1.45 line-height | Comfortable for long grids |
| Grid row height | **36px "comfortable"**, 30px "compact" toggle | Clerks favour compact; managers comfortable |
| Base spacing unit | 4px (scale: 4/8/12/16/24/32) | Consistent gutters |
| Corner radius | 8px cards, 6px inputs/chips, 4px table cells | Soft, modern, not toy-round |
| Max content width | Fluid; data grids full-bleed, forms capped at 1280px | Grids need width, forms need focus |
| Elevation | 3 levels: flat (grid), raised (card `0 1px 2px`), floating (drawer/modal `0 8px 24px`) | Clear layering |

### 1.3 Theme support

- **Both light & dark are first-class.** Default follows OS (`prefers-color-scheme`); user can pin a theme in the top-bar user menu (persisted on `sec_user`).
- Theme is a token swap only — **no layout, spacing or component geometry changes** between themes.
- Data-viz palette is theme-aware (see §4.3); status chip *hues* stay constant, only their surface/opacity adapt so DRAFT-gray reads as gray in both themes.

### 1.4 Responsive tiers

| Tier | Width | Behaviour |
|------|-------|-----------|
| **XL desktop** | ≥1440px | Sidebar expanded, multi-column dashboards, side-drawer opens beside grid |
| **Desktop** | 1024–1439px | Sidebar expanded, 2-col dashboards, drawer overlays |
| **Tablet** | 768–1023px | Sidebar **collapsed to icon rail**, dashboards single-col, grids scroll-x |
| **Mobile** | <768px | Sidebar → off-canvas hamburger; **grids become stacked cards** (§10); forms single-column; approvals & job progress fully usable for shop-floor / on-site use |

---

## 2. Layout System

### 2.1 App shell

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ TOP BAR  (fixed, 56px)                                                                  │
│ [☰] UMMS◇  | 🔍 Global search…            | 🏢 Site: CMB ▾ | 🔔 12 | ⚙ | (JD) Jane ▾ |  │
├───────────────┬──────────────────────────────────────────────────────────────────────┤
│ LEFT SIDEBAR  │  BREADCRUMB:  Workshop  ›  Job Cards  ›  JC-CMB-26-000502               │
│ (fixed 248px, │ ┌──────────────────────────────────────────────────────────────────┐  │
│  scrolls      │ │                                                                    │  │
│  independently│ │                  MAIN CONTENT REGION                               │  │
│  of content)  │ │  (page title + primary actions row, then content)                 │  │
│               │ │                                                                    │  │
│  [nav tree]   │ │                                                                    │  │
│               │ └──────────────────────────────────────────────────────────────────┘  │
│               │  RIGHT DRAWER (record detail) slides in here, 420–520px, over content  │
└───────────────┴──────────────────────────────────────────────────────────────────────┘
```

### 2.2 Top bar contents

| Slot | Element | Behaviour |
|------|---------|-----------|
| Left | Sidebar toggle `☰` + product mark **UMMS** | Collapses sidebar to 64px icon rail |
| Center | **Global search** (`/` to focus) | Federated: doc no (`GRN-CMB-26-…`), item code, asset reg no, battery serial, job no. Grouped results with type icon; Enter → best match, ↓ to pick |
| Right 1 | **Site switcher** `🏢 Site: CMB ▾` | Bound to `sec_user_site`; changes row-level scope (`site_id`) of every list; "All my sites" option for multi-site managers |
| Right 2 | **Notifications** `🔔 badge` | Approval requests assigned to me, price-pending nudges, low-stock & overdue-job alerts; opens a panel grouped by type |
| Right 3 | Settings `⚙` | Density toggle, theme, table defaults |
| Right 4 | **User menu** `(JD) Jane ▾` | Profile, role badges, theme pin, sign out |

### 2.3 Full sidebar menu tree

> Grouped by module. Each leaf = a route. Items hidden unless `sec_role_permission` grants them.
> Module headers are collapsible; active leaf gets a left accent bar in `--primary`.

```
▸ DASHBOARDS
    • Executive Command Center
    • Stores Overview
    • Lubricant Overview
    • Battery Overview
    • Workshop Overview

▸ STORES
    • Material Requests (MRN)          → tx_mrn
    • Purchase Orders (PO)             → tx_po
    • Goods Receipts (GRN)             → tx_grn
    • Issues                           → tx_issue
    • Transfers                        → tx_transfer
    • Adjustments / Stock Count        → tx_adjustment
    • Returns                          → tx_return
    • Stock Balances                   → inv_stock_balance
    • Pending Price Queue              → inv_pending_price
    • Stock Ledger                     → mv_stock_ledger

▸ LUBRICANT
    • Lubricant Dashboard
    • Lubricant Issues                 → tx_lube_issue
    • Consumption by Asset / Site
    • Monthly Balance (Stock Book)     → inv_lube_monthly_balance
    • Days-of-Cover Watchlist

▸ BATTERY
    • Battery Register (Serials)       → md_battery
    • Issue to Asset                   → tx_battery_issue
    • Battery Transfer                 → tx_battery_transfer
    • Return / Warranty / Scrap        → tx_battery_return
    • Lifecycle Log                    → hist_battery_event
    • Warranty Watch

▸ WORKSHOP
    • Job Card Board (Kanban)          → tx_jobcard
    • New Job Card
    • Job Material Requests (MRQ)      → tx_job_material_req
    • Labour Sheets (LAB)             → tx_job_labour
    • Outside Repairs (OSR)           → tx_job_outside_repair
    • Job Costing                      → cost_job_summary
    • Cost Variance                    → cost_variance

▸ APPROVALS
    • My Approval Queue                → apr_request / apr_step
    • Delegations
    • Approval History                 → apr_action

▸ MASTERS
    • Items                            → md_item
    • Item Categories / Groups
    • Assets (Fleet & Plant)           → md_asset
    • Batteries                        → md_battery
    • Suppliers                        → md_supplier
    • Employees / Technicians          → md_employee
    • Locations / Sites / Bins         → md_location
    • Prices & Price History           → md_price / md_price_history
    • Labour Rates                     → md_labour_rate
    • Warranty Terms                   → md_warranty_term
    • UoM & Conversions                → md_uom

▸ REPORTS
    • Stock Valuation
    • Fast / Slow Moving
    • Lubricant Consumption
    • Battery Life & Warranty
    • Job Cost & Profitability
    • Approval SLA / Ageing
    • Custom / Saved Views

▸ ADMIN
    • Users & Roles                    → sec_user / sec_role
    • Site Access                      → sec_user_site
    • Number Series                    → sys_number_series
    • Status & Codes                   → sys_status / sys_code
    • Workflow Designer                → sys_workflow / sys_workflow_step
    • Settings                         → sys_setting
    • Migration Console                → stg_* / map_*
```

### 2.4 Content region anatomy

Every page follows the same top-to-bottom rhythm:

```
Breadcrumb (module › entity › record)
Page title  ─────────────────────────────  [ Primary action ]  [ ⋯ secondary ]
Filter / summary strip  (chips, saved views, KPI mini-row)
Content (grid | form | dashboard | detail)
```

---

## 3. Component Inventory

| # | Component | Purpose | Used on |
|---|-----------|---------|---------|
| C1 | **KPI / stat card** | One headline number + delta + spark + drill link | All dashboards |
| C2 | **Alert banner** | Cross-cutting warnings (low stock, price-pending, overdue jobs, failed QC) | Dashboards, list headers |
| C3 | **Status chip** | Render `*_status` with semantic color + label | Everywhere a document/serial/battery/job appears |
| C4 | **Data grid** | Sortable, filterable, column-chooser, density toggle, CSV/XLSX export, saved views, row-select, inline row actions | Stores/Lube/Battery/Workshop lists, ledger |
| C5 | **Searchable server-filtered table** | Server-side paging + filter for large sets (`mv_stock_ledger`, `hist_battery_event`) | Ledger & history viewers |
| C6 | **Approval-queue list item** | Doc summary + requester + age + Approve/Reject/Return inline | My Approval Queue, notifications |
| C7 | **Job progress panel / timeline** | Vertical event timeline of `tx_job_progress` + status transitions | Job Card cockpit |
| C8 | **Movement-log / ledger viewer** | Append-only rows with running balance + MWAC, direction chips | Item detail, Stock Ledger, battery lifecycle |
| C9 | **Trend chart (line/area)** | Time series (stock value, consumption, job throughput) | Dashboards, item/asset detail |
| C10 | **Donut / bar (stock mix)** | Composition (value by category, batteries by status, jobs by state) | Dashboards |
| C11 | **Quick-action buttons** | Context primary + overflow (New GRN, Post, Reverse, Approve) | Page headers, drawers, grid rows |
| C12 | **Drawer / side-panel** | Peek a record without leaving the list | All lists |
| C13 | **Drill-down page** | Full record page with tabs | Job card, item, asset, battery |
| C14 | **Header + line-grid form** | Document entry: header card on top, editable line grid below, totals footer | GRN, Issue, MRN, PO, Lube issue, MRQ, Labour, Adjustment |
| C15 | **Filter chip bar / saved views** | Persistent filters + named views (`My site — Low stock`) | All lists |
| C16 | **Empty / loading / error states** | Skeletons, empty illustrations w/ primary action, retry errors | Every data region |

### 3.1 Component detail notes

**C1 KPI card** — layout: label (top, muted) · big value · delta pill (▲/▼ vs prior period, green/red) · optional sparkline · footer drill link ("View 14 low-stock items →"). Value color stays neutral; only the delta and any threshold badge carry semantic color.

**C2 Alert banner** — full-width, left status stripe + icon + message + inline action(s) + dismiss. Severity uses `--warning` (attention), `--danger` (breach), `--info` (FYI). Stacks max 3; extras collapse into "+2 more".

**C3 Status chip** — pill: colored 10–14% tint background, solid text/border in the hue, dot on the left. Label is the exact `sys_status` code humanized (e.g. `PENDING_TM_APPROVAL` → "Pending TM"). Never color-only — always dot + text for accessibility.

**C4 Data grid** — features row above the grid: search box · filter chips · column chooser (⚙) · density · export · saved-view dropdown. Sticky header + sticky first column (doc no). Row hover reveals a right-aligned action cluster (👁 drawer · ✎ edit · ⋯ menu). Multi-select → bulk bar (approve, export, print).

**C6 Approval-queue item** — two-line card: line 1 = doc-type icon · doc no · title/asset · amount · age badge (green<4h / amber<24h / red≥SLA); line 2 = requester · site · current step (`PENDING_OM_APPROVAL`) · inline **[Approve] [Return] [Reject]**. Expander reveals the document line grid inline.

**C7 Job progress timeline** — vertical rail; each node = a `tx_job_progress` entry or status transition, with timestamp, actor, note, and % complete. Status-transition nodes carry the destination status chip.

**C8 Ledger viewer** — append-only, newest-first toggle; columns: date/time · doc no (link) · direction chip (`IN`/`OUT`/`XFER_*`/`ADJ_*`/`RET_*`) · qty · unit cost · value · **running on-hand** · **running MWAC**. Reversal rows shown struck-through-linked to their origin. No edit affordance — it is immutable.

**C11 Quick actions** — primary is filled `--primary`; destructive (Reverse/Void/Reject) is outline `--danger` and always confirmed (§9.6).

**C12 Drawer** — 420–520px, header (doc no + status chip + close), scrollable body (summary → lines → audit stamps), sticky footer actions. "Open full record ↗" promotes to the C13 page.

---

## 4. Color & Status Tokens

### 4.1 Semantic base tokens

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--bg` | `#F4F6F8` | `#0E1116` | App background |
| `--surface` | `#FFFFFF` | `#161B22` | Cards, grids, drawers |
| `--surface-2` | `#F0F2F5` | `#1E252E` | Subtle rows, headers, wells |
| `--border` | `#DCE1E7` | `#2A323C` | Dividers, grid lines |
| `--text` | `#1B2733` | `#E6EDF3` | Primary text |
| `--text-muted` | `#5C6B7A` | `#93A1B0` | Labels, secondary |
| `--primary` | `#1F6FEB` | `#4C8DFF` | Brand, primary actions, active nav |
| `--primary-weak` | `#E7F0FF` | `#12233F` | Primary tint fills |
| `--success` | `#1F9254` | `#3FB971` | Posted/closed, positive delta |
| `--warning` | `#B7791F` | `#E3A008` | Attention, pending, ageing |
| `--danger` | `#C0392B` | `#F0533F` | Rejected, overdue, breach, destructive |
| `--info` | `#2C7BE5` | `#5AA2FF` | Neutral info, approved-in-flight |
| `--focus-ring` | `#1F6FEB` @ 3px | `#4C8DFF` @ 3px | Keyboard focus outline |

### 4.2 Status chip color map (drives every C3 chip)

| Status group value | Chip semantic | Light hue | Dark hue | Applies to |
|--------------------|---------------|-----------|----------|------------|
| `DRAFT` | **Gray** | `#6B7684` | `#8B96A4` | DOC, GRN, JOBCARD draft |
| `SUBMITTED` / `RECEIVED` / `PENDING*` / `QC_PENDING` / `PROVISIONAL` | **Amber** | `#B7791F` | `#E3A008` | pending approval / receipt / price |
| `APPROVED` / `QC_PASSED` / `PRICED` / `ASSIGNED_WORKSHOP` / `IN_PROGRESS` | **Blue** | `#1F6FEB` | `#4C8DFF` | in-flight / accepted |
| `POSTED` / `CLOSED` / `CONFIRMED` / `WORK_COMPLETED` / `QC` clean | **Green** | `#1F9254` | `#3FB971` | done / financially settled |
| `REJECTED` / `QC_FAILED` / `OVERDUE` / `CANCELLED` / `LOST` | **Red** | `#C0392B` | `#F0533F` | failed / breach |
| `ON_HOLD` / `RETURNED` / `AWAITING_PARTS` / `AWAITING_OUTSIDE_REPAIR` | **Purple** | `#7C4DC4` | `#A882E8` | paused / blocked / re-entrant wait |
| `ESCALATED` / `DELEGATED` | **Teal** | `#0F8B8D` | `#3CC7C9` | routed sideways |

**Battery lifecycle mapping (`BATTERY` group):**

| Battery status | Chip | Reasoning |
|----------------|------|-----------|
| `IN_STOCK` | Gray | Idle inventory |
| `ISSUED` / `IN_SERVICE` | Blue | Active in field |
| `TRANSFERRED` | Teal | Moved between assets |
| `RETURNED` / `UNDER_WARRANTY_CLAIM` | Purple | Held / in claim |
| `REPAIRED` / `REPLACED` | Green | Restored |
| `SCRAPPED` / `LOST` | Red | End of life |

**Stock direction (`MVDIR`) mini-tags in ledger:** `IN`/`XFER_IN`/`ADJ_IN`/`RET_IN` → green up-arrow; `OUT`/`XFER_OUT`/`ADJ_OUT`/`RET_OUT` → red down-arrow.

### 4.3 Data-viz palette (theme-aware, ≥3:1 adjacent contrast)

| Series slot | Light | Dark |
|-------------|-------|------|
| Series 1 | `#1F6FEB` | `#4C8DFF` |
| Series 2 | `#1F9254` | `#3FB971` |
| Series 3 | `#B7791F` | `#E3A008` |
| Series 4 | `#7C4DC4` | `#A882E8` |
| Series 5 | `#0F8B8D` | `#3CC7C9` |
| Series 6 | `#C0392B` | `#F0533F` |

Sequential (stock value heat) uses a single-hue `--primary` ramp; diverging (variance +/−) uses green↔red through a neutral mid.

---

## 5. Screen — Executive Command Center

> Route: Dashboards › Executive Command Center. Audience: OM / TM / GM. Scope respects site switcher.

```
Workshop  ›  Dashboards  ›  Executive Command Center
Executive Command Center                         Site: [All my sites ▾]  [Period: Jul-26 ▾]  [⟳]

┌── ALERT BANNER ───────────────────────────────────────────────────────────────────────┐
│ ⚠  14 items below reorder · 6 GRN lines awaiting price (LKR 1.2M unvalued) · 3 jobs     │
│    overdue · 2 batteries warranty-expiring 30d      [Review price queue]  [View jobs] ✕ │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌ KPI ROW ───────────────────────────────────────────────────────────────────────────────┐
│ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌────────────┐ │
│ │ STOCK VALUE   │ │ OPEN JOBS     │ │ PENDING       │ │ LUBE DAYS-COVER│ │ BATTERIES  │ │
│ │ LKR 48.6M     │ │ 37            │ │ APPROVALS     │ │ 9 days ⚠       │ │ IN SERVICE │ │
│ │ ▲ 2.1% ~~~~/  │ │ ▼ 4  ~~\_/~   │ │ 12  (3 SLA!)  │ │ 2 SKUs <5d     │ │ 128        │ │
│ │ Ledger →      │ │ Board →       │ │ My queue →    │ │ Watchlist →    │ │ Register → │ │
│ └───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘ └────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌ CHARTS (2-col) ───────────────────────────────┐ ┌ QUEUES (right rail) ──────────────────┐
│ Stock Value Trend (6 mo)      [Value ▾]        │ │ MY APPROVAL QUEUE                (12)  │
│  ▁▂▃▄▅▆  area, --primary                       │ │ • JC-CMB-26-000502  Engine OH  2.1M   │
│                                                │ │   Pending OM · 5h  [✔][⤺][✖]  🔴SLA   │
│ Job Throughput (created vs closed)  bar×2      │ │ • GRN-CMB-26-000210  Filters  0.4M    │
│  ▉▉ created  ▉ closed                          │ │   Pending TM · 1h  [✔][⤺][✖]          │
├────────────────────────────────────────────────┤ │ • MRQ-KND-26-000488 Brake job  …      │
│ Stock Mix by Category   donut                  │ ├───────────────────────────────────────┤
│  ◔ Spares 42% · Lube 18% · Battery 12% · …     │ │ OVERDUE JOBS                     (3)  │
│                                                │ │ • JC-CMB-26-000471  9d in AWAITING_    │
│ Jobs by Status   stacked bar                   │ │   PARTS  🟣   [Open]                   │
│  DRAFT▉ PENDING▉ IN_PROGRESS▉ COMPLETED▉       │ │ • JC-KND-26-000455  overdue 2d 🔴      │
└────────────────────────────────────────────────┘ └───────────────────────────────────────┘
```

**Data sources:** Stock value = Σ `inv_stock_balance.on_hand_qty × moving_avg_cost`; Pending approvals = `apr_step` where approver = me & state `PENDING`; Price-pending = `inv_pending_price`; Lube days-cover = on-hand ÷ avg daily `mv_stock_ledger OUT` (item_type LUBRICANT); Jobs = `tx_jobcard` by `jobcard_status`.

---

## 6. Screen — Stores Stock List (with alerts)

> Route: Stores › Stock Balances. Reads `inv_stock_balance` joined `md_item`.

```
Stores  ›  Stock Balances
Stock Balances                                                   [+ New Issue] [+ New GRN ▾]

[🔍 Search item/code]  Views:(All)(★Low stock)(★My fast-movers)  Filters:[Category ▾][Below ROL ✓][Stockable ✓]  ⚙ 📤

┌─ Banner ───────────────────────────────────────────────────────────────────────────────┐
│ ⚠ 14 items at/below reorder level · 3 negative-on-hand (investigate)   [Create MRN]     │
└─────────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────┬───────────────────────┬────────┬─────────┬────────┬──────────┬───────────┐
│ ITEM CODE ▲  │ DESCRIPTION           │ UoM    │ ON HAND │ ROL    │ MWAC     │ VALUE     │
├──────────────┼───────────────────────┼────────┼─────────┼────────┼──────────┼───────────┤
│ SPR-00231    │ Oil Filter DENSO …    │ EA     │   4 🔴  │  10    │  1,250.00│  5,000.00 │
│ SPR-00988    │ Brake Pad Set FR      │ SET    │  12 🟠  │  12    │  8,400.00│100,800.00 │
│ LUB-15W40    │ Engine Oil 15W-40     │ L      │ 210 🟢  │  80    │    920.00│193,200.00 │
│ BAT-N200     │ Battery N200 (model)  │ EA     │   6 🟢  │   4    │ 22,500.00│135,000.00 │
│ SPR-01120    │ Coolant Hose          │ EA     │  −2 🔴  │   5    │    640.00│ −1,280.00 │
├──────────────┴───────────────────────┴────────┴─────────┴────────┴──────────┴───────────┤
│  Showing 1–25 of 842   ‹ 1 2 3 … ›            On-hand chip: 🔴 ≤ROL/neg 🟠 =ROL 🟢 ok    │
└─────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ row hover →  [👁 drawer] [Ledger] [Create MRN] [⋯]
```

**Row → drawer (C12):** item header + on-hand by location, last 10 `mv_stock_ledger` rows (C8), open MRNs/POs, price history link. **Quick actions:** Create MRN, New Issue, Open ledger, Adjust.

---

## 7. Screen — GRN Entry Form (header + line grid)

> Route: Stores › Goods Receipts › New. Writes `tx_grn`/`txl_grn`; on Post → `mv_stock_ledger IN` + MWAC recalc; un-priced lines → `inv_pending_price`. Follows the **C14** pattern.

```
Stores  ›  Goods Receipts  ›  New GRN                                    Status: [● DRAFT]
New Goods Receipt Note                             [Save Draft]  [Post & Receive]  [⋯ Cancel]

┌ HEADER ────────────────────────────────────────────────────────────────────────────────┐
│ GRN No     [ auto: GRN-CMB-26-000211 ]      GRN Date   [09-Jul-2026 ▦]                    │
│ Supplier   [ Lanka Filters (Pvt) Ltd  ▾ ]   Against PO [ PO-HO0-26-000045 ▾ ] (optional)  │
│ Site/Store [ CMB · Main Store ▾ ]           Invoice No [ INV-88213 ]  Inv Date [ ▦ ]      │
│ QC Required [✓]                             Remarks    [ … ]                              │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌ LINES ─── [+ Add line] [⌫ Remove] [Import from PO]  (Tab/Enter to move · Alt+↓ dup row) ─┐
│ # │ ITEM (code/desc)      │ ORD │ RECV │ UoM │ UNIT PRICE │  LINE AMT  │ BIN   │ PRICE?  │
│ 1 │ SPR-00231 Oil Filter  │ 100 │ 100  │ EA  │   1,250.00 │ 125,000.00 │ A-12  │ ✓ known │
│ 2 │ SPR-00988 Brake Pad   │  20 │  18  │ SET │      —     │      —     │ A-03  │ ⏳ pend  │
│ 3 │ [type code / scan…]   │     │      │     │            │            │       │         │
├───┴───────────────────────┴─────┴──────┴─────┴────────────┴────────────┴───────┴─────────┤
│  Lines: 2   Received value: LKR 125,000.00   Pending-price lines: 1   ⚠ will queue        │
└─────────────────────────────────────────────────────────────────────────────────────────┘
  Inline validation: RECV>ORD → amber warn; price blank → line flagged ⏳ (received at last-known,
  queued to inv_pending_price); item not stockable → block.
```

**Post effect (status map):** `DRAFT → RECEIVED → QC_PENDING`(if QC) `→ QC_PASSED → PRICED/PARTIAL → POSTED`. Each priced line: `mv_stock_ledger` `IN` + `inv_stock_balance` MWAC update. Un-priced (line 2): received at provisional cost, `inv_pending_price` row created, GRN carries `PARTIAL` price state until confirmed.

---

## 8. Screen — Lubricant Dashboard

> Route: Lubricant › Lubricant Dashboard. Reads `mv_stock_ledger` (LUBRICANT), `inv_stock_balance`, `tx_lube_issue`, `inv_lube_monthly_balance`.

```
Lubricant  ›  Lubricant Dashboard
Lubricant Dashboard                              Site:[CMB ▾]  Period:[Jul-26 ▾]  [+ Lube Issue]

┌ KPI ─────────────────────────────────────────────────────────────────────────────────────┐
│ ┌ ON-HAND VALUE ┐ ┌ CONSUMED (MTD) ┐ ┌ CRITICAL SKUs ┐ ┌ AVG DAYS-COVER ┐ ┌ TOP ASSET ┐  │
│ │ LKR 1.94M     │ │ 3,120 L        │ │ 2  🔴          │ │ 11 days        │ │ WP-1123   │  │
│ │ 8 SKUs        │ │ ▲ vs Jun 6%    │ │ <5 days cover  │ │ ~~\_/~         │ │ 640 L MTD │  │
│ └───────────────┘ └────────────────┘ └────────────────┘ └────────────────┘ └───────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────────┘

┌ CRITICAL STOCK / DAYS-LEFT (grid) ──────────────────┐ ┌ CONSUMPTION TREND ────────────────┐
│ SKU        On-hand  Avg/day  Days-left  Status       │ │ Litres/day (30d)  area --primary  │
│ LUB-15W40  210 L    9.5 L    22 d       🟢           │ │  ▁▂▄▃▅▆▅▄  ← spikes = services     │
│ LUB-80W90   18 L    5.2 L     3.5 d     🔴 order     │ ├───────────────────────────────────┤
│ LUB-ATF     40 L    9.0 L     4.4 d     🔴 order     │ │ CONSUMPTION BY ASSET  bar (top 8) │
│ LUB-GREASE  55 kg   1.1 kg   50 d       🟢           │ │  WP-1123 ▉▉▉▉  · GEN-04 ▉▉▉ · …    │
│ [Create MRN for critical ▸]                          │ └───────────────────────────────────┘
└──────────────────────────────────────────────────────┘
┌ RECENT LUBE ISSUES ──────────────────────────────────────────────────────────────────────┐
│ Doc              Asset     Meter     Qty   UoM  Dept        Date        Status             │
│ LUB-KND-26-000318 GEN-04   14,220 h  40 L   L   Power       09-Jul  🟢 POSTED             │
│ LUB-CMB-26-000512 WP-1123  88,140 km 25 L   L   Transport   09-Jul  🟢 POSTED             │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Days-left** = on-hand ÷ trailing-30d avg daily OUT. Each issue enforces `asset_id` (or site+dept) **and** `meter_reading` per contract §7.5 — the grid always shows the meter, proving traceability.

---

## 9. Screen — Battery Lifecycle / Asset Detail

> Route: Battery › Battery Register › (serial). Reads `md_battery`, `hist_battery_event`, warranty. This is a **C13 drill-down** with the full serial story.

```
Battery  ›  Register  ›  BAT-SN-4471190             Status: [● IN_SERVICE]      [Transfer][Return ▾]
┌ IDENTITY ──────────────────────────────────────┐ ┌ WARRANTY ─────────────────────────────┐
│ Serial   SN-4471190      Model  BAT-N200        │ │ Term   24 months from issue           │
│ Item     BAT-N200 (md_item)                     │ │ Start  12-Jan-2025                     │
│ Acq cost LKR 22,500.00                          │ │ Ends   12-Jan-2027  (187 d left) 🟠   │
│ Current asset  WP-1123 (Water Pump Lorry)       │ │ Claimable ✓   [Raise warranty claim]  │
│ In service since 12-Jan-2025 (18 mo)            │ └───────────────────────────────────────┘
└─────────────────────────────────────────────────┘
┌ LIFECYCLE LOG  (hist_battery_event, append-only, newest first) ───────────────────────────┐
│ When            Event            Doc               From → To asset     Status       By      │
│ 09-Jul-26 10:12 METER CHECK      —                 WP-1123             IN_SERVICE   R.Silva │
│ 04-Mar-26 08:30 TRANSFER         BTR-CMB-26-000014 GEN-04 → WP-1123    TRANSFERRED  A.Perera│
│ 12-Jan-25 09:00 ISSUE TO ASSET   BAT-CMB-26-000077 (store) → GEN-04    ISSUED       Store   │
│ 10-Jan-25 14:20 GRN RECEIPT      GRN-CMB-26-000151 —                   IN_STOCK     Store   │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ Every row links to its source document. md_battery.current_asset_id & battery_status update  │
│ in the SAME txn as each event (contract §7.4).                                               │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌ ACTIONS ── [Transfer to asset ▸] [Return / Replace ▸] [Warranty claim ▸] [Scrap ▸] ───────┐
│ Each opens a confirm-drawer; posts tx_battery_* + appends hist_battery_event + status move. │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Status flow surfaced:** `IN_STOCK → ISSUED → IN_SERVICE → TRANSFERRED → RETURNED → UNDER_WARRANTY_CLAIM → REPAIRED/REPLACED → SCRAPPED`. The header chip is the live `md_battery.battery_status`; the log renders the whole path.

---

## 10. Screen — Job Card Cockpit

> Route: Workshop › Job Card Board › (job). **C13 tabbed drill-down** — the operational heart. Reads `tx_jobcard`, `txl_jobcard_task`, `tx_job_progress`, `tx_job_parts`, `tx_job_labour`, `tx_job_outside_repair`, `cost_job_summary`.

```
Workshop  ›  Job Cards  ›  JC-CMB-26-000502            Status: [● IN_PROGRESS]  [Add Progress][⋯]
┌ HEADER STRIP ──────────────────────────────────────────────────────────────────────────────┐
│ Asset WP-1123 · Lorry (LP-4471) │ Fault: Engine overhaul │ Opened 02-Jul │ TM ✓ · OM ⏳     │
│ Est cost LKR 2.10M │ Actual (live) LKR 1.86M │ Variance −11% 🟢 │ Days open 7 │ Bay B-2      │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
[ Tasks ] [ Progress ] [ Parts ] [ Labour ] [ Outside ] [ Cost Summary ]      ← tab bar
┌ TAB: Tasks (txl_jobcard_task) ─────────────────────────────────────────────────────────────┐
│ # Task                     Est hrs  Assigned    Status                                       │
│ 1 Strip & inspect engine   8        R.Silva     🟢 WORK_COMPLETED                            │
│ 2 Recondition head         12       K.Fernando  🔵 IN_PROGRESS                               │
│ 3 Replace bearings         6        —            🟣 AWAITING_PARTS (SPR-00988)               │
└──────────────────────────────────────────────────────────────────────────────────────────────┘

── TAB: Progress (tx_job_progress + status transitions) — C7 timeline ──────────────────────
   ● 09-Jul 16:00  60% · "Head reconditioned, awaiting bearings"  K.Fernando
   │  ⤷ status → AWAITING_PARTS 🟣  (MRQ-CMB-26-000488 raised)
   ● 05-Jul 11:20  35% · "Engine stripped, block OK"  R.Silva
   ● 02-Jul 09:00  Job APPROVED → ASSIGNED_WORKSHOP 🔵

── TAB: Parts (tx_job_parts → issue/GRN, MWAC) ─────────────────────────────────────────────
   Item        Req(MRQ)          Issued  UoM  Unit cost  Amount     Source
   SPR-00113   MRQ-CMB-26-000488  4      EA   3,200.00   12,800.00  ISS-CMB-26-001004
   SPR-00988   MRQ-CMB-26-000488  1 SET  ⏳ AWAITING     8,400.00   (reserved inv_reservation)
   → Material cost rolls to cost_job_summary.material_cost; un-priced part flags job (§7.7)

── TAB: Labour (tx_job_labour, LAB) ────────────────────────────────────────────────────────
   Tech        Grade  Date     Hrs   Rate     Amount     Doc
   R.Silva     A      05-Jul   8.0   650.00   5,200.00   LAB-CMB-26-000771
   K.Fernando  A      09-Jul   6.5   650.00   4,225.00   LAB-CMB-26-000772

── TAB: Outside (tx_job_outside_repair, OSR) ───────────────────────────────────────────────
   Vendor            Desc               Amount      Status         Doc
   Precision Machining Crank grinding    45,000.00  🔵 APPROVED     OSR-CMB-26-000031

── TAB: Cost Summary (cost_job_summary / cost_job_line / cost_variance) ────────────────────
   Element      Estimated    Actual       Variance     %
   Material     1,300,000    1,180,400    −119,600     −9%   🟢
   Labour         420,000      388,000     −32,000     −8%   🟢
   Outside         80,000       45,000     −35,000    −44%   🟢
   General        300,000      246,000     −54,000    −18%   🟢
   ─────────────────────────────────────────────────────────
   TOTAL        2,100,000    1,859,400    −240,600    −11%   🟢
   ⚠ Close blocked: 1 part AWAITING, OM approval ⏳, 0 pending-price rows  (contract §7.7)
```

**Status journey (header chip):** `DRAFT → PENDING_TM_APPROVAL → PENDING_OM_APPROVAL → APPROVED → ASSIGNED_WORKSHOP → IN_PROGRESS ⇄ (AWAITING_PARTS | AWAITING_OUTSIDE_REPAIR) → WORK_COMPLETED → PENDING_COSTING → PENDING_CLOSURE → CLOSED`. The cockpit shows a **close-readiness checklist** (parts accounted, no `inv_pending_price` rows, labour captured, outside costs in, approvals done) — gate matches contract §7.7.

---

## 11. Screen — Approval Queue

> Route: Approvals › My Approval Queue. Reads `apr_request` / `apr_step` (mine, `PENDING`), acts write `apr_action`.

```
Approvals  ›  My Approval Queue
My Approval Queue                              [Bulk approve ▾]   Sort:[Ageing ▾]  Filter:[Type ▾][Site ▾]

Tabs:  [ Pending (12) ]  [ Returned to me (2) ]  [ Delegated (1) ]  [ History ]

┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ ☐  📋 JC-CMB-26-000502   Engine overhaul · WP-1123          LKR 2.10M      🔴 5h · SLA breach │
│    Requested by R.Silva · CMB · step 2/2 PENDING_OM_APPROVAL      [✔ Approve] [⤺ Return] [✖]  │
│    ▸ expand: task lines, cost estimate, requester note                                        │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ☐  📦 GRN-CMB-26-000210  Filters receipt · Lanka Filters    LKR 0.40M      🟠 1h              │
│    Requested by Store · CMB · step 1/1 PENDING_TM_APPROVAL        [✔ Approve] [⤺ Return] [✖]  │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ☐  🔧 MRQ-KND-26-000488  Brake parts · JC-KND-26-000455     LKR 0.09M      🟢 20m             │
│    Requested by A.Perera · KND · step 1/2 PENDING_TM_APPROVAL     [✔ Approve] [⤺ Return] [✖]  │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ ☐  ⛽ OSR-CMB-26-000031  Crank grinding · Precision Mach.    LKR 0.045M     🟢 3h             │
│    Requested by K.Fernando · CMB · step 1/1 PENDING_OM_APPROVAL   [✔ Approve] [⤺ Return] [✖]  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
  Age badge: 🟢 <4h · 🟠 <SLA · 🔴 ≥SLA breach.  Approve = optimistic (row greys, undo 5s).
  Return requires a reason (inline). Reject requires a reason + confirm.
```

**Action effects:** Approve → `apr_action APPROVED`, advances `apr_step`; last step flips source doc status (e.g. JC `PENDING_OM_APPROVAL → APPROVED`). Return → `RETURNED` (doc back to requester, `ON_HOLD`/`RETURNED`). Reject → `REJECTED` (doc `REJECTED`). Every action stamps `approved_by`/`approved_at` and is immutable in `apr_action`.

---

## 12. Interaction Patterns

| Pattern | Rule |
|---------|------|
| **Quick actions** | Every list row + drawer + detail header exposes the 1–2 most likely next docs (Stock row → *Create MRN*; GRN → *Post*; Job → *Add Progress*). Primary filled, destructive outlined-danger. |
| **Keyboard-first entry (clerks)** | Line grids: `Tab`/`Enter` advance cell→cell then new row; `Alt+↓` duplicate row; `Ctrl+Enter` post; item cell autocompletes on code/scan; numeric cells accept `+`/`=` running math. No mouse needed for a 100-line GRN. |
| **Inline validation** | Validate on blur, not on submit. RECV>ORD → amber cell warn (allowed with note); blank price → ⏳ pending flag; qty>available on issue → red block unless override (`override_by`+`override_reason`). Errors shown *at the cell*, summary count in footer. |
| **Optimistic feedback** | Approve/Post/Save show instant state + toast with **5s Undo**; server confirm swaps in real doc no (`GRN-CMB-26-000211`). On failure, row reverts + error toast. |
| **Autosave drafts** | Header+line forms autosave `DRAFT` every 20s and on blur; "Saved • 10:14" indicator. |
| **Empty states** | Icon + one line + primary CTA ("No GRNs this month — *Create GRN*"). Never a blank grid. |
| **Loading states** | Skeleton rows for grids, shimmer cards for KPIs; charts show axis + skeleton bars. Never a full-page spinner over usable UI. |
| **Error states** | Inline retry banner ("Couldn't load ledger — *Retry*"), keep last-good data dimmed if present. |
| **Confirmations for reversals** | Reverse/Void/Scrap/Reject open a confirm dialog stating the ledger/costing consequence ("This posts a reversing `mv_stock_ledger` OUT and recalculates MWAC. Enter reason."). Requires typed reason; logged. Never a silent destructive action. |
| **Drill everywhere** | Any doc no, item code, asset reg, serial or job no is a link → drawer (peek) or detail page (full). |
| **Site context** | Changing the site switcher re-scopes the current list in place (no full reload) and is reflected in the breadcrumb chip. |

---

## 13. Accessibility & Responsive Rules

| Area | Rule |
|------|------|
| **Contrast** | Text ≥ 4.5:1, large text/icons ≥ 3:1, chip text on tint ≥ 4.5:1 — verified in **both** themes. Status never encoded by color alone (always dot + label + icon). |
| **Focus** | Visible 3px `--focus-ring` on every interactive element; logical tab order header→lines→footer; skip-to-content link. |
| **Keyboard** | Full app operable without mouse: sidebar (arrow/enter), grids (arrows/enter), drawers (Esc to close), approval actions (`A`/`R`/`U` when row focused). |
| **Touch targets** | ≥44×44px on tablet/mobile for buttons, chips-as-actions, grid row actions. |
| **Screen readers** | Semantic landmarks (`nav`, `main`), grids as ARIA tables with sortable headers announced; status chips carry `aria-label` with full status text; toasts `aria-live=polite`, errors `assertive`. |
| **Motion** | Respect `prefers-reduced-motion`: disable drawer slide / row-fade, keep instant state changes. |
| **Sidebar responsive** | ≥1024px expanded (248px) · 768–1023px icon rail (64px, labels on hover) · <768px off-canvas drawer via `☰`. |
| **Tables → cards (mobile)** | Below 768px each grid row becomes a stacked card: title (doc no + status chip), 2–4 key fields as label/value pairs, action row. Approval queue & job progress stay fully usable on the shop floor. |
| **Forms (mobile)** | Header collapses to accordion; line grid becomes one card per line with big numeric inputs; sticky Save/Post bar at bottom. |
| **Density** | Comfortable default; compact toggle persists per user; both meet touch-target minimums on touch devices (compact disabled on <768px). |

---

## 14. Token & Component Traceability (contract alignment)

| UI element | Backs onto (contract) |
|------------|-----------------------|
| Status chip labels | `sys_status` values per `status_group` (§5) |
| Doc no rendering | `<TYPE>-<SITE>-<YY>-<NNNNNN>` (§4) via `sys_number_series` |
| Ledger viewer | `mv_stock_ledger` + running `inv_stock_balance.moving_avg_cost` (§6) |
| Price-pending banner/flags | `inv_pending_price` (§6, §7.7) |
| Site switcher scope | `sec_user_site` / row `site_id` (§1.3, §7.8) |
| Approval queue & actions | `apr_request` / `apr_step` / `apr_action` (§3.6) |
| Battery lifecycle log | `hist_battery_event` + `md_battery.battery_status` (§7.4) |
| Lube issue meter field | `tx_lube_issue.meter_reading` + `asset_id` (§7.5) |
| Job close checklist | close gate rules (§7.7) |
| Reversal confirmations | append-only / reversing-document rule (§1.4) |
| Audit stamps in drawers | `created_by/at`, `approved_by/at`, `row_version` (§1.3) |

> **New UI-only tokens introduced here** (no backend counterpart, presentation only, following naming spirit):
> `--bg`, `--surface(-2)`, `--border`, `--text(-muted)`, `--primary(-weak)`, `--success/--warning/--danger/--info`,
> `--focus-ring`, the status chip hue map (§4.2), and the 6-slot data-viz palette (§4.3). No new *data* tables are proposed.
```