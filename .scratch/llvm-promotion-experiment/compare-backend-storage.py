import argparse,collections,gzip,json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('baseline',type=Path);p.add_argument('candidate',type=Path);p.add_argument('output',type=Path);a=p.parse_args()
x=json.loads(a.baseline.read_text());y=json.loads(a.candidate.read_text())
with gzip.open(x['function_details'],'rt') as f:b=json.load(f)
with gzip.open(y['function_details'],'rt') as f:c=json.load(f)
summary={k:{'baseline':v,'candidate':y['summary'].get(k,0),'change':y['summary'].get(k,0)-v,'change_percent':100*(y['summary'].get(k,0)-v)/v if v else None} for k,v in x['summary'].items()}
common=b.keys()&c.keys();bcalls=collections.Counter();ccalls=collections.Counter();btypes=collections.Counter();ctypes=collections.Counter()
for f in b.values():bcalls.update(f['callees']);btypes.update(f['alloca_types'])
for f in c.values():ccalls.update(f['callees']);ctypes.update(f['alloca_types'])
reduced=[];increased=[]
for key in sorted(common):
 delta=c[key]['parameters']-b[key]['parameters']
 if delta:
  item={'symbol':key,'baseline_parameters':b[key]['parameters'],'candidate_parameters':c[key]['parameters'],'baseline_direct_call_sites':bcalls[key],'candidate_direct_call_sites':ccalls[key]}
  (reduced if delta<0 else increased).append(item)
record={'baseline':str(a.baseline),'candidate':str(a.candidate),'summary':summary,'internal_definitions_only_baseline':sorted(b.keys()-c.keys()),'internal_definitions_only_candidate':sorted(c.keys()-b.keys()),'functions_with_reduced_parameters':len(reduced),'removed_parameter_lanes':sum(r['baseline_parameters']-r['candidate_parameters'] for r in reduced),'removed_static_direct_call_argument_lanes':sum((r['baseline_parameters']-r['candidate_parameters'])*r['baseline_direct_call_sites'] for r in reduced),'functions_with_increased_parameters':increased,'reduced_parameter_details':reduced,'alloca_types':{k:{'baseline':btypes[k],'candidate':ctypes[k],'change':ctypes[k]-btypes[k]} for k in sorted(btypes.keys()|ctypes.keys())},'note':'Static input-volume comparison, not a speed claim. Combined alloca delta includes ABI result-local alias changes and is not exact unused-Temp attribution.'}
a.output.write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({k:record[k] for k in ['functions_with_reduced_parameters','removed_parameter_lanes','removed_static_direct_call_argument_lanes','functions_with_increased_parameters']}))
for k in ['bitcode_packs','bitcode_bytes','ir_text_bytes','function_allocas','function_loads','function_stores','function_calls','function_zero_length_memory_intrinsics']:print(k,summary.get(k))
