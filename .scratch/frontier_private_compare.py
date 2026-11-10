import os,json,importlib.util,shutil,hashlib,sys,re
from pathlib import Path
base=Path('/workspace/silk');scratch=base/'.scratch'
compiler=scratch/'worker-forks-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
root=scratch/'benchmarks/transport-family-ctvjs_tx'
spec=importlib.util.spec_from_file_location('cold',str(scratch/'benchmarks/cold_bench.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
results=[]
for workload in sys.argv[1:] or ['compiler','harfrust']:
 for private in [False,True]:
  tag=f'frontier-private-{workload}-'+('on' if private else 'off')
  source=root/('silk' if workload=='compiler' else 'nonstd');cwd=source if workload=='compiler' else source/'fonts/shape/tools/cli'
  shutil.rmtree(source/'build',ignore_errors=True)
  env=dict(os.environ)
  for key in list(env):
   if key.startswith('SILK_FRONTIER_') or key.startswith('SILK_EXPERIMENT_'): env.pop(key,None)
  env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1')
  if private:env['SILK_FRONTIER_FORK_PRIVATE']='1'
  command=[str(compiler),'check',*(['--package','silk-compiler'] if workload=='compiler' else []),'--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings']
  r=b.measure(['timeout','--kill-after=10','120s',*command],cwd,env,scratch/f'{tag}.log')
  raw=(scratch/f'{tag}.log').read_text()
  forks=[int(x) for x in re.findall(r'^frontier private fork ms=\d+ a=(\d+)',raw,re.M)]
  r.update(workload=workload,private=private,sha256=hashlib.sha256(compiler.read_bytes()).hexdigest(),accepted='frontier accepted' in raw,descendants=sum(x>=4 for x in forks),fork_events=forks)
  results.append(r);(scratch/'frontier-private-comparison.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(r),flush=True)
  if r['exit_code']!=0 or not r['accepted']:raise RuntimeError('worker proof did not complete: '+tag)
