import ctypes,os,subprocess,sys,time,json
from pathlib import Path
s=Path('/workspace/silk/.scratch');tree=s/'executable-specialization-preparation'
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
mode=sys.argv[1];tag=sys.argv[2]
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXECUTABLE_','SILK_ARTIFACT_','SILK_RETAINED_')) and k not in ('LLVM_PROFILE_FILE','LD_PRELOAD')};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
cmd=[str(s/'ci-n1-4a1fa332/N1'),mode,'--manifest-path',str(tree/'compiler/silk.toml'),'--stdlib',str(tree/'stdlib'),'--progress','plain','--timings']
if mode=='test':cmd+=['--root','src/SemanticRootCases.silk','--filter',sys.argv[3],'--optimization','debug','--no-cache']
log=s/('preparation-'+tag+'.log');start=time.monotonic()
with log.open('wb') as f:r=subprocess.run(cmd,cwd=tree,env=env,stdout=f,stderr=subprocess.STDOUT)
children=[]
while True:
 try:
  pid,status=os.waitpid(-1,0);children.append([pid,os.waitstatus_to_exitcode(status)])
 except ChildProcessError:break
print(json.dumps(dict(command=cmd,log=str(log),elapsed=time.monotonic()-start,exit=r.returncode,children=children)),flush=True)
sys.exit(r.returncode or int(any(code for _,code in children)))
