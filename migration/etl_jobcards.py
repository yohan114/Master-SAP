#!/usr/bin/env python3
"""
UMMS legacy-jobcard importer v2  (policy: DO NOT DROP ANY JOB)
- Missing vehicle  -> assign a GENERAL placeholder asset (GEN-000N), flag for review, keep the job.
- Cross-sheet reconciliation issues -> still loaded, flagged NEEDS_RECONCILIATION (never discarded).
- Exact duplicates -> kept, flagged POSSIBLE_DUPLICATE (human decides, nothing auto-deleted).
Run: python3 etl_jobcards.py <workbook.xlsx> <outdir>
"""
import openpyxl, re, json, sys, csv, datetime, collections

WB  = sys.argv[1] if len(sys.argv) > 1 else "data/Job_Record.xlsx"
OUT = sys.argv[2] if len(sys.argv) > 2 else "."

JOBRE   = re.compile(r'^\s*(\d{4})/(\d{1,2})/([A-Za-z])/(\d{1,4})(-\d{1,2})?\s*$')
METERRE = re.compile(r'(\d{3,})\s*[Kk][Mm]')
CANCELRE= re.compile(r'cancel', re.I)
GENERAL_ASSET_PREFIX = "GEN-"            # placeholder fleet number for vehicle-less jobs

SITE_CANON = {
 'cep-03':'CEP-03','badalgama':'Badalgama','batticaloa':'Batticaloa','katana':'Katana',
 'ruwanwella':'Ruwanwella','muthur plant':'Muthur','muthur':'Muthur','wadakada':'Wadakada',
 'marawila':'Marawila','kilinochchi':'Kilinochchi','mihinthale':'Mihinthale','solution':'Solution',
 'h/o':'Head Office','kadawatha':'Kadawatha','erawur':'Erawur','port city':'Port City',
 'mundalama estate':'Mundalama Estate','galenbidunuwewa':'Galenbidunuwewa','asphalt team':'Asphalt Team',
 'a/team':'Asphalt Team','raththota':'Raththota','dekatana':'Dekatana','biyagama':'Biyagama',
 'thalawa':'Thalawa','thebuwana':'Thebuwana','buttala':'Buttala','gampaha bridge':'Gampaha Bridge',
 'moragahakanda':'Moragahakanda','doramadalawa':'Doramadalawa','serunuwara':'Serunuwara',
 'thanthirimale':'Thanthirimale','galnewa':'Galnewa','thissamaharama':'Thissamaharama','mgs-01':'Solution',
}
def norm_site(raw):
    if raw in (None,""): return (None, True)
    k = re.sub(r'\s+',' ', str(raw).strip()).lower()
    if k in SITE_CANON: return (SITE_CANON[k], False)
    return (str(raw).strip().title(), True)

def as_date(v):
    if isinstance(v,(datetime.datetime,datetime.date)):
        return (v.date() if isinstance(v,datetime.datetime) else v, None)
    if v in (None,""): return (None, None)
    if CANCELRE.search(str(v)): return (None, 'CANCELLED')
    return (None, 'BAD_DATE')

def parse_num(v):
    if v in (None,""): return None
    try: return float(str(v).replace(',',''))
    except: return 'NAN'

wb = openpyxl.load_workbook(WB, data_only=True)

def load(sheet, colmap, first=2):
    ws = wb[sheet]; recs=[]
    for r in range(first, ws.max_row+1):
        if ws.cell(r,1).value in (None,""): continue
        rec={'__sheet':sheet,'__row':r}
        for c,name in colmap.items(): rec[name]=ws.cell(r,c).value
        recs.append(rec)
    return recs

REQ = load('Requested job', {1:'job_no',2:'vehicle',3:'repair_desc',4:'start',5:'end',6:'site',7:'remarks'})
CJOB= load('C-job',         {1:'job_no',2:'ref',3:'vehicle',4:'repair_desc',5:'start',6:'end',7:'hrs',8:'cost',9:'site',10:'remarks'})
print("STAGED: Requested=%d  C-job=%d  (total source rows=%d)" % (len(REQ), len(CJOB), len(REQ)+len(CJOB)))

