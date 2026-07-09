#!/usr/bin/env python3
"""
Load the storesdb SQLite export into the UMMS PostgreSQL schema (sql/schema.sql).
Builds masters (uom, category, supplier, item, asset), reconstructs the append-only
mv_stock_ledger with running Moving-Average Cost, and the inv_stock_balance snapshot.
Emits ONE self-contained SQL file (bootstrap + data) to load via psql.

Usage:  python3 load_stores_to_postgres.py data/inventory.db build/umms_load.sql
Then:   psql -d umms -f sql/schema.sql
        psql -d umms -v ON_ERROR_STOP=1 -f build/umms_load.sql
"""
import sqlite3, sys, re, datetime, collections, os

SRC = sys.argv[1] if len(sys.argv) > 1 else "data/inventory.db"
OUT = sys.argv[2] if len(sys.argv) > 2 else "build/umms_load.sql"
os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
con = sqlite3.connect(SRC); con.row_factory = sqlite3.Row; c = con.cursor()

def norm(s): return re.sub(r'\s+', ' ', str(s or '').strip()).lower()
def Q(s):
    if s is None or s == '': return 'NULL'
    return "'" + str(s).replace("'", "''") + "'"
def N(x): return 'NULL' if x is None else repr(round(float(x), 4))

CAT2TYPE = {'battery':'BATTERY','oil & lubricants':'LUBRICANT','general items':'GENERAL','general consumables':'GENERAL'}
itype = lambda cat: CAT2TYPE.get(norm(cat), 'SPARE')
NONVEH = {'opening balance','main store','main stores','store','stores','unknown','in store','head office',''}
is_veh = lambda v: norm(v) and norm(v) not in NONVEH and not norm(v).startswith('rack')

# ---------- UoM ----------
units = set(['Pcs'])
for (u,) in c.execute("SELECT DISTINCT unit FROM general_items WHERE COALESCE(unit,'')<>''"): units.add(str(u).strip())
UOM = {}
utype = lambda u: 'VOLUME' if u.lower() in ('l','ltr','litre') else ('WEIGHT' if u.lower() in ('kg','g') else 'COUNT')
for i, u in enumerate(sorted(units), 1): UOM[norm(u)] = (i, u)
def uom_id(u): return UOM.get(norm(u), UOM['pcs'])[0]

# ---------- Categories ----------
cats = collections.OrderedDict()
for (cat,) in c.execute("SELECT DISTINCT category FROM items WHERE COALESCE(category,'')<>'' ORDER BY category"):
    cats.setdefault(norm(cat), str(cat).strip())
CAT = {n: (i, disp) for i, (n, disp) in enumerate(cats.items(), 1)}
def cat_id(cat): m = CAT.get(norm(cat)); return m[0] if m else 'NULL'

# ---------- Suppliers ----------
sup = collections.OrderedDict()
for (s,) in c.execute("SELECT DISTINCT supplierName FROM receipts WHERE TRIM(COALESCE(supplierName,''))<>'' ORDER BY supplierName"):
    sup.setdefault(str(s).strip(), None)
SUP = {s: i for i, s in enumerate(sup, 1)}
sup_type = {}
for r in c.execute("SELECT supplierName, purchaseSource, COUNT(*) n FROM receipts WHERE TRIM(COALESCE(supplierName,''))<>'' GROUP BY 1,2"):
    d = sup_type.setdefault(str(r['supplierName']).strip(), collections.Counter()); d[norm(r['purchaseSource'])] += r['n']
def styp(s):
    d = sup_type.get(s); dom = d.most_common(1)[0][0] if d else ''
    return 'HEAD_OFFICE' if 'head office' in dom else 'LOCAL'

# ---------- Items (dedup by normalized name) ----------
name_cat = collections.defaultdict(collections.Counter); name_disp = {}
gi = {norm(r['itemName']): r for r in c.execute("SELECT * FROM general_items")}
for tbl in ('items', 'issues', 'general_items', 'material_transfers'):
    for r in c.execute("SELECT itemName nm, category cat FROM %s" % tbl):
        n = norm(r['nm'])
        if not n: continue
        name_cat[n][norm(r['cat'])] += 1; name_disp.setdefault(n, str(r['nm']).strip())
