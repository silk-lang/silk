import os,json,shutil,tempfile,importlib.util,sys,subprocess,re,hashlib
from pathlib import Path
scratch=Path('/workspace/silk/.scratch');binary=Path(sys.argv[1])
spec=importlib.util.spec_from_file_location('cold',str(scratch/'benchmarks/cold_bench.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(tempfile.mkdtemp(prefix='private-pss-',dir=scratch/'benchmarks'));source=root/'silk';revision=m.snapshot(Path('/workspace/silk-baseline'),source);rows=[]
for mode in ('serial','balanced'):
 shutil.rmtree(source/'build',ignore_errors=True);env=dict(os.environ)
 for key in list(env):
  if key.startswith('SILK_FRONTIER_') or key.startswith('SILK_EXPERIMENT_') or key in ('SILK_RETAINED_BUILD','SILK_POSTCHECK_BUILD','LD_PRELOAD'):env.pop(key,None)
 if mode=='balanced':env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1')
 log=root/(mode+'.log');cmd=['python3',str(scratch/'benchmarks/pss_run.py'),'--log',str(log),'--','timeout','--kill-after=5','90s',str(binary),'check','--package','silk-compiler','--stdlib',str(source/'stdlib'),'--progress','plain']
 p=subprocess.run(cmd,cwd=source,env=env,capture_output=True,text=True);(root/(mode+'-monitor.log')).write_text(p.stdout+p.stderr)
 if p.returncode:raise RuntimeError(p.stderr)
 r=json.loads(p.stdout);raw=log.read_text();r.update(mode=mode,root=str(root),revision=revision,binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),accepted='frontier accepted' in raw,descendants=len(re.findall(r'^frontier private fork ms=\d+ a=[4-7] ',raw,re.M)))
 rows.append(r);(root/'results.json').write_text(json.dumps(rows,indent=2));print(json.dumps(r),flush=True)
 if any(x['exit_code']!=0 for x in r['exits']) or (mode=='balanced' and (not r['accepted'] or not r['descendants'])):raise SystemExit(1)
