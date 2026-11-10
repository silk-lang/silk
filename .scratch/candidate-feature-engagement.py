#!/usr/bin/env python3
"""One diagnostic original-compiler build; owns exclusive lock, never a speed claim.

Run only after source/native gates and explicit scheduling. Historical runners
are unchanged. All compiler descendants settle before parsing or runtime smoke.
"""
import argparse
import collections
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

SCRATCH = Path('/workspace/silk/.scratch')
sys.path.insert(0, str(SCRATCH/'incremental_reporting'))
from feature_sequence import common_environment, validate_construction

WORKLOAD_REVISION = 'a63f612150a0b91a118c8111b910b12c3e124b50'
TRACE = re.compile(r'^frontier (?P<label>.+) ms=(?P<ms>\d+) a=(?P<a>\d+) b=(?P<b>\d+)$')
COUNT_LABELS = ('executable count certified', 'executable count text emitted', 'executable count text reused')
SCHEMA_LABELS = ('executable schema certified', 'executable mir template reused',
                 'executable schema text emitted', 'executable schema text reused')
THREAD_METRICS = ('body avoided', 'body published', 'body eligible', 'body refused', 'mir owned', 'mir skipped')
SHARED_METRICS = ('eligible', 'misses', 'encoded', 'unsupported', 'guard-refused',
                  'guard-context-nodes', 'guard-cycle-nodes', 'guard-limit-nodes',
                  'published', 'capsule-bytes', 'arena-bytes')


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2)+'\n')


