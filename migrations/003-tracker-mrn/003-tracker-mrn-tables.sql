-- =====================================================================
-- 003-tracker-mrn-tables.sql — staging schema for the legacy tracker MRN import
-- (tracker_backup_*.json → migrate-tracker-backup.js).
--
-- These stg_* tables are a SELF-CONTAINED staging area for the legacy MRN /
-- receipt data (1,342 MRNs · 4,054 lines · 3,269 receipts, 1,421 unpriced).
-- They are deliberately kept OUT of the live Stores tables (tx_mrn / txl_mrn /
-- tx_grn) and the moving-average inventory engine — replaying 3k+ receipts
-- (many unpriced) into the live ledger would revalue real stock and can't be
-- undone. The importer matches each item/asset to the live master READ-ONLY and
-- records the match (matched_item_id / matched_asset_id) so a later, deliberate
-- reconciliation step can promote rows into tx_mrn / md_item / md_asset.
--
-- Natural keys throughout, so the same DDL runs on PostgreSQL and (via db.js
-- translation of now()/TIMESTAMPTZ) on SQLite.
-- =====================================================================

-- distinct items (matched to live md_item by name, not created there)
CREATE TABLE IF NOT EXISTS stg_mrn_item (
    item_key         VARCHAR(200) PRIMARY KEY,          -- lower(trim(itemName))
    item_name        VARCHAR(200) NOT NULL,
    item_description VARCHAR(300),
    category_raw     VARCHAR(60),
    category_code    VARCHAR(30),
    uom              VARCHAR(10)  NOT NULL DEFAULT 'EA',
    matched_item_id  BIGINT,                            -- live md_item.item_id (null if no name match)
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- distinct vehicleMachinery values, split into vehicle/asset vs workshop dept
CREATE TABLE IF NOT EXISTS stg_mrn_asset (
    asset_key        VARCHAR(140) PRIMARY KEY,          -- lower(trim(vehicleMachinery))
    raw_value        VARCHAR(140) NOT NULL,
    kind             VARCHAR(10)  NOT NULL,             -- 'ASSET' | 'DEPT'
    asset_code       VARCHAR(60),                       -- when kind=ASSET
    dept_code        VARCHAR(10),                       -- when kind=DEPT
    matched_asset_id BIGINT,                            -- live md_asset.asset_id (null if no code match)
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- one row per unique mrnNum
CREATE TABLE IF NOT EXISTS stg_mrn (
    mrn_number        VARCHAR(40) PRIMARY KEY,
    request_date      DATE,
    status            VARCHAR(12) NOT NULL,             -- FULFILLED | PARTIAL | PENDING
    legacy_id         BIGINT,                           -- min(id) of the group
    line_count        INTEGER NOT NULL DEFAULT 0,
    source_created_at TIMESTAMPTZ,                      -- min(createdAt)
    imported_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one row per JSON record (legacy id is the natural key)
CREATE TABLE IF NOT EXISTS stg_mrn_line (
    legacy_item_id BIGINT      PRIMARY KEY,             -- JSON "id"
    mrn_number     VARCHAR(40)  REFERENCES stg_mrn(mrn_number),
    item_key       VARCHAR(200) REFERENCES stg_mrn_item(item_key),
    asset_key      VARCHAR(140) REFERENCES stg_mrn_asset(asset_key),
    requested_qty  NUMERIC(18,4),
    received_qty   NUMERIC(18,4),
    uom            VARCHAR(10),
    category_code  VARCHAR(30),
    notes          VARCHAR(300),
    status         VARCHAR(12) NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one row per receipt object
CREATE TABLE IF NOT EXISTS stg_grn (
    legacy_receipt_id BIGINT      PRIMARY KEY,          -- receipt "id"
    legacy_item_id    BIGINT      REFERENCES stg_mrn_line(legacy_item_id),
    received_qty      NUMERIC(18,4),
    delivery_date     DATE,
    purchase_source   VARCHAR(60),
    grn_number        VARCHAR(40),                      -- null when the source had ""
    invoice_number    VARCHAR(40),
    invoice_date      DATE,
    supplier_name     VARCHAR(120),
    unit_price        NUMERIC(18,4),                    -- null = unpriced (needs pricing later)
    is_priced         BOOLEAN NOT NULL DEFAULT FALSE,
    transaction_type  VARCHAR(20),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stg_import_log (
    mrn_number VARCHAR(40),
    level      VARCHAR(10),                             -- INFO | WARN | ERROR
    detail     VARCHAR(400),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_stg_mrn_line_mrn  ON stg_mrn_line(mrn_number);
CREATE INDEX IF NOT EXISTS ix_stg_grn_line      ON stg_grn(legacy_item_id);
CREATE INDEX IF NOT EXISTS ix_stg_grn_unpriced  ON stg_grn(is_priced);
CREATE INDEX IF NOT EXISTS ix_stg_mrn_status    ON stg_mrn(status);