ITEM = {}
for i, n in enumerate(sorted(name_disp), 1):
    dom = name_cat[n].most_common(1)[0][0]; g = gi.get(n)
    ITEM[n] = dict(id=i, name=name_disp[n], type=itype(dom), cat=cat_id(dom),
                   uom=uom_id(g['unit'] if g else 'Pcs'), reorder=(g['minStock'] if g else 0))
def item_id(nm): m = ITEM.get(norm(nm)); return m['id'] if m else None

# ---------- Assets ----------
veh = collections.OrderedDict()
for tbl, col in [('items','vehicleMachinery'), ('issues','vehicleMachinery')]:
    for (v,) in c.execute("SELECT DISTINCT %s FROM %s" % (col, tbl)):
        if is_veh(v): veh.setdefault(str(v).strip(), None)
ASSET = {v: i for i, v in enumerate(veh, 1)}
acls = lambda v: 'VEHICLE' if re.match(r'^[A-Za-z0-9]{1,4}-?\d{2,4}$', v) else 'MACHINE'

# ---------- Ledger reconstruction (running MWAC per item) ----------
itmap = {r['id']: r['itemName'] for r in c.execute("SELECT id,itemName FROM items")}
gimap = {r['id']: r['itemName'] for r in c.execute("SELECT id,itemName FROM general_items")}
movements = []  # (item_id, date, direction, qty, given_cost_or_None, srctype, srcid)
for r in c.execute("SELECT * FROM receipts"):
    iid = item_id(itmap.get(r['itemId']))
    if iid: movements.append((iid, r['deliveryDateISO'] or '2025-01-01',
        'RET_OUT' if norm(r['transactionType']) == 'return' else 'IN', r['qty'] or 0, r['unitPrice'], 'GRN', r['id']))
for r in c.execute("SELECT * FROM issues"):
    iid = item_id(r['itemName'])
    if iid: movements.append((iid, r['issueDateISO'] or '2025-01-01', 'OUT', r['qty'] or 0, None, 'ISS', r['id']))
for r in c.execute("SELECT * FROM general_item_transactions"):
    iid = item_id(gimap.get(r['itemId']))
    if not iid: continue
    if norm(r['vehicleMachinery']) == 'opening balance':
        movements.append((iid, r['txDateISO'] or '2025-01-01', 'ADJ_IN', r['qty'] or 0, None, 'ADJ', r['id']))
    elif norm(r['txType']) == 'receive':
        movements.append((iid, r['txDateISO'] or '2025-01-01', 'IN', r['qty'] or 0, None, 'GRN', r['id']))
    else:
        movements.append((iid, r['txDateISO'] or '2025-01-01', 'OUT', r['qty'] or 0, None, 'ISS', r['id']))

movements.sort(key=lambda m: (m[0], m[1], m[6]))
bal = collections.defaultdict(float); avg = collections.defaultdict(float)
ledger = []; pending = 0
SIGN = {'IN':1,'RET_IN':1,'ADJ_IN':1,'OUT':-1,'RET_OUT':-1,'ADJ_OUT':-1}
for lid, (iid, date, direction, qty, given, st, sid) in enumerate(movements, 1):
    qty = abs(float(qty or 0)); prov = False
    if qty == 0:
        continue                                    # skip zero-qty noise rows
    if SIGN[direction] > 0:
        if given is not None:                       # priced receipt
            ucost = float(given)
            nb = bal[iid] + qty
            avg[iid] = (bal[iid]*avg[iid] + qty*ucost)/nb if nb > 0 else ucost
            bal[iid] = nb
        else:                                        # unpriced receipt / opening -> provisional at current avg
            ucost = avg[iid]; bal[iid] += qty; prov = True; pending += 1
    else:
        ucost = avg[iid]; bal[iid] -= qty            # issue at MWAC
    val = round(SIGN[direction]*qty*ucost, 2)
    ledger.append((lid, date, iid, direction, qty, round(ucost,4), val,
                   round(bal[iid],4), round(bal[iid]*avg[iid],2), round(avg[iid],4), st, sid, prov))

# ---------- emit SQL ----------
def batched(rows, prefix, size=400):
    out = []
    for i in range(0, len(rows), size):
        out.append(prefix + "\n" + ",\n".join(rows[i:i+size]) + ";")
    return "\n".join(out)

