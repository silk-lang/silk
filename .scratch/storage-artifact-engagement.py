"""Focused retained-artifact regression, then optional original full compiler. Scheduled shared lock only."""
from pathlib import Path
import argparse,hashlib,importlib.util,io,json,os,shutil,subprocess,tarfile,tempfile
s=Path('/workspace/silk/.scratch');p=argparse.ArgumentParser();p.add_argument('--candidate',type=Path,required=True);p.add_argument('--tree',type=Path,required=True);p.add_argument('--full',action='store_true');a=p.parse_args();assert shutil.disk_usage(s).free>=900*1024*1024
meta=json.loads((s/'benchmarks/component-edits-pdsji6wg/metadata.json').read_text());root=Path(tempfile.mkdtemp(prefix='storage-artifact-engagement-',dir=s/'benchmarks'));print(root,flush=True)
spec=importlib.util.spec_from_file_location('b',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
env={k:v for k,v in os.environ.items() if not k.startswith('SILK_') and k not in ['LD_PRELOAD','LLVM_PROFILE_FILE']};env.update(meta['environments']['build']);os.sched_setaffinity(0,set(meta['cpus']))
if a.full:
 archive=subprocess.check_output(['git','-C','/workspace/silk-baseline','archive',meta['revisions']['silk']]);work=root/'silk';work.mkdir()
 with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:bundle.extractall(work,filter='data')
 stdlib=work/'stdlib';command=[str(a.candidate),'build','--package','silk-compiler','--stdlib',str(stdlib),'--progress','plain','--timings'];artifact=work/'build/llvm/x86_64-unknown-linux-gnu/debug/silk-compiler';workload_sha=hashlib.sha256(archive).hexdigest()
else:
 work=root/'fixture';(work/'src').mkdir(parents=True);(work/'silk.toml').write_text('[package]\nname="storage-artifact"\nversion="0.0.0"\n')
 text=(a.tree/'corpus/native/raw-buffer-resize-preserves-elements/main.silk').read_text();text=text.replace('pub fn main() -> i32','fn storageMain() -> i32')
 names=['pad'+str(i).zfill(2) for i in range(40)]
 for name in names:(work/'src'/(name+'.silk')).write_text('pub fn answer() -> i32 { return 0 }\n')
 (work/'src/main.silk').write_text('\n'.join('import '+name for name in names)+'\n'+text+'\npub fn main() -> i32 { return storageMain() + '+' + '.join(n+'.answer()' for n in names)+' }\n')
 env['SILK_FRONTIER_WARM']='0';stdlib=a.tree/'stdlib';command=[str(a.candidate),'build','--stdlib',str(stdlib),'--progress','plain','--timings'];artifact=work/'build/llvm/x86_64-unknown-linux-gnu/debug/storage-artifact';workload_sha=hashlib.sha256((work/'src/main.silk').read_bytes()).hexdigest()
(root/'metadata.json').write_text(json.dumps({'candidate':str(a.candidate),'candidate_sha256':hashlib.sha256(a.candidate.read_bytes()).hexdigest(),'source':subprocess.check_output(['git','-C',str(a.tree),'rev-parse','HEAD'],text=True).strip(),'full':a.full,'workload_sha256':workload_sha,'revisions':meta['revisions'],'environment':{k:v for k,v in env.items() if k.startswith('SILK_')},'command':command,'purpose':'Proof-path regression only, shared CPU overlap; all selected artifact/pipeline stages mandatory'},indent=2)+'\n')
r=b.measure(command,work,env,root/'build.log');(root/'result.json').write_text(json.dumps(r,indent=2)+'\n');assert r['exit_code']==0 and all(x['exit_code']==0 for x in r['detached'])
trace=(root/'build.log').read_text();required=['frontier accepted','frontier artifact proved','frontier artifact emitted','frontier artifact accepted'];required+=['frontier native coordinator started','frontier native cache checkpoint','frontier native objects published'] if a.full else [];missing=[x for x in required if x not in trace];assert not missing,missing
assert 'frontier artifact refused' not in trace and 'frontier artifact graph refused' not in trace
shutil.copy2(artifact,root/'artifact');run=subprocess.run([str(artifact),*(['--help'] if a.full else [])],capture_output=True,timeout=20);(root/'runtime.stdout').write_bytes(run.stdout);(root/'runtime.stderr').write_bytes(run.stderr);assert run.returncode==(0 if a.full else 42)
(root/'passed.json').write_text(json.dumps({'artifact_sha256':hashlib.sha256(artifact.read_bytes()).hexdigest(),'runtime_exit':run.returncode,'required_trace':required},indent=2)+'\n');print('PASS '+str(root),flush=True)
