"""Same-binary completed-body reuse screen; caller holds exclusive performance.lock."""
import argparse, hashlib, importlib.util, json, os, shutil, tempfile
from pathlib import Path
from lane import candidate_environment
s=Path('/workspace/silk/.scratch')
spec=importlib.util.spec_from_file_location('cold',s/'benchmarks/cold_bench.py'); b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
p=argparse.ArgumentParser();p.add_argument('--candidate',type=Path,required=True);p.add_argument('--source',required=True);a=p.parse_args()
os.sched_setaffinity(0,{0,1,2,3})
r=Path(tempfile.mkdtemp(prefix='completed-registry-screen-',dir=s/'benchmarks'))
revs={'silk':b.snapshot(Path('/workspace/silk-baseline'),r/'silk'),'nonstd':b.snapshot(Path('/workspace/nonstd'),r/'nonstd')}
assert revs=={'silk':'a63f612150a0b91a118c8111b910b12c3e124b50','nonstd':'ccb168b773bb56d7bd60a3495141d427149766d0'}
meta=dict(binary=str(a.candidate.resolve()),sha256=hashlib.sha256(a.candidate.read_bytes()).hexdigest(),source=a.source,workloads=revs,cpus=[0,1,2,3],sequence=['cold','first-edit'],note='Same binary only; no original-baseline speedup claim. Each mode starts fresh; no unchanged priming.')
(r/'metadata.json').write_text(json.dumps(meta,indent=2));print(json.dumps({'root':str(r),**meta}),flush=True)
rows=[]
for work in ('compiler','harfrust'):
 src=r/('silk' if work=='compiler' else 'nonstd');cwd=src if work=='compiler' else src/'fonts/shape/tools/cli'
 edited=src/'compiler/src/main.silk' if work=='compiler' else cwd/'src/main.silk';original=edited.read_bytes()
 needle=b'Create a package or a workspace\\n' if work=='compiler' else b'Usage: hr_shape FONT TEXT'
 replacement=b'Create a package or a workspace (revision one)\\n' if work=='compiler' else b'Usage: hr_shape FONT TEXT (revision one)'
 assert original.count(needle)==1
 for mode in ('base','reuse'):
  edited.write_bytes(original);shutil.rmtree(src/'build',ignore_errors=True)
  env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_'))}
  env=candidate_environment(env,{'SILK_RETAINED_CACHE':'1','SILK_FRONTIER_EPHEMERAL':'1'},'parallel','candidate','check')
  if mode=='reuse':env['SILK_FRONTIER_REUSE_COMPLETED']='1'
  for stage in ('cold','first-edit'):
   if stage=='first-edit':edited.write_bytes(original.replace(needle,replacement))
   cmd=[str(a.candidate),'check']+(['--package','silk-compiler'] if work=='compiler' else [])+['--stdlib',str(r/'silk/stdlib'),'--progress','plain','--timings']
   log=r/f'{work}-{mode}-{stage}.log'
   row=dict(workload=work,mode=mode,stage=stage,command=cmd,environment={k:v for k,v in env.items() if k.startswith('SILK_')},source_sha256=hashlib.sha256(edited.read_bytes()).hexdigest(),**b.measure(cmd,cwd,env,log))
   trace=log.read_text();row.update(accepted='frontier accepted' in trace,attempted='frontier split' in trace,diagnostics=[x for x in trace.splitlines() if ': warning[' in x or ': error[' in x],cache_bytes=sum(f.stat().st_size for f in (src/'build/cache').rglob('*') if f.is_file()))
   rows.append(row);(r/'results.json').write_text(json.dumps(rows,indent=2));print(json.dumps(row),flush=True)
   assert row['exit_code']==0 and all(x['exit_code']==0 for x in row['detached']),log
   assert stage!='cold' or row['accepted'],log
   if mode=='reuse':assert row['diagnostics']==next(x['diagnostics'] for x in rows if x['workload']==work and x['mode']=='base' and x['stage']==stage),log
  shutil.rmtree(src/'build',ignore_errors=True)
 edited.write_bytes(original)
print('COMPLETE '+str(r),flush=True)
