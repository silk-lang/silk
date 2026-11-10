import importlib.util,json,os,shutil,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('cold_bench','/workspace/silk/.scratch/benchmarks/cold_bench.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
root=Path(tempfile.mkdtemp(prefix='frontier-',dir='/workspace/silk/.scratch/benchmarks'))
silk=root/'silk';nonstd=root/'nonstd'
b.snapshot(Path('/workspace/silk-baseline'),silk)
b.snapshot(Path('/workspace/nonstd'),nonstd)
compiler='/workspace/silk/.scratch/fork-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
print(json.dumps({'root':str(root),'compiler':compiler}),flush=True)
for workload,source,cwd,flags in [('compiler',silk,silk,['--package','silk-compiler']),('harfrust',nonstd,nonstd/'fonts/shape/tools/cli',[])]:
 for enabled in [False,True]:
  shutil.rmtree(source/'build',ignore_errors=True)
  env=dict(os.environ)
  env.pop('SILK_EXPERIMENT_FORK_CHECK',None)
  env.pop('SILK_EXPERIMENT_FRONTIER',None)
  if enabled:env['SILK_EXPERIMENT_FRONTIER']='1'
  command=[compiler,'check',*flags,'--stdlib',str(silk/'stdlib'),'--progress','plain','--timings']
  result=b.measure(command,cwd,env,root/f'{workload}-{enabled}.log')
  result.update(workload=workload,frontier=enabled)
  with (root/'results.jsonl').open('a') as f:f.write(json.dumps(result)+'\n')
  print(json.dumps(result),flush=True)
