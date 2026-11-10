import fcntl,json,os,shutil,subprocess,time
from pathlib import Path
repo=Path('/workspace/silk')
root=repo/'.scratch/cache-overlap-review'
binary=repo/'.scratch/coarse-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
root.mkdir(exist_ok=True)
(root/'src').mkdir(exist_ok=True)
dep=root/'build/cache/vendor'
dep.mkdir(parents=True,exist_ok=True)
(root/'silk.toml').write_text('[package]\nname="cache-overlap-review"\nversion="0.0.0"\nsource="src"\n[dependencies]\nvendor={path="build/cache/vendor"}\n')
(root/'src/main.silk').write_text('import vendor.A\npub fn main() -> i32 { return A.answer() }\n')
for name in ['A','B']:(dep/(name+'.silk')).write_text('pub fn answer() -> i32 { return 0 }\n')
def exports(name):
 (dep/'silk.toml').write_text('[package]\nname="vendor"\nversion="0.0.0"\nkind="library"\nsource="."\nexports=["'+name+'"]\n')
exports('A')
# Keep the authored dependency; discard only this probe's previous compiler cache.
shutil.rmtree(root/'build/cache/cache-overlap-review',ignore_errors=True)
results=[]
def invoke(label,enabled):
 env=dict(os.environ)
 for k in ['SILK_EXPERIMENT_COARSE_CHECK','SILK_EXPERIMENT_COARSE_BUILD','SILK_EXPERIMENT_COARSE_TRACE','SILK_EXPERIMENT_ADAPTIVE_CACHE','SILK_EXPERIMENT_FRONTIER','SILK_EXPERIMENT_FORK_CHECK']:env.pop(k,None)
 if enabled:env.update(SILK_EXPERIMENT_ADAPTIVE_CACHE='1',SILK_EXPERIMENT_COARSE_TRACE='1')
 cmd=[str(binary),'check','--manifest-path',str(root/'silk.toml'),'--stdlib',str(repo/'.scratch/coarse-cache-experiment/stdlib'),'--progress','never','--json']
 run=subprocess.run(cmd,env=env,capture_output=True,text=True,timeout=90)
 diagnostics=[];trace=[];other=[]
 for line in run.stderr.splitlines():
  if line.startswith(('adaptive ','whole-check ')):trace.append(line)
  else:
   try:diagnostics.append(json.loads(line))
   except ValueError:other.append(line)
 row=dict(label=label,enabled=enabled,status=run.returncode,diagnostics=diagnostics,trace=trace,other=other)
 results.append(row);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n')
 (root/(label+'.stderr')).write_text(run.stderr)
 print(json.dumps(row),flush=True)
 return row
print('Waiting for shared performance lock',flush=True)
with open(repo/'.scratch/performance.lock','a') as lock:
 fcntl.flock(lock,fcntl.LOCK_SH)
 first=invoke('initial',True)
 warm=invoke('warm',True)
 if 'whole-check hit' not in warm['trace']:warm=invoke('warm2',True)
 assert first['status']==0 and warm['status']==0 and 'whole-check hit' in warm['trace'],results
 exports('B')
 changed=invoke('changed-adaptive',True)
 baseline=invoke('changed-serial',False)
 assert baseline['status']==1,results
 if changed['status']!=baseline['status'] or changed['diagnostics']!=baseline['diagnostics']:
  raise AssertionError('STALE RESULT: exported A removed, adaptive differs from serial')
 else:print('NO STALE RESULT: changed manifest correctly invalidated',flush=True)
