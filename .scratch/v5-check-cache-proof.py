"""Correctness/evidence only; caller holds shared performance lock."""
import hashlib,importlib.util,json,os,tempfile
from pathlib import Path
s=Path('/workspace/silk/.scratch');compiler=s/'frontier-ssa-persistent-v5'
spec=importlib.util.spec_from_file_location('cold',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
root=Path(tempfile.mkdtemp(prefix='v5-check-cache-',dir=s/'benchmarks'));source=root/'silk'
revision=b.snapshot(Path('/workspace/silk-baseline'),source);assert revision=='a63f612150a0b91a118c8111b910b12c3e124b50'
edit=source/'compiler/src/main.silk';original=edit.read_bytes();needle=b'Create a package or a workspace\\n';assert original.count(needle)==1
(root/'original-main.bin').write_bytes(original)
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_'))}
env.update(SILK_CLANG=str(s/'llvm-22.1.8/bin/clang'),SILK_RETAINED_CACHE='1',SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1')
metadata=dict(root=str(root),revision=revision,binary=str(compiler),sha256=hashlib.sha256(compiler.read_bytes()).hexdigest(),environment={k:v for k,v in env.items() if k.startswith('SILK_')},note='Shared-slot correctness run, not a timing claim; cold then direct edit, no priming; writers reaped; edited sources and caches retained.')
(root/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n');print(json.dumps(metadata),flush=True)
rows=[]
for stage in ['cold','first-edit']:
 if stage=='first-edit':edit.write_bytes(original.replace(needle,b'Create a package or a workspace (revision one)\\n'))
 log=root/f'{stage}.log'
 row=b.measure([str(compiler),'check','--package','silk-compiler','--stdlib',str(source/'stdlib'),'--progress','never','--json'],source,env,log)
 text=log.read_text();lines=text.splitlines();diagnostics=[json.loads(l) for l in lines if l.startswith('{')]
 cache=source/'build/cache';sizes=[p.stat().st_size for p in cache.rglob('*') if p.is_file()] if cache.exists() else []
 row.update(stage=stage,source_sha256=hashlib.sha256(edit.read_bytes()).hexdigest(),edit_marker=b'revision one' in edit.read_bytes(),accepted='frontier accepted' in lines,attempted=any(l.startswith('frontier split ') for l in lines),cache_files=len(sizes),cache_bytes=sum(sizes),diagnostics=diagnostics,cache_traces=[l for l in lines if l.startswith('frontier ') and any(x in l for x in ['cache','record','missing','accepted','failed','refused'])])
 rows.append(row);(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(row),flush=True)
 assert row['exit_code']==0 and all(x['exit_code']==0 for x in row['detached'])
 assert stage!='first-edit' or row['edit_marker']
 assert not row['attempted'] or row['accepted']
assert rows[0]['diagnostics']==rows[1]['diagnostics'],'warning diagnostics changed after help-text-only edit'
print('PASS '+str(root),flush=True)
