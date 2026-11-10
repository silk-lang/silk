"""Frozen four-unit diagnostic construction; caller holds shared performance lock."""
import argparse,ctypes,hashlib,json,os,shutil,subprocess,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--revision',required=True);a=p.parse_args();a.check_only=False
s=Path('/workspace/silk/.scratch');tree=s/'thread-frontier-prototype';pkg=s/'thread-frontier-package';builder=s/'ci-n1-4a1fa332/N1';binary=s/'frontier-native-threads-v2';clang=s/'llvm-22.1.8/bin/clang'
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def git(*args):return subprocess.check_output(['git','-C',str(tree),*args],text=True).strip()
assert git('rev-parse','HEAD')==a.revision and not git('status','--porcelain'),'source freeze mismatch'
assert sha(builder)=='d0c04d1a9b672e34fd6302ccaa9fc49b23a2ba1954c8d826dc73be626bc611db'
libc=ctypes.CDLL(None,use_errno=True);assert libc.prctl(36,1,0,0,0)==0
blocked=('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_PROFILE_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_CACHE_WORK_')
env={k:v for k,v in os.environ.items() if not k.startswith(blocked) and k not in ['LLVM_PROFILE_FILE','LD_PRELOAD','SILK_SHARED_TYPED_BODIES','SILK_REUSE_COMPLETED']};env['SILK_CLANG']=str(clang)
preflight_free_bytes=shutil.disk_usage(s).free
assert preflight_free_bytes >= 2*1024**3, 'bootstrap requires at least 2GiB free'
mode='sourcecheck' if a.check_only else 'build';command=[str(builder),'check' if a.check_only else 'build','--manifest-path',str(pkg/'silk.toml'),'--stdlib',str(tree/'stdlib'),'--profile','speed-four','--progress','plain','--timings'];log=s/f'thread-frontier-{mode}.log';started=time.monotonic()
with log.open('wb') as f:result=subprocess.run(command,cwd=tree,env=env,stdout=f,stderr=subprocess.STDOUT)
detached=[]
while True:
 try:
  pid,status=os.waitpid(-1,0);detached.append({'pid':pid,'exit':os.waitstatus_to_exitcode(status)})
 except ChildProcessError:break
assert git('rev-parse','HEAD')==a.revision and not git('status','--porcelain'),'source changed'
metadata={'source':a.revision,'builder':str(builder),'builder_sha256':sha(builder),'clang':str(clang.resolve()),'clang_sha256':sha(clang),'optimization':'speed','debug':False,'codegen_units':4,'profile_use':None,'preflight_free_bytes':preflight_free_bytes,'command':command,'log':str(log),'elapsed_s':time.monotonic()-started,'detached':detached,'purpose':'Repaired native-thread build activation and dormant warm registry; four-unit O2, no PGO; full source and native14 gates required; no performance claim','harness_sha256':sha(Path(__file__)),'manifest_sha256':sha(pkg/'silk.toml'),'exit':result.returncode}
if not a.check_only and result.returncode==0:
 shutil.copy2(pkg/'build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler',binary);metadata.update(binary=str(binary),sha256=sha(binary))
(s/f'thread-frontier-{mode}.json').write_text(json.dumps(metadata,indent=2)+'\n')
print(json.dumps(metadata),flush=True)

assert result.returncode==0,(result.returncode,str(log))
assert all(x['exit']==0 for x in detached),detached
