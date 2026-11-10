#!/usr/bin/env python3
"""Same frozen binary, reversed-order cold→first-edit controls; owns exclusive lock.

Derived from completed_registry_{,build_}screen.py. Both modes use the same retained
cache and developer packing policy. A pipeline screen leaves the registry OFF;
a registry screen holds the already-selected pipeline policy fixed.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import tempfile
import time

from lane import candidate_environment

SCRATCH = Path('/workspace/silk/.scratch')
PREFIXES = ('SILK_FRONTIER_', 'SILK_EXPERIMENT_', 'SILK_POSTCHECK_', 'SILK_RETAINED_',
            'SILK_FINITE_', 'SILK_NATIVE_BUILD_PIPELINE', 'SILK_ARTIFACT_')
FEATURES = {'SILK_RETAINED_CACHE':'1', 'SILK_FRONTIER_EPHEMERAL':'1'}
REVISIONS = {'silk':'a63f612150a0b91a118c8111b910b12c3e124b50',
             'nonstd':'ccb168b773bb56d7bd60a3495141d427149766d0'}



def screen_environment(base, toggle, fixed_pipeline, mode, operation):
    env={k:v for k,v in base.items() if not k.startswith(PREFIXES)}
    env=candidate_environment(env,FEATURES,'parallel','candidate',operation)
    env['SILK_CLANG']=str(SCRATCH/'llvm-22.1.8/bin/clang')
    pipeline=(mode=='on') if toggle=='pipeline' else fixed_pipeline=='on'
    registry=toggle=='registry' and mode=='on'
    if pipeline and operation=='build':env['SILK_NATIVE_BUILD_PIPELINE']='1'
    if registry:env['SILK_FRONTIER_REUSE_COMPLETED']='1'
    return env,pipeline,registry


def save(path, value):
    path.write_text(json.dumps(value, indent=2)+'\n')


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def disk_gate(root, minimum_mib, context, may_wait):
    minimum = minimum_mib*1024*1024
    free = shutil.disk_usage(SCRATCH).free
    if free >= minimum:
        return
    note = dict(event='DISK_PAUSED', context=context, free_bytes=free,
                minimum_bytes=minimum, monotonic_ns=time.monotonic_ns(),
                invariant='Between invocations only: no compiler or detached writer is active; source/cache preserved.')
    save(root/'disk-pause.json', note)
    print(json.dumps(note), flush=True)
    if not may_wait:
        raise RuntimeError('Environmental disk preflight refusal before invocation')
    while shutil.disk_usage(SCRATCH).free < minimum:
        time.sleep(1)
    note.update(event='DISK_RESUMED', free_bytes=shutil.disk_usage(SCRATCH).free,
                resumed_ns=time.monotonic_ns())
    with (root/'disk-resumes.jsonl').open('a') as stream:
        stream.write(json.dumps(note)+'\n')
    (root/'disk-pause.json').unlink()
    print(json.dumps(note), flush=True)


def report(root, rows, metadata):
    comparisons = []
    for operation in metadata['operations']:
        for workload in ('compiler','harfrust'):
            for stage in ('cold','first-edit'):
                pairs = []
                for repeat in range(metadata['rounds']):
                    pair = {row['mode']:row for row in rows if row['operation']==operation
                            and row['workload']==workload and row['stage']==stage and row['round']==repeat}
                    if set(pair)=={'off','on'} and all(row['exit_code']==0 for row in pair.values()):
                        pairs.append(pair)
                if not pairs:
                    continue
                value = dict(operation=operation, workload=workload, stage=stage, pairs=len(pairs),
                    foreground_off_s=statistics.median(p['off']['wall_s'] for p in pairs),
                    foreground_on_s=statistics.median(p['on']['wall_s'] for p in pairs),
                    settled_off_s=statistics.median(p['off']['settled_wall_s'] for p in pairs),
                    settled_on_s=statistics.median(p['on']['settled_wall_s'] for p in pairs),
                    foreground_on_over_off=statistics.median(p['on']['wall_s']/p['off']['wall_s'] for p in pairs),
                    settled_on_over_off=statistics.median(p['on']['settled_wall_s']/p['off']['settled_wall_s'] for p in pairs),
                    cpu_off_s=statistics.median(p['off']['process_tree']['user_s']+p['off']['process_tree']['sys_s'] for p in pairs),
                    cpu_on_s=statistics.median(p['on']['process_tree']['user_s']+p['on']['process_tree']['sys_s'] for p in pairs),
                    paired_foreground_ratios=[p['on']['wall_s']/p['off']['wall_s'] for p in pairs],
                    paired_settled_ratios=[p['on']['settled_wall_s']/p['off']['settled_wall_s'] for p in pairs])
                value['edit_regression'] = stage!='cold' and max(value['foreground_on_over_off'],value['settled_on_over_off'])>1.05
                comparisons.append(value)
    save(root/'comparisons.json', comparisons)
    lines = [f"# {metadata['toggle']} same-binary screen", '',
             'Four execution cores; codegen-unit count is unrelated. Cold → first edit with no unchanged priming. Each command’s detached writers settle before the next command. Two rounds reverse off/on order. Ratios are on/off: above 1 is slower. These small samples do not establish statistical significance.', '',
             'The registry is absent in both pipeline-screen modes. Registry-screen modes use the same fixed pipeline policy. No original-baseline speedup is claimed by this screen.', '',
             '| Operation / workload | Stage | Pairs | Foreground off → on | On/off | Settled off → on | On/off | CPU off → on | Flag |',
             '|---|---|---:|---:|---:|---:|---:|---:|---|']
    for row in comparisons:
        lines.append(f"| {row['operation']} / {row['workload']} | {row['stage']} | {row['pairs']} | {row['foreground_off_s']:.3f}s → {row['foreground_on_s']:.3f}s | {row['foreground_on_over_off']:.3f} | {row['settled_off_s']:.3f}s → {row['settled_on_s']:.3f}s | {row['settled_on_over_off']:.3f} | {row['cpu_off_s']:.3f}s → {row['cpu_on_s']:.3f}s | {'REGRESSION' if row['edit_regression'] else ''} |")
    expected = len(metadata['operations'])*2*metadata['rounds']*2*2
    lines += ['', f'Completed {len(rows)}/{expected} invocations. Every row retains its exact command/environment, source hash, diagnostics, foreground/settled time, process-tree CPU, writer status, cache bytes, and engagement traces. Build rows retain artifact hashes and edited help output.', '',
              'A small or workload-dependent improvement is not enough to select a default; inspect per-round ratios and editing costs. Failed/incomplete cases remain evidence and must not be treated as a completed screen.']
    (root/'screen-report.md').write_text('\n'.join(lines)+'\n')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate',type=Path,required=True)
    parser.add_argument('--source',required=True)
    parser.add_argument('--expected-sha256',required=True)
    parser.add_argument('--construction',type=Path,required=True)
    parser.add_argument('--toggle',choices=('pipeline','registry'),required=True)
    parser.add_argument('--fixed-pipeline',choices=('off','on'),default='off')
    parser.add_argument('--rounds',type=int,default=2)
    parser.add_argument('--minimum-free-mib',type=int,default=1024)
    parser.add_argument('--wait-for-disk',action='store_true')
    args=parser.parse_args()
    assert args.rounds>=2, 'Small-gain screens need a reversed pair.'
    assert args.toggle!='pipeline' or args.fixed_pipeline=='off'
    os.sched_setaffinity(0,{0,1,2,3})
    spec=importlib.util.spec_from_file_location('cold',SCRATCH/'benchmarks/cold_bench.py')
    bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
    with (SCRATCH/'performance.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        assert sha(args.candidate)==args.expected_sha256, 'Frozen binary changed'
        construction=json.loads(args.construction.read_text())
        assert construction['source']==args.source and construction['sha256']==args.expected_sha256
        assert shutil.disk_usage(SCRATCH).free>=args.minimum_free_mib*1024*1024, 'Insufficient disk before snapshots'
        root=Path(tempfile.mkdtemp(prefix=f'{args.toggle}-screen-',dir=SCRATCH/'benchmarks'))
        revisions={'silk':bench.snapshot(Path('/workspace/silk-baseline'),root/'silk'),
                   'nonstd':bench.snapshot(Path('/workspace/nonstd'),root/'nonstd')}
        assert revisions==REVISIONS,revisions
        metadata=dict(toggle=args.toggle,fixed_pipeline=args.fixed_pipeline,rounds=args.rounds,
                      operations=['build'] if args.toggle=='pipeline' else ['check','build'],
                      candidate=str(args.candidate.resolve()),sha256=args.expected_sha256,source=args.source,
                      revisions=revisions,cpus=[0,1,2,3],cpu_lane='cpus=0,1,2,3',worker_policy='parallel',
                      sequence=['cold','first-edit'],features=FEATURES,harness_sha256=sha(Path(__file__)),
                      order='off,on in even rounds; on,off in odd rounds',profile='default',
                      disk_minimum_mib=args.minimum_free_mib,
                      rss_note='Individual-process maximum; not aggregate concurrent memory.')
        save(root/'metadata.json',metadata);save(root/'candidate-construction.json',construction)
        print(json.dumps({'root':str(root),**metadata}),flush=True)
        rows=[];paired={}
        current={}
        try:
            for operation in metadata['operations']:
                for workload in ('compiler','harfrust'):
                    source=root/('silk' if workload=='compiler' else 'nonstd')
                    cwd=source if workload=='compiler' else source/'fonts/shape/tools/cli'
                    edited=source/'compiler/src/main.silk' if workload=='compiler' else cwd/'src/main.silk'
                    original=edited.read_bytes();cache=source/'build'
                    needle=b'Create a package or a workspace\\n' if workload=='compiler' else b'Usage: hr_shape FONT TEXT'
                    replacement=b'Create a package or a workspace (revision one)\\n' if workload=='compiler' else b'Usage: hr_shape FONT TEXT (revision one)'
                    assert original.count(needle)==1
                    for repeat in range(args.rounds):
                        for mode in (('off','on') if repeat%2==0 else ('on','off')):
                            edited.write_bytes(original);assert not cache.is_symlink();shutil.rmtree(cache,ignore_errors=True)
                            env,pipeline,registry=screen_environment(os.environ,args.toggle,args.fixed_pipeline,mode,operation)
                            for stage in ('cold','first-edit'):
                                current=dict(operation=operation,workload=workload,round=repeat,mode=mode,stage=stage)
                                disk_gate(root,args.minimum_free_mib,current,args.wait_for_disk)
                                if stage=='first-edit':edited.write_bytes(original.replace(needle,replacement))
                                tag=f'{operation}-{workload}-{repeat}-{mode}-{stage}'
                                cmd=[str(args.candidate),operation]+(['--package','silk-compiler'] if workload=='compiler' else [])+['--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings']
                                log=root/(tag+'.log')
                                row=dict(**current,cpu_lane=metadata['cpu_lane'],worker_policy='parallel',sequence='edits',
                                         command=cmd,environment={k:v for k,v in env.items() if k.startswith('SILK_')},
                                         source_sha256=hashlib.sha256(edited.read_bytes()).hexdigest(),
                                         **bench.measure(cmd,cwd,env,log))
                                trace=log.read_text()
                                row.update(writer_tail_s=row['settled_wall_s']-row['wall_s'],
                                    diagnostics=[line for line in trace.splitlines() if ': warning[' in line or ': error[' in line],
                                    frontier_accepted='frontier accepted' in trace,frontier_attempted='frontier split' in trace,
                                    artifact_accepted='frontier artifact accepted' in trace,
                                    pipeline_started='frontier native coordinator started' in trace,
                                    pipeline_published='frontier native objects published' in trace,
                                    pipeline_refused='frontier native coordinator refused' in trace,
                                    registry_hits=sum(int(hit) for hit in re.findall(r'frontier completed body registry ms=\d+ a=\d+ b=(\d+)',trace)),
                                    cache_bytes=sum(f.stat().st_size for f in (cache/'cache').rglob('*') if f.is_file()) if (cache/'cache').exists() else 0)
                                if operation=='build' and row['exit_code']==0:
                                    binary=cache/'llvm/x86_64-unknown-linux-gnu/debug'/('silk-compiler' if workload=='compiler' else 'font-shape-cli')
                                    row['binary_sha256']=sha(binary)
                                    smoke=subprocess.run([str(binary),'--help'],capture_output=True)
                                    helptext=smoke.stdout+smoke.stderr
                                    row['help_exit_code']=smoke.returncode
                                    row['edit_observed']=b'revision one' in helptext if stage=='first-edit' else b'revision one' not in helptext
                                    (root/(tag+'.help')).write_bytes(helptext)
                                rows.append(row);save(root/'results.json',rows);report(root,rows,metadata)
                                print(json.dumps(row),flush=True)
                                assert row['exit_code']==0 and all(d['exit_code']==0 for d in row['detached']),tag
                                if stage=='cold':
                                    assert row['frontier_accepted'],tag+': cold proof not accepted'
                                    if operation=='build':
                                        assert row['artifact_accepted'],tag+': cold artifact proof not accepted'
                                        assert row['pipeline_started']==pipeline and row['pipeline_published']==pipeline and not row['pipeline_refused'],tag+': pipeline engagement mismatch'
                                    if registry:assert row['registry_hits']>0,tag+': completed-body reuse not exercised'
                                else:
                                    assert not any(row[k] for k in ('frontier_attempted','frontier_accepted','artifact_accepted','pipeline_started','pipeline_published')),tag+': first edit reforked'
                                if operation=='build':assert row['help_exit_code']==0 and row['edit_observed'],tag
                                key=(operation,workload,repeat,stage)
                                if key in paired:
                                    other=paired[key]
                                    assert row['diagnostics']==other['diagnostics'],tag+': ordered diagnostics differ'
                                    if operation=='build':assert row['binary_sha256']==other['binary_sha256'],tag+': same-input artifact differs'
                                else:paired[key]=row
                            shutil.rmtree(cache,ignore_errors=True)
                    edited.write_bytes(original)
            save(root/'restored.json',dict(sources_restored=True,all_writers_reaped=True))
        except BaseException as error:
            if 'original' in locals(): (root/'original-source.bin').write_bytes(original)
            save(root/'aborted.json',dict(context=current,error=repr(error),source=str(edited) if 'edited' in locals() else None,
                                         cache=str(cache) if 'cache' in locals() else None,source_and_cache_preserved=True))
            report(root,rows,metadata)
            raise
        print('COMPLETE '+str(root),flush=True)


if __name__=='__main__':main()
