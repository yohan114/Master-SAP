#!/usr/bin/env python3
"""
UMMS stores importer — inventory.db (SQLite) -> canonical masters + stock ledger.
Extracts md_item / md_supplier / md_asset / md_battery / md_location, reconstructs
mv_stock_ledger (IN/OUT/XFER/ADJ) with moving-average cost, and flags pending pricing.
Run: python3 stores_etl.py <inventory.db> <outdir>
"""
import sqlite3, sys, re, json, collections
DB  = sys.argv[1] if len(sys.argv)>1 else "data/inventory.db"
OUT = sys.argv[2] if len(sys.argv)>2 else "."
con=sqlite3.connect(DB); con.row_factory=sqlite3.Row; c=con.cursor()

def norm(s): return re.sub(r'\s+',' ',str(s or '').strip()).lower()
CAT2TYPE = {'battery':'BATTERY','oil & lubricants':'LUBRICANT','general items':'GENERAL',
            'general consumables':'GENERAL'}
def item_type(cat): return CAT2TYPE.get(norm(cat),'SPARE')
NONVEHICLE = {'opening balance','main store','main stores','store','stores','unknown','',
              'in store','main store ', 'head office'}
def is_vehicle(v):
    n=norm(v)
    return n and n not in NONVEHICLE and not n.startswith('rack')

# ---------- MASTER: md_item (dedup by normalized name; type from dominant category) ----------
name_cat=collections.defaultdict(collections.Counter); name_disp={}
for tbl,namecol,catcol in [('items','itemName','category'),('issues','itemName','category'),
                           ('general_items','itemName','category'),('material_transfers','itemName','category')]:
    for r in c.execute("SELECT %s AS nm,%s AS cat FROM %s"%(namecol,catcol,tbl)):
        n=norm(r['nm'])
        if not n: continue
        name_cat[n][norm(r['cat'])]+=1
        name_disp.setdefault(n, str(r['nm']).strip())
# enrich general item attributes
gi={norm(r['itemName']):r for r in c.execute("SELECT * FROM general_items")}
md_item={}; i=0
for n in sorted(name_disp):
    i+=1; dom=name_cat[n].most_common(1)[0][0]
    g=gi.get(n)
    md_item[n]=dict(item_id=i, item_no="ITM-%06d"%i, item_name=name_disp[n],
        category=dom or 'general items', item_type=item_type(dom),
        uom=(g['unit'] if g else 'Pcs'), bin=(g['rackNumber'] if g else None),
        reorder=(g['minStock'] if g else 0), part_no=(g['partNumber'] if g else None),
        is_serial=(item_type(dom)=='BATTERY'))
def item_id(nm):
    m=md_item.get(norm(nm)); return m['item_id'] if m else None

# ---------- MASTER: md_supplier (dominant purchaseSource -> supplier_type) ----------
sup=collections.defaultdict(collections.Counter)
for r in c.execute("SELECT supplierName,purchaseSource FROM receipts WHERE TRIM(COALESCE(supplierName,''))<>''"):
    sup[str(r['supplierName']).strip()][norm(r['purchaseSource'])]+=1
def sup_type(src):
    if 'head office' in src: return 'HEAD_OFFICE'
    return 'LOCAL'
md_supplier={s:dict(supplier_id=idx+1, supplier_no="SUP-%04d"%(idx+1), name=s,
                    supplier_type=sup_type(cnt.most_common(1)[0][0])) for idx,(s,cnt) in enumerate(sorted(sup.items()))}

# ---------- MASTER: md_asset (vehicles, excluding non-vehicle tokens) ----------
veh=set()
for tbl,col in [('items','vehicleMachinery'),('issues','vehicleMachinery'),
                ('material_transfers','fromLocation'),('material_transfers','toLocation'),
                ('batteries','currentVehicle')]:
    for r in c.execute("SELECT DISTINCT %s AS v FROM %s"%(col,tbl)):
        if is_vehicle(r['v']): veh.add(str(r['v']).strip())
md_asset={v:dict(asset_id=idx+1, asset_no=v, reg_no=v,
                 asset_class=('VEHICLE' if re.match(r'^[A-Za-z0-9]{1,4}-?\d{2,4}$',v) else 'MACHINE'))
          for idx,v in enumerate(sorted(veh))}

# ---------- MASTER: md_battery ----------
md_battery=[dict(battery_id=r['id'], battery_serial_no=r['serialNumber'], item=r['itemName'],
                 brand=r['brand'], condition=r['condition'], status=('IN_STOCK' if norm(r['state'])=='in store' else 'IN_SERVICE'),
                 current_asset=r['currentVehicle'] or None, acq_date=r['purchaseDateISO'])
            for r in c.execute("SELECT * FROM batteries")]

# ---------- MASTER: md_location (stores/racks/transfer endpoints) ----------
locs=set(['Main Store'])
for r in c.execute("SELECT DISTINCT rackNumber v FROM general_items WHERE COALESCE(rackNumber,'')<>''"): locs.add('Rack '+str(r['v']))
for tbl,col in [('material_transfers','fromLocation'),('material_transfers','toLocation')]:
    for r in c.execute("SELECT DISTINCT %s v FROM %s"%(col,tbl)):
        n=norm(r['v'])
        if n in ('main store','main stores','store'): locs.add('Main Store')

