import pathlib,json,sys
S=pathlib.Path('/workspace/silk/.scratch');cohorts=[pathlib.Path(x) for x in sys.argv[1:]]
lines=['# Checked-runtime-plan controlled disposition','','Matching-construction V22 versus unconditional compact checked-plan candidate; original compiler workload and original stdlib. One immediate sequence per mode, per CPU lane. Diagnostics off. These component controls are not original N0 acceptance or a 3× claim.','','| CPUs | Operation | Stage | Foreground reference → candidate | Settled reference → candidate | CPU reference → candidate | Detached writer CPU reference → candidate |','|---|---|---|---|---|---|---|'];rows=[]
def cpu(r):return r['process_tree']['user_s']+r['process_tree']['sys_s']
def writer(r):return sum(x.get('user_s',0)+x.get('sys_s',0) for x in r.get('detached',[]))
for root in cohorts:
 m=json.loads((root/'metadata.json').read_text());cs=json.loads((root/'results.json').read_text());assert len(cs)==4 and all(c['validated'] and c['all_supervisors_reaped'] for c in cs)
 for op in ['check','build']:
  pair={c['mode']:c for c in cs if c['operation']==op}
  for l,r in zip(pair['reference']['invocations'],pair['candidate']['invocations']):
   vals={k:{'reference':a,'candidate':b,'delta':b-a,'ratio':b/a if a else None,'increased':b>a} for k,a,b in [('foreground',l['wall_s'],r['wall_s']),('settled',l['settled_wall_s'],r['settled_wall_s']),('cpu',cpu(l),cpu(r)),('writer_cpu',writer(l),writer(r))]}
   row=dict(cpus=m['cpus'],operation=op,stage=l['stage'],metrics=vals);rows.append(row)
   fields=['+'.join(map(str,m['cpus'])),op,l['stage']]
   for v in vals.values():
    ratio=f" ({(v['ratio']-1)*100:+.1f}%)" if v['ratio'] is not None else ''
    fields.append(f"{v['reference']:.3f} → {v['candidate']:.3f}s{ratio}")
   lines.append('| '+' | '.join(fields)+' |')
lines+=['','Every positive delta is shown, including small directional changes; one pair does not establish statistical significance. Detached-writer CPU excludes parent-joined writers, whose CPU remains in total. Immediate writer tails overlap, so per-invocation tails are not additive.','', 'Evidence:']+[f'- `{p}`' for p in cohorts]
(S/'checked-runtime-plan-controls.json').write_text(json.dumps(dict(cohorts=list(map(str,cohorts)),comparisons=rows),indent=2)+'\n');(S/'checked-runtime-plan-controls.md').write_text('\n'.join(lines)+'\n');print('\n'.join(lines))
