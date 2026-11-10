from pathlib import Path
import hashlib, importlib.util, io, json, os, re, shutil, subprocess, tarfile, tempfile
s=Path('/workspace/silk/.scratch'); binary=s/'frontier-cache-v8'; revision='3eb51811ab9f0cf8d2ca0529e47810f792e177a3'
spec=importlib.util.spec_from_file_location('bench',s/'benchmarks/cold_bench.py');bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
root=Path(tempfile.mkdtemp(prefix='v8-retained-compiler-',dir=s/'benchmarks'));source=root/'silk';source.mkdir();print(root,flush=True)
data=subprocess.check_output(['git','archive',revision],cwd=s/'finite-integration')
with tarfile.open(fileobj=io.BytesIO(data)) as archive:archive.extractall(source,filter='data')
base={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_'))}
base['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
env=dict(base,SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_RESHARE='1',SILK_FRONTIER_CHUNKS='1',SILK_RETAINED_BUILD='1',SILK_RETAINED_CACHE='1',SILK_EXPERIMENT_DEV_PACKS='1')
metadata={'source':revision,'compiler':str(binary),'sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'environment':{k:v for k,v in env.items() if k.startswith('SILK_')},'purpose':'Shared-slot correctness only: actual descendant packet transport, full build, generated executable smoke.'}
(root/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
command=[str(binary),'build','--manifest-path',str(source/'compiler/silk.toml'),'--stdlib',str(source/'stdlib'),'--progress','plain','--timings']
log=root/'retained-build.log';result=bench.measure(command,source,env,log);trace=log.read_text();result.update(frontier_accepted='frontier accepted' in trace,artifact_accepted='artifact accepted' in trace,cache_imported='artifact cache imported' in trace)
(root/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
assert result['exit_code']==0 and all(x['exit_code']==0 for x in result['detached']),log
assert all(result[k] for k in ['frontier_accepted','artifact_accepted','cache_imported']),log
built=source/'build/llvm/x86_64-unknown-linux-gnu/debug/silk-compiler'
assert built.exists(),built
shutil.copy2(built,root/'generated-compiler')
version=subprocess.run([str(built),'--version'],capture_output=True,text=True);assert version.returncode==0,version
fixture=root/'generated-smoke';(fixture/'src').mkdir(parents=True)
(fixture/'silk.toml').write_text('[package]\nname="generated-smoke"\nversion="0.0.0"\nsilk-version="0.0.0"\n')
(fixture/'src/main.silk').write_text('fn add(left: i32, right: i32) -> i32 { return left + right }\npub fn main() -> i32 { return add(20, 22) }\n')
smoke=bench.measure([str(built),'check','--stdlib',str(source/'stdlib'),'--progress','plain'],fixture,base,root/'generated-smoke.log')
result.update(binary_sha256=hashlib.sha256(built.read_bytes()).hexdigest(),version=version.stdout.strip(),generated_smoke=smoke)
(root/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
assert smoke['exit_code']==0 and all(x['exit_code']==0 for x in smoke['detached']),root/'generated-smoke.log'
artifacts={str(p.relative_to(source/'build')):hashlib.sha256(p.read_bytes()).hexdigest() for p in (source/'build').rglob('*') if p.is_file() and p.suffix in {'.bc','.o','.ll'}}
(root/'artifact-hashes.json').write_text(json.dumps(artifacts,indent=2)+'\n')
print('PASS '+str(root),flush=True)
