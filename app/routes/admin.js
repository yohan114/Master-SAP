// Admin — master-data deduplication. Finds near-duplicate md_item rows (fuzzy name match) and merges
// one into the other: every item_id reference is reassigned to the survivor, stock balances are folded
// (respecting the UNIQUE(item_id, location_id) constraint), and the loser is soft-deleted — all in one
// transaction. Admin-only: gated on ADMIN.ALL, the permission held only by the system_admin role
// (this app's RBAC is permission-based; there is no role-name middleware).
//
// Fuzzy matching: on PostgreSQL it uses the pg_trgm extension's similarity() (added in sql/schema.sql).
// SQLite has no extensions, so there we compute an equivalent trigram-Jaccard similarity in JS — the
// tool works identically on either engine.
const express = require('express');
const { q, one, tx, ENGINE } = require('../db');
const { requirePerm } = require('../auth/mw');

const router = express.Router();
const SIM_THRESHOLD = 0.8;
router.use(requirePerm('ADMIN.ALL'));   // every admin route requires system_admin

// Every table.column that references md_item(item_id), reassigned wholesale on merge. inv_stock_balance
// is handled separately below (UNIQUE(item_id, location_id) + a generated column ⇒ its rows are folded,
// not blindly moved). Empty/unused tables here are simply no-ops.
const ITEM_FK = [
  ['mv_stock_ledger', 'item_id'], ['txl_grn', 'item_id'], ['txl_po', 'item_id'], ['txl_issue', 'item_id'],
  ['txl_transfer', 'item_id'], ['txl_adjustment', 'item_id'], ['txl_return', 'item_id'], ['txl_lube_issue', 'item_id'],
  ['tx_battery_issue', 'item_id'], ['txl_job_material_req', 'item_id'], ['tx_job_parts', 'item_id'],
  ['inv_pending_price', 'item_id'], ['inv_reservation', 'item_id'], ['inv_valuation_layer', 'item_id'],
  ['inv_lube_monthly_balance', 'item_id'], ['md_price', 'item_id'], ['md_price_history', 'item_id'],
  ['md_uom_conversion', 'item_id'], ['md_battery', 'item_id'], ['cost_job_line', 'item_id'],
  ['txl_mrn', 'item_id'], ['txl_mrn', 'promoted_item_id'],
];

// --- trigram similarity (SQLite fallback; mirrors pg_trgm's space-padded trigram Jaccard) ---
function trigrams(s) {
  const t = '  ' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  const g = new Set();
  for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3));
  return g;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Order a candidate pair so the survivor (keep) is the one with more stock — the item with inventory is
// the safer one to preserve; ties go to the lower item_id.
function orient(x, y, sim) {
  const [keep, merge] = (Number(y.stock_qty) > Number(x.stock_qty)) ? [y, x] : [x, y];
  return { keep, merge, similarity: Math.round(sim * 1000) / 1000 };
}
const enrich = (it) => ({
  item_id: it.item_id, item_no: it.item_no, item_name: it.item_name,
  category: it.category_name || null, stock_qty: Number(it.stock_qty) || 0,
});

