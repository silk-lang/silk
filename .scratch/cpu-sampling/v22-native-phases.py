#!/usr/bin/env python3
"""Scheduled diagnostic only. One invocation; no implicit baseline or performance claim."""
from pathlib import Path
import argparse,hashlib,io,json,os,shutil,subprocess,tarfile,tempfile
p=argparse.ArgumentParser()
p.add_argument('--binary',type=Path,required=True)
p.add_argument('--compiler-source',required=True,help='Exact combined diagnostic source revision')
p.add_argument('--cpus',default='0,1,2,3')
p.add_argument('--serial',action='store_true')
p.add_argument('--control',action='store_true',help='Same diagnostic binary/events without perf')
p.add_argument('--events-off',action='store_true',help='Measure instrumentation overhead separately')
p.add_argument('--query-census',action='store_true',help='Independent expensive-query provider counters; adds encoding overhead')
p.add_argument('--operation',choices=['check','build'],default='build')
p.add_argument('--stack-bytes',type=int,choices=[0,8192,32768],default=0,help='Optional DWARF user stacks; partial FDE coverage remains')
p.add_argument('--name',default='v22-native-phases')
a=p.parse_args()
s=Path('/workspace/silk/.scratch'); here=Path(__file__).resolve().parent
if shutil.disk_usage(s).free < 1536*1024*1024:raise SystemExit('STOP: less than1536MiB free before fresh workload')
binary=a.binary.resolve(); cpus=[int(x) for x in a.cpus.split(',')]
revision='a63f612150a0b91a118c8111b910b12c3e124b50'
root=Path(tempfile.mkdtemp(prefix=a.name+'-',dir=s/'benchmarks')); source=root/'silk';source.mkdir()
data=subprocess.check_output(['git','archive',revision],cwd='/workspace/silk-baseline')
with tarfile.open(fileobj=io.BytesIO(data)) as archive:archive.extractall(source,filter='data')
environment={'SILK_CLANG':str(s/'llvm-22.1.8/bin/clang'),'SILK_EXPERIMENT_DEV_PACKS':'1'}
if not a.serial:
 environment.update({key:'1' for key in ['SILK_RETAINED_CACHE','SILK_FRONTIER_EPHEMERAL','SILK_EXPERIMENT_FRONTIER','SILK_FRONTIER_SHARED','SILK_FRONTIER_FORK_PRIVATE','SILK_FRONTIER_CHUNKS','SILK_RETAINED_BUILD','SILK_NATIVE_BUILD_PIPELINE']})
if not a.events_off:environment['SILK_CPU0_CACHE_TRACE']='1'
if a.query_census:environment['SILK_QUERY_RUN_CENSUS']='1'
spec=dict(command=[str(binary),a.operation,'--package','silk-compiler','--stdlib',str(source/'stdlib'),'--progress','plain','--timings'],cwd=str(source),cpus=cpus,original_ld_library_path=os.environ.get('LD_LIBRARY_PATH'),environment=environment,binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),compiler_source=a.compiler_source,workload_source=revision,source_archive_sha256=hashlib.sha256(data).hexdigest(),purpose='Diagnostic CPU attribution; fixedV22 policy; no wall-speed claim',sampled=not a.control,event_trace=not a.events_off,query_census=a.query_census,stack_bytes=a.stack_bytes,runner_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),launcher_sha256=hashlib.sha256((here/'launch-native-phases.py').read_bytes()).hexdigest())
shutil.copy2(__file__,root/'runner.py');shutil.copy2(here/'launch-native-phases.py',root/'launcher.py')
symbol_map=Path(str(binary)+'.symbols')
if symbol_map.exists():
 spec['symbol_map']=str(symbol_map);spec['symbol_map_sha256']=hashlib.sha256(symbol_map.read_bytes()).hexdigest()
