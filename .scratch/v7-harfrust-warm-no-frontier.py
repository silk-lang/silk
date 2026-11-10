import os,json,tempfile,importlib.util,hashlib
from pathlib import Path
s=Path('/workspace/silk/.scratch');spec=importlib.util.spec_from_file_location('cold',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
root=Path(tempfile.mkdtemp(prefix='v7-harf-warm-gate-',dir=s/'benchmarks'));revisions={'silk':b.snapshot(Path('/workspace/silk-baseline'),root/'silk'),'nonstd':b.snapshot(Path('/workspace/nonstd'),root/'nonstd')}
cwd=root/'nonstd/fonts/shape/tools/cli';edited=cwd/'src/main.silk';original=edited.read_bytes();needle=b'Usage: hr_shape FONT TEXT';assert original.count(needle)==1;(root/'original-main.bin').write_bytes(original)
compiler=s/'frontier-sweep-persistent-v7';env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_'))};env.update(SILK_CLANG=str(s/'llvm-22.1.8/bin/clang'),SILK_RETAINED_CACHE='1',SILK_FRONTIER_EPHEMERAL='1',SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1');os.sched_setaffinity(0,{0,1,2,3})
meta=dict(root=str(root),revisions=revisions,binary=str(compiler),binary_sha256=hashlib.sha256(compiler.read_bytes()).hexdigest(),source_revision='9eb6040ae9fff1c9b183e571f56267f9d8f36b15',note='Diagnostic only: normal parallel cold, frontier disabled only for direct warm edits; retained cache stays enabled. No intervening unchanged run; cache+editedsource retained.')
(root/'metadata.json').write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps(meta),flush=True);results=[]
for stage in ['cold','first-edit','second-edit']:
 if stage!='cold':
  env.pop('SILK_EXPERIMENT_FRONTIER',None);edited.write_bytes(original.replace(needle,needle+(b' (revision one)' if stage=='first-edit' else b' (revision two)')))
 command=[str(compiler),'check','--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings'];log=root/(stage+'.log');r=b.measure(command,cwd,env,log);text=log.read_text();r.update(stage=stage,command=command,environment={k:v for k,v in env.items() if k.startswith('SILK_')},source_sha256=hashlib.sha256(edited.read_bytes()).hexdigest(),frontier_attempted='frontier split' in text,frontier_accepted='frontier accepted' in text,cache_bytes=sum(p.stat().st_size for p in (root/'nonstd/build/cache').rglob('*') if p.is_file()),diagnostic_lines=[l for l in text.splitlines() if ': warning[' in l or ': error[' in l]);results.append(r);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(r),flush=True)
 assert r['exit_code']==0 and all(d['exit_code']==0 for d in r['detached'])
 assert r['frontier_attempted']==(stage=='cold')
assert results[0]['diagnostic_lines']==results[1]['diagnostic_lines']==results[2]['diagnostic_lines']
print('PASS '+str(root),flush=True)