def parse_feature(trace, feature):
    if feature in ('checked-plan','runtime-preparation'):
        path=SCRATCH/'runtime-plan-census.py'
        spec=importlib.util.spec_from_file_location('runtime_plan_census',path)
        census=importlib.util.module_from_spec(spec);spec.loader.exec_module(census)
        result=census.parse(trace,require_final=True,schema='preparation-v1' if feature=='runtime-preparation' else 'plan-v1');result['feature']=feature
        return result
    records = []
    for number, line in enumerate(trace.splitlines(), 1):
        m = TRACE.fullmatch(line)
        if m:
            records.append(dict(line=number, label=m['label'], ms=int(m['ms']), a=int(m['a']), b=int(m['b'])))
        elif line.startswith(('frontier executable count ', 'frontier executable schema ', 'frontier executable mir template ', 'frontier executable closure ', 'frontier artifact closure roots', 'frontier body-share ', 'frontier thread ')):
            raise AssertionError(('Malformed feature trace', number, line))
    if feature == 'executables':
        old = [r for r in records if r['label'] in COUNT_LABELS]
        schema = [r for r in records if r['label'] in SCHEMA_LABELS]
        assert not (old and schema), 'Mixed legacy Count/new schema trace protocols; do not merge runs'
        labels = SCHEMA_LABELS if schema else COUNT_LABELS
        selected = schema if schema else old
        counts = {label:sum(r['label']==label for r in selected) for label in labels}
        required = SCHEMA_LABELS if schema else COUNT_LABELS[:2]
        return dict(feature=feature, trace_protocol='schema-template' if schema else 'legacy-count',
            raw_records=selected, event_counts=counts, engaged=all(counts[label]>0 for label in required),
            identity_limit='Trace has no PID. a is store-local; repeated events across processes are NOT unique definitions. No deduplication or CPU saving is inferred.',
            template_kind_note=('New schema events combine Count and Resize, and finalized MIR template reuse applies to both. No schema-kind field is emitted: this validates the combined executable-schema/template package, not isolated Resize reuse.' if schema else 'Legacy Count-only text sharing; no MIR template reuse claim.'),
            engagement_contract=('Require actual schema certification, MIR template reuse, emitted schema text and schema text reuse.' if schema else 'At least one certified Count and one emitted Count body; text reuse is reported separately, not assumed.'))
    if feature == 'closure':
        schema=parse_feature(trace,'executables')
        assert not any(r['label']=='executable closure refused' for r in records), 'Executable selector refused and fell back'
        proved=[r for r in records if r['label']=='artifact proved']
        emitted=[r for r in records if r['label']=='artifact emitted']
        assert len(proved)==len(emitted)==1, 'Closure requires one terminal full-proof/selected-emission pair; multiple attempts are ambiguous'
        full=proved[0];selected=emitted[0]
        assert full['line']<selected['line'], 'Closure emission precedes full proof'
        assert 0<selected['a']<=full['b'], 'Invalid selected/full definition counts'
        roots=[r for r in records if r['label']=='artifact closure roots']
        assert len(roots)<=1, 'Ambiguous executable/proof root snapshots'
        if roots:
            assert roots[0]['line']<selected['line'], 'Root selection snapshot follows emission'
            assert 0<roots[0]['a']<=roots[0]['b'], 'Invalid executable/expanded proof root counts'
        return dict(feature=feature,schema=schema,proof_record=full,emission_record=selected,
            root_records=roots,executable_roots=roots[0]['a'] if roots else None,
            expanded_proof_roots=roots[0]['b'] if roots else None,
            logical_definitions=full['b'],selected_definitions=selected['a'],pruned_definitions=full['b']-selected['a'],
            speculative_records=[r for r in records if r['label'] in ('speculative completed','speculative work')],
            engaged=schema['engaged'] and selected['a']<full['b'],
            counter_contract='Retained artifact proved.b counts the complete validated logical definition graph; artifact emitted.a counts validated cmd5 selected entries, each reply length checked against request. Require one ordered pair and positive pruning; full artifact/native acceptance is validated separately. Speculative text may already have been warmed before selection. Not serial collected-text a-b, avoided MIR lowering or all LLVM queries, unique source declarations, replay work, or CPU savings.')
    if feature == 'threads':
        selected=[r for r in records if r['label'].startswith('thread ')]
        workers={str(i):dict(initial={},final=[],pending={}) for i in range(4)}
        for r in selected:
            worker=str(r['a']);assert worker in workers, ('Unexpected thread shard',worker)
            state=workers[worker];label=r['label'][len('thread '):]
            phase,metric=label.split(' ',1)
            assert phase in ('initial','final'), ('Unknown thread phase',label)
            assert metric in (('tasks',)+THREAD_METRICS if phase=='initial' else THREAD_METRICS), ('Unknown thread metric',label)
            if phase=='initial':
                assert metric not in state['initial'], ('Duplicate initial thread metric',worker,metric)
                assert not state['final'] and not state['pending'], ('Initial metric after final',worker)
                state['initial'][metric]=r['b']
            else:
                assert set(state['initial'])==set(('tasks',)+THREAD_METRICS), ('Final before complete initial',worker)
                if metric=='body avoided':
                    assert not state['pending'], ('Incomplete previous final snapshot',worker)
                else:
                    assert 'body avoided' in state['pending'], ('Final metric before snapshot start',worker,metric)
                assert metric not in state['pending'], ('Duplicate final metric',worker,metric)
                state['pending'][metric]=r['b']
                if metric=='mir skipped':
                    assert set(state['pending'])==set(THREAD_METRICS), ('Incomplete final snapshot',worker)
                    prior=state['final'][-1] if state['final'] else state['initial']
                    assert all(state['pending'][m]>=prior[m] for m in THREAD_METRICS), ('Nonmonotonic thread final',worker)
                    state['final'].append(state['pending']);state['pending']={}
        initial=collections.Counter();latest=collections.Counter();chosen={}
        for worker,state in workers.items():
            assert set(state['initial'])==set(('tasks',)+THREAD_METRICS), ('Missing initial thread evidence',worker)
            assert not state['pending'], ('Truncated final thread snapshot',worker)
            initial.update(state['initial'])
            last=state['final'][-1] if state['final'] else state['initial']
            latest.update({m:last[m] for m in THREAD_METRICS})
            chosen[worker]=dict(phase='final' if state['final'] else 'initial',metrics=last)
        assert not any(r['label']=='worker-transport' for r in records), 'Mixed process/thread lane evidence'
        return dict(feature=feature,raw_records=selected,workers=workers,initial_totals=dict(initial),
            latest_totals=dict(latest),selected_workers=chosen,
            engaged=initial['tasks']>0 and initial['body avoided']>0 and initial['body published']>0 and initial['mir owned']>0,
            aggregation='Exactly four logical native-thread shards0–3, initial once each. Repeated complete final snapshots are cumulative; latest supersedes initial, never sum phases. Counters have no PID/TID or exact keys, so they do not independently prove thread identity, global unique bodies, or CPU savings.')
    assert feature == 'shared-bodies'
    workers = {}; current = {}; selected = []
    for r in records:
        if not r['label'].startswith('body-share '): continue
        selected.append(r); label=r['label'][len('body-share '):]; worker=str(r['a'])
        if label in ('initial avoided', 'final avoided'):
            phase=label.split()[0]; snapshots=workers.setdefault(worker,{})
            assert phase not in snapshots, ('Duplicate worker snapshot', worker, phase)
            snapshots[phase]=dict(avoided=r['b']);current[worker]=phase
        else:
            assert worker in current, ('Metric before worker snapshot', worker, label)
            snapshot=workers[worker][current[worker]]
            assert label not in snapshot, ('Duplicate worker metric',worker,current[worker],label)
            snapshot[label]=r['b']
    expected=sorted({str(r['a']) for r in records if r['label']=='worker-transport'},key=int)
    assert set(workers)==set(expected), ('Shared trace/transport worker mismatch',list(workers),expected)
    latest={}; totals=collections.Counter()
    for worker,snapshots in workers.items():
        assert 'initial' in snapshots, ('Missing initial snapshot',worker)
        for phase,snapshot in snapshots.items():
            assert all(metric in snapshot for metric in SHARED_METRICS), ('Incomplete snapshot',worker,phase)
        if 'final' in snapshots:
            for metric,value in snapshots['initial'].items():
                assert metric in snapshots['final'] and snapshots['final'][metric]>=value, ('Nonmonotonic snapshot',worker,metric)
        phase='final' if 'final' in snapshots else 'initial'
        latest[worker]=dict(selected_phase=phase,metrics=snapshots[phase])
        for metric,value in snapshots[phase].items():
            if metric!='arena-bytes': totals[metric]+=value
    return dict(feature=feature, raw_records=selected, worker_snapshots=workers, selected_workers=latest,
        totals=dict(totals), arena_bytes_max=max((v['metrics']['arena-bytes'] for v in latest.values()),default=0),
        engaged=bool(workers) and totals['avoided']>0,
        aggregation='Final supersedes initial per logical worker; private children reset counters at fork. Arena bytes is one shared mmap, use max. Counts are local events, not unique shared identities. Original/private logical worker IDs are retained exactly; trace contains no PID.')


