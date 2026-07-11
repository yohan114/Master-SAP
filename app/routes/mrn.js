// Material Requisition Note (MRN) module — the demand document that precedes an issue.
//
// Two-mode request lines (docs/14):
//   * GENERAL — picked from the item master; only stockable master items qualify. These carry
//     stock control (availability, min/reorder) and are fulfilled by an issue at MWAC.
//   * OTHER   — typed free-text for rare/one-time/off-catalogue items. No stock control; they
//     bypass availability but must carry description + qty + unit + reason, and go to purchase
//     (or promotion to master), never a stock issue.
//
// Lifecycle: raise (DRAFT) -> approve (APPROVED) -> fulfil. Fulfilment issues the GENERAL lines
// from stock and links them back (tx_issue.mrn_id); OTHER lines wait for purchasing, so an MRN
// with any OTHER line settles at PARTIAL until procurement lands (that tier is future work).
const express = require('express');
const { q, one, tx } = require('../db');
const { requirePerm, scopeSql } = require('../auth/mw');
const { nextNo } = require('../lib/numbering');
const { postIssue, balanceOf, siteCodeOf, qty4 } = require('../lib/inventory');

const router = express.Router();
const today = () => new Date().toISOString().slice(0, 10);

// Audit control: a typed OTHER item may not duplicate an existing stockable master item.
async function masterClash(c, desc) {
  const nm = String(desc || '').trim();
  if (!nm) return null;
  return (await c.query(
    `SELECT item_no, item_name FROM md_item
     WHERE is_active AND is_stockable AND (LOWER(TRIM(item_name)) = LOWER($1) OR LOWER(item_no) = LOWER($1))
     LIMIT 1`, [nm])).rows[0] || null;
}

