"""Original-baseline versus parallel-policy incremental trials; caller holds exclusive performance.lock."""
import argparse, hashlib, importlib.util, json, os, shutil, subprocess, tempfile
from pathlib import Path

scratch=Path('/workspace/silk/.scratch')
spec=importlib.util.spec_from_file_location('cold',scratch/'benchmarks/cold_bench.py')
bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
p=argparse.ArgumentParser()
p.add_argument('--candidate',type=Path,required=True)
p.add_argument('--baseline',type=Path,default=scratch/'N0-one')
p.add_argument('--modes',default='baseline,cached,ephemeral')
p.add_argument('--operations',default='check,build')
p.add_argument('--workloads',default='compiler,harfrust')
p.add_argument('--sequences',default='edits,unchanged')
p.add_argument('--rounds',type=int,default=1)
p.add_argument('--feature',action='append',default=[])
p.add_argument('--prepare-only',action='store_true')
p.add_argument('--allow-fallback',action='store_true',help='Keep measuring after a rejected parallel proof; always label it')
a=p.parse_args();os.sched_setaffinity(0,{0,1,2,3})
root=Path(tempfile.mkdtemp(prefix='integrated-incremental-',dir=scratch/'benchmarks'))
revisions={'silk':bench.snapshot(Path('/workspace/silk-baseline'),root/'silk'),
 'nonstd':bench.snapshot(Path('/workspace/nonstd'),root/'nonstd')}
assert revisions=={'silk':'a63f612150a0b91a118c8111b910b12c3e124b50','nonstd':'ccb168b773bb56d7bd60a3495141d427149766d0'},revisions
binaries={'baseline':a.baseline.resolve(),'cached':a.candidate.resolve(),'ephemeral':a.candidate.resolve(),
 'cached-whole':a.candidate.resolve(),'ephemeral-whole':a.candidate.resolve()}
modes=a.modes.split(',');assert all(m in binaries for m in modes)
stages={'unchanged':['cold','unchanged'],'edits':['cold','first-edit','second-edit']}
metadata={'revisions':revisions,'binaries':{m:{'path':str(binaries[m]),'sha256':hashlib.sha256(binaries[m].read_bytes()).hexdigest()} for m in modes},
 'rounds':a.rounds,'cpus':sorted(os.sched_getaffinity(0)),'profile':'default','stages':stages,
 'note':'Each sequence starts with empty cache and restored original sources. No unchanged run precedes first edit. All detached writers reaped.',
 'edit':'Change reachable help text in one existing function body; second edit changes only revision-one to revision-two text.',
 'memory':'Peak individual-process RSS, not aggregate concurrent memory.'}
(root/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
print(json.dumps({'root':str(root),'metadata':metadata}),flush=True)
if a.prepare_only:raise SystemExit(0)
results=[];candidate_artifacts={}
for operation in a.operations.split(','):
 for workload in a.workloads.split(','):
  source=root/('silk' if workload=='compiler' else 'nonstd');cache=source/'build'
  cwd=source if workload=='compiler' else source/'fonts/shape/tools/cli'
  edited=source/'compiler/src/main.silk' if workload=='compiler' else cwd/'src/main.silk'
  original=edited.read_bytes()
  needle=b'Create a package or a workspace\\n' if workload=='compiler' else b'Usage: hr_shape FONT TEXT'
  assert original.count(needle)==1,(edited,needle)
  additions=[b'Create a package or a workspace (revision one)\\n',b'Create a package or a workspace (revision two)\\n'] if workload=='compiler' else [b'Usage: hr_shape FONT TEXT (revision one)',b'Usage: hr_shape FONT TEXT (revision two)']
  try:
   for sequence in a.sequences.split(','):
    for repeat in range(a.rounds):
     ordered=modes if repeat%2==0 else list(reversed(modes))
     for mode in ordered:
      edited.write_bytes(original);assert not cache.is_symlink();shutil.rmtree(cache,ignore_errors=True)
      env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_'))}
      env['SILK_CLANG']=str(scratch/'llvm-22.1.8/bin/clang')
      if mode!='baseline':
       env.update(dict(item.split('=',1) for item in a.feature))
       env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1')
       if mode.startswith('ephemeral'):env['SILK_FRONTIER_EPHEMERAL']='1'
       if mode.endswith('-whole'):env['SILK_EXPERIMENT_WHOLE_CHECK']='1'
       if operation=='build':env.update(SILK_RETAINED_BUILD='1',SILK_EXPERIMENT_DEV_PACKS='1')
      command=[str(binaries[mode]),operation]+(['--package','silk-compiler'] if workload=='compiler' else [])+['--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings']
      for stage in stages[sequence]:
       if stage in ['first-edit','second-edit']:edited.write_bytes(original.replace(needle,additions[0 if stage=='first-edit' else 1]))
       tag=f'{operation}-{workload}-{sequence}-{repeat}-{mode}-{stage}';log=root/(tag+'.log')
       result=dict(operation=operation,workload=workload,sequence=sequence,round=repeat,mode=mode,stage=stage,command=command,
        environment={k:v for k,v in env.items() if k.startswith('SILK_')},source_sha256=hashlib.sha256(edited.read_bytes()).hexdigest(),
        **bench.measure(command,cwd,env,log))
       trace=log.read_text();result.update(frontier_accepted='frontier accepted' in trace,artifact_accepted='artifact accepted' in trace,
        whole_hit='whole-check hit' in trace,frontier_attempted='frontier split' in trace)
       result['frontier_fallback']=result['frontier_attempted'] and not result['frontier_accepted']
       result['trace_summary']=[line for line in trace.splitlines() if any(word in line for word in ['refused','missing','failed','fallback','accepted'])][-20:]
       if operation=='build' and result['exit_code']==0:
        binary=cache/'llvm/x86_64-unknown-linux-gnu/debug'/('silk-compiler' if workload=='compiler' else 'font-shape-cli')
        result['binary_sha256']=hashlib.sha256(binary.read_bytes()).hexdigest()
        smoke=subprocess.run([str(binary),'--help'],capture_output=True)
        helptext=smoke.stdout+smoke.stderr
        marker=b'revision one' if stage=='first-edit' else b'revision two' if stage=='second-edit' else None
        result['help_exit_code']=smoke.returncode;result['edit_observed']=marker in helptext if marker else b'revision one' not in helptext and b'revision two' not in helptext
        (root/(tag+'.help')).write_bytes(helptext)
       results.append(result);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n')
       print(json.dumps(result),flush=True)
       assert result['exit_code']==0 and all(d['exit_code']==0 for d in result['detached']),tag
       assert a.allow_fallback or not result['frontier_fallback'],tag+': parallel proof fell back; inspect trace_summary before continuing'
       if operation=='build':assert result['help_exit_code']==0 and result['edit_observed'],tag+': compiled edit not observed'
       if operation=='build' and mode!='baseline':
        artifact_key=(workload,result['source_sha256'])
        if artifact_key in candidate_artifacts:assert candidate_artifacts[artifact_key]==result['binary_sha256'],tag+': identical candidate inputs produced a different artifact'
        else:candidate_artifacts[artifact_key]=result['binary_sha256']
      shutil.rmtree(cache,ignore_errors=True)
  finally:
   edited.write_bytes(original);shutil.rmtree(cache,ignore_errors=True)
(root/'restored.json').write_text(json.dumps({'sources_restored':True})+'\n')
print('COMPLETE '+str(root),flush=True)