def validate_proof(trace, completion_policy="coordinator-overlap"):
    assert completion_policy in ("coordinator-overlap","thread-joined-before-native")
    required=['frontier accepted','frontier artifact proved','frontier artifact emitted','frontier artifact accepted',
              'frontier native coordinator started','frontier native cache checkpoint',
              'frontier native objects published','frontier native cache completed']
    if completion_policy=='thread-joined-before-native':
        assert not any(label in trace for label in required[-4:]), 'Thread lane unexpectedly entered native coordinator'
        required=required[:4]
        thread=parse_feature(trace,'threads')
        assert thread['engaged'], 'Thread proof lacks actual four-shard/shared-body engagement'
        lines=trace.splitlines();assert lines.count('frontier threads joined')==1, 'Missing or duplicate observed thread join marker'
        joined=lines.index('frontier threads joined')+1
        assert all(r['line']<joined for r in thread['raw_records']), 'Thread work reported after join'
        assert trace.index('frontier artifact emitted')<trace.index('frontier threads joined')<trace.index('frontier artifact accepted'), 'Thread join must follow emission and precede final artifact acceptance'
    assert all(label in trace for label in required), ('Missing proof/native stage',[x for x in required if x not in trace])
    for label in ['host capacity refused','frontier refused','frontier artifact refused','frontier artifact graph refused','frontier native coordinator refused']:
        assert label not in trace, ('Refused standard-policy path',label)
    events=required[-4:] if completion_policy=='coordinator-overlap' else required
    # Thread policy has no synthetic coordinator/checkpoint events. Runtime success and
    # reaping are checked by main. The nonallocating join marker must occur between
    # selected emission and final artifact acceptance; no PID/TID inference is made.
    assert all(trace.count(label)==1 for label in events), 'Duplicate native completion stage'
    offsets=[trace.index(label) for label in events]
    assert offsets==sorted(offsets), 'Native completion stages out of order'
    return required


