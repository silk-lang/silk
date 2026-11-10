import ctypes, fcntl, hashlib, json, os, pathlib, subprocess, sys, time
root=pathlib.Path('/workspace/silk-streamed-hir-facets'); out=pathlib.Path('/workspace/silk/.scratch/streamed-hir-validation')
producer=pathlib.Path('/workspace/silk/.scratch/N1-one'); clang=pathlib.Path('/workspace/silk/.scratch/llvm-22.1.8/bin/clang')
ctypes.CDLL(None).prctl(36,1,0,0,0)
env={k:v for k,v in os.environ.items() if not k.startswith('SILK_')};env['SILK_CLANG']=str(clang)
commands=[('sourcecheck',[str(producer),'check','--manifest-path','compiler/silk.toml','--stdlib','stdlib','--progress','never']),('focused',[str(producer),'test','compiler/src/hir/LoweringCases.silk','-o',str(out/'streamed-hir-tests'),'--stdlib','stdlib','--optimization','none','--no-cache','--filter','streamed'])]
receipt={'source':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'producer':str(producer),'producer_sha256':hashlib.sha256(producer.read_bytes()).hexdigest(),'old_golden_producer_sha256':hashlib.sha256(pathlib.Path('/workspace/silk/.scratch/frontier-native-work-v22').read_bytes()).hexdigest(),'commands':[]}
with open('/workspace/silk/.scratch/performance.lock','a') as lock:
 fcntl.flock(lock,fcntl.LOCK_SH)
 for label,cmd in commands:
  before=time.monotonic()
  with open(out/(label+'.log'),'w') as log:p=subprocess.run(cmd,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
  reaped=[]
  while True:
   try:pid,status=os.waitpid(-1,0);reaped.append([pid,os.waitstatus_to_exitcode(status)])
   except ChildProcessError:break
  receipt['commands'].append({'label':label,'command':cmd,'exit':p.returncode,'elapsed':time.monotonic()-before,'reaped':reaped})
  (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
  print(label,p.returncode,'reaped',reaped,flush=True)
  if p.returncode:sys.exit(p.returncode)
