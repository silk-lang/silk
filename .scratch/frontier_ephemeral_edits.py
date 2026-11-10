import os,json,importlib.util,shutil,hashlib
from pathlib import Path
base=Path('/workspace/silk');scratch=base/'.scratch';root=scratch/'benchmarks/transport-family-ctvjs_tx';source=root/'silk';edited=source/'compiler/src/main.silk'
compiler=scratch/'ephemeral-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
spec=importlib.util.spec_from_file_location('cold',str(scratch/'benchmarks/cold_bench.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
original=edited.read_bytes();results=[]
try:
 for ephemeral in [False,True]:
  mode='ephemeral' if ephemeral else 'cached';edited.write_bytes(original);shutil.rmtree(source/'build',ignore_errors=True)
  env=dict(os.environ)
  for key in ['SILK_EXPERIMENT_FORK_CHECK','SILK_EXPERIMENT_FRONTIER','SILK_FRONTIER_SHARED','SILK_FRONTIER_WARM','SILK_FRONTIER_EPHEMERAL','SILK_FRONTIER_STATIC','SILK_FRONTIER_TASK_TRACE']:env.pop(key,None)
  env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1')
  if ephemeral:env['SILK_FRONTIER_EPHEMERAL']='1'
  for stage in ['cold','warm','first-edit','second-edit']:
   if stage=='first-edit':edited.write_bytes(original+b'\npub fn ephemeralEditProbe() -> i32 { return 1 }\n')
   if stage=='second-edit':edited.write_bytes(original+b'\npub fn ephemeralEditProbe() -> i32 { return 2 }\n')
   tag=f'frontier-ephemeral-edit-{mode}-{stage}'
   command=[str(compiler),'check','--package','silk-compiler','--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings']
   r=b.measure(command,source,env,scratch/f'{tag}.log');raw=(scratch/f'{tag}.log').read_text()
   r.update(workload='compiler',mode=mode,stage=stage,sha256=hashlib.sha256(compiler.read_bytes()).hexdigest(),accepted='frontier accepted' in raw,ephemeral_workers=raw.count('frontier worker-ephemeral '))
   results.append(r);(scratch/'frontier-ephemeral-edits.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(r),flush=True)
   if r['exit_code']!=0:raise RuntimeError('check failed: '+tag)
finally:
 edited.write_bytes(original)
 shutil.rmtree(source/'build',ignore_errors=True)
