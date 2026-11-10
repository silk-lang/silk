#!/usr/bin/env python3
"""Decode one immutable CLI invocation's query census. Never combine different source snapshots."""
import argparse, collections, hashlib, json, pathlib, struct
NAMES=('starts','finishes','hits','preexisting_unit_hits','new_unit_hits','unmatched_finishes','provenance_mentions')
REASONS={1:'origin',2:'condition',3:'profile',4:'local_index',5:'suspension',6:'identity_limit',7:'family',8:'dump_limit'}
def read(path):
    data=path.read_bytes(); at=0
    def word():
        nonlocal at
        if at+8>len(data): raise ValueError(f'{path}: truncated word')
        n=struct.unpack_from('>Q',data,at)[0]; at+=8; return n
    def field():
        nonlocal at
        n=word()
        if n>len(data)-at: raise ValueError(f'{path}: truncated field')
        b=data[at:at+n]; at+=n; return b
    if field()!=b'silk-query-runs-v1': raise ValueError(f'{path}: wrong magic')
    pid,worker,phase,boundary,dropped=(word() for _ in range(5)); stamp=field(); count=word()
    if count>131072 or phase>2: raise ValueError(f'{path}: bad header')
    rows=[]
    for _ in range(count):
        family,unit,reason=(word() for _ in range(3)); identity=field()
        values=[word() for _ in NAMES]
        if (reason==0) != bool(identity): raise ValueError(f'{path}: identity/status mismatch')
        rows.append((family,unit,reason,identity,values))
    if at!=len(data): raise ValueError(f'{path}: trailing bytes')
    return dict(path=str(path),pid=pid,worker=worker,phase=phase,boundary=boundary,dropped=dropped,stamp=stamp,rows=rows)
def summarize(paths, invocation):
    latest={}; phases=collections.defaultdict(set)
    for p in paths:
        d=read(p); pid=d['pid']; phase=d['phase']
        if phase in phases[pid]: raise ValueError(f'duplicate PID/phase {pid}/{phase}: isolate one invocation')
        phases[pid].add(phase)
        if pid not in latest or latest[pid]['phase']<phase: latest[pid]=d
    groups={}; totals=collections.defaultdict(collections.Counter); excluded=collections.defaultdict(collections.Counter)
    for d in latest.values():
        for family,unit,reason,identity,values in d['rows']:
            counts=dict(zip(NAMES,values)); totals[family].update(counts)
            if reason:
                excluded[REASONS.get(reason,str(reason))].update(counts); continue
            key=(d['stamp'],family,identity)
            groups.setdefault(key,collections.Counter())[d['pid']]+=values[0]
    exact=collections.defaultdict(collections.Counter)
    for (_,family,_), per_pid in groups.items():
        runs=sum(per_pid.values()); producers=sum(v>0 for v in per_pid.values())
        if runs:
            exact[family].update(unique_started_keys=1,provider_starts=runs,
                repeated_starts=runs-1,cross_process_repeats=max(0,producers-1),
                same_process_repeats=runs-producers)
    return dict(invocation=invocation,warning='Counts are not CPU savings. Source snapshot equality is supplied by the invocation harness. Phase 0-only workers are incomplete for retained work.',
        processes=[{k:d[k] for k in ('path','pid','worker','phase','boundary','dropped')} for d in latest.values()],
        stamps=sorted({hashlib.sha256(d['stamp']).hexdigest() for d in latest.values()}),
        all_rows_by_family=dict(totals),supported_exact_by_family=dict(exact),excluded_by_reason=dict(excluded))
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--invocation',required=True); p.add_argument('files',nargs='+',type=pathlib.Path)
    a=p.parse_args(); print(json.dumps(summarize(a.files,a.invocation),indent=2,sort_keys=True))
