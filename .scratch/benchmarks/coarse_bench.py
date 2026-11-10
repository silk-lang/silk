import hashlib,importlib.util,json,os,shutil,sys,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('cold_bench','/workspace/silk/.scratch/benchmarks/cold_bench.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
base=Path('/workspace/silk')
phase=sys.argv[1] if len(sys.argv)>1 else 'check'
root=Path(tempfile.mkdtemp(prefix='coarse-',dir=base/'.scratch/benchmarks'))
silk=root/'silk';nonstd=root/'nonstd'
revisions={'silk':b.snapshot(Path('/workspace/silk-baseline'),silk),'nonstd':b.snapshot(Path('/workspace/nonstd'),nonstd)}
compiler=base/'.scratch/coarse-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
metadata={'root':str(root),'compiler':str(compiler),'compiler_sha256':hashlib.sha256(compiler.read_bytes()).hexdigest(),'revisions':revisions,'operation':phase}
(root/'metadata.json').write_text(json.dumps(metadata,indent=2));print(json.dumps(metadata),flush=True)
for workload,source,cwd,flags,leaf,artifactname in [('compiler',silk,silk,['--package','silk-compiler'],silk/'compiler/src/ReleaseVersion.silk','silk-compiler'),('harfrust',nonstd,nonstd/'fonts/shape/tools/cli',[],nonstd/'fonts/shape/tools/cli/src/options.silk','font-shape-cli')]:
 original=leaf.read_text();hashes=[]
 for enabled in [False,True]:
  leaf.write_text(original);shutil.rmtree(source/'build',ignore_errors=True)
  env=dict(os.environ);env['SILK_CLANG']=str(base/'.scratch/llvm-22.1.8/bin/clang')
  for key in ['SILK_EXPERIMENT_COARSE_CHECK','SILK_EXPERIMENT_COARSE_BUILD','SILK_EXPERIMENT_COARSE_TRACE']:env.pop(key,None)
  if enabled:
   env['SILK_EXPERIMENT_COARSE_CHECK']='1';env['SILK_EXPERIMENT_COARSE_BUILD']='1';env['SILK_EXPERIMENT_COARSE_TRACE']='1'
  command=[str(compiler),phase,*flags,'--stdlib',str(silk/'stdlib'),'--progress','plain','--timings']
  states=['cold','warm','edited','edited-warm'] if phase=='check' else ['cold','warm']
  for state in states:
   if state=='edited':
    leaf.write_text(original.replace('b"0.0.0"','b"0.0.1"') if workload=='compiler' else original+'\npub fn coarseExperimentEdit() -> i32 { return 7 }\n')
   log=root/f'{workload}-{enabled}-{state}.log'
   result=b.measure(command,cwd,env,log)
   result.update(workload=workload,coarse=enabled,state=state,operation=phase)
   result['whole_hit']='whole-check hit\n' in log.read_text(errors='replace')
   if phase=='build' and state=='cold' and result['exit_code']==0:
    paths=[p for p in (source/'build').rglob(artifactname) if p.is_file()]
    assert len(paths)==1,paths
    result['artifact_sha256']=hashlib.sha256(paths[0].read_bytes()).hexdigest();hashes.append(result['artifact_sha256'])
   with (root/'results.jsonl').open('a') as f:f.write(json.dumps(result)+'\n')
   print(json.dumps(result),flush=True)
   if result['exit_code']:raise RuntimeError(f'{workload} {enabled} {state} failed: {log}')
  leaf.write_text(original)
 if phase=='build':
  assert len(hashes)==2 and hashes[0]==hashes[1],(workload,hashes)
  print(json.dumps({'workload':workload,'byte_identical':True,'sha256':hashes[0]}),flush=True)
print('FINISHED',phase,root,flush=True)
