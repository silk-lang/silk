import importlib.util,json,os,subprocess
from pathlib import Path
s=Path('/workspace/silk/.scratch'); w=s/'benchmarks/checked-plan-native-4zlcknl4/lifetimes_local_first'
spec=importlib.util.spec_from_file_location('bench',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
(w/'build').rename(w/'candidate-cold-cache')
e={k:v for k,v in os.environ.items() if not k.startswith('SILK_') and k not in ['LLVM_PROFILE_FILE','LD_PRELOAD']}
e.update(SILK_CLANG=str(s/'llvm-22.1.8/bin/clang'),SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1',SILK_RETAINED_BUILD='1',SILK_RETAINED_CACHE='1')
cmd=[str(s/'frontier-native-work-v22'),'build','--stdlib',str(s/'checked-runtime-plan-gate-68b67/stdlib'),'--progress','plain','--timings']
r=b.measure(cmd,w,e,w/'v22-admission.log');r.update(command=cmd,environment={k:v for k,v in e.items() if k.startswith('SILK_')})
t=(w/'v22-admission.log').read_text();r.update(frontier='frontier accepted' in t,attempted='frontier split' in t,refused='host capacity refused' in t)
(w/'v22-admission.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r),flush=True)
assert r['exit_code']==0 and all(x['exit_code']==0 for x in r['detached'])
