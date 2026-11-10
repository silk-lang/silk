import os,json,shutil,tempfile,importlib.util,sys,hashlib
from pathlib import Path
scratch=Path('/workspace/silk/.scratch');binary=Path(sys.argv[1]);kind=sys.argv[2]
assert kind in ('refuse','exit','exit-second')
spec=importlib.util.spec_from_file_location('cold',str(scratch/'benchmarks/cold_bench.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(tempfile.mkdtemp(prefix='private-failure-'+kind+'-',dir=scratch/'benchmarks'));source=root/'silk';revision=m.snapshot(Path('/workspace/silk-baseline'),source)
env=dict(os.environ)
for key in list(env):
 if key.startswith('SILK_FRONTIER_') or key.startswith('SILK_EXPERIMENT_') or key in ('SILK_RETAINED_BUILD','SILK_POSTCHECK_BUILD','LD_PRELOAD'):env.pop(key,None)
env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1',LD_PRELOAD=str(scratch/(kind+'-private-fork.so')))
if kind=='exit-second':env.update(SILK_FRONTIER_RESHARE='1',SILK_FRONTIER_COMPLETE_MODULES='1')
command=['timeout','--kill-after=5','90s',str(binary),'check','--package','silk-compiler','--stdlib',str(source/'stdlib'),'--progress','plain']
r=m.measure(command,source,env,root/'check.log');raw=(root/'check.log').read_text();marker='frontier injected second private child exit' if kind=='exit-second' else 'frontier injected private '+('fork refusal' if kind=='refuse' else 'child exit')
r.update(kind=kind,root=str(root),revision=revision,binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),injections=raw.count(marker),accepted='frontier accepted' in raw)
(root/'results.json').write_text(json.dumps(r,indent=2));print(json.dumps(r),flush=True)
if r['exit_code']!=0 or r['injections']==0 or (kind=='refuse' and not r['accepted']) or (kind!='refuse' and r['accepted']):raise SystemExit(1)
