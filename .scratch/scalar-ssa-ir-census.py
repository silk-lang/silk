"""Untimed IR-volume census, preserving O0 and full debug; caller holds shared performance.lock."""
import argparse,gzip,hashlib,importlib.util,json,os,re,shutil,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--baseline',type=Path,required=True);p.add_argument('--candidate',type=Path,required=True);p.add_argument('--resume',type=Path);a=p.parse_args()
s=Path('/workspace/silk/.scratch');spec=importlib.util.spec_from_file_location('b',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
root=a.resume or Path(tempfile.mkdtemp(prefix='scalar-ssa-ir-',dir=s/'benchmarks'));print(root,flush=True)
if a.resume:
 prior=json.loads((root/'metadata.json').read_text());revisions=prior['revisions'];assert prior['compilers']['baseline']['sha256']==hashlib.sha256(a.baseline.read_bytes()).hexdigest()
 archive=Path(tempfile.mkdtemp(prefix='history-'+prior['compilers']['candidate']['sha256'][:12]+'-',dir=root))
 (archive/'metadata.json').write_text(json.dumps(prior,indent=2)+'\n')
 if (root/'results.json').exists():
  previous=json.loads((root/'results.json').read_text())
  for result in previous:
   if result['mode']=='candidate' and 'compressed_ir' in result:
    artifact=Path(result['compressed_ir'])
    if artifact.exists():
     retained=archive/artifact.name;artifact.rename(retained);result['compressed_ir']=str(retained)
  (archive/'results.json').write_text(json.dumps(previous,indent=2)+'\n')
 if (root/'REPORT.md').exists():shutil.copy2(root/'REPORT.md',archive/'REPORT.md')
else:revisions={'silk':b.snapshot(Path('/workspace/silk-baseline'),root/'silk'),'nonstd':b.snapshot(Path('/workspace/nonstd'),root/'nonstd')}
assert revisions=={'silk':'a63f612150a0b91a118c8111b910b12c3e124b50','nonstd':'ccb168b773bb56d7bd60a3495141d427149766d0'},revisions
metadata={'purpose':'Untimed IR-volume comparison; elapsed times are not performance claims. Both modes O0 and debug=true.','revisions':revisions,'compilers':{k:{'path':str(v),'sha256':hashlib.sha256(v.read_bytes()).hexdigest()} for k,v in [('baseline',a.baseline),('candidate',a.candidate)]}}
(root/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_'))};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang');results=[]
if a.resume and (root/'results.json').exists():results=[x for x in json.loads((root/'results.json').read_text()) if x['mode']=='baseline']
for workload,project in [('compiler',root/'silk/compiler'),('harfrust',root/'nonstd/fonts/shape/tools/cli')]:
 symbols={}
 for mode,compiler in [('baseline',a.baseline),('candidate',a.candidate)]:
  previous=next((x for x in results if x['workload']==workload and x['mode']==mode and 'ir_counts' in x),None)
  if previous:
   with gzip.open(previous['compressed_ir'],'rb') as ir:symbols[mode]={line.split(b'@',1)[1].split(b'(',1)[0] for line in ir if line.startswith(b'define ')}
   print('REUSED '+workload+' '+mode,flush=True);continue
  out=root/(workload+'-'+mode+'.ll');log=out.with_suffix('.log')
  command=[str(compiler.resolve()),'build',str(project/'src/main.silk'),'-o',str(out),'--stdlib',str(root/'silk/stdlib'),'--optimization','none','--debug','true','--emit','llvm-ir']
  result={'workload':workload,'mode':mode,'command':command,**b.measure(command,project,env,log)}
  (root/(workload+'-'+mode+'-status.json')).write_text(json.dumps(result,indent=2)+'\n')
  assert result['exit_code']==0 and all(d['exit_code']==0 for d in result['detached']),(workload,mode,log)
  counts={'alloca':0,'load':0,'store':0,'definitions':0,'declarations':0,'lines':0};names=set();digest=hashlib.sha256()
  with out.open('rb') as ir,gzip.open(str(out)+'.gz','wb',compresslevel=1) as compressed:
   for line in ir:
    digest.update(line);compressed.write(line);counts['lines']+=1
    for op in ['alloca','load']:
     if re.search(rb'= '+op.encode()+rb'\b',line):counts[op]+=1
    if re.match(rb'\s*store\b',line):counts['store']+=1
    if line.startswith(b'define '):counts['definitions']+=1;names.add(line.split(b'@',1)[1].split(b'(',1)[0])
    if line.startswith(b'declare '):counts['declarations']+=1
  counts['bytes']=out.stat().st_size;result.update(ir_counts=counts,ir_sha256=digest.hexdigest(),compressed_ir=str(out)+'.gz');symbols[mode]=names;out.unlink()
  results.append(result);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(result),flush=True)
  shutil.rmtree(root/'silk/build',ignore_errors=True);shutil.rmtree(root/'nonstd/build',ignore_errors=True)
 assert symbols['baseline']==symbols['candidate'],(workload,'different emitted function identities')
print('COMPLETE '+str(root),flush=True)
