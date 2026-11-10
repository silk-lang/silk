import os,json,shutil,tempfile,importlib.util,sys,re,hashlib,subprocess
from pathlib import Path
scratch=Path('/workspace/silk/.scratch');binary=Path(sys.argv[1]);limit=int(os.environ.get('RESHARE_TRIALS','3'))
spec=importlib.util.spec_from_file_location('cold',str(scratch/'benchmarks/cold_bench.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(tempfile.mkdtemp(prefix='reshare-build-parity-',dir=scratch/'benchmarks'));source=root/'silk';revision=m.snapshot(Path('/workspace/silk-baseline'),source);rows=[]
command=['timeout','--kill-after=10','150s',str(binary),'build','--package','silk-compiler','--stdlib',str(source/'stdlib'),'--progress','plain']
meta={'root':str(root),'revision':revision,'compiler':str(binary),'sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'packing_mib':4,'correctness_only':True};(root/'metadata.json').write_text(json.dumps(meta,indent=2));print(json.dumps(meta),flush=True)
selected=None
for trial in range(limit+1):
 mode='off' if selected is not None else 'on-'+str(trial)
 if trial==limit and selected is None:raise SystemExit('no second-child emission engaged in bounded trials')
 shutil.rmtree(source/'build',ignore_errors=True);env=dict(os.environ,SILK_CLANG=str(scratch/'llvm-22.1.8/bin/clang'))
 for key in list(env):
  if key.startswith('SILK_FRONTIER_') or key.startswith('SILK_EXPERIMENT_') or key in ('SILK_RETAINED_BUILD','SILK_POSTCHECK_BUILD','LD_PRELOAD'):env.pop(key,None)
 env.update(SILK_EXPERIMENT_DEV_PACKS='1',SILK_EXPERIMENT_PACK_MIB='4')
 if mode!='off':env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1',SILK_FRONTIER_RESHARE='1',SILK_FRONTIER_COMPLETE_MODULES='1',SILK_FRONTIER_SPECULATIVE_EMISSION='1',SILK_RETAINED_BUILD='1')
 log=root/(mode+'.log');row={'mode':mode,**m.measure(command,source,env,log)};raw=log.read_text();owners=[int(x) for x in re.findall(r'^frontier private fork .* a=(\d+)',raw,re.M) if int(x)>=4]
 emitted={int(a):int(b) for a,b in re.findall(r'^frontier artifact descendant store emitted .* a=(\d+) b=(\d+)',raw,re.M)}
 warm=[tuple(map(int,pair)) for pair in re.findall(r'^frontier speculative completed .* a=(\d+) b=(\d+)',raw,re.M)]
 row.update(children=owners,emitted=emitted,second_child=any(x>=8 and x-4 in owners and emitted.get(x,0)>0 for x in owners),frontier_accepted='frontier accepted' in raw,artifact_accepted='frontier artifact accepted' in raw,warmed=sum(a for a,b in warm),warm_hits=sum(b for a,b in warm))
 if row['exit_code']==0:
  ar=source/'build/llvm';out=ar/'x86_64-unknown-linux-gnu/debug/silk-compiler';shutil.copy2(out,root/('compiler-'+mode));row['binary_sha256']=hashlib.sha256(out.read_bytes()).hexdigest();row['artifacts']={str(p.relative_to(ar)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(ar.rglob('*')) if p.is_file()};row['version_rc']=subprocess.run([str(root/('compiler-'+mode)),'--version'],capture_output=True).returncode
 rows.append(row);(root/'results.json').write_text(json.dumps(rows,indent=2));print(json.dumps({k:v for k,v in row.items() if k!='artifacts'}),flush=True)
 if row['exit_code']!=0:raise SystemExit('build failed')
 if mode=='off':
  compare={'binary_equal':row['binary_sha256']==selected['binary_sha256'],'differences':[k for k in sorted(set(row['artifacts'])|set(selected['artifacts'])) if row['artifacts'].get(k)!=selected['artifacts'].get(k)],'selected':selected['mode']};(root/'parity.json').write_text(json.dumps(compare,indent=2));print(json.dumps(compare),flush=True)
  if not compare['binary_equal'] or compare['differences']:raise SystemExit(1)
  break
 if not row['frontier_accepted'] or not row['artifact_accepted']:raise SystemExit('retained proof did not accept')
 if row['second_child'] and row['warmed']>0 and row['warm_hits']>0:selected=row
