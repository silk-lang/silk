from pathlib import Path
import importlib.util,os,json,shutil,hashlib
spec=importlib.util.spec_from_file_location('cold','/workspace/silk/.scratch/benchmarks/cold_bench.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path('/workspace/silk/.scratch/benchmarks/combined-build-q8h3xb20');expected=next(r for r in json.loads((root/'results.json').read_text()) if r['case']=='compiler' and r['mode']=='on');source=root/'silk';records=[]
env=dict(os.environ,SILK_CLANG='/workspace/silk/.scratch/llvm-22.1.8/bin/clang',SILK_RETAINED_BUILD='1',SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1')
for flag in ['SILK_POSTCHECK_BUILD','SILK_FINITE_ARTIFACT','SILK_FRONTIER_WARM','SILK_FRONTIER_STATIC','SILK_FRONTIER_EPHEMERAL','SILK_EXPERIMENT_DEV_PACKS']:env.pop(flag,None)
for round in range(2):
 if (source/'build').exists():shutil.rmtree(source/'build')
 log=root/('compiler-repeat-'+str(round)+'.log');r=m.measure(expected['command'],source,env,log)
 trace=log.read_text();r.update(round=round,frontier_accepted='frontier accepted' in trace,artifact_accepted='artifact accepted' in trace)
 actual={str(p.relative_to(source/'build/llvm')):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((source/'build/llvm').rglob('*')) if p.is_file()}
 r['artifacts']=actual;r['differences']=[k for k in sorted(set(actual)|set(expected['artifacts'])) if actual.get(k)!=expected['artifacts'].get(k)]
 binary=source/'build/llvm/x86_64-unknown-linux-gnu/debug/silk-compiler'
 if binary.exists():shutil.copy2(binary,root/('compiler-repeat-'+str(round)));r['binary_sha256']=hashlib.sha256(binary.read_bytes()).hexdigest()
 records.append(r);(root/'repeat-results.json').write_text(json.dumps(records,indent=2));print(json.dumps({k:v for k,v in r.items() if k!='artifacts'}),flush=True)
 if r['exit_code'] or not(r['frontier_accepted'] and r['artifact_accepted']):raise SystemExit('repeat did not accept')
print('Repeated artifact differences',[len(r['differences']) for r in records],flush=True)

raise SystemExit(1 if any(r["differences"] for r in records) else 0)
