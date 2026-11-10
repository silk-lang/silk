#!/usr/bin/env python3
"""Immediate edit cohorts, separate from the settled-writer incremental lane.

Every compiler invocation has its own subreaper supervisor. The next edit starts
on foreground exit notification, without waiting for that invocation's writers.
All supervisors settle before artifact validation, cache removal or another case.
This file is independent of compare.py and does not alter its settled semantics.
"""
import argparse
import ctypes
import fcntl
import hashlib
import json
import multiprocessing as mp
from multiprocessing.connection import wait
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import traceback

from lane import cpus as parse_cpus, identity, candidate_environment, expect_no_pool, POLICIES

SCRATCH = Path('/workspace/silk/.scratch')
STAGES = ('cold', 'first-edit', 'second-edit')
ENV_PREFIXES = ('SILK_FRONTIER_', 'SILK_EXPERIMENT_', 'SILK_POSTCHECK_', 'SILK_RETAINED_', 'SILK_FINITE_', 'SILK_NATIVE_BUILD_PIPELINE')


def usage(r):
    return dict(user_s=r.ru_utime, sys_s=r.ru_stime, max_rss_kib=r.ru_maxrss,
                minor_faults=r.ru_minflt, major_faults=r.ru_majflt,
                voluntary_switches=r.ru_nvcsw, involuntary_switches=r.ru_nivcsw)


def process_identity(pid):
    """One procfs observation, not a polling monitor; birth ticks prevent PID reuse."""
    try:
        tail = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return dict(pid=pid, state=tail[0], parent_pid=int(tail[1]), start_ticks=int(tail[19]))
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None


def adopted_children():
    own = os.getpid()
    try:
        children = Path(f'/proc/{own}/task/{own}/children').read_text().split()
    except FileNotFoundError:
        # Some managed procfs mounts omit task/*/children. A single scan after
        # foreground exit is recorded in notification/launch latency, never polled.
        children = [entry.name for entry in Path('/proc').iterdir() if entry.name.isdigit()]
    return [value for pid in children if (value := process_identity(int(pid))) is not None and value['parent_pid'] == own]


def supervise(connection, command, cwd, environment, log_path, prior_descendants):
    """Only this command's descendants can be adopted here, even across setsid."""
    child = None
    detached = []
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0):
            raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER')
        with open(log_path, 'wb') as log:
            observation_started = time.monotonic_ns()
            prior_states = []
            for prior in prior_descendants:
                observed = process_identity(prior['pid'])
                if observed is not None and observed['start_ticks'] == prior['start_ticks']:
                    prior_states.append(observed)
            observation_finished = time.monotonic_ns()
            started = time.monotonic_ns()
            child = subprocess.Popen(command, cwd=cwd, env=environment,
                                     stdin=subprocess.DEVNULL, stdout=log,
                                     stderr=subprocess.STDOUT)
            _, status, resource = os.wait4(child.pid, 0)
            exited = time.monotonic_ns()
            child.returncode = os.waitstatus_to_exitcode(status)
            foreground = dict(event='foreground', supervisor_pid=os.getpid(),
                              compiler_pid=child.pid, started_ns=started,
                              foreground_ns=exited, exit_code=child.returncode,
                              wall_s=(exited-started)/1e9, primary=usage(resource),
                              supervisor_affinity=sorted(os.sched_getaffinity(0)),
                              adopted_descendants_at_foreground=adopted_children(),
                              prior_descendant_observation_started_ns=observation_started,
                              prior_descendant_observation_finished_ns=observation_finished,
                              prior_descendants_observed_before_launch=prior_states)
            connection.send(foreground)
            # The supervisor deliberately remains alive and owns this invocation's
            # orphans while the orchestrator launches a different supervisor.
            while True:
                try:
                    pid, status, additional = os.wait4(-1, 0)
                    detached.append(dict(pid=pid, exit_code=os.waitstatus_to_exitcode(status),
                                         reaped_ns=time.monotonic_ns(), **usage(additional)))
                except ChildProcessError:
                    break
            settled = time.monotonic_ns()
        tree = dict(foreground['primary'])
        for additional in detached:
            for key in tree:
                tree[key] = max(tree[key], additional[key]) if key == 'max_rss_kib' else tree[key] + additional[key]
        connection.send(dict(event='settled', settled_ns=settled,
                             settled_wall_s=(settled-started)/1e9,
                             detached=detached, process_tree=tree))
    except BaseException:
        error = traceback.format_exc()
        # Do not leave a compiler or adopted writer behind on a supervisor error.
        if child is not None and child.returncode is None:
            try:
                _, status, _ = os.wait4(child.pid, 0)
                child.returncode = os.waitstatus_to_exitcode(status)
            except ChildProcessError:
                pass
        while True:
            try:
                os.wait4(-1, 0)
            except ChildProcessError:
                break
        connection.send(dict(event='error', error=error, all_children_reaped=True))
    finally:
        connection.close()


