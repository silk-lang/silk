"""Correctness only. Run under shared lock and an outer timeout (180s recommended)."""
import hashlib, importlib.util, json, os, re, shutil, sys
from pathlib import Path
scratch = Path('/workspace/silk/.scratch')
frozen = scratch / 'benchmarks/transport-family-ctvjs_tx/silk'
root = scratch / 'frontier-module-error-fixture'
root.mkdir(exist_ok=True)
(root/'silk.toml').write_text('[workspace]\nmembers = ["compiler", "tomledit"]\noutput-dir = "build"\n')
for name in ['compiler', 'tomledit']:
 if not (root/name).exists():
  shutil.copytree(frozen/name, root/name, ignore=shutil.ignore_patterns('build'))
source = root/'compiler/src/semantic/Semantic.silk'
original = (frozen/'compiler/src/semantic/Semantic.silk').read_text()
source.write_text(original + '\n// Deliberately unreachable: the module sweep must still reject its body.\nfn frontierUnusedBodyError() -> i32 { return true }\n')
print('Prepared compiler fixture with unused invalid module body.', flush=True)
if '--run' not in sys.argv:
 raise SystemExit(0)
compiler = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('cold',scratch/'benchmarks/cold_bench.py')
bench = importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
rows = []
for mode in ['off','on']:
 shutil.rmtree(root/'build',ignore_errors=True)
 env = {k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_FINITE_'))}
 if mode=='on':
  env.update(SILK_EXPERIMENT_FRONTIER='1', SILK_FRONTIER_SHARED='1', SILK_FRONTIER_EPHEMERAL='1', SILK_FRONTIER_FORK_PRIVATE='1', SILK_FRONTIER_CHUNKS='1', SILK_FRONTIER_COMPLETE_MODULES='1', SILK_FRONTIER_RESHARE='1')
 log = root/f'{mode}.log'
 row = bench.measure([str(compiler),'check','--package','silk-compiler','--stdlib',str(frozen/'stdlib'),'--progress','never','--json'], root, env, log)
 text = log.read_text()
 row.update(mode=mode, diagnostics=[x for x in text.splitlines() if not x.startswith('frontier ')],
  forks=sum(int(x)>=4 for x in re.findall(r'^frontier private fork .* a=(\d+)',text,re.M)),
  accepted='frontier accepted' in text, sha256=hashlib.sha256(compiler.read_bytes()).hexdigest())
 rows.append(row);(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
 print(json.dumps(row),flush=True)
 assert row['exit_code']==1, 'expected authored module rejection, not crash/timeout'
 if mode=='on':
  assert row['forks']>0, 'fixture failed to exercise an actual private descendant'
  assert not row['accepted'], 'invalid module incorrectly accepted'
assert rows[0]['diagnostics']==rows[1]['diagnostics'], 'full structured diagnostic parity changed'
assert any(json.loads(x).get('severity')=='error' for x in rows[0]['diagnostics']), 'missing error diagnostic'
print('PASS actual-donation module-error cleanup and exact diagnostic parity',flush=True)
