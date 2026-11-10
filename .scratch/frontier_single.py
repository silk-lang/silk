import os,json,importlib.util,shutil,sys,hashlib,subprocess
from pathlib import Path
base=Path('/workspace/silk');tag=sys.argv[1];workload=sys.argv[2] if len(sys.argv)>2 else 'compiler';enabled=len(sys.argv)<4 or sys.argv[3]!='off'
compiler=base/'.scratch/fork-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
root=base/'.scratch/benchmarks/transport-family-ctvjs_tx';source=root/('silk' if workload=='compiler' else 'nonstd');cwd=source if workload=='compiler' else source/'fonts/shape/tools/cli'
shutil.rmtree(source/'build',ignore_errors=True)
for old in (base/'.scratch').glob('frontier-failure-*.oracle-*'):old.unlink()
spec=importlib.util.spec_from_file_location('cold',str(base/'.scratch/benchmarks/cold_bench.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
env=dict(os.environ)
for key in ['SILK_EXPERIMENT_FORK_CHECK','SILK_EXPERIMENT_FRONTIER','SILK_FRONTIER_SHARED']:env.pop(key,None)
if enabled:env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1')
command=[str(compiler),'check',*(['--package','silk-compiler'] if workload=='compiler' else []),'--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings']
r=b.measure(command,cwd,env,base/'.scratch'/f'{tag}.log');r.update(workload=workload,frontier=enabled,sha256=hashlib.sha256(compiler.read_bytes()).hexdigest())
(base/'.scratch'/f'{tag}.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r),flush=True)

if enabled:
    outputs=list((base/'.scratch').glob('frontier-failure-*.oracle-*'))
    if outputs:
        saved=base/'.scratch'/f'{tag}-oracle';saved.mkdir(exist_ok=True)
        for output in outputs:shutil.copy2(output,saved/output.name)
