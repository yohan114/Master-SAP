// Material Requisition Note (MRN) module — the demand document that precedes an issue.
// Lifecycle (per docs/04 A1): raise (DRAFT) -> approve (APPROVED) -> fulfil from stock, which
// posts an issue at MWAC against the MRN, increments issued_qty, and rolls the line/header to
// PARTIAL/CLOSED. The MRN itself never moves stock — the issue it spawns does. If the MRN names
// a job card, fulfilling posts the parts straight onto that job (same cross-module flow as a
// direct stores issue). Stock short of the approved qty is left open for a later top-up/PO.
const express = require('express');
const { q, one, tx } = require('../db');
const { requirePerm, scopeSql } = require('../auth/mw');
const { nextNo } = require('../lib/numbering');
const { postIssue, balanceOf, siteCodeOf, qty4 } = require('../lib/inventory');

const router = express.Router();
const today = () => new Date().toISOString().slice(0, 10);

// List MRNs (site-scoped), newest first, with a line count.
router.get('/', async (req, res) => {
  try {
    const sc = scopeSql(req, 'm', 1);
    const rows = await q(
      `SELECT m.mrn_id, m.mrn_no, m.mrn_date, m.doc_status, m.priority, m.location_id, l.location_name,
              m.jobcard_id, m.required_date,
              (SELECT count(*) FROM txl_mrn x WHERE x.mrn_id=m.mrn_id AND x.is_active) AS lines
       FROM tx_mrn m JOIN md_location l ON l.location_id=m.location_id
       WHERE m.is_active${sc.sql}
       ORDER BY m.mrn_id DESC LIMIT 200`, sc.params);
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One MRN + its lines (with the on-hand at the requesting store, so you can see fulfilability).
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sc = scopeSql(req, 'm', 2);
    const mrn = await one(
      `SELECT m.*, l.location_name FROM tx_mrn m JOIN md_location l ON l.location_id=m.location_id
       WHERE m.mrn_id=$1${sc.sql}`, [id, ...sc.params]);
    if (!mrn) return res.status(404).json({ error: 'MRN not found' });
    mrn.lines = await q(
      `SELECT x.mrn_line_id, x.line_no, x.item_id, i.item_no, i.item_name, x.requested_qty,
              x.approved_qty, x.issued_qty, x.line_status, COALESCE(b.on_hand_qty,0) AS on_hand_qty
       FROM txl_mrn x JOIN md_item i ON i.item_id=x.item_id
       LEFT JOIN inv_stock_balance b ON b.item_id=x.item_id AND b.location_id=$2
       WHERE x.mrn_id=$1 AND x.is_active ORDER BY x.line_no`, [id, mrn.location_id]);
    res.json(mrn);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Raise an MRN: header + one or more request lines.
router.post('/', requirePerm('STORES.MRN'), async (req, res) => {
  try {
    const b = req.body || {};
    const lines = Array.isArray(b.lines) ? b.lines.filter((x) => x && x.item_id && Number(x.qty) > 0) : [];
    if (!b.location_id) return res.status(400).json({ error: 'location_id (requesting store) required' });
    if (!lines.length) return res.status(400).json({ error: 'at least one line (item_id + qty>0) required' });
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
      let ln = 0;
      for (const line of lines) {
        const item = (await c.query('SELECT base_uom_id FROM md_item WHERE item_id=$1', [line.item_id])).rows[0];
        if (!item) throw new Error(`unknown item ${line.item_id}`);
        await c.query(
          `INSERT INTO txl_mrn(mrn_id, line_no, item_id, uom_id, requested_qty, remarks, created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [m.mrn_id, ++ln, line.item_id, item.base_uom_id, qty4(line.qty), line.remarks || null, uid]);
      }
      return { ...m, lines: ln };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Approve a DRAFT MRN. Sets each line's approved_qty (= requested, or per-line overrides in body.lines).
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
      const lines = (await c.query('SELECT mrn_line_id, requested_qty FROM txl_mrn WHERE mrn_id=$1 AND is_active', [id])).rows;
      for (const l of lines) {
        const aq = over.has(l.mrn_line_id) ? qty4(over.get(l.mrn_line_id)) : qty4(l.requested_qty);
        await c.query('UPDATE txl_mrn SET approved_qty=$1, updated_by=$2, updated_at=now() WHERE mrn_line_id=$3', [aq, uid, l.mrn_line_id]);
      }
      await c.query("UPDATE tx_mrn SET doc_status='APPROVED', approved_by=$1, approved_at=now(), updated_by=$1, updated_at=now() WHERE mrn_id=$2", [uid, id]);
      return { mrn_id: id, doc_status: 'APPROVED', lines: lines.length };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Fulfil an approved MRN from stock: post an issue at MWAC for the available qty of each open
// line (capped at on-hand, so a short store fulfils what it can), link it back, and roll status.
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
        'SELECT mrn_line_id, item_id, approved_qty, issued_qty FROM txl_mrn WHERE mrn_id=$1 AND is_active ORDER BY line_no', [id])).rows;
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
      const after = (await c.query('SELECT approved_qty, issued_qty FROM txl_mrn WHERE mrn_id=$1 AND is_active', [id])).rows;
      const allClosed = after.length > 0 && after.every((l) => Number(l.approved_qty) > 0 && Number(l.issued_qty) >= Number(l.approved_qty));
      const anyIssued = after.some((l) => Number(l.issued_qty) > 0);
      const doc_status = allClosed ? 'CLOSED' : anyIssued ? 'PARTIAL' : mrn.doc_status;
      await c.query('UPDATE tx_mrn SET doc_status=$1, updated_by=$2, updated_at=now() WHERE mrn_id=$3', [doc_status, uid, id]);
      return { mrn_id: id, doc_status, lines: posted };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
