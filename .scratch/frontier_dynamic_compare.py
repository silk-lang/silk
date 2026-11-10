import subprocess,json,os,re
from pathlib import Path
base=Path('/workspace/silk/.scratch');results=[]
for workload in ['compiler','harfrust']:
 for round in range(2):
  modes=['static','dynamic','serial'] if round==0 else ['serial','dynamic','static']
  for mode in modes:
   tag=f'frontier-dynamic-{workload}-{round}-{mode}'
   args=['python3',str(base/'frontier_single.py'),tag,workload]
   env=dict(os.environ);env.pop('SILK_FRONTIER_STATIC',None)
   if mode=='static':env['SILK_FRONTIER_STATIC']='1'
   if mode=='serial':args+=['off']
   subprocess.run(args,check=True,env=env)
   result=json.loads((base/(tag+'.json')).read_text());result.update(round=round,mode=mode)
   raw=(base/(tag+'.log')).read_text()
   if result['exit_code']!=0:raise RuntimeError(f'check failed: {tag}')
   if mode!='serial':
    if 'frontier accepted' not in raw:raise RuntimeError(f'parallel proof fallback: {tag}')
    task_counts=[int(x) for x in re.findall(r'frontier runtime task count ms=\d+ a=\d+ b=(\d+)',raw)]
    module_counts=[int(x) for x in re.findall(r'frontier module task count ms=\d+ a=\d+ b=(\d+)',raw)]
    result.update(runtime_tasks=task_counts,module_tasks=module_counts)
    if len(task_counts)!=4 or len(module_counts)!=4:raise RuntimeError(f'missing worker counters: {tag}')
    if mode=='dynamic':
     width=int(re.search(r'frontier split ms=\d+ a=\d+ b=(\d+)',raw)[1])
     if sum(task_counts)!=width:raise RuntimeError(f'frontier task coverage: {tag}, {task_counts}, width={width}')
   results.append(result)
   (base/'frontier-dynamic-comparison.json').write_text(json.dumps(results,indent=2)+'\n')
 for round in range(2):
  pair=[r for r in results if r['workload']==workload and r['round']==round and r['mode']!='serial']
  if sum(pair[0]['module_tasks'])!=sum(pair[1]['module_tasks']):raise RuntimeError(f'module task coverage: {workload} round{round}')