// GET /duplicate-candidates — pairs of active items whose names are > 80% similar, with codes, names,
// categories, and current on-hand stock for each.
router.get('/duplicate-candidates', async (req, res) => {
  try {
    let pairs;
    if (ENGINE === 'sqlite') {
      const items = await q(
        `SELECT i.item_id, i.item_no, i.item_name, c.category_name,
                COALESCE((SELECT SUM(b.on_hand_qty) FROM inv_stock_balance b WHERE b.item_id=i.item_id),0) AS stock_qty
         FROM md_item i LEFT JOIN md_item_category c ON c.category_id=i.category_id
         WHERE i.is_active ORDER BY i.item_id`);
      const grams = items.map((it) => trigrams(it.item_name));
      pairs = [];
      for (let a = 0; a < items.length; a++)
        for (let b = a + 1; b < items.length; b++) {
          const sim = jaccard(grams[a], grams[b]);
          if (sim > SIM_THRESHOLD) pairs.push(orient(enrich(items[a]), enrich(items[b]), sim));
        }
    } else {
      const rows = await q(
        `SELECT a.item_id a_id, a.item_no a_no, a.item_name a_name, ca.category_name a_cat,
                COALESCE(sa.qty,0) a_qty,
                b.item_id b_id, b.item_no b_no, b.item_name b_name, cb.category_name b_cat,
                COALESCE(sb.qty,0) b_qty,
                similarity(a.item_name, b.item_name) AS sim
         FROM md_item a
         JOIN md_item b ON a.item_id < b.item_id AND similarity(a.item_name, b.item_name) > $1
         LEFT JOIN md_item_category ca ON ca.category_id = a.category_id
         LEFT JOIN md_item_category cb ON cb.category_id = b.category_id
         LEFT JOIN (SELECT item_id, SUM(on_hand_qty) qty FROM inv_stock_balance GROUP BY item_id) sa ON sa.item_id = a.item_id
         LEFT JOIN (SELECT item_id, SUM(on_hand_qty) qty FROM inv_stock_balance GROUP BY item_id) sb ON sb.item_id = b.item_id
         WHERE a.is_active AND b.is_active
         ORDER BY sim DESC LIMIT 500`, [SIM_THRESHOLD]);
      pairs = rows.map((r) => orient(
        enrich({ item_id: r.a_id, item_no: r.a_no, item_name: r.a_name, category_name: r.a_cat, stock_qty: r.a_qty }),
        enrich({ item_id: r.b_id, item_no: r.b_no, item_name: r.b_name, category_name: r.b_cat, stock_qty: r.b_qty }),
        Number(r.sim)));
    }
    pairs.sort((x, y) => y.similarity - x.similarity);
    res.json({ threshold: SIM_THRESHOLD, engine: ENGINE, count: pairs.length, pairs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /merge-items { keepId, mergeId } — reassign every item_id reference from mergeId to keepId, fold
// stock balances, and soft-delete mergeId. Atomic: any failure rolls the whole merge back.
router.post('/merge-items', async (req, res) => {
  try {
    const keepId = Number((req.body || {}).keepId);
    const mergeId = Number((req.body || {}).mergeId);
    if (!keepId || !mergeId) return res.status(400).json({ error: 'keepId and mergeId are required' });
    if (keepId === mergeId) return res.status(400).json({ error: 'keepId and mergeId must differ' });
    const keep = await one('SELECT item_id, item_no FROM md_item WHERE item_id=$1', [keepId]);
    const merge = await one('SELECT item_id, item_no FROM md_item WHERE item_id=$1', [mergeId]);
    if (!keep || !merge) return res.status(404).json({ error: 'keepId or mergeId not found' });
    const uid = req.user.user_id;
    const out = await tx(async (c) => {
      const ledgerMoved = Number((await c.query('SELECT COUNT(*) AS n FROM mv_stock_ledger WHERE item_id=$1', [mergeId])).rows[0].n);
      // 1) reassign the plain item_id references
      for (const [t, col] of ITEM_FK)
        await c.query(`UPDATE ${t} SET ${col}=$1 WHERE ${col}=$2`, [keepId, mergeId]);
      // 2) fold stock balances (UNIQUE(item_id, location_id)): move where the survivor has none at that
      //    location, otherwise combine quantities + re-weight the moving-average cost, then drop the loser's row.
      const mbals = (await c.query('SELECT * FROM inv_stock_balance WHERE item_id=$1', [mergeId])).rows;
      let folded = 0;
      for (const mb of mbals) {
        const kb = (await c.query('SELECT * FROM inv_stock_balance WHERE item_id=$1 AND location_id=$2', [keepId, mb.location_id])).rows[0];
        if (!kb) {
          await c.query('UPDATE inv_stock_balance SET item_id=$1, updated_by=$2, updated_at=now() WHERE balance_id=$3', [keepId, uid, mb.balance_id]);
        } else {
          const onHand = Math.round((Number(kb.on_hand_qty) + Number(mb.on_hand_qty)) * 10000) / 10000;
          const reserved = Math.round((Number(kb.reserved_qty) + Number(mb.reserved_qty)) * 10000) / 10000;
          const value = Math.round((Number(kb.stock_value) + Number(mb.stock_value)) * 100) / 100;
          const avg = onHand > 0 ? Math.round((value / onHand) * 10000) / 10000 : 0;
          await c.query('UPDATE inv_stock_balance SET on_hand_qty=$1, reserved_qty=$2, stock_value=$3, moving_avg_cost=$4, updated_by=$5, updated_at=now() WHERE balance_id=$6',
            [onHand, reserved, value, avg, uid, kb.balance_id]);
          await c.query('DELETE FROM inv_stock_balance WHERE balance_id=$1', [mb.balance_id]);
          folded++;
        }
      }
      // 3) retire the loser
      await c.query('UPDATE md_item SET is_active=FALSE, updated_by=$1, updated_at=now() WHERE item_id=$2', [uid, mergeId]);
      return { keepId, mergeId, ledger_reassigned: ledgerMoved, balances_moved: mbals.length, balances_combined: folded };
    });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
