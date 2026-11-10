import fcntl,json,os,shutil,subprocess,sys
from pathlib import Path
repo=Path('/workspace/silk')
binary=Path(sys.argv[1]) if len(sys.argv)>1 else repo/'.scratch/coarse-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
root=repo/'.scratch/native-cache-inputs-review'
shutil.rmtree(root,ignore_errors=True)
(root/'src').mkdir(parents=True)
relative='build/llvm/x86_64-unknown-linux-gnu/probe/native-cache-inputs.native'
native=root/relative;native.mkdir(parents=True)
(root/'silk.toml').write_text('[package]\nname="native-cache-inputs"\nversion="0.0.0"\nsource="src"\n[native]\nsources=[{c="'+relative+'/input.c",include=["'+relative+'"]}]\n[profiles.probe]\noptimization="none"\ndebug=false\n')
(root/'src/main.silk').write_text('unsafe extern "C" fn cached_header_value() -> i32\npub fn main() -> i32 { return unsafe cached_header_value() }\n')
source='#include "value.h"\nint cached_header_value(void) { return VALUE; }\n'
(native/'input.c').write_text(source)
env=dict(os.environ);env['SILK_CLANG']=str(repo/'.scratch/llvm-22.1.8/bin/clang')
for key in ['SILK_EXPERIMENT_FRONTIER','SILK_EXPERIMENT_FORK_CHECK','SILK_EXPERIMENT_COARSE_CHECK','SILK_EXPERIMENT_COARSE_BUILD','SILK_EXPERIMENT_COARSE_TRACE','SILK_EXPERIMENT_ADAPTIVE_CACHE']:env.pop(key,None)
results=[]
with open(repo/'.scratch/performance.lock','a') as lock:
 print('Waiting for shared performance lock',flush=True);fcntl.flock(lock,fcntl.LOCK_SH)
 for value in [17,17,23,23]:
  header=f'#define VALUE {value}\n';(native/'value.h').write_text(header)
  p=subprocess.run([str(binary),'build','--manifest-path',str(root/'silk.toml'),'--stdlib',str(repo/'.scratch/coarse-cache-experiment/stdlib'),'--profile','probe','--progress','never'],env=env,capture_output=True,text=True,timeout=120)
  row=dict(value=value,buildStatus=p.returncode,stderr=p.stderr);print(json.dumps(row),flush=True)
  assert p.returncode==0,row
  assert (native/'input.c').read_text()==source
  assert (native/'value.h').read_text()==header
  ran=subprocess.run([str(native.with_suffix(''))],capture_output=True,timeout=10)
  row['status']=ran.returncode;assert ran.returncode==value,row
  results.append(row);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n')
print('PASS source/header preserved and header edits invalidate artifact reuse',flush=True)
