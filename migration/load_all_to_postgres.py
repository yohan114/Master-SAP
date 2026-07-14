#!/usr/bin/env python3
"""
Unified loader: loads the WHOLE operation into one UMMS PostgreSQL DB and proves the
cross-module job-cost chain in SQL:
  stores masters + mv_stock_ledger + inv_stock_balance   (from inventory.db)
  + md_asset (unified fleet) + md_employee/grade/labour_rate (from Daily_Work_Done)
  + tx_jobcard (from Job_Record 'Requested job') + tx_job_progress + tx_job_labour
  + cost_job_summary   (labour rolled up per job)
Emits one self-contained SQL file to run after sql/schema.sql.

Usage: python3 load_all_to_postgres.py <inventory.db> <Job_Record.xlsx> <Daily_Work_Done.xlsx> <out.sql>
"""
import sqlite3, openpyxl, sys, re, os, datetime, collections
INV = sys.argv[1] if len(sys.argv) > 1 else "data/inventory.db"
JB  = sys.argv[2] if len(sys.argv) > 2 else "data/Job_Record.xlsx"
DW  = sys.argv[3] if len(sys.argv) > 3 else "data/Daily_Work_Done.xlsx"
OUT = sys.argv[4] if len(sys.argv) > 4 else "build/umms_all.sql"
os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)

def norm(s): return re.sub(r'\s+', ' ', str(s or '').strip()).lower()
def nreg(s): return re.sub(r'[^a-z0-9]', '', str(s or '').lower())
def Q(s): return 'NULL' if s is None or s == '' else "'" + str(s).replace("'", "''") + "'"
def N(x): return 'NULL' if x is None else repr(round(float(x), 4))
def d2(v):
    if isinstance(v, (datetime.datetime, datetime.date)): return v.date() if isinstance(v, datetime.datetime) else v
    m = re.match(r'(\d{1,2})/(\d{1,2})/(\d{4})', str(v or ''))
    if m:
        mo, da, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try: return datetime.date(yr, mo, da)
        except: return None
    return None
def batched(rows, prefix, size=400):
    return "\n".join(prefix + "\n" + ",\n".join(rows[i:i+size]) + ";" for i in range(0, len(rows), size)) if rows else "-- (none)"

con = sqlite3.connect(INV); con.row_factory = sqlite3.Row; c = con.cursor()

# ===== stores masters (uom, category, supplier, item) — same logic as load_stores =====
CAT2TYPE = {'battery':'BATTERY','oil & lubricants':'LUBRICANT','general items':'GENERAL','general consumables':'GENERAL'}
itype = lambda cat: CAT2TYPE.get(norm(cat), 'SPARE')
units = set(['Pcs'])
for (u,) in c.execute("SELECT DISTINCT unit FROM general_items WHERE COALESCE(unit,'')<>''"): units.add(str(u).strip())
UOM = {norm(u): (i, u) for i, u in enumerate(sorted(units), 1)}
uom_id = lambda u: UOM.get(norm(u), UOM['pcs'])[0]
utype = lambda u: 'VOLUME' if u.lower() in ('l','ltr','litre') else ('WEIGHT' if u.lower() in ('kg','g') else 'COUNT')
cats = collections.OrderedDict()
for (cat,) in c.execute("SELECT DISTINCT category FROM items WHERE COALESCE(category,'')<>'' ORDER BY 1"): cats.setdefault(norm(cat), str(cat).strip())
CAT = {n: (i, d) for i, (n, d) in enumerate(cats.items(), 1)}
cat_id = lambda cat: (CAT.get(norm(cat)) or ('NULL',))[0] if CAT.get(norm(cat)) else 'NULL'
supd = collections.OrderedDict()
for (s,) in c.execute("SELECT DISTINCT supplierName FROM receipts WHERE TRIM(COALESCE(supplierName,''))<>'' ORDER BY 1"): supd.setdefault(str(s).strip(), None)
SUP = {s: i for i, s in enumerate(supd, 1)}
styc = collections.defaultdict(collections.Counter)
for r in c.execute("SELECT supplierName s, purchaseSource p, COUNT(*) n FROM receipts WHERE TRIM(COALESCE(supplierName,''))<>'' GROUP BY 1,2"):
    styc[str(r['s']).strip()][norm(r['p'])] += r['n']
