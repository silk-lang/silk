"""Scheduled untimed V17 compiler/Harf native-input census. Caller owns shared performance lock.
Keeps raw content-addressed bitcode and compressed per-function census, never expanded LLVM IR.
The original compiler+stdlib/nonstd revisions and CPU lane are exactly V15's retained capture.
"""
from pathlib import Path
import argparse,collections,gzip,hashlib,json,os,shutil,subprocess,sys,time
s=Path('/workspace/silk/.scratch');here=s/'llvm-promotion-experiment'
p=argparse.ArgumentParser();p.add_argument('--workloads',default='compiler,harfrust');p.add_argument('--include-missing-baseline',action='store_true');a=p.parse_args()
workloads=a.workloads.split(',');assert set(workloads)<={'compiler','harfrust'}
matrix=s/'benchmarks/integrated-incremental-q8sjib9c/metadata.json'
output=s/'v17-storage-census-results.json';results=[]
def sha(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
 return h.hexdigest()
def launch(command,log):
 print('Running '+str(log),flush=True)
 with Path(log).open('wb') as f:r=subprocess.run(command,stdout=f,stderr=subprocess.STDOUT)
 assert r.returncode==0,(command,log,r.returncode)
def compact_owned(root):
 # Capture already reaped all writers and removed its own completed build caches.
 receipts=[]
 for name in ['silk','nonstd']:
  tree=root/name
  if not tree.exists():continue
  rows=[]
  for path in sorted(tree.rglob('*')):
   if path.is_file():rows.append(dict(path=str(path.relative_to(tree)),bytes=path.stat().st_size,sha256=sha(path)))
  receipt=root/(name+'-source-files.json.gz')
  with gzip.open(receipt,'wt') as f:json.dump(rows,f,separators=(',',':'))
  receipts.append(dict(tree=str(tree),file_count=len(rows),bytes=sum(x['bytes'] for x in rows),receipt=str(receipt)))
  shutil.rmtree(tree)
 artifact=root/'artifact'
 if artifact.exists():
  digest=sha(artifact);size=artifact.stat().st_size;mode=artifact.stat().st_mode;compressed=artifact.with_suffix('.gz')
  with artifact.open('rb') as src,gzip.open(compressed,'wb',compresslevel=6) as out:shutil.copyfileobj(src,out)
  h=hashlib.sha256()
  with gzip.open(compressed,'rb') as f:
   for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
  assert h.hexdigest()==digest
  (root/'artifact-compressed.json').write_text(json.dumps(dict(original=str(artifact),sha256=digest,bytes=size,mode=mode,compressed=str(compressed)),indent=2)+'\n')
  artifact.unlink()
 if not receipts and (root/'source-prune.json').exists():return
 (root/'source-prune.json').write_text(json.dumps(dict(reason='Completed own capture; exact revisions and source archive hashes in metadata; file hashes retained',trees=receipts),indent=2)+'\n')
def capture(version,workload):
 root=s/f'benchmarks/backend-storage-{version}-{workload}-capture'
 binary=s/('frontier-performance-v17' if version=='v17' else 'backend-storage-v15')
 construction=s/('frontier-performance-v17.json' if version=='v17' else 'backend-storage-v15.json')
 if not (root/'capture-result.json').exists():
  assert not root.exists(),f'Incomplete capture requires review before retry: {root}'
  assert shutil.disk_usage(s).free>=900*1024*1024,'Pause between captures: need900MiB headroom'
  launch([sys.executable,str(here/'capture-backend-storage.py'),str(root),'--workload',workload,'--matrix',str(matrix),'--binary',str(binary),'--compiler-metadata',str(construction)],s/f'backend-storage-{version}-{workload}-capture.log')
 result=json.loads((root/'capture-result.json').read_text());assert result['exit_code']==0 and all(x['exit_code']==0 for x in result['detached'])
 census=root/'census-ssa-v17.json'
 if not census.exists():launch([sys.executable,str(here/'census-backend-storage.py'),str(root/'capture'),str(census)],root/'census.log')
 records=[json.loads(f.read_text()) for f in (root/'capture/commands').glob('*.json')]
 inputs={x['sha256']:x['saved'] for row in records for x in row['inputs'] if x.get('bitcode') and 'saved' in x}
 for digest,path in inputs.items():assert sha(path)==digest,path
 receipt=dict(script_sha256=sha(__file__),census_script_sha256=sha(here/'census-backend-storage.py'),parameter_script_sha256=sha(here/'parameter_spill_census.py'),census_sha256=sha(census),metadata_sha256=sha(root/'metadata.json'),bitcode_inputs=inputs)
 (root/'census-ssa-inputs.json').write_text(json.dumps(receipt,indent=2)+'\n')
 compact_owned(root)
 return census

def compare(baseline,candidate,workload):
 x=json.loads(baseline.read_text());y=json.loads(candidate.read_text())
 with gzip.open(x['function_details'],'rt') as f:b=json.load(f)
 with gzip.open(y['function_details'],'rt') as f:c=json.load(f)
 common=b.keys()&c.keys();metrics=['allocas','loads','stores','calls','parameters','zero_length_memory_intrinsics','argument_spill_slots','argument_spill_loads']
 totals={k:dict(baseline=sum(v.get(k,0) for v in b.values()),candidate=sum(v.get(k,0) for v in c.values()),matched_baseline=sum(b[n].get(k,0) for n in common),matched_candidate=sum(c[n].get(k,0) for n in common)) for k in metrics}
 for row in totals.values():row['change']=row['candidate']-row['baseline'];row['matched_change']=row['matched_candidate']-row['matched_baseline']
 changed=[dict(symbol=n,loads_delta=c[n].get('loads',0)-b[n].get('loads',0),stores_delta=c[n].get('stores',0)-b[n].get('stores',0),allocas_delta=c[n].get('allocas',0)-b[n].get('allocas',0)) for n in common if any(c[n].get(k,0)!=b[n].get(k,0) for k in ['loads','stores','allocas'])]
 changed.sort(key=lambda row:row['loads_delta']+row['stores_delta'])
 record=dict(workload=workload,baseline=str(baseline),candidate=str(candidate),totals=totals,common_functions=len(common),only_baseline=sorted(b.keys()-c.keys()),only_candidate=sorted(c.keys()-b.keys()),changed_functions=len(changed),largest_memory_instruction_reductions=changed[:30],note='Actual native bitcode IR, unique symbols and exact matching source revisions. Static load/store counts are not a CPU or speed claim; V15/V17 also differ in release-unit packing, so matched-function counts isolate that.')
 report=s/f'v17-{workload}-storage-census-comparison.json';report.write_text(json.dumps(record,indent=2)+'\n');return dict(workload=workload,report=str(report),totals=totals)
for workload in workloads:
 candidate=capture('v17',workload)
 baseline=s/f'benchmarks/backend-storage-v15-{workload}-capture/census.json'
 if not baseline.exists() and a.include_missing_baseline:baseline=capture('v15',workload)
 if baseline.exists():
  baseline=capture('v15',workload)
  results.append(compare(baseline,candidate,workload))
 else:results.append(dict(workload=workload,candidate=str(candidate),comparison=None,reason='No retained V15 Harf capture; baseline must be scheduled explicitly'))
 output.write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(results[-1]),flush=True)
