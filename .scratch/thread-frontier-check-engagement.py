"""One normal-admission CLI check engagement; diagnostic correctness only, caller holds lock."""
from pathlib import Path
import argparse,importlib.util,json,os,shutil,tempfile,hashlib
p=argparse.ArgumentParser();p.add_argument('--compiler',required=True);p.add_argument('--stdlib',required=True);p.add_argument('--fixture',required=True);a=p.parse_args()
s=Path('/workspace/silk/.scratch');root=Path(tempfile.mkdtemp(prefix='thread-frontier-check-',dir=s/'benchmarks'));print(root,flush=True)
f=Path(a.fixture);shutil.copytree(f/'src',root/'src');shutil.copy2(f/'silk.toml',root/'silk.toml')
spec=importlib.util.spec_from_file_location('cold',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
env={k:v for k,v in os.environ.items() if not k.startswith('SILK_') and k not in ['LD_PRELOAD','LLVM_PROFILE_FILE']};env.update(SILK_CLANG=str(s/'llvm-22.1.8/bin/clang'),SILK_EXPERIMENT_THREADS='1',SILK_RETAINED_CACHE='1')
cmd=[str(Path(a.compiler).resolve()),'check','--stdlib',str(Path(a.stdlib).resolve()),'--json','--progress','never']
(root/'metadata.json').write_text(json.dumps({'command':cmd,'binary_sha256':hashlib.sha256(Path(a.compiler).read_bytes()).hexdigest(),'environment':{k:v for k,v in env.items() if k.startswith('SILK_')},'purpose':'Normal admission first check engagement, no timing claim'},indent=2)+'\n')
r=b.measure(cmd,root,env,root/'check.log');trace=(root/'check.log').read_text();r['accepted']='frontier accepted' in trace;r['native_replies']=trace.count('frontier thread initial tasks');(root/'results.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r),flush=True)
assert r['exit_code']==0 and all(x['exit_code']==0 for x in r['detached'])
assert r['accepted'] and r['native_replies']==4,root/'check.log'
