import fcntl,json,os,shutil,subprocess
from pathlib import Path
repo=Path('/workspace/silk'); results=[]
base=repo/'.scratch/artifact-cache-inputs-acceptance';base.mkdir(exist_ok=True)
binary=repo/'.scratch/coarse-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
variants=[('off',binary),('adaptive',binary)]
with open(repo/'.scratch/performance.lock','a') as lock:
 print('Waiting for shared performance lock',flush=True);fcntl.flock(lock,fcntl.LOCK_SH)
 for mode,binary in variants:
  root=base/mode;shutil.rmtree(root,ignore_errors=True);(root/'src').mkdir(parents=True)
  dep=root/'build/cache/vendor';dep.mkdir(parents=True)
  (root/'silk.toml').write_text('[package]\nname="artifact-cache-overlap"\nversion="0.0.0"\nsource="src"\n[dependencies]\nvendor={path="build/cache/vendor"}\n[profiles.probe]\noptimization="none"\ndebug=false\n')
  (root/'src/main.silk').write_text('import vendor.A\npub fn main() -> i32 { return A.answer() }\n')
  for name in ['A','B']:(dep/(name+'.silk')).write_text('pub fn answer() -> i32 { return 0 }\n')
  def exports(name):(dep/'silk.toml').write_text('[package]\nname="vendor"\nversion="0.0.0"\nkind="library"\nsource="."\nexports=["'+name+'"]\n')
  exports('A')
  env=dict(os.environ)
  for k in ['SILK_EXPERIMENT_COARSE_CHECK','SILK_EXPERIMENT_COARSE_BUILD','SILK_EXPERIMENT_COARSE_TRACE','SILK_EXPERIMENT_ADAPTIVE_CACHE','SILK_EXPERIMENT_FRONTIER','SILK_EXPERIMENT_FORK_CHECK']:env.pop(k,None)
  if mode=='adaptive':env.update(SILK_EXPERIMENT_ADAPTIVE_CACHE='1',SILK_EXPERIMENT_COARSE_TRACE='1')
  env['SILK_CLANG']=str(repo/'.scratch/llvm-22.1.8/bin/clang')
  def run(label,command='build'):
   args=[str(binary),command,'--manifest-path',str(root/'silk.toml'),'--stdlib',str(repo/'.scratch/coarse-cache-experiment/stdlib'),'--progress','never','--profile','probe']
   if command=='check':args.append('--json')
   p=subprocess.run(args,env=env,capture_output=True,text=True,timeout=120)
   row=dict(mode=mode,label=label,status=p.returncode,stdout=p.stdout,stderr=p.stderr)
   results.append(row);(base/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(row),flush=True)
   return row
  initial=run('initial');assert initial['status']==0,results
  warm=run('warm');assert warm['status']==0,results
  exports('B')
  changed=run('changed-warm-build')
  check=run('changed-check','check');assert check['status']==1,results
  assert changed['status']==1 and 'MOD0003' in changed['stderr'],results
  print(mode,'authored cache-parent manifest correctly invalidates build PASS',flush=True)
