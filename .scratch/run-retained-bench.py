from pathlib import Path
import importlib.util,os,json,shutil,subprocess,hashlib,tempfile
spec=importlib.util.spec_from_file_location('cold','/workspace/silk/.scratch/benchmarks/cold_bench.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(tempfile.mkdtemp(prefix='retained-build-',dir='/workspace/silk/.scratch/benchmarks'));silk=root/'silk';nonstd=root/'nonstd'
revisions={'silk':m.snapshot(Path('/workspace/silk-baseline'),silk),'nonstd':m.snapshot(Path('/workspace/nonstd'),nonstd)}
compiler='/workspace/silk/.scratch/N1-retained-build';records=[]
(root/'metadata.json').write_text(json.dumps({'revisions':revisions,'compiler':compiler,'compiler_sha256':hashlib.sha256(Path(compiler).read_bytes()).hexdigest(),'cpus':'0-3','profile':'default','finite_artifact':bool(os.environ.get('SILK_FINITE_ARTIFACT')),'artifact_trace':bool(os.environ.get('SILK_ARTIFACT_TRACE')),'cold':'Fresh own build/cache per run; OS page cache not flushed.','rss':'maximum individual process, not concurrent aggregate'},indent=2))
Path('/workspace/silk/.scratch/retained-benchmark-root.txt').write_text(str(root))
for case in os.environ.get('RETAINED_CASES','compiler,harfrust').split(','):
 source=silk if case=='compiler' else nonstd;work=source if case=='compiler' else source/'fonts/shape/tools/cli'
 command=['taskset','-c','0-3',compiler,'build']+(['--package','silk-compiler'] if case=='compiler' else [])+['--stdlib',str(silk/'stdlib'),'--progress','plain','--timings']
 for mode in os.environ.get('RETAINED_MODES','off,on').split(','):
  if (source/'build').exists():shutil.rmtree(source/'build')
  env=dict(os.environ,SILK_CLANG='/workspace/silk/.scratch/llvm-22.1.8/bin/clang')
  for flag in ('SILK_PARALLEL_EMIT','SILK_RETAINED_BUILD','SILK_POSTCHECK_BUILD','SILK_FRONTIER_CHECK','SILK_FORK_CHECK','SILK_EXPERIMENT_FRONTIER','SILK_EXPERIMENT_FORK_CHECK'):env.pop(flag,None)
  if mode=='on':env['SILK_POSTCHECK_BUILD']='1'
  record={'case':case,'mode':mode,'command':command,**m.measure(command,work,env,root/(case+'-'+mode+'.log'))}
  if record['exit_code']==0:
   binary=source/'build/llvm/x86_64-unknown-linux-gnu/debug'/('silk-compiler' if case=='compiler' else 'font-shape-cli')
   dest=root/(case+'-'+mode);shutil.copy2(binary,dest);record['binary_sha256']=hashlib.sha256(dest.read_bytes()).hexdigest()
   artifact_root=source/'build/llvm';record['artifacts']={str(p.relative_to(artifact_root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(artifact_root.rglob('*')) if p.is_file()}
   if case=='compiler':record['version_rc']=subprocess.run([str(dest),'--version'],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode
  records.append(record);(root/'results.json').write_text(json.dumps(records,indent=2));print(json.dumps(record),flush=True)
  if record['exit_code']:raise SystemExit(1)
