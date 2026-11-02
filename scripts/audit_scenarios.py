#!/usr/bin/env python3
import csv, json, statistics, hashlib
from pathlib import Path
from collections import defaultdict
root=Path('scenario-evidence')
names=['tiered_no_appeal','flat3','correlated','selective_appeal','non_reveal','oracle_inversion']
records=[]
for name in names:
 for seed in range(1,21):
  path=root/name/f'seed_{seed}'
  rows=list(csv.DictReader((path/'results.csv').open()))
  receipt=list(csv.DictReader((path/'receipt-log.csv').open()))
  assert len(rows)==1000,(name,seed,len(rows))
  percase=defaultdict(int)
  for r in receipt:
   if int(r['disputeId'])>0:percase[int(r['disputeId'])]+=int(r['gasUsed'])
  assert all(percase[int(r['disputeId'])]==int(r['totalGas']) for r in rows),(name,seed,'receipt gas mismatch')
  correct=sum(r['correct']=='Yes' for r in rows)
  objective=[r for r in rows if int(r['type']) in (0,1,4)]
  subjective=[r for r in rows if int(r['type']) in (2,3)]
  subcorrect=sum(r['correct']=='Yes' for r in subjective)
  nnone=sum(int(r['actualWinner'])==0 for r in rows)
  records.append(dict(scenario=name,seed=seed,objective_n=len(objective),agreement_percent=correct/10,
     subjective_agreement_percent=100*subcorrect/len(subjective),
     included_gas_per_case=sum(int(r['totalGas']) for r in rows)/1000,none_n=nnone))
(root/'run-level.csv').write_text('scenario,seed,objective_n,agreement_percent,subjective_agreement_percent,included_gas_per_case,none_n\n'+
 '\n'.join(','.join(str(r[k]) for k in ['scenario','seed','objective_n','agreement_percent','subjective_agreement_percent','included_gas_per_case','none_n']) for r in records)+'\n')
summary={}
for name in names:
 rs=[r for r in records if r['scenario']==name]
 summary[name]={k:dict(mean=statistics.mean(r[k] for r in rs),sd=statistics.stdev(r[k] for r in rs))
  for k in ['objective_n','agreement_percent','subjective_agreement_percent','included_gas_per_case','none_n']}
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
with (root/'SHA256SUMS.txt').open('w') as f:
 for p in sorted(root.rglob('*')):
  if p.is_file() and p.name!='SHA256SUMS.txt':f.write(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(root)}\n')
print(json.dumps(summary,indent=2))