styp = lambda s: 'HEAD_OFFICE' if (styc.get(s) and 'head office' in styc[s].most_common(1)[0][0]) else 'LOCAL'
name_cat = collections.defaultdict(collections.Counter); name_disp = {}
gi = {norm(r['itemName']): r for r in c.execute("SELECT * FROM general_items")}
for tbl in ('items', 'issues', 'general_items', 'material_transfers'):
    for r in c.execute("SELECT itemName nm, category cat FROM %s" % tbl):
        n = norm(r['nm'])
        if n: name_cat[n][norm(r['cat'])] += 1; name_disp.setdefault(n, str(r['nm']).strip())
ITEM = {}
for i, n in enumerate(sorted(name_disp), 1):
    dom = name_cat[n].most_common(1)[0][0]; g = gi.get(n)
    ITEM[n] = dict(id=i, name=name_disp[n], type=itype(dom), cat=cat_id(dom), uom=uom_id(g['unit'] if g else 'Pcs'), reorder=(g['minStock'] if g else 0))
item_id = lambda nm: (ITEM.get(norm(nm)) or {}).get('id')

# ===== unified fleet (stores + job + labour vehicles) =====
wbJ = openpyxl.load_workbook(JB, data_only=True); wsR = wbJ['Requested job']; wsC = wbJ['C-job']
wbD = openpyxl.load_workbook(DW, data_only=True); wsL = wbD['From 1st Dec2025']; wsRate = wbD['Labor Hour']
NONVEH = {'openingbalance','mainstore','mainstores','store','stores','unknown','instore','headoffice',''}
def add_asset(store, v):
    k = nreg(v)
    if k and k not in NONVEH and not k.startswith('rack'): store.setdefault(k, str(v).strip())
adisp = collections.OrderedDict()
for tbl, col in [('items','vehicleMachinery'), ('issues','vehicleMachinery')]:
    for (v,) in c.execute("SELECT DISTINCT %s FROM %s" % (col, tbl)): add_asset(adisp, v)
for r in range(2, wsR.max_row+1): add_asset(adisp, wsR.cell(r, 2).value)
for r in range(2, wsC.max_row+1): add_asset(adisp, wsC.cell(r, 3).value)
ASSET = {k: i for i, k in enumerate(adisp, 1)}
GEN_ASSET = len(ASSET) + 1                       # catch-all for job cards with no vehicle
acls = lambda v: 'VEHICLE' if re.match(r'^[a-z0-9]{1,4}\d{2,4}$', v) else 'MACHINE'

# ===== employees / grades / labour rates from Daily Work =====
RATE = {}
for r in range(4, wsRate.max_row+1):
    nm, pr = wsRate.cell(r, 2).value, wsRate.cell(r, 3).value
    if nm not in (None, ""):
        for a in str(nm).split('/'): RATE[a.strip().lower()] = pr
ALIAS = {'vinoth':'vinod','seethananda':'seethananda','seetha':'seetha','nawathilake':'nawathilaka','themindu':'theminda','electrical vinod':'vinod m','dilipa':'dileepa','dilip':'dileepa'}
def canon(tok):
    k = tok.strip().lower(); return ALIAS.get(k, k)
def emp_rate(tok):
    return RATE.get(canon(tok))
# gather distinct mechanics
mechs = collections.OrderedDict()
labour_rows = []   # (date, norm_veh, [mech tokens], hours, work_done)
for r in range(2, wsL.max_row+1):
    veh = wsL.cell(r, 2).value; dt = d2(wsL.cell(r, 1).value); mech = wsL.cell(r, 4).value; t = wsL.cell(r, 5).value
    if all(x in (None, "") for x in (veh, dt, mech, t)): continue
    hrs = t if isinstance(t, (int, float)) else None
    toks = [x.strip() for x in re.split(r'[,/&+]| and ', str(mech or '')) if x.strip()]
    for tk in toks: mechs.setdefault(canon(tk), tk)
    labour_rows.append((dt, nreg(veh), toks, hrs, str(wsL.cell(r, 3).value or '')))
