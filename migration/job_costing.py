#!/usr/bin/env python3
"""Per-job costing across the 4 sources.
For each costed job (C-job): Labour (Daily Work Done, hours x rate, matched by vehicle+date window),
Material (stores issues to that vehicle in window, valued at stores MWAC), Outside (n/a here),
Total = L+M+O, compared to the workshop's recorded C-job Cost. Emits jobs_costing.json for the UI."""
import openpyxl, sqlite3, re, datetime, json, collections
UP="data/"
JB=UP+"Job_Record.xlsx"
DW=UP+"Daily_Work_Done.xlsx"
INV="data/inventory.db"

def nv(v): return re.sub(r'[^a-z0-9]','',str(v or '').lower())
def d2(v):
    if isinstance(v,(datetime.datetime,datetime.date)): return v.date() if isinstance(v,datetime.datetime) else v
    m=re.match(r'(\d{1,2})/(\d{1,2})/(\d{4})',str(v or ''))
    if m:
        mo,da,yr=int(m.group(1)),int(m.group(2)),int(m.group(3))
        try: return datetime.date(yr,mo,da)
        except: return None
    return None

# ---- labour rates ----
wb=openpyxl.load_workbook(DW,data_only=True)
ws=wb['Labor Hour']; RATE={}
for r in range(4,ws.max_row+1):
    nm=ws.cell(r,2).value; pr=ws.cell(r,3).value
    if nm not in (None,""):
        for a in str(nm).split('/'): RATE[a.strip().lower()]=pr
ALIAS={'vinoth':'vinod','seethananda':'seethananda','seetha':'seetha','nawathilake':'nawathilaka',
       'themindu':'theminda','electrical vinod':'vinod m','dilipa':'dileepa','dilip':'dileepa'}
def rate(tok):
    k=tok.strip().lower(); k=ALIAS.get(k,k); return RATE.get(k)
# ---- daily labour by (vehicle, date) ----
ws=wb['From 1st Dec2025']; labour=collections.defaultdict(list)
for r in range(2,ws.max_row+1):
    veh=ws.cell(r,2).value; dt=d2(ws.cell(r,1).value); mech=ws.cell(r,4).value; t=ws.cell(r,5).value
    if not veh or dt is None: continue
    hrs=t if isinstance(t,(int,float)) else None
    toks=[x.strip() for x in re.split(r'[,/&+]| and ',str(mech or '')) if x.strip()]
    lines=[]
    for tk in toks:
        rt=rate(tk); cost=(hrs*rt) if (hrs and rt) else None
        lines.append(dict(name=tk,hours=hrs,rate=rt,cost=cost))
    labour[nv(veh)].append(dict(date=dt, desc=str(ws.cell(r,3).value or ''), hours=hrs, lines=lines))

# ---- stores MWAC per item + issues by (vehicle,date) ----
con=sqlite3.connect(INV)
mwac={}
for name,qs,vs in con.execute("""SELECT LOWER(TRIM(i.itemName)), SUM(r.qty), SUM(r.qty*r.unitPrice)
   FROM receipts r JOIN items i ON i.id=r.itemId WHERE r.unitPrice IS NOT NULL GROUP BY 1"""):
    if qs: mwac[name]=vs/qs
issues=collections.defaultdict(list)
# material demand per vehicle from the MRN item lines (items), valued at stores MWAC
for r in con.execute("SELECT vehicleMachinery,reqDateISO,itemName,reqQty,category FROM items"):
    dt=d2(r[1])
    if not r[0] or dt is None or not r[3] or r[3]<=0: continue
    uc=mwac.get(str(r[2] or '').strip().lower())
    issues[nv(r[0])].append(dict(date=dt,item=r[2],qty=r[3],unit_cost=uc,amount=(r[3]*uc) if uc else None,cat=r[4]))

