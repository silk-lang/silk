"""Twelve actual-source compact sink and proof-query parity cases; caller holds the shared performance lock."""
import argparse, ctypes, hashlib, json, os, re, subprocess, time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--revision',required=True);a=p.parse_args()
s=Path('/workspace/silk/.scratch');tree=s/'runtime-preparation-gate';builder=s/'ci-n1-4a1fa332/N1';clang=s/'llvm-22.1.8/bin/clang'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def git(*args):return subprocess.check_output(['git','-C',str(tree),*args],text=True).strip()
assert git('rev-parse','HEAD')==a.revision and not git('status','--porcelain')
assert sha(builder)=='d0c04d1a9b672e34fd6302ccaa9fc49b23a2ba1954c8d826dc73be626bc611db'
assert ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)==0
env={k:v for k,v in os.environ.items() if not k.startswith('SILK_') and k not in ['LLVM_PROFILE_FILE','LD_PRELOAD']};env['SILK_CLANG']=str(clang)
output=s/f'runtime-preparation-{a.revision[:9]}-tests'
selections=[('runtimeProofRetainsPendingBorrowAndConcreteCallbackRoles',1),('runtimeControlUsesFinalBlockOrderAndReplacedTerminators',1),('checkedRuntimePlan',7),('checkedRuntimePreparation',2),('runtimePlanCountsResetAtForkAndSaturate',1)]
rows=[]
for ordinal,(selected,count) in enumerate(selections):
 command=[str(builder),'test',str(tree/'compiler/src/backend/RuntimePlanCases.silk'),'--stdlib',str(tree/'stdlib'),'--filter',selected,'--optimization','none','--debug','false','--output',str(output)]
 if ordinal==0:command.append('--no-cache')
 log=s/f'runtime-preparation-{a.revision[:9]}-{ordinal+1}.log';start=time.monotonic()
 with log.open('wb') as f: result=subprocess.run(command,cwd=tree,env=env,stdout=f,stderr=subprocess.STDOUT)
 detached=[]
 while True:
  try:
   pid,status=os.waitpid(-1,0);detached.append({'pid':pid,'exit':os.waitstatus_to_exitcode(status)})
  except ChildProcessError:break
 text=log.read_text(errors='replace')
 passed=bool(re.search(rf'Tests\s+{count} passed, 0 failed \(0 cached, {count} executed, {count} selected,',text))
 names=[line.strip() for line in text.splitlines() if '::' in line and selected in line]
 rows.append({'filter':selected,'expected':count,'names':names,'command':command,'log':str(log),'exit':result.returncode,'passed':passed,'elapsed_s':time.monotonic()-start,'detached':detached})
 metadata={'source':a.revision,'aggregator_sha256':sha(tree/'compiler/src/backend/RuntimePlanCases.silk'),'builder_sha256':sha(builder),'clang_sha256':sha(clang),'runner':str(output),'rows':rows,'purpose':'Actual compact sink versus executable projection, exact patterns, cleanup, observers, shared access, parking, selected providers and cache guards; no performance claim'}
 (s/f'runtime-preparation-{a.revision[:9]}-focused.json').write_text(json.dumps(metadata,indent=2)+'\n')
 print(json.dumps(rows[-1]),flush=True)
 assert result.returncode==0 and passed and len(names)==count,(result.returncode,str(log),names)
 assert all(x['exit']==0 for x in detached),detached
assert git('rev-parse','HEAD')==a.revision and not git('status','--porcelain')
print('PASS: 12 selected, 12 executed, 0 cached; all descendants reaped',flush=True)
