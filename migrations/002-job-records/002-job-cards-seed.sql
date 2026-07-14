-- =====================================================================
-- 002-job-cards-seed.sql — staging schema for the legacy Excel job-record import
-- (Job_Record_Requested_and_Cjob.xlsx → migrate-job-records.js).
--
-- These wk_* tables are a SELF-CONTAINED staging area for ~3k historical job
-- records (2023–2026). They are deliberately kept OUT of the live Workshop
-- tables (tx_jobcard / md_asset / md_location) so a bulk history import can't
-- corrupt the live approval-workflow data and is trivially reversible (DROP the
-- wk_* tables). A later reconciliation step can promote selected rows into
-- tx_jobcard if desired.
--
-- Natural keys (job_card_no / asset_code / site_name) are used instead of
-- surrogate identities so the same DDL runs unchanged on PostgreSQL and (via the
-- app's db.js translation of now()/TIMESTAMPTZ) on SQLite.
-- =====================================================================

CREATE TABLE IF NOT EXISTS wk_site (
    site_name      VARCHAR(120) PRIMARY KEY,   -- normalised display name
    is_nonstandard BOOLEAN     NOT NULL DEFAULT FALSE,   -- e.g. TR-01, W/S C-com, H/O, solution
    job_count      INTEGER     NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wk_asset (
    asset_code   VARCHAR(60)  PRIMARY KEY,      -- reg. no (LO-5981) or EQP-<name> for equipment
    asset_name   VARCHAR(150) NOT NULL,         -- original vehicle/equipment label
    is_equipment BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wk_job_card (
    job_card_no     VARCHAR(40)  PRIMARY KEY,   -- natural key, e.g. 2023/3/R/27
    asset_code      VARCHAR(60)  REFERENCES wk_asset(asset_code),
    site_name       VARCHAR(120) REFERENCES wk_site(site_name),
    work_desc       TEXT,
    date_opened     DATE,
    date_closed     DATE,
    status          VARCHAR(12)  NOT NULL,      -- OPEN | CLOSED | PENDING | CANCELLED
    job_type        VARCHAR(10),                -- MAJOR | MINOR | NULL (source column is empty in this file)
    remarks         TEXT,
    odometer_at_job NUMERIC(14,2),              -- extracted from remarks/description (e.g. 135198)
    odometer_unit   VARCHAR(6),                 -- Km | Hrs
    hours           NUMERIC(12,2),              -- C-job "Hrs"
    cost            NUMERIC(18,2),              -- C-job "Cost" (LKR)
    ref_no          VARCHAR(40),                -- C-job "Ref."
    source_sheet    VARCHAR(20),                -- 'Requested job' | 'C-job'
    source_import   VARCHAR(40)  NOT NULL DEFAULT 'EXCEL_MIGRATION_2026',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT ck_wk_job_card_status CHECK (status IN ('OPEN','CLOSED','PENDING','CANCELLED'))
);

CREATE TABLE IF NOT EXISTS import_warnings (
    job_card_no  VARCHAR(40),
    warning_type VARCHAR(40),
    detail       VARCHAR(400),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_wk_job_card_asset  ON wk_job_card(asset_code);
CREATE INDEX IF NOT EXISTS ix_wk_job_card_site   ON wk_job_card(site_name);
CREATE INDEX IF NOT EXISTS ix_wk_job_card_opened ON wk_job_card(date_opened);
CREATE INDEX IF NOT EXISTS ix_wk_job_card_status ON wk_job_card(status);
CREATE INDEX IF NOT EXISTS ix_import_warnings_jc ON import_warnings(job_card_no);
