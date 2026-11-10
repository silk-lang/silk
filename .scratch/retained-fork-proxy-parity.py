import os,json,shutil,hashlib,importlib.util
from pathlib import Path
root=Path('/workspace/silk/.scratch/benchmarks/combined-build-dt0u7xfh');source=root/'silk'
spec=importlib.util.spec_from_file_location('cold','/workspace/silk/.scratch/benchmarks/cold_bench.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
rows=json.loads((root/'results.json').read_text());on=rows[0]
shutil.rmtree(source/'build')
env=dict(os.environ,SILK_CLANG='/workspace/silk/.scratch/llvm-22.1.8/bin/clang')
for k in list(env):
 if k.startswith('SILK_FRONTIER_') or k.startswith('SILK_EXPERIMENT_') or k in ('SILK_RETAINED_BUILD','SILK_POSTCHECK_BUILD','SILK_FINITE_ARTIFACT','SILK_PARALLEL_EMIT'):env.pop(k,None)
r={'case':'compiler','mode':'off',**m.measure(on['command'],source,env,root/'compiler-off.log')}
binary=source/'build/llvm/x86_64-unknown-linux-gnu/debug/silk-compiler'
if r['exit_code']==0:
 shutil.copy2(binary,root/'compiler-off');r['binary_sha256']=hashlib.sha256(binary.read_bytes()).hexdigest();ar=source/'build/llvm';r['artifacts']={str(p.relative_to(ar)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(ar.rglob('*')) if p.is_file()}
rows.append(r);(root/'results.json').write_text(json.dumps(rows,indent=2))
comparison={'binary_equal':r.get('binary_sha256')==on['binary_sha256'],'differences':[k for k in sorted(set(r.get('artifacts',{}))|set(on['artifacts'])) if r.get('artifacts',{}).get(k)!=on['artifacts'].get(k)],'exit_code':r['exit_code']}
(root/'proxy-parity.json').write_text(json.dumps(comparison,indent=2));print(json.dumps(comparison),flush=True)
if not comparison['binary_equal'] or comparison['differences']:raise SystemExit(1)
