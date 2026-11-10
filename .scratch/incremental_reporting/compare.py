"""Original-baseline versus parallel-policy incremental trials; caller holds exclusive performance.lock."""
import argparse, hashlib, importlib.util, json, os, shutil, subprocess, tempfile, time
from pathlib import Path
from lane import cpus as parse_cpus, identity as cpu_identity, candidate_environment, expect_no_pool, POLICIES

scratch=Path('/workspace/silk/.scratch')
spec=importlib.util.spec_from_file_location('cold',scratch/'benchmarks/cold_bench.py')
bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
p=argparse.ArgumentParser()
p.add_argument('--candidate',type=Path,required=True)
p.add_argument('--candidate-source-revision',required=True,help='Frozen source revision used to produce candidate binary')
p.add_argument('--baseline-source-revision',default='a63f612150a0b91a118c8111b910b12c3e124b50')
p.add_argument('--baseline',type=Path,default=scratch/'N0-one')
p.add_argument('--modes',default='baseline,cached,ephemeral')
p.add_argument('--operations',default='check,build')
p.add_argument('--workloads',default='compiler,harfrust')
p.add_argument('--sequences',default='edits,unchanged',help='edits=cold→first-edit→second-edit; unchanged=cold→unchanged; primed-edits=cold→unchanged→first-edit→second-edit')
p.add_argument('--rounds',type=int,default=1)
p.add_argument('--cpus',default='0,1,2,3',help='Inherited process-tree affinity, e.g. 0 or 0,1,2,3; unrelated to codegen units')
p.add_argument('--worker-policy',choices=POLICIES,default='parallel',help='parallel=prototype opt-in; serial=same switches with frontier opt-in unset; default=no injected worker/backend switches')
p.add_argument('--require-host-capacity-refusal',action='store_true',help='Opt-in one-core host-policy validation: cold must report capacity refusal and never start a pool')
p.add_argument('--feature',action='append',default=[])
p.add_argument('--prepare-only',action='store_true')
p.add_argument('--minimum-free-mib',type=int,default=1024,help='Environmental free-space guard before snapshot and every compiler invocation')
p.add_argument('--wait-for-disk',action='store_true',help='Pause only between invocations for external cleanup, preserving cache/source; waiting is outside measured time')
p.add_argument('--first-edit-regression-limit',type=float,default=1.5,help='Stop on a first direct edit of either operation/workload if candidate exceeds same-round baseline by this ratio; zero disables')
p.add_argument('--allow-fallback',action='store_true',help='Keep measuring after a rejected parallel proof; always label it')
a=p.parse_args();assert a.rounds>0
assert set(a.operations.split(',')) <= {'check','build'}
assert set(a.workloads.split(',')) <= {'compiler','harfrust'}
assert set(a.sequences.split(',')) <= {'edits','unchanged','primed-edits'}
selected_cpus=parse_cpus(a.cpus)
os.sched_setaffinity(0,set(selected_cpus))
assert sorted(os.sched_getaffinity(0))==selected_cpus
cpu_lane=cpu_identity(selected_cpus)
if a.require_host_capacity_refusal:assert len(selected_cpus)==1 and a.worker_policy=='parallel'
initial_free=shutil.disk_usage(scratch).free
if initial_free < a.minimum_free_mib*1024*1024:
 raise SystemExit(f'Environmental preflight refusal: {initial_free//(1024*1024)} MiB free; require {a.minimum_free_mib} MiB. No compiler executed.')
root=Path(tempfile.mkdtemp(prefix='integrated-incremental-',dir=scratch/'benchmarks'))
revisions={'silk':bench.snapshot(Path('/workspace/silk-baseline'),root/'silk'),
 'nonstd':bench.snapshot(Path('/workspace/nonstd'),root/'nonstd')}
assert revisions=={'silk':'a63f612150a0b91a118c8111b910b12c3e124b50','nonstd':'ccb168b773bb56d7bd60a3495141d427149766d0'},revisions
binaries={'baseline':a.baseline.resolve(),'cached':a.candidate.resolve(),'ephemeral':a.candidate.resolve(),
 'candidate':a.candidate.resolve(),'cached-whole':a.candidate.resolve(),'ephemeral-whole':a.candidate.resolve()}
