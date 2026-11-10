"""Frozen four-unit diagnostic construction; caller holds shared performance lock."""
import argparse,ctypes,hashlib,json,os,shutil,subprocess,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--revision',required=True);p.add_argument('--check-only',action='store_true');a=p.parse_args()
s=Path('/workspace/silk/.scratch');tree=s/'shared-typed-bodies';pkg=s/'shared-typed-bodies-package';builder=s/'ci-n1-4a1fa332/N1';binary=s/'frontier-shared-typed-body';clang=s/'llvm-22.1.8/bin/clang'
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def git(*args):return subprocess.check_output(['git','-C',str(tree),*args],text=True).strip()
assert git('rev-parse','HEAD')==a.revision and not git('status','--porcelain'),'source freeze mismatch'
assert sha(builder)=='d0c04d1a9b672e34fd6302ccaa9fc49b23a2ba1954c8d826dc73be626bc611db'
libc=ctypes.CDLL(None,use_errno=True);assert libc.prctl(36,1,0,0,0)==0
blocked=('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_PROFILE_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_CACHE_WORK_')
env={k:v for k,v in os.environ.items() if not k.startswith(blocked) and k not in ['LLVM_PROFILE_FILE','LD_PRELOAD']};env['SILK_CLANG']=str(clang)
mode='sourcecheck' if a.check_only else 'build';command=[str(builder),'check' if a.check_only else 'build','--manifest-path',str(pkg/'silk.toml'),'--stdlib',str(tree/'stdlib'),'--profile','speed-four','--progress','plain','--timings'];log=s/f'frontier-shared-typed-body-{mode}.log';started=time.monotonic()
with log.open('wb') as f:result=subprocess.run(command,cwd=tree,env=env,stdout=f,stderr=subprocess.STDOUT)
detached=[]
while True:
 try:
  pid,status=os.waitpid(-1,0);detached.append({'pid':pid,'exit':os.waitstatus_to_exitcode(status)})
 except ChildProcessError:break
assert result.returncode==0,(result.returncode,str(log));assert all(x['exit']==0 for x in detached),detached
assert git('rev-parse','HEAD')==a.revision and not git('status','--porcelain'),'source changed'
metadata={'source':a.revision,'builder':str(builder),'builder_sha256':sha(builder),'clang':str(clang.resolve()),'clang_sha256':sha(clang),'optimization':'speed','debug':False,'codegen_units':4,'profile_use':None,'command':command,'log':str(log),'elapsed_s':time.monotonic()-started,'detached':detached,'purpose':'Same-binary optional-flag correctness and CPU attribution; not comparable construction quality to V13 mono-PGO'}
if not a.check_only:
 shutil.copy2(pkg/'build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler',binary);metadata.update(binary=str(binary),sha256=sha(binary))
(s/f'frontier-shared-typed-body-{mode}.json').write_text(json.dumps(metadata,indent=2)+'\n')
print(json.dumps(metadata),flush=True)