# grades = distinct rate values (+ UNSET)
gradevals = sorted({float(emp_rate(t) or 0) for t in mechs});
if 0 not in gradevals: gradevals = [0] + gradevals
GRADE = {v: i for i, v in enumerate(gradevals, 1)}     # rate value -> grade_id
EMP = {}                                                # canon name -> (emp_id, grade_id, rate)
for i, (cn, disp) in enumerate(mechs.items(), 1):
    rt = float(emp_rate(cn) or 0); EMP[cn] = (i, GRADE[rt], rt, disp)

# ===== job cards (Requested register) =====
jobs = []; seen_no = collections.Counter()
for r in range(2, wsR.max_row+1):
    jn = wsR.cell(r, 1).value
    if jn in (None, ""): continue
    veh = wsR.cell(r, 2).value; st = d2(wsR.cell(r, 4).value); en = d2(wsR.cell(r, 5).value)
    cancel = bool(re.search('cancel', str(wsR.cell(r, 4).value or ''), re.I))
    jno = str(jn).strip(); seen_no[jno] += 1
    if seen_no[jno] > 1: jno = f"{jno}#{seen_no[jno]}"
    aid = ASSET.get(nreg(veh), GEN_ASSET)
    jobs.append(dict(id=len(jobs)+1, no=jno, asset=aid, veh=nreg(veh),
        date=st or datetime.date(2025,1,1), start=st, end=en or (st + datetime.timedelta(days=60) if st else None),
        desc=str(wsR.cell(r, 3).value or ''), status='CANCELLED' if cancel else 'PENDING_COSTING'))
jobs_by_veh = collections.defaultdict(list)
for j in jobs:
    if j['veh'] and j['start']: jobs_by_veh[j['veh']].append(j)

# ===== attach labour to jobs by vehicle + date window =====
progress = []; labour = []; jobcost = collections.defaultdict(float)
for (dt, nv, toks, hrs, wd) in labour_rows:
    cand = next((j for j in jobs_by_veh.get(nv, []) if j['start'] <= dt <= j['end']), None)
    if not cand: continue
    progress.append(dict(id=len(progress)+1, job=cand['id'], date=dt, work=wd[:400]))
    for tk in toks:
        cn = canon(tk); emp = EMP[cn]; rate = emp[2]; cost = (hrs or 0) * rate
        labour.append(dict(id=len(labour)+1, job=cand['id'], emp=emp[0], grade=emp[1], date=dt,
                           hours=hrs or 0, rate=rate, cost=cost))
        cand['status'] = 'CLOSED'; jobcost[cand['id']] += cost

# ================= emit SQL =================
w = open(OUT, "w"); W = w.write
W("-- UMMS unified load (generated). Run AFTER sql/schema.sql on an empty DB.\nBEGIN;\nSET CONSTRAINTS ALL DEFERRED;\n")
W("INSERT INTO sec_user (user_id,username,full_name,password_hash,created_by) OVERRIDING SYSTEM VALUE VALUES (1,'system','Migration System','!disabled',1);\n")
W("INSERT INTO md_location (location_id,location_code,location_name,location_type,site_code,created_by) OVERRIDING SYSTEM VALUE VALUES (1,'MAIN','Main Site','SITE','MN0',1),(2,'MSTORE','Main Store','STORE',NULL,1),(3,'WSHOP','Workshop','STORE',NULL,1);\n")
W("UPDATE md_location SET parent_location_id=1 WHERE location_id IN (2,3);\n")
W(batched([f"({i},{Q(disp[:15])},{Q(disp)},{Q(utype(disp))},1)" for n,(i,disp) in UOM.items()],
          "INSERT INTO md_uom (uom_id,uom_code,uom_name,uom_type,created_by) OVERRIDING SYSTEM VALUE VALUES")+"\n")
W(batched([f"({i},{Q('CAT%03d'%i)},{Q(d)},1)" for n,(i,d) in CAT.items()],
          "INSERT INTO md_item_category (category_id,category_code,category_name,created_by) OVERRIDING SYSTEM VALUE VALUES")+"\n")
W(batched([f"({i},{Q('SUP-%04d'%i)},{Q(s)},{Q(styp(s))},1)" for s,i in SUP.items()],
          "INSERT INTO md_supplier (supplier_id,supplier_no,supplier_name,supplier_type,created_by) OVERRIDING SYSTEM VALUE VALUES")+"\n")
