// Migrate legacy workshop job records from Job_Record_Requested_and_Cjob.xlsx into the wk_* staging
// tables (see 002-job-cards-seed.sql). Reads BOTH sheets — note they have DIFFERENT column layouts —
// merges them by job_card_no (Sheet 2 "C-job" preferred, and it carries the real Hrs/Cost), derives a
// status, extracts odometer readings, normalises sites, flags data-quality issues into import_warnings,
// and upserts in batches of 100 (a transaction per batch, rolled back on error).
//
//   JOBS_XLSX=/path/Job_Record_Requested_and_Cjob.xlsx node migrate-job-records.js
//
// Uses the app's db.js data layer, so it writes to whichever engine the app is configured for
// (PostgreSQL or SQLite) — no direct connection handling, no new dependency.
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', '..', 'app');
const { q, tx, ENGINE } = require(path.join(APP, 'db'));
const { readWorkbook, serialToISODate } = require('./lib/xlsx-lite');

const XLSX_PATH = process.env.JOBS_XLSX;
if (!XLSX_PATH) { console.error('Set JOBS_XLSX=/path/to/Job_Record_Requested_and_Cjob.xlsx'); process.exit(1); }
const BATCH = 100;
const TODAY = new Date().toISOString().slice(0, 10);

// Sheet column layouts (0-based). The two sheets are NOT the same shape.
const LAYOUT = {
  'Requested job': { job: 0, vehicle: 1, desc: 2, start: 3, end: 4, site: 5, remarks: 6, notes: 7, jobtype: 8 },
  'C-job':         { job: 0, ref: 1, vehicle: 2, desc: 3, start: 4, end: 5, hrs: 6, cost: 7, site: 8, remarks: 9 },
};

const str = (v) => (v == null ? '' : String(v)).trim();
const NONSTANDARD = new Set(['solution', 'h/o', 'w/s c-com', 'a/team', 'a/plant']);

function normaliseSite(raw) {
  const s = str(raw).replace(/\s+/g, ' ');
  if (!s) return { name: null, nonstandard: false };
  const display = /^[a-z ]+$/i.test(s) ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : s;   // Title-case pure-alpha names
  const nonstandard = NONSTANDARD.has(s.toLowerCase()) || !/^[A-Za-z][A-Za-z ]+$/.test(display);
  return { name: display, nonstandard };
}
function normaliseAsset(raw) {
  const s = str(raw);
  if (!s) return null;
  const isEquip = !s.includes('-');
  return { code: (isEquip ? 'EQP-' + s : s).slice(0, 60), name: s.slice(0, 150), is_equipment: isEquip };
}
function deriveStatus(dateOpened, dateClosed, remarks) {
  const r = str(remarks).toLowerCase();
  if (r.includes('cancel')) return 'CANCELLED';
  if (r.includes('not done')) return 'PENDING';
  if (dateClosed) return 'CLOSED';
  if (dateOpened) return 'OPEN';
  return 'PENDING';
}
function extractOdometer(...texts) {
  for (const t of texts) {
    const m = str(t).match(/([\d][\d,]{2,})\s*(km|hrs?)\b/i);
    if (m) return { value: Number(m[1].replace(/,/g, '')), unit: /k/i.test(m[2]) ? 'Km' : 'Hrs' };
  }
  return null;
}