def validate(rec, costed):
    errs=[]; warns=[]; status='DRAFT'
    jn = str(rec.get('job_no') or '').strip()
    if not jn: errs.append('MISSING_JOB_NO')            # only truly unusable case (row has no key at all)
    elif not JOBRE.match(jn): warns.append('JOBNO_FORMAT')
    veh = str(rec.get('vehicle') or '').strip()
    if not veh: warns.append('VEHICLE_DEFAULTED_GENERAL')   # <-- was hard reject; now defaulted, kept
    sd, sflag = as_date(rec.get('start')); ed, eflag = as_date(rec.get('end'))
    if sflag=='CANCELLED' or eflag=='CANCELLED': status='CANCELLED'
    elif sflag=='BAD_DATE': warns.append('BAD_START_DATE')
    if eflag=='BAD_DATE': warns.append('BAD_END_DATE')
    if sd and ed and sd>ed: warns.append('START_AFTER_END')
    meter=None
    m = METERRE.search(str(rec.get('remarks') or ''))
    if m: meter=int(m.group(1))
    cost=hrs=None
    if costed:
        cost=parse_num(rec.get('cost')); hrs=parse_num(rec.get('hrs'))
        if cost=='NAN': warns.append('COST_NONNUMERIC'); cost=None
        elif cost is None: warns.append('COST_MISSING_PENDING_VALUATION')
        elif cost<0: warns.append('COST_NEGATIVE')
        if hrs=='NAN': warns.append('HRS_NONNUMERIC'); hrs=None
    site, site_rev = norm_site(rec.get('site'))
    if site_rev and site: warns.append('SITE_NEEDS_XREF')
    if site is None: warns.append('MISSING_SITE')
    return dict(job_no=jn, vehicle=veh or None, ref=str(rec.get('ref') or '').strip() or None,
                repair_desc=str(rec.get('repair_desc') or '').strip() or None,
                start=sd.isoformat() if sd else None, end=ed.isoformat() if ed else None,
                site=site, hrs=hrs, cost=cost, meter=meter, status=status,
                __src='%s!%d'%(rec['__sheet'],rec['__row']), __errs=errs, __warns=warns)

vreq  = [validate(r, costed=False) for r in REQ]
vcjob = [validate(r, costed=True)  for r in CJOB]

def key(v): return (v['job_no'], v['ref'], v['vehicle'])
exact_dup_keys = {k for k,c in collections.Counter(key(v) for v in vcjob).items() if c>1}

# ---------- MERGE: clean auto-link only; everything else is KEPT (flagged), never dropped ----------
req_by_jobno = {}
for v in vreq: req_by_jobno.setdefault(v['job_no'], []).append(v)
cjob_jobno_multi = {k for k,c in collections.Counter(v['job_no'] for v in vcjob).items() if c>1}

merged=[]; cjob_kept=[]; consumed=set()
n_reconcile=0
for cj in vcjob:
    jn=cj['job_no']; cand=req_by_jobno.get(jn)
    flags=list(cj['__warns'])
    if key(cj) in exact_dup_keys: flags.append('POSSIBLE_DUPLICATE')
    if cand and len(cand)==1 and jn not in cjob_jobno_multi and \
       cand[0]['vehicle'] and cj['vehicle'] and cand[0]['vehicle']==cj['vehicle']:
        h=cand[0]
        merged.append(dict(h, ref=cj['ref'], hrs=cj['hrs'], cost=cj['cost'], meter=cj['meter'] or h['meter'],
                           costed=True, __warns=sorted(set(h['__warns'])|set(flags)), __src=h['__src']+'+'+cj['__src']))
        consumed.add(id(h))
    else:
        if jn in cjob_jobno_multi: flags.append('NEEDS_RECONCILIATION_JOBNO_COLLISION'); n_reconcile+=1
        elif cand: flags.append('NEEDS_RECONCILIATION_VEHICLE_MISMATCH'); n_reconcile+=1
        cjob_kept.append(dict(cj, costed=True, __warns=sorted(set(flags))))
