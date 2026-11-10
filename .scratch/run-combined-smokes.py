from pathlib import Path
import importlib.util,os,json,shutil,subprocess,hashlib,tomllib,re,tempfile
spec=importlib.util.spec_from_file_location('cold','/workspace/silk/.scratch/benchmarks/cold_bench.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(tempfile.mkdtemp(prefix='combined-smokes-',dir='/workspace/silk/.scratch/benchmarks'));Path('/workspace/silk/.scratch/combined-smokes-root.txt').write_text(str(root))
compiler=os.environ.get('COMBINED_COMPILER','/workspace/silk/.scratch/combined-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler');records=[]
for case in os.environ.get('COMBINED_CASES','ordinary,basic,observer,suspension,statics,providers,lifetimes_local_first,lifetimes_static_first,nonparking_provider').split(','):
 source=Path('/workspace/silk/.scratch/retained-smokes')/case;work=root/case
 shutil.copytree(source/'src',work/'src');shutil.copy2(source/'silk.toml',work/'silk.toml')
 names=['pad'+str(i).zfill(2) for i in range(40)]
 for name in names:(work/'src'/(name+'.silk')).write_text('pub fn answer() -> i32 { return 0 }\n')
 main=work/'src/main.silk';s=main.read_text();match=re.search(r'pub\s+(?:effect\s+)?fn\s+main\b[^\{]*\{',s);assert match,case
 s=s[:match.end()]+'\n  let _padding = '+' + '.join(n+'.answer()' for n in names)+'\n'+s[match.end():]
 main.write_text('\n'.join('import '+n for n in names)+'\n'+s)
 pair=[]
 for mode in os.environ.get('COMBINED_MODES','off,on').split(','):
  if (work/'build').exists():shutil.rmtree(work/'build')
  env=dict(os.environ,SILK_CLANG='/workspace/silk/.scratch/llvm-22.1.8/bin/clang')
  for flag in list(env):
   if flag.startswith('SILK_EXPERIMENT') or flag.startswith('SILK_FRONTIER') or flag in ('SILK_PARALLEL_EMIT','SILK_RETAINED_BUILD','SILK_POSTCHECK_BUILD','SILK_FINITE_ARTIFACT','SILK_ARTIFACT_TRACE'):env.pop(flag,None)
  if mode=='on':env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_WARM='0',SILK_RETAINED_BUILD='1')
  if mode=='on' and os.environ.get('COMBINED_EPHEMERAL'):env['SILK_FRONTIER_EPHEMERAL']='1'
  if mode=='postcheck':env['SILK_POSTCHECK_BUILD']='1'
  command=[compiler,'build','--stdlib',os.environ.get('COMBINED_STDLIB','/workspace/silk-combined-build/stdlib'),'--progress','plain','--timings']
  record={'case':case,'mode':mode,**m.measure(command,work,env,work/(mode+'.log'))}
  if record['exit_code']==0:
   package=tomllib.loads((work/'silk.toml').read_text())['package']['name'];artifact=work/'build/llvm/x86_64-unknown-linux-gnu/debug'/package
   record['binary_sha256']=hashlib.sha256(artifact.read_bytes()).hexdigest();executed=subprocess.run([str(artifact)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   record.update(program_exit=executed.returncode,stdout=executed.stdout.decode(errors='replace'),stderr=executed.stderr.decode(errors='replace'))
  trace=(work/(mode+'.log')).read_text();record['accepted']='artifact accepted' in trace;record['refused']='artifact refused' in trace;record['frontier_accepted']='frontier accepted' in trace
  records.append(record);pair.append(record);(root/'results.json').write_text(json.dumps(records,indent=2));print(json.dumps(record),flush=True)
  if record['exit_code'] or record.get('program_exit')!=42:raise SystemExit('execution failed '+case+' '+mode)
  if mode=='on' and not record['frontier_accepted']:raise SystemExit('frontier did not accept '+case)
  if mode!='off' and case!='suspension' and not record['accepted']:raise SystemExit('artifact did not accept '+case)
  if mode!='off' and case=='suspension' and not record['refused']:raise SystemExit('suspension did not explicitly fall back')
 if len(pair)>1 and len({(r['program_exit'],r['stdout'],r['stderr']) for r in pair})!=1:raise SystemExit('runtime parity mismatch')
print('PASS combined smokes',root,flush=True)
