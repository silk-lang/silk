#!/usr/bin/env python3
"""Same-binary immediate pipeline causality control; registry OFF in both modes.

Owns exclusive performance.lock. Uses immediate_edits.run_cohort unchanged; each
command has its own subreaper and the next edit begins before prior writers settle.
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


def report(root, cohorts):
    comparisons=[]
    for workload in ('compiler','harfrust'):
        pairs=[]
        rounds=sorted({c['round'] for c in cohorts if c['workload']==workload})
        for repeat in rounds:
            pair={c['mode']:c for c in cohorts if c['workload']==workload and c['round']==repeat and not c['failure']}
            if set(pair)=={'off','on'}:pairs.append(pair)
        if not pairs:continue
        for ordinal,stage in enumerate(('cold','first-edit','second-edit')):
            selected=[(p['off']['invocations'][ordinal],p['on']['invocations'][ordinal]) for p in pairs]
            row=dict(workload=workload,stage=stage,pairs=len(selected))
            for field in ('wall_s','settled_wall_s','edit_action_to_return_s','launch_gap_s'):
                if all(field in off and field in on for off,on in selected):
                    row[field+'_off']=statistics.median(off[field] for off,on in selected)
                    row[field+'_on']=statistics.median(on[field] for off,on in selected)
                    row[field+'_paired_ratios']=[on[field]/off[field] for off,on in selected]
                    row[field+'_on_over_off']=statistics.median(row[field+'_paired_ratios'])
            row['cpu_off_s']=statistics.median(off['process_tree']['user_s']+off['process_tree']['sys_s'] for off,on in selected)
            row['cpu_on_s']=statistics.median(on['process_tree']['user_s']+on['process_tree']['sys_s'] for off,on in selected)
            row['regression']=stage!='cold' and max(row[field+'_on_over_off'] for field in ('wall_s','settled_wall_s','edit_action_to_return_s'))>1.05
            comparisons.append(row)
        comparisons.append(dict(workload=workload,stage='complete-cohort',pairs=len(pairs),
            wall_s_off=statistics.median(p['off']['cohort_wall_s'] for p in pairs),
            wall_s_on=statistics.median(p['on']['cohort_wall_s'] for p in pairs),
            wall_s_on_over_off=statistics.median(p['on']['cohort_wall_s']/p['off']['cohort_wall_s'] for p in pairs),
            wall_s_paired_ratios=[p['on']['cohort_wall_s']/p['off']['cohort_wall_s'] for p in pairs],regression=False))
    save(root/'comparisons.json',comparisons)
    metadata=json.loads((root/'metadata.json').read_text())
    construction=json.loads((root/'candidate-construction.json').read_text())
    diagnostic=construction.get('codegen_units')==4 and construction.get('profile_use') is None
    lines=['# Immediate pipeline OFF/ON causality control','',
           'Same frozen binary and four execution cores. Both modes retain the full parallel frontier/cache/packing policy; registry is OFF in both. Only SILK_NATIVE_BUILD_PIPELINE differs. Two rounds reverse OFF/ON order. There is no unchanged priming and no wait for a prior writer before either edit. Artifact hashes and ordered diagnostics must agree for every same-input pair.','',
           'Times are paired medians; on/off >1 is slower. Settled intervals of different invocations overlap and must not be added. Complete-cohort elapsed includes all three commands and every writer. Small samples do not establish statistical significance.','',
           '| Workload | Stage | Pairs | Foreground off → on | On/off | Settled off → on | On/off | Edit action → return off → on | On/off | Flag |',
           '|---|---|---:|---:|---:|---:|---:|---:|---:|---|']
    for row in comparisons:
        settled=f"{row['settled_wall_s_off']:.3f}s → {row['settled_wall_s_on']:.3f}s | {row['settled_wall_s_on_over_off']:.3f}" if 'settled_wall_s_off' in row else '— | —'
        action=f"{row['edit_action_to_return_s_off']:.3f}s → {row['edit_action_to_return_s_on']:.3f}s | {row['edit_action_to_return_s_on_over_off']:.3f}" if 'edit_action_to_return_s_off' in row else '— | —'
        lines.append(f"| {row['workload']} | {row['stage']} | {row['pairs']} | {row['wall_s_off']:.3f}s → {row['wall_s_on']:.3f}s | {row['wall_s_on_over_off']:.3f} | {settled} | {action} | {'REGRESSION' if row['regression'] else ''} |")
    lines+=['','Actual launch gaps, source-mutation duration, one-shot non-zombie prior-descendant observations, exact timestamp envelopes, command/writer CPU, supervisor identities and complete artifact/diagnostic checks are retained in results.json. This screen isolates pipeline cost; it is not an original-baseline speedup claim.']
    if metadata.get('require_completion'):
        observed=sum(len(row['detached']) for cohort in cohorts for row in cohort['invocations'])
        acknowledged=sum(row.get('completion_count',0) for cohort in cohorts for row in cohort['invocations'])
        lines+=['',f'Completion barrier required: {acknowledged} cold completion acknowledgements after publication; {observed} detached descendants were observed and reaped by supervisors. Parent-reaped writer CPU is already included in primary wait4 usage and is not added twice. No fixed detached-writer count is assumed. The external supervisor does not independently observe the exit status of a writer already reaped by the compiler.']
    if diagnostic:
        lines+=['','Construction caveat: this diagnostic compiler uses four O2 codegen units without PGO. OFF/ON ratios within this binary isolate pipeline behavior. Absolute times are not directly comparable with V17 mono-PGO, and this is not a final3× claim.']
    (root/'immediate-pipeline-report.md').write_text('\n'.join(lines)+'\n')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate',type=Path,required=True)
    parser.add_argument('--source',required=True)
    parser.add_argument('--expected-sha256',required=True)
    parser.add_argument('--construction',type=Path,required=True)
    parser.add_argument('--rounds',type=int,default=2)
    parser.add_argument('--require-checkpoint',action='store_true',help='Require one early cache checkpoint before native publication in each cold ON case')
    parser.add_argument('--require-completion',action='store_true',help='Require checkpoint completion after publication and no live cold descendant at first ON edit launch')
    parser.add_argument('--workloads',default='compiler,harfrust',help='Comma-separated compiler and/or harfrust')
    parser.add_argument('--minimum-free-mib',type=int,default=1536)
    parser.add_argument('--resume',type=Path,help='Resume only a between-cohort disk refusal; completed cohorts remain unchanged')
    args=parser.parse_args();assert args.rounds>=2
    workloads=args.workloads.split(',');assert workloads and len(set(workloads))==len(workloads) and set(workloads)<={'compiler','harfrust'}
    assert not args.require_completion or args.require_checkpoint
    os.sched_setaffinity(0,{0,1,2,3})
    with (SCRATCH/'performance.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        assert sha(args.candidate)==args.expected_sha256
        construction=json.loads(args.construction.read_text())
        assert construction['source']==args.source and construction['sha256']==args.expected_sha256
        assert shutil.disk_usage(SCRATCH).free>=args.minimum_free_mib*1024*1024,'Insufficient disk before snapshots'
        if args.resume is None:
            root=Path(tempfile.mkdtemp(prefix='immediate-pipeline-',dir=SCRATCH/'benchmarks'))
            revisions={'silk':snapshot(Path('/workspace/silk-baseline'),root/'silk'),
                       'nonstd':snapshot(Path('/workspace/nonstd'),root/'nonstd')}
            assert revisions==REVISIONS
            metadata=dict(candidate=str(args.candidate.resolve()),sha256=args.expected_sha256,source=args.source,
                revisions=revisions,rounds=args.rounds,cpus=[0,1,2,3],cpu_lane='cpus=0,1,2,3',registry='off',require_checkpoint=args.require_checkpoint,require_completion=args.require_completion,
                sequence='immediate-edits',operations=['build'],workloads=workloads,
                toggle='SILK_NATIVE_BUILD_PIPELINE',order='off/on then on/off',delay_ms=0,
                harness_sha256=sha(Path(__file__)),supervisor_harness_sha256=sha(Path(__file__).with_name('immediate_edits.py')),
                note='No compiler/cache feature differs except pipeline. Each invocation owns a separate subreaper. All writers settle before artifact checks, cleanup or the next cohort.')
            cohorts=[]
        else:
            root=args.resume.resolve()
            assert root.parent==(SCRATCH/'benchmarks').resolve() and not (root/'restored.json').exists()
            metadata=json.loads((root/'metadata.json').read_text())
            assert metadata['source']==args.source and metadata['sha256']==args.expected_sha256 and metadata['rounds']==args.rounds
            assert metadata['revisions']==REVISIONS and metadata['registry']=='off'
            assert metadata.get('require_checkpoint',False)==args.require_checkpoint
            assert metadata.get('require_completion',False)==args.require_completion and metadata['workloads']==workloads
            assert metadata['supervisor_harness_sha256']==sha(Path(__file__).with_name('immediate_edits.py'))
            aborted=json.loads((root/'aborted.json').read_text())
            assert aborted['error']=="AssertionError('Insufficient disk before cohort; no compiler/writer active')",'Only environmental between-cohort refusal may resume'
            cohorts=json.loads((root/'results.json').read_text())
            for cohort in cohorts:
                assert not cohort['failure'] and cohort['all_supervisors_reaped'] and len(cohort['invocations'])==3
                assert all(code==0 for code in cohort['supervisor_exit_codes'])
                assert all(row.get('artifact_pruned_after_validation') and row['exit_code']==0 and row['edit_observed'] and all(d['exit_code']==0 for d in row['detached']) for row in cohort['invocations'])
            for name,repository,main in [('silk','/workspace/silk-baseline','compiler/src/main.silk'),('nonstd','/workspace/nonstd','fonts/shape/tools/cli/src/main.silk')]:
                assert not (root/name/'build').exists(),'No partial cohort cache may be resumed'
                original=subprocess.check_output(['git','-C',repository,'show',REVISIONS[name]+':'+main])
                assert (root/name/main).read_bytes()==original,'Resume requires restored original source'
            metadata.setdefault('resumes',[]).append(dict(monotonic_ns=time.monotonic_ns(),completed_cohorts=len(cohorts),
                prior_refusal=aborted,harness_sha256=sha(Path(__file__)),note='No measured interval or immediate cohort interrupted; only remaining fresh cohorts run'))
        save(root/'metadata.json',metadata);save(root/'candidate-construction.json',construction)
        print(json.dumps({'root':str(root),**metadata}),flush=True)
        paired={};context={};completed=set()
        for cohort in cohorts:
            completed.add((cohort['workload'],cohort['round'],cohort['mode']))
            for row in cohort['invocations']:paired[(cohort['workload'],cohort['round'],row['stage'])]=row
        try:
            for workload in workloads:
                source=root/('silk' if workload=='compiler' else 'nonstd')
                cwd=source if workload=='compiler' else source/'fonts/shape/tools/cli'
                edited=source/'compiler/src/main.silk' if workload=='compiler' else cwd/'src/main.silk'
                original=edited.read_bytes();cache=source/'build'
                needle=b'Create a package or a workspace\\n' if workload=='compiler' else b'Usage: hr_shape FONT TEXT'
                replacements=[b'Create a package or a workspace (revision one)\\n',b'Create a package or a workspace (revision two)\\n'] if workload=='compiler' else [b'Usage: hr_shape FONT TEXT (revision one)',b'Usage: hr_shape FONT TEXT (revision two)']
                assert original.count(needle)==1
                variants=[original,*(original.replace(needle,value) for value in replacements)]
                output=cache/'llvm/x86_64-unknown-linux-gnu/debug'/('silk-compiler' if workload=='compiler' else 'font-shape-cli')
                for repeat in range(args.rounds):
                    for mode in (('off','on') if repeat%2==0 else ('on','off')):
                        if (workload,repeat,mode) in completed:continue
                        context=dict(operation='build',workload=workload,round=repeat,mode=mode)
                        assert shutil.disk_usage(SCRATCH).free>=args.minimum_free_mib*1024*1024,'Insufficient disk before cohort; no compiler/writer active'
                        assert not cache.is_symlink();shutil.rmtree(cache,ignore_errors=True)
                        edited.write_bytes(original)
                        env,pipeline,registry=screen_environment(os.environ,'pipeline','off',mode,'build')
                        assert not registry and ('SILK_FRONTIER_REUSE_COMPLETED' not in env)
                        cmd=[str(args.candidate),'build']+(['--package','silk-compiler'] if workload=='compiler' else [])+['--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings']
                        tag=f'{workload}-{repeat}-{mode}'
                        cohort=run_cohort(cmd,cwd,env,edited,variants,root,tag,output,0)
                        cohort.update(**context,command=cmd,environment={k:v for k,v in env.items() if k.startswith('SILK_')},cpu_lane='cpus=0,1,2,3')
                        cohorts.append(cohort);save(root/'results.json',cohorts)
                        assert not cohort['failure'],cohort['failure']
                        assert len(cohort['invocations'])==3 and all(code==0 for code in cohort['supervisor_exit_codes'])
                        for row in cohort['invocations']:
                            trace=Path(row['log']).read_text()
                            row.update(diagnostics=[line for line in trace.splitlines() if ': warning[' in line or ': error[' in line],
                                frontier_attempted='frontier split' in trace,frontier_accepted='frontier accepted' in trace,
                                artifact_accepted='frontier artifact accepted' in trace,
                                pipeline_started='frontier native coordinator started' in trace,
                                pipeline_published='frontier native objects published' in trace,
                                pipeline_refused='frontier native coordinator refused' in trace,
                                checkpoint_count=trace.count('frontier native cache checkpoint'),
                                completion_count=trace.count('frontier native cache completed'))
                            row['checkpoint_ordered']=(row['checkpoint_count']==1 and row['pipeline_started'] and row['pipeline_published'] and trace.index('frontier native coordinator started')<trace.index('frontier native cache checkpoint')<trace.index('frontier native objects published'))
                            row['completion_ordered']=(row['completion_count']==1 and row['checkpoint_ordered'] and trace.index('frontier native objects published')<trace.index('frontier native cache completed'))
                            assert row['supervisor_affinity']==[0,1,2,3]
                            assert row['exit_code']==0 and all(d['exit_code']==0 for d in row['detached'])
                            if row['stage']=='cold':
                                assert row['frontier_accepted'] and row['artifact_accepted'],(tag,'cold proof missing')
                                assert row['pipeline_started']==pipeline and row['pipeline_published']==pipeline and not row['pipeline_refused'],(tag,'pipeline engagement mismatch')
                                if args.require_checkpoint:
                                    assert row['checkpoint_count']==int(pipeline) and (not pipeline or row['checkpoint_ordered']),(tag,'early checkpoint evidence mismatch')
                                if args.require_completion:
                                    assert row['completion_count']==int(pipeline) and (not pipeline or row['completion_ordered']),(tag,'checkpoint completion evidence mismatch')
                            else:
                                assert row['checkpoint_count']==0 and row['completion_count']==0,(tag,row['stage'],'unexpected warm checkpoint/completion')
                                if args.require_completion and pipeline and row['stage']=='first-edit':
                                    row['cold_live_descendants_before_edit']=[child for child in row['prior_descendants_observed_before_launch'] if child['state']!='Z']
                                    assert not row['cold_live_descendants_before_edit'],(tag,'cold descendant still live at first edit launch')
                                assert not any(row[key] for key in ('frontier_attempted','frontier_accepted','artifact_accepted','pipeline_started','pipeline_published')),(tag,row['stage'],'warm edit reforked')
                            artifact=Path(row['retained_artifact']);row['artifact_sha256']=sha(artifact)
                            smoke=subprocess.run([str(artifact),'--help'],capture_output=True)
                            helptext=smoke.stdout+smoke.stderr
                            marker=None if row['stage']=='cold' else b'revision one' if row['stage']=='first-edit' else b'revision two'
                            row['help_exit_code']=smoke.returncode
                            row['edit_observed']=marker in helptext if marker else b'revision one' not in helptext and b'revision two' not in helptext
                            (root/f'{tag}-{row["stage"]}.help').write_bytes(helptext)
                            assert row['help_exit_code']==0 and row['edit_observed'],(tag,row['stage'],'wrong artifact marker')
                            key=(workload,repeat,row['stage'])
                            if key in paired:
                                assert row['artifact_sha256']==paired[key]['artifact_sha256'],(tag,'artifact differs')
                                assert row['diagnostics']==paired[key]['diagnostics'],(tag,'ordered diagnostics differ')
                            else:paired[key]=row
                        save(root/'results.json',cohorts);report(root,cohorts);print(json.dumps(cohort),flush=True)
                        for row in cohort['invocations']:
                            Path(row['retained_artifact']).unlink();row['artifact_pruned_after_validation']=True
                        edited.write_bytes(original);shutil.rmtree(cache,ignore_errors=True)
                        save(root/'results.json',cohorts)
            save(root/'restored.json',dict(sources_restored=True,all_writers_reaped=True))
        except BaseException as error:
            if 'original' in locals():(root/'original-source.bin').write_bytes(original)
            save(root/'aborted.json',dict(context=context,error=repr(error),source_and_cache_preserved=True))
            raise
        print('COMPLETE '+str(root),flush=True)


if __name__=='__main__':main()
