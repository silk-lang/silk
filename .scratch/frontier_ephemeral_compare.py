import os,json,importlib.util,shutil,hashlib,sys
from pathlib import Path
base=Path('/workspace/silk');scratch=base/'.scratch'
compiler=scratch/'ephemeral-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
root=scratch/'benchmarks/transport-family-ctvjs_tx'
spec=importlib.util.spec_from_file_location('cold',str(scratch/'benchmarks/cold_bench.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
rounds=int(sys.argv[1]) if len(sys.argv)>1 else 1
first_round=int(sys.argv[2]) if len(sys.argv)>2 else 0
results=json.loads((scratch/'frontier-ephemeral-comparison.json').read_text()) if first_round else []
for workload in ['compiler','harfrust']:
 for round in range(first_round,first_round+rounds):
  for ephemeral in ([False,True] if round%2==0 else [True,False]):
   mode='ephemeral' if ephemeral else 'cached'
   tag=f'frontier-ephemeral-{workload}-{round}-{mode}'
   source=root/('silk' if workload=='compiler' else 'nonstd');cwd=source if workload=='compiler' else source/'fonts/shape/tools/cli'
   shutil.rmtree(source/'build',ignore_errors=True)
   env=dict(os.environ)
   for key in ['SILK_EXPERIMENT_FORK_CHECK','SILK_EXPERIMENT_FRONTIER','SILK_FRONTIER_SHARED','SILK_FRONTIER_WARM','SILK_FRONTIER_EPHEMERAL','SILK_FRONTIER_STATIC','SILK_FRONTIER_TASK_TRACE']:env.pop(key,None)
   env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1')
   if ephemeral:env['SILK_FRONTIER_EPHEMERAL']='1'
   command=[str(compiler),'check',*(['--package','silk-compiler'] if workload=='compiler' else []),'--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings']
   r=b.measure(command,cwd,env,scratch/f'{tag}.log')
   raw=(scratch/f'{tag}.log').read_text()
   r.update(workload=workload,mode=mode,round=round,sha256=hashlib.sha256(compiler.read_bytes()).hexdigest(),accepted='frontier accepted' in raw,ephemeral_workers=raw.count('frontier worker-ephemeral '))
   results.append(r);(scratch/'frontier-ephemeral-comparison.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(r),flush=True)
   if r['exit_code']!=0 or not r['accepted'] or (ephemeral and r['ephemeral_workers']!=4):raise RuntimeError('worker proof/ephemeral mode did not complete: '+tag)
