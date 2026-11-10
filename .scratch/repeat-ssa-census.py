import importlib.util,json,os
from pathlib import Path
s=Path('/workspace/silk/.scratch');root=s/'benchmarks/scalar-ssa-ir-sk7c1swx';spec=importlib.util.spec_from_file_location('b',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_'))}
command=[str(s/'frontier-ssa-persistent-v6'),'build',str(root/'silk/compiler/src/main.silk'),'-o',str(root/'compiler-candidate.ll'),'--stdlib',str(root/'silk/stdlib'),'--optimization','none','--debug','true','--emit','llvm-ir']
r=b.measure(command,root/'silk/compiler',env,root/'compiler-candidate-repeat.log');(root/'candidate-repeat-status.json').write_text(json.dumps(r,indent=2));print(json.dumps(r),flush=True)
