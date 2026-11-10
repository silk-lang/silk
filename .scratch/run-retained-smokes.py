from pathlib import Path
import importlib.util,os,json,shutil,subprocess,hashlib,tomllib
spec=importlib.util.spec_from_file_location('cold','/workspace/silk/.scratch/benchmarks/cold_bench.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path('/workspace/silk/.scratch/retained-smokes');compiler='/workspace/silk/.scratch/N1-retained-build';records=[]
for case in ('ordinary','basic','observer','suspension','statics','providers','lifetimes_local_first','lifetimes_static_first','nonparking_provider'):
 work=root/case
 for mode in ('off','on'):
  if (work/'build').exists():shutil.rmtree(work/'build')
  env=dict(os.environ,SILK_CLANG='/workspace/silk/.scratch/llvm-22.1.8/bin/clang')
  for flag in ('SILK_PARALLEL_EMIT','SILK_RETAINED_BUILD','SILK_POSTCHECK_BUILD','SILK_FRONTIER_CHECK','SILK_FORK_CHECK','SILK_EXPERIMENT_FRONTIER','SILK_EXPERIMENT_FORK_CHECK'):env.pop(flag,None)
  if mode=='on':env['SILK_POSTCHECK_BUILD']='1'
  dest=work/('program-'+mode)
  command=[compiler,'build','--stdlib','/workspace/silk-retained-build/stdlib','--progress','plain','--timings']
  record={'case':case,'mode':mode,**m.measure(command,work,env,work/(mode+'.log'))}
  if record['exit_code']==0:
   package=tomllib.loads((work/'silk.toml').read_text())['package']['name']
   shutil.copy2(work/'build/llvm/x86_64-unknown-linux-gnu/debug'/package,dest)
   record['binary_sha256']=hashlib.sha256(dest.read_bytes()).hexdigest()
   record['program_exit']=subprocess.run([str(dest)],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode
  trace=(work/(mode+'.log')).read_text()
  record['accepted']='artifact accepted' in trace
  record['refused']='artifact refused' in trace
  records.append(record);(root/'results.json').write_text(json.dumps(records,indent=2));print(json.dumps(record),flush=True)
  if record['exit_code'] or record.get('program_exit')!=42:raise SystemExit(1)
