// Example protected routes showing the three enforcement points.
const express = require('express');
const { all, run } = require('../db');
const { requirePerm, siteScope } = require('../auth/rbac');
const { audit } = require('../auth/audit');

const router = express.Router();

// 1) Site-scoped read — a KND store keeper only sees KND rows; a manager/admin sees all.
router.get('/stock', (req, res) => {
  const sc = siteScope(req, []);
  const rows = all(`SELECT id, item, site_id, qty, unit_price FROM stock WHERE 1=1${sc.clause} ORDER BY id`, sc.params);
  res.json({ count: rows.length, rows });
});

// 2) Pricing — only a role granted STORES.PRICE may set unit price.
router.post('/grn/:id/price', requirePerm('STORES.PRICE'), (req, res) => {
  const { unit_price } = req.body || {};
  run('UPDATE stock SET unit_price = ? WHERE id = ?', [unit_price, req.params.id]);
  audit('PRICE_SET', { userId: req.user.id, entity: 'stock:' + req.params.id, detail: { unit_price } });
  res.json({ ok: true, id: Number(req.params.id), unit_price });
});

// 3) Delete — only STORES.DELETE. THIS REPLACES the hard-coded 'E&CWorkshop' password check.
router.delete('/items/:id', requirePerm('STORES.DELETE'), (req, res) => {
  run('DELETE FROM stock WHERE id = ?', [req.params.id]);
  audit('ITEM_DELETE', { userId: req.user.id, entity: 'stock:' + req.params.id });
  res.json({ ok: true });
});

module.exports = router;
