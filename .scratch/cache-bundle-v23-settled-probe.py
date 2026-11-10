"""Caller owns exclusive performance.lock. Settled Harf component comparison, not original-baseline speedup."""
from pathlib import Path
import argparse,hashlib,importlib.util,json,os,re,shutil,tempfile
p=argparse.ArgumentParser();p.add_argument('--cpus',choices=['0','0,1,2,3'],required=True);p.add_argument('--modes',default='v19,v21,v23');a=p.parse_args()
scratch=Path('/workspace/silk/.scratch');spec=importlib.util.spec_from_file_location('bench',scratch/'benchmarks/cold_bench.py');bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
os.sched_setaffinity(0,{int(x) for x in a.cpus.split(',')})
assert shutil.disk_usage(scratch).free>900*1024*1024,'pre-snapshot disk guard'
root=Path(tempfile.mkdtemp(prefix='bundle-v23-settled-',dir=scratch/'benchmarks'))
revs={k:bench.snapshot(Path(v),root/k) for k,v in [('silk','/workspace/silk-baseline'),('nonstd','/workspace/nonstd')]}
assert revs=={'silk':'a63f612150a0b91a118c8111b910b12c3e124b50','nonstd':'ccb168b773bb56d7bd60a3495141d427149766d0'}
pins=json.loads((scratch/'v21-component-pins.json').read_text());v23=json.loads((scratch/'frontier-cache-bundle-v23-build.json').read_text())
identities={'v19':pins['reference'],'v21':pins['candidate'],'v23':{'binary':v23['binary'],'sha256':v23['sha256'],'source':v23['source'],'construction':str(scratch/'frontier-cache-bundle-v23-build.json')}}
modes=a.modes.split(',');assert modes and len(set(modes))==len(modes) and all(x in identities for x in modes)
for mode in modes:assert hashlib.sha256(Path(identities[mode]['binary']).read_bytes()).hexdigest()==identities[mode]['sha256']
flags={'SILK_CLANG':str(scratch/'llvm-22.1.8/bin/clang'),'SILK_RETAINED_CACHE':'1','SILK_FRONTIER_EPHEMERAL':'1','SILK_EXPERIMENT_FRONTIER':'1','SILK_FRONTIER_SHARED':'1','SILK_FRONTIER_FORK_PRIVATE':'1','SILK_FRONTIER_CHUNKS':'1','SILK_CACHE_BUNDLE_TRACE':'1'}
metadata={'binaries':identities,'modes':modes,'source_revisions':revs,'cpus':sorted(os.sched_getaffinity(0)),'flags':flags,'harness_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'note':'Component comparison only: V19 dense, rejected V21 Bundle, repaired V23 Bundle. Same four-unit O2/noPGO construction. Writers settle before each next source action. Direct cold-to-edit, then unchanged on edited source. CPU0 retains frontier opt-in and requires automatic cold refusal, never manual serial flags. Foreground phase wall durations are not phase CPU. Single round is diagnostic, not final promotion evidence.'}
(root/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n');print(json.dumps({'root':str(root),'cpus':a.cpus}),flush=True)
cwd=root/'nonstd/fonts/shape/tools/cli';source=cwd/'src/main.silk';original=source.read_bytes();needle=b'Usage: hr_shape FONT TEXT';assert original.count(needle)==1
rows=[];parity={};pattern=re.compile(r'^frontier bundle (.*?) ms=(\d+) a=(\d+) b=(\d+)$')
for mode in modes:
 source.write_bytes(original)
 assert not (root/'nonstd/build').exists(),'previous mode cache must be archived before fresh cold'
 for stage in ['cold','first-edit','unchanged']:
  assert shutil.disk_usage(scratch).free>400*1024*1024,'between-invocation disk guard; evidence retained'
  if stage=='first-edit':source.write_bytes(original.replace(needle,needle+b' (revision one)'))
  env={k:v for k,v in os.environ.items() if not k.startswith('SILK_')};env.update(flags)
  command=[identities[mode]['binary'],'check','--stdlib',str(root/'silk/stdlib'),'--progress','never','--json']
  row=bench.measure(command,cwd,env,root/f'{mode}-{stage}.log');log=Path(row['log']).read_text()
  diagnostics=[json.loads(line) for line in log.splitlines() if line.startswith('{')]
  row.update(mode=mode,stage=stage,cpus=a.cpus,command=command,diagnostics=diagnostics,source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),frontier_accepted='frontier accepted' in log,host_refused='frontier host capacity refused' in log)
  row['phases']=[{'phase':m[1],'wall_ms':int(m[2]),'a':int(m[3]),'b':int(m[4])} for line in log.splitlines() if (m:=pattern.match(line))]
  cache=root/'nonstd/build/cache';row['cache_files']=[{'path':str(f.relative_to(cache)),'bytes':f.stat().st_size} for f in cache.rglob('*') if f.is_file()] if cache.exists() else [];row['cache_bytes']=sum(f['bytes'] for f in row['cache_files'])
  rows.append(row);(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
  print(json.dumps({k:row[k] for k in ['mode','stage','cpus','exit_code','wall_s','settled_wall_s','primary','detached','cache_bytes','phases']}),flush=True)
  assert row['exit_code']==0 and all(d['exit_code']==0 for d in row['detached']),row
  if a.cpus=='0':
   assert 'frontier split' not in log and not row['frontier_accepted'],row
   if stage=='cold':assert row['host_refused'],row
  elif stage=='cold':assert row['frontier_accepted'],row
  else:assert 'frontier split' not in log,row
  if stage in parity:assert diagnostics==parity[stage],(mode,stage,'ordered JSON mismatch')
  else:parity[stage]=diagnostics
 # Preserve every final edited cache, avoiding accidental cross-binary cache reuse.
 build=root/'nonstd/build'
 if build.exists():build.rename(root/f'{mode}-final-build')
print(json.dumps({'complete':True,'root':str(root),'calls':len(rows),'all_writers_reaped':True,'source_state':'revision one; all final caches retained separately'}),flush=True)
