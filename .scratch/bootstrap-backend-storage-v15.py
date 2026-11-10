"""Frozen mono/O2 V15 backend storage construction with reused IR PGO; caller holds shared lock."""
import argparse,ctypes,hashlib,json,os,re,shutil,subprocess,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--revision',required=True);a=p.parse_args()
s=Path('/workspace/silk/.scratch');tree=s/'backend-storage-v15-source';builder=s/'ci-n1-4a1fa332/N1';binary=s/'backend-storage-v15'
profile=s/'construction-9279952db/pgo/compiler.profdata';profile_source='9279952dba5d0cc7f02f4f1b2439dc0607cfe162';expected_profile='596383e9556b6724cf2e7ebfea044aa2c3720cc1a4f3f72b0365e097f6c98662'
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def git(*args):return subprocess.check_output(['git','-C',str(tree),*args],text=True).strip()
assert re.fullmatch('[0-9a-f]{40}',a.revision),a.revision
assert git('rev-parse','HEAD')==a.revision and not git('status','--porcelain'),'source freeze mismatch'
assert sha(profile)==expected_profile,'profile changed'
assert sha(builder)=='d0c04d1a9b672e34fd6302ccaa9fc49b23a2ba1954c8d826dc73be626bc611db','producer changed'
clang=s/'llvm-22.1.8/bin/clang-22'
assert sha(clang)=='31a40dc31f3c15a47aa119aa148f339bf363d8f61202ddbdacbd3f24b71ba113','Clang changed'
diagnostics=s/'backend-storage-v15-clang-diagnostics'
if diagnostics.exists():diagnostics.rename(s/('backend-storage-v15-clang-diagnostics-previous-'+str(time.time_ns())))
shutil.copy2(s/'clang-backend-storage-v15-pgo',s/'clang-backend-storage-v15-pgo.used')
libc=ctypes.CDLL(None,use_errno=True)
if libc.prctl(36,1,0,0,0)!=0:raise OSError(ctypes.get_errno(),'PR_SET_CHILD_SUBREAPER')
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_PROFILE_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_')) and k not in ['LLVM_PROFILE_FILE','LD_PRELOAD']}
env['SILK_CLANG']=str(s/'clang-backend-storage-v15-pgo');env['SILK_PROFILE_USE']=str(profile)
commands=s/'backend-storage-v15-clang.jsonl';commands.write_text('')
args=[str(builder),'build','src/main.silk','-o',str(binary),'--stdlib','../stdlib','--optimization','speed','--debug','false']
log=s/'backend-storage-v15-build.log';started=time.monotonic()
with log.open('wb') as f:result=subprocess.run(args,cwd=tree/'compiler',env=env,stdout=f,stderr=subprocess.STDOUT)
detached=[]
while True:
 try:
  pid,status=os.waitpid(-1,0);detached.append({'pid':pid,'exit':os.waitstatus_to_exitcode(status)})
 except ChildProcessError:break
assert result.returncode==0,(result.returncode,str(log))
assert all(x['exit']==0 for x in detached),detached
assert git('rev-parse','HEAD')==a.revision and not git('status','--porcelain'),'source changed during construction'
invocations=[json.loads(line) for line in commands.read_text().splitlines()]
assert any(any(arg=='-fprofile-use='+str(profile) for arg in x['arguments']) for x in invocations),'profile flag missing'
profile_invocations=[x for x in invocations if any(arg.startswith('-fprofile-use=') for arg in x['arguments'])]
assert profile_invocations and all((diagnostics/(str(x['pid'])+'.log')).exists() for x in profile_invocations),'native diagnostics missing'
text='\n'.join((diagnostics/(str(x['pid'])+'.log')).read_text(errors='replace') for x in profile_invocations)
missing=re.findall(r'no profile data available for function (\S+)',text);mismatch=[line for line in text.splitlines() if any(word in line.lower() for word in ['hash mismatch','profile data may be out of date','cfg mismatch','function control flow change detected'])]
metadata={'source':a.revision,'binary':str(binary),'sha256':sha(binary),'builder':str(builder),'builder_sha256':sha(builder),'clang':str(clang),'clang_sha256':sha(clang),'executed_clang_wrapper_sha256':sha(s/'clang-backend-storage-v15-pgo.used'),'clang_diagnostics_directory':str(diagnostics),'clang_warning_coverage_complete':True,'actual_applied_profile_functions':None,'optimization':'speed','debug':False,'codegen_units':1,'construction':'mono O2 reused IR instrumentation profile','profile':str(profile),'profile_sha256':expected_profile,'profile_source':profile_source,'source_diff_files':git('diff','--name-only',profile_source,a.revision).splitlines(),'training_summary':{'profile_functions':8343,'module_local_names':8334,'external_names':9},'profile_coverage_note':'Mono uses identical source_filename=silk and internal content-symbol naming. Changed/new functions may lack counts or fail CFG-hash matching and use normal optimization. Missing/mismatch diagnostics are enabled; exact applied-count coverage is not inferred from raw source-symbol totals. No four-unit linkage alias/remapping is used.','missing_profile_warnings':len(missing),'missing_profile_functions':missing,'cfg_mismatch_warnings':mismatch,'warning_lines':[line for line in text.splitlines() if 'warning:' in line],'elapsed_construction_s':time.monotonic()-started,'detached':detached,'affinity':sorted(os.sched_getaffinity(0)),'command':args,'cwd':str(tree/'compiler'),'build_log':str(log),'clang_invocations':str(commands)}
(s/'backend-storage-v15.json').write_text(json.dumps(metadata,indent=2)+'\n')
print(json.dumps({k:metadata[k] for k in ['source','sha256','profile_sha256','codegen_units','missing_profile_warnings','elapsed_construction_s']}),flush=True)
