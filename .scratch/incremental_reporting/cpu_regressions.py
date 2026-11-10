"""Additional CPU/writer accounting for a completed cohort; no compiler invocation."""
import argparse,json,statistics
from pathlib import Path

def total_cpu(row):
    value=row['process_tree'];return value['user_s']+value['sys_s']
def writer_cpu(row):
    return sum(child['user_s']+child['sys_s'] for child in row['detached'])
def change(before,after):
    return dict(reference_s=before,candidate_s=after,delta_s=after-before,
        ratio=after/before if before else None,increased=after>before,
        regression_gt5pct=after>before*1.05 if before else after>0)
def compare(cohorts):
    grouped={}
    for cohort in cohorts:
        assert cohort.get('validated') and cohort['all_supervisors_reaped']
        key=(cohort['operation'],cohort['workload'],cohort['round'])
        grouped.setdefault(key,{})[cohort['mode']]=cohort
    results=[]
    for (operation,workload,repeat),pair in grouped.items():
        if set(pair)!={'reference','candidate'}:continue
        for left,right in zip(pair['reference']['invocations'],pair['candidate']['invocations']):
            assert left['stage']==right['stage']
            results.append(dict(operation=operation,workload=workload,round=repeat,stage=left['stage'],
                total_cpu=change(total_cpu(left),total_cpu(right)),detached_writer_cpu=change(writer_cpu(left),writer_cpu(right)),
                foreground=change(left['wall_s'],right['wall_s']),settled=change(left['settled_wall_s'],right['settled_wall_s']),
                reference_writer_count=len(left['detached']),candidate_writer_count=len(right['detached'])))
    return results

def main():
    p=argparse.ArgumentParser();p.add_argument('cohort',type=Path);args=p.parse_args()
    rows=compare(json.loads((args.cohort/'results.json').read_text()))
    note='Every positive delta is marked as an increase; >5% flags are separate and are not statistical significance. Detached writer CPU excludes writers joined inside the compiler, whose CPU remains in total/primary wait4. Zero detached CPU is not zero total writer work. Immediate settled tails overlap and are not additive.'
    (args.cohort/'cpu-writer-regressions.json').write_text(json.dumps(dict(note=note,comparisons=rows),indent=2)+'\n')
    lines=['# CPU and writer cost changes','',note,'','| Operation / stage | Total CPU reference → candidate | CPU delta | Detached writer CPU reference → candidate | Writer delta | Increases |','|---|---:|---:|---:|---:|---|']
    for r in rows:
        cpu=r['total_cpu'];writer=r['detached_writer_cpu'];flags=[label for label,key in [('foreground','foreground'),('settled','settled'),('CPU','total_cpu'),('detached writer CPU','detached_writer_cpu')] if r[key]['increased']]
        lines.append(f"| {r['operation']} / {r['stage']} | {cpu['reference_s']:.3f} → {cpu['candidate_s']:.3f} | {cpu['delta_s']:+.3f} | {writer['reference_s']:.3f} → {writer['candidate_s']:.3f} | {writer['delta_s']:+.3f} | {', '.join(flags) or 'none'} |")
    (args.cohort/'cpu-writer-regressions.md').write_text('\n'.join(lines)+'\n')
if __name__=='__main__':main()
