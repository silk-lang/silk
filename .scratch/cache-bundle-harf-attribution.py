"""Settled diagnostic phase attribution; caller owns shared/exclusive performance.lock slot."""
from pathlib import Path
import hashlib,importlib.util,json,os,re,shutil,subprocess,tempfile
scratch=Path('/workspace/silk/.scratch')
spec=importlib.util.spec_from_file_location('bench',scratch/'benchmarks/cold_bench.py');bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
os.sched_setaffinity(0,{0,1,2,3})
assert shutil.disk_usage(scratch).free>600*1024*1024,'disk guard before snapshots'
root=Path(tempfile.mkdtemp(prefix='bundle-harf-attribution-',dir=scratch/'benchmarks'))
revs={'silk':bench.snapshot(Path('/workspace/silk-baseline'),root/'silk'),'nonstd':bench.snapshot(Path('/workspace/nonstd'),root/'nonstd')}
assert revs=={'silk':'a63f612150a0b91a118c8111b910b12c3e124b50','nonstd':'ccb168b773bb56d7bd60a3495141d427149766d0'}
cwd=root/'nonstd/fonts/shape/tools/cli'; source=cwd/'src/main.silk';original=source.read_bytes();needle=b'Usage: hr_shape FONT TEXT';assert original.count(needle)==1
binary={'reference':scratch/'frontier-cache-bundle-v21','diagnostic':scratch/'frontier-cache-bundle-attribution'}
flags={'SILK_CLANG':str(scratch/'llvm-22.1.8/bin/clang'),'SILK_RETAINED_CACHE':'1','SILK_FRONTIER_EPHEMERAL':'1','SILK_EXPERIMENT_FRONTIER':'1','SILK_FRONTIER_SHARED':'1','SILK_FRONTIER_FORK_PRIVATE':'1','SILK_FRONTIER_CHUNKS':'1'}
metadata={'source_revisions':revs,'candidate_source':'aa08d24f4','binaries':{k:{'path':str(v),'sha256':hashlib.sha256(v.read_bytes()).hexdigest()} for k,v in binary.items()},'cpus':sorted(os.sched_getaffinity(0)),'flags':flags,'note':'Diagnostic only. Each writer settles before the next source action. No unchanged priming before edit. Phase wall timings are separate from primary/detached wait4 CPU. No original-baseline comparison.'}
(root/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n');print(json.dumps({'root':str(root)}),flush=True)
rows=[];parity={};phasepattern=re.compile(r'^frontier bundle (.*?) ms=(\d+) a=(\d+) b=(\d+)$')
for mode,exe in binary.items():
 source.write_bytes(original);shutil.rmtree(root/'nonstd/build',ignore_errors=True)
 for stage in ['cold','first-edit','unchanged']:
  assert shutil.disk_usage(scratch).free>400*1024*1024,'disk guard before invocation'
  if stage=='first-edit':source.write_bytes(original.replace(needle,needle+b' (revision one)'))
  env={k:v for k,v in os.environ.items() if not k.startswith('SILK_')};env.update(flags)
  trace=root/f'{mode}-{stage}.trace'
  if mode=='diagnostic':env['SILK_CACHE_BUNDLE_TRACE_FILE']=str(trace)
  cmd=[str(exe),'check','--stdlib',str(root/'silk/stdlib'),'--progress','never','--json']
  row=bench.measure(cmd,cwd,env,root/f'{mode}-{stage}.log')
  log=Path(row['log']).read_text();diagnostics=[json.loads(line) for line in log.splitlines() if line.startswith('{')]
  row.update(mode=mode,stage=stage,command=cmd,diagnostics=diagnostics,source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),trace=str(trace),frontier_accepted='frontier accepted' in log)
  assert row['exit_code']==0 and all(d['exit_code']==0 for d in row['detached']),row
  if stage=='cold':assert row['frontier_accepted'],row
  else:assert 'frontier split' not in log,row
  if mode=='reference':parity[stage]=diagnostics
  else:
   assert diagnostics==parity[stage],(mode,stage,'ordered JSON mismatch')
   assert trace.is_file(),(mode,stage,'no explicit phase file')
   phases=[]
   for line in trace.read_text().splitlines():
    match=phasepattern.match(line)
    if match:phases.append({'phase':match[1],'wall_ms':int(match[2]),'a':int(match[3]),'b':int(match[4])})
   row['phases']=phases
   if stage!='unchanged':assert any(x['phase']=='writer encode total' for x in phases),'writer phases missing'
  cache=root/'nonstd/build/cache'
  sizes=[{'path':str(p.relative_to(cache)),'bytes':p.stat().st_size} for p in cache.rglob('*') if p.is_file()] if cache.exists() else []
  row['cache_files']=sizes;row['cache_bytes']=sum(p['bytes'] for p in sizes)
  rows.append(row);(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
  print(json.dumps({k:row[k] for k in ['mode','stage','wall_s','settled_wall_s','primary','detached','cache_bytes']}),flush=True)
  if mode=='diagnostic':print(json.dumps({'stage':stage,'phases':row['phases']}),flush=True)
# Preserve edited candidate source/cache for non-timed manifest-size attribution and follow-up.
print(json.dumps({'complete':True,'root':str(root),'calls':len(rows),'all_writers_reaped':True,'source_state':'revision one; unchanged command after direct edit'}),flush=True)
