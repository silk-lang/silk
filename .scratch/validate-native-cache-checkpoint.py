import ctypes,json,os,subprocess,time
from pathlib import Path
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
s=Path('/workspace/silk/.scratch');tree=Path('/workspace/silk-native-cache-checkpoint');compiler=s/'ci-n1-4a1fa332/N1'
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_PROFILE_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_CACHE_WORK_','SILK_NATIVE_BUILD_PIPELINE')) and k not in ('LLVM_PROFILE_FILE','LD_PRELOAD')};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
steps=[('sourcecheck',['check','--manifest-path','compiler/silk.toml','--stdlib','stdlib','--progress','never']),('packs',['test','compiler/src/driver/SemanticCache.silk','--stdlib','stdlib','--optimization','none','--no-cache','--filter','detachedPacksPreserveAcceptedBodiesAndRespectClean','-o',str(s/'native-checkpoint-pack-tests')]),('coordinator',['test','compiler/src/driver/NativeCoordinator.silk','--stdlib','stdlib','--optimization','none','--no-cache','--filter','nativeCoordinatorRequiresSuccessAndExplicitPublication','-o',str(s/'native-checkpoint-coordinator-tests')])]
rows=[]
for name,args in steps:
 log=s/f'native-cache-checkpoint-{name}.log';started=time.monotonic()
 with log.open('wb') as out:q=subprocess.run([str(compiler),*args],cwd=tree,env=env,stdout=out,stderr=subprocess.STDOUT)
 children=[]
 while True:
  try:pid,status=os.waitpid(-1,0);children.append([pid,os.waitstatus_to_exitcode(status)])
  except ChildProcessError:break
 row=dict(step=name,status=q.returncode,elapsed=time.monotonic()-started,children=children,log=str(log));rows.append(row);print(json.dumps(row),flush=True)
 (s/'native-cache-checkpoint-validation.json').write_text(json.dumps(rows,indent=2)+'\n')
 if q.returncode or any(status for _,status in children):raise SystemExit(1)
