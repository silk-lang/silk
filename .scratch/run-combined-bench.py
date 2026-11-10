from pathlib import Path
import importlib.util,os,json,shutil,subprocess,hashlib,tempfile
spec=importlib.util.spec_from_file_location('cold','/workspace/silk/.scratch/benchmarks/cold_bench.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(tempfile.mkdtemp(prefix='combined-build-',dir='/workspace/silk/.scratch/benchmarks'));silk=root/'silk';nonstd=root/'nonstd'
revisions={'silk':m.snapshot(Path('/workspace/silk-baseline'),silk),'nonstd':m.snapshot(Path('/workspace/nonstd'),nonstd)}
compiler=os.environ.get('COMBINED_COMPILER','/workspace/silk/.scratch/combined-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler');records=[]
(root/'metadata.json').write_text(json.dumps({'revisions':revisions,'compiler':compiler,'compiler_sha256':hashlib.sha256(Path(compiler).read_bytes()).hexdigest(),'cpus':'0-3','profile':'default','finite_artifact':True,'artifact_trace':bool(os.environ.get('SILK_ARTIFACT_TRACE')),'cold':'Fresh own build/cache per run; OS page cache not flushed.','rss':'maximum individual process, not concurrent aggregate'},indent=2))
Path('/workspace/silk/.scratch/combined-benchmark-root.txt').write_text(str(root))
for case in os.environ.get('RETAINED_CASES','compiler,harfrust').split(','):
 source=silk if case=='compiler' else nonstd;work=source if case=='compiler' else source/'fonts/shape/tools/cli'
 command=['taskset','-c','0-3',compiler,'build']+(['--package','silk-compiler'] if case=='compiler' else [])+['--stdlib',str(silk/'stdlib'),'--progress','plain','--timings']
 for mode in os.environ.get('RETAINED_MODES','off,on').split(','):
  if (source/'build').exists():shutil.rmtree(source/'build')
  env=dict(os.environ,SILK_CLANG='/workspace/silk/.scratch/llvm-22.1.8/bin/clang')
  for flag in ('SILK_PARALLEL_EMIT','SILK_RETAINED_BUILD','SILK_POSTCHECK_BUILD','SILK_FRONTIER_CHECK','SILK_FORK_CHECK','SILK_EXPERIMENT_FRONTIER','SILK_EXPERIMENT_FORK_CHECK','SILK_FRONTIER_SHARED','SILK_FRONTIER_WARM','SILK_FRONTIER_STATIC','SILK_FINITE_ARTIFACT','SILK_FRONTIER_EPHEMERAL','SILK_EXPERIMENT_DEV_PACKS'):env.pop(flag,None)
  if mode in ('on','repeat','packed'):env.update(SILK_RETAINED_BUILD='1',SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1')
  if mode in ('on','repeat','packed') and os.environ.get('COMBINED_EPHEMERAL'):env['SILK_FRONTIER_EPHEMERAL']='1'
  if mode=='packed':env['SILK_EXPERIMENT_DEV_PACKS']='1'
  record={'case':case,'mode':mode,'command':command,**m.measure(command,work,env,root/(case+'-'+mode+'.log'))}
  if record['exit_code']==0:
   binary=source/'build/llvm/x86_64-unknown-linux-gnu/debug'/('silk-compiler' if case=='compiler' else 'font-shape-cli')
   dest=root/(case+'-'+mode);shutil.copy2(binary,dest);record['binary_sha256']=hashlib.sha256(dest.read_bytes()).hexdigest()
   artifact_root=source/'build/llvm';record['artifacts']={str(p.relative_to(artifact_root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(artifact_root.rglob('*')) if p.is_file()}
   if case=='compiler':record['version_rc']=subprocess.run([str(dest),'--version'],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode
  trace=(root/(case+'-'+mode+'.log')).read_text();record.update(frontier_accepted='frontier accepted' in trace,artifact_accepted='artifact accepted' in trace,artifact_refused='artifact refused' in trace)
  records.append(record);(root/'results.json').write_text(json.dumps(records,indent=2));print(json.dumps(record),flush=True)
  if record['exit_code']:raise SystemExit(1)
  if mode in ('on','repeat','packed') and not(record['frontier_accepted'] and record['artifact_accepted']):raise SystemExit('combined path did not accept '+case)
comparisons=[]
for case in {r['case'] for r in records}:
 rows={r['mode']:r for r in records if r['case']==case}
 for left,right in [('off','on'),('on','repeat'),('on','packed')]:
  if left not in rows or right not in rows:continue
  a=rows[left]['artifacts'];b=rows[right]['artifacts']
  comparisons.append({'case':case,'left':left,'right':right,'binary_equal':rows[left]['binary_sha256']==rows[right]['binary_sha256'],'differences':[k for k in sorted(set(a)|set(b)) if a.get(k)!=b.get(k)]})
(root/'comparisons.json').write_text(json.dumps(comparisons,indent=2))
print(json.dumps({'root':str(root),'comparisons':comparisons}),flush=True)
