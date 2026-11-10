"""Strict diagnostic snapshot parser. Counts are provider events, not time saved."""
import collections
import re
METRICS=('starts','compact','ordinary','storage','helpers','oracle','mir','verify','frame','export','glue','union','helper-oracle')
PREPARATION_METRICS=METRICS+('prepare-starts','prepared','plan-uses','mir-uses')
TRACE=re.compile(r'^frontier (?P<label>.*?) ms=(?P<ms>\d+) a=(?P<a>\d+) b=(?P<b>\d+)$')
def parse(trace, require_final=False, schema='plan-v1'):
    assert schema in ('plan-v1','preparation-v1'),('Unknown census schema',schema)
    metrics=METRICS if schema=='plan-v1' else PREPARATION_METRICS
    streams={};raw=[];transport=set()
    for line_no,line in enumerate(trace.splitlines(),1):
        m=TRACE.fullmatch(line)
        if m and m['label']=='worker-transport': transport.add(int(m['a']))
        if not line.startswith('frontier plan '):continue
        assert m,('Malformed plan event',line_no,line)
        phase,metric=m['label'][len('plan '):].split(' ',1)
        assert phase in ('initial','final','coordinator','scalar') and metric in metrics,('Unknown plan event',phase,metric)
        worker=int(m['a']);role='worker' if phase in ('initial','final') else phase
        if role!='worker':assert worker==0,('Invalid parent ordinal',phase,worker)
        key=(role,worker);s=streams.setdefault(key,{'snapshots':[],'pending':{},'phase':None})
        expected=metrics[len(s['pending'])]
        assert metric==expected,('Incomplete/out-of-order snapshot',key,expected,metric)
        if metric=='starts':
            if phase=='initial':assert not s['snapshots'],('Duplicate initial',key)
            if phase=='final':assert s['snapshots'] and s['snapshots'][0]['phase']=='initial',('Final before initial',key)
            s['phase']=phase
        assert s['phase']==phase,('Mixed snapshot phase',key)
        s['pending'][metric]=int(m['b'])
        raw.append(dict(line=line_no,phase=phase,worker=worker,metric=metric,count=int(m['b']),ms=int(m['ms'])))
        if metric==metrics[-1]:
            values=s['pending']
            assert values['compact']==values['ordinary']+values['storage'],('Compact kind mismatch',key)
            if s['snapshots']:assert all(values[k]>=s['snapshots'][-1]['metrics'][k] for k in metrics),('Nonmonotonic cumulative snapshot',key)
            s['snapshots'].append(dict(phase=phase,metrics=values));s['pending']={}
    assert streams,'Missing runtime-plan census'
    for key,s in streams.items():assert not s['pending'],('Truncated plan snapshot',key)
    worker_ids={w for role,w in streams if role=='worker'}
    assert worker_ids==transport,('Plan/transport worker coverage mismatch',worker_ids,transport)
    parent=[key for key in streams if key[0]!='worker']
    assert len(parent)==1,('Missing/ambiguous coordinator or scalar snapshot',parent)
    assert not (transport and parent[0][0]=='scalar'),'Parallel run cannot have scalar parent role'
    missing_final=[w for (role,w),s in streams.items() if role=='worker' and s['snapshots'][-1]['phase']!='final']
    if require_final:assert not missing_final,('Retained full build missing final worker accounting',missing_final)
    totals=collections.Counter();selected={}
    for (role,worker),s in streams.items():
        last=s['snapshots'][-1];selected[f'{role}:{worker}']=last;totals.update(last['metrics'])
    engaged=totals['starts']>0 and totals['compact']>0 and totals['ordinary']>0
    if schema=='preparation-v1':
        engaged=engaged and totals['prepared']>0 and totals['plan-uses']>0 and totals['mir-uses']>0 and totals['plan-uses']+totals['mir-uses']>totals['prepared']
    return dict(schema=schema,require_final=require_final,missing_final_workers=missing_final,raw_records=raw,streams={f'{r}:{w}':s for (r,w),s in streams.items()},selected=selected,totals=dict(totals),engaged=engaged,preparation_note='Preparation provider starts/publications and successful plan/MIR retrievals are event counts, not exact-key uniqueness. A consumer may later fail lowering. Both consumer types and aggregate reuse required in preparation schema; no saved-time claim.',contract='Latest cumulative snapshot per process-local logical worker; parent separate from worker0. Helper completions and explicit oracle classes retained. MIR starts may remain for valid fallback/emit paths. No unique-key, zero-MIR or CPU-saving claim.')
