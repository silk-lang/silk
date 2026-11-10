from pathlib import Path
import hashlib,io,json,os,subprocess,tarfile,tempfile
s=Path('/workspace/silk/.scratch');root=Path(tempfile.mkdtemp(prefix='v11-cpu-check-',dir=s/'benchmarks'))
meta=json.loads((s/'benchmarks/integrated-incremental-uxdcjhol/metadata.json').read_text());binary=Path(meta['binaries']['candidate']['path'])
assert hashlib.sha256(binary.read_bytes()).hexdigest()==meta['binaries']['candidate']['sha256']
source=root/'silk';source.mkdir();data=subprocess.check_output(['git','archive',meta['revisions']['silk']],cwd='/workspace/silk-baseline')
with tarfile.open(fileobj=io.BytesIO(data)) as a:a.extractall(source,filter='data')
spec=dict(command=[str(binary),'check','--package','silk-compiler','--stdlib',str(source/'stdlib'),'--progress','plain','--timings'],cwd=str(source),cpus=meta['cpus'],original_ld_library_path=os.environ.get('LD_LIBRARY_PATH'),environment={'SILK_CLANG':str(s/'llvm-22.1.8/bin/clang'),'SILK_RETAINED_CACHE':'1','SILK_FRONTIER_EPHEMERAL':'1','SILK_EXPERIMENT_FRONTIER':'1','SILK_FRONTIER_SHARED':'1','SILK_FRONTIER_FORK_PRIVATE':'1','SILK_FRONTIER_CHUNKS':'1'},binary_sha256=meta['binaries']['candidate']['sha256'],source=meta['revisions']['silk'],source_archive_sha256=hashlib.sha256(data).hexdigest(),purpose='Diagnostic CPU attribution only; contended shared slot, not wall performance')
(root/'spec.json').write_text(json.dumps(spec,indent=2)+'\n');print(root,flush=True)
env=dict(os.environ,LD_LIBRARY_PATH=str(s/'profilers/root/usr/lib/x86_64-linux-gnu'),DEBUGINFOD_URLS='')
os.sched_setaffinity(0,set(spec['cpus']))
command=[str(s/'profilers/root/usr/bin/perf'),'record','-e','cpu-clock:u','-F','99','--clockid','mono','--no-bpf-event','-B','-N','-o',str(root/'perf.data'),'--','python3',str(s/'cpu-sampling/launch.py'),str(root)]
(root/'perf-command.json').write_text(json.dumps(command,indent=2)+'\n')
with (root/'perf.log').open('wb') as log:result=subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT)
assert result.returncode==0,(root,result.returncode)
with (root/'samples.txt').open('wb') as samples:
 subprocess.run([str(s/'profilers/root/usr/bin/perf'),'script','-i',str(root/'perf.data'),'-F','comm,pid,tid,time,event,ip,sym,dso,period'],env=env,stdout=samples,check=True)
print('Finished '+str(root),flush=True)
