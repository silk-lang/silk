"""Original and same-binary frontend scheduling comparisons; run under exclusive lock."""
import argparse,hashlib,importlib.util,json,os,shutil,tempfile
from pathlib import Path
s=Path('/workspace/silk/.scratch'); spec=importlib.util.spec_from_file_location('cold',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
p=argparse.ArgumentParser();p.add_argument('--candidate',type=Path,required=True);p.add_argument('--rounds',type=int,default=2);p.add_argument('--modes',default='baseline,base,complete,reshare');a=p.parse_args();os.sched_setaffinity(0,{0,1,2,3})
r=Path(tempfile.mkdtemp(prefix='frontier-v3-',dir=s/'benchmarks'));revs={'silk':b.snapshot(Path('/workspace/silk-baseline'),r/'silk'),'nonstd':b.snapshot(Path('/workspace/nonstd'),r/'nonstd')}
assert revs=={'silk':'a63f612150a0b91a118c8111b910b12c3e124b50','nonstd':'ccb168b773bb56d7bd60a3495141d427149766d0'}
meta={'candidate':str(a.candidate),'candidate_sha256':hashlib.sha256(a.candidate.read_bytes()).hexdigest(),'revisions':revs,'rounds':a.rounds,'cpus':[0,1,2,3]};(r/'metadata.json').write_text(json.dumps(meta,indent=2));print(json.dumps({'root':str(r),**meta}),flush=True);rows=[]
for work in ('compiler','harfrust'):
 src=r/('silk' if work=='compiler' else 'nonstd');cwd=src if work=='compiler' else src/'fonts/shape/tools/cli'
 for rep in range(a.rounds):
  modes=a.modes.split(',');modes=modes if rep%2==0 else list(reversed(modes))
  for mode in modes:
   shutil.rmtree(src/'build',ignore_errors=True)
   env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_'))}
   binary=s/'N0-one' if mode=='baseline' else a.candidate
   if mode!='baseline':env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1')
   if mode in ('complete','reshare'):env['SILK_FRONTIER_COMPLETE_MODULES']='1'
   if mode=='reshare':env['SILK_FRONTIER_RESHARE']='1'
   log=r/f'{work}-{rep}-{mode}.log';cmd=[str(binary),'check']+(['--package','silk-compiler'] if work=='compiler' else [])+['--stdlib',str(r/'silk/stdlib'),'--progress','plain','--timings']
   row={'workload':work,'round':rep,'mode':mode,'command':cmd,**b.measure(cmd,cwd,env,log)};trace=log.read_text();row['accepted']='frontier accepted' in trace
   rows.append(row);(r/'results.json').write_text(json.dumps(rows,indent=2));print(json.dumps(row),flush=True)
   assert row['exit_code']==0 and all(x['exit_code']==0 for x in row['detached']),log
   if mode!='baseline':assert row['accepted'],log
   shutil.rmtree(src/'build',ignore_errors=True)