modes=a.modes.split(',');assert all(m in binaries for m in modes)
stages={'unchanged':['cold','unchanged'],'edits':['cold','first-edit','second-edit'],'primed-edits':['cold','unchanged','first-edit','second-edit']}
features=dict(item.split('=',1) for item in a.feature)
assert all(k.startswith('SILK_') for k in features)
metadata={'revisions':revisions,'binaries':{m:{'path':str(binaries[m]),'sha256':hashlib.sha256(binaries[m].read_bytes()).hexdigest(),'source_revision':a.baseline_source_revision if m=='baseline' else a.candidate_source_revision} for m in modes},
 'requested':{'modes':modes,'operations':a.operations.split(','),'workloads':a.workloads.split(','),'sequences':a.sequences.split(',')},'features':features,'harness_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
 'disk_preflight':{'initial_free_bytes':initial_free,'minimum_free_mib':a.minimum_free_mib,'wait_for_disk':a.wait_for_disk},
 'rounds':a.rounds,'cpus':selected_cpus,'cpu_lane':cpu_lane,'worker_policy':a.worker_policy,
 'affinity_note':'Affinity is set on the harness before spawning; compiler, threads, native tools and cache writers inherit it. This is execution CPU capacity, not compiler construction codegen-unit count.',
 'require_host_capacity_refusal':a.require_host_capacity_refusal,'profile':'default','stages':stages,
 'note':'Each sequence starts with empty cache and restored sources. Only primed-edits has an unchanged run before first edit; never combine it with direct edits. All detached writers reaped.',
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
  completed_workload=False
  try:
   for sequence in a.sequences.split(','):
    for repeat in range(a.rounds):
     ordered=modes if repeat%2==0 else list(reversed(modes))
     for mode in ordered:
      edited.write_bytes(original);assert not cache.is_symlink();shutil.rmtree(cache,ignore_errors=True)
      env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_'))}
      env['SILK_CLANG']=str(scratch/'llvm-22.1.8/bin/clang')
      if mode!='baseline':
       env=candidate_environment(env,features,a.worker_policy,mode,operation)
      command=[str(binaries[mode]),operation]+(['--package','silk-compiler'] if workload=='compiler' else [])+['--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings']
      for stage in stages[sequence]:
       free=shutil.disk_usage(scratch).free
       if free < a.minimum_free_mib*1024*1024:
        refusal=dict(reason='Environmental preflight refusal; no compiler executed for this stage',operation=operation,workload=workload,mode=mode,stage=stage,free_bytes=free,minimum_free_mib=a.minimum_free_mib)
        if not a.wait_for_disk:
         (root/'environmental-abort.json').write_text(json.dumps(refusal,indent=2)+'\n');print(json.dumps(refusal),flush=True)
         raise SystemExit('Stopped before next invocation: disk space below environmental threshold')
        refusal['reason']='DISK_PAUSED before invocation; no compiler/writer active; cache and source retained'
        (root/'disk-pause.json').write_text(json.dumps(refusal,indent=2)+'\n');print(json.dumps(refusal),flush=True)
        while shutil.disk_usage(scratch).free < a.minimum_free_mib*1024*1024:time.sleep(1)
        resumed={**refusal,'reason':'DISK_RESUMED before invocation','free_bytes':shutil.disk_usage(scratch).free}
        with (root/'disk-resumes.jsonl').open('a') as receipt:receipt.write(json.dumps(resumed)+'\n')
        (root/'disk-pause.json').unlink();print(json.dumps(resumed),flush=True)
       if stage in ['first-edit','second-edit']:edited.write_bytes(original.replace(needle,additions[0 if stage=='first-edit' else 1]))
       tag=f'{operation}-{workload}-{sequence}-{repeat}-{mode}-{stage}';log=root/(tag+'.log')
       result=dict(cpu_lane=cpu_lane,cpus=selected_cpus,worker_policy=a.worker_policy,operation=operation,workload=workload,sequence=sequence,round=repeat,mode=mode,stage=stage,command=command,
        environment={k:v for k,v in env.items() if k.startswith('SILK_')},source_sha256=hashlib.sha256(edited.read_bytes()).hexdigest(),
        **bench.measure(command,cwd,env,log))
       trace=log.read_text();result['writer_tail_s']=result['settled_wall_s']-result['wall_s']
       result['cache_bytes']=sum(f.stat().st_size for f in (cache/'cache').rglob('*') if f.is_file()) if (cache/'cache').exists() else 0
       result['diagnostic_lines']=[line for line in trace.splitlines() if ': warning[' in line or ': error[' in line]
       result['edit_marker_present']=b'revision one' in edited.read_bytes() if stage=='first-edit' else b'revision two' in edited.read_bytes() if stage=='second-edit' else b'revision one' not in edited.read_bytes() and b'revision two' not in edited.read_bytes()
       result.update(frontier_accepted='frontier accepted' in trace,artifact_accepted='artifact accepted' in trace,
        whole_hit='whole-check hit' in trace,frontier_attempted='frontier split' in trace)
       result['host_capacity_refused']='host capacity refused' in trace
       result['no_pool_expected']=mode!='baseline' and (expect_no_pool(a.worker_policy,selected_cpus) or a.require_host_capacity_refusal)
       result['no_pool_verified']=not result['frontier_attempted'] and not result['frontier_accepted'] and not result['artifact_accepted']
       result['frontier_fallback']=result['frontier_attempted'] and not result['frontier_accepted']
       result['trace_summary']=[line for line in trace.splitlines() if any(word in line for word in ['refused','missing','failed','fallback','accepted'])][-20:]
       if operation=='build' and result['exit_code']==0:
        binary=cache/'llvm/x86_64-unknown-linux-gnu/debug'/('silk-compiler' if workload=='compiler' else 'font-shape-cli')
        result['binary_sha256']=hashlib.sha256(binary.read_bytes()).hexdigest()
        units=binary.with_name(binary.name+'.units')
        artifacts=[binary]+(sorted(f for f in units.rglob('*') if f.is_file()) if units.exists() else [])
        manifest=[{'path':str(f.relative_to(binary.parent)),'bytes':f.stat().st_size,'sha256':hashlib.file_digest(f.open('rb'),'sha256').hexdigest()} for f in artifacts]
        manifest_path=root/(tag+'.artifacts.json');manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
        result['artifact_manifest']=str(manifest_path);result['artifact_manifest_sha256']=hashlib.sha256(manifest_path.read_bytes()).hexdigest()

        smoke=subprocess.run([str(binary),'--help'],capture_output=True)
        helptext=smoke.stdout+smoke.stderr
        marker=b'revision one' if stage=='first-edit' else b'revision two' if stage=='second-edit' else None
        result['help_exit_code']=smoke.returncode;result['edit_observed']=marker in helptext if marker else b'revision one' not in helptext and b'revision two' not in helptext
        (root/(tag+'.help')).write_bytes(helptext)
       results.append(result);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n')
       print(json.dumps(result),flush=True)
       if sequence=='edits' and repeat==0 and mode!='baseline' and stage=='first-edit':
        paired=next((r for r in results if r['mode']=='baseline' and r['operation']==operation and r['workload']==workload and r['sequence']==sequence and r['round']==repeat and r['stage']==stage),None)
        if paired:
         ratio=result['wall_s']/paired['wall_s'];settled_ratio=result['settled_wall_s']/paired['settled_wall_s']
         checkpoint=dict(event='FIRST_DIRECT_EDIT_CHECKPOINT',cpu_lane=cpu_lane,worker_policy=a.worker_policy,operation=operation,workload=workload,mode=mode,baseline_s=paired['wall_s'],candidate_s=result['wall_s'],candidate_over_baseline=ratio,settled_candidate_over_baseline=settled_ratio)
         (root/(operation+'-'+workload+'-first-edit-checkpoint.json')).write_text(json.dumps(checkpoint,indent=2)+'\n');print(json.dumps(checkpoint),flush=True)
         if a.first_edit_regression_limit and max(ratio,settled_ratio)>a.first_edit_regression_limit:
          subprocess.run(['python3',str(Path(__file__).with_name('report.py')),str(root)],check=True)
          raise SystemExit('Stopped before remaining workloads: first direct edit exceeds configured baseline-relative regression limit')
       if result['no_pool_expected']:assert result['no_pool_verified'],tag+': worker pool started despite serial/default-one-core policy'
       if a.require_host_capacity_refusal and mode!='baseline' and stage=='cold':assert result['host_capacity_refused'],tag+': no host capacity refusal evidence'
       assert result['edit_marker_present'],tag+': wrong source revision marker'
       assert result['exit_code']==0 and all(d['exit_code']==0 for d in result['detached']),tag
       assert a.allow_fallback or not result['frontier_fallback'],tag+': parallel proof fell back; inspect trace_summary before continuing'
       if operation=='build':assert result['help_exit_code']==0 and result['edit_observed'],tag+': compiled edit not observed'
       if operation=='build' and mode!='baseline':
        artifact_key=(workload,result['source_sha256'])
        if artifact_key in candidate_artifacts:assert candidate_artifacts[artifact_key]==result['binary_sha256'],tag+': identical candidate inputs produced a different artifact'
        else:candidate_artifacts[artifact_key]=result['binary_sha256']
      shutil.rmtree(cache,ignore_errors=True)
   completed_workload=True
  finally:
   if completed_workload:
    edited.write_bytes(original);shutil.rmtree(cache,ignore_errors=True)
   else:
    (root/(operation+'-'+workload+'-original-source.bin')).write_bytes(original)
    (root/'aborted.json').write_text(json.dumps({'operation':operation,'workload':workload,'source':str(edited),'cache':str(cache),'edited_state_preserved':True})+'\n')
(root/'restored.json').write_text(json.dumps({'sources_restored':True})+'\n')
subprocess.run(['python3',str(Path(__file__).with_name('report.py')),str(root)],check=True)
print('COMPLETE '+str(root),flush=True)
