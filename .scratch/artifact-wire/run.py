from pathlib import Path
import importlib.util,os,json,shutil
spec=importlib.util.spec_from_file_location('cold','/workspace/silk/.scratch/benchmarks/cold_bench.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path('/workspace/silk/.scratch/benchmarks/retained-build-7e4_s5co');source=root/'nonstd';shutil.rmtree(source/'build')
env=dict(os.environ,SILK_CLANG='/workspace/silk/.scratch/llvm-22.1.8/bin/clang',SILK_POSTCHECK_BUILD='1',LD_PRELOAD='/workspace/silk/.scratch/artifact-wire/capture.so')
command=['/workspace/silk/.scratch/N1-retained-build','build','--stdlib',str(root/'silk/stdlib'),'--progress','plain']
r=m.measure(command,source/'fonts/shape/tools/cli',env,Path('/workspace/silk/.scratch/artifact-wire/run.log'));Path('/workspace/silk/.scratch/artifact-wire/result.json').write_text(json.dumps(r,indent=2));print(json.dumps(r))
