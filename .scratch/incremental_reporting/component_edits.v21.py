#!/usr/bin/env python3
"""Controlled source-revision comparison; identical runtime flags on both sides.

Exclusive lock owned here. No N0 baseline policy and no hidden cache priming.
The shared immediate supervisor owns and reaps every invocation's descendants.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import tempfile
import time

from immediate_edits import run_cohort, snapshot
from option_screen import screen_environment, sha, save, SCRATCH, REVISIONS


def common_environment(base, operation):
    env, pipeline, registry = screen_environment(base, 'registry', 'on', 'off', operation)
    assert pipeline and not registry and 'SILK_FRONTIER_REUSE_COMPLETED' not in env
    assert ('SILK_NATIVE_BUILD_PIPELINE' in env) == (operation == 'build')
    return env


def validate_trace(row, operation, cpus):
    trace = Path(row['log']).read_text()
    row.update(diagnostics=[line for line in trace.splitlines() if ': warning[' in line or ': error[' in line],
        frontier_attempted='frontier split' in trace, frontier_accepted='frontier accepted' in trace,
        artifact_accepted='frontier artifact accepted' in trace, host_capacity_refused='host capacity refused' in trace,
        pipeline_started='frontier native coordinator started' in trace,
        pipeline_published='frontier native objects published' in trace,
        pipeline_refused='frontier native coordinator refused' in trace,
        checkpoint_count=trace.count('frontier native cache checkpoint'),
        completion_count=trace.count('frontier native cache completed'))
    assert row['supervisor_affinity'] == cpus
    assert row['exit_code'] == 0 and all(child['exit_code'] == 0 for child in row['detached'])
    cold = row['stage'] == 'cold'
    parallel = len(cpus) == 4
    pool = any(row[key] for key in ('frontier_attempted', 'frontier_accepted', 'artifact_accepted'))
    if cold and parallel:
        assert row['frontier_accepted'], 'Cold frontier proof missing'
        if operation == 'build':
            assert row['artifact_accepted'], 'Cold artifact proof missing'
    else:
        assert not pool, 'Unexpected CPU0/warm worker pool'
    if cold and not parallel:
        assert row['host_capacity_refused'], 'CPU0 automatic refusal missing'
    pipeline = cold and parallel and operation == 'build'
    assert row['pipeline_started'] == pipeline and row['pipeline_published'] == pipeline
    assert not row['pipeline_refused']
    assert row['checkpoint_count'] == int(pipeline) and row['completion_count'] == int(pipeline)
    if pipeline:
        events = ['frontier native coordinator started', 'frontier native cache checkpoint',
                  'frontier native objects published', 'frontier native cache completed']
        offsets = [trace.index(event) for event in events]
        row['completion_ordered'] = offsets == sorted(offsets)
        assert row['completion_ordered']
    if parallel and operation == 'build' and row['stage'] == 'first-edit':
        row['live_prior_descendants'] = [child for child in row['prior_descendants_observed_before_launch'] if child['state'] != 'Z']
        assert not row['live_prior_descendants'], 'Cold writer survived completion barrier'


def report(root, cohorts, metadata):
    comparisons = []
    lines = ['# Source-component immediate edit control', '',
        f"Reference `{metadata['reference_label']}` → candidate `{metadata['candidate_label']}`; execution CPUs {metadata['cpus']}. Both compilers have matching producer, Clang, four-unit O2, no-PGO construction. Runtime flags are identical: ordinary retained/frontier/shared/private/chunk/build-packing features, build pipeline ON, completed registry OFF. This isolates the source component; it is not original N0 acceptance or a final 3× claim.", '',
        'Cold → first edit → second edit launches without prior writer settlement or unchanged priming. Settled intervals overlap and must not be added. Complete-cohort wall includes all commands and writers. Parent-reaped writer CPU is already included in primary wait4 usage. Small samples are directional evidence, not confidence estimates.', '',
        '| Operation / workload | Stage | Pairs | Foreground reference → candidate | Ratio | Settled reference → candidate | Ratio | Total CPU reference → candidate | Flag |',
        '|---|---|---:|---:|---:|---:|---:|---:|---|']
    for operation in metadata['operations']:
        for workload in metadata['workloads']:
            pairs = []
            for repeat in range(metadata['rounds']):
                pair = {c['mode']:c for c in cohorts if c['operation']==operation and c['workload']==workload and c['round']==repeat}
                if set(pair)=={'reference','candidate'} and all(c.get('validated') for c in pair.values()):
                    pairs.append(pair)
            if not pairs:
                continue
            for index, stage in enumerate(('cold', 'first-edit', 'second-edit')):
                rows = [(pair['reference']['invocations'][index], pair['candidate']['invocations'][index]) for pair in pairs]
                value = dict(operation=operation, workload=workload, stage=stage, pairs=len(pairs))
                for field in ('wall_s','settled_wall_s','edit_action_to_return_s','launch_gap_s'):
                    if all(field in left and field in right for left,right in rows):
                        value[field+'_reference'] = statistics.median(left[field] for left,right in rows)
                        value[field+'_candidate'] = statistics.median(right[field] for left,right in rows)
                        value[field+'_paired_ratios'] = [right[field]/left[field] for left,right in rows]
                        value[field+'_ratio'] = statistics.median(value[field+'_paired_ratios'])
                value['cpu_reference_s'] = statistics.median(left['process_tree']['user_s']+left['process_tree']['sys_s'] for left,right in rows)
                value['cpu_candidate_s'] = statistics.median(right['process_tree']['user_s']+right['process_tree']['sys_s'] for left,right in rows)
                value['regression'] = max(value['wall_s_ratio'],value['settled_wall_s_ratio'],value.get('edit_action_to_return_s_ratio',0)) > 1.05
                comparisons.append(value)
                lines.append(f"| {operation} / {workload} | {stage} | {len(pairs)} | {value['wall_s_reference']:.3f} → {value['wall_s_candidate']:.3f} s | {value['wall_s_ratio']:.3f} | {value['settled_wall_s_reference']:.3f} → {value['settled_wall_s_candidate']:.3f} s | {value['settled_wall_s_ratio']:.3f} | {value['cpu_reference_s']:.3f} → {value['cpu_candidate_s']:.3f} s | {'REGRESSION' if value['regression'] else ''} |")
            left = statistics.median(p['reference']['cohort_wall_s'] for p in pairs)
            right = statistics.median(p['candidate']['cohort_wall_s'] for p in pairs)
            ratio = statistics.median(p['candidate']['cohort_wall_s']/p['reference']['cohort_wall_s'] for p in pairs)
            comparisons.append(dict(operation=operation,workload=workload,stage='complete-cohort',pairs=len(pairs),wall_s_reference=left,wall_s_candidate=right,wall_s_ratio=ratio))
            lines.append(f'| {operation} / {workload} | complete cohort | {len(pairs)} | {left:.3f} → {right:.3f} s | {ratio:.3f} | — | — | — | |')
    lines += ['', 'Exact source-mutation/launch/return timestamps, actual gaps, prior-writer liveness, per-invocation CPU/descendants, ordered diagnostics, artifact hashes and stage markers remain in results.json. Every cohort fully settles before validation, cleanup or disk guard. Unchanged runs are intentionally deferred; no unchanged invocation primes an edit.']
    save(root/'comparisons.json',comparisons)
    (root/'component-report.md').write_text('\n'.join(lines)+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pins',type=Path,required=True)
    parser.add_argument('--cpus',choices=['0','0,1,2,3'],required=True)
    parser.add_argument('--rounds',type=int,default=2)
    parser.add_argument('--operations',default='check,build')
    parser.add_argument('--workloads',default='compiler,harfrust')
    parser.add_argument('--minimum-free-mib',type=int,default=1536)
    parser.add_argument('--resume',type=Path)
    args=parser.parse_args();assert args.rounds>=1
    operations=args.operations.split(',');workloads=args.workloads.split(',')
    assert operations and len(set(operations))==len(operations) and set(operations)<={'check','build'}
    assert workloads and len(set(workloads))==len(workloads) and set(workloads)<={'compiler','harfrust'}
    cpus=list(map(int,args.cpus.split(',')));os.sched_setaffinity(0,set(cpus))
    pins=json.loads(args.pins.read_text());assert set(pins)=={'reference','candidate'}
    with (SCRATCH/'performance.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        construction={}
        for mode,pin in pins.items():
            assert sha(Path(pin['binary']))==pin['sha256']
            construction[mode]=json.loads(Path(pin['construction']).read_text())
            assert construction[mode]['source']==pin['source'] and construction[mode]['sha256']==pin['sha256']
        for key in ('builder_sha256','clang_sha256','optimization','debug','codegen_units','profile_use'):
            assert construction['reference'][key]==construction['candidate'][key],('Construction mismatch',key)
        assert construction['reference']['codegen_units']==4 and construction['reference']['profile_use'] is None
        assert shutil.disk_usage(SCRATCH).free>=args.minimum_free_mib*1048576,'Insufficient disk before snapshot'
        metadata=dict(pins=pins,reference_label=pins['reference']['label'],candidate_label=pins['candidate']['label'],
            operations=operations,workloads=workloads,rounds=args.rounds,cpus=cpus,revisions=REVISIONS,
            pipeline='on',registry='off',delay_ms=0,harness_sha256=sha(Path(__file__)),
            supervisor_sha256=sha(Path(__file__).with_name('immediate_edits.py')),
            environment_builder_sha256=sha(Path(__file__).with_name('option_screen.py')),
            lane_sha256=sha(Path(__file__).with_name('lane.py')),
            environments={op:common_environment(os.environ,op) for op in operations})
        # Metadata records only Silk policy, not unrelated inherited credentials.
        metadata['environments']={op:{k:v for k,v in env.items() if k.startswith('SILK_')} for op,env in metadata['environments'].items()}
        if args.resume:
            root=args.resume.resolve();assert root.parent==(SCRATCH/'benchmarks').resolve()
            assert not (root/'restored.json').exists()
            previous=json.loads((root/'metadata.json').read_text())
            assert all(previous[k]==v for k,v in metadata.items()),'Resume pins/settings changed'
            aborted=json.loads((root/'aborted.json').read_text())
            assert aborted['error']=="AssertionError('Insufficient disk before cohort; no compiler/writer active')"
            cohorts=json.loads((root/'results.json').read_text())
            assert all(c.get('validated') and c['all_supervisors_reaped'] and c.get('cleaned') for c in cohorts)
            for name,repo,mainpath in [('silk','/workspace/silk-baseline','compiler/src/main.silk'),('nonstd','/workspace/nonstd','fonts/shape/tools/cli/src/main.silk')]:
                assert not (root/name/'build').exists()
                assert (root/name/mainpath).read_bytes()==subprocess.check_output(['git','show',REVISIONS[name]+':'+mainpath],cwd=repo)
            metadata=previous
            metadata.setdefault('resumes',[]).append(dict(monotonic_ns=time.monotonic_ns(),completed_cohorts=len(cohorts),prior_refusal=aborted))
        else:
            root=Path(tempfile.mkdtemp(prefix='component-edits-',dir=SCRATCH/'benchmarks'))
            revisions={name:snapshot(Path(repo),root/name) for name,repo in [('silk','/workspace/silk-baseline'),('nonstd','/workspace/nonstd')]}
            assert revisions==REVISIONS;cohorts=[]
        save(root/'metadata.json',metadata);save(root/'construction.json',construction);save(root/'results.json',cohorts)
        print(json.dumps(dict(root=str(root),metadata=metadata)),flush=True)
        paired={};completed=set();context={}
        for c in cohorts:
            completed.add((c['operation'],c['workload'],c['round'],c['mode']))
            for row in c['invocations']:paired[(c['operation'],c['workload'],c['round'],row['stage'])]=row
        try:
            for operation in operations:
                for workload in workloads:
                    source=root/('silk' if workload=='compiler' else 'nonstd')
                    cwd=source if workload=='compiler' else source/'fonts/shape/tools/cli'
                    edited=source/'compiler/src/main.silk' if workload=='compiler' else cwd/'src/main.silk'
                    original=edited.read_bytes();cache=source/'build'
                    needle=b'Create a package or a workspace\\n' if workload=='compiler' else b'Usage: hr_shape FONT TEXT'
                    replacements=[b'Create a package or a workspace (revision one)\\n',b'Create a package or a workspace (revision two)\\n'] if workload=='compiler' else [b'Usage: hr_shape FONT TEXT (revision one)',b'Usage: hr_shape FONT TEXT (revision two)']
                    assert original.count(needle)==1
                    variants=[original,*(original.replace(needle,value) for value in replacements)]
                    output=cache/'llvm/x86_64-unknown-linux-gnu/debug'/('silk-compiler' if workload=='compiler' else 'font-shape-cli') if operation=='build' else None
                    for repeat in range(args.rounds):
                        for mode in (('reference','candidate') if repeat%2==0 else ('candidate','reference')):
                            if (operation,workload,repeat,mode) in completed:continue
                            context=dict(operation=operation,workload=workload,round=repeat,mode=mode)
                            assert shutil.disk_usage(SCRATCH).free>=args.minimum_free_mib*1048576,'Insufficient disk before cohort; no compiler/writer active'
                            assert not cache.is_symlink();shutil.rmtree(cache,ignore_errors=True);edited.write_bytes(original)
                            env=common_environment(os.environ,operation)
                            assert {k:v for k,v in env.items() if k.startswith('SILK_')}==metadata['environments'][operation]
                            command=[pins[mode]['binary'],operation]+(['--package','silk-compiler'] if workload=='compiler' else [])+['--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings']
                            tag=f'{operation}-{workload}-{repeat}-{mode}'
                            cohort=run_cohort(command,cwd,env,edited,variants,root,tag,output,0)
                            cohort.update(**context,command=command,environment=metadata['environments'][operation],cpus=cpus)
                            cohorts.append(cohort);save(root/'results.json',cohorts)
                            assert not cohort['failure'] and cohort['all_supervisors_reaped']
                            assert len(cohort['invocations'])==3 and all(code==0 for code in cohort['supervisor_exit_codes'])
                            for row in cohort['invocations']:
                                validate_trace(row,operation,cpus)
                                if output is not None:
                                    artifact=Path(row['retained_artifact']);row['artifact_sha256']=sha(artifact)
                                    smoke=subprocess.run([str(artifact),'--help'],capture_output=True)
                                    helptext=smoke.stdout+smoke.stderr
                                    marker=None if row['stage']=='cold' else b'revision one' if row['stage']=='first-edit' else b'revision two'
                                    row['help_exit_code']=smoke.returncode
                                    row['edit_observed']=marker in helptext if marker else b'revision one' not in helptext and b'revision two' not in helptext
                                    (root/f'{tag}-{row["stage"]}.help').write_bytes(helptext)
                                    assert row['help_exit_code']==0 and row['edit_observed']
                                key=(operation,workload,repeat,row['stage'])
                                if key in paired:
                                    assert row['diagnostics']==paired[key]['diagnostics'],(tag,'Ordered diagnostics differ')
                                    assert row['source_sha256']==paired[key]['source_sha256']
                                    if output is not None:assert row['artifact_sha256']==paired[key]['artifact_sha256'],(tag,'Artifacts differ')
                                else:paired[key]=row
                            cohort['validated']=True
                            cohort['cache_bytes_after_all_writers']=sum(f.stat().st_size for f in cache.rglob('*') if f.is_file()) if cache.exists() else 0
                            save(root/'results.json',cohorts);report(root,cohorts,metadata);print(json.dumps(cohort),flush=True)
                            for row in cohort['invocations']:
                                if output is not None:Path(row['retained_artifact']).unlink();row['artifact_pruned_after_validation']=True
                            edited.write_bytes(original);shutil.rmtree(cache,ignore_errors=True)
                            cohort['cleaned']=True;save(root/'results.json',cohorts)
            save(root/'restored.json',dict(sources_restored=True,all_writers_reaped=True))
        except BaseException as error:
            if 'original' in locals():(root/'original-source.bin').write_bytes(original)
            save(root/'aborted.json',dict(context=context,error=repr(error),source_and_cache_preserved=True))
            raise
        print('COMPLETE '+str(root),flush=True)


if __name__=='__main__':main()
