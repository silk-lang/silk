"""Diagnostic only: cached-parallel cold, then edited serial reuse of exactly that cache."""
import hashlib,importlib.util,json,os,shutil,tempfile
from pathlib import Path
s=Path('/workspace/silk/.scratch');compiler=s/'frontier-integrated-v2'
spec=importlib.util.spec_from_file_location('b',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
os.sched_setaffinity(0,{0,1,2,3});root=Path(tempfile.mkdtemp(prefix='incremental-serial-reuse-',dir=s/'benchmarks'))
revision=b.snapshot(Path('/workspace/silk-baseline'),root/'silk');source=root/'silk';edited=source/'compiler/src/main.silk';original=edited.read_bytes()
results=[]
try:
 for stage in ['cached-parallel-cold','serial-first-edit','serial-second-edit']:
  env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_'))}
  if stage=='cached-parallel-cold':env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1')
  else:
   name=b'one' if stage=='serial-first-edit' else b'two'
   edited.write_bytes(original.replace(b'Create a package or a workspace\\n',b'Create a package or a workspace (revision '+name+b')\\n'))
  command=[str(compiler),'check','--package','silk-compiler','--stdlib',str(source/'stdlib'),'--progress','plain','--timings']
  log=root/(stage+'.log');r=b.measure(command,source,env,log)
  r.update(stage=stage,command=command,environment={k:v for k,v in env.items() if k.startswith('SILK_')},source_revision=revision,source_sha256=hashlib.sha256(edited.read_bytes()).hexdigest(),compiler_sha256=hashlib.sha256(compiler.read_bytes()).hexdigest())
  results.append(r);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(r),flush=True)
  assert r['exit_code']==0 and all(x['exit_code']==0 for x in r['detached'])
finally:
 edited.write_bytes(original);shutil.rmtree(source/'build',ignore_errors=True)
print('COMPLETE '+str(root),flush=True)
