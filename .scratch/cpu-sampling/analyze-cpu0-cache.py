#!/usr/bin/env python3
"""Offline, exact-symbol leaf/phase attribution for cpu0-cache-sequence.py."""
import collections,gzip,json,re,sys
from pathlib import Path
root=Path(sys.argv[1]);spec=json.loads((root/'spec.json').read_text())
names={a:c for a,b,c in (s.rstrip('\n').split('\t',2) for s in Path(spec['symbol_map']).open())}
pattern=re.compile(r'^cpu0-cache (.*?) at_ns=(\d+) pid=(\d+) tid=(\d+) ns=(\d+) a=(\d+) b=(\d+) c=(\d+)$')
sample=re.compile(r'^\s*(\S+)\s+(\d+)/(\d+)\s+([\d.]+):\s+(\d+)\s+cpu-clock:u:\s+(\S+)\s+(.+)\s+\((.*)\)$')
phases={'settle-inputs','fresh-image','carry-image','carried-checks-files','prune-blobs','compact-roots','encode-files','write-files'}
results=[]
for stage,path in [('cold',root),('first-edit',root/'first-edit'),('unchanged',root/'unchanged')]:
    meta=json.loads((path/'launch.json').read_text());roles={meta['root_pid']:'compiler',**{x['pid']:'writer' for x in meta['detached']}}
    events=[]
    for line in (path/'native-phases.log').read_text().splitlines():
        m=pattern.fullmatch(line)
        if m:events.append(dict(zip(['label','at','pid','tid','ns','a','b','c'],[m[1],*map(int,m.groups()[1:])])) )
    families=collections.defaultdict(lambda:dict(capture_ns=0,hash_text_ns=0,lookup_ns=0,count=0,canonical_bytes=0))
    snapshots={};phasewall=collections.defaultdict(int);intervals=[]
    for e in events:
        label=e['label'];role=roles.get(e['pid'],'unknown')
        for prefix,field in [('input-capture ','capture_ns'),('input-hash-text ','hash_text_ns'),('input-lookup ','lookup_ns')]:
            if label.startswith(prefix):
                f=families[role+'/'+label[len(prefix):]];f[field]+=e['ns']
                if prefix=='input-capture ':f['count']+=e['a'];f['canonical_bytes']+=e['b']
        if label.startswith(('green-','budget-','directory-')):snapshots[(e['pid'],label)]=e
        if label in phases:
            phasewall[role+'/'+label]+=e['ns'];intervals.append((e['pid'],e['at']-e['ns'],e['at'],label))
    cpu=collections.Counter();leaf=collections.defaultdict(collections.Counter);phasecpu=collections.Counter();count=0
    samples=path/'samples.txt';handle=samples.open() if samples.exists() else gzip.open(str(samples)+'.gz','rt')
    with handle:
        for line in handle:
            m=sample.match(line)
            if not m:continue
            comm,pid,tid,clock,period,ip,symbol,dso=m.groups();pid=int(pid);at=round(float(clock)*1e9);sec=int(period)/1e9
            role=roles.get(pid,'observer/'+comm);name=names.get(symbol,symbol);cpu[role]+=sec;leaf[role][name]+=sec;count+=1
            for owner,start,end,label in intervals:
                if owner==pid and start<=at<=end:phasecpu[role+'/'+label]+=sec
    result=dict(stage=stage,launch=meta,samples=count,sampled_user_cpu=cpu,top_leaf={r:v.most_common(35) for r,v in leaf.items()},phase_wall_ns=phasewall,sampled_phase_cpu=phasecpu,input_families=dict(sorted(families.items(),key=lambda x:-x[1]['capture_ns'])),last_cumulative_snapshots=list(snapshots.values()))
    (path/'cache-attribution.json').write_text(json.dumps(result,indent=2)+'\n');results.append(result)
report={'limitations':['One instrumented diagnostic sequence; no original-baseline or speedup claim.','99Hz user CPU samples exclude kernel work; timer durations are elapsed wall and include instrumentation overhead.','Phase CPU intervals may nest (especially carried-checks-files/settle-inputs); do not add inclusive phases. Input family aggregates do not identify contiguous intervals.','Snapshots are cumulative per PID/adoption; only last snapshots shown and raw events retained. Budget rows are offered rows for completed attempts, not actual rows before early failure.','DWARF user stacks have partial FDE coverage; missing frames do not prove absence. Leaf symbol ownership uses exact diagnostic map, not source inline locations.','Transitions intentionally wait for all writers: this measures steady cache work, not immediate-edit interference.'],'stages':results}
(root/'cache-attribution.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps([{k:r[k] for k in ['stage','sampled_user_cpu','phase_wall_ns','sampled_phase_cpu']} for r in results],indent=2))
