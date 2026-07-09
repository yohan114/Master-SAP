#!/usr/bin/env python3
"""
UMMS cutover reconciliation + exception worklist (go / no-go gate).

Compares independently-computed control totals from the LEGACY source (storesdb SQLite)
against the loaded UMMS PostgreSQL database, and lists every open exception queue.
Exit 0 = reconciled (go); exit 1 = a control total diverged (no-go).

Usage:  PGHOST=... PGPORT=... PGUSER=... PGDATABASE=umms \
        python3 reconcile.py <inventory.db>
"""
import sqlite3, subprocess, sys, os

INV = sys.argv[1] if len(sys.argv) > 1 else "data/inventory.db"
con = sqlite3.connect(INV)
def L(sql): return con.execute(sql).fetchone()[0] or 0
def P(sql):
    r = subprocess.run(['psql', '-tAc', sql], env=os.environ, capture_output=True, text=True)
    if r.returncode != 0: raise SystemExit("psql error: " + r.stderr.strip())
    return r.stdout.strip()
def Pf(sql): return float(P(sql) or 0)
def Pi(sql): return int(float(P(sql) or 0))

# ---------- legacy control totals (same business rules the loader applies) ----------
legacy = {
  'suppliers'   : L("SELECT COUNT(DISTINCT TRIM(supplierName)) FROM receipts WHERE TRIM(COALESCE(supplierName,''))<>''"),
  'stock_in_qty': (L("SELECT COALESCE(SUM(ABS(qty)),0) FROM receipts WHERE LOWER(COALESCE(transactionType,''))<>'return' AND COALESCE(qty,0)<>0")
                 + L("SELECT COALESCE(SUM(ABS(qty)),0) FROM general_item_transactions WHERE (LOWER(vehicleMachinery)='opening balance' OR LOWER(txType)='receive') AND COALESCE(qty,0)<>0")),
  'stock_out_qty':(L("SELECT COALESCE(SUM(ABS(qty)),0) FROM issues WHERE COALESCE(qty,0)<>0")
                 + L("SELECT COALESCE(SUM(ABS(qty)),0) FROM general_item_transactions WHERE LOWER(txType)='issue' AND COALESCE(qty,0)<>0")
                 + L("SELECT COALESCE(SUM(ABS(qty)),0) FROM receipts WHERE LOWER(COALESCE(transactionType,''))='return' AND COALESCE(qty,0)<>0")),
}
umms = {
  'suppliers'   : Pi("SELECT COUNT(*) FROM md_supplier"),
  'stock_in_qty': Pf("SELECT COALESCE(SUM(qty),0) FROM mv_stock_ledger WHERE mv_direction IN ('IN','ADJ_IN')"),
  'stock_out_qty': Pf("SELECT COALESCE(SUM(qty),0) FROM mv_stock_ledger WHERE mv_direction IN ('OUT','RET_OUT')"),
}

TOL = 0.5
print("="*74)
print("UMMS CUTOVER RECONCILIATION  (legacy storesdb  vs  UMMS PostgreSQL)")
print("="*74)
print(f"{'Control total':<26}{'legacy':>16}{'UMMS':>16}{'':>3}status")
fail = 0
for k, label in [('suppliers','Suppliers'), ('stock_in_qty','Total stock IN (qty)'), ('stock_out_qty','Total stock OUT (qty)')]:
    a, b = float(legacy[k]), float(umms[k]); ok = abs(a-b) <= TOL
    fail |= (0 if ok else 1)
    print(f"{label:<26}{a:>16,.2f}{b:>16,.2f}   {'MATCH' if ok else 'DIFF !!'}")

# internal consistency: IN - OUT should equal Σ on-hand
net = umms['stock_in_qty'] - umms['stock_out_qty']
onhand = Pf("SELECT COALESCE(SUM(on_hand_qty),0) FROM inv_stock_balance")
ok = abs(net-onhand) <= TOL; fail |= (0 if ok else 1)
print(f"{'Net (IN-OUT) = on-hand':<26}{net:>16,.2f}{onhand:>16,.2f}   {'MATCH' if ok else 'DIFF !!'}")

print("-"*74)
print("UMMS-only figures (no legacy equivalent — valuation is new in UMMS):")
print(f"  items={Pi('SELECT COUNT(*) FROM md_item')}  assets={Pi('SELECT COUNT(*) FROM md_asset')}  "
      f"job_cards={Pi('SELECT COUNT(*) FROM tx_jobcard')}  ledger_rows={Pi('SELECT COUNT(*) FROM mv_stock_ledger')}")
print(f"  total stock value = LKR {Pf('SELECT COALESCE(SUM(stock_value),0) FROM inv_stock_balance'):,.2f}")
print(f"  total labour cost = LKR {Pf('SELECT COALESCE(SUM(labour_cost),0) FROM cost_job_summary'):,.2f}")

print("="*74)
print("OPEN EXCEPTION WORKLISTS (clear before / shortly after cutover)")
print("="*74)
def row(label, sql, unit=''):
    print(f"  {label:<42}{P(sql):>12} {unit}")
row("Pending pricing — movements", "SELECT COUNT(*) FROM mv_stock_ledger WHERE is_provisional")
row("Pending pricing — qty affected", "SELECT to_char(COALESCE(SUM(qty),0),'FM999,999,990.00') FROM mv_stock_ledger WHERE is_provisional")
row("Negative on-hand items", "SELECT COUNT(*) FROM inv_stock_balance WHERE on_hand_qty < 0")
row("Labour lines with no rate (rate-pending)", "SELECT COUNT(*) FROM tx_job_labour WHERE hourly_rate = 0")
row("Technicians missing a rate", "SELECT COUNT(DISTINCT employee_id) FROM tx_job_labour WHERE hourly_rate = 0")
row("Job cards not yet costed", "SELECT COUNT(*) FROM tx_jobcard j WHERE NOT EXISTS (SELECT 1 FROM cost_job_summary c WHERE c.jobcard_id=j.jobcard_id)")
row("Job cards on general placeholder asset", "SELECT COUNT(*) FROM tx_jobcard WHERE asset_id=(SELECT asset_id FROM md_asset WHERE asset_no='AST-GEN')")

print("\n  Top 5 pending-price items (need a unit price):")
print(subprocess.run(['psql','-c',
  "SELECT i.item_no, left(i.item_name,32) item, count(*) lines, to_char(sum(m.qty),'FM999,990.0') qty "
  "FROM mv_stock_ledger m JOIN md_item i USING(item_id) WHERE m.is_provisional "
  "GROUP BY 1,2 ORDER BY sum(m.qty) DESC LIMIT 5"], env=os.environ, capture_output=True, text=True).stdout)

print("="*74)
if fail:
    print("RESULT: NO-GO — a control total diverged; investigate before cutover.")
    sys.exit(1)
print("RESULT: GO — all control totals reconcile. Work the exception lists, then flip legacy read-only.")
