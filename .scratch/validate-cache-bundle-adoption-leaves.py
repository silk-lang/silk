"""Caller holds performance.lock in shared mode. Two minimal module test roots, no compiler build."""
import argparse,ctypes,json,os,subprocess,time
from pathlib import Path
s=Path('/workspace/silk/.scratch')
parser=argparse.ArgumentParser();parser.add_argument('--tree',type=Path,default=s/'cache-bundle-source');parser.add_argument('--all-small',action='store_true');args=parser.parse_args();tree=args.tree
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
compiler=s/'ci-n1-4a1fa332/N1'
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_PROFILE_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_CACHE_','SILK_NATIVE_BUILD_PIPELINE','SILK_ESCAPE_')) and k not in ('LLVM_PROFILE_FILE','LD_PRELOAD')};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
rows=[]
tests=[('semantic','CacheInputProof','exactCrossShardSourceEvidenceClaims'),('semantic','CacheBundleLive','selectedBundleEvidenceExcludesDeadShardObservations')]
if args.all_small: tests += [('semantic','CacheBundle','immutableCacheBundle'),('driver','CacheBundles','cacheBundleManifestPublishesOnlyCompleteShardSets')]
for area,module,test in tests:
 log=s/f'cache-bundle-{module}-tests.log';output=s/f'cache-bundle-{module}-tests';command=[str(compiler),'test',f'compiler/src/{area}/{module}.silk','--stdlib','stdlib','--optimization','none','--no-cache','--filter',test,'-o',str(output)]
 started=time.monotonic()
 with log.open('wb') as f:q=subprocess.run(command,cwd=tree,env=env,stdout=f,stderr=subprocess.STDOUT)
 children=[]
 while True:
  try:pid,status=os.waitpid(-1,0);children.append([pid,os.waitstatus_to_exitcode(status)])
  except ChildProcessError:break
 row={'tree':str(tree),'module':module,'test':test,'command':command,'status':q.returncode,'elapsed':time.monotonic()-started,'children':children,'log':str(log),'output':str(output)};rows.append(row);print(json.dumps(row),flush=True)
 (s/'cache-bundle-adoption-leaf-tests.json').write_text(json.dumps(rows,indent=2)+'\n')
 assert q.returncode==0 and all(status==0 for _,status in children),row
