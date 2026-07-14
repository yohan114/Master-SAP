// Import legacy Stores MRN data from a tracker_backup_*.json export into the stg_* staging schema
// (see 003-tracker-mrn-tables.sql). Groups line items by mrnNum, derives fulfilment status, classifies
// each vehicleMachinery as an asset vs a workshop department, resolves units, matches items/assets to
// the live master READ-ONLY, and loads receipts (flagging the unpriced ones). Each MRN is imported in
// its own transaction — a failure rolls back that MRN and is logged, but the run continues. Idempotent
// (an MRN already in stg_mrn is skipped). Prints progress + a summary and writes a CSV report.
//
//   node migrate-tracker-backup.js /path/to/tracker_backup_2026-07-12.json
//
// Uses the app's db.js data layer (runs on PostgreSQL or SQLite); no new npm dependency — the ~3 MB
// JSON is small enough to read at once (no stream-json needed).
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', '..', 'app');
const { q, one, tx, ENGINE } = require(path.join(APP, 'db'));

const JSON_PATH = process.argv[2] || process.env.TRACKER_JSON;
if (!JSON_PATH) { console.error('Usage: node migrate-tracker-backup.js <tracker_backup.json>'); process.exit(1); }

// ---- mappings ------------------------------------------------------------
const CATEGORY = {
  'oil & lubricants': 'oil_lubricants', filters: 'filters', electrical: 'electrical', hydraulics: 'hydraulics',
  'bearings & seals': 'bearings_seals', battery: 'battery', 'general items': 'general_items', belts: 'belts', tyre: 'tyre',
};
const DEPT = {
  'work shop stores': 'WS-STR', 'work shop stock': 'WS-STK', 'work shop office': 'WS-OFF',
  'tinkering work shop': 'WS-TNK', 'tinker nawathilaka': 'WS-TNK', 'machanical dilipa': 'WS-MCH', 'machanic kumara': 'WS-MCH',
};
const UNITS = new Set(['kg', 'ltr', 'l', 'ft', 'set', 'nos', 'ea', 'pc', 'pair', 'roll', 'box', 'mtr', 'm', 'lbs']);

const str = (v) => (v == null ? '' : String(v)).trim();
const nz = (v) => { const s = str(v); return s === '' ? null : s; };                         // "" -> null
const isoDate = (v) => { const s = str(v); const m = s.match(/^\d{4}-\d{2}-\d{2}/); return m ? m[0] : null; };
const num = (v) => (v == null || v === '' ? null : Number(v));

function classifyAsset(raw) {
  const key = str(raw).toLowerCase();
  if (DEPT[key]) return { kind: 'DEPT', dept_code: DEPT[key], asset_code: null };
  if (/^machan/i.test(raw)) return { kind: 'DEPT', dept_code: 'WS-MCH', asset_code: null };   // any other Machan*
  if (/\d/.test(raw)) return { kind: 'ASSET', dept_code: null, asset_code: str(raw).slice(0, 60) };
  return { kind: 'DEPT', dept_code: null, asset_code: null };                                 // name/location, unmapped
}
function resolveUomAndNotes(itemDesc) {
  const d = str(itemDesc);
  if (d && UNITS.has(d.toLowerCase())) return { uom: d.slice(0, 10), notes: null };
  return { uom: 'EA', notes: nz(d) };
}
const lineStatus = (req, rec) => (rec >= req && req > 0 ? 'FULFILLED' : rec > 0 ? 'PARTIAL' : 'PENDING');
function headerStatus(lines) {
  const allFulfilled = lines.every((l) => Number(l.recQty) >= Number(l.reqQty) && Number(l.reqQty) > 0);
  if (allFulfilled) return 'FULFILLED';
  return lines.some((l) => Number(l.recQty) > 0) ? 'PARTIAL' : 'PENDING';
}

