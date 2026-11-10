import fcntl,importlib.util,json,os,shutil,subprocess
from pathlib import Path
repo=Path('/workspace/silk');binary=repo/'.scratch/cache-correctness-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
spec=importlib.util.spec_from_file_location('bench',repo/'.scratch/benchmarks/cold_bench.py');bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
base=repo/'.scratch/production-native-symlink-acceptance';records=[]
env=dict(os.environ)
for k in list(env):
 if k.startswith('SILK_EXPERIMENT_'):env.pop(k,None)
env['SILK_CLANG']=str(repo/'.scratch/llvm-22.1.8/bin/clang')
with open(repo/'.scratch/performance.lock','a') as lock:
 print('Waiting for shared performance lock',flush=True);fcntl.flock(lock,fcntl.LOCK_SH)
 shutil.rmtree(base,ignore_errors=True);(base/'src').mkdir(parents=True)
 for name in ['a','b']:(base/f'targets/{name}/child').mkdir(parents=True)
 (base/'silk.toml').write_text('[package]\nname="native-linked-headers"\nversion="0.0.0"\nsource="src"\n[native]\nsources=[{c="src/input.c"}]\n[profiles.probe]\noptimization="none"\ndebug=false\n')
 (base/'src/main.silk').write_text('unsafe extern "C" fn linked_header_value() -> i32\npub fn main() -> i32 { return unsafe linked_header_value() }\n')
 (base/'src/input.c').write_text('#include "../alias/../value.h"\nint linked_header_value(void) { return VALUE; }\n')
 (base/'value.h').write_text('#define VALUE 99\n')
 (base/'targets/a/value.h').write_text('#define VALUE 17\n');(base/'targets/b/value.h').write_text('#define VALUE 31\n')
 (base/'alias').symlink_to('targets/a/child')
 output=base/'build/llvm/x86_64-unknown-linux-gnu/probe/native-linked-headers'
 for stage,value in enumerate([17,23,31,31]):
  if stage==1:(base/'targets/a/value.h').write_text('#define VALUE 23\n')
  if stage==2:(base/'alias').unlink();(base/'alias').symlink_to('targets/b/child')
  command=[str(binary),'build','--manifest-path',str(base/'silk.toml'),'--stdlib',str(repo/'stdlib'),'--profile','probe','--progress','never']
  log=base/f'stage-{stage}.log';r=bench.measure(command,base,env,log);assert r['exit_code']==0,log.read_text()
  got=subprocess.run([str(output)],capture_output=True).returncode;r.update(stage=stage,expected=value,actual=got);records.append(r);(base/'results.json').write_text(json.dumps(records,indent=2));print(json.dumps({'stage':stage,'expected':value,'actual':got}),flush=True);assert got==value,(got,value)
 print('PASS native parent lookup preserves symlink semantics, header edits, and retarget invalidation',flush=True)
