#!/usr/bin/env python3
"""
UMMS labour importer — Daily_Work_Done.xlsx -> md_employee/md_labour_rate + tx_job_progress + tx_job_labour.
Splits multi-mechanic rows, reconciles names via alias xref to the rate master, computes labour cost.
Policy: DO NOT DROP ANY ROW — unresolved/rate-less lines are kept & flagged.
"""
import openpyxl, re, datetime, collections, json, sys
F=sys.argv[1] if len(sys.argv)>1 else "data/Daily_Work_Done.xlsx"
OUT=sys.argv[2] if len(sys.argv)>2 else "."
wb=openpyxl.load_workbook(F,data_only=True)

# ---- rate master (Labor Hour) ----
ws=wb['Labor Hour']; RATE={}
for r in range(4,ws.max_row+1):
    nm=ws.cell(r,2).value; pr=ws.cell(r,3).value
    if nm not in (None,""):
        for alias in str(nm).split('/'):        # "Seethananda/seetha" -> both alias to same rate
            RATE[alias.strip().lower()]=(str(nm).strip(), pr)
# alias xref for observed spelling variants (would be reviewed/extended by ops)
ALIAS={'vinoth':'vinod','seethananda':'seethananda','seetha':'seetha','nawathilake':'nawathilaka',
       'themindu':'theminda','electrical vinod':'vinod m','dilipa':'dileepa','dilip':'dileepa',
       'vinod m':'vinod m'}
def resolve(tok):
    k=tok.strip().lower()
    k=ALIAS.get(k,k)
    if k in RATE: return RATE[k][0], RATE[k][1], False   # canonical, rate, needs_review
    return tok.strip(), None, True                        # new employee, no rate

def parse_date(v):
    if isinstance(v,(datetime.datetime,datetime.date)):
        return (v.date() if isinstance(v,datetime.datetime) else v)
    m=re.match(r'(\d{1,2})/(\d{1,2})/(\d{4})',str(v or ''))
    if m:
        mo,da,yr=int(m.group(1)),int(m.group(2)),int(m.group(3))
        try: return datetime.date(yr,mo,da)
        except: return None
    return None

# ---- daily rows -> progress + split labour ----
ws=wb['From 1st Dec2025']
progress=[]; labour=[]; emp=collections.Counter(); pending_rate=collections.Counter()
warn=collections.Counter()
for r in range(2,ws.max_row+1):
    d=ws.cell(r,1).value; veh=ws.cell(r,2).value; desc=ws.cell(r,3).value
    mech=ws.cell(r,4).value; t=ws.cell(r,5).value
    if all(x in (None,"") for x in (d,veh,desc,mech,t)): continue
    dt=parse_date(d); flags=[]
    if dt is None and d not in (None,""): flags.append('BAD_DATE')
    if veh in (None,""): flags.append('MISSING_VEHICLE')
    hrs = t if isinstance(t,(int,float)) else None
    if hrs is None: flags.append('MISSING_HOURS')
    toks=[x.strip() for x in re.split(r'[,/&+]| and ',str(mech or '')) if x.strip()] if mech not in (None,"") else []
    if not toks: flags.append('NO_MECHANIC')
    pid=len(progress)+1
    progress.append(dict(progress_id=pid, work_date=dt.isoformat() if dt else None,
        asset=str(veh).strip() if veh else None, work_done=str(desc).strip() if desc else None,
        hours=hrs, n_mechanics=len(toks), flags=flags, src="row%d"%r))
    # one tx_job_labour line per mechanic (rule: each listed mechanic worked `hours` that day)
    for tk in toks:
        canon, rate, review = resolve(tk)
        emp[canon]+=1
        lf=list(flags)
        if rate is None: lf.append('RATE_PENDING'); pending_rate[canon]+=1
        if review and rate is not None: lf.append('NAME_ALIAS_APPLIED')
        cost=(hrs*rate) if (hrs is not None and rate is not None) else None
        labour.append(dict(progress_id=pid, employee=canon, raw_name=tk, work_date=progress[-1]['work_date'],
            asset=progress[-1]['asset'], hours=hrs, hourly_rate=rate, labour_cost=cost, flags=lf))

# ---- report ----
costed=[l for l in labour if l['labour_cost'] is not None]
print("RATE MASTER employees:", len({v[0] for v in RATE.values()}))
print("DAILY progress rows      :", len(progress))
print("LABOUR lines (split)     :", len(labour))
print("  with a resolved rate   :", len(labour)-sum(1 for l in labour if l['hourly_rate'] is None))
print("  RATE_PENDING (no rate) :", sum(1 for l in labour if l['hourly_rate'] is None), " across", len(pending_rate), "names")
print("  costable (hours*rate)  :", len(costed), " total labour cost = LKR", "{:,.2f}".format(sum(l['labour_cost'] for l in costed)))
print("  total man-hours (costed):","{:,.1f}".format(sum(l['hours'] for l in costed)))
print("distinct employees (post-alias):", len(emp))
print("top RATE_PENDING names:", pending_rate.most_common(10))
print("row flags:", dict(collections.Counter(f for p in progress for f in p['flags'])))
json.dump(labour[:3], open(OUT+"/labour_sample.json","w"), indent=2, default=str)
print("\nSAMPLE progress:", json.dumps(progress[0], default=str))
print("SAMPLE labour (multi-mech split):")
for l in labour[:4]: print("  ", json.dumps({k:l[k] for k in ('employee','raw_name','work_date','asset','hours','hourly_rate','labour_cost','flags')}, default=str))
