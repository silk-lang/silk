import os,json,importlib.util,shutil,hashlib,tempfile,time
from pathlib import Path

base=Path('/workspace/silk'); scratch=base/'.scratch'
frozen=scratch/'benchmarks/transport-family-ctvjs_tx'
compiler=scratch/'frontier-integrated-first'
expected='9b5b5f370b0f716601ccc1d668700108484e9ee36aefa6ce01259cfa911e8c04'
assert hashlib.sha256(compiler.read_bytes()).hexdigest()==expected
spec=importlib.util.spec_from_file_location('cold',str(scratch/'benchmarks/cold_bench.py'))
b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
root=Path(tempfile.mkdtemp(prefix='frontier-integrated-edits-',dir=scratch/'benchmarks'))
for name in ['silk','nonstd']:
 source_root=frozen/name
 def ignored(directory,names):
  return [name for name in names if name=='.git' or (name=='build' and Path(directory)==source_root)]
 shutil.copytree(source_root,root/name,ignore=ignored)

def treehash(path):
 h=hashlib.sha256()
 for file in sorted(path.rglob('*')):
  if file.is_file():
   h.update(str(file.relative_to(path)).encode()+b'\0');h.update(file.read_bytes()+b'\0')
 return h.hexdigest()

metadata={'compiler':str(compiler),'compiler_sha256':expected,'root':str(root),
 'copied_from':str(frozen),'source_hashes':{name:treehash(root/name) for name in ['silk','nonstd']},
 'stages':['cold','warm','first-edit','second-edit','second-warm'],
 'edit':'append public zero-argument function returning i32 1; then change body to return 2',
 'cpu_affinity':sorted(os.sched_getaffinity(0)),
 'rss_note':'Maximum individual process RSS, not simultaneous aggregate RSS',
 'locking':'Caller holds exclusive performance.lock for complete sequence'}
(root/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
print(json.dumps(metadata),flush=True)
results=[]
for workload in ['compiler','harfrust']:
 source=root/('silk' if workload=='compiler' else 'nonstd')
 cwd=source if workload=='compiler' else source/'fonts/shape/tools/cli'
 edited=source/'compiler/src/main.silk' if workload=='compiler' else cwd/'src/main.silk'
 original=edited.read_bytes()
 try:
  for ephemeral in [False,True]:
   mode='ephemeral' if ephemeral else 'cached'
   edited.write_bytes(original);shutil.rmtree(source/'build',ignore_errors=True)
   env={k:v for k,v in os.environ.items() if not (k.startswith('SILK_FRONTIER_') or k.startswith('SILK_EXPERIMENT_'))}
   env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_CLANG=str(scratch/'llvm-22.1.8/bin/clang'))
   if ephemeral:env['SILK_FRONTIER_EPHEMERAL']='1'
   command=[str(compiler),'check']+(['--package','silk-compiler'] if workload=='compiler' else [])+['--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings']
   for stage in metadata['stages']:
    if stage=='first-edit':edited.write_bytes(original+b'\npub fn ephemeralEditProbe() -> i32 { return 1 }\n')
    if stage=='second-edit':edited.write_bytes(original+b'\npub fn ephemeralEditProbe() -> i32 { return 2 }\n')
    tag=f'{workload}-{mode}-{stage}';log=root/f'{tag}.log'
    r=b.measure(command,cwd,env,log); raw=log.read_text()
    r.update(workload=workload,mode=mode,stage=stage,command=command,
      edited_file_sha256=hashlib.sha256(edited.read_bytes()).hexdigest(),
      accepted='frontier accepted' in raw,ephemeral_workers=raw.count('frontier worker-ephemeral '))
    results.append(r);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps(r),flush=True)
    if r['exit_code']!=0:raise RuntimeError('check failed: '+tag)
 finally:
  edited.write_bytes(original)
  shutil.rmtree(source/'build',ignore_errors=True)
assert metadata['source_hashes']=={name:treehash(root/name) for name in ['silk','nonstd']}
(root/'restored.json').write_text(json.dumps({'sources_restored':True})+'\n')
print('COMPLETE '+str(root),flush=True)
