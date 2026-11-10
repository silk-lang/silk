"""Correctness-only; run under shared performance lock, not a timing claim."""
import hashlib,importlib.util,json,os,re,shutil
from pathlib import Path
scratch=Path('/workspace/silk/.scratch');root=scratch/'benchmarks/transport-family-ctvjs_tx';source=root/'silk'
compiler=scratch/'frontier-balanced'
spec=importlib.util.spec_from_file_location('cold',scratch/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
rows=[];expected=None
for mode in ['cached','balanced']:
 shutil.rmtree(source/'build',ignore_errors=True)
 env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_FINITE_'))}
 env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1')
 if mode=='balanced':env.update(SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1')
 for phase in ['cold','warm']:
  log=scratch/f'balanced-proof-{mode}-{phase}.log'
  command=['timeout','90s',str(compiler),'check','--package','silk-compiler','--stdlib',str(root/'silk/stdlib'),'--progress','never','--json']
  row=b.measure(command,source,env,log);text=log.read_text();lines=text.splitlines();diagnostics=[x for x in lines if not x.startswith('frontier ')]
  row.update(mode=mode,phase=phase,accepted='frontier accepted' in lines,split=any(x.startswith('frontier split ') for x in lines),forks=sum(int(x)>=4 for x in re.findall(r'^frontier private fork .* a=(\d+)',text,re.M)),chunks=text.count('frontier declaration chunk '),diagnostics=diagnostics)
  rows.append(row);(scratch/'balanced-warm-proof.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(row),flush=True)
  assert row['exit_code']==0 and all(x['exit_code']==0 for x in row['detached']), f'{mode}/{phase}: failed'
  assert not row['split'] or row['accepted'], f'{mode}/{phase}: parallel fallback'
  if expected is None:expected=diagnostics
  assert diagnostics==expected, f'{mode}/{phase}: diagnostics changed'