# ---------- LEDGER reconstruction ----------
mv=[]  # movement rows
def add(item_name, direction, qty, unit_cost, date, src, doc, provisional=False, note=None):
    iid=item_id(item_name)
    mv.append(dict(item_id=iid, item=str(item_name).strip(), mv_direction=direction, qty=qty,
                   unit_cost=unit_cost, movement_date=date, source_doc_type=src, source_doc=doc,
                   is_provisional=provisional, unresolved_item=(iid is None), note=note))
# receipts -> IN  (resolve item via items.itemId -> items.itemName)
itmap={r['id']:r['itemName'] for r in c.execute("SELECT id,itemName FROM items")}
pending_price=0
for r in c.execute("SELECT * FROM receipts"):
    nm=itmap.get(r['itemId'])
    prov = r['unitPrice'] is None
    if prov: pending_price+=1
    d='XFER' if False else ('RET' if norm(r['transactionType'])=='return' else 'IN')
    add(nm, 'RET_IN' if d=='RET' else 'IN', r['qty'] or 0, r['unitPrice'], r['deliveryDateISO'],
        'GRN', r['grnNumber'] or '(no-grn)', provisional=prov)
# issues -> OUT
for r in c.execute("SELECT * FROM issues"):
    add(r['itemName'],'OUT', r['qty'] or 0, None, r['issueDateISO'],'ISS', r['mrnNum'] or '(issue)')
# general item tx -> IN/OUT (opening balance detection)
giname={r['id']:r['itemName'] for r in c.execute("SELECT id,itemName FROM general_items")}
opening=0
for r in c.execute("SELECT * FROM general_item_transactions"):
    nm=giname.get(r['itemId'])
    if norm(r['vehicleMachinery'])=='opening balance':
        add(nm,'ADJ_IN', r['qty'] or 0, None, r['txDateISO'],'ADJ','OPENING', note='opening'); opening+=1
    elif norm(r['txType'])=='receive':
        add(nm,'IN', r['qty'] or 0, None, r['txDateISO'],'GRN', r['grnNum'] or '(gi-recv)')
    else:
        add(nm,'OUT', r['qty'] or 0, None, r['txDateISO'],'ISS', r['mrnNum'] or '(gi-issue)')
# material_transfers -> XFER_OUT + XFER_IN
for r in c.execute("SELECT * FROM material_transfers"):
    add(r['itemName'],'XFER_OUT', r['qty'] or 0, None, r['transferDateISO'],'TRF', r['mtnNum'])
    add(r['itemName'],'XFER_IN',  r['qty'] or 0, None, r['transferDateISO'],'TRF', r['mtnNum'])

# ---------- per-item on-hand + MWAC (priced receipts only) ----------
bal=collections.defaultdict(float); val=collections.defaultdict(float)
signs={'IN':1,'ADJ_IN':1,'XFER_IN':1,'RET_IN':1,'OUT':-1,'XFER_OUT':-1,'ADJ_OUT':-1,'RET_OUT':-1}
for m in sorted(mv, key=lambda x:(x['item'], x['movement_date'] or '')):
    s=signs.get(m['mv_direction'],0); bal[m['item']]+=s*m['qty']
    if m['mv_direction'] in ('IN',) and m['unit_cost']: val[m['item']]+=m['qty']*m['unit_cost']

# ---------- REPORT ----------
print("MASTERS EXTRACTED")
print("  md_item      :", len(md_item), " (types: %s)"%dict(collections.Counter(v['item_type'] for v in md_item.values())))
print("  md_supplier  :", len(md_supplier), " (HEAD_OFFICE:%d LOCAL:%d)"%(
      sum(1 for v in md_supplier.values() if v['supplier_type']=='HEAD_OFFICE'),
      sum(1 for v in md_supplier.values() if v['supplier_type']=='LOCAL')))
print("  md_asset     :", len(md_asset))
print("  md_battery   :", len(md_battery))
print("  md_location  :", len(locs))
print("\nSTOCK LEDGER (mv_stock_ledger) reconstructed")
print("  total movements:", len(mv), dict(collections.Counter(m['mv_direction'] for m in mv)))
print("  provisional (no price):", sum(1 for m in mv if m['is_provisional']), " -> inv_pending_price")
print("  opening-balance rows:", opening)
print("  movements with UNRESOLVED item name:", sum(1 for m in mv if m['unresolved_item']))
print("  distinct items with on-hand computed:", len(bal))

import csv
json.dump({'md_item_sample':list(md_item.values())[:2]}, open(OUT+'/stores_masters_sample.json','w'), indent=2, default=str)
# sample canonical payloads
grn_hdr={r['grnNumber'] for r in c.execute("SELECT grnNumber FROM receipts WHERE COALESCE(grnNumber,'')<>''")}
print("\nSAMPLE — md_item:", json.dumps(list(md_item.values())[100], default=str))
print("SAMPLE — md_supplier:", json.dumps(list(md_supplier.values())[0], default=str))
print("SAMPLE — md_battery:", json.dumps(md_battery[0], default=str))
sample_grn=[m for m in mv if m['source_doc_type']=='GRN' and not m['is_provisional']][:1]
print("SAMPLE — priced GRN ledger row:", json.dumps(sample_grn[0], default=str) if sample_grn else "none")
print("SAMPLE — pending-price row:", json.dumps(next(m for m in mv if m['is_provisional']), default=str))
print("\ndistinct GRN headers:", len(grn_hdr), " | receipts w/o GRN -> provisional GRN:", sum(1 for r in c.execute("SELECT 1 FROM receipts WHERE COALESCE(grnNumber,'')=''")))
