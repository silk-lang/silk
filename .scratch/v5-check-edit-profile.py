import os,json,shutil,tempfile,importlib.util,hashlib
from pathlib import Path
s=Path('/workspace/silk/.scratch'); prior=s/'benchmarks/v5-check-cache-yf13unoc'; root=s/'benchmarks/v5-edit-profile-2bcmsbjp'; source=root/'silk'
# Prior perf denied before launching compiler; reuse unchanged copied cache.
edit=source/'compiler/src/main.silk'; data=edit.read_bytes(); assert data.count(b'(revision two)')==1
meta=json.loads((prior/'metadata.json').read_text()); env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_'))};env.update(meta['environment']);env['LD_LIBRARY_PATH']=str(s/'profilers/root/usr/lib/x86_64-linux-gnu')
spec=importlib.util.spec_from_file_location('cold',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
cmd=[str(s/'profilers/root/usr/bin/perf'),'record','-q','-e','cycles:u','-o',str(root/'perf.data'),'--',meta['binary'],'check','--package','silk-compiler','--stdlib',str(source/'stdlib'),'--progress','plain','--timings','--json']
print(json.dumps({'root':str(root),'command':cmd,'source_sha256':hashlib.sha256(edit.read_bytes()).hexdigest()}),flush=True)
r=b.measure(cmd,source,env,root/'check.log');(root/'results.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r),flush=True)
assert r['exit_code']==0 and all(x['exit_code']==0 for x in r['detached'])
