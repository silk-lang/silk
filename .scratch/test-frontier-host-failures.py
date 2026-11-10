import os,sys,json,shutil,importlib.util
from pathlib import Path
base=Path('/workspace/silk/.scratch'); project=base/'frontier-host-failure-project'
spec=importlib.util.spec_from_file_location('cold',base/'benchmarks/cold_bench.py'); cold=importlib.util.module_from_spec(spec);spec.loader.exec_module(cold)
binary=Path(sys.argv[1]) if len(sys.argv)>1 else base/'frontier-integrated-first'
output=base/'frontier-host-failure-results';output.mkdir(exist_ok=True)
command=[str(binary),'check','--stdlib',str(base/'finite-integration/stdlib'),'--progress','plain']
base_env=dict(os.environ)
for name in ['SILK_EXPERIMENT_FRONTIER','SILK_FRONTIER_SHARED','SILK_FRONTIER_WARM','SILK_TEST_HOST_FAILURE','SILK_TEST_HOST_FAILURE_AT','LD_PRELOAD']:base_env.pop(name,None)
trials=[('serial',None,0),('parallel',None,0),('mmap','mmap',1),('tmpfile-first','tmpfile',1),('tmpfile-partial','tmpfile',3),('socketpair-first','socketpair',1),('socketpair-partial','socketpair',3),('fork-first','fork',1),('fork-partial','fork',3),('wait-interrupted','waitpid',1)]
results=[]
for label,mode,n in trials:
 shutil.rmtree(project/'build',ignore_errors=True)
 env=dict(base_env)
 if label!='serial':env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_WARM='0')
 if mode:env.update(LD_PRELOAD=str(base/'frontier-host-failures.so'),SILK_TEST_HOST_FAILURE=mode,SILK_TEST_HOST_FAILURE_AT=str(n))
 result=cold.measure(command,project,env,output/f'{label}.log')
 log=(output/f'{label}.log').read_text()
 result.update(label=label,injected=('INJECTED ' in log),accepted=('frontier accepted' in log),split=('frontier split' in log))
 results.append(result);(output/'results.json').write_text(json.dumps(results,indent=2)+'\n')
 print(label,'exit',result['exit_code'],'injected',result['injected'],'accepted',result['accepted'],'reaped',len(result['detached']),flush=True)
 if result['exit_code'] or (mode and not result['injected']) or (label in ['parallel','wait-interrupted'] and not result['accepted']):
  print(log,flush=True);raise SystemExit(1)
