from pathlib import Path
import importlib.util,os,json,shutil,subprocess,hashlib
spec=importlib.util.spec_from_file_location('cold','/workspace/silk/.scratch/benchmarks/cold_bench.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(Path('/workspace/silk/.scratch/portable-benchmark-root.txt').read_text());work=root/'silk'
compiler='/workspace/silk/.scratch/N1-parallel-emit'
command=['taskset','-c','0-3',compiler,'build','--package','silk-compiler','--stdlib',str(work/'stdlib'),'--progress','plain','--timings']
records=[]
for mode in ('off','on'):
 if (work/'build').exists():shutil.rmtree(work/'build')
 env=dict(os.environ,SILK_CLANG='/workspace/silk/.scratch/llvm-22.1.8/bin/clang');env.pop('SILK_PARALLEL_EMIT',None)
 if mode=='on':env['SILK_PARALLEL_EMIT']='1'
 record={'mode':mode,'command':command,**m.measure(command,work,env,root/(mode+'.log'))}
 if record['exit_code']==0:
  binary=work/'build/llvm/x86_64-unknown-linux-gnu/debug/silk-compiler'
  dest=root/('compiler-'+mode);shutil.copy2(binary,dest)
  record['binary_sha256']=hashlib.sha256(dest.read_bytes()).hexdigest()
  record['version_rc']=subprocess.run([str(dest),'--version'],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode
 records.append(record);(root/'results.json').write_text(json.dumps(records,indent=2));print(json.dumps(record),flush=True)
 if record['exit_code']:break
