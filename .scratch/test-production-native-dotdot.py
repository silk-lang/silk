import fcntl,importlib.util,json,os,shutil,subprocess
from pathlib import Path
repo=Path('/workspace/silk');binary=repo/'.scratch/cache-correctness-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
spec=importlib.util.spec_from_file_location('bench',repo/'.scratch/benchmarks/cold_bench.py');bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
base=repo/'.scratch/production-native-dotdot-probe';records=[]
env=dict(os.environ)
for k in list(env):
 if k.startswith('SILK_EXPERIMENT_'):env.pop(k,None)
env['SILK_CLANG']=str(repo/'.scratch/llvm-22.1.8/bin/clang')
def run(p,stage,command='build'):
 cmd=[str(binary),command,'--manifest-path',str(p/'silk.toml'),'--stdlib',str(repo/'stdlib'),'--profile','probe','--progress','never']
 if command=='check':cmd.append('--json')
 log=base/(p.name+'-'+stage+'.log');r=bench.measure(cmd,p,env,log);r.update(fixture=p.name,stage=stage,command=cmd);records.append(r);(base/'results.json').write_text(json.dumps(records,indent=2));print(json.dumps({'fixture':p.name,'stage':stage,'status':r['exit_code']}),flush=True);return r['exit_code'],log.read_text()
profile='\n[profiles.probe]\noptimization="none"\ndebug=false\n'
with open(repo/'.scratch/performance.lock','a') as lock:
 print('Waiting for shared performance lock',flush=True);fcntl.flock(lock,fcntl.LOCK_SH)
 shutil.rmtree(base,ignore_errors=True);base.mkdir()
 p=base/'native';(p/'src').mkdir(parents=True);relative='build/llvm/x86_64-unknown-linux-gnu/probe/native-cache-inputs.native';cache=p/relative;cache.mkdir(parents=True)
 (p/'silk.toml').write_text('[package]\nname="native-cache-inputs"\nversion="0.0.0"\nsource="src"\n[native]\nsources=[{c="src/input.c",include=["'+relative+'"]}]\n'+profile)
 (p/'src/main.silk').write_text('unsafe extern "C" fn cached_header_value() -> i32\npub fn main() -> i32 { return unsafe cached_header_value() }\n')
 header='00000000000000000000000000000000.headers';source='#include "../'+relative+'/'+header+'"\nint cached_header_value(void) { return VALUE; }\n';(p/'src/input.c').write_text(source)
 for i,value in enumerate([17,17,23,23]):
  content=f'#define VALUE {value}\n';(cache/header).write_text(content);status,text=run(p,f'header-{i}');assert status==0,text
  assert (cache/header).read_text()==content,'pruning deleted authored hash-shaped header'
  assert (p/'src/input.c').read_text()==source
  got=subprocess.run([str(cache.with_suffix(''))],capture_output=True).returncode;assert got==value,(got,value)
 print('PASS manifest export invalidation and hash-shaped native header preservation/invalidation',flush=True)
