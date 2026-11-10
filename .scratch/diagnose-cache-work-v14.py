"""Diagnostic CPU attribution only; caller holds shared performance lock."""
import argparse,hashlib,importlib.util,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--compiler',type=Path,required=True);p.add_argument('--reuse-completed',action='store_true');a=p.parse_args()
s=Path('/workspace/silk/.scratch');spec=importlib.util.spec_from_file_location('cold',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
root=Path(tempfile.mkdtemp(prefix='cache-work-v14-',dir=s/'benchmarks'));work=root/'silk';revision=b.snapshot(Path('/workspace/silk-baseline'),work);assert revision=='a63f612150a0b91a118c8111b910b12c3e124b50'
main=work/'compiler/src/main.silk';original=main.read_bytes();needle=b'Create a package or a workspace\\n';assert original.count(needle)==1
blocked=('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_CACHE_WORK_')
env={k:v for k,v in os.environ.items() if not k.startswith(blocked)}
env.update(SILK_CLANG=str(s/'llvm-22.1.8/bin/clang'),SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1',SILK_RETAINED_CACHE='1',SILK_CACHE_WORK_TRACE='1')
if a.reuse_completed:env['SILK_FRONTIER_REUSE_COMPLETED']='1'
command=[str(a.compiler.resolve()),'check','--package','silk-compiler','--stdlib',str(work/'stdlib'),'--progress','plain','--timings'];results=[]
(root/'metadata.json').write_text(json.dumps({'compiler':str(a.compiler.resolve()),'sha256':hashlib.sha256(a.compiler.read_bytes()).hexdigest(),'source':revision,'env':{k:v for k,v in env.items() if k.startswith('SILK_')},'purpose':'Diagnostic nested-stage attribution under shared CPU slot; no authoritative wall comparison. Original source direct body edits, then unchanged; source-input census cold only.'},indent=2)+'\n');print(root,flush=True)
try:
 for stage in ['cold','first-edit','second-edit','unchanged']:
  if stage in ['first-edit','second-edit']:
   main.write_bytes(original.replace(needle,b'Create a package or a workspace ('+(b'revision one' if stage=='first-edit' else b'revision two')+b')\\n'))
  current=dict(env)
  if stage=='cold':current['SILK_FRONTIER_INPUT_CENSUS']='1'
  before={str(p):p.stat().st_mtime_ns for p in s.glob('frontier-failure-*.input-census')}
  log=root/(stage+'.log');row={'stage':stage,**b.measure(command,work,current,log)};text=log.read_text()
  row.update(frontier='frontier accepted' in text,split='frontier split' in text)
  results.append(row);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(row),flush=True)
  assert row['exit_code']==0 and all(x['exit_code']==0 for x in row['detached'])
  if stage=='cold':assert row['frontier']
  else:assert not row['split']
  for f in s.glob('frontier-failure-*.input-census'):
   if before.get(str(f))!=f.stat().st_mtime_ns:shutil.copy2(f,root/f.name)
finally:main.write_bytes(original)
summary=subprocess.check_output(['python3',str(s/'summarize-cache-work.py'),*[str(root/(x+'.log')) for x in ['cold','first-edit','second-edit','unchanged']]],text=True);(root/'cache-work-summary.jsons').write_text(summary)
print('PASS '+str(root),flush=True)