(root/'spec.json').write_text(json.dumps(spec,indent=2)+'\n');print(root,flush=True)
before={str(p):[p.stat().st_ino,p.stat().st_size,p.stat().st_mtime_ns] for p in s.glob('frontier-failure-*.query-runs')}
(root/'query-dumps-before.json').write_text(json.dumps(before,indent=2)+'\n')
launch=['python3',str(root/'launcher.py'),str(root)]
env=dict(os.environ,LD_LIBRARY_PATH=str(s/'profilers/root/usr/lib/x86_64-linux-gnu'),DEBUGINFOD_URLS='')
os.sched_setaffinity(0,set(cpus))
perf=str(s/'profilers/root/usr/bin/perf')
command=launch if a.control else [perf,'record','-e','cpu-clock:u','-F','99','--clockid','mono','--no-bpf-event','-B','-N',*(['--user-callchains','--call-graph',f'dwarf,{a.stack_bytes}'] if a.stack_bytes else []),'-o',str(root/'perf.data'),'--',*launch]
(root/'perf-command.json').write_text(json.dumps(command,indent=2)+'\n')
with (root/'perf.log').open('wb') as log:result=subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT)
if result.returncode:raise SystemExit(f'FAILED {root}: status{result.returncode}; all evidence retained')
if not a.control:
 with (root/'samples.txt').open('wb') as samples:subprocess.run([perf,'script','-G','--ns','-i',str(root/'perf.data'),'-F','comm,pid,tid,time,event,ip,sym,dso,period'],env=env,stdout=samples,check=True)
 if a.stack_bytes:
  with (root/'stack-samples.txt').open('wb') as stacks:subprocess.run([perf,'script','--ns','-i',str(root/'perf.data'),'-F','comm,pid,tid,time,event,ip,sym,dso,period'],env=env,stdout=stacks,check=True)
 with (root/'tasks-and-samples.txt').open('wb') as tasks:subprocess.run([perf,'script','-G','--ns','-i',str(root/'perf.data'),'--show-task-events','--show-mmap-events','--show-switch-events'],env=env,stdout=tasks,check=True)
launch_meta=json.loads((root/'launch.json').read_text())
assert launch_meta['exit_code']==0 and all(d['exit_code']==0 for d in launch_meta['detached'])
collected=root/'query-runs';collected.mkdir();receipts=[]
for path in sorted(s.glob('frontier-failure-*.query-runs')):
 state=[path.stat().st_ino,path.stat().st_size,path.stat().st_mtime_ns]
 if before.get(str(path))==state:continue
 target=collected/path.name;path.rename(target)
 receipts.append(dict(original=str(path),collected=str(target),bytes=target.stat().st_size,sha256=hashlib.sha256(target.read_bytes()).hexdigest(),state=state))
(root/'query-dumps-collected.json').write_text(json.dumps(receipts,indent=2)+'\n')
if a.query_census:assert receipts,'no query-run snapshots collected'
if not a.serial:
 text=(root/'compiler.log').read_text()
 if len(cpus)==1:
  assert 'frontier host capacity refused' in text
  assert 'frontier split ' not in text and 'frontier accepted' not in text
  assert 'frontier native coordinator started' not in text
 else:
  assert 'frontier accepted' in text and 'host capacity refused' not in text
  if a.operation=='build':assert 'frontier artifact accepted' in text and 'frontier native objects published' in text
if not a.events_off and a.operation=='build':
 text=(root/'native-phases.log').read_text()
 for event in ['native-bitcode-begin','native-bitcode-end','native-clang-begin','native-clang-end']:assert event in text,event
 if not a.serial and len(cpus)>1:assert 'native-wait-end' in text
if a.operation=='build':
 artifact=source/'build/llvm/x86_64-unknown-linux-gnu/debug/silk-compiler'
 ran=subprocess.run([str(artifact),'--help'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
 (root/'runtime.stdout').write_bytes(ran.stdout);(root/'runtime.stderr').write_bytes(ran.stderr)
 (root/'runtime.json').write_text(json.dumps(dict(exit_code=ran.returncode,artifact_sha256=hashlib.sha256(artifact.read_bytes()).hexdigest()),indent=2)+'\n')
 assert ran.returncode==0
print('Finished '+str(root),flush=True)