w = open(OUT, "w"); W = w.write
W("-- UMMS stores load (generated). Run AFTER sql/schema.sql on an empty DB.\nBEGIN;\nSET CONSTRAINTS ALL DEFERRED;\n")
W("INSERT INTO sec_user (user_id,username,full_name,password_hash,created_by,created_at) OVERRIDING SYSTEM VALUE VALUES (1,'system','Migration System','!disabled',1,now());\n")
W("INSERT INTO md_location (location_id,location_code,location_name,location_type,site_code,created_by) OVERRIDING SYSTEM VALUE VALUES (1,'MAIN','Main Site','SITE','MN0',1),(2,'MSTORE','Main Store','STORE',NULL,1);\n")
W("UPDATE md_location SET parent_location_id=1 WHERE location_id=2;\n")
W(batched([f"({i},{Q(disp[:15])},{Q(disp)},{Q(utype(disp))},1)" for n,(i,disp) in UOM.items()],
          "INSERT INTO md_uom (uom_id,uom_code,uom_name,uom_type,created_by) OVERRIDING SYSTEM VALUE VALUES") + "\n")
W(batched([f"({i},{Q('CAT%03d'%i)},{Q(disp)},1)" for n,(i,disp) in CAT.items()],
          "INSERT INTO md_item_category (category_id,category_code,category_name,created_by) OVERRIDING SYSTEM VALUE VALUES") + "\n")
W(batched([f"({i},{Q('SUP-%04d'%i)},{Q(s)},{Q(styp(s))},1)" for s,i in SUP.items()],
          "INSERT INTO md_supplier (supplier_id,supplier_no,supplier_name,supplier_type,created_by) OVERRIDING SYSTEM VALUE VALUES") + "\n")
W(batched([f"({m['id']},{Q('ITM-%06d'%m['id'])},{Q(m['name'][:150])},{Q(m['type'])},{m['cat']},{m['uom']},{N(m['reorder'])},{'TRUE' if m['type']=='BATTERY' else 'FALSE'},1)"
           for m in ITEM.values()],
          "INSERT INTO md_item (item_id,item_no,item_name,item_type,category_id,base_uom_id,reorder_level,is_serial_tracked,created_by) OVERRIDING SYSTEM VALUE VALUES") + "\n")
W(batched([f"({i},{Q('AST-%05d'%i)},{Q(v[:150])},{Q(acls(v))},1,1)" for v,i in ASSET.items()],
          "INSERT INTO md_asset (asset_id,asset_no,asset_name,asset_class,site_id,created_by) OVERRIDING SYSTEM VALUE VALUES") + "\n")
W(batched([f"({lid},{Q('MV-%07d'%lid)},{Q(date)},{iid},2,{Q(dr)},{N(qty)},{N(uc)},{va},{N(rq)},{rv},{N(ra)},{Q(st)},{sid},{'TRUE' if prov else 'FALSE'},1,1,1)"
           for (lid,date,iid,dr,qty,uc,va,rq,rv,ra,st,sid,prov) in ledger],
          "INSERT INTO mv_stock_ledger (ledger_id,movement_no,movement_date,item_id,location_id,mv_direction,qty,unit_cost,value_amt,running_balance_qty,running_balance_value,running_avg_cost,source_doc_type,source_doc_id,is_provisional,posted_by,site_id,created_by) OVERRIDING SYSTEM VALUE VALUES") + "\n")
W(batched([f"({iid},2,{N(bal[iid])},{N(avg[iid])},{round(bal[iid]*avg[iid],2)},1)" for iid in sorted(bal)],
          "INSERT INTO inv_stock_balance (item_id,location_id,on_hand_qty,moving_avg_cost,stock_value,created_by) VALUES") + "\n")
W("COMMIT;\n")
# fix identity sequences after OVERRIDING SYSTEM VALUE
for t, col in [('sec_user','user_id'),('md_location','location_id'),('md_uom','uom_id'),('md_item_category','category_id'),
               ('md_supplier','supplier_id'),('md_item','item_id'),('md_asset','asset_id'),('mv_stock_ledger','ledger_id')]:
    W(f"SELECT setval(pg_get_serial_sequence('{t}','{col}'), (SELECT COALESCE(MAX({col}),1) FROM {t}));\n")
w.close()
print(f"masters: uom={len(UOM)} cat={len(CAT)} supplier={len(SUP)} item={len(ITEM)} asset={len(ASSET)}")
print(f"ledger movements={len(ledger)}  provisional(pending-price)={pending}")
print(f"wrote {OUT}")