def run_cohort(command, cwd, env, edited, variants, root, tag, output=None, delay_ms=0):
    """Return three independent lifetimes plus their overlapping cohort envelope."""
    # The orchestrator is single-threaded; fork avoids Python startup delay
    # between foreground exit and the next edit. Each child installs its own
    # subreaper before starting its compiler, so sibling cohorts never mix.
    context = mp.get_context('fork')
    active = {}
    supervisors = []
    rows = []
    launch_requests = []
    hashes = [hashlib.sha256(value).hexdigest() for value in variants]
    previous_foreground = None
    cohort_start = time.monotonic_ns()

    def launch(index):
        nonlocal previous_foreground
        # A delayed policy is explicit, identical for A/B, and recorded. At delay=0
        # there is no sleep, cache poll, artifact hashing or priming invocation.
        if previous_foreground is not None and delay_ms:
            due = previous_foreground + int(delay_ms*1e6)
            remaining = due - time.monotonic_ns()
            if remaining > 0:
                time.sleep(remaining/1e9)
        edit_started = time.monotonic_ns()
        edited.write_bytes(variants[index])
        edit_finished = time.monotonic_ns()
        receiver, sender = context.Pipe(duplex=False)
        log = root / f'{tag}-{STAGES[index]}.log'
        prior_descendants = [child for row in rows for child in row.get('adopted_descendants_at_foreground', [])]
        process = context.Process(target=supervise,
                                  args=(sender, command, str(cwd), env, str(log), prior_descendants))
        requested = time.monotonic_ns()
        process.start()
        sender.close()
        supervisors.append(process)
        row = dict(stage=STAGES[index], log=str(log), source_sha256=hashes[index],
                   edit_started_ns=edit_started, edit_finished_ns=edit_finished,
                   supervisor_launch_requested_ns=requested,
                   previous_foreground_ns=previous_foreground)
        rows.append(row)
        active[receiver] = (index, process)
        launch_requests.append(requested)

    launch(0)
    failure = None
    try:
        while active:
            for connection in wait(list(active)):
                index, process = active[connection]
                try:
                    event = connection.recv()
                except EOFError:
                    failure = failure or f'supervisor {process.pid} closed before settlement'
                    del active[connection]
                    connection.close()
                    continue
                row = rows[index]
                kind = event.pop('event')
                row.update(event)
                if kind == 'foreground':
                    notification = time.monotonic_ns()
                    row['foreground_notification_ns'] = notification
                    if row['exit_code']:
                        failure = failure or f'{STAGES[index]} compiler exited {row["exit_code"]}'
                    if output is not None and not row['exit_code']:
                        # Native compileIr publishes by atomic rename. A hard link pins
                        # this stage's immutable artifact without reading a large binary
                        # or running it before the next edit starts.
                        retained = root / f'{tag}-{STAGES[index]}.artifact'
                        os.link(output, retained)
                        st = retained.stat()
                        row['retained_artifact'] = str(retained)
                        row['artifact_inode'] = [st.st_dev, st.st_ino, st.st_size]
                    if index + 1 < len(STAGES) and failure is None:
                        previous_foreground = row['foreground_ns']
                        launch(index + 1)
                elif kind in ('settled', 'error'):
                    if kind == 'error':
                        failure = failure or event['error']
                    del active[connection]
                    connection.close()
    finally:
        # On assertion/IO failure or interrupt, let every started supervisor drain.
        # No cache cleanup or source restoration happens before this completes.
        for process in supervisors:
            process.join()
        for connection in active:
            connection.close()
    cohort_end = time.monotonic_ns()
    for row in rows:
        if 'foreground_ns' in row and row['previous_foreground_ns'] is not None:
            row['launch_gap_s'] = (row['started_ns']-row['previous_foreground_ns'])/1e9
            row['previous_return_to_this_return_s'] = (row['foreground_ns']-row['previous_foreground_ns'])/1e9
            row['source_mutation_s'] = (row['edit_finished_ns']-row['edit_started_ns'])/1e9
            row['edit_action_to_return_s'] = (row['foreground_ns']-row['edit_started_ns'])/1e9
        if 'settled_ns' in row:
            row['writer_tail_s'] = (row['settled_ns']-row['foreground_ns'])/1e9
    for index, row in enumerate(rows):
        if 'started_ns' in row:
            row['prior_invocations_not_observed_settled_at_start'] = [prior['stage'] for prior in rows[:index]
                if prior.get('settled_ns', 0) > row['started_ns']]
    return dict(sequence='immediate-edits', delay_ms=delay_ms, started_ns=cohort_start,
                settled_ns=cohort_end, cohort_wall_s=(cohort_end-cohort_start)/1e9,
                supervisor_exit_codes=[p.exitcode for p in supervisors],
                all_supervisors_reaped=True, failure=failure, invocations=rows)


