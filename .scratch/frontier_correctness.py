import os,subprocess,shutil,json
from pathlib import Path
root=Path('/workspace/silk/.scratch/frontier-fixture')
compiler='/workspace/silk/.scratch/fork-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
for mode in ['valid','invalid']:
 if mode=='valid':
  for name in ['m05','m15','m22']:(root/(name+'.silk')).write_text('pub fn answer() -> i32 { return 1 }\n')
 if mode=='invalid':
  (root/'m05.silk').write_text('pub fn answer() -> i32 { return true }\n')
  (root/'m15.silk').write_text('type A = B\ntype B = A\npub fn answer() -> i32 { let unused: A = 0 return 1 }\n')
  (root/'m22.silk').write_text('static if 7 { pub fn answer() -> i32 { return 1 } }\n')
 outputs=[]
 for enabled in [False,True,True]:
  shutil.rmtree(root/'build',ignore_errors=True)
  env=dict(os.environ);env.pop('SILK_EXPERIMENT_FORK_CHECK',None);env.pop('SILK_EXPERIMENT_FRONTIER',None)
  if enabled:env['SILK_EXPERIMENT_FRONTIER']='1';env['SILK_FRONTIER_WARM']='0';env['SILK_FRONTIER_SHARED']='1'
  r=subprocess.run([compiler,'check','--manifest-path',str(root/'silk.toml'),'--stdlib','/workspace/silk/stdlib','--progress','never','--json'],env=env,capture_output=True)
  stderr=b'\n'.join(line for line in r.stderr.splitlines() if not line.startswith(b'frontier '))
  outputs.append((r.returncode,r.stdout,stderr))
  print(mode,enabled,r.returncode,r.stderr.decode(),flush=True)
 assert outputs[0][0]==(0 if mode=='valid' else 1),outputs
 assert outputs[0]==outputs[1]==outputs[2],outputs
print('diagnostics equivalent',flush=True)