W(batched([f"({m['id']},{Q('ITM-%06d'%m['id'])},{Q(m['name'][:150])},{Q(m['type'])},{m['cat']},{m['uom']},{N(m['reorder'])},{'TRUE' if m['type']=='BATTERY' else 'FALSE'},1)" for m in ITEM.values()],
          "INSERT INTO md_item (item_id,item_no,item_name,item_type,category_id,base_uom_id,reorder_level,is_serial_tracked,created_by) OVERRIDING SYSTEM VALUE VALUES")+"\n")
W(batched([f"({i},{Q('AST-%05d'%i)},{Q(adisp[k][:150])},{Q(acls(k))},1,1)" for k,i in ASSET.items()] +
          [f"({GEN_ASSET},'AST-GEN','General / Unassigned','EQUIPMENT',1,1)"],
          "INSERT INTO md_asset (asset_id,asset_no,asset_name,asset_class,site_id,created_by) OVERRIDING SYSTEM VALUE VALUES")+"\n")
W(batched([f"({i},{Q('GRD-%d'%int(v))},{Q('Rate %d'%int(v))},1)" for v,i in GRADE.items()],
          "INSERT INTO md_employee_grade (grade_id,grade_code,grade_name,created_by) OVERRIDING SYSTEM VALUE VALUES")+"\n")
W(batched([f"({i},'2025-01-01',{N(v)},1)" for v,i in GRADE.items()],
          "INSERT INTO md_labour_rate (grade_id,effective_date,hourly_rate,created_by) VALUES")+"\n")
W(batched([f"({e[0]},{Q('EMP-%04d'%e[0])},{Q(e[3][:150])},TRUE,{e[1]},1,1)" for cn,e in EMP.items()],
          "INSERT INTO md_employee (employee_id,employee_no,employee_name,is_technician,grade_id,site_id,created_by) OVERRIDING SYSTEM VALUE VALUES")+"\n")
# ---- stores ledger + balances (reconstruct MWAC) ----
itmap = {r['id']: r['itemName'] for r in c.execute("SELECT id,itemName FROM items")}
gimap = {r['id']: r['itemName'] for r in c.execute("SELECT id,itemName FROM general_items")}
movements = []
for r in c.execute("SELECT * FROM receipts"):
    iid = item_id(itmap.get(r['itemId']))
    if iid: movements.append((iid, r['deliveryDateISO'] or '2025-01-01', 'RET_OUT' if norm(r['transactionType'])=='return' else 'IN', r['qty'] or 0, r['unitPrice'], 'GRN', r['id']))
for r in c.execute("SELECT * FROM issues"):
    iid = item_id(r['itemName'])
    if iid: movements.append((iid, r['issueDateISO'] or '2025-01-01', 'OUT', r['qty'] or 0, None, 'ISS', r['id']))
for r in c.execute("SELECT * FROM general_item_transactions"):
    iid = item_id(gimap.get(r['itemId']))
    if not iid: continue
    d = 'ADJ_IN' if norm(r['vehicleMachinery'])=='opening balance' else ('IN' if norm(r['txType'])=='receive' else 'OUT')
    movements.append((iid, r['txDateISO'] or '2025-01-01', d, r['qty'] or 0, None, 'ADJ' if d=='ADJ_IN' else ('GRN' if d=='IN' else 'ISS'), r['id']))
movements.sort(key=lambda m: (m[0], m[1], m[6]))
bal = collections.defaultdict(float); avg = collections.defaultdict(float); SIGN={'IN':1,'RET_IN':1,'ADJ_IN':1,'OUT':-1,'RET_OUT':-1,'ADJ_OUT':-1}
led = []
for (iid, date, dr, qty, given, st, sid) in movements:
    qty = abs(float(qty or 0))
    if qty == 0: continue
    prov = False
    if SIGN[dr] > 0:
        if given is not None:
            uc = float(given); nb = bal[iid]+qty; avg[iid] = (bal[iid]*avg[iid]+qty*uc)/nb if nb>0 else uc; bal[iid]=nb
        else: uc = avg[iid]; bal[iid]+=qty; prov=True
    else:
        uc = avg[iid]; bal[iid]-=qty
    led.append((len(led)+1, date, iid, dr, qty, round(uc,4), round(SIGN[dr]*qty*uc,2), round(bal[iid],4), round(bal[iid]*avg[iid],2), round(avg[iid],4), st, sid, prov))
