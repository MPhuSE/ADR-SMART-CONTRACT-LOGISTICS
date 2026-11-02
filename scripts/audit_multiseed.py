#!/usr/bin/env python3
import csv,json,statistics,hashlib
from pathlib import Path
from collections import defaultdict
root=Path('validation'); rows=[]; receipts=[]; seeds=[]
for seed in range(1,21):
    p=root/'runs'/f'seed_{seed}'
    cases=list(csv.DictReader((p/'results.csv').open()))
    rc=list(csv.DictReader((p/'receipt-log.csv').open()))
    assert len(cases)==1000,(seed,len(cases))
    ids={int(x['disputeId']):int(x['totalGas']) for x in cases}
    actual=defaultdict(int)
    for x in rc:
        if int(x['disputeId'])>0: actual[int(x['disputeId'])]+=int(x['gasUsed'])
        x['seed']=seed
    assert all(actual[k]==v for k,v in ids.items()),f'receipt reconciliation failed: {seed}'
    counts=[sum(int(r['type'])==i for r in cases) for i in range(5)]
    seeds.append(dict(seed=seed,objective=sum(counts[i] for i in (0,1,4)),types=counts))
    for r in cases:r['seed']=seed
    rows.extend(cases);receipts.extend(x for x in rc if int(x['disputeId'])>0)
shares=[s['objective']/10 for s in seeds]
summary=dict(seeds=20,cases=len(rows),receipts=len(receipts),meanObjectivePercent=statistics.mean(shares),sdObjectivePercentagePoints=statistics.stdev(shares),perSeed=seeds)
(root/'audit-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
with (root/'all_receipts.csv').open('w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=list(receipts[0]));w.writeheader();w.writerows(receipts)
terminal={(int(r['seed']),int(r['disputeId'])):int(r['tier']) for r in rows}
denom=defaultdict(int);totals=defaultdict(int)
for r in rows:denom[int(r['tier'])]+=1
for x in receipts:
    key=(int(x['seed']),int(x['disputeId']))
    totals[(terminal[key],x['operation'])]+=int(x['gasUsed'])
with (root/'gas-by-terminal-tier.csv').open('w',newline='') as f:
    w=csv.writer(f);w.writerow(['tier','operation','cohort_n','mean_contribution_gas_per_case'])
    for (tier,operation),gas in sorted(totals.items()):w.writerow([tier,operation,denom[tier],gas/denom[tier]])
with (root/'SHA256SUMS.txt').open('w') as f:
    for path in sorted(root.rglob('*')):
        if path.is_file() and path.name!='SHA256SUMS.txt':f.write(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(root)}\n')
print(json.dumps(summary,indent=2))