def snapshot(source, destination):
    destination.mkdir()
    archive = subprocess.Popen(['git', '-C', str(source), 'archive', 'HEAD'], stdout=subprocess.PIPE)
    try:
        subprocess.run(['tar', '-xf', '-', '-C', str(destination)], stdin=archive.stdout, check=True)
    finally:
        archive.stdout.close()
    if archive.wait():
        raise RuntimeError(f'git archive failed: {source}')
    return subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2)+'\n')



def report(root, cohorts):
    pairs = {}
    for cohort in cohorts:
        if cohort.get('failure') or len(cohort['invocations']) != 3:
            continue
        key = (cohort['cpu_lane'], cohort['worker_policy'], cohort['operation'],
               cohort['workload'], cohort['round'], cohort['delay_ms'])
        pairs.setdefault(key, {})[cohort['mode']] = cohort
    lines = ['# Immediate edit comparison', '',
             'Separate lane: each edit starts after the previous foreground exits, while its cache writer may still be active. Actual launch gaps and writer overlap are recorded. No unchanged priming occurs.', '',
             'Per-invocation settled intervals overlap and must not be added. Cohort elapsed time includes all three foreground commands and every detached writer. Ratios below are candidate / baseline; above 1 is slower. These are individual matched pairs, not confidence estimates.', '',
             '| CPU lane | Operation / workload | Round | Stage | Foreground baseline → candidate | Ratio | Settled baseline → candidate | Ratio | Edit action → return baseline → candidate | Ratio | Flag |',
             '|---|---|---:|---|---:|---:|---:|---:|---:|---:|---|']
    comparisons = []
    for key, modes in sorted(pairs.items()):
        if set(modes) != {'baseline', 'candidate'}:
            continue
        baseline, candidate = modes['baseline'], modes['candidate']
        for left, right in zip(baseline['invocations'], candidate['invocations']):
            foreground = right['wall_s']/left['wall_s']
            settled = right['settled_wall_s']/left['settled_wall_s']
            action = right['edit_action_to_return_s']/left['edit_action_to_return_s'] if left['stage']!='cold' else None
            action_cells = f"{left['edit_action_to_return_s']:.3f}s → {right['edit_action_to_return_s']:.3f}s | {action:.3f}" if action is not None else '— | —'
            regression = left['stage'] != 'cold' and max(foreground, settled, action) > 1.05
            comparisons.append(dict(cpu_lane=key[0], worker_policy=key[1], operation=key[2],
                                    workload=key[3], round=key[4], delay_ms=key[5], stage=left['stage'],
                                    candidate_over_baseline_foreground=foreground,
                                    candidate_over_baseline_settled=settled, candidate_over_baseline_edit_action=action, regression=regression))
            lines.append(f"| {key[0]} | {key[2]} / {key[3]} | {key[4]} | {left['stage']} | {left['wall_s']:.3f}s → {right['wall_s']:.3f}s | {foreground:.3f} | {left['settled_wall_s']:.3f}s → {right['settled_wall_s']:.3f}s | {settled:.3f} | {action_cells} | {'REGRESSION' if regression else ''} |")
        lines.append(f"| {key[0]} | {key[2]} / {key[3]} | {key[4]} | complete cohort | {baseline['cohort_wall_s']:.3f}s → {candidate['cohort_wall_s']:.3f}s | {candidate['cohort_wall_s']/baseline['cohort_wall_s']:.3f} | — | — | — | — | |")
    lines += ['', 'Edit action → return includes source mutation and launch overhead. Separate actual gaps from the previous foreground return:', '',
              '| CPU lane | Operation / workload | Round | Stage | Launch gap baseline → candidate | Source mutation baseline → candidate |',
              '|---|---|---:|---|---:|---:|']
    for key,modes in sorted(pairs.items()):
        if set(modes) != {'baseline','candidate'}: continue
        for left,right in zip(modes['baseline']['invocations'][1:],modes['candidate']['invocations'][1:]):
            lines.append(f"| {key[0]} | {key[2]} / {key[3]} | {key[4]} | {left['stage']} | {left['launch_gap_s']:.4f}s → {right['launch_gap_s']:.4f}s | {left['source_mutation_s']:.4f}s → {right['source_mutation_s']:.4f}s |")
    lines += ['', 'Inspect results.json for ordered diagnostics, retained artifact hashes and help output, exact source/launch/foreground/settlement timestamps, single-shot prior-descendant liveness observations immediately before launch (zombies excluded from live evidence), per-supervisor descendants, and process-tree CPU. Final acceptance requires both this lane and the settled-writer lane; cold gains do not waive edit regressions.']
    write_json(root/'comparisons.json', comparisons)
    construction_path=root/'candidate-construction.json'
    if construction_path.exists():
        construction=json.loads(construction_path.read_text())
        if construction.get('codegen_units')==4 and construction.get('profile_use') is None:
            lines+=['','Construction caveat: candidate is a diagnostic compiler built with four O2 codegen units and no PGO. This original-baseline comparison includes construction differences; use it to diagnose editing/CPU0 regressions, not to attribute a delta to one implementation change or compare absolute times with V17 mono-PGO.']
    (root/'immediate-report.md').write_text('\n'.join(lines)+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--candidate-source-revision', required=True)
    parser.add_argument('--candidate-construction', type=Path, help='Pinned construction metadata, retained with diagnostic caveats')
    parser.add_argument('--baseline', type=Path, default=SCRATCH/'N0-one')
    parser.add_argument('--baseline-source-revision', default='a63f612150a0b91a118c8111b910b12c3e124b50')
    parser.add_argument('--cpus', default='0,1,2,3')
    parser.add_argument('--worker-policy', choices=POLICIES, default='parallel')
    parser.add_argument('--require-host-capacity-refusal', action='store_true')
    parser.add_argument('--operations', default='check,build')
    parser.add_argument('--workloads', default='compiler,harfrust')
    parser.add_argument('--rounds', type=int, default=1)
    parser.add_argument('--delay-ms', type=float, default=0)
    parser.add_argument('--feature', action='append', default=[])
    parser.add_argument('--minimum-free-mib', type=int, default=1536)
    args = parser.parse_args()
    assert args.rounds > 0 and 0 <= args.delay_ms <= 60000
    operations = args.operations.split(','); workloads = args.workloads.split(',')
    assert set(operations) <= {'check', 'build'}
    assert set(workloads) <= {'compiler', 'harfrust'}
    selected = parse_cpus(args.cpus)
    os.sched_setaffinity(0, set(selected))
    if args.require_host_capacity_refusal:
        assert len(selected) == 1 and args.worker_policy == 'parallel'
    features = dict(item.split('=', 1) for item in args.feature)
    assert all(key.startswith('SILK_') for key in features)
    binaries = {'baseline': args.baseline.resolve(), 'candidate': args.candidate.resolve()}
    # Self-contained lock prevents accidental overlap with another benchmark.
    with (SCRATCH/'performance.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if shutil.disk_usage(SCRATCH).free < args.minimum_free_mib*1024*1024:
            raise SystemExit('Insufficient disk before snapshots; no compiler started')
        root = Path(tempfile.mkdtemp(prefix='immediate-edits-', dir=SCRATCH/'benchmarks'))
        revisions = {'silk': snapshot(Path('/workspace/silk-baseline'), root/'silk')}
        if 'harfrust' in workloads:
            revisions['nonstd'] = snapshot(Path('/workspace/nonstd'), root/'nonstd')
        assert revisions['silk'] == args.baseline_source_revision
        if 'nonstd' in revisions:
            assert revisions['nonstd'] == 'ccb168b773bb56d7bd60a3495141d427149766d0'
        metadata = dict(sequence='immediate-edits', delay_ms=args.delay_ms, cpus=selected,
                        cpu_lane=identity(selected), worker_policy=args.worker_policy,
                        revisions=revisions, rounds=args.rounds, operations=operations,
                        workloads=workloads, features=features,
                        harness_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                        binaries={mode:dict(path=str(path), sha256=hashlib.file_digest(path.open('rb'),'sha256').hexdigest(),
                            source_revision=args.baseline_source_revision if mode=='baseline' else args.candidate_source_revision)
                            for mode,path in binaries.items()},
                        note='No prior writer settlement or unchanged priming before either edit. Every invocation owns its own subreaper; cohort fully settled before validation/cleanup. Times from different overlapping invocations must not be added.',
                        artifacts='Hard links pin atomic-rename output; hashes and --help markers checked only after the entire cohort settles.',
                        clocks='monotonic_ns on same host; launch gaps include source edit, IPC scheduling, supervisor startup and process creation; previous-return-to-this-return includes that gap plus foreground latency. Per-invocation wall starts after one nonpolling prior-descendant liveness observation.',
                        memory='Individual-process maximum RSS, not concurrent aggregate memory.')
        if args.candidate_construction is not None:
            construction=json.loads(args.candidate_construction.read_text())
            assert construction['source']==args.candidate_source_revision
            assert construction['sha256']==metadata['binaries']['candidate']['sha256']
            write_json(root/'candidate-construction.json',construction)
            metadata['candidate_construction']={key:construction.get(key) for key in ('optimization','debug','codegen_units','profile_use','purpose')}
        write_json(root/'metadata.json', metadata)
        print(json.dumps(dict(root=str(root), metadata=metadata)), flush=True)
        results = []
        diagnostics = {}
        for operation in operations:
            for workload in workloads:
                source = root/('silk' if workload=='compiler' else 'nonstd')
                cwd = source if workload=='compiler' else source/'fonts/shape/tools/cli'
                cache = source/'build'
                edited = source/'compiler/src/main.silk' if workload=='compiler' else cwd/'src/main.silk'
                original = edited.read_bytes()
                needle = b'Create a package or a workspace\\n' if workload=='compiler' else b'Usage: hr_shape FONT TEXT'
                assert original.count(needle) == 1
                replacements = [b'Create a package or a workspace (revision one)\\n', b'Create a package or a workspace (revision two)\\n'] if workload=='compiler' else [b'Usage: hr_shape FONT TEXT (revision one)', b'Usage: hr_shape FONT TEXT (revision two)']
                variants = [original, *(original.replace(needle, replacement) for replacement in replacements)]
                for repeat in range(args.rounds):
                    for mode in (['baseline', 'candidate'] if repeat%2==0 else ['candidate', 'baseline']):
                        if shutil.disk_usage(SCRATCH).free < args.minimum_free_mib*1024*1024:
                            raise SystemExit('Insufficient disk before cohort; no compiler/writer active')
                        assert not cache.is_symlink()
                        shutil.rmtree(cache, ignore_errors=True)
                        edited.write_bytes(original)
                        env = {k:v for k,v in os.environ.items() if not k.startswith(ENV_PREFIXES)}
                        env['SILK_CLANG'] = str(SCRATCH/'llvm-22.1.8/bin/clang')
                        if mode == 'candidate':
                            env = candidate_environment(env, features, args.worker_policy, mode, operation)
                        command = [str(binaries[mode]), operation] + (['--package','silk-compiler'] if workload=='compiler' else []) + ['--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings']
                        output = cache/'llvm/x86_64-unknown-linux-gnu/debug'/('silk-compiler' if workload=='compiler' else 'font-shape-cli') if operation=='build' else None
                        tag = f'{operation}-{workload}-{repeat}-{mode}'
                        cohort = run_cohort(command, cwd, env, edited, variants, root, tag, output, args.delay_ms)
                        cohort.update(operation=operation, workload=workload, round=repeat, mode=mode,
                                      command=command, environment={k:v for k,v in env.items() if k.startswith('SILK_')},
                                      cpu_lane=identity(selected), cpus=selected, worker_policy=args.worker_policy)
                        results.append(cohort)
                        write_json(root/'results.json', results)
                        assert not cohort['failure'], cohort['failure']
                        assert len(cohort['invocations']) == 3 and all(code == 0 for code in cohort['supervisor_exit_codes'])
                        for row in cohort['invocations']:
                            trace = Path(row['log']).read_text()
                            row['diagnostic_lines'] = [line for line in trace.splitlines() if ': warning[' in line or ': error[' in line]
                            row['frontier_attempted'] = 'frontier split' in trace
                            row['frontier_accepted'] = 'frontier accepted' in trace
                            row['artifact_accepted'] = 'artifact accepted' in trace
                            row['host_capacity_refused'] = 'host capacity refused' in trace
                            row['pipeline_started'] = 'frontier native coordinator started' in trace
                            row['pipeline_published'] = 'frontier native objects published' in trace
                            row['pipeline_refused'] = 'frontier native coordinator refused' in trace
                            row['checkpoint_count'] = trace.count('frontier native cache checkpoint')
                            row['no_pool_verified'] = not any(row[key] for key in ('frontier_attempted','frontier_accepted','artifact_accepted'))
                            assert row['supervisor_affinity'] == selected, (tag, 'affinity changed')
                            assert row['exit_code'] == 0 and all(d['exit_code']==0 for d in row['detached'])
                            key = (operation, workload, repeat, row['stage'])
                            if key in diagnostics:
                                assert diagnostics[key] == row['diagnostic_lines'], (tag,row['stage'],'ordered diagnostics differ')
                            else:
                                diagnostics[key] = row['diagnostic_lines']
                            if mode == 'candidate' and (args.require_host_capacity_refusal or expect_no_pool(args.worker_policy, selected)):
                                assert row['no_pool_verified'] and not row['pipeline_started'] and row['checkpoint_count']==0, (tag,row['stage'],'unexpected pool/coordinator/checkpoint')
                            if mode == 'candidate' and args.worker_policy=='parallel' and len(selected)>=4:
                                if row['stage']=='cold':
                                    assert row['frontier_accepted'], (tag, 'cold frontier proof not accepted')
                                    if operation=='build':
                                        assert row['artifact_accepted'], (tag, 'cold artifact proof not accepted')
                                        pipeline='SILK_NATIVE_BUILD_PIPELINE' in env
                                        assert row['pipeline_started']==pipeline and row['pipeline_published']==pipeline and not row['pipeline_refused'], (tag, 'pipeline engagement mismatch')
                                else:
                                    assert row['no_pool_verified'] and not row['pipeline_started'], (tag,row['stage'],'warm edit reforked')
                            if mode == 'candidate' and args.require_host_capacity_refusal and row['stage']=='cold':
                                assert row['host_capacity_refused'], (tag,'missing automatic refusal')
                            if output is not None:
                                artifact = Path(row['retained_artifact'])
                                row['artifact_sha256'] = hashlib.file_digest(artifact.open('rb'),'sha256').hexdigest()
                                smoke = subprocess.run([str(artifact),'--help'], capture_output=True)
                                helptext = smoke.stdout+smoke.stderr
                                marker = None if row['stage']=='cold' else b'revision one' if row['stage']=='first-edit' else b'revision two'
                                row['help_exit_code'] = smoke.returncode
                                row['edit_observed'] = marker in helptext if marker else b'revision one' not in helptext and b'revision two' not in helptext
                                (root/f'{tag}-{row["stage"]}.help').write_bytes(helptext)
                                assert row['help_exit_code']==0 and row['edit_observed'], (tag,row['stage'],'wrong compiled edit')
                        cohort['cache_bytes_after_all_writers'] = sum(p.stat().st_size for p in cache.rglob('*') if p.is_file()) if cache.exists() else 0
                        write_json(root/'results.json', results)
                        report(root, results)
                        print(json.dumps(cohort), flush=True)
                        # Preserve compact evidence after artifact checks; links hold a
                        # previous binary inode alive until all relevant writers settle.
                        for row in cohort['invocations']:
                            if 'retained_artifact' in row:
                                Path(row['retained_artifact']).unlink()
                                row['artifact_pruned_after_validation'] = True
                        edited.write_bytes(original)
                        shutil.rmtree(cache, ignore_errors=True)
                        write_json(root/'results.json', results)
        report(root, results)
        write_json(root/'restored.json', dict(sources_restored=True, all_writers_reaped=True))
        print('COMPLETE '+str(root), flush=True)


if __name__ == '__main__':
    main()
