#!/usr/bin/env python3
"""Four-stage edit supervisor. Reuses unchanged per-invocation process ownership.

This isolated extension does not alter any historical three-stage harness.
"""
import hashlib
import multiprocessing as mp
from multiprocessing.connection import wait
import os
import time
from immediate_edits import supervise, snapshot

STAGES = ('cold', 'first-edit', 'second-edit', 'unchanged')

def run_cohort(command, cwd, env, edited, variants, root, tag, output=None, delay_ms=0, sequence="immediate"):
    """Four independent invocation lifetimes; unchanged never mutates source."""
    assert sequence in ("immediate", "settled") and len(variants) == len(STAGES)
    assert variants[2] == variants[3]
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
        if STAGES[index] != "unchanged":
            edited.write_bytes(variants[index])
        else:
            assert edited.read_bytes() == variants[index], "Unchanged source unexpectedly changed"
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
                   source_mutated=STAGES[index] != "unchanged",
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
                    if sequence == "immediate" and index + 1 < len(STAGES) and failure is None:
                        previous_foreground = row['foreground_ns']
                        launch(index + 1)
                elif kind in ('settled', 'error'):
                    if kind == 'error':
                        failure = failure or event['error']
                    del active[connection]
                    connection.close()
                    if kind == "settled" and sequence == "settled" and index + 1 < len(STAGES) and failure is None:
                        previous_foreground = row['foreground_ns']
                        launch(index + 1)
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
            row['source_mutation_s'] = (row['edit_finished_ns']-row['edit_started_ns'])/1e9 if row['source_mutated'] else 0
            row['source_verification_s'] = 0 if row['source_mutated'] else (row['edit_finished_ns']-row['edit_started_ns'])/1e9
            row['edit_action_to_return_s'] = (row['foreground_ns']-row['edit_started_ns'])/1e9
        if 'settled_ns' in row:
            row['writer_tail_s'] = (row['settled_ns']-row['foreground_ns'])/1e9
    for index, row in enumerate(rows):
        if 'started_ns' in row:
            row['prior_invocations_not_observed_settled_at_start'] = [prior['stage'] for prior in rows[:index]
                if prior.get('settled_ns', 0) > row['started_ns']]
    return dict(sequence=sequence+'-edits', delay_ms=delay_ms, started_ns=cohort_start,
                settled_ns=cohort_end, cohort_wall_s=(cohort_end-cohort_start)/1e9,
                supervisor_exit_codes=[p.exitcode for p in supervisors],
                all_supervisors_reaped=True, failure=failure, invocations=rows)
