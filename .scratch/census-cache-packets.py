"""Frozen-source packet census; run under the assigned shared performance lock."""
import hashlib, importlib.util, json, os, re, subprocess, tempfile
from pathlib import Path
s=Path('/workspace/silk/.scratch')
spec=importlib.util.spec_from_file_location('cold',s/'benchmarks/cold_bench.py'); b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
root=Path(tempfile.mkdtemp(prefix='cache-packet-census-',dir=s/'benchmarks'))
silk=root/'silk'; nonstd=root/'nonstd'
revisions={'silk':b.snapshot(Path('/workspace/silk-baseline'),silk),'nonstd':b.snapshot(Path('/workspace/nonstd'),nonstd)}
assert revisions=={'silk':'a63f612150a0b91a118c8111b910b12c3e124b50','nonstd':'ccb168b773bb56d7bd60a3495141d427149766d0'}
compiler=s/'frontier-diagnostic-order';digest=hashlib.file_digest(compiler.open('rb'),'sha256').hexdigest()
assert digest=='886f8ae3f9a9a9d93d717a849b64c2303d627836c03a19e77f0207da5123fedc'
os.sched_setaffinity(0,{0,1,2,3})
env={k:v for k,v in os.environ.items() if not k.startswith('SILK_')}
env.update(SILK_CLANG=str(s/'llvm-22.1.8/bin/clang'),SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1',SILK_RETAINED_CACHE='1',SILK_CACHE_PACKET_CENSUS='1')
metadata={'source_revisions':revisions,'compiler':str(compiler),'compiler_sha256':digest,'compiler_source':'014c9641c','cpu_affinity':sorted(os.sched_getaffinity(0)),'env':{k:v for k,v in env.items() if k.startswith('SILK_')},'purpose':'Two original-source cold checks under shared slot. Packet representation and phase diagnostic, not authoritative wall-speed measurement. Writers reaped before next case.'}
(root/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n');print(root,flush=True)
results=[]
for workload,cwd,source,args in [('compiler',silk,silk,['--package','silk-compiler']),('harfrust',nonstd/'fonts/shape/tools/cli',nonstd,[])]:
 command=['timeout','180',str(compiler),'check',*args,'--stdlib',str(silk/'stdlib'),'--progress','plain','--timings']
 log=root/(workload+'.log'); row={'workload':workload,'command':command,**b.measure(command,cwd,env,log)}
 text=log.read_text();row['frontier_accepted']='frontier accepted' in text;row['host_capacity_refused']='frontier host capacity refused' in text
 pattern=re.compile(r'^frontier (cache [a-z -]+) ms=(\d+) a=(\d+) b=(\d+)$',re.M)
 events=[{'label':m[1],'duration_ms':int(m[2]),'a':int(m[3]),'b':int(m[4])} for m in pattern.finditer(text)]
 row['census']=events
 files=[]
 for p in sorted((source/'build').rglob('*')):
  if p.is_file(): files.append({'path':str(p.relative_to(source)),'bytes':p.stat().st_size,'sha256':hashlib.file_digest(p.open('rb'),'sha256').hexdigest()})
 row['persisted_files']=files;row['persisted_bytes']=sum(f['bytes'] for f in files)
 row['raw_worker_encoded_bytes']=sum(e['b'] for e in events if e['label']=='cache image encoded bytes')
 row['worker_counts']={kind:sum(e['b'] for e in events if e['label']==f'cache image {kind}') for kind in ['roots','leaves','nodes']}
 row['merged_counts']={kind:[e['b'] for e in events if e['label']==f'cache merged {kind}'] for kind in ['roots','leaves','nodes']}
 results.append(row);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n')
 print(json.dumps({k:row[k] for k in ['workload','exit_code','frontier_accepted','host_capacity_refused','raw_worker_encoded_bytes','persisted_bytes','worker_counts','merged_counts']}),flush=True)
 assert row['exit_code']==0 and all(d['exit_code']==0 for d in row['detached'])
 assert row['frontier_accepted'] and row['raw_worker_encoded_bytes']>0, 'cold engagement unavailable; do not label fallback as packet census'
print('PASS '+str(root),flush=True)
