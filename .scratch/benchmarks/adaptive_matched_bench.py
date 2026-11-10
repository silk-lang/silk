import argparse,hashlib,importlib.util,json,os,re,shutil,tempfile,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--rounds',type=int,default=2);args=p.parse_args()
repo=Path('/workspace/silk')
spec=importlib.util.spec_from_file_location('cold',repo/'.scratch/benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
root=Path(tempfile.mkdtemp(prefix='adaptive-matched-',dir=repo/'.scratch/benchmarks'))
silk=root/'silk';nonstd=root/'nonstd'
revs={'silk':b.snapshot(Path('/workspace/silk-baseline'),silk),'nonstd':b.snapshot(Path('/workspace/nonstd'),nonstd)}
originalCompiler=repo/'.scratch/coarse-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
compiler=root/'compiler-under-test';shutil.copy2(originalCompiler,compiler)
baseEnv=dict(os.environ)
for k in list(baseEnv):
 if k.startswith('SILK_EXPERIMENT_') or k in ['SILK_VERIFY_MIR','SILK_PROFILE_GENERATE','SILK_PROFILE_USE']:baseEnv.pop(k,None)
baseEnv['SILK_CLANG']=str(repo/'.scratch/llvm-22.1.8/bin/clang')
snapshotRoot=repo/'.scratch/coarse-cache-experiment'
sourceFiles=['compiler/src/main.silk','compiler/src/driver/BuildInputs.silk','compiler/src/driver/NativeCompile.silk','compiler/src/semantic/SourceRevision.silk','compiler/src/semantic/TypeText.silk','compiler/src/backend/LlvmCode.silk']
sourceHashes={name:hashlib.sha256((snapshotRoot/name).read_bytes()).hexdigest() for name in sourceFiles}
metadata={'compiler_source_file_sha256':sourceHashes,'bootstrap_flags':['build','--profile','speed-four','optimization=speed','debug=false','codegen-units=4'],'root':str(root),'compiler':str(compiler),'compiler_source_path':str(originalCompiler),'compiler_sha256':hashlib.sha256(compiler.read_bytes()).hexdigest(),'revisions':revs,'rounds':args.rounds,'stdlib':str(silk/'stdlib'),'base_flags':['--progress','plain','--timings'],'adaptive_flag':'SILK_EXPERIMENT_ADAPTIVE_CACHE=1','SILK_CLANG':baseEnv['SILK_CLANG'],'llvm_sha256':hashlib.sha256(Path(baseEnv['SILK_CLANG']).read_bytes()).hexdigest(),'cpu_affinity':sorted(os.sched_getaffinity(0)),'cold_definition':'Entire workload build directory removed before each cold trial; OS page cache retained. Detached children fully reaped before next run. Exclusive flock held by harness wrapper.','lifecycle_edits':{'compiler':'ReleaseVersion.value bytes 0.0.0 -> 0.0.1 -> 0.0.2','harfrust':'append coarseExperimentEdit returning7; then change its result to8'},'rss_definition':'Maximum individual process RSS, including waited children; not simultaneous aggregate RSS.'}
(root/'metadata.json').write_text(json.dumps(metadata,indent=2));print(json.dumps(metadata),flush=True)
results=[];artifacts=root/'artifacts';artifacts.mkdir()
workloads=[('compiler',silk,silk,['--package','silk-compiler'],silk/'compiler/src/ReleaseVersion.silk','silk-compiler'),('harfrust',nonstd,nonstd/'fonts/shape/tools/cli',[],nonstd/'fonts/shape/tools/cli/src/options.silk','font-shape-cli')]
def measure(workload,source,cwd,flags,operation,enabled,roundno,state):
 env=dict(baseEnv)
 if enabled:env['SILK_EXPERIMENT_ADAPTIVE_CACHE']='1'
 command=[str(compiler),operation,*flags,'--stdlib',str(silk/'stdlib'),'--progress','plain','--timings']
 label=f'{operation}-{workload}-r{roundno}-{int(enabled)}-{state}';log=root/(label+'.log')
 row=b.measure(command,cwd,env,log)
 row.update(workload=workload,operation=operation,adaptive=enabled,round=roundno,state=state,command=command,tree_cpu_s=row['process_tree']['user_s']+row['process_tree']['sys_s'])
 assert row['exit_code']==0,(label,log.read_text()[-4000:])
 images=[x for x in (source/'build').rglob('semantic-*') if x.is_file() and re.fullmatch(r'semantic-[0-9a-f]+',x.name)]
 row['semantic_images']=len(images);row['history_markers']=len(list((source/'build').rglob('history-*')))
 results.append(row);(root/'results.json').write_text(json.dumps(results,indent=2))
 with (root/'results.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
 print(json.dumps(row),flush=True);return row
# Balanced AB/BA order within each workload, preserving identical source/output paths.
for operation in ['check','build']:
 for name,source,cwd,flags,leaf,artifactName in workloads:
  original=leaf.read_text();coldHashes={}
  for roundno in range(1,args.rounds+1):
   for enabled in ([False,True] if roundno%2 else [True,False]):
    leaf.write_text(original);shutil.rmtree(source/'build',ignore_errors=True)
    row=measure(name,source,cwd,flags,operation,enabled,roundno,'cold')
    if enabled:assert row['semantic_images']==0,('cold adaptive recorded fine image',row)
    if operation=='build':
     paths=[x for x in (source/'build').rglob(artifactName) if x.is_file()];assert len(paths)==1,paths
     saved=artifacts/f'{name}-r{roundno}-{int(enabled)}';shutil.copy2(paths[0],saved)
     digest=hashlib.sha256(saved.read_bytes()).hexdigest();coldHashes[enabled]=digest
     print(json.dumps({'artifact':str(saved),'sha256':digest,'workload':name,'round':roundno,'adaptive':enabled}),flush=True)
     (root/'artifact-hashes.json').write_text(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in artifacts.iterdir()},indent=2))
    if roundno==1:
     measure(name,source,cwd,flags,operation,enabled,roundno,'warm')
     for editno in [1,2]:
      if name=='compiler':leaf.write_text(original.replace('b"0.0.0"',f'b"0.0.{editno}"'))
      else:leaf.write_text(original+f'\npub fn coarseExperimentEdit() -> i32 {{ return {6+editno} }}\n')
      edited=measure(name,source,cwd,flags,operation,enabled,roundno,f'edit{editno}')
      if enabled:assert edited['semantic_images']>0,('edit failed to populate fine image',edited)
     measure(name,source,cwd,flags,operation,enabled,roundno,'edit2-warm')
     leaf.write_text(original)
   if operation=='build':assert coldHashes[False]==coldHashes[True],(name,roundno,coldHashes)
  leaf.write_text(original)
print('FINISHED',root,flush=True)