req_kept=[dict(h, costed=False) for lst in req_by_jobno.values() for h in lst if id(h) not in consumed]

allcanon = merged + cjob_kept + req_kept

# ---------- assign GENERAL placeholder numbers to vehicle-less jobs ----------
gen_seq=0; general_assets=[]
for v in allcanon:
    if not v['vehicle']:
        gen_seq+=1
        gnum="%s%04d" % (GENERAL_ASSET_PREFIX, gen_seq)
        v['vehicle']=gnum; v['is_general_asset']=True
        general_assets.append({'general_no':gnum,'legacy_job_no':v['job_no'],'source':v['__src'],
                               'site':v['site'],'desc':v['repair_desc']})

# ---------- BUCKETS (nothing dropped: hard reject only if row has literally no job_no) ----------
post   = [v for v in allcanon if not v['__errs']]
reject = [v for v in allcanon if v['__errs']]        # only MISSING_JOB_NO (structurally unusable)
warns  = collections.Counter(w for v in allcanon for w in v.get('__warns',[]))
print("\nRESULT (no jobs dropped):")
print("  jobcards loaded (POST-ready) : %d" % len(post))
print("  hard-reject (no job_no at all): %d" % len(reject))
print("  of which auto-linked+costed  : %d" % len(merged))
print("  general-asset assigned        : %d  (%s)" % (len(general_assets), ", ".join(g['general_no'] for g in general_assets)))
print("  flagged NEEDS_RECONCILIATION  : %d" % n_reconcile)
print("  WARN/flag breakdown:", dict(warns.most_common()))

def to_payload(v):
    gen = v.get('is_general_asset', False)
    p = {
      "legacy_job_no": v['job_no'], "legacy_ref": v.get('ref'),
      "asset_lookup": {"by":"general_placeholder" if gen else "reg_no", "value":v['vehicle']},
      "site_lookup": {"by":"name","value":v['site']},
      "job_type":"BREAKDOWN", "reported_defect": v.get('repair_desc'),
      "jobcard_date": v.get('start'), "work_started_at": v.get('start'), "work_completed_at": v.get('end'),
      "meter_reading": v.get('meter'), "meter_type":"KM" if v.get('meter') else None,
      "jobcard_status": "CLOSED" if (v.get('costed') and v.get('cost') is not None)
                        else ("CANCELLED" if v.get('status')=='CANCELLED' else "PENDING_COSTING"),
      "needs_vehicle_review": gen,
      "migration": {"source": v['__src'], "flags": v.get('__warns',[])},
    }
    if v.get('costed'):
        p["cost_summary"]={"labour_hours":v.get('hrs'),"total_job_cost":v.get('cost'),
                           "is_provisional":v.get('cost') is None,
                           "cost_status":"FINALIZED" if v.get('cost') is not None else "DRAFT"}
    return p

payloads=[to_payload(v) for v in post]
json.dump(payloads, open(OUT+"/jobcards_canonical.json","w"), indent=2, default=str)
csv.writer(open(OUT+"/general_assets.csv","w",newline="")).writerows(
    [["general_no","legacy_job_no","source","site","desc"]]+[[g['general_no'],g['legacy_job_no'],g['source'],g['site'],g['desc']] for g in general_assets])
print("\nGENERAL-ASSET STUBS (md_asset, asset_class=EQUIPMENT, is_provisional, needs_review):")
for g in general_assets:
    print("  %s  <- %-16s %-14s  %s" % (g['general_no'], g['legacy_job_no'], g['source'], (g['desc'] or '(blank row)')[:40]))
print("\nWROTE jobcards_canonical.json (%d)  general_assets.csv (%d)" % (len(payloads), len(general_assets)))
