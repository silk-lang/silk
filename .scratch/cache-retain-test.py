import ctypes,fcntl,hashlib,json,os,pathlib,subprocess,time
root=pathlib.Path('/workspace/silk');tree=root/'.scratch/incremental-cache-segments'
compiler=root/'.scratch/ci-n1-4a1fa332/N1';clang=root/'.scratch/llvm-22.1.8/bin/clang'
command=[str(compiler),'test',str(tree/'compiler/src/semantic/CacheRetainCases.silk'),'--stdlib',str(tree/'stdlib'),'--filter','cacheRetain','--optimization','none','--debug','false','--output',str(root/'.scratch/cache-retain-tests'),'--no-cache']
env={k:v for k,v in os.environ.items() if not k.startswith('SILK') and k not in ('LLVM_PROFILE_FILE','LD_PRELOAD')};env['SILK_CLANG']=str(clang)
receipt={'command':command,'baseline':'85ba82efe750a4682cc21192ad5dcb37d7bbd981','inputs':{str(p.relative_to(tree)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (tree/'compiler/src/semantic/CacheSegments.silk',tree/'compiler/src/semantic/CacheGeneration.silk',tree/'compiler/src/semantic/CacheView.silk',tree/'compiler/src/semantic/CacheRetain.silk',tree/'compiler/src/semantic/CacheRetainCases.silk')},'compiler_sha256':hashlib.sha256(compiler.read_bytes()).hexdigest(),'clang_sha256':hashlib.sha256(clang.read_bytes()).hexdigest()}
assert receipt['compiler_sha256']=='d0c04d1a9b672e34fd6302ccaa9fc49b23a2ba1954c8d826dc73be626bc611db'
if ctypes.CDLL(None).prctl(36,1,0,0,0):raise RuntimeError('subreaper failed')
with open(root/'.scratch/performance.lock','a') as lock:
 fcntl.flock(lock,fcntl.LOCK_SH)
 start=time.monotonic()
 with open(root/'.scratch/cache-retain-tests.log','w') as log:r=subprocess.run(command,env=env,cwd=tree,stdout=log,stderr=subprocess.STDOUT)
 receipt['exit']=r.returncode;receipt['reaped']=[]
 while True:
  try:
   pid,status,usage=os.wait4(-1,0);receipt['reaped'].append({'pid':pid,'exit':os.waitstatus_to_exitcode(status),'user':usage.ru_utime,'sys':usage.ru_stime})
  except ChildProcessError:break
 receipt['elapsed']=time.monotonic()-start
 receipt['inputs_unchanged']=all(hashlib.sha256((tree/p).read_bytes()).hexdigest()==h for p,h in receipt['inputs'].items())
 (root/'.scratch/cache-retain-tests.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt),flush=True)
raise SystemExit(r.returncode or any(x['exit'] for x in receipt['reaped']))
