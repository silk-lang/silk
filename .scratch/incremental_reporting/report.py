"""Read-only baseline-relative report for incremental benchmark evidence."""
import argparse, collections, json, statistics, re
from pathlib import Path

STAGES={'edits':['cold','first-edit','second-edit'],'unchanged':['cold','unchanged'],
        'primed-edits':['cold','unchanged','first-edit','second-edit']}
LABELS={'edits':'DIRECT: cold → first edit → second edit',
        'unchanged':'UNCHANGED: cold → first unchanged',
        'primed-edits':'PRIMED: cold → unchanged → first edit → second edit'}

def phases(row):
    p=Path(row.get('log',''))
    if not p.is_file():return {}
    out={}
    for line in p.read_text().splitlines():
        m=re.match(r'^  (load|check|borrow|codegen|native|link)\s+(.+?)\s+(\d+(?:\.\d+)?)(ms|s)$',line)
        if m:out[m[1]]={'seconds':float(m[3])/(1000 if m[4]=='ms' else 1),'detail':m[2]}
        q=re.match(r'^\s+(\d+(?:\.\d+)?)(ms|s)\s+(\d+(?:\.\d+)?)(ms|s)\s+([\d,]+)\s+(\w+)$',line)
        if q:out.setdefault('queries',{})[q[6]]={'own_s':float(q[1])/(1000 if q[2]=='ms' else 1),'inclusive_s':float(q[3])/(1000 if q[4]=='ms' else 1),'runs':int(q[5].replace(',',''))}
    return out

def lane_key(r):
    return (r.get('cpu_lane', 'cpus='+','.join(map(str,r['cpus'])) if 'cpus' in r else 'CPU unspecified'),r.get('worker_policy','policy unspecified'))

def summarize(rows, threshold=1.05):
    baseline={}
    for r in rows:
        if r['mode']=='baseline':
            k=lane_key(r)+tuple(r[x] for x in ('operation','workload','sequence','stage','round'))
            if k in baseline: raise ValueError(f'duplicate baseline row: {k}')
            baseline[k]=r
    groups=collections.defaultdict(list)
    for r in rows:
        if r['mode']!='baseline':groups[lane_key(r)+tuple(r[x] for x in ('operation','workload','sequence','stage','mode'))].append(r)
    output=[]
    for key, candidates in sorted(groups.items()):
        pairs=[]; bad=[]
        for r in candidates:
            b=baseline.get(lane_key(r)+tuple(r[x] for x in ('operation','workload','sequence','stage','round')))
            valid=lambda v:v.get('exit_code')==0 and all(d.get('exit_code')==0 for d in v.get('detached',[]))
            if b is None:bad.append('missing same-round baseline');continue
            if not valid(r) or not valid(b):bad.append('failed process/writer');continue
            pairs.append((b,r))
        record=dict(zip(('cpu_lane','worker_policy','operation','workload','sequence','stage','mode'),key),executed=len(candidates),paired=len(pairs),issues=sorted(set(bad)),fallbacks=sum(bool(r.get('frontier_fallback')) for r in candidates))
        if pairs:
            record['diagnostic_mismatches']=sum(b['diagnostic_lines']!=c['diagnostic_lines'] for b,c in pairs if 'diagnostic_lines' in b and 'diagnostic_lines' in c)
            record['diagnostic_comparisons']=sum('diagnostic_lines' in b and 'diagnostic_lines' in c for b,c in pairs)
            med=lambda f:statistics.median(f(b,c) for b,c in pairs)
            record.update(baseline_s=med(lambda b,c:b['wall_s']),candidate_s=med(lambda b,c:c['wall_s']),
                baseline_settled_s=med(lambda b,c:b['settled_wall_s']),candidate_settled_s=med(lambda b,c:c['settled_wall_s']),
                foreground_speedup=med(lambda b,c:b['wall_s']/c['wall_s']),settled_speedup=med(lambda b,c:b['settled_wall_s']/c['settled_wall_s']),
                writer_tail_s=med(lambda b,c:c['settled_wall_s']-c['wall_s']),
                baseline_writer_tail_s=med(lambda b,c:b['settled_wall_s']-b['wall_s']),
                candidate_cpu_s=med(lambda b,c:sum(c.get('process_tree',c.get('primary',{})).get(k,0) for k in ('user_s','sys_s'))),
                baseline_cpu_s=med(lambda b,c:sum(b.get('process_tree',b.get('primary',{})).get(k,0) for k in ('user_s','sys_s'))))
            record['baseline_cache_bytes']=med(lambda b,c:b.get('cache_bytes',0))
            record['candidate_cache_bytes']=med(lambda b,c:c.get('cache_bytes',0))
            record['regression']=record['foreground_speedup']<1/threshold or record['settled_speedup']<1/threshold
        output.append(record)
    return output

