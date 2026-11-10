import json,statistics,pathlib
root=pathlib.Path('/workspace/silk/.scratch/benchmarks')
summary=[]
for workload in ['compiler','harfrust']:
 for operation in ['check','build']:
  path=root/f'final-{workload}-{operation}.jsonl'
  if not path.exists():continue
  allrows=[json.loads(l) for l in path.read_text().splitlines()]
  metadata=allrows[0]['metadata'];rows=allrows[1:]
  record={'workload':workload,'operation':operation,'profile':metadata['profile'],'metadata':metadata,'results':{},'result_file':str(path)}
  for label in ['A','B']:
   selected=[r for r in rows if r['label']==label]
   if not selected:continue
   record['results'][label]={
    'trials':len(selected),'passed':all(r['exit_code']==0 for r in selected),
    'wall_s':statistics.mean(r['wall_s'] for r in selected),
    'wall_range_s':[min(r['wall_s'] for r in selected),max(r['wall_s'] for r in selected)],
    'settled_wall_s':statistics.mean(r['settled_wall_s'] for r in selected),
    'primary_user_s':statistics.mean(r['primary']['user_s'] for r in selected),
    'tree_user_s':statistics.mean(r['process_tree']['user_s'] for r in selected),
    'tree_cpu_s':statistics.mean(r['process_tree']['user_s']+r['process_tree']['sys_s'] for r in selected),
    'primary_peak_rss_mib':max(r['primary']['max_rss_kib']/1024 for r in selected),
    'tree_peak_rss_mib':max(r['process_tree']['max_rss_kib']/1024 for r in selected)}
  if len(record['results'])==2:
   a,b=record['results']['A'],record['results']['B']
   record['speedup']=a['wall_s']/b['wall_s'];record['settled_speedup']=a['settled_wall_s']/b['settled_wall_s']
  summary.append(record)
(root/'final-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print('| Workload | Operation | Trials A/B | Foreground A→B | Speedup | Settled A→B | Settled speedup | User A→B | Tree CPU A→B | RSS A→B |')
print('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|')
for row in summary:
 if len(row['results'])!=2:continue
 a,b=row['results']['A'],row['results']['B']
 print(f"| {row['workload']} | {row['operation']} | {a['trials']}/{b['trials']} | {a['wall_s']:.3f}→{b['wall_s']:.3f} s | {row['speedup']:.3f}× | {a['settled_wall_s']:.3f}→{b['settled_wall_s']:.3f} s | {row['settled_speedup']:.3f}× | {a['primary_user_s']:.3f}→{b['primary_user_s']:.3f} s | {a['tree_cpu_s']:.3f}→{b['tree_cpu_s']:.3f} s | {a['primary_peak_rss_mib']:.0f}→{b['primary_peak_rss_mib']:.0f} MiB |")
