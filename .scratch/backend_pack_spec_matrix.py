"""Same-binary compiler-build pack-size/speculation matrix; caller holds exclusive performance.lock."""
import argparse,hashlib,importlib.util,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
s=Path('/workspace/silk/.scratch')
spec=importlib.util.spec_from_file_location('b',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
p=argparse.ArgumentParser();p.add_argument('--candidate',type=Path,required=True);p.add_argument('--rounds',type=int,default=1)
p.add_argument('--packs',default='4,8,16');p.add_argument('--edits',action='store_true')
p.add_argument('--feature',action='append',default=[],help='Additional exact NAME=VALUE environment feature')
p.add_argument('--prepare-only',action='store_true');a=p.parse_args();os.sched_setaffinity(0,{0,1,2,3})
root=Path(tempfile.mkdtemp(prefix='backend-pack-spec-',dir=s/'benchmarks'));source=root/'silk'
revision=b.snapshot(Path('/workspace/silk-baseline'),source);compiler=a.candidate.resolve()
edited=source/'compiler/src/main.silk';original=edited.read_bytes();needle=b'Create a package or a workspace\\n';assert original.count(needle)==1
metadata={'compiler':str(compiler),'compiler_sha256':hashlib.sha256(compiler.read_bytes()).hexdigest(),'source_revision':revision,
 'profile':'default','packs_mib':a.packs.split(','),'features':a.feature,'rounds':a.rounds,'edits':a.edits,'cpus':[0,1,2,3],
 'note':'Each pack/spec configuration starts cold; optional edits follow directly, without an unchanged refill. All cache writers reaped.'}
(root/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n');print(json.dumps({'root':str(root),'metadata':metadata}),flush=True)
if a.prepare_only:raise SystemExit(0)
results=[];hashes={};saved_artifacts={};cache=source/'build'
try:
 for repeat in range(a.rounds):
  configs=[(pack,speculate) for pack in a.packs.split(',') for speculate in [False,True]]
  if repeat%2:configs.reverse()
  for pack,speculate in configs:
   edited.write_bytes(original);shutil.rmtree(cache,ignore_errors=True)
   env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_'))}
   env.update(SILK_CLANG=str(s/'llvm-22.1.8/bin/clang'),SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',
    SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1',SILK_RETAINED_BUILD='1',SILK_EXPERIMENT_DEV_PACKS='1',SILK_EXPERIMENT_PACK_MIB=pack)
   for feature in a.feature:
    name,separator,value=feature.partition('=');assert separator and name.startswith('SILK_');env[name]=value
   if speculate:env['SILK_FRONTIER_SPECULATIVE_EMISSION']='1'
   stages=['cold','first-edit','second-edit'] if a.edits else ['cold']
   for stage in stages:
    marker=None
    if stage!='cold':
     marker=b'revision one' if stage=='first-edit' else b'revision two'
     edited.write_bytes(original.replace(needle,b'Create a package or a workspace ('+marker+b')\\n'))
    tag=f'r{repeat}-pack{pack}-spec{int(speculate)}-{stage}';log=root/(tag+'.log')
    command=[str(compiler),'build','--package','silk-compiler','--stdlib',str(source/'stdlib'),'--progress','plain','--timings']
    result=dict(round=repeat,pack_mib=pack,speculation=speculate,stage=stage,command=command,
      environment={k:v for k,v in env.items() if k.startswith('SILK_')},**b.measure(command,source,env,log))
    trace=log.read_text();result.update(frontier_accepted='frontier accepted' in trace,artifact_accepted='artifact accepted' in trace,
     trace_summary=[line for line in trace.splitlines() if any(word in line for word in ['refused','failed','fallback','accepted','speculat'])][-25:])
    result['phase_seconds']={name:float(value)/(1000 if unit=='ms' else 1) for name,value,unit in re.findall(r'^\s+(load|check|codegen|link)\s.*?\s([\d.]+)(ms|s)\s*$',trace,re.M)}
    result['artifact_milestones_ms']={name:int(value) for name,value in re.findall(r'^frontier artifact (discovered|proved|emitted|accepted) ms=(\d+)',trace,re.M)}
    warmed=re.findall(r'^frontier speculative completed ms=\d+ a=(\d+) b=(\d+)',trace,re.M)
    work=re.findall(r'^frontier speculative work ms=(\d+) a=(\d+) b=(\d+)',trace,re.M)
    result['speculative_prepared']=sum(int(prepared) for prepared,used in warmed)
    result['speculative_used']=sum(int(used) for prepared,used in warmed)
    result['speculative_work_ms']=sum(int(milliseconds) for milliseconds,worker,attempts in work)
    result['speculative_attempts']=sum(int(attempts) for milliseconds,worker,attempts in work)
    binary=cache/'llvm/x86_64-unknown-linux-gnu/debug/silk-compiler'
    if result['exit_code']==0:
     result['binary_sha256']=hashlib.sha256(binary.read_bytes()).hexdigest()
     result['object_count']=len(list((cache/'llvm').rglob('*.o')))
     check=subprocess.run([str(binary),'--help'],capture_output=True);output=check.stdout+check.stderr
     result['help_exit_code']=check.returncode;result['edit_observed']=marker in output if marker else b'revision one' not in output and b'revision two' not in output
     digest=result['binary_sha256']
     if digest in saved_artifacts:os.link(saved_artifacts[digest],root/tag)
     else:
      shutil.copy2(binary,root/tag);saved_artifacts[digest]=root/tag
    results.append(result);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(result),flush=True)
    assert result['exit_code']==0 and all(x['exit_code']==0 for x in result['detached']),tag
    if stage=='cold':assert result['frontier_accepted'] and result['artifact_accepted'],tag+': rejected cold proof'
    if 'frontier split' in trace:assert result['frontier_accepted'],tag+': rejected parallel attempt'
    assert result['help_exit_code']==0 and result['edit_observed'],tag+': generated code did not reflect edit'
    key=(pack,stage)
    if key in hashes:assert hashes[key]==result['binary_sha256'],tag+': speculation/repetition changed identical-input artifact'
    else:hashes[key]=result['binary_sha256']
   shutil.rmtree(cache,ignore_errors=True)
finally:
 edited.write_bytes(original);shutil.rmtree(cache,ignore_errors=True)
print('COMPLETE '+str(root),flush=True)