def render(meta, rows, summary, threshold):
    lines=['# Cold and incremental compiler comparison','',
        '**Edit latency is a separate acceptance gate. Cold speedups do not compensate for edit regressions.**','',
        'Ratios are medians of paired, same-round baseline/candidate ratios. Times are medians; >1× is faster. '
        'Ratios never cross CPU-affinity or worker-policy lanes. CPU lanes describe execution affinity, not compiler construction codegen-unit count. '
        'Settled time includes every detached cache writer. Unpaired or failed runs are excluded from ratios and listed below.','']
    edits=[r for r in summary if r['stage']!='cold' and r.get('regression')]
    lines += [f'**EDIT / UNCHANGED REGRESSIONS: {len(edits)} comparisons exceed {(threshold-1)*100:.0f}% slower foreground or settled time.**','']
    for r in edits:lines.append(f"- {r['cpu_lane']} / {r['worker_policy']} / {r['operation']} / {r['workload']} / {r['sequence']} / {r['stage']} / {r['mode']}: {r['foreground_speedup']:.3f}× foreground, {r['settled_speedup']:.3f}× settled.")
    if not edits:lines.append('No measured edit/unchanged regression beyond the threshold; missing comparisons are not passes.')
    lines+=['','## Executed scope','']
    scope=collections.Counter(lane_key(r)+(r['operation'],r['workload'],r['sequence'],r['mode']) for r in rows)
    for k,n in sorted(scope.items()):lines.append(f"- {' / '.join(k)}: {n} executed invocations.")
    failed=[r for r in rows if r.get('exit_code')!=0 or any(d.get('exit_code')!=0 for d in r.get('detached',[]))]
    fallback=[r for r in rows if r.get('frontier_fallback')]
    issues=[r for r in summary if r['issues']]
    lines+=['',f'Failed invocations: {len(failed)}. Explicit frontier fallbacks: {len(fallback)}. Incompletely paired comparisons: {len(issues)}.']
    request=meta.get('requested')
    if request:
        expected=meta['rounds']*len(request['operations'])*len(request['workloads'])*len(request['modes'])*sum(len(STAGES[s]) for s in request['sequences'])
        lines+= [f'Requested invocations: {expected}; actually executed: {len(rows)}. '+('COMPLETE.' if expected==len(rows) else '**INCOMPLETE MATRIX.**')]
    else:lines+=['Original metadata does not enumerate requested scope; report only claims the invocations actually present.']
    for r in issues:lines.append(f"- {' / '.join(str(r[k]) for k in ('cpu_lane','worker_policy','operation','workload','sequence','stage','mode'))}: {', '.join(r['issues'])}")
    for seq in STAGES:
        relevant=[r for r in summary if r['sequence']==seq]
        if not relevant:continue
        lines+=['',f'## {LABELS[seq]}','']
        if seq=='primed-edits':lines+=['**These edit results may conceal a cache refill during the unchanged run; never substitute them for DIRECT edits.**','']
        lines+=['| CPU lane / worker policy | Operation / workload | Mode | Stage | Pairs | Foreground baseline → candidate | Speedup | Settled baseline → candidate | Speedup | Writer tail baseline → candidate | CPU baseline → candidate | Status |',
                '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|']
        order={s:i for i,s in enumerate(STAGES[seq])}
        for r in sorted(relevant,key=lambda r:(r['cpu_lane'],r['worker_policy'],r['operation'],r['workload'],r['mode'],order[r['stage']])):
            prefix=f"| {r['cpu_lane']} / {r['worker_policy']} | {r['operation']} / {r['workload']} | {r['mode']} | {r['stage']} | {r['paired']}/{r['executed']} |"
            if not r['paired']:lines.append(prefix+' — | — | — | — | — | — | UNPAIRED |');continue
            status='REGRESSION' if r['regression'] else 'measured'
            if r['fallbacks']:status+='; FALLBACK'
            if r['issues']:status+='; INCOMPLETE'
            if r.get('diagnostic_mismatches'):status+='; DIAGNOSTICS DIFFER'
            lines.append(prefix+f" {r['baseline_s']:.3f}s → {r['candidate_s']:.3f}s | {r['foreground_speedup']:.3f}× | {r['baseline_settled_s']:.3f}s → {r['candidate_settled_s']:.3f}s | {r['settled_speedup']:.3f}× | {r['baseline_writer_tail_s']:.3f}s → {r['writer_tail_s']:.3f}s | {r['baseline_cpu_s']:.3f}s → {r['candidate_cpu_s']:.3f}s | {status} |")
    lines+=['','## Cache bytes and executed phase evidence','',
        '| CPU lane / policy / operation / workload / sequence / stage / mode | Baseline cache MB → candidate cache MB |', '|---|---:|']
    for r in summary:
        if r['paired']:lines.append('| '+ ' / '.join(r[k] for k in ('cpu_lane','worker_policy','operation','workload','sequence','stage','mode'))+f" | {r['baseline_cache_bytes']/1e6:.3f} → {r['candidate_cache_bytes']/1e6:.3f} |")
    lines+=['','Phase seconds, body counts, and query own/inclusive/run counters for every executed invocation are preserved in the adjacent `.phases.json`; missing baseline instrumentation is left absent, not inferred.','']
    lines+=['','## Reproducibility','', '```json',json.dumps({k:meta.get(k,'not recorded') for k in ('binaries','revisions','features','cpus','cpu_lane','worker_policy','affinity_note','require_host_capacity_refusal','rounds','profile','edit','harness_sha256')},indent=2),'```','',
        'Each raw result retains its exact command, environment, source hash, log path, process/writer status and artifact marker checks. '
        'Individual-process peak RSS is not aggregate fork memory. A candidate artifact hash is not compared to a different compiler version as a correctness requirement.','']
    return '\n'.join(lines)

def main():
    p=argparse.ArgumentParser();p.add_argument('evidence',type=Path);p.add_argument('--output',type=Path);p.add_argument('--regression-threshold',type=float,default=1.05);a=p.parse_args()
    meta=json.loads((a.evidence/'metadata.json').read_text());rows=json.loads((a.evidence/'results.json').read_text())
    rows=[dict(r,cpu_lane=lane_key(dict({'cpus':meta.get('cpus',[])},**r))[0] if ('cpu_lane' in r or 'cpus' in r or 'cpus' in meta) else 'CPU unspecified',worker_policy=r.get('worker_policy',meta.get('worker_policy','prototype parallel (legacy metadata)'))) for r in rows]
    summary=summarize(rows,a.regression_threshold)
    out=a.output or a.evidence/'incremental-report.md';out.write_text(render(meta,rows,summary,a.regression_threshold))
    out.with_suffix('.phases.json').write_text(json.dumps([dict({k:r[k] for k in ('cpu_lane','worker_policy','operation','workload','sequence','stage','mode','round')},log=r.get('log'),phases=phases(r)) for r in rows],indent=2)+'\n')
    out.with_suffix('.json').write_text(json.dumps(summary,indent=2)+'\n');print(out)
if __name__=='__main__':main()
