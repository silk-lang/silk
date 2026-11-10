"""Bounded settled maintenance diagnostic core; compiler adapter intentionally not wired.

Immediate timing remains cache_segments_sequence.py. This lane measures a persistent
cache through real maintenance, including writer completion and physical storage.
No threshold, reserved-byte ledger, or coarse trim is a completed cycle.
"""
from pathlib import Path
import os
import multiprocessing as mp
from multiprocessing.connection import wait
import time
from immediate_edits import supervise


def physical_inventory(root):
    """After settlement only; count each inode once, report sparse allocated bytes."""
    root=Path(root);seen=set();rows=[]
    if not root.exists():return dict(files=[],logical_bytes=0,allocated_bytes=0)
    for parent,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            p=Path(parent)/name
            assert not p.is_symlink(),('Cache inventory must not follow aliases',str(p))
        for name in files:
            p=Path(parent)/name;st=p.stat();identity=(st.st_dev,st.st_ino)
            if identity in seen:continue
            seen.add(identity)
            rows.append(dict(path=str(p.relative_to(root)),device=st.st_dev,inode=st.st_ino,logical_bytes=st.st_size,allocated_bytes=st.st_blocks*512))
    return dict(files=rows,logical_bytes=sum(x['logical_bytes'] for x in rows),allocated_bytes=sum(x['allocated_bytes'] for x in rows))


def prove_cycle(receipts):
    """Internal adapter contract, NOT an implemented compiler trace protocol.

    Adapter must bind raw event offsets/hashes to each receipt. Distinct kind names
    explicitly separate mixed-segment compaction from whole-owner/coarse retention.
    """
    compact={};retired=[]
    for event in receipts:
        assert event.get('evidence'), 'Cycle receipts require raw evidence references'
        kind=event['kind']
        if kind=='mixed-compaction-completed':
            assert event['input_generation']!=event['output_generation']
            assert event['copied_payload_bytes']>0 and event['mixed_segments_rewritten']>0
            assert event['publication_committed'] is True and event['writers_reaped'] is True
            compact[event['output_generation']]=event
        elif kind=='physical-reclamation-completed':
            assert event['pins_released'] is True and event['writers_reaped'] is True
            assert event['reclaimed_allocated_bytes']>0 and event['removed_objects']
            retired.append(event)
        elif kind in ('coarse-trim','compaction-due','space-reservation','publication-refused'):
            continue
        else:raise AssertionError(('Unknown maintenance receipt kind',kind))
    for retire in retired:
        build=compact.get(retire['retained_generation'])
        if build and retire['monotonic_ns']>=build['monotonic_ns']:
            assert build['input_generation'] in retire['retired_generations']
            return dict(compaction=build,reclamation=retire)
    return None


def run_settled(command,cwd,env,log,cache_root,artifact=None):
    """One invocation's exact subreaper CPU and foreground/settled times.

    Caller owns exclusive performance.lock for the complete sequence. A cheap
    statvfs sample records global filesystem high-water evidence at <=100ms waits;
    this is an observed bound, never an exact per-cache peak. Full cache traversal
    occurs only after every descendant is reaped, outside compiler timings.
    """
    context=mp.get_context('fork');receiver,sender=context.Pipe(duplex=False)
    process=context.Process(target=supervise,args=(sender,command,str(cwd),env,str(log),[]))
    process.start();sender.close();row={};samples=[];error=None
    try:
        while True:
            stat=os.statvfs(cwd);samples.append(dict(at_ns=time.monotonic_ns(),free_bytes=stat.f_bavail*stat.f_frsize))
            if not wait([receiver],timeout=.1):
                assert process.is_alive(),'Supervisor exited without settlement'
                continue
            event=receiver.recv();kind=event.pop('event');row.update(event)
            if kind=='foreground' and row['exit_code']==0 and artifact is not None:
                retained=Path(str(log)+'.artifact');os.link(artifact,retained);row['retained_artifact']=str(retained)
            if kind in ('settled','error'):
                error=event.get('error') if kind=='error' else None
                break
    finally:
        process.join();receiver.close()
    assert error is None and process.exitcode==0,('Supervisor failed',error,process.exitcode)
    assert row['exit_code']==0 and all(x['exit_code']==0 for x in row['detached'])
    row.update(all_children_reaped=True,cache_after_settlement=physical_inventory(cache_root),filesystem_samples=samples,
        observed_minimum_free_bytes=min(x['free_bytes'] for x in samples),
        observed_filesystem_growth_bytes=max(0,samples[0]['free_bytes']-min(x['free_bytes'] for x in samples)),
        peak_limit='Observed global filesystem high water, sampled at 100ms; transient peaks between samples and attribution to individual cache objects are not proven.')
    return row


def bounded_maintenance(run_stage,read_receipts,maximum_edits):
    """Adapter drives substantive deterministic edits; no silent unlimited retry.

    run_stage must persist each row immediately, preserving source/cache and owning
    the exclusive lock, and validate ordinary diagnostic/native/artifact behavior.
    Baseline replay later uses this exact observed edit schedule/count.
    """
    assert 1<=maximum_edits<=128,'An explicit bounded diagnostic cap is required'
    rows=[run_stage('cold',0)];events=[]
    for index in range(1,maximum_edits+1):
        row=run_stage('edit',index);rows.append(row)
        assert row['all_children_reaped']
        events.extend(read_receipts(row));cycle=prove_cycle(events)
        if cycle:
            unchanged=run_stage('unchanged-after-cycle',index)
            assert unchanged['all_children_reaped'] and unchanged['source_mutated'] is False
            rows.append(unchanged)
            return dict(status='cycle-complete',cycle=cycle,rows=rows,edits=index,matched_baseline_schedule=[(r['stage'],r['edit_index']) for r in rows])
    return dict(status='cycle-not-reached',rows=rows,edits=maximum_edits,receipts=events,accepted=False)


def correctness_schedule():
    return [dict(case='policy-toggle',operation=op,mode=mode,source='same',directory='same')
            for mode in ('off','on','off') for op in ('build','check','build')]
