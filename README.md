# Master‑SAP — UMMS (Unified Master Management System)

**One platform for Transport Stores, Oil/Lubricant, Battery Lifecycle, and Workshop Job‑Card Costing.**

This repository contains the **complete solution blueprint** for consolidating five separate
systems and Excel processes — stores management, an oil/lubricant stock book, battery tracking,
workshop job cards & costing, and legacy Excel/backups — into **one centralized system** with
shared master data, linked transactions, approval workflows, a single stock ledger, full
traceability, and final job costing.

> This is an **enterprise architecture & design deliverable** (documentation + reference SQL
> schema + a UI prototype), engineered so it can be built as a modern web app now and integrated
> with a full ERP (SAP MM/PM/CO) later — without rework.

---

## 1. What problem this solves

| Today (5 silos)                              | Target (UMMS)                                                        |
|----------------------------------------------|---------------------------------------------------------------------|
| Separate stores system                       | **Stores / Material Management** module on a shared item master      |
| Oil / lubricant stock book (Excel)           | **Lubricant** module on the same ledger, traceable by asset & date   |
| Battery stock tracking (Excel)               | **Battery** module with full serial lifecycle history                |
| Workshop job cards & costing (manual)        | **Job Card** module with approvals + labour/material/outside costing |
| Excel files & old system backups             | **Staged migration** into governed masters + opening balances        |

Everything connects through **shared masters** (one item list, one asset/vehicle list, one
supplier list, one location tree) and a **single append‑only stock ledger**, so one transaction in
one module correctly affects stock, costing, and reporting everywhere else.

---

## 2. The blueprint (read in this order)

| # | Document | What's inside |
|---|----------|---------------|
| 00 | [Design Contract](docs/00-design-contract.md) | **Start here.** Canonical naming standards, shared masters, numbering, status vocabularies, valuation method, integrity rules. |
| 01 | [Business Architecture](docs/01-business-architecture.md) | Target‑state in business language; architecture layers; cross‑module connectivity scenario. |
| 02 | [Module Breakdown](docs/02-module-breakdown.md) | Every module/submodule: purpose, masters, transactions, approvals, reports, alerts, dashboards. |
| 03 | [Database Design](docs/03-database-design.md) | Relational schema: masters / transactions / movements / history / approvals / costing; keys, fields, ledger & valuation logic. |
| 04 | [Stock Workflows](docs/04-stock-workflows.md) | Stores, lubricant & battery end‑to‑end workflows, status maps, movement logic, validations, alerts. |
| 05 | [Job Card & Costing](docs/05-jobcard-and-costing.md) | Full job lifecycle, approvals, workshop execution, labour, cost formulas, close gating, controls. |
| 06 | [Dashboards & KPIs](docs/06-dashboards-kpi.md) | Executive + operational dashboards, KPI catalog with formulas, alert & exception logic. |
| 07 | [Roles & Permissions](docs/07-roles-permissions.md) | Role catalog, permission matrix, site‑based visibility, segregation of duties, audit. |
| 08 | [Data Migration](docs/08-data-migration.md) | Staging, mapping, validation, duplicate detection, reconciliation, phased cutover. |
| 09 | [UI/UX Design Direction](docs/09-uiux-design.md) | Command‑center design language, sidebar nav, components, status colors, wireframes. |
| 10 | [Reports & Documents](docs/10-reports-documents.md) | Report catalog + printable document layouts (GRN, job costing sheet, etc.). |
| 11 | [Integration & Future‑Readiness](docs/11-integration.md) | Excel, barcode/QR, attachments, notifications, API, BI, optional SAP. |
| 12 | [Roadmap, Appendices & Risks](docs/12-roadmap-appendices-risks.md) | Phase plan, menu tree, master hierarchy, numbering, alert list, MVP vs advanced, risk register. |
| 13 | [Auth & RBAC Design](docs/13-auth-rbac-design.md) | Login, password hashing, sessions, permission middleware, site scoping — replaces the legacy hard‑coded password. |

**Reference SQL:** [`sql/schema.sql`](sql/schema.sql) — PostgreSQL DDL for the core tables.
**UI prototype:** [`ui/prototype.html`](ui/prototype.html) — an interactive command‑center mockup.
**Production gate:** [`PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) — the P0/P1/P2 go‑live checklist.
**Migration:** [`migration/`](migration/) — four tested legacy‑import ETLs + costing engine + playbook.

---

## 3. Core design decisions (at a glance)

- **Shared masters, zero duplication.** `md_item` holds every material (store item, lubricant,
  spare, general item, battery model). `md_asset` holds every vehicle/machine/equipment. One
  supplier, employee, location, and UoM list.
- **Single stock ledger.** Every receipt, issue, transfer, adjustment and return posts an
  append‑only row to `mv_stock_ledger`; `inv_stock_balance` is the fast on‑hand + moving‑average
  cost snapshot.
- **Effective‑date pricing.** Costing always reads the correct price *as of the transaction date*
  via `md_price_history`. Un‑priced receipts go to a **pending valuation queue** and trigger
  revaluation when confirmed.
- **Serial‑true battery lifecycle.** Every battery movement appends to `hist_battery_event`,
  preserving original‑vs‑current asset and full history.
- **Approval‑gated job closure.** A job cannot close until parts are received/accounted, prices are
  in, labour is captured, outside‑repair costs are entered, and all approvals are complete.
- **Auditable everywhere.** Standard audit fields on every table; approvals and reversals logged;
  price/cost edits tracked.
- **Site‑scoped security.** Normal site users see only their own site's data; managers roll up.

Naming standards, table prefixes (`md_`, `tx_`, `txl_`, `mv_`, `inv_`, `hist_`, `apr_`, `cost_`,
`stg_`, `sys_`, `sec_`), and numbering (`TYPE-SITE-YY-NNNNNN`) are defined once in the
[Design Contract](docs/00-design-contract.md).

---

## 4. Implementation phases (summary)

| Phase | Focus |
|-------|-------|
| **1** | Foundation masters + Stores (ledger, GRN/issue/transfer, valuation) |
| **2** | Lubricant + Battery (monthly balance, serial lifecycle, warranty) |
| **3** | Job Card + Costing (approvals, workshop execution, labour, closure) |
| **4** | Dashboards, analytics, alerts & automation |
| **5** | Integrations & mobile (barcode/QR, WhatsApp/email, API, BI, optional SAP) |

Full detail, MVP‑vs‑advanced scope, and the risk register are in
[doc 12](docs/12-roadmap-appendices-risks.md).

---

## 5. Repository layout

```
Master-SAP/
├── README.md                     # this file
├── docs/                         # the solution blueprint (00–12)
├── sql/
│   └── schema.sql                # PostgreSQL reference DDL for core tables
└── ui/
    └── prototype.html            # command-center UI prototype
```