def engagement_environment(base,feature):
    clean={k:v for k,v in base.items() if not k.startswith('SILK_') and k not in ('LD_PRELOAD','LLVM_PROFILE_FILE')}
    env=common_environment(clean,'build','shared-bodies' if feature in ('threads','checked-plan','runtime-preparation') else 'executables' if feature=='closure' else feature,'reference' if feature in ('threads','checked-plan','runtime-preparation') else 'candidate')
    if feature=='threads': env['SILK_EXPERIMENT_THREADS']='1'
    if feature in ('checked-plan','runtime-preparation'): env['SILK_RUNTIME_PLAN_CENSUS']='1'
    if feature=='closure': env['SILK_EXECUTABLE_CLOSURE']='1'
    if feature in ('executables','closure'): env['SILK_EXECUTABLE_TRACE']='1'
    return clean,env


class HashingReader:
    def __init__(self, stream): self.stream=stream;self.digest=hashlib.sha256()
    def read(self, size=-1):
        data=self.stream.read(size);self.digest.update(data);return data


def snapshot(destination):
    destination.mkdir()
    process=subprocess.Popen(['git','-C','/workspace/silk-baseline','archive',WORKLOAD_REVISION],stdout=subprocess.PIPE)
    reader=HashingReader(process.stdout)
    try:
        with tarfile.open(fileobj=reader,mode='r|') as archive: archive.extractall(destination,filter='data')
        while reader.read(1024*1024): pass
    finally:
        process.stdout.close();status=process.wait()
    assert status==0, 'Frozen source archive failed'
    return reader.digest.hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary',type=Path,required=True)
    parser.add_argument('--source',required=True)
    parser.add_argument('--binary-sha256',required=True)
    parser.add_argument('--construction',type=Path,required=True)
    parser.add_argument('--construction-sha256',required=True)
    parser.add_argument('--feature',choices=('executables','shared-bodies','threads','closure','checked-plan','runtime-preparation'),required=True)
    parser.add_argument('--completion-policy',choices=('coordinator-overlap','thread-joined-before-native'),default='coordinator-overlap')
    parser.add_argument('--minimum-free-mib',type=int,default=1536)
    args=parser.parse_args()
    assert (args.feature=='threads')==(args.completion_policy=='thread-joined-before-native'), 'Thread feature requires explicit thread completion policy; other features require coordinator policy'
    assert re.fullmatch('[0-9a-f]{40}',args.source)
    args.binary=args.binary.resolve();args.construction=args.construction.resolve()
    with (SCRATCH/'performance.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        assert sha(args.binary)==args.binary_sha256, 'Binary pin changed'
        assert sha(args.construction)==args.construction_sha256, 'Construction receipt changed'
        construction=json.loads(args.construction.read_text())
        pin=dict(binary=str(args.binary),source=args.source,sha256=args.binary_sha256,construction=str(args.construction))
        validate_construction({m:pin for m in ('reference','candidate')},{m:construction for m in ('reference','candidate')})
        assert shutil.disk_usage(SCRATCH).free>=args.minimum_free_mib*1048576, 'Insufficient disk before full workload'
        os.sched_setaffinity(0,{0,1,2,3})
        root=Path(tempfile.mkdtemp(prefix=args.feature+'-engagement-',dir=SCRATCH/'benchmarks'))
        print(root,flush=True)
        clean,env=engagement_environment(os.environ,args.feature)
        command=[str(args.binary),'build','--package','silk-compiler','--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings']
        bench_path=SCRATCH/'benchmarks/cold_bench.py'
        spec=importlib.util.spec_from_file_location('cold_measure',bench_path);bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
        for source in (Path(__file__),SCRATCH/'runtime-plan-census.py',bench_path,SCRATCH/'incremental_reporting/feature_sequence.py',SCRATCH/'incremental_reporting/option_screen.py',SCRATCH/'incremental_reporting/lane.py'):
            shutil.copy2(source,root/source.name)
        save(root/'construction.json',construction)
        metadata=dict(feature=args.feature,completion_policy=args.completion_policy,
            thread_join_evidence=('V2 requires exactly one fixed threads-joined marker after selected emission and before final artifact acceptance, and no thread counter after that marker. Source places it after closing/joining the nonempty pool. Ordinary native ELF/help and descendant drain remain required; no PID/TID counting or inferred individual-thread identities.' if args.feature=='threads' else None),binary=str(args.binary),binary_sha256=args.binary_sha256,source=args.source,
            construction=str(args.construction),construction_sha256=args.construction_sha256,
            workload_revision=WORKLOAD_REVISION,stdlib_revision=WORKLOAD_REVISION,command=command,cpus=[0,1,2,3],
            environment={k:v for k,v in env.items() if k.startswith('SILK_')},
            harness_sha256=sha(Path(__file__)),measure_sha256=sha(bench_path),
            environment_builder_sha256=sha(SCRATCH/'incremental_reporting/feature_sequence.py'),
            purpose='Diagnostic full compiler feature/proof engagement only; trace enabled where available, no speed or N0 acceptance claim')
        save(root/'metadata.json',metadata)
        try:
            metadata['source_archive_sha256']=snapshot(root/'silk');save(root/'metadata.json',metadata)
            assert not (root/'silk/build').exists(), 'Workload was not cold'
            result=bench.measure(command,root/'silk',env,root/'build.log');save(root/'result.json',result)
            assert result['exit_code']==0 and all(c['exit_code']==0 for c in result['detached'])
            trace=(root/'build.log').read_text();required=validate_proof(trace,args.completion_policy)
            feature=parse_feature(trace,args.feature);save(root/'feature-engagement.json',feature)
            artifact=root/'silk/build/llvm/x86_64-unknown-linux-gnu/debug/silk-compiler'
            os.link(artifact,root/'artifact')
            runtime=bench.measure([str(artifact),'--help'],root,clean,root/'runtime.log');save(root/'runtime.json',runtime)
            assert runtime['exit_code']==0 and all(c['exit_code']==0 for c in runtime['detached'])
            assert (root/'runtime.log').stat().st_size>0, 'Empty compiler help'
            save(root/'proof-runtime.json',dict(artifact_sha256=sha(artifact),required_stages=required,completion_policy=args.completion_policy,all_children_reaped=True))
            assert feature['engaged'], 'Proof/runtime passed but feature engagement absent'
            save(root/'passed.json',dict(feature=args.feature,artifact_sha256=sha(artifact),all_children_reaped=True,diagnostic_only=True))
            print('PASS '+str(root),flush=True)
        except BaseException as error:
            save(root/'aborted.json',dict(error=repr(error),source_and_cache_preserved=True));raise

if __name__=='__main__':main()
