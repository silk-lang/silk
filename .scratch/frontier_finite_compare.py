import subprocess,json
from pathlib import Path
base=Path('/workspace/silk/.scratch')
results=[]
for workload in ['compiler','harfrust']:
 for round in range(2):
  for mode in (['off','on'] if round==0 else ['on','off']):
   tag=f'frontier-finite-clean-{workload}-{round}-{mode}'
   args=['python3',str(base/'frontier_single.py'),tag,workload]
   if mode=='off':args+=['off']
   subprocess.run(args,check=True)
   result=json.loads((base/(tag+'.json')).read_text());result['round']=round;result['mode']=mode
   raw=(base/(tag+'.log')).read_text()
   if mode=='on' and 'frontier accepted' not in raw:raise RuntimeError(f'parallel proof fallback: {tag}')
   if result['exit_code']!=0:raise RuntimeError(f'check failed: {tag}')
   results.append(result)
(base/'frontier-finite-clean-comparison.json').write_text(json.dumps(results,indent=2)+'\n')