# ---- recorded costs from C-job (by job_no) ----
wb2=openpyxl.load_workbook(JB,data_only=True)
wsC=wb2['C-job']; REC={}
for r in range(2,wsC.max_row+1):
    jn=wsC.cell(r,1).value
    if jn in (None,""): continue
    REC[str(jn).strip()]=(wsC.cell(r,8).value, wsC.cell(r,7).value)
# ---- jobs from Requested register (master job list, spans 2023..2026) ----
ws=wb2['Requested job']
import datetime as _dt
jobs=[]
for r in range(2,ws.max_row+1):
    jn=ws.cell(r,1).value
    if jn in (None,""): continue
    veh=ws.cell(r,2).value; st=d2(ws.cell(r,4).value); en=d2(ws.cell(r,5).value)
    if st and not en: en=st+_dt.timedelta(days=60)   # window fallback
    rec_cost,rec_hrs=REC.get(str(jn).strip(),(None,None))
    key=nv(veh); win_s=st; win_e=en or st
    lab_lines=[]; lab_cost=0.0; lab_hrs=0.0
    if key and win_s:
        for L in labour.get(key,[]):
            if win_s<=L['date']<=win_e:
                for ln in L['lines']:
                    lab_lines.append(dict(date=str(L['date']),name=ln['name'],hours=ln['hours'],rate=ln['rate'],cost=ln['cost'],desc=L['desc'][:40]))
                    if ln['cost']: lab_cost+=ln['cost']
                    if ln['hours']: lab_hrs+=ln['hours']
    mat_lines=[]; mat_cost=0.0
    if key and win_s:
        for I in issues.get(key,[]):
            if win_s<=I['date']<=win_e:
                mat_lines.append(dict(date=str(I['date']),item=I['item'],qty=I['qty'],unit_cost=I['unit_cost'],amount=I['amount']))
                if I['amount']: mat_cost+=I['amount']
    total=lab_cost+mat_cost
    jobs.append(dict(job_no=str(jn).strip(), vehicle=str(veh or '').strip(),
        start=str(st) if st else None, end=str(en) if en else None,
        labour_cost=round(lab_cost,2), labour_hours=round(lab_hrs,1),
        material_cost=round(mat_cost,2), outside_cost=0.0, total_cost=round(total,2),
        recorded_cost=(float(rec_cost) if isinstance(rec_cost,(int,float)) else None),
        recorded_hours=(float(rec_hrs) if isinstance(rec_hrs,(int,float)) else None),
        n_labour=len(lab_lines), n_parts=len(mat_lines),
        labour_lines=lab_lines, part_lines=mat_lines))

# ---- report ----
matched_lab=[j for j in jobs if j['labour_cost']>0]
matched_mat=[j for j in jobs if j['material_cost']>0]
print("JOBS (C-job):",len(jobs))
print("  with matched labour:",len(matched_lab)," with matched material:",len(matched_mat))
print("  Σ computed labour: LKR {:,.0f}".format(sum(j['labour_cost'] for j in jobs)))
print("  Σ computed material: LKR {:,.0f}".format(sum(j['material_cost'] for j in jobs)))
print("  Σ computed total:  LKR {:,.0f}".format(sum(j['total_cost'] for j in jobs)))
print("  Σ recorded (C-job cost): LKR {:,.0f}".format(sum(j['recorded_cost'] or 0 for j in jobs)))
costed=[j for j in jobs if j["labour_cost"]>0 or j["material_cost"]>0 or j["recorded_cost"]]
json.dump(costed, open("jobs_costing.json","w"), indent=1, default=str)
print("  costed jobs (browsable):",len(costed))
print("wrote jobs_costing.json (%d costed jobs)"%len(costed))
# show a few examples one-by-one
print("\nSAMPLE JOBS (labour+material computed vs recorded):")
for j in sorted(jobs,key=lambda x:-x['total_cost'])[:6]:
    print("  {job_no:18} {vehicle:9} L={labour_cost:>10,.0f} M={material_cost:>10,.0f} TOT={total_cost:>11,.0f}  rec={rc}".format(
        rc=("{:,.0f}".format(j['recorded_cost']) if j['recorded_cost'] else '-'), **j))
