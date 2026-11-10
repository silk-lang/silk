import importlib.util,json,os,pathlib
root=pathlib.Path('/workspace/silk');snapshot=root/'.scratch/benchmarks/coarse-o7m9o4zq'
spec=importlib.util.spec_from_file_location('cold',root/'.scratch/benchmarks/cold_bench.py');bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
binary=root/'.scratch/coarse-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
env=dict(os.environ,SILK_EXPERIMENT_COARSE_CHECK='1',SILK_EXPERIMENT_COARSE_TRACE='1')
for name,cwd,flags in [('compiler',snapshot/'silk',['--package','silk-compiler']),('harfrust',snapshot/'nonstd/fonts/shape/tools/cli',[])]:
 records=[]
 for state in ['cold','warm']:
  log=root/f'.scratch/coarse-fixed-{name}-{state}.log'
  command=[str(binary),'check',*flags,'--stdlib',str(snapshot/'silk/stdlib'),'--progress','never','--json']
  result=bench.measure(command,cwd,env,log)
  result.update(workload=name,state=state)
  lines=log.read_text().splitlines()
  result['hit']='whole-check hit' in lines
  records.append((result,'\n'.join(l for l in lines if not l.startswith('whole-check '))))
  print(json.dumps(result),flush=True)
 assert all(r['exit_code']==0 for r,d in records),(name,records)
 assert records[1][0]['hit'],(name,'warm miss')
 assert records[0][1]==records[1][1],(name,'diagnostic mismatch')
 print(name,'PASS unchanged first warm hit and identical diagnostics',flush=True)