// List MRNs (site-scoped), newest first, with a line count.
router.get('/', async (req, res) => {
  try {
    const sc = scopeSql(req, 'm', 1);
    const rows = await q(
      `SELECT m.mrn_id, m.mrn_no, m.mrn_date, m.doc_status, m.priority, m.location_id, l.location_name,
              m.jobcard_id, m.required_date,
              (SELECT count(*) FROM txl_mrn x WHERE x.mrn_id=m.mrn_id AND x.is_active) AS lines,
              (SELECT count(*) FROM txl_mrn x WHERE x.mrn_id=m.mrn_id AND x.is_active AND x.item_source='OTHER') AS other_lines
       FROM tx_mrn m JOIN md_location l ON l.location_id=m.location_id
       WHERE m.is_active${sc.sql}
       ORDER BY m.mrn_id DESC LIMIT 200`, sc.params);
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One MRN + its lines. GENERAL lines carry the on-hand/reorder/min at the requesting store so the
// UI can render an availability badge; OTHER lines carry the typed description + reason.
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sc = scopeSql(req, 'm', 2);
    const mrn = await one(
      `SELECT m.*, l.location_name FROM tx_mrn m JOIN md_location l ON l.location_id=m.location_id
       WHERE m.mrn_id=$1${sc.sql}`, [id, ...sc.params]);
    if (!mrn) return res.status(404).json({ error: 'MRN not found' });
    mrn.lines = await q(
      `SELECT x.mrn_line_id, x.line_no, x.item_source, x.item_id, i.item_no, i.item_name,
              x.item_description, x.request_reason, x.suggested_category_id, cat.category_name AS suggested_category,
              u.uom_code, x.requested_qty, x.approved_qty, x.issued_qty, x.line_status,
              COALESCE(b.on_hand_qty,0) AS on_hand_qty, i.reorder_level, i.min_qty, i.is_stockable
       FROM txl_mrn x
       LEFT JOIN md_item i ON i.item_id=x.item_id
       LEFT JOIN md_uom u ON u.uom_id=x.uom_id
       LEFT JOIN md_item_category cat ON cat.category_id=x.suggested_category_id
       LEFT JOIN inv_stock_balance b ON b.item_id=x.item_id AND b.location_id=$2
       WHERE x.mrn_id=$1 AND x.is_active ORDER BY x.line_no`, [id, mrn.location_id]);
    res.json(mrn);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Raise an MRN. Each line is GENERAL (item_id) or OTHER (typed description). item_source may be
// omitted — it's inferred from whether an item_id is present, so older callers keep working.
router.post('/', requirePerm('STORES.MRN'), async (req, res) => {
  try {
    const b = req.body || {};
    const raw = Array.isArray(b.lines)
      ? b.lines.filter((x) => x && Number(x.qty) > 0 && (x.item_id || x.description || x.item_description)) : [];
    if (!b.location_id) return res.status(400).json({ error: 'location_id (requesting store) required' });
    if (!raw.length) return res.status(400).json({ error: 'at least one line (item or description, qty>0) required' });
    const site_id = b.site_id || b.location_id;
    const uid = req.user.user_id;
    const date = b.mrn_date || today();
    const out = await tx(async (c) => {
      const no = await nextNo('MRN', await siteCodeOf(c, site_id), date, c);
      const m = (await c.query(
        `INSERT INTO tx_mrn(mrn_no, mrn_date, location_id, jobcard_id, asset_id, required_date, priority,
             remarks, requested_by, doc_status, site_id, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10,$11) RETURNING mrn_id, mrn_no, doc_status`,
        [no, date, b.location_id, b.jobcard_id || null, b.asset_id || null, b.required_date || null,
         b.priority || 'NORMAL', b.remarks || null, b.requested_by || null, site_id, uid])).rows[0];
      let ln = 0, other = 0;
      for (const line of raw) {
        const src = String(line.item_source || (line.item_id ? 'GENERAL' : 'OTHER')).toUpperCase();
        if (src === 'GENERAL') {
          const it = (await c.query('SELECT base_uom_id, is_stockable, is_active FROM md_item WHERE item_id=$1', [line.item_id])).rows[0];
          if (!it || !it.is_active) throw new Error(`unknown item ${line.item_id}`);
          if (!it.is_stockable) throw new Error('that master item is not stock-controlled — request it as an Other item');
          await c.query(
            `INSERT INTO txl_mrn(mrn_id, line_no, item_source, item_id, uom_id, requested_qty, remarks, created_by)
             VALUES($1,$2,'GENERAL',$3,$4,$5,$6,$7)`,
            [m.mrn_id, ++ln, line.item_id, it.base_uom_id, qty4(line.qty), line.remarks || null, uid]);
        } else {
          const desc = String(line.description || line.item_description || '').trim();
          const reason = String(line.reason || line.request_reason || '').trim();
          if (desc.length < 3) throw new Error('describe the other item (at least 3 characters)');
          if (!line.uom_id) throw new Error('unit (uom) is required for an other item');
          if (!reason) throw new Error('a reason is required for an other item');
          const clash = await masterClash(c, desc);
          if (clash) throw new Error(`"${desc}" already exists as general item ${clash.item_no} (${clash.item_name}). Please select it instead of typing it.`);
          await c.query(
            `INSERT INTO txl_mrn(mrn_id, line_no, item_source, item_description, request_reason,
                 suggested_category_id, est_unit_price, uom_id, requested_qty, remarks, created_by)
             VALUES($1,$2,'OTHER',$3,$4,$5,$6,$7,$8,$9,$10)`,
            [m.mrn_id, ++ln, desc, reason, line.suggested_category_id || null, line.est_unit_price || null,
             line.uom_id, qty4(line.qty), line.remarks || null, uid]);
          other++;
        }
      }
      return { ...m, lines: ln, other_lines: other };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Approve a DRAFT MRN. Sets each line's approved_qty (= requested, or per-line overrides). OTHER
// lines move to PENDING_PO (they go to buying, not stock); GENERAL lines stay OPEN for issue.
router.post('/:id/approve', requirePerm('STORES.MRN'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const uid = req.user.user_id;
    const mrn = await one('SELECT mrn_id, doc_status FROM tx_mrn WHERE mrn_id=$1 AND is_active', [id]);
    if (!mrn) return res.status(404).json({ error: 'MRN not found' });
    if (mrn.doc_status !== 'DRAFT') return res.status(409).json({ error: `MRN is ${mrn.doc_status}; only a DRAFT can be approved` });
    const over = new Map((Array.isArray(b.lines) ? b.lines : []).map((x) => [Number(x.mrn_line_id), Number(x.qty)]));
    const out = await tx(async (c) => {
      const lines = (await c.query('SELECT mrn_line_id, item_source, requested_qty FROM txl_mrn WHERE mrn_id=$1 AND is_active', [id])).rows;
      for (const l of lines) {
        const aq = over.has(l.mrn_line_id) ? qty4(over.get(l.mrn_line_id)) : qty4(l.requested_qty);
        const st = l.item_source === 'OTHER' ? 'PENDING_PO' : 'OPEN';   // fits line_status VARCHAR(15)
        await c.query('UPDATE txl_mrn SET approved_qty=$1, line_status=$2, updated_by=$3, updated_at=now() WHERE mrn_line_id=$4', [aq, st, uid, l.mrn_line_id]);
      }
      await c.query("UPDATE tx_mrn SET doc_status='APPROVED', approved_by=$1, approved_at=now(), updated_by=$1, updated_at=now() WHERE mrn_id=$2", [uid, id]);
      return { mrn_id: id, doc_status: 'APPROVED', lines: lines.length };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Fulfil an approved MRN. Only GENERAL lines are issued from stock (capped at on-hand, so a short
// store fulfils what it can); OTHER lines are left for purchasing. Header rolls to CLOSED only when
// every line is settled — so any pending OTHER line keeps it at PARTIAL.
router.post('/:id/fulfil', requirePerm('STORES.ISSUE'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const uid = req.user.user_id;
    const date = b.issue_date || today();
    const mrn = await one('SELECT * FROM tx_mrn WHERE mrn_id=$1 AND is_active', [id]);
    if (!mrn) return res.status(404).json({ error: 'MRN not found' });
    if (!['APPROVED', 'PARTIAL'].includes(mrn.doc_status)) return res.status(409).json({ error: `MRN is ${mrn.doc_status}; approve it before fulfilling` });
    const fromLoc = b.location_id || mrn.location_id;
    const out = await tx(async (c) => {
      const lines = (await c.query(
        `SELECT mrn_line_id, item_id, approved_qty, issued_qty FROM txl_mrn
         WHERE mrn_id=$1 AND is_active AND item_source='GENERAL' ORDER BY line_no`, [id])).rows;
      const posted = [];
      for (const l of lines) {
        const remaining = qty4(Number(l.approved_qty) - Number(l.issued_qty));
        if (!(remaining > 0)) continue;
        const bal = await balanceOf(c, l.item_id, fromLoc);
        const issueQty = qty4(Math.min(remaining, Number(bal.on_hand_qty) || 0));
        if (!(issueQty > 0)) { posted.push({ mrn_line_id: l.mrn_line_id, issued: 0, short: remaining }); continue; }
        const iss = await postIssue(c, {
          itemId: l.item_id, locationId: fromLoc, qty: issueQty,
          jobcardId: mrn.jobcard_id || null, assetId: mrn.asset_id || null, mrnId: id,
          date, siteId: mrn.site_id, userId: uid,
        });
        const newIssued = qty4(Number(l.issued_qty) + issueQty);
        const line_status = newIssued >= Number(l.approved_qty) ? 'CLOSED' : 'PARTIAL';
        await c.query('UPDATE txl_mrn SET issued_qty=$1, line_status=$2, updated_by=$3, updated_at=now() WHERE mrn_line_id=$4',
          [newIssued, line_status, uid, l.mrn_line_id]);
        posted.push({ mrn_line_id: l.mrn_line_id, issued: issueQty, line_amt: iss.line_amt, issue_id: iss.issue_id, job_part_id: iss.job_part_id, line_status });
      }
      const after = (await c.query('SELECT item_source, approved_qty, issued_qty, line_status FROM txl_mrn WHERE mrn_id=$1 AND is_active', [id])).rows;
      const generalDone = after.filter((l) => l.item_source === 'GENERAL').every((l) => Number(l.approved_qty) > 0 && Number(l.issued_qty) >= Number(l.approved_qty));
      const otherPending = after.some((l) => l.item_source === 'OTHER' && !['PURCHASED', 'CANCELLED'].includes(l.line_status));
      const anyIssued = after.some((l) => Number(l.issued_qty) > 0);
      const doc_status = (after.length > 0 && generalDone && !otherPending) ? 'CLOSED' : (anyIssued || otherPending) ? 'PARTIAL' : mrn.doc_status;
      await c.query('UPDATE tx_mrn SET doc_status=$1, updated_by=$2, updated_at=now() WHERE mrn_id=$3', [doc_status, uid, id]);
      return { mrn_id: id, doc_status, lines: posted, other_pending: otherPending };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
