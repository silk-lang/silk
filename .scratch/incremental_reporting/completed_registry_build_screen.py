"""Same-binary completed-body reuse screen; caller holds exclusive performance.lock."""
import argparse, hashlib, importlib.util, json, os, shutil, tempfile, subprocess
from pathlib import Path
from lane import candidate_environment
s=Path('/workspace/silk/.scratch')
spec=importlib.util.spec_from_file_location('cold',s/'benchmarks/cold_bench.py'); b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
p=argparse.ArgumentParser();p.add_argument('--candidate',type=Path,required=True);p.add_argument('--source',required=True);a=p.parse_args()
os.sched_setaffinity(0,{0,1,2,3})
assert shutil.disk_usage(s).free>=1024**3, 'Environmental disk preflight: need1GiB before snapshot'
r=Path(tempfile.mkdtemp(prefix='completed-registry-build-screen-',dir=s/'benchmarks'))
revs={'silk':b.snapshot(Path('/workspace/silk-baseline'),r/'silk'),'nonstd':b.snapshot(Path('/workspace/nonstd'),r/'nonstd')}
assert revs=={'silk':'a63f612150a0b91a118c8111b910b12c3e124b50','nonstd':'ccb168b773bb56d7bd60a3495141d427149766d0'}
meta=dict(binary=str(a.candidate.resolve()),sha256=hashlib.sha256(a.candidate.read_bytes()).hexdigest(),source=a.source,workloads=revs,cpus=[0,1,2,3],operation='build',sequence=['cold','first-edit'],note='Same binary only; no original-baseline speedup claim. Each mode starts fresh; no unchanged priming.')
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
  env=candidate_environment(env,{'SILK_RETAINED_CACHE':'1','SILK_FRONTIER_EPHEMERAL':'1'},'parallel','candidate','build')
  env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
  if mode=='reuse':env['SILK_FRONTIER_REUSE_COMPLETED']='1'
  for stage in ('cold','first-edit'):
   if stage=='first-edit':edited.write_bytes(original.replace(needle,replacement))
   assert shutil.disk_usage(s).free>=300*1024*1024, 'Environmental disk preflight: need300MiB before next invocation'
   cmd=[str(a.candidate),'build']+(['--package','silk-compiler'] if work=='compiler' else [])+['--stdlib',str(r/'silk/stdlib'),'--progress','plain','--timings']
   log=r/f'{work}-{mode}-{stage}.log'
   row=dict(workload=work,mode=mode,stage=stage,command=cmd,environment={k:v for k,v in env.items() if k.startswith('SILK_')},source_sha256=hashlib.sha256(edited.read_bytes()).hexdigest(),**b.measure(cmd,cwd,env,log))
   trace=log.read_text();row.update(accepted='frontier accepted' in trace,attempted='frontier split' in trace,diagnostics=[x for x in trace.splitlines() if ': warning[' in x or ': error[' in x],cache_bytes=sum(f.stat().st_size for f in (src/'build/cache').rglob('*') if f.is_file()))
   if row['exit_code']==0:
    binary=src/'build/llvm/x86_64-unknown-linux-gnu/debug'/('silk-compiler' if work=='compiler' else 'font-shape-cli')
    row['binary_sha256']=hashlib.sha256(binary.read_bytes()).hexdigest()
    smoke=subprocess.run([str(binary),'--help'],capture_output=True);helptext=smoke.stdout+smoke.stderr
    row['help_exit_code']=smoke.returncode;row['edit_observed']=b'revision one' in helptext if stage=='first-edit' else b'revision one' not in helptext
    (r/f'{work}-{mode}-{stage}.help').write_bytes(helptext)
   rows.append(row);(r/'results.json').write_text(json.dumps(rows,indent=2));print(json.dumps(row),flush=True)
   assert row['exit_code']==0 and all(x['exit_code']==0 for x in row['detached']),log
   assert stage!='cold' or row['accepted'],log
   assert row.get('help_exit_code')==0 and row.get('edit_observed'),log
   if mode=='reuse':
    assert row['binary_sha256']==next(x['binary_sha256'] for x in rows if x['workload']==work and x['mode']=='base' and x['stage']==stage),log
    assert row['diagnostics']==next(x['diagnostics'] for x in rows if x['workload']==work and x['mode']=='base' and x['stage']==stage),log
  shutil.rmtree(src/'build',ignore_errors=True)
 edited.write_bytes(original)
print('COMPLETE '+str(r),flush=True)
