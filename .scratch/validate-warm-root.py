import ctypes, json, os, subprocess, time
from pathlib import Path
base=Path('/workspace/silk/.scratch'); tree=Path('/workspace/silk-warm-view-root-reuse'); compiler=base/'frontier-shared-graphs-v11'
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_PROFILE_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_CACHE_WORK_','SILK_ESCAPE_')) and k not in ('LLVM_PROFILE_FILE','LD_PRELOAD')}
env['SILK_CLANG']=str(base/'llvm-22.1.8/bin/clang')
commands=[('sourcecheck',[str(compiler),'check','--manifest-path',str(tree/'compiler/silk.toml'),'--stdlib',str(tree/'stdlib'),'--progress','plain']),('tests',[str(compiler),'test',str(tree/'compiler/src/semantic/Semantic.silk'),'-o',str(base/'warm-root-tests'),'--stdlib',str(tree/'stdlib'),'--filter','sharedEscapeViews','--optimization','none','--debug','false','--no-cache'])]
results=[]
for name,command in commands:
 log=base/f'warm-root-{name}.log';started=time.monotonic()
 print('START',name,flush=True)
 with log.open('wb') as output:p=subprocess.run(command,cwd=tree,env=env,stdout=output,stderr=subprocess.STDOUT)
 detached=[]
 while True:
  try:
   pid,status=os.waitpid(-1,0);detached.append({'pid':pid,'exit':os.waitstatus_to_exitcode(status)})
  except ChildProcessError:break
 row={'name':name,'command':command,'exit':p.returncode,'seconds':time.monotonic()-started,'detached':detached,'log':str(log)};results.append(row)
 (base/'warm-root-validation.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(row),flush=True)
 if p.returncode or any(x['exit'] for x in detached):raise SystemExit(p.returncode or 1)