(async () => {
  console.log(`Engine: ${ENGINE}. Reading ${XLSX_PATH} …`);
  const wb = readWorkbook(XLSX_PATH);

  // ---- 1) ensure the staging schema (run the .sql statement-by-statement so it works on both engines) ----
  const ddl = fs.readFileSync(path.join(__dirname, '002-job-cards-seed.sql'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of ddl) await q(stmt);
  console.log('Staging schema ready (wk_site, wk_asset, wk_job_card, import_warnings).');

  // ---- 2) read + merge both sheets (Sheet 2 wins on overlap) ----
  const jobs = new Map();      // job_card_no -> record
  const warnings = [];         // { job_card_no, warning_type, detail }
  const warn = (jc, type, detail) => warnings.push({ job_card_no: jc, warning_type: type, detail: String(detail).slice(0, 400) });
  const order = ['Requested job', 'C-job'];   // process Sheet 1 first, then let C-job overwrite/enrich

  for (const sheet of order) {
    const rows = wb.sheets[sheet]; const L = LAYOUT[sheet];
    if (!rows || !L) continue;
    for (let i = 1; i < rows.length; i++) {         // skip header row
      const r = rows[i]; if (!r || r.every((c) => c == null || c === '')) continue;
      const jobNo = str(r[L.job]);
      if (!jobNo) { warn(null, 'SKIPPED_NO_JOBNO', `${sheet} row ${i + 1} has no job number`); continue; }

      const asset = normaliseAsset(r[L.vehicle]);
      const site = normaliseSite(r[L.site]);
      const dateOpened = serialToISODate(r[L.start]);
      const dateClosed = serialToISODate(r[L.end]);
      const remarks = [str(r[L.remarks]), L.notes != null ? str(r[L.notes]) : ''].filter(Boolean).join(' · ') || null;
      const desc = str(r[L.desc]) || null;
      const odo = extractOdometer(desc, remarks);

      const rec = {
        job_card_no: jobNo, source_sheet: sheet,
        asset_code: asset ? asset.code : null, _asset: asset,
        site_name: site.name, _siteNonstd: site.nonstandard,
        work_desc: desc, date_opened: dateOpened, date_closed: dateClosed,
        status: deriveStatus(dateOpened, dateClosed, remarks),
        job_type: null,                                   // source column I is empty across the whole file
        remarks, odometer_at_job: odo ? odo.value : null, odometer_unit: odo ? odo.unit : null,
        hours: L.hrs != null && r[L.hrs] != null ? Number(r[L.hrs]) : null,
        cost: L.cost != null && r[L.cost] != null ? Number(r[L.cost]) : null,
        ref_no: L.ref != null ? (str(r[L.ref]) || null) : null,
      };

      if (jobs.has(jobNo)) {                              // C-job enriches / overwrites Sheet 1
        const prev = jobs.get(jobNo);
        rec.cost = rec.cost ?? prev.cost; rec.hours = rec.hours ?? prev.hours;
        rec.odometer_at_job = rec.odometer_at_job ?? prev.odometer_at_job;
        rec.odometer_unit = rec.odometer_unit ?? prev.odometer_unit;
      }
      jobs.set(jobNo, rec);

      // data-quality warnings
      if (site.nonstandard) warn(jobNo, 'NONSTANDARD_SITE', site.name);
      if (asset && asset.is_equipment) warn(jobNo, 'EQUIPMENT_ASSET', asset.name);
      if (!asset) warn(jobNo, 'MISSING_ASSET', `${sheet} row ${i + 1}`);
      if (dateOpened && dateClosed && dateClosed < dateOpened) warn(jobNo, 'DATE_INVERTED', `opened ${dateOpened} > closed ${dateClosed}`);
      for (const [lbl, d] of [['opened', dateOpened], ['closed', dateClosed]]) {
        if (d && d < '2000-01-01') warn(jobNo, 'DATE_OUT_OF_RANGE', `${lbl} ${d}`);
        else if (d && d > TODAY) warn(jobNo, 'FUTURE_DATE', `${lbl} ${d}`);
      }
      if (odo) warn(jobNo, 'ODOMETER_EXTRACTED', `${odo.value} ${odo.unit}`);
    }
  }

  // ---- 3) upsert the lookups (sites + assets), deduped ----
  const sites = new Map(), assets = new Map();
  for (const j of jobs.values()) {
    if (j.site_name) { const s = sites.get(j.site_name) || { site_name: j.site_name, is_nonstandard: j._siteNonstd, n: 0 }; s.n++; s.is_nonstandard = s.is_nonstandard || j._siteNonstd; sites.set(j.site_name, s); }
    if (j._asset) assets.set(j._asset.code, j._asset);
  }
  await tx(async (c) => {
    for (const s of sites.values())
      await c.query(`INSERT INTO wk_site(site_name, is_nonstandard, job_count) VALUES($1,$2,$3)
        ON CONFLICT (site_name) DO UPDATE SET is_nonstandard=EXCLUDED.is_nonstandard, job_count=EXCLUDED.job_count`, [s.site_name, !!s.is_nonstandard, s.n]);
    for (const a of assets.values())
      await c.query(`INSERT INTO wk_asset(asset_code, asset_name, is_equipment) VALUES($1,$2,$3)
        ON CONFLICT (asset_code) DO NOTHING`, [a.code, a.name, !!a.is_equipment]);
  });
  console.log(`Lookups: ${sites.size} sites, ${assets.size} assets.`);

  // ---- 4) upsert job cards in batches of 100 (a tx per batch) ----
  const all = [...jobs.values()];
  let done = 0;
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    await tx(async (c) => {
      for (const j of batch) {
        await c.query(
          `INSERT INTO wk_job_card(job_card_no, asset_code, site_name, work_desc, date_opened, date_closed,
             status, job_type, remarks, odometer_at_job, odometer_unit, hours, cost, ref_no, source_sheet)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (job_card_no) DO UPDATE SET
             asset_code=EXCLUDED.asset_code, site_name=EXCLUDED.site_name, work_desc=EXCLUDED.work_desc,
             date_opened=EXCLUDED.date_opened, date_closed=EXCLUDED.date_closed, status=EXCLUDED.status,
             remarks=EXCLUDED.remarks, odometer_at_job=EXCLUDED.odometer_at_job, odometer_unit=EXCLUDED.odometer_unit,
             hours=COALESCE(EXCLUDED.hours, wk_job_card.hours), cost=COALESCE(EXCLUDED.cost, wk_job_card.cost),
             ref_no=COALESCE(EXCLUDED.ref_no, wk_job_card.ref_no), source_sheet=EXCLUDED.source_sheet`,
          [j.job_card_no, j.asset_code, j.site_name, j.work_desc, j.date_opened, j.date_closed, j.status,
           j.job_type, j.remarks, j.odometer_at_job, j.odometer_unit, j.hours, j.cost, j.ref_no, j.source_sheet]);
      }
    });
    done += batch.length;
    console.log(`Inserted ${done} / ${all.length} jobs`);
  }

  // ---- 5) record warnings ----
  await q('DELETE FROM import_warnings');   // fresh set each run
  for (let i = 0; i < warnings.length; i += BATCH) {
    const batch = warnings.slice(i, i + BATCH);
    await tx(async (c) => {
      for (const w of batch) await c.query('INSERT INTO import_warnings(job_card_no, warning_type, detail) VALUES($1,$2,$3)', [w.job_card_no, w.warning_type, w.detail]);
    });
  }

  // ---- 6) summary report ----
  const byStatus = await q('SELECT status, COUNT(*) AS n FROM wk_job_card GROUP BY status ORDER BY n DESC');
  const bySite = await q('SELECT site_name, COUNT(*) AS n FROM wk_job_card GROUP BY site_name ORDER BY n DESC LIMIT 10');
  const byWarn = await q('SELECT warning_type, COUNT(*) AS n FROM import_warnings GROUP BY warning_type ORDER BY n DESC');
  const range = (await q('SELECT MIN(date_opened) AS lo, MAX(COALESCE(date_closed,date_opened)) AS hi FROM wk_job_card WHERE date_opened IS NOT NULL'))[0];
  const total = (await q('SELECT COUNT(*) AS n FROM wk_job_card'))[0].n;

  const line = '─'.repeat(52);
  console.log(`\n${line}\n  MIGRATION SUMMARY — legacy job records\n${line}`);
  console.log(`  Total job cards loaded : ${total}`);
  console.log('  By status              :', byStatus.map((r) => `${r.status}=${r.n}`).join('  '));
  console.log(`  Sites                  : ${sites.size} (top: ${bySite.slice(0, 5).map((r) => `${r.site_name} ${r.n}`).join(', ')})`);
  console.log(`  Assets                 : ${assets.size}`);
  console.log('  Warnings               :', byWarn.map((r) => `${r.warning_type}=${r.n}`).join('  ') || 'none');
  console.log(`  Date range             : ${range.lo} → ${range.hi}`);
  console.log(line);
  process.exit(0);
})().catch((e) => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
