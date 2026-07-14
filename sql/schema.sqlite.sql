-- =====================================================================
-- UMMS — SQLite schema (GENERATED — do not edit by hand)
-- Source: sql/schema.sql  ·  Regenerate: node sql/gen-sqlite-schema.js
-- The app selects this variant when DB_ENGINE=sqlite (or SQLITE_DB is set).
-- =====================================================================

-- =====================================================================
-- UMMS — Unified Master Management System  (repo: Master-SAP)
-- FILE: sql/schema.sql   |   Target: PostgreSQL 14+
-- Core backbone DDL. Conforms to docs/00-design-contract.md.
-- Conventions: <root>_id INTEGER IDENTITY PK; <root>_no VARCHAR(30) UNIQUE;
--   *_qty NUMERIC(18,4); *_amt/*_cost money NUMERIC(18,2); costs/avg NUMERIC(18,4);
--   audit block on every table; site_id on approvable docs; append-only mv_/hist_.
-- Status/direction enums enforced with CHECK; label master held in sys_status.
-- Forward cross-references are added in the DEFERRED CONSTRAINTS section (bottom).
-- =====================================================================

-- Fuzzy text matching for the admin duplicate-item finder (similarity()). Standard contrib module.
-- (Stripped from the generated SQLite schema — SQLite has no extensions; the app falls back to an
--  in-JS trigram similarity there. See routes/admin.js.)
-- =====================================================================
-- SECTION 0 — SECURITY CORE (declared first: audit FKs point at sec_user)
-- =====================================================================

CREATE TABLE sec_user (
    user_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username      VARCHAR(60)  NOT NULL,
    full_name     VARCHAR(150) NOT NULL,
    email         VARCHAR(150),
    employee_id   INTEGER,                 -- FK md_employee (deferred)
    home_site_id  INTEGER,                 -- FK md_location (deferred)
    password_hash VARCHAR(200),
    auth_provider VARCHAR(20)  NOT NULL DEFAULT 'LOCAL',
    is_locked     BOOLEAN      NOT NULL DEFAULT FALSE,
    must_change_password BOOLEAN NOT NULL DEFAULT TRUE,   -- force a rotation on first login
    locked_until  TEXT,                            -- set on repeated failed logins; temporary lockout
    last_login_at TEXT,
    created_by    INTEGER       NOT NULL,
    created_at    TEXT  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by    INTEGER,
    updated_at    TEXT,
    row_version   INTEGER      NOT NULL DEFAULT 1,
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sec_user_username UNIQUE (username),
    CONSTRAINT fk_sec_user_created_by FOREIGN KEY (created_by)
        REFERENCES sec_user(user_id) DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT fk_sec_user_updated_by FOREIGN KEY (updated_by)
        REFERENCES sec_user(user_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE sec_role (
    role_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    role_code   VARCHAR(30)  NOT NULL,
    role_name   VARCHAR(100) NOT NULL,
    description VARCHAR(300),
    created_by  INTEGER       NOT NULL REFERENCES sec_user(user_id),
    created_at  TEXT  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by  INTEGER       REFERENCES sec_user(user_id),
    updated_at  TEXT,
    row_version INTEGER      NOT NULL DEFAULT 1,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sec_role_code UNIQUE (role_code)
);

CREATE TABLE sec_permission (
    permission_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    permission_code VARCHAR(60)  NOT NULL,
    permission_name VARCHAR(120) NOT NULL,
    module          VARCHAR(20)  NOT NULL,   -- STORES|LUBE|BATTERY|WORKSHOP|ADMIN
    action          VARCHAR(20)  NOT NULL,   -- CREATE|READ|UPDATE|APPROVE|POST|VOID
    created_by      INTEGER       NOT NULL REFERENCES sec_user(user_id),
    created_at      TEXT  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by      INTEGER       REFERENCES sec_user(user_id),
    updated_at      TEXT,
    row_version     INTEGER      NOT NULL DEFAULT 1,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sec_permission_code UNIQUE (permission_code)
);

CREATE TABLE sec_user_role (
    user_role_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES sec_user(user_id),
    role_id      INTEGER NOT NULL REFERENCES sec_role(role_id),
    created_by   INTEGER NOT NULL REFERENCES sec_user(user_id),
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sec_user_role UNIQUE (user_id, role_id)
);

CREATE TABLE sec_role_permission (
    role_permission_id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id       INTEGER NOT NULL REFERENCES sec_role(role_id),
    permission_id INTEGER NOT NULL REFERENCES sec_permission(permission_id),
    created_by    INTEGER NOT NULL REFERENCES sec_user(user_id),
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sec_role_permission UNIQUE (role_id, permission_id)
);

-- =====================================================================
-- SECTION 1 — SYSTEM / CONFIG (no location dependency yet)
-- =====================================================================

CREATE TABLE sys_status (
    status_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    status_group VARCHAR(20) NOT NULL,   -- DOC|APR|GRN|PRICE|MVDIR|JOBCARD|BATTERY|MIGR
    status_code  VARCHAR(30) NOT NULL,
    status_name  VARCHAR(80) NOT NULL,
    sort_order   INTEGER     NOT NULL DEFAULT 0,
    is_terminal  BOOLEAN     NOT NULL DEFAULT FALSE,
    created_by   INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by   INTEGER      REFERENCES sec_user(user_id),
    updated_at   TEXT,
    row_version  INTEGER     NOT NULL DEFAULT 1,
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sys_status UNIQUE (status_group, status_code)
);

CREATE TABLE sys_code (
    code_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    code_group VARCHAR(30) NOT NULL,
    code_value VARCHAR(30) NOT NULL,
    code_label VARCHAR(120) NOT NULL,
    sort_order INTEGER     NOT NULL DEFAULT 0,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sys_code UNIQUE (code_group, code_value)
);

CREATE TABLE sys_setting (
    setting_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_key   VARCHAR(80)  NOT NULL,
    setting_value VARCHAR(400),
    data_type     VARCHAR(15)  NOT NULL DEFAULT 'STRING',
    description   VARCHAR(300),
    site_id       INTEGER,                  -- null = global (FK md_location deferred)
    created_by    INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by    INTEGER      REFERENCES sec_user(user_id),
    updated_at    TEXT,
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sys_setting_key UNIQUE (setting_key, site_id)
);

-- =====================================================================
-- SECTION 2 — LOCATION MASTER + site-scoped security & numbering
-- =====================================================================

CREATE TABLE md_location (
    location_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    location_code      VARCHAR(20)  NOT NULL,
    location_name      VARCHAR(120) NOT NULL,
    location_type      VARCHAR(10)  NOT NULL,   -- SITE|STORE|BIN
    site_code          CHAR(3),                 -- 3-letter code for numbering (SITE rows)
    parent_location_id INTEGER       REFERENCES md_location(location_id),
    address            VARCHAR(300),
    created_by         INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by         INTEGER      REFERENCES sec_user(user_id),
    updated_at         TEXT,
    row_version        INTEGER     NOT NULL DEFAULT 1,
    is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_location_code UNIQUE (location_code),
    CONSTRAINT ck_md_location_type CHECK (location_type IN ('SITE','STORE','BIN'))
);

CREATE TABLE sec_user_site (
    user_site_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES sec_user(user_id),
    site_id      INTEGER NOT NULL REFERENCES md_location(location_id),
    access_level VARCHAR(10) NOT NULL DEFAULT 'READ',   -- READ|WRITE|APPROVE
    created_by   INTEGER NOT NULL REFERENCES sec_user(user_id),
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sec_user_site UNIQUE (user_id, site_id),
    CONSTRAINT ck_sec_user_site_level CHECK (access_level IN ('READ','WRITE','APPROVE'))
);

-- Append-only log of every login attempt (success or failure) — feeds the admin login-audit view and
-- the brute-force lockout. user_id is NULL when the typed username matched no account; the raw username
-- is kept so unknown-user attempts are still visible.
CREATE TABLE sec_audit_log (
    audit_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER REFERENCES sec_user(user_id),
    username     VARCHAR(60),
    ip_address   VARCHAR(45),
    user_agent   VARCHAR(300),
    success      BOOLEAN NOT NULL,
    attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_sec_audit_log_user ON sec_audit_log(user_id, attempted_at);
CREATE INDEX ix_sec_audit_log_at ON sec_audit_log(audit_id);

-- Machine-to-machine credentials for the /api/v1 REST layer (SAP Fiori / Integration Suite, etc.).
-- POST /api/v1/auth/token exchanges client_id + client_secret for a short-lived Bearer JWT. The secret
-- is stored hashed (scrypt), like a user password.
CREATE TABLE sec_service_account (
    service_account_id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id          VARCHAR(60)  NOT NULL,
    client_secret_hash VARCHAR(200) NOT NULL,
    account_name       VARCHAR(150) NOT NULL,
    scopes             VARCHAR(300) NOT NULL DEFAULT 'read',
    last_token_at      TEXT,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sec_service_account_client UNIQUE (client_id)
);

CREATE TABLE sys_number_series (
    series_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_type      VARCHAR(5)  NOT NULL,   -- MRN|PO|GRN|ISS|TRF|ADJ|RET|LUB|BAT|BTR|BRT|JC|MRQ|LAB|OSR
    site_id       INTEGER      NOT NULL REFERENCES md_location(location_id),
    year_yy       SMALLINT    NOT NULL,
    current_no    INTEGER      NOT NULL DEFAULT 0,
    padding_width SMALLINT    NOT NULL DEFAULT 6,
    prefix        VARCHAR(10),
    format_mask   VARCHAR(40) NOT NULL DEFAULT '{TYPE}-{SITE}-{YY}-{NNNNNN}',
    created_by    INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by    INTEGER      REFERENCES sec_user(user_id),
    updated_at    TEXT,
    row_version   INTEGER     NOT NULL DEFAULT 1,
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sys_number_series UNIQUE (doc_type, site_id, year_yy)
);

-- =====================================================================
-- SECTION 3 — CORE MASTERS (items, UoM, suppliers, dimensions)
-- =====================================================================

CREATE TABLE md_uom (
    uom_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    uom_code   VARCHAR(15) NOT NULL,
    uom_name   VARCHAR(60) NOT NULL,
    uom_type   VARCHAR(10) NOT NULL DEFAULT 'COUNT',  -- COUNT|VOLUME|WEIGHT|LENGTH|TIME
    decimals   SMALLINT    NOT NULL DEFAULT 2,
    is_base    BOOLEAN     NOT NULL DEFAULT TRUE,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_uom_code UNIQUE (uom_code)
);

CREATE TABLE md_item_category (
    category_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    category_code      VARCHAR(20)  NOT NULL,
    category_name      VARCHAR(120) NOT NULL,
    parent_category_id INTEGER       REFERENCES md_item_category(category_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_item_category UNIQUE (category_code)
);

CREATE TABLE md_item_group (
    group_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    group_code VARCHAR(20)  NOT NULL,
    group_name VARCHAR(120) NOT NULL,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_item_group UNIQUE (group_code)
);

CREATE TABLE md_supplier (
    supplier_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_no    VARCHAR(30)  NOT NULL,
    supplier_name  VARCHAR(150) NOT NULL,
    supplier_type  VARCHAR(15)  NOT NULL DEFAULT 'LOCAL',  -- LOCAL|HEAD_OFFICE|SUBCONTRACTOR
    tax_id         VARCHAR(30),
    contact_person VARCHAR(120),
    phone          VARCHAR(40),
    email          VARCHAR(150),
    address        VARCHAR(300),
    city           VARCHAR(80),
    payment_terms  VARCHAR(60),
    currency_code  CHAR(3)      NOT NULL DEFAULT 'LKR',
    is_subcontractor BOOLEAN    NOT NULL DEFAULT FALSE,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_supplier_no UNIQUE (supplier_no),
    CONSTRAINT ck_md_supplier_type CHECK (supplier_type IN ('LOCAL','HEAD_OFFICE','SUBCONTRACTOR'))
);

CREATE TABLE md_department (
    department_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    department_code VARCHAR(20)  NOT NULL,
    department_name VARCHAR(120) NOT NULL,
    parent_department_id INTEGER  REFERENCES md_department(department_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_department UNIQUE (department_code)
);

CREATE TABLE md_cost_center (
    cost_center_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    cost_center_code VARCHAR(20)  NOT NULL,
    cost_center_name VARCHAR(120) NOT NULL,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_cost_center UNIQUE (cost_center_code)
);

CREATE TABLE md_project (
    project_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    project_code VARCHAR(20)  NOT NULL,
    project_name VARCHAR(150) NOT NULL,
    start_date   DATE,
    end_date     DATE,
    project_status VARCHAR(15) NOT NULL DEFAULT 'ACTIVE',
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_project UNIQUE (project_code)
);

CREATE TABLE md_item (
    item_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    item_no           VARCHAR(30)  NOT NULL,
    item_name         VARCHAR(150) NOT NULL,
    item_type         VARCHAR(12)  NOT NULL,   -- STORE|LUBRICANT|BATTERY|SPARE|GENERAL|CONSUMABLE
    category_id       INTEGER       REFERENCES md_item_category(category_id),
    group_id          INTEGER       REFERENCES md_item_group(group_id),
    base_uom_id       INTEGER       NOT NULL REFERENCES md_uom(uom_id),
    is_stockable      BOOLEAN      NOT NULL DEFAULT TRUE,
    is_serial_tracked BOOLEAN      NOT NULL DEFAULT FALSE,
    is_batch_tracked  BOOLEAN      NOT NULL DEFAULT FALSE,
    valuation_method  VARCHAR(6)   NOT NULL DEFAULT 'MWAC',   -- MWAC|FIFO
    reorder_level     NUMERIC(18,4) NOT NULL DEFAULT 0,
    reorder_qty       NUMERIC(18,4) NOT NULL DEFAULT 0,
    min_qty           NUMERIC(18,4) NOT NULL DEFAULT 0,
    max_qty           NUMERIC(18,4),
    shelf_life_days   INTEGER,
    default_supplier_id INTEGER     REFERENCES md_supplier(supplier_id),
    barcode           VARCHAR(50),
    tax_code          VARCHAR(20),
    specification     VARCHAR(400),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_item_no UNIQUE (item_no),
    CONSTRAINT ck_md_item_type CHECK (item_type IN
        ('STORE','LUBRICANT','BATTERY','SPARE','GENERAL','CONSUMABLE')),
    CONSTRAINT ck_md_item_valuation CHECK (valuation_method IN ('MWAC','FIFO'))
);

CREATE TABLE md_uom_conversion (
    conversion_id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id       INTEGER       REFERENCES md_item(item_id),   -- null = global conversion
    from_uom_id   INTEGER NOT NULL REFERENCES md_uom(uom_id),
    to_uom_id     INTEGER NOT NULL REFERENCES md_uom(uom_id),
    factor        NUMERIC(18,6) NOT NULL,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_uom_conversion UNIQUE (item_id, from_uom_id, to_uom_id),
    CONSTRAINT ck_md_uom_conv_factor CHECK (factor > 0)
);

-- ---------- Assets (unified fleet + plant) + subtype extensions ----------

CREATE TABLE md_asset (
    asset_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_no        VARCHAR(30)  NOT NULL,
    asset_name      VARCHAR(150) NOT NULL,
    asset_class     VARCHAR(12)  NOT NULL,   -- VEHICLE|MACHINE|EQUIPMENT
    site_id         INTEGER       NOT NULL REFERENCES md_location(location_id),
    department_id   INTEGER       REFERENCES md_department(department_id),
    cost_center_id  INTEGER       REFERENCES md_cost_center(cost_center_id),
    asset_status    VARCHAR(12)  NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE|IDLE|DISPOSED
    acquisition_date DATE,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_asset_no UNIQUE (asset_no),
    CONSTRAINT ck_md_asset_class CHECK (asset_class IN ('VEHICLE','MACHINE','EQUIPMENT'))
);

CREATE TABLE md_asset_vehicle (
    asset_id     INTEGER PRIMARY KEY REFERENCES md_asset(asset_id),
    reg_no       VARCHAR(20)  NOT NULL,
    chassis_no   VARCHAR(40),
    engine_no    VARCHAR(40),
    make         VARCHAR(60),
    model        VARCHAR(60),
    model_year   SMALLINT,
    fuel_type    VARCHAR(15),
    meter_type   VARCHAR(4)   NOT NULL DEFAULT 'KM',   -- KM|HR
    current_meter NUMERIC(18,2) NOT NULL DEFAULT 0,
    tyre_size    VARCHAR(30),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_asset_vehicle_reg UNIQUE (reg_no),
    CONSTRAINT ck_md_asset_vehicle_meter CHECK (meter_type IN ('KM','HR'))
);

CREATE TABLE md_asset_machine (
    asset_id     INTEGER PRIMARY KEY REFERENCES md_asset(asset_id),
    plant_no     VARCHAR(30),
    make         VARCHAR(60),
    model        VARCHAR(60),
    capacity     NUMERIC(18,2),
    capacity_uom VARCHAR(15),
    meter_type   VARCHAR(4)   NOT NULL DEFAULT 'HR',
    hour_meter   NUMERIC(18,2) NOT NULL DEFAULT 0,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT ck_md_asset_machine_meter CHECK (meter_type IN ('KM','HR'))
);

-- ---------- Employees, grades, labour rates ----------

CREATE TABLE md_employee_grade (
    grade_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    grade_code VARCHAR(20)  NOT NULL,
    grade_name VARCHAR(80)  NOT NULL,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_employee_grade UNIQUE (grade_code)
);

CREATE TABLE md_employee (
    employee_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_no   VARCHAR(30)  NOT NULL,
    employee_name VARCHAR(150) NOT NULL,
    is_technician BOOLEAN      NOT NULL DEFAULT FALSE,
    grade_id      INTEGER       REFERENCES md_employee_grade(grade_id),
    department_id INTEGER       REFERENCES md_department(department_id),
    site_id       INTEGER       NOT NULL REFERENCES md_location(location_id),
    designation   VARCHAR(80),
    hire_date     DATE,
    phone         VARCHAR(40),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_employee_no UNIQUE (employee_no)
);

CREATE TABLE md_labour_rate (
    labour_rate_id INTEGER PRIMARY KEY AUTOINCREMENT,
    grade_id       INTEGER NOT NULL REFERENCES md_employee_grade(grade_id),
    effective_date DATE   NOT NULL,
    hourly_rate    NUMERIC(18,2) NOT NULL,
    ot_multiplier  NUMERIC(9,4)  NOT NULL DEFAULT 1.5,
    currency_code  CHAR(3)       NOT NULL DEFAULT 'LKR',
    rate_status    VARCHAR(12)   NOT NULL DEFAULT 'CONFIRMED',
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_labour_rate UNIQUE (grade_id, effective_date)
);

CREATE TABLE md_warranty_term (
    warranty_term_id INTEGER PRIMARY KEY AUTOINCREMENT,
    term_code        VARCHAR(20)  NOT NULL,
    term_name        VARCHAR(100) NOT NULL,
    duration_months  INTEGER      NOT NULL DEFAULT 0,
    meter_limit      NUMERIC(18,2),
    description      VARCHAR(300),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_warranty_term UNIQUE (term_code)
);

CREATE TABLE md_approval_role (
    approval_role_id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_code   VARCHAR(30)  NOT NULL,
    role_name   VARCHAR(100) NOT NULL,
    sec_role_id INTEGER       REFERENCES sec_role(role_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_approval_role UNIQUE (role_code)
);

-- ---------- Battery serial register (stateful master) ----------

CREATE TABLE md_battery (
    battery_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    battery_serial_no  VARCHAR(50)  NOT NULL,
    item_id            INTEGER NOT NULL REFERENCES md_item(item_id),   -- battery model
    manufacturer       VARCHAR(80),
    capacity_ah        NUMERIC(10,2),
    voltage            NUMERIC(6,2),
    manufacture_date   DATE,
    purchase_grn_id    INTEGER,                 -- FK tx_grn (deferred)
    purchase_date      DATE,
    acquisition_cost   NUMERIC(18,2) NOT NULL DEFAULT 0,
    warranty_term_id   INTEGER REFERENCES md_warranty_term(warranty_term_id),
    warranty_start_date DATE,
    warranty_end_date   DATE,
    original_asset_id  INTEGER REFERENCES md_asset(asset_id),   -- first asset installed on
    current_asset_id   INTEGER REFERENCES md_asset(asset_id),   -- current asset (null in stock)
    current_location_id INTEGER REFERENCES md_location(location_id),
    battery_status     VARCHAR(22) NOT NULL DEFAULT 'IN_STOCK',
    install_meter      NUMERIC(18,2),
    last_event_id      INTEGER,                 -- FK hist_battery_event (deferred)
    site_id            INTEGER NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_battery_serial UNIQUE (battery_serial_no),
    CONSTRAINT ck_md_battery_status CHECK (battery_status IN
        ('IN_STOCK','ISSUED','IN_SERVICE','TRANSFERRED','RETURNED',
         'UNDER_WARRANTY_CLAIM','REPAIRED','SCRAPPED','REPLACED','LOST'))
);

-- =====================================================================
-- SECTION 4 — PRICING (effective-dated; costing reads price as-of date)
-- =====================================================================

CREATE TABLE md_price_history (
    price_history_id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id         INTEGER NOT NULL REFERENCES md_item(item_id),
    supplier_id     INTEGER REFERENCES md_supplier(supplier_id),
    site_id         INTEGER REFERENCES md_location(location_id),
    uom_id          INTEGER NOT NULL REFERENCES md_uom(uom_id),
    unit_price      NUMERIC(18,4) NOT NULL,
    currency_code   CHAR(3)       NOT NULL DEFAULT 'LKR',
    effective_date  DATE          NOT NULL,
    end_date        DATE,
    price_status    VARCHAR(12)   NOT NULL DEFAULT 'CONFIRMED',
    source_doc_type VARCHAR(10),          -- GRN|PO|MANUAL|IMPORT
    source_doc_id   INTEGER,
    change_reason   VARCHAR(200),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_md_price_hist_status CHECK (price_status IN
        ('PENDING','PROVISIONAL','CONFIRMED','REVISED'))
);

CREATE TABLE md_price (
    price_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id         INTEGER NOT NULL REFERENCES md_item(item_id),
    supplier_id     INTEGER REFERENCES md_supplier(supplier_id),
    site_id         INTEGER REFERENCES md_location(location_id),
    uom_id          INTEGER NOT NULL REFERENCES md_uom(uom_id),
    unit_price      NUMERIC(18,4) NOT NULL,
    currency_code   CHAR(3)       NOT NULL DEFAULT 'LKR',
    effective_date  DATE          NOT NULL,
    price_status    VARCHAR(12)   NOT NULL DEFAULT 'CONFIRMED',
    price_history_id INTEGER REFERENCES md_price_history(price_history_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_md_price_current UNIQUE (item_id, supplier_id, site_id),
    CONSTRAINT ck_md_price_status CHECK (price_status IN
        ('PENDING','PROVISIONAL','CONFIRMED','REVISED'))
);

-- =====================================================================
-- SECTION 5 — WORKFLOW DEFINITIONS (generic approval engine config)
-- =====================================================================

CREATE TABLE sys_workflow (
    workflow_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_code VARCHAR(40)  NOT NULL,   -- JOBCARD_APPROVAL|PO_APPROVAL|GRN_PRICE|ADJ_APPROVAL...
    workflow_name VARCHAR(120) NOT NULL,
    doc_type      VARCHAR(10)  NOT NULL,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sys_workflow_code UNIQUE (workflow_code)
);

CREATE TABLE sys_workflow_step (
    step_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id      INTEGER NOT NULL REFERENCES sys_workflow(workflow_id),
    step_no          SMALLINT NOT NULL,
    step_name        VARCHAR(100) NOT NULL,
    approval_role_id INTEGER REFERENCES md_approval_role(approval_role_id),
    required_role_id INTEGER REFERENCES sec_role(role_id),
    min_amount       NUMERIC(18,2),
    max_amount       NUMERIC(18,2),
    is_final         BOOLEAN NOT NULL DEFAULT FALSE,
    can_return       BOOLEAN NOT NULL DEFAULT TRUE,
    escalate_after_hours INTEGER,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sys_workflow_step UNIQUE (workflow_id, step_no)
);

-- =====================================================================
-- SECTION 6 — MOVEMENT LEDGER (append-only) + INVENTORY STATE
-- =====================================================================

CREATE TABLE mv_stock_ledger (
    ledger_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    movement_no          VARCHAR(30)  NOT NULL,
    movement_date        DATE         NOT NULL,
    item_id              INTEGER NOT NULL REFERENCES md_item(item_id),
    location_id          INTEGER NOT NULL REFERENCES md_location(location_id),
    mv_direction         VARCHAR(10)  NOT NULL,
    qty                  NUMERIC(18,4) NOT NULL,      -- magnitude, always >= 0
    unit_cost            NUMERIC(18,4) NOT NULL,      -- IN=receipt cost, OUT=MWAC at issue
    value_amt            NUMERIC(18,2) NOT NULL,      -- signed value delta (+in / -out)
    running_balance_qty  NUMERIC(18,4) NOT NULL,      -- on-hand after this movement
    running_balance_value NUMERIC(18,2) NOT NULL,     -- inventory value after
    running_avg_cost     NUMERIC(18,4) NOT NULL,      -- MWAC after (item x location)
    source_doc_type      VARCHAR(10)  NOT NULL,       -- GRN|ISS|TRF|ADJ|RET|LUB|BAT|BRT|JOB|REVAL
    source_doc_id        INTEGER       NOT NULL,
    source_line_id       INTEGER,
    batch_no             VARCHAR(40),
    serial_no            VARCHAR(50),
    battery_id           INTEGER REFERENCES md_battery(battery_id),
    valuation_layer_id   INTEGER,                      -- FK inv_valuation_layer (deferred)
    is_provisional       BOOLEAN NOT NULL DEFAULT FALSE,
    reval_of_ledger_id   INTEGER REFERENCES mv_stock_ledger(ledger_id),
    posted_by            INTEGER NOT NULL REFERENCES sec_user(user_id),
    posted_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    site_id              INTEGER NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_mv_stock_ledger_no UNIQUE (movement_no),
    CONSTRAINT ck_mv_direction CHECK (mv_direction IN
        ('IN','OUT','XFER_IN','XFER_OUT','ADJ_IN','ADJ_OUT','RET_IN','RET_OUT')),
    CONSTRAINT ck_mv_qty_nonneg CHECK (qty >= 0)
);

CREATE TABLE inv_stock_balance (
    balance_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id          INTEGER NOT NULL REFERENCES md_item(item_id),
    location_id      INTEGER NOT NULL REFERENCES md_location(location_id),
    on_hand_qty      NUMERIC(18,4) NOT NULL DEFAULT 0,
    reserved_qty     NUMERIC(18,4) NOT NULL DEFAULT 0,
    available_qty    NUMERIC(18,4) GENERATED ALWAYS AS (on_hand_qty - reserved_qty) STORED,
    moving_avg_cost  NUMERIC(18,4) NOT NULL DEFAULT 0,
    stock_value      NUMERIC(18,2) NOT NULL DEFAULT 0,
    last_movement_id INTEGER REFERENCES mv_stock_ledger(ledger_id),
    last_movement_at TEXT,
    last_receipt_date DATE,
    last_issue_date   DATE,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_inv_stock_balance UNIQUE (item_id, location_id)
);

CREATE TABLE inv_valuation_layer (
    layer_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id         INTEGER NOT NULL REFERENCES md_item(item_id),
    location_id     INTEGER NOT NULL REFERENCES md_location(location_id),
    receipt_ledger_id INTEGER NOT NULL REFERENCES mv_stock_ledger(ledger_id),
    receipt_date    DATE   NOT NULL,
    orig_qty        NUMERIC(18,4) NOT NULL,
    remaining_qty   NUMERIC(18,4) NOT NULL,
    unit_cost       NUMERIC(18,4) NOT NULL,
    source_doc_type VARCHAR(10),
    source_doc_id   INTEGER,
    is_open         BOOLEAN NOT NULL DEFAULT TRUE,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT ck_inv_layer_remaining CHECK (remaining_qty >= 0)
);

CREATE TABLE inv_reservation (
    reservation_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id         INTEGER NOT NULL REFERENCES md_item(item_id),
    location_id     INTEGER NOT NULL REFERENCES md_location(location_id),
    reserved_qty    NUMERIC(18,4) NOT NULL,
    source_doc_type VARCHAR(10) NOT NULL,   -- JC|MRQ|ISS
    source_doc_id   INTEGER      NOT NULL,
    source_line_id  INTEGER,
    jobcard_id      INTEGER,                 -- FK tx_jobcard (deferred)
    reservation_status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE|RELEASED|CONSUMED|EXPIRED
    expiry_at       TEXT,
    site_id         INTEGER NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT ck_inv_reservation_status CHECK (reservation_status IN
        ('ACTIVE','RELEASED','CONSUMED','EXPIRED')),
    CONSTRAINT ck_inv_reservation_qty CHECK (reserved_qty > 0)
);

CREATE TABLE inv_pending_price (
    pending_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    grn_id          INTEGER NOT NULL,        -- FK tx_grn (deferred)
    grn_line_id     INTEGER NOT NULL,        -- FK txl_grn (deferred)
    item_id         INTEGER NOT NULL REFERENCES md_item(item_id),
    location_id     INTEGER NOT NULL REFERENCES md_location(location_id),
    received_qty    NUMERIC(18,4) NOT NULL,
    provisional_unit_cost NUMERIC(18,4) NOT NULL,
    provisional_source VARCHAR(10) NOT NULL DEFAULT 'LAST',   -- LAST|PO|MANUAL
    price_status    VARCHAR(12) NOT NULL DEFAULT 'PENDING',   -- PENDING|PROVISIONAL|CONFIRMED
    confirmed_unit_cost NUMERIC(18,4),
    confirmed_price_history_id INTEGER REFERENCES md_price_history(price_history_id),
    reval_ledger_id INTEGER REFERENCES mv_stock_ledger(ledger_id),
    variance_amt    NUMERIC(18,2),
    resolved_by     INTEGER REFERENCES sec_user(user_id),
    resolved_at     TEXT,
    site_id         INTEGER NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT ck_inv_pending_price_status CHECK (price_status IN
        ('PENDING','PROVISIONAL','CONFIRMED'))
);

CREATE TABLE inv_lube_monthly_balance (
    lube_bal_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id       INTEGER NOT NULL REFERENCES md_item(item_id),
    location_id   INTEGER NOT NULL REFERENCES md_location(location_id),
    period_yyyymm INTEGER NOT NULL,
    opening_qty   NUMERIC(18,4) NOT NULL DEFAULT 0,
    receipt_qty   NUMERIC(18,4) NOT NULL DEFAULT 0,
    issue_qty     NUMERIC(18,4) NOT NULL DEFAULT 0,
    adj_qty       NUMERIC(18,4) NOT NULL DEFAULT 0,
    closing_qty   NUMERIC(18,4) NOT NULL DEFAULT 0,
    opening_value NUMERIC(18,2) NOT NULL DEFAULT 0,
    closing_value NUMERIC(18,2) NOT NULL DEFAULT 0,
    avg_cost      NUMERIC(18,4) NOT NULL DEFAULT 0,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_inv_lube_monthly UNIQUE (item_id, location_id, period_yyyymm)
);

-- =====================================================================
-- SECTION 7 — STORES / MATERIAL TRANSACTIONS (tx_ / txl_)
-- =====================================================================

CREATE TABLE tx_mrn (
    mrn_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    mrn_no        VARCHAR(30) NOT NULL,
    mrn_date      DATE NOT NULL,
    location_id   INTEGER NOT NULL REFERENCES md_location(location_id),  -- requesting store
    department_id INTEGER REFERENCES md_department(department_id),
    asset_id      INTEGER REFERENCES md_asset(asset_id),
    jobcard_id    INTEGER,                 -- FK tx_jobcard (deferred)
    required_date DATE,
    priority      VARCHAR(10) NOT NULL DEFAULT 'NORMAL',
    doc_status    VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    requested_by  INTEGER REFERENCES md_employee(employee_id),
    remarks       VARCHAR(300),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_mrn_no UNIQUE (mrn_no)
);

CREATE TABLE txl_mrn (
    mrn_line_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    mrn_id       INTEGER NOT NULL REFERENCES tx_mrn(mrn_id),
    line_no      SMALLINT NOT NULL,
    item_source  VARCHAR(10) NOT NULL DEFAULT 'GENERAL',   -- GENERAL (from master) | OTHER (typed)
    item_id      INTEGER REFERENCES md_item(item_id),       -- GENERAL only: a stockable master item
    item_description      VARCHAR(200),                     -- OTHER only: free-text description
    request_reason        VARCHAR(300),                     -- OTHER: why it's off-catalogue (required)
    suggested_category_id INTEGER REFERENCES md_item_category(category_id),  -- OTHER: helps buyer/promotion
    est_unit_price        NUMERIC(18,4),                    -- OTHER: optional, aids approval threshold
    promoted_item_id      INTEGER REFERENCES md_item(item_id),  -- OTHER: set if later added to the master
    uom_id       INTEGER NOT NULL REFERENCES md_uom(uom_id),
    requested_qty NUMERIC(18,4) NOT NULL,
    approved_qty  NUMERIC(18,4) NOT NULL DEFAULT 0,
    issued_qty    NUMERIC(18,4) NOT NULL DEFAULT 0,
    po_qty        NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_status  VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    remarks      VARCHAR(200),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_txl_mrn_line UNIQUE (mrn_id, line_no),
    -- The two-mode contract: a line is EITHER a master item OR a typed one, never both.
    CONSTRAINT ck_txl_mrn_source CHECK (
        (item_source = 'GENERAL' AND item_id IS NOT NULL AND item_description IS NULL)
     OR (item_source = 'OTHER'   AND item_id IS NULL AND item_description IS NOT NULL AND request_reason IS NOT NULL)
    )
);

-- Append-only audit of MRN status/action transitions (raise, approve, reject, issue, reverse,
-- edit, link). One row per move; from_status is NULL for the opening CREATE. Mirrors
-- hist_jobcard_status (hist_ = immutable history) — the MRN traceability audit spine.
CREATE TABLE hist_mrn_status (
    mrn_status_hist_id INTEGER PRIMARY KEY AUTOINCREMENT,
    mrn_id       INTEGER NOT NULL REFERENCES tx_mrn(mrn_id),
    from_status  VARCHAR(15),
    to_status    VARCHAR(15) NOT NULL,
    action       VARCHAR(20) NOT NULL,   -- CREATE|SUBMIT|APPROVE|REJECT|ISSUE|REVERSE|EDIT|LINK|CANCEL
    note         VARCHAR(300),
    changed_by   INTEGER      NOT NULL REFERENCES sec_user(user_id),
    changed_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    site_id      INTEGER      NOT NULL REFERENCES md_location(location_id)
);
CREATE INDEX ix_hist_mrn_status_mrn ON hist_mrn_status(mrn_id, mrn_status_hist_id);

CREATE TABLE tx_po (
    po_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    po_no        VARCHAR(30) NOT NULL,
    po_date      DATE NOT NULL,
    po_type      VARCHAR(12) NOT NULL DEFAULT 'LOCAL',   -- LOCAL|HEAD_OFFICE
    supplier_id  INTEGER NOT NULL REFERENCES md_supplier(supplier_id),
    location_id  INTEGER NOT NULL REFERENCES md_location(location_id),  -- deliver-to store
    mrn_id       INTEGER REFERENCES tx_mrn(mrn_id),
    delivery_date DATE,
    currency_code CHAR(3) NOT NULL DEFAULT 'LKR',
    total_amt    NUMERIC(18,2) NOT NULL DEFAULT 0,
    terms        VARCHAR(200),
    doc_status   VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    remarks      VARCHAR(300),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_po_no UNIQUE (po_no),
    CONSTRAINT ck_tx_po_type CHECK (po_type IN ('LOCAL','HEAD_OFFICE'))
);

CREATE TABLE txl_po (
    po_line_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id        INTEGER NOT NULL REFERENCES tx_po(po_id),
    line_no      SMALLINT NOT NULL,
    item_id      INTEGER NOT NULL REFERENCES md_item(item_id),
    uom_id       INTEGER NOT NULL REFERENCES md_uom(uom_id),
    order_qty    NUMERIC(18,4) NOT NULL,
    received_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
    unit_price   NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_amt     NUMERIC(18,2) NOT NULL DEFAULT 0,
    expected_date DATE,
    mrn_line_id  INTEGER REFERENCES txl_mrn(mrn_line_id),
    line_status  VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    remarks      VARCHAR(200),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_txl_po_line UNIQUE (po_id, line_no)
);

CREATE TABLE tx_grn (
    grn_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    grn_no        VARCHAR(30) NOT NULL,
    grn_date      DATE NOT NULL,
    po_id         INTEGER REFERENCES tx_po(po_id),
    supplier_id   INTEGER NOT NULL REFERENCES md_supplier(supplier_id),
    location_id   INTEGER NOT NULL REFERENCES md_location(location_id),  -- receiving store
    supplier_dn_no      VARCHAR(40),
    supplier_invoice_no VARCHAR(40),
    currency_code CHAR(3) NOT NULL DEFAULT 'LKR',
    total_qty     NUMERIC(18,4) NOT NULL DEFAULT 0,
    total_amt     NUMERIC(18,2) NOT NULL DEFAULT 0,
    grn_status    VARCHAR(12) NOT NULL DEFAULT 'DRAFT',
    doc_status    VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    received_by   INTEGER REFERENCES md_employee(employee_id),
    remarks       VARCHAR(300),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_grn_no UNIQUE (grn_no),
    CONSTRAINT ck_tx_grn_status CHECK (grn_status IN
        ('DRAFT','RECEIVED','QC_PENDING','QC_PASSED','QC_FAILED','PRICED','POSTED','PARTIAL'))
);

CREATE TABLE txl_grn (
    grn_line_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    grn_id       INTEGER NOT NULL REFERENCES tx_grn(grn_id),
    line_no      SMALLINT NOT NULL,
    item_id      INTEGER NOT NULL REFERENCES md_item(item_id),
    uom_id       INTEGER NOT NULL REFERENCES md_uom(uom_id),
    location_id  INTEGER REFERENCES md_location(location_id),   -- bin
    ordered_qty  NUMERIC(18,4) NOT NULL DEFAULT 0,
    received_qty NUMERIC(18,4) NOT NULL,
    accepted_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
    rejected_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
    unit_price   NUMERIC(18,4),                 -- null while price pending
    line_amt     NUMERIC(18,2) NOT NULL DEFAULT 0,
    is_priced    BOOLEAN NOT NULL DEFAULT FALSE,
    price_status VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    batch_no     VARCHAR(40),
    mfg_date     DATE,
    expiry_date  DATE,
    serial_count INTEGER NOT NULL DEFAULT 0,    -- battery serial count on this line
    po_line_id   INTEGER REFERENCES txl_po(po_line_id),
    ledger_id    INTEGER REFERENCES mv_stock_ledger(ledger_id),
    qc_status    VARCHAR(12),
    remarks      VARCHAR(200),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_txl_grn_line UNIQUE (grn_id, line_no)
);

CREATE TABLE tx_issue (
    issue_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_no      VARCHAR(30) NOT NULL,
    issue_date    DATE NOT NULL,
    location_id   INTEGER NOT NULL REFERENCES md_location(location_id),  -- from store
    issue_type    VARCHAR(10) NOT NULL DEFAULT 'STORE',   -- STORE|GENERAL|JOB
    department_id INTEGER REFERENCES md_department(department_id),
    cost_center_id INTEGER REFERENCES md_cost_center(cost_center_id),
    asset_id      INTEGER REFERENCES md_asset(asset_id),
    jobcard_id    INTEGER,                 -- FK tx_jobcard (deferred)
    mrn_id        INTEGER REFERENCES tx_mrn(mrn_id),
    requested_by  INTEGER REFERENCES md_employee(employee_id),
    issued_to_employee_id INTEGER REFERENCES md_employee(employee_id),
    total_amt     NUMERIC(18,2) NOT NULL DEFAULT 0,
    doc_status    VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    override_by   INTEGER REFERENCES sec_user(user_id),
    override_reason VARCHAR(200),
    remarks       VARCHAR(300),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_issue_no UNIQUE (issue_no),
    CONSTRAINT ck_tx_issue_type CHECK (issue_type IN ('STORE','GENERAL','JOB'))
);

CREATE TABLE txl_issue (
    issue_line_id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id      INTEGER NOT NULL REFERENCES tx_issue(issue_id),
    line_no       SMALLINT NOT NULL,
    item_id       INTEGER NOT NULL REFERENCES md_item(item_id),
    uom_id        INTEGER NOT NULL REFERENCES md_uom(uom_id),
    requested_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
    issued_qty    NUMERIC(18,4) NOT NULL,
    unit_cost     NUMERIC(18,4) NOT NULL DEFAULT 0,   -- MWAC at issue
    line_amt      NUMERIC(18,2) NOT NULL DEFAULT 0,
    batch_no      VARCHAR(40),
    reservation_id INTEGER REFERENCES inv_reservation(reservation_id),
    ledger_id     INTEGER REFERENCES mv_stock_ledger(ledger_id),
    mrn_line_id   INTEGER REFERENCES txl_mrn(mrn_line_id),   -- traceability: the exact MRN line this issue settles (NULL for non-MRN issues)
    remarks       VARCHAR(200),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_txl_issue_line UNIQUE (issue_id, line_no)
);

CREATE TABLE tx_transfer (
    transfer_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_no     VARCHAR(30) NOT NULL,
    transfer_date   DATE NOT NULL,
    from_location_id INTEGER NOT NULL REFERENCES md_location(location_id),
    to_location_id   INTEGER NOT NULL REFERENCES md_location(location_id),
    from_site_id    INTEGER NOT NULL REFERENCES md_location(location_id),
    to_site_id      INTEGER NOT NULL REFERENCES md_location(location_id),
    in_transit      BOOLEAN NOT NULL DEFAULT FALSE,
    received_date   DATE,
    total_amt       NUMERIC(18,2) NOT NULL DEFAULT 0,
    doc_status      VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    remarks         VARCHAR(300),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_transfer_no UNIQUE (transfer_no),
    CONSTRAINT ck_tx_transfer_diff CHECK (from_location_id <> to_location_id)
);

CREATE TABLE txl_transfer (
    transfer_line_id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id   INTEGER NOT NULL REFERENCES tx_transfer(transfer_id),
    line_no       SMALLINT NOT NULL,
    item_id       INTEGER NOT NULL REFERENCES md_item(item_id),
    uom_id        INTEGER NOT NULL REFERENCES md_uom(uom_id),
    transfer_qty  NUMERIC(18,4) NOT NULL,
    received_qty  NUMERIC(18,4) NOT NULL DEFAULT 0,
    unit_cost     NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_amt      NUMERIC(18,2) NOT NULL DEFAULT 0,
    batch_no      VARCHAR(40),
    out_ledger_id INTEGER REFERENCES mv_stock_ledger(ledger_id),
    in_ledger_id  INTEGER REFERENCES mv_stock_ledger(ledger_id),
    remarks       VARCHAR(200),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_txl_transfer_line UNIQUE (transfer_id, line_no)
);

CREATE TABLE tx_adjustment (
    adjustment_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    adjustment_no   VARCHAR(30) NOT NULL,
    adjustment_date DATE NOT NULL,
    location_id     INTEGER NOT NULL REFERENCES md_location(location_id),
    adjustment_type VARCHAR(12) NOT NULL DEFAULT 'COUNT',  -- COUNT|DAMAGE|WRITE_OFF|GAIN
    reason_code     VARCHAR(30),
    total_amt       NUMERIC(18,2) NOT NULL DEFAULT 0,
    doc_status      VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    remarks         VARCHAR(300),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_adjustment_no UNIQUE (adjustment_no)
);

CREATE TABLE txl_adjustment (
    adjustment_line_id INTEGER PRIMARY KEY AUTOINCREMENT,
    adjustment_id INTEGER NOT NULL REFERENCES tx_adjustment(adjustment_id),
    line_no       SMALLINT NOT NULL,
    item_id       INTEGER NOT NULL REFERENCES md_item(item_id),
    uom_id        INTEGER NOT NULL REFERENCES md_uom(uom_id),
    system_qty    NUMERIC(18,4) NOT NULL DEFAULT 0,
    counted_qty   NUMERIC(18,4) NOT NULL DEFAULT 0,
    adjust_qty    NUMERIC(18,4) NOT NULL,          -- signed
    mv_direction  VARCHAR(10) NOT NULL,            -- ADJ_IN|ADJ_OUT
    unit_cost     NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_amt      NUMERIC(18,2) NOT NULL DEFAULT 0,
    batch_no      VARCHAR(40),
    ledger_id     INTEGER REFERENCES mv_stock_ledger(ledger_id),
    remarks       VARCHAR(200),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_txl_adjustment_line UNIQUE (adjustment_id, line_no),
    CONSTRAINT ck_txl_adj_dir CHECK (mv_direction IN ('ADJ_IN','ADJ_OUT'))
);

CREATE TABLE tx_return (
    return_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    return_no    VARCHAR(30) NOT NULL,
    return_date  DATE NOT NULL,
    return_type  VARCHAR(12) NOT NULL DEFAULT 'SUPPLIER',  -- SUPPLIER|STORE_BACK
    supplier_id  INTEGER REFERENCES md_supplier(supplier_id),
    location_id  INTEGER NOT NULL REFERENCES md_location(location_id),
    grn_id       INTEGER REFERENCES tx_grn(grn_id),
    total_amt    NUMERIC(18,2) NOT NULL DEFAULT 0,
    doc_status   VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    remarks      VARCHAR(300),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_return_no UNIQUE (return_no),
    CONSTRAINT ck_tx_return_type CHECK (return_type IN ('SUPPLIER','STORE_BACK'))
);

CREATE TABLE txl_return (
    return_line_id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_id     INTEGER NOT NULL REFERENCES tx_return(return_id),
    line_no       SMALLINT NOT NULL,
    item_id       INTEGER NOT NULL REFERENCES md_item(item_id),
    uom_id        INTEGER NOT NULL REFERENCES md_uom(uom_id),
    return_qty    NUMERIC(18,4) NOT NULL,
    unit_cost     NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_amt      NUMERIC(18,2) NOT NULL DEFAULT 0,
    mv_direction  VARCHAR(10) NOT NULL,            -- RET_OUT|RET_IN
    grn_line_id   INTEGER REFERENCES txl_grn(grn_line_id),
    ledger_id     INTEGER REFERENCES mv_stock_ledger(ledger_id),
    reason        VARCHAR(200),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_txl_return_line UNIQUE (return_id, line_no),
    CONSTRAINT ck_txl_return_dir CHECK (mv_direction IN ('RET_OUT','RET_IN'))
);

-- =====================================================================
-- SECTION 8 — LUBRICANT ISSUE (meter-traceable consumption)
-- =====================================================================

CREATE TABLE tx_lube_issue (
    lube_issue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    lube_issue_no VARCHAR(30) NOT NULL,
    issue_date    DATE NOT NULL,
    location_id   INTEGER NOT NULL REFERENCES md_location(location_id),  -- from store
    asset_id      INTEGER REFERENCES md_asset(asset_id),
    department_id INTEGER REFERENCES md_department(department_id),
    meter_reading NUMERIC(18,2),
    meter_type    VARCHAR(4),                 -- KM|HR
    issued_to_employee_id INTEGER REFERENCES md_employee(employee_id),
    jobcard_id    INTEGER,                 -- FK tx_jobcard (deferred)
    total_qty     NUMERIC(18,4) NOT NULL DEFAULT 0,
    total_amt     NUMERIC(18,2) NOT NULL DEFAULT 0,
    doc_status    VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    remarks       VARCHAR(300),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_lube_issue_no UNIQUE (lube_issue_no),
    -- Contract rule 5: traceable to asset OR to (site + department)
    CONSTRAINT ck_tx_lube_target CHECK (asset_id IS NOT NULL OR department_id IS NOT NULL),
    CONSTRAINT ck_tx_lube_meter CHECK (meter_type IS NULL OR meter_type IN ('KM','HR'))
);

CREATE TABLE txl_lube_issue (
    lube_line_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    lube_issue_id INTEGER NOT NULL REFERENCES tx_lube_issue(lube_issue_id),
    line_no       SMALLINT NOT NULL,
    item_id       INTEGER NOT NULL REFERENCES md_item(item_id),   -- item_type = LUBRICANT
    uom_id        INTEGER NOT NULL REFERENCES md_uom(uom_id),
    issue_qty     NUMERIC(18,4) NOT NULL,
    unit_cost     NUMERIC(18,4) NOT NULL DEFAULT 0,   -- MWAC at issue
    line_amt      NUMERIC(18,2) NOT NULL DEFAULT 0,
    batch_no      VARCHAR(40),
    prev_meter    NUMERIC(18,2),
    consumption_since_last NUMERIC(18,2),
    ledger_id     INTEGER REFERENCES mv_stock_ledger(ledger_id),
    remarks       VARCHAR(200),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_txl_lube_line UNIQUE (lube_issue_id, line_no)
);

-- =====================================================================
-- SECTION 9 — BATTERY TRANSACTIONS + SERIAL LIFECYCLE LOG
-- =====================================================================

CREATE TABLE tx_battery_issue (
    battery_issue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    battery_issue_no VARCHAR(30) NOT NULL,
    issue_date       DATE NOT NULL,
    battery_id       INTEGER NOT NULL REFERENCES md_battery(battery_id),
    item_id          INTEGER NOT NULL REFERENCES md_item(item_id),
    from_location_id INTEGER NOT NULL REFERENCES md_location(location_id),
    to_asset_id      INTEGER NOT NULL REFERENCES md_asset(asset_id),
    meter_reading    NUMERIC(18,2),
    installed_by_employee_id INTEGER REFERENCES md_employee(employee_id),
    jobcard_id       INTEGER,                 -- FK tx_jobcard (deferred)
    warranty_start_date DATE,
    battery_status_after VARCHAR(22) NOT NULL DEFAULT 'IN_SERVICE',
    ledger_id        INTEGER REFERENCES mv_stock_ledger(ledger_id),  -- OUT of serialized stock
    hist_event_id    INTEGER,                 -- FK hist_battery_event (deferred)
    doc_status       VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    remarks          VARCHAR(300),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_battery_issue_no UNIQUE (battery_issue_no)
);

CREATE TABLE tx_battery_transfer (
    battery_transfer_id INTEGER PRIMARY KEY AUTOINCREMENT,
    battery_transfer_no VARCHAR(30) NOT NULL,
    transfer_date  DATE NOT NULL,
    battery_id     INTEGER NOT NULL REFERENCES md_battery(battery_id),
    from_asset_id  INTEGER REFERENCES md_asset(asset_id),
    to_asset_id    INTEGER NOT NULL REFERENCES md_asset(asset_id),
    from_meter     NUMERIC(18,2),
    to_meter       NUMERIC(18,2),
    reason         VARCHAR(200),
    battery_status_after VARCHAR(22) NOT NULL DEFAULT 'IN_SERVICE',
    hist_event_id  INTEGER,                 -- FK hist_battery_event (deferred)
    doc_status     VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    remarks        VARCHAR(300),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_battery_transfer_no UNIQUE (battery_transfer_no),
    CONSTRAINT ck_tx_battery_transfer_diff CHECK (from_asset_id IS NULL OR from_asset_id <> to_asset_id)
);

CREATE TABLE tx_battery_return (
    battery_return_id INTEGER PRIMARY KEY AUTOINCREMENT,
    battery_return_no VARCHAR(30) NOT NULL,
    return_date    DATE NOT NULL,
    battery_id     INTEGER NOT NULL REFERENCES md_battery(battery_id),
    from_asset_id  INTEGER REFERENCES md_asset(asset_id),
    to_location_id INTEGER NOT NULL REFERENCES md_location(location_id),
    return_type    VARCHAR(12) NOT NULL,   -- RETURN|REPLACEMENT|SCRAP|WARRANTY|LOST|REPAIR
    replacement_battery_id INTEGER REFERENCES md_battery(battery_id),
    warranty_term_id INTEGER REFERENCES md_warranty_term(warranty_term_id),
    warranty_claim_no VARCHAR(40),
    condition_note VARCHAR(200),
    meter_reading  NUMERIC(18,2),
    battery_status_after VARCHAR(22) NOT NULL,
    ledger_id      INTEGER REFERENCES mv_stock_ledger(ledger_id),  -- IN to stock if returned
    hist_event_id  INTEGER,                 -- FK hist_battery_event (deferred)
    doc_status     VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    remarks        VARCHAR(300),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_battery_return_no UNIQUE (battery_return_no),
    CONSTRAINT ck_tx_battery_return_type CHECK (return_type IN
        ('RETURN','REPLACEMENT','SCRAP','WARRANTY','LOST','REPAIR')),
    CONSTRAINT ck_tx_battery_return_status CHECK (battery_status_after IN
        ('IN_STOCK','RETURNED','UNDER_WARRANTY_CLAIM','REPAIRED','SCRAPPED','REPLACED','LOST'))
);

CREATE TABLE hist_battery_event (
    event_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    battery_id     INTEGER NOT NULL REFERENCES md_battery(battery_id),
    event_seq      INTEGER NOT NULL,
    event_type     VARCHAR(15) NOT NULL,   -- RECEIVED|ISSUED|INSTALLED|TRANSFERRED|RETURNED|WARRANTY_CLAIM|REPAIRED|SCRAPPED|REPLACED|LOST|ADJUSTED
    event_date     DATE NOT NULL,
    from_asset_id  INTEGER REFERENCES md_asset(asset_id),
    to_asset_id    INTEGER REFERENCES md_asset(asset_id),
    from_location_id INTEGER REFERENCES md_location(location_id),
    to_location_id   INTEGER REFERENCES md_location(location_id),
    meter_reading  NUMERIC(18,2),
    from_status    VARCHAR(22),
    to_status      VARCHAR(22) NOT NULL,
    source_doc_type VARCHAR(10) NOT NULL,  -- GRN|BAT|BTR|BRT|ADJ
    source_doc_id   INTEGER,
    source_doc_no   VARCHAR(30),
    replacement_battery_id INTEGER REFERENCES md_battery(battery_id),
    event_value_amt NUMERIC(18,2),
    remarks        VARCHAR(300),
    site_id        INTEGER NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_hist_battery_event UNIQUE (battery_id, event_seq),
    CONSTRAINT ck_hist_battery_event_type CHECK (event_type IN
        ('RECEIVED','ISSUED','INSTALLED','TRANSFERRED','RETURNED','WARRANTY_CLAIM',
         'REPAIRED','SCRAPPED','REPLACED','LOST','ADJUSTED'))
);

-- =====================================================================
-- SECTION 10 — WORKSHOP JOB CARD + JOB COSTING
-- =====================================================================

CREATE TABLE tx_jobcard (
    jobcard_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    jobcard_no     VARCHAR(30) NOT NULL,
    jobcard_date   DATE NOT NULL,
    promised_date  DATE,                                     -- SLA/promised completion; drives Overdue/Delayed KPI
    asset_id       INTEGER NOT NULL REFERENCES md_asset(asset_id),
    location_id    INTEGER NOT NULL REFERENCES md_location(location_id),  -- workshop
    job_type       VARCHAR(14) NOT NULL DEFAULT 'BREAKDOWN', -- BREAKDOWN|PREVENTIVE|ACCIDENT|RUNNING_REPAIR|INSPECTION|GENERAL
    priority       VARCHAR(10) NOT NULL DEFAULT 'NORMAL',
    reported_by_employee_id INTEGER REFERENCES md_employee(employee_id),
    reported_defect TEXT,
    meter_reading  NUMERIC(18,2),
    meter_type     VARCHAR(4),
    assigned_to_employee_id INTEGER REFERENCES md_employee(employee_id),
    project_id     INTEGER REFERENCES md_project(project_id),
    department_id  INTEGER REFERENCES md_department(department_id),
    cost_center_id INTEGER REFERENCES md_cost_center(cost_center_id),
    estimated_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_job_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
    jobcard_status VARCHAR(28) NOT NULL DEFAULT 'DRAFT',
    doc_status     VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    tm_approved_by INTEGER REFERENCES sec_user(user_id),
    tm_approved_at TEXT,
    om_approved_by INTEGER REFERENCES sec_user(user_id),
    om_approved_at TEXT,
    opened_at      TEXT,
    work_started_at TEXT,
    work_completed_at TEXT,
    closed_at      TEXT,
    hold_reason    VARCHAR(300),
    remarks        VARCHAR(400),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_jobcard_no UNIQUE (jobcard_no),
    CONSTRAINT ck_tx_jobcard_type CHECK (job_type IN
        ('BREAKDOWN','PREVENTIVE','ACCIDENT','RUNNING_REPAIR','INSPECTION','GENERAL')),
    CONSTRAINT ck_tx_jobcard_status CHECK (jobcard_status IN
        ('DRAFT','PENDING_TM_APPROVAL','PENDING_OM_APPROVAL','APPROVED',
         'ASSIGNED_WORKSHOP','IN_PROGRESS','AWAITING_PARTS','AWAITING_OUTSIDE_REPAIR',
         'WORK_COMPLETED','PENDING_COSTING','PENDING_CLOSURE','CLOSED',
         'ON_HOLD','CANCELLED','REJECTED'))
);

CREATE TABLE txl_jobcard_task (
    task_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    jobcard_id     INTEGER NOT NULL REFERENCES tx_jobcard(jobcard_id),
    line_no        SMALLINT NOT NULL,
    task_code      VARCHAR(30),
    task_description TEXT NOT NULL,
    defect_type    VARCHAR(30),
    assigned_to_employee_id INTEGER REFERENCES md_employee(employee_id),
    task_status    VARCHAR(12) NOT NULL DEFAULT 'PENDING',  -- PENDING|IN_PROGRESS|COMPLETED|CANCELLED
    estimated_hours NUMERIC(9,2) NOT NULL DEFAULT 0,
    actual_hours   NUMERIC(9,2) NOT NULL DEFAULT 0,
    started_at     TEXT,
    completed_at   TEXT,
    remarks        VARCHAR(300),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_txl_jobcard_task UNIQUE (jobcard_id, line_no),
    CONSTRAINT ck_txl_jobcard_task_status CHECK (task_status IN
        ('PENDING','IN_PROGRESS','COMPLETED','CANCELLED'))
);

CREATE TABLE tx_job_progress (
    progress_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    jobcard_id     INTEGER NOT NULL REFERENCES tx_jobcard(jobcard_id),
    task_id        INTEGER REFERENCES txl_jobcard_task(task_id),
    progress_date  DATE NOT NULL,
    work_done      TEXT NOT NULL,
    pct_complete   NUMERIC(5,2) NOT NULL DEFAULT 0,
    hours_spent    NUMERIC(9,2) NOT NULL DEFAULT 0,
    logged_by_employee_id INTEGER REFERENCES md_employee(employee_id),
    status_snapshot VARCHAR(28),
    next_action    VARCHAR(300),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE TABLE tx_job_material_req (
    mrq_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    mrq_no       VARCHAR(30) NOT NULL,
    mrq_date     DATE NOT NULL,
    jobcard_id   INTEGER NOT NULL REFERENCES tx_jobcard(jobcard_id),
    location_id  INTEGER NOT NULL REFERENCES md_location(location_id),  -- store
    req_type     VARCHAR(10) NOT NULL DEFAULT 'INTERNAL',  -- INTERNAL|EXTERNAL
    requested_by INTEGER REFERENCES md_employee(employee_id),
    doc_status   VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    remarks      VARCHAR(300),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_job_material_req_no UNIQUE (mrq_no),
    CONSTRAINT ck_tx_job_mrq_type CHECK (req_type IN ('INTERNAL','EXTERNAL'))
);

CREATE TABLE txl_job_material_req (
    mrq_line_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    mrq_id       INTEGER NOT NULL REFERENCES tx_job_material_req(mrq_id),
    line_no      SMALLINT NOT NULL,
    item_id      INTEGER NOT NULL REFERENCES md_item(item_id),
    uom_id       INTEGER NOT NULL REFERENCES md_uom(uom_id),
    task_id      INTEGER REFERENCES txl_jobcard_task(task_id),
    requested_qty NUMERIC(18,4) NOT NULL,
    approved_qty  NUMERIC(18,4) NOT NULL DEFAULT 0,
    issued_qty    NUMERIC(18,4) NOT NULL DEFAULT 0,
    reservation_id INTEGER REFERENCES inv_reservation(reservation_id),
    line_status  VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    remarks      VARCHAR(200),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_txl_job_material_req UNIQUE (mrq_id, line_no)
);

CREATE TABLE tx_job_parts (
    job_part_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    jobcard_id   INTEGER NOT NULL REFERENCES tx_jobcard(jobcard_id),
    task_id      INTEGER REFERENCES txl_jobcard_task(task_id),
    item_id      INTEGER NOT NULL REFERENCES md_item(item_id),
    uom_id       INTEGER NOT NULL REFERENCES md_uom(uom_id),
    qty          NUMERIC(18,4) NOT NULL,
    unit_cost    NUMERIC(18,4) NOT NULL DEFAULT 0,
    part_cost    NUMERIC(18,2) NOT NULL DEFAULT 0,
    source_type  VARCHAR(10) NOT NULL DEFAULT 'ISSUE',   -- ISSUE|GRN|DIRECT
    source_doc_type VARCHAR(10),
    source_doc_id   INTEGER,
    source_line_id  INTEGER,
    issue_line_id INTEGER REFERENCES txl_issue(issue_line_id),
    mrq_id        INTEGER REFERENCES tx_job_material_req(mrq_id),
    ledger_id     INTEGER REFERENCES mv_stock_ledger(ledger_id),
    is_returned   BOOLEAN NOT NULL DEFAULT FALSE,
    is_general    BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE = general item; rolls to general_cost not material_cost
    is_provisional BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE = valued at provisional price pending confirmation
    remarks       VARCHAR(200),
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT ck_tx_job_parts_source CHECK (source_type IN ('ISSUE','GRN','DIRECT'))
);

CREATE TABLE tx_job_labour (
    labour_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    labour_no    VARCHAR(30) NOT NULL,
    jobcard_id   INTEGER NOT NULL REFERENCES tx_jobcard(jobcard_id),
    task_id      INTEGER REFERENCES txl_jobcard_task(task_id),
    employee_id  INTEGER NOT NULL REFERENCES md_employee(employee_id),
    labour_date  DATE NOT NULL,
    start_time   TIME,
    end_time     TIME,
    hours        NUMERIC(9,2) NOT NULL DEFAULT 0,
    ot_hours     NUMERIC(9,2) NOT NULL DEFAULT 0,
    grade_id     INTEGER REFERENCES md_employee_grade(grade_id),
    labour_rate_id INTEGER REFERENCES md_labour_rate(labour_rate_id),
    hourly_rate  NUMERIC(18,2) NOT NULL DEFAULT 0,
    labour_cost  NUMERIC(18,2) NOT NULL DEFAULT 0,
    doc_status   VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    remarks      VARCHAR(200),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_job_labour_no UNIQUE (labour_no)
);

CREATE TABLE tx_job_outside_repair (
    osr_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    osr_no       VARCHAR(30) NOT NULL,
    jobcard_id   INTEGER NOT NULL REFERENCES tx_jobcard(jobcard_id),
    task_id      INTEGER REFERENCES txl_jobcard_task(task_id),
    subcontractor_id INTEGER NOT NULL REFERENCES md_supplier(supplier_id),
    description  TEXT,
    sent_date    DATE,
    expected_return_date DATE,
    actual_return_date   DATE,
    po_id        INTEGER REFERENCES tx_po(po_id),
    grn_id       INTEGER REFERENCES tx_grn(grn_id),
    invoice_no   VARCHAR(40),
    estimated_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
    actual_cost  NUMERIC(18,2) NOT NULL DEFAULT 0,
    osr_status   VARCHAR(12) NOT NULL DEFAULT 'SENT',  -- SENT|IN_PROGRESS|RECEIVED|INVOICED|CLOSED
    doc_status   VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    remarks      VARCHAR(300),
    approved_by INTEGER      REFERENCES sec_user(user_id),
    approved_at TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tx_job_osr_no UNIQUE (osr_no),
    CONSTRAINT ck_tx_job_osr_status CHECK (osr_status IN
        ('SENT','IN_PROGRESS','RECEIVED','INVOICED','CLOSED'))
);

-- ---------- Job cost roll-up ----------

CREATE TABLE cost_job_summary (
    summary_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    jobcard_id   INTEGER NOT NULL REFERENCES tx_jobcard(jobcard_id),
    material_cost       NUMERIC(18,2) NOT NULL DEFAULT 0,
    labour_cost         NUMERIC(18,2) NOT NULL DEFAULT 0,
    outside_repair_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
    general_cost        NUMERIC(18,2) NOT NULL DEFAULT 0,
    overhead_cost       NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_job_cost      NUMERIC(18,2) NOT NULL DEFAULT 0,
    estimated_cost      NUMERIC(18,2) NOT NULL DEFAULT 0,
    variance_amt        NUMERIC(18,2) NOT NULL DEFAULT 0,
    variance_pct        NUMERIC(9,4)  NOT NULL DEFAULT 0,
    currency_code CHAR(3) NOT NULL DEFAULT 'LKR',
    is_provisional BOOLEAN NOT NULL DEFAULT FALSE,       -- TRUE while any provisional-priced cost line exists (blocks close)
    cost_status  VARCHAR(12) NOT NULL DEFAULT 'DRAFT',  -- DRAFT|CALCULATED|FINALIZED
    calculated_at TEXT,
    finalized_by  INTEGER REFERENCES sec_user(user_id),
    finalized_at  TEXT,
    site_id     INTEGER      NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_cost_job_summary UNIQUE (jobcard_id),
    CONSTRAINT ck_cost_job_summary_status CHECK (cost_status IN ('DRAFT','CALCULATED','FINALIZED'))
);

CREATE TABLE cost_job_line (
    cost_line_id INTEGER PRIMARY KEY AUTOINCREMENT,
    jobcard_id   INTEGER NOT NULL REFERENCES tx_jobcard(jobcard_id),
    summary_id   INTEGER REFERENCES cost_job_summary(summary_id),
    cost_element VARCHAR(10) NOT NULL,   -- MATERIAL|LABOUR|OUTSIDE|GENERAL|OVERHEAD
    source_doc_type VARCHAR(10),
    source_doc_id   INTEGER,
    source_line_id  INTEGER,
    item_id      INTEGER REFERENCES md_item(item_id),
    employee_id  INTEGER REFERENCES md_employee(employee_id),
    task_id      INTEGER REFERENCES txl_jobcard_task(task_id),
    qty          NUMERIC(18,4) NOT NULL DEFAULT 0,
    unit_cost    NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_cost    NUMERIC(18,2) NOT NULL DEFAULT 0,
    cost_date    DATE,
    is_provisional BOOLEAN NOT NULL DEFAULT FALSE,
    remarks      VARCHAR(200),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT ck_cost_job_line_element CHECK (cost_element IN
        ('MATERIAL','LABOUR','OUTSIDE','GENERAL','OVERHEAD'))
);

-- Append-only audit of job-card status transitions (the two-level approval workflow and close).
-- One row per move: who changed it, from -> to, when, and an optional note. from_status is NULL for
-- the opening transition. Mirrors the hist_battery_event pattern (hist_ = immutable history).
CREATE TABLE hist_jobcard_status (
    jc_status_hist_id INTEGER PRIMARY KEY AUTOINCREMENT,
    jobcard_id   INTEGER NOT NULL REFERENCES tx_jobcard(jobcard_id),
    from_status  VARCHAR(28),
    to_status    VARCHAR(28) NOT NULL,
    note         VARCHAR(300),
    changed_by   INTEGER      NOT NULL REFERENCES sec_user(user_id),
    changed_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    site_id      INTEGER      NOT NULL REFERENCES md_location(location_id)
);
CREATE INDEX ix_hist_jobcard_status_jc ON hist_jobcard_status(jobcard_id, jc_status_hist_id);

CREATE TABLE cost_variance (
    variance_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    jobcard_id   INTEGER NOT NULL REFERENCES tx_jobcard(jobcard_id),
    summary_id   INTEGER REFERENCES cost_job_summary(summary_id),
    cost_element VARCHAR(10) NOT NULL,
    estimated_amt NUMERIC(18,2) NOT NULL DEFAULT 0,
    actual_amt    NUMERIC(18,2) NOT NULL DEFAULT 0,
    variance_amt  NUMERIC(18,2) NOT NULL DEFAULT 0,
    variance_pct  NUMERIC(9,4)  NOT NULL DEFAULT 0,
    variance_reason VARCHAR(300),
    is_flagged_recompute BOOLEAN NOT NULL DEFAULT FALSE,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT ck_cost_variance_element CHECK (cost_element IN
        ('MATERIAL','LABOUR','OUTSIDE','GENERAL','OVERHEAD','TOTAL'))
);

-- =====================================================================
-- SECTION 11 — APPROVAL / WORKFLOW INSTANCES (generic, all modules)
-- =====================================================================

CREATE TABLE apr_request (
    request_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    request_no     VARCHAR(30),
    workflow_id    INTEGER NOT NULL REFERENCES sys_workflow(workflow_id),
    source_doc_type VARCHAR(10) NOT NULL,   -- JC|PO|GRN|ADJ|BRT|MRQ...
    source_doc_id   INTEGER NOT NULL,
    source_doc_no   VARCHAR(30),
    current_step_no SMALLINT NOT NULL DEFAULT 1,
    apr_status     VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    amount         NUMERIC(18,2),
    requested_by   INTEGER NOT NULL REFERENCES sec_user(user_id),
    requested_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at   TEXT,
    site_id        INTEGER NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT ck_apr_request_status CHECK (apr_status IN
        ('PENDING','APPROVED','REJECTED','RETURNED','ESCALATED','DELEGATED'))
);

CREATE TABLE apr_step (
    apr_step_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id     INTEGER NOT NULL REFERENCES apr_request(request_id),
    step_no        SMALLINT NOT NULL,
    workflow_step_id INTEGER REFERENCES sys_workflow_step(step_id),
    assigned_role_id INTEGER REFERENCES sec_role(role_id),
    assigned_user_id INTEGER REFERENCES sec_user(user_id),
    step_status    VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    acted_by       INTEGER REFERENCES sec_user(user_id),
    acted_at       TEXT,
    due_at         TEXT,
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER      REFERENCES sec_user(user_id),
    updated_at TEXT,
    row_version INTEGER    NOT NULL DEFAULT 1,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_apr_step UNIQUE (request_id, step_no),
    CONSTRAINT ck_apr_step_status CHECK (step_status IN
        ('PENDING','APPROVED','REJECTED','RETURNED','ESCALATED','DELEGATED'))
);

CREATE TABLE apr_action (
    action_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id   INTEGER NOT NULL REFERENCES apr_request(request_id),
    apr_step_id  INTEGER NOT NULL REFERENCES apr_step(apr_step_id),
    action_type  VARCHAR(10) NOT NULL,   -- SUBMIT|APPROVE|REJECT|RETURN|ESCALATE|DELEGATE
    action_by    INTEGER NOT NULL REFERENCES sec_user(user_id),
    action_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    from_status  VARCHAR(12),
    to_status    VARCHAR(12),
    delegated_to INTEGER REFERENCES sec_user(user_id),
    comments     VARCHAR(400),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_apr_action_type CHECK (action_type IN
        ('SUBMIT','APPROVE','REJECT','RETURN','ESCALATE','DELEGATE'))
);

-- =====================================================================
-- SECTION 12 — ATTACHMENTS
-- =====================================================================

CREATE TABLE doc_attachment (
    attachment_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    source_doc_type VARCHAR(10) NOT NULL,
    source_doc_id   INTEGER NOT NULL,
    doc_category   VARCHAR(25) NOT NULL,   -- GRN_SCAN|BATTERY_SERIAL_PHOTO|INVOICE|WARRANTY|OTHER
    file_name      VARCHAR(200) NOT NULL,
    file_url       VARCHAR(400) NOT NULL,
    mime_type      VARCHAR(80),
    file_size      INTEGER,
    checksum_sha256 VARCHAR(64),                    -- integrity / de-dup of uploaded proof files
    link_role      VARCHAR(20),                     -- PRIMARY|SUPPORTING|PROOF|SIGNATURE
    is_primary     BOOLEAN NOT NULL DEFAULT FALSE,  -- primary attachment for the source document
    site_id        INTEGER NOT NULL REFERENCES md_location(location_id),
    created_by INTEGER      NOT NULL REFERENCES sec_user(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE
);

-- =====================================================================
-- SECTION 13 — DEFERRED CROSS-REFERENCE FOREIGN KEYS
--   (added here because target tables are declared later above)
-- =====================================================================

-- =====================================================================
-- SECTION 14 — INDEXES (hot paths: ledger scan, balance lookup,
--   price-as-of-date, serial history, approvals, job costing)
-- =====================================================================

-- Ledger: the append-only spine. Balance rebuild scans by item x location x seq.
CREATE INDEX ix_mv_ledger_item_loc      ON mv_stock_ledger (item_id, location_id, ledger_id);
CREATE INDEX ix_mv_ledger_source        ON mv_stock_ledger (source_doc_type, source_doc_id, source_line_id);
CREATE INDEX ix_mv_ledger_date          ON mv_stock_ledger (movement_date);
CREATE INDEX ix_mv_ledger_location      ON mv_stock_ledger (location_id, movement_date);
CREATE INDEX ix_mv_ledger_battery       ON mv_stock_ledger (battery_id)  WHERE battery_id IS NOT NULL;
CREATE INDEX ix_mv_ledger_serial        ON mv_stock_ledger (serial_no)   WHERE serial_no IS NOT NULL;
CREATE INDEX ix_mv_ledger_provisional   ON mv_stock_ledger (is_provisional) WHERE is_provisional = TRUE;

-- Balance: on-hand/available lookups, reorder scans.
CREATE INDEX ix_inv_balance_location    ON inv_stock_balance (location_id, item_id);
CREATE INDEX ix_inv_balance_low         ON inv_stock_balance (item_id) WHERE on_hand_qty <= 0;

-- Valuation layers (FIFO consumption: oldest open layer first).
CREATE INDEX ix_inv_val_layer_fifo      ON inv_valuation_layer (item_id, location_id, receipt_date, layer_id)
                                        WHERE is_open = TRUE;

-- Reservations (availability netting + release on job close).
CREATE INDEX ix_inv_reservation_item    ON inv_reservation (item_id, location_id, reservation_status);
CREATE INDEX ix_inv_reservation_job     ON inv_reservation (jobcard_id) WHERE jobcard_id IS NOT NULL;

-- Pending price queue (the un-priced worklist + job-close gate).
CREATE INDEX ix_inv_pending_status      ON inv_pending_price (price_status) WHERE price_status <> 'CONFIRMED';
CREATE INDEX ix_inv_pending_grn         ON inv_pending_price (grn_id);
CREATE INDEX ix_inv_pending_item        ON inv_pending_price (item_id, location_id);

-- Price-as-of-date (costing reads price effective on the transaction date).
CREATE INDEX ix_md_price_hist_asof      ON md_price_history (item_id, effective_date DESC);
CREATE INDEX ix_md_price_hist_scope     ON md_price_history (item_id, supplier_id, site_id, effective_date DESC);
CREATE INDEX ix_md_price_current        ON md_price (item_id, site_id, price_status);

-- Battery serial state + full lifecycle reconstruction.
CREATE INDEX ix_md_battery_current_asset ON md_battery (current_asset_id) WHERE current_asset_id IS NOT NULL;
CREATE INDEX ix_md_battery_item          ON md_battery (item_id);
CREATE INDEX ix_md_battery_status        ON md_battery (battery_status);
CREATE INDEX ix_hist_battery_serial      ON hist_battery_event (battery_id, event_seq);
CREATE INDEX ix_hist_battery_date        ON hist_battery_event (battery_id, event_date);
CREATE INDEX ix_hist_battery_asset       ON hist_battery_event (to_asset_id);

-- Item master lookups.
CREATE INDEX ix_md_item_type            ON md_item (item_type) WHERE is_active = TRUE;
CREATE INDEX ix_md_item_category        ON md_item (category_id);

-- Transaction header lookups by site/date/status (day-book, worklists).
CREATE INDEX ix_tx_grn_site_date        ON tx_grn (site_id, grn_date);
CREATE INDEX ix_tx_grn_status           ON tx_grn (grn_status);
CREATE INDEX ix_tx_issue_site_date      ON tx_issue (site_id, issue_date);
CREATE INDEX ix_tx_issue_asset          ON tx_issue (asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX ix_tx_transfer_from        ON tx_transfer (from_location_id, transfer_date);
CREATE INDEX ix_tx_lube_asset           ON tx_lube_issue (asset_id, issue_date);

-- MRN traceability + global search: header worklists (site/date/status/store/asset/job),
-- line rollups, and the issue<->MRN join that reconstructs MRN -> issue -> ledger.
CREATE INDEX ix_tx_mrn_site_date        ON tx_mrn (site_id, mrn_date);
CREATE INDEX ix_tx_mrn_status           ON tx_mrn (doc_status);
CREATE INDEX ix_tx_mrn_location         ON tx_mrn (location_id);
CREATE INDEX ix_tx_mrn_asset            ON tx_mrn (asset_id)   WHERE asset_id IS NOT NULL;
CREATE INDEX ix_tx_mrn_jobcard          ON tx_mrn (jobcard_id) WHERE jobcard_id IS NOT NULL;
CREATE INDEX ix_txl_mrn_item            ON txl_mrn (item_id);
CREATE INDEX ix_txl_mrn_status          ON txl_mrn (line_status);
CREATE INDEX ix_tx_issue_mrn            ON tx_issue (mrn_id)   WHERE mrn_id IS NOT NULL;
CREATE INDEX ix_txl_issue_mrn_line      ON txl_issue (mrn_line_id) WHERE mrn_line_id IS NOT NULL;

-- Job card worklists + costing joins.
CREATE INDEX ix_tx_jobcard_asset        ON tx_jobcard (asset_id, jobcard_date);
CREATE INDEX ix_tx_jobcard_status       ON tx_jobcard (jobcard_status, site_id);
CREATE INDEX ix_tx_job_parts_job        ON tx_job_parts (jobcard_id);
CREATE INDEX ix_tx_job_labour_job       ON tx_job_labour (jobcard_id);
CREATE INDEX ix_tx_job_labour_emp       ON tx_job_labour (employee_id, labour_date);
CREATE INDEX ix_tx_job_osr_job          ON tx_job_outside_repair (jobcard_id);
CREATE INDEX ix_cost_job_line_job       ON cost_job_line (jobcard_id, cost_element);

-- Approval worklists (my pending steps; document -> request).
CREATE INDEX ix_apr_request_source      ON apr_request (source_doc_type, source_doc_id);
CREATE INDEX ix_apr_request_status      ON apr_request (apr_status) WHERE apr_status = 'PENDING';
CREATE INDEX ix_apr_step_open           ON apr_step (assigned_role_id, step_status) WHERE step_status = 'PENDING';
CREATE INDEX ix_apr_action_request      ON apr_action (request_id, action_at);

-- Security resolution (row-level site visibility).
CREATE INDEX ix_sec_user_site_user      ON sec_user_site (user_id);
CREATE INDEX ix_sec_user_role_user      ON sec_user_role (user_id);

-- Number series concurrency (SELECT ... FOR UPDATE key).
CREATE INDEX ix_sys_number_series_key   ON sys_number_series (doc_type, site_id, year_yy);

-- Attachments back-reference.
CREATE INDEX ix_doc_attachment_source   ON doc_attachment (source_doc_type, source_doc_id);

-- =====================================================================
-- END OF SCHEMA
-- =====================================================================