(async () => {
  console.log(`Engine: ${ENGINE}. Reading ${JSON_PATH} …`);
  const records = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  if (!Array.isArray(records)) throw new Error('expected a JSON array of MRN line records');

  // ---- ensure staging schema (statement-by-statement, so it runs on both engines) ----
  const ddl = fs.readFileSync(path.join(__dirname, '003-tracker-mrn-tables.sql'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of ddl) await q(stmt);

  // ---- resolve distinct items & assets once (READ-ONLY match against the live master) ----
  const itemCache = new Map(), assetCache = new Map();
  for (const r of records) {
    const iKey = str(r.itemName).toLowerCase();
    if (iKey && !itemCache.has(iKey)) {
      const cat = CATEGORY[str(r.category).toLowerCase()] || 'general_items';
      const { uom } = resolveUomAndNotes(r.itemDesc);
      const match = await one('SELECT item_id FROM md_item WHERE LOWER(item_name)=LOWER($1) AND is_active LIMIT 1', [str(r.itemName)]);
      itemCache.set(iKey, { item_key: iKey, item_name: str(r.itemName).slice(0, 200), item_description: nz(r.itemDesc),
        category_raw: nz(r.category), category_code: cat, uom, matched_item_id: match ? match.item_id : null });
    }
    const aRaw = str(r.vehicleMachinery);
    const aKey = aRaw.toLowerCase();
    if (aKey && !assetCache.has(aKey)) {
      const cls = classifyAsset(aRaw);
      let matched = null;
      if (cls.kind === 'ASSET') { const m = await one('SELECT asset_id FROM md_asset WHERE asset_no=$1 OR LOWER(asset_name)=LOWER($1) LIMIT 1', [aRaw]); matched = m ? m.asset_id : null; }
      assetCache.set(aKey, { asset_key: aKey, raw_value: aRaw.slice(0, 140), ...cls, matched_asset_id: matched });
    }
  }

  // ---- group by mrnNum (records with no mrnNum can't be grouped — flagged, not silently dropped) ----
  const groups = new Map(); const noMrn = [];
  for (const r of records) { const k = str(r.mrnNum); if (!k) { noMrn.push(r); continue; } (groups.get(k) || groups.set(k, []).get(k)).push(r); }

  const stats = { total: groups.size, imported: 0, skipped: 0, failed: 0, noMrn: noMrn.length, lines: 0, receipts: 0, unpriced: 0, ret: 0 };
  const csv = [];   // { mrnNum, itemName, vehicleMachinery, reqQty, recQty, hasUnpriced, importStatus, errorMessage }
  let processed = 0;

  if (noMrn.length) {
    console.log(`⚠️  ${noMrn.length} record(s) have no mrnNum — cannot be grouped into an MRN; logged + reported.`);
    for (const r of noMrn) {
      try { await q('INSERT INTO stg_import_log(mrn_number,level,detail) VALUES($1,$2,$3)', [null, 'WARN', `record id=${r.id} itemName="${str(r.itemName)}" has no mrnNum`]); } catch { /* ignore */ }
      csv.push({ mrnNum: '', itemName: str(r.itemName), vehicleMachinery: str(r.vehicleMachinery), reqQty: r.reqQty, recQty: r.recQty, hasUnpriced: r.hasUnpriced, importStatus: 'skipped_no_mrn', errorMessage: 'missing mrnNum' });
    }
  }

  for (const [mrnNum, lines] of groups) {
    let outcome = 'imported', errMsg = '';
    try {
      const existing = await one('SELECT mrn_number FROM stg_mrn WHERE mrn_number=$1', [mrnNum]);
      if (existing) {
        outcome = 'skipped'; stats.skipped++;
        console.log(`⚠️  MRN ${mrnNum} — skipped (already exists)`);
      } else {
        let receiptCount = 0;
        await tx(async (c) => {   // one transaction per MRN group
          // lookups (idempotent)
          for (const r of lines) {
            const it = itemCache.get(str(r.itemName).toLowerCase());
            if (it) await c.query(`INSERT INTO stg_mrn_item(item_key,item_name,item_description,category_raw,category_code,uom,matched_item_id)
              VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (item_key) DO NOTHING`,
              [it.item_key, it.item_name, it.item_description, it.category_raw, it.category_code, it.uom, it.matched_item_id]);
            const as = assetCache.get(str(r.vehicleMachinery).toLowerCase());
            if (as) await c.query(`INSERT INTO stg_mrn_asset(asset_key,raw_value,kind,asset_code,dept_code,matched_asset_id)
              VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (asset_key) DO NOTHING`,
              [as.asset_key, as.raw_value, as.kind, as.asset_code, as.dept_code, as.matched_asset_id]);
          }
          // header
          const legacyId = Math.min(...lines.map((l) => Number(l.id) || Infinity));
          const created = lines.map((l) => str(l.createdAt)).filter(Boolean).sort()[0] || null;
          await c.query(`INSERT INTO stg_mrn(mrn_number,request_date,status,legacy_id,line_count,source_created_at)
            VALUES($1,$2,$3,$4,$5,$6)`,
            [mrnNum, isoDate(lines[0].reqDateISO || lines[0].reqDate), headerStatus(lines),
             Number.isFinite(legacyId) ? legacyId : null, lines.length, created]);
          // lines + receipts
          for (const r of lines) {
            const it = itemCache.get(str(r.itemName).toLowerCase());
            const as = assetCache.get(str(r.vehicleMachinery).toLowerCase());
            const { uom, notes } = resolveUomAndNotes(r.itemDesc);
            await c.query(`INSERT INTO stg_mrn_line(legacy_item_id,mrn_number,item_key,asset_key,requested_qty,received_qty,uom,category_code,notes,status)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (legacy_item_id) DO NOTHING`,
              [Number(r.id), mrnNum, it ? it.item_key : null, as ? as.asset_key : null,
               num(r.reqQty), num(r.recQty), uom, it ? it.category_code : 'general_items', notes,
               lineStatus(Number(r.reqQty) || 0, Number(r.recQty) || 0)]);
            for (const rc of (Array.isArray(r.receipts) ? r.receipts : [])) {
              const priced = rc.unitPrice != null;
              if (!priced) stats.unpriced++;
              if (str(rc.transactionType).toLowerCase() !== 'receive') stats.ret++;
              await c.query(`INSERT INTO stg_grn(legacy_receipt_id,legacy_item_id,received_qty,delivery_date,purchase_source,
                   grn_number,invoice_number,invoice_date,supplier_name,unit_price,is_priced,transaction_type)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (legacy_receipt_id) DO NOTHING`,
                [Number(rc.id), Number(r.id), num(rc.qty), isoDate(rc.deliveryDateISO || rc.deliveryDate), nz(rc.purchaseSource),
                 nz(rc.grnNumber), nz(rc.invoiceNumber), isoDate(rc.invoiceDate), nz(rc.supplierName), num(rc.unitPrice), priced, nz(rc.transactionType)]);
              receiptCount++;
            }
          }
        });
        stats.imported++; stats.lines += lines.length; stats.receipts += receiptCount;
        console.log(`✅ MRN ${mrnNum} — imported (${lines.length} line${lines.length > 1 ? 's' : ''}, ${receiptCount} receipt${receiptCount === 1 ? '' : 's'})`);
      }
    } catch (e) {
      outcome = 'failed'; errMsg = e.message; stats.failed++;
      console.log(`❌ MRN ${mrnNum} — failed: ${e.message}`);
      try { await q('INSERT INTO stg_import_log(mrn_number,level,detail) VALUES($1,$2,$3)', [mrnNum, 'ERROR', e.message.slice(0, 400)]); } catch { /* ignore */ }
    }
    for (const r of lines) csv.push({ mrnNum, itemName: str(r.itemName), vehicleMachinery: str(r.vehicleMachinery),
      reqQty: r.reqQty, recQty: r.recQty, hasUnpriced: r.hasUnpriced, importStatus: outcome, errorMessage: errMsg });
    if (++processed % 100 === 0) console.log(`   … ${processed}/${groups.size} MRNs processed`);
  }

  // ---- CSV report (kept out of git — see source/.gitignore) ----
  const cell = (s) => { s = String(s ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cols = ['mrnNum', 'itemName', 'vehicleMachinery', 'reqQty', 'recQty', 'hasUnpriced', 'importStatus', 'errorMessage'];
  const exportsDir = path.join(__dirname, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const reportPath = path.join(exportsDir, `migration-report-${new Date().toISOString().slice(0, 10)}.csv`);
  fs.writeFileSync(reportPath, [cols.join(','), ...csv.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));

  const line = '─'.repeat(52);
  console.log(`\n${line}\n  TRACKER MRN IMPORT — SUMMARY\n${line}`);
  console.log(`  Total MRNs processed : ${stats.total}`);
  console.log(`  Imported: ${stats.imported} | Skipped: ${stats.skipped} | Failed: ${stats.failed}`);
  if (stats.noMrn) console.log(`  Records with no mrnNum: ${stats.noMrn}  (could not be grouped — flagged)`);
  console.log(`  Total line items     : ${stats.lines}`);
  console.log(`  Total receipts/GRNs  : ${stats.receipts}`);
  console.log(`  Unpriced receipts    : ${stats.unpriced}  (need price update)`);
  if (stats.ret) console.log(`  Non-'Receive' receipts: ${stats.ret}  (flagged)`);
  console.log(`  CSV report           : ${reportPath}`);
  console.log(line);
  process.exit(0);
})().catch((e) => { console.error('IMPORT FAILED:', e.message); process.exit(1); });
