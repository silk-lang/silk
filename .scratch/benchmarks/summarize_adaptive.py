import json,statistics,sys
from pathlib import Path
root=Path(sys.argv[1]);rows=json.loads((root/'results.json').read_text())
def median(values):return statistics.median(values)
for operation in ['check','build']:
 for workload in ['compiler','harfrust']:
  values={}
  for enabled in [False,True]:
   selected=[r for r in rows if r['operation']==operation and r['workload']==workload and r['adaptive']==enabled and r['state']=='cold']
   if not selected:continue
   values[enabled]={'wall':median([r['wall_s'] for r in selected]),'settled':median([r['settled_wall_s'] for r in selected]),'cpu':median([r['tree_cpu_s'] for r in selected]),'rssMiB':median([r['process_tree']['max_rss_kib']/1024 for r in selected]),'range':[min(r['wall_s'] for r in selected),max(r['wall_s'] for r in selected)]}
  if len(values)==2:
   print(operation,workload,json.dumps(values),'speedup',values[False]['wall']/values[True]['wall'])
  for state in ['warm','edit1','edit2','edit2-warm']:
   for r in rows:
    if r['operation']==operation and r['workload']==workload and r['state']==state:
     print(' ',state,'adaptive' if r['adaptive'] else 'off',round(r['wall_s'],3),round(r['tree_cpu_s'],3),'images',r['semantic_images'])