W(batched([f"({l[0]},{Q('MV-%07d'%l[0])},{Q(l[1])},{l[2]},2,{Q(l[3])},{N(l[4])},{N(l[5])},{l[6]},{N(l[7])},{l[8]},{N(l[9])},{Q(l[10])},{l[11]},{'TRUE' if l[12] else 'FALSE'},1,1,1)" for l in led],
          "INSERT INTO mv_stock_ledger (ledger_id,movement_no,movement_date,item_id,location_id,mv_direction,qty,unit_cost,value_amt,running_balance_qty,running_balance_value,running_avg_cost,source_doc_type,source_doc_id,is_provisional,posted_by,site_id,created_by) OVERRIDING SYSTEM VALUE VALUES")+"\n")
W(batched([f"({iid},2,{N(bal[iid])},{N(avg[iid])},{round(bal[iid]*avg[iid],2)},1)" for iid in sorted(bal)],
          "INSERT INTO inv_stock_balance (item_id,location_id,on_hand_qty,moving_avg_cost,stock_value,created_by) VALUES")+"\n")
# ---- job cards ----
W(batched([f"({j['id']},{Q(j['no'][:30])},{Q(j['date'])},{j['asset']},3,{Q(j['status'])},{Q(j['desc'][:400])},1,1)" for j in jobs],
          "INSERT INTO tx_jobcard (jobcard_id,jobcard_no,jobcard_date,asset_id,location_id,jobcard_status,reported_defect,site_id,created_by) OVERRIDING SYSTEM VALUE VALUES")+"\n")
W(batched([f"({p['id']},{p['job']},{Q(p['date'])},{Q(p['work'])},1)" for p in progress],
          "INSERT INTO tx_job_progress (progress_id,jobcard_id,progress_date,work_done,created_by) OVERRIDING SYSTEM VALUE VALUES")+"\n")
W(batched([f"({l['id']},{Q('LAB-%06d'%l['id'])},{l['job']},{l['emp']},{Q(l['date'])},{N(l['hours'])},{l['grade']},{N(l['rate'])},{N(l['cost'])},1,1)" for l in labour],
          "INSERT INTO tx_job_labour (labour_id,labour_no,jobcard_id,employee_id,labour_date,hours,grade_id,hourly_rate,labour_cost,site_id,created_by) OVERRIDING SYSTEM VALUE VALUES")+"\n")
W(batched([f"({i},{jid},{N(round(cst,2))},{N(round(cst,2))},'CALCULATED',1,1)" for i,(jid,cst) in enumerate(jobcost.items(),1)],
          "INSERT INTO cost_job_summary (summary_id,jobcard_id,labour_cost,total_job_cost,cost_status,site_id,created_by) OVERRIDING SYSTEM VALUE VALUES")+"\n")
W("COMMIT;\n")
for t, col in [('sec_user','user_id'),('md_location','location_id'),('md_uom','uom_id'),('md_item_category','category_id'),('md_supplier','supplier_id'),('md_item','item_id'),('md_asset','asset_id'),('md_employee_grade','grade_id'),('md_employee','employee_id'),('mv_stock_ledger','ledger_id'),('tx_jobcard','jobcard_id'),('tx_job_progress','progress_id'),('tx_job_labour','labour_id'),('cost_job_summary','summary_id')]:
    W(f"SELECT setval(pg_get_serial_sequence('{t}','{col}'), (SELECT COALESCE(MAX({col}),1) FROM {t}));\n")
w.close()
print(f"masters: item={len(ITEM)} supplier={len(SUP)} asset={len(ASSET)+1} employee={len(EMP)} grade={len(GRADE)}")
print(f"stores ledger={len(led)}  jobcards={len(jobs)}  progress={len(progress)}  labour_lines={len(labour)}  cost_rows={len(jobcost)}")
print(f"Σ labour cost = LKR {sum(jobcost.values()):,.0f}")
print("wrote", OUT)
