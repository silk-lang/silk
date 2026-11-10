#!/usr/bin/env python3
"""Fail-closed census coverage for one drained perf-recorded compiler invocation.
Requires task fork/exec/exit records and BOTH diagnostic flags. Never infers worker coverage
from dump files alone. The caller supplies the compiler PID from its launch receipt.
"""
import argparse,collections,importlib.util,json,pathlib,re
spec=importlib.util.spec_from_file_location('census',pathlib.Path(__file__).with_name('query-run-census.py')); census=importlib.util.module_from_spec(spec);spec.loader.exec_module(census)
def validate(tasks,events,root,paths,lane):
    errors=[]; parents={}; exits=set(); execs={}; points=collections.defaultdict(list)
    for line in tasks.splitlines():
        if 'PERF_RECORD_LOST' in line: errors.append('lost perf task/sample records')
        m=re.search(r'PERF_RECORD_FORK\((\d+):(\d+)\):\((\d+):(\d+)\)',line)
        if m:
            pid,tid,parent,ptid=map(int,m.groups())
            if pid==tid:
                if pid in parents and parents[pid]!=parent:errors.append(f'reused PID {pid}')
                parents[pid]=parent
        m=re.search(r'PERF_RECORD_EXIT\((\d+):(\d+)\)',line)
        if m and m[1]==m[2]:exits.add(int(m[1]))
        m=re.search(r'PERF_RECORD_COMM exec: (.*):(\d+)/(\d+)',line)
        if m and m[2]==m[3]:execs[int(m[2])]=m[1]
    descendants={root}
    while True:
        more=descendants|{p for p,par in parents.items() if par in descendants}
        if more==descendants:break
        descendants=more
    if root not in execs:errors.append('root compiler exec missing')
    for line in events.splitlines():
        m=re.search(r'cpu0-cache (\S+) at_ns=(\d+) pid=(\d+) tid=(\d+) ns=(\d+) a=(\d+) b=(\d+) c=(\d+)',line)
        if m:
            label=m[1];ns,pid,tid,duration,a,b,c=map(int,m.groups()[1:]);points[pid].append(dict(label=label,at=ns,tid=tid,ns=duration,a=a,b=b,c=c))
    packets={};by_pid=collections.defaultdict(dict)
    for path in paths:
        d=census.read(path);key=(d['pid'],d['phase'])
        if key in packets:errors.append(f'duplicate dump {key}')
        packets[key]=d;by_pid[d['pid']][d['phase']]=d
        if d['pid'] not in descendants:errors.append(f'dump PID outside compiler tree {d["pid"]}')
    roles={root:'coordinator'}
    for pid in descendants-{root}:
        labels={p['label'] for p in points[pid]}
        if 'native-coordinator-work-begin' in labels:roles[pid]='native-coordinator'
        elif any(p['label']=='query-census-dump-begin' and p['a']==0 for p in points[pid]):roles[pid]='semantic-worker'
        elif 'write-files' in labels:roles[pid]='cache-writer'
        elif pid in execs and execs[pid]!=execs.get(root):roles[pid]='native-tool'
        else:errors.append(f'unclassified compiler descendant {pid} parent={parents.get(pid)} exec={execs.get(pid)}')
    for pid in descendants:
        if pid not in exits:errors.append(f'missing process exit {pid}')
    workers=[pid for pid,r in roles.items() if r=='semantic-worker']
    if lane=='serial' and workers:errors.append(f'serial lane has semantic workers {workers}')
    if lane=='parallel' and len(workers)<4:errors.append(f'parallel lane has only {len(workers)} semantic workers')
    expected={(root,2)}|{(p,phase) for p in workers for phase in (0,1)}
    for pid,phase in set(packets)-expected:errors.append(f'unexpected dump {pid}/{phase}')
    for pid,phase in expected:
        begins=[p for p in points[pid] if p['label']=='query-census-dump-begin' and p['a']==phase]
        ends=[p for p in points[pid] if p['label']=='query-census-dump-end' and p['a']==phase]
        if len(begins)!=1 or len(ends)!=1:errors.append(f'dump interval count {pid}/{phase}: {len(begins)}/{len(ends)} (possible second store or failed dump)')
        d=packets.get((pid,phase))
        if d is None:errors.append(f'missing dump {pid}/{phase}');continue
        if len(begins)==len(ends)==1:
            if begins[0]['at']>ends[0]['at']:errors.append(f'reversed interval {pid}/{phase}')
            if begins[0]['b']!=len(d['rows']):errors.append(f'row count mismatch {pid}/{phase}')
            if ends[0]['b']!=pathlib.Path(d['path']).stat().st_size:errors.append(f'byte count mismatch {pid}/{phase}')
        if d['dropped']:errors.append(f'event capacity exhausted {pid}/{phase}: {d["dropped"]}')
        if any(row[2] in (4,6,8) for row in d['rows']):errors.append(f'identity/index limit exclusions {pid}/{phase}')
    if (root,2) in packets and packets[root,2]['worker']!=(1<<64)-1:errors.append('coordinator worker identity is not MAX')
    logical=[]
    for pid in workers:
        if (pid,0) in packets and (pid,1) in packets:
            a,b=packets[pid,0],packets[pid,1]
            if a['worker']!=b['worker'] or a['boundary']!=b['boundary'] or a['stamp']!=b['stamp']:errors.append(f'worker header changed {pid}')
            before={row[1]:row for row in a['rows']};after={row[1]:row for row in b['rows']}
            for unit,row in before.items():
                later=after.get(unit)
                if later is None or later[0]!=row[0] or any(y<x for x,y in zip(row[4],later[4])):
                    errors.append(f'cumulative counters lost/rebound {pid}/unit{unit}')
                elif row[2]==later[2]==0 and row[3]!=later[3]:
                    errors.append(f'unit exact identity changed {pid}/unit{unit}')
            logical.append(b['worker'])
    if len(logical)!=len(set(logical)):errors.append('duplicate logical worker identity')
    if lane=='parallel' and not {0,1,2,3}<=set(logical):errors.append('missing initial logical worker 0..3')
    return dict(complete=not errors,errors=errors,root_pid=root,lane=lane,roles=roles,process_count=len(descendants),semantic_workers=workers,logical_workers=logical,dump_count=len(packets))
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--tasks',type=pathlib.Path,required=True);p.add_argument('--events',type=pathlib.Path,required=True);p.add_argument('--root-pid',type=int,required=True);p.add_argument('--lane',choices=['serial','parallel'],required=True);p.add_argument('dumps',nargs='+',type=pathlib.Path)
    a=p.parse_args();r=validate(a.tasks.read_text(),a.events.read_text(),a.root_pid,a.dumps,a.lane);print(json.dumps(r,indent=2,sort_keys=True));raise SystemExit(0 if r['complete'] else 1)
