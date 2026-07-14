#!/usr/bin/env python3
"""
UMMS lubricant importer — oilbook.db -> md_item(LUBRICANT)/md_asset/md_project
+ mv_stock_ledger + tx_lube_issue + inv_lube_monthly_balance.
Policy: DO NOT DROP ANY ROW. import_hash reused as idempotency key. Uses the ledger's
running balance_after to reconcile the reconstruction.
"""
import sqlite3, sys, json, collections
DB  = sys.argv[1] if len(sys.argv)>1 else "data/oilbook.db"
OUT = sys.argv[2] if len(sys.argv)>2 else "."
con=sqlite3.connect(DB); con.row_factory=sqlite3.Row; c=con.cursor()

# ---- masters ----
md_item={r['id']:dict(item_id=r['id'], item_no="LUB-%04d"%r['id'], item_name=r['name'],
          item_type='LUBRICANT', uom=r['unit'], category=r['category'], reorder=r['reorder_level'],
          unit_price=r['unit_price']) for r in c.execute("SELECT * FROM products")}
def acls(x): return {'bike':'VEHICLE','plant':'MACHINE'}.get(x,'EQUIPMENT')
md_asset={r['id']:dict(asset_id=r['id'], reg_no=r['registration'], ec_code=r['ec_code'],
          asset_class=acls(r['asset_class']), site=r['site'],
          status='NEEDS_REVIEW' if r['status']=='pending' else 'ACTIVE') for r in c.execute("SELECT * FROM fleet_assets")}
md_project={r['id']:dict(project_id=r['id'], name=r['name'], location=r['location']) for r in c.execute("SELECT * FROM projects")}
# pending consumer resolution (unresolved aliases)
pending_alias=[dict(raw=r['raw_text'], hits=r['hit_count']) for r in c.execute("SELECT * FROM aliases WHERE resolved=0")]
# month-end balances
monthly=[dict(product_id=r['product_id'], period=r['period'], book_qty=r['book_qty'],
              counted_qty=r['counted_qty'], variance=r['variance']) for r in c.execute("SELECT * FROM stock_counts")]

DIRMAP={'receipt':'IN','opening':'ADJ_IN','adjustment':'ADJ_IN'}
mv=[]; lube_issue=[]; flags=collections.Counter()
for r in c.execute("SELECT * FROM transactions WHERE voided=0 ORDER BY product_id, txn_date, id"):
    if r['kind']=='issue':
        direction='OUT'; qty=r['qty_issued']
        # consumer resolution
        if r['asset_id']: consumer=('asset', md_asset[r['asset_id']]['reg_no'])
        elif r['project_id']: consumer=('project', md_project[r['project_id']]['name'])
        elif r['consumer_type'] in ('internal',): consumer=('internal', 'Internal')
        else: consumer=('unresolved', r['description']); flags['CONSUMER_UNRESOLVED']+=1
        lube_issue.append(dict(lube_issue_no="LUB-M-%06d"%r['id'], product_id=r['product_id'],
            issue_date=r['txn_date'], qty=qty, consumer_type=consumer[0], consumer=consumer[1],
            asset_id=r['asset_id'], project_id=r['project_id'], meter_reading=None,
            mr_no=r['mr_no'], balance_after=r['balance_after'], import_hash=r['import_hash']))
        flags['METER_MISSING']+=1   # source has no meter reading (contract §7.5 gap)
    else:
        direction=DIRMAP.get(r['kind'],'ADJ_IN'); qty=r['qty_received']
    mv.append(dict(item_id=r['product_id'], item=md_item[r['product_id']]['item_name'],
        mv_direction=direction, qty=qty, unit_cost=None, is_provisional=True,   # lube unpriced here -> value via stores GRN MWAC
        movement_date=r['txn_date'], source_doc_type={'receipt':'GRN','issue':'LUB','opening':'ADJ','adjustment':'ADJ'}[r['kind']],
        source_doc=r['mr_no'] or r['mtn_no'] or r['kind'], balance_after=r['balance_after'],
        import_hash=r['import_hash'], consumer_type=r['consumer_type']))

# ---- reconcile reconstructed on-hand vs source balance_after (last per product) ----
sign={'IN':1,'ADJ_IN':1,'OUT':-1,'ADJ_OUT':-1}
recon=collections.defaultdict(float)
for m in mv: recon[m['item_id']]+=sign.get(m['mv_direction'],0)*(m['qty'] or 0)
last_bal={}
for r in c.execute("SELECT product_id,balance_after FROM transactions t WHERE id=(SELECT id FROM transactions WHERE product_id=t.product_id AND voided=0 ORDER BY txn_date DESC,id DESC LIMIT 1)"):
    last_bal[r['product_id']]=r['balance_after']
mism=[pid for pid in recon if round(recon[pid],2)!=round(last_bal.get(pid,0),2)]

print("MASTERS  md_item(LUBRICANT)=%d  md_asset=%d (pending %d)  md_project=%d"%(
      len(md_item), len(md_asset), sum(1 for a in md_asset.values() if a['status']=='NEEDS_REVIEW'), len(md_project)))
print("LEDGER   movements=%d  %s"%(len(mv), dict(collections.Counter(m['mv_direction'] for m in mv))))
print("         all provisional-priced (lube unpriced in source) -> value via stores lube MWAC")
print("LUBE ISSUES=%d  consumer: %s"%(len(lube_issue), dict(collections.Counter(l['consumer_type'] for l in lube_issue))))
print("FLAGS    CONSUMER_UNRESOLVED=%d  METER_MISSING=%d (all issues)  pending aliases=%d"%(
      flags['CONSUMER_UNRESOLVED'], flags['METER_MISSING'], len(pending_alias)))
print("MONTHLY  inv_lube_monthly_balance rows=%d periods=%s"%(len(monthly), sorted({m['period'] for m in monthly})))
print("RECONCILE reconstructed on-hand vs source balance_after: %d/%d products match, %d mismatch"%(
      len(recon)-len(mism), len(recon), len(mism)))
json.dump(lube_issue[:3], open(OUT+"/oil_lube_issue_sample.json","w"), indent=2, default=str)
print("\nSAMPLE md_item:", json.dumps(list(md_item.values())[0], default=str))
print("SAMPLE lube_issue(asset):", json.dumps(next(l for l in lube_issue if l['consumer_type']=='asset'), default=str))
print("SAMPLE lube_issue(unresolved):", json.dumps(next(l for l in lube_issue if l['consumer_type']=='unresolved'), default=str))
print("SAMPLE pending alias:", json.dumps(pending_alias[0], default=str) if pending_alias else "none")
print("SAMPLE monthly:", json.dumps(monthly[0], default=str))
