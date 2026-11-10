import os,json,subprocess,time,shutil,hashlib,sys
sys.path.insert(0,"/workspace/silk/.scratch/benchmarks")
from cold_bench import measure
from pathlib import Path
base=Path('/workspace/silk/.scratch')
source=base/'parallel-check-experiment'
compiler=base/'fork-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
root=base/'frontier-finite-smokes';root.mkdir(exist_ok=True)
env=dict(os.environ)
for k in ['SILK_EXPERIMENT_FORK_CHECK','SILK_EXPERIMENT_FRONTIER','SILK_FRONTIER_SHARED']:env.pop(k,None)
env['SILK_CLANG']=str(base/'llvm-22.1.8/bin/clang')
cases={
 'finite':(source/'corpus/native/generic-finite-type-cycle/main.silk').read_text(),
 'type_growth':(source/'corpus/invalid/generic-polymorphic-recursion/main.silk').read_text(),
 'static_growth':'fn grow(static n: i32) -> i32 { return grow(n + 1) }\npub fn main() -> i32 { return grow(0) }\n',
}
capture=(source/'compiler/src/semantic/SemanticCaptureCases.silk').read_text()
start=capture.index('  let growingText = """',capture.index('effect fn cleanupReentryClaims'))+len('  let growingText = """')
cases['cleanup_growth']=capture[start:capture.index('"""',start)]
results=[]
for name,text in cases.items():
 folder=root/name;(folder/'src').mkdir(parents=True,exist_ok=True)
 (folder/'src/main.silk').write_text(text)
 (folder/'silk.toml').write_text('[package]\nname="finite-smoke"\nversion="0.0.0"\nsilk-version="0.0.0"\n')
 for mode in ['check','build']:
  shutil.rmtree(folder/'build',ignore_errors=True)
  cmd=[str(compiler),mode]
  if mode=='check':cmd+=['--manifest-path',str(folder/'silk.toml'),'--json','--progress','never']
  else:cmd += [str(folder/'src/main.silk'),'-o',str(folder/'program'),'--optimization','none','--debug','false']
  cmd+=['--stdlib',str(source/'stdlib')]
  stats=root/f'{name}-{mode}.stats.json'; log=root/f'{name}-{mode}.log'
  wrapped=['timeout','--signal=TERM','--kill-after=3','45',*cmd]
  measured=measure(wrapped,folder,env,log);measured.update(case=name,mode=mode)
  code=measured['exit_code']
  raw=log.read_text(errors='replace')
  if name=='finite':
   measured['okay']=code==0
   if mode=='build' and code==0:
    app=subprocess.run([str(folder/'program')],timeout=5,capture_output=True);measured['runtime_exit']=app.returncode;measured['okay'] &= app.returncode==42
  else:measured['okay']=code==1 and 'SEM0053' in raw and 'specialization graph' in raw
  results.append(measured);print(json.dumps(measured),flush=True)
(root/'results.json').write_text(json.dumps({'compiler_sha256':hashlib.sha256(compiler.read_bytes()).hexdigest(),'results':results},indent=2)+'\n')
assert all(x['okay'] for x in results),results
