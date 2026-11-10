"""Checked runtime plan retained-cache lifecycle correctness; caller holds shared performance lock. No timing claim."""
from pathlib import Path
import argparse, hashlib, importlib.util, json, os, re, shutil, subprocess, tempfile, tomllib
p=argparse.ArgumentParser();p.add_argument('--compiler',required=True);p.add_argument('--reference',required=True);p.add_argument('--stdlib',required=True);p.add_argument('--cases',default='lifetimes_local_first,lifetimes_static_first,observer,suspension');a=p.parse_args()
scratch=Path('/workspace/silk/.scratch')
spec=importlib.util.spec_from_file_location('cold',scratch/'benchmarks/cold_bench.py');bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
root=Path(tempfile.mkdtemp(prefix='checked-plan-native-',dir=scratch/'benchmarks'));print(root,flush=True)
results=[]
base={k:v for k,v in os.environ.items() if not k.startswith('SILK_') and k not in ['LLVM_PROFILE_FILE','LD_PRELOAD']}
base['SILK_CLANG']=str(scratch/'llvm-22.1.8/bin/clang')
base['SILK_RUNTIME_PLAN_CENSUS']='1'
parallel=dict(base,SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1',SILK_RETAINED_BUILD='1',SILK_RETAINED_CACHE='1')
assert shutil.disk_usage(root).free >= 900*1024**2, 'native gate requires 900MiB free'
(root/'metadata.json').write_text(json.dumps({'compiler':str(Path(a.compiler).resolve()),'sha256':hashlib.sha256(Path(a.compiler).read_bytes()).hexdigest(),'reference':str(Path(a.reference).resolve()),'reference_sha256':hashlib.sha256(Path(a.reference).read_bytes()).hexdigest(),'candidate_source':'05b786d0f310d2e6e527d08801c957c02adfcaf4','reference_source':'85ba82efe750a4682cc21192ad5dcb37d7bbd981','harness_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'stdlib':str(Path(a.stdlib).resolve()),'environment':{k:v for k,v in parallel.items() if k.startswith('SILK_')},'purpose':'Native correctness only; 40 authored module tasks pass the module-count condition; default warm threshold and normal process-frontier admission are observed, not forced. Tiny fixtures may stay serial; actual pool proof is a separate full workload gate. Cold goes directly to first body edit before unchanged. Frozen V22 serial reference uses independent cache each stage; candidate compact policy is unconditional and no candidate-OFF comparison substitutes for the reference. Invalid build compares ordered primary code/line/column/message; the separate boundary gate compares full structured diagnostics and related spans.'},indent=2)+'\n')
for case in a.cases.split(','):
 source=scratch/'retained-smokes'/case;work=root/case
 shutil.copytree(source/'src',work/'src');shutil.copy2(source/'silk.toml',work/'silk.toml')
 main=work/'src/main.silk';text=main.read_text();assert 'pub fn main() -> i32' in text,case
 text=text.replace('pub fn main() -> i32','fn originalMain() -> i32',1)
 names=['pad'+str(i).zfill(2) for i in range(40)]
 for name in names:(work/'src'/(name+'.silk')).write_text('pub fn answer() -> i32 { return 0 }\n')
 main.write_text('\n'.join('import '+n for n in names)+'\n'+text+'\npub fn main() -> i32 {\n  let padding = '+' + '.join(n+'.answer()' for n in names)+'\n  return originalMain() + padding\n}\n')
 original_main=main.read_text()
 package=tomllib.loads((work/'silk.toml').read_text())['package']['name'];relative=Path('llvm/x86_64-unknown-linux-gnu/debug')/package
 command=[str(Path(a.compiler).resolve()),'build','--stdlib',str(Path(a.stdlib).resolve()),'--progress','plain','--timings']
 for stage,value in [('cold',0),('first-edit',1),('second-edit',2),('unchanged',2)]:
  if stage!='unchanged':
   if case.startswith('lifetimes_'):
    assert original_main.count('return value.*')==1
    main.write_text(original_main if value==0 else original_main.replace('return value.*',f'return value.* + {value}'))
   elif case=='observer':
    main.write_text(original_main.replace('let weight = 3',f'let weight = {3+value}').replace('weighted) != 6',f'weighted) != {6+2*value}').replace('return 42',f'return {42+value}'))
   elif case=='suspension':main.write_text(original_main.replace('return 42 / value',f'return {42+value} / value'))
   else:raise AssertionError('unrecognized edit case '+case)
  expected=42+value*(2 if case.startswith('lifetimes_') else 1)
  stage_results=[]
  for mode,env in [('parallel',parallel),('serial',base)]:
   command[0]=str(Path(a.compiler if mode=='parallel' else a.reference).resolve())
   log=work/(stage+'-'+mode+'.log');result={'case':case,'stage':stage,'mode':mode,**bench.measure(command,work,env,log)}
   trace=log.read_text();result.update(frontier='frontier accepted' in trace,artifact='artifact accepted' in trace,persisted='artifact replay captured' in trace,attempted='frontier split' in trace,plan_census=[{'phase':m.group(1),'metric':m.group(2),'worker':int(m.group(3)),'count':int(m.group(4))} for m in re.finditer(r'frontier plan (\S+) (\S+) ms=\d+ a=(\d+) b=(\d+)',trace)])
   assert result['exit_code']==0 and all(d['exit_code']==0 for d in result['detached']),(case,stage,mode,log)
   binary=work/'build'/relative;executed=subprocess.run([str(binary)],capture_output=True)
   result.update(binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),program_exit=executed.returncode,stdout=executed.stdout.decode(errors='replace'),stderr=executed.stderr.decode(errors='replace'))
   results.append(result);stage_results.append(result);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(result),flush=True)
   assert executed.returncode==expected,(case,stage,mode,executed.returncode)
   if mode=='parallel':
    if stage=='cold':
     assert any(x['metric']=='compact' and x['count']>0 for x in result['plan_census']),(case,stage,'no actual compact plan coverage',log)
     if result['attempted'] and case=='suspension':assert result['frontier'] and not result['artifact'] and 'artifact refused' in trace and ('check cache imported' in trace or 'check cache assembled' in trace),(case,stage,'explicit fallback lost check evidence',log)
     elif result['attempted']:assert result['frontier'] and result['artifact'] and result['persisted'],(case,stage,'retained cache did not engage',log)
    else:assert not result['attempted'],(case,stage,'warm build restarted cold frontier',log)
    (work/'build').rename(work/'parallel-cache')
   else:
    shutil.rmtree(work/'build',ignore_errors=True);(work/'parallel-cache').rename(work/'build')
  assert stage_results[0]['binary_sha256']==stage_results[1]['binary_sha256'],(case,stage,'serial artifact mismatch')
 invalid=original_main.replace('return value.*','return \"invalid\"') if case.startswith('lifetimes_') else original_main.replace('return 1' if case=='suspension' else 'return 7','return \"invalid\"')
 assert invalid!=original_main
 main.write_text(invalid)
 failures=[]
 for mode,env in [('parallel',parallel),('serial',base)]:
  command[0]=str(Path(a.compiler if mode=='parallel' else a.reference).resolve())
  log=work/('invalid-edit-'+mode+'.log');result={'case':case,'stage':'invalid-edit','mode':mode,**bench.measure(command,work,env,log)}
  trace=log.read_text();result['diagnostics']=[{'path':m.group(1),'line':int(m.group(2)),'column':int(m.group(3)),'code':m.group(4),'message':m.group(5)} for m in re.finditer(r'^(.+):(\d+):(\d+): error\[([^\]]+)\]([^\n]*)',trace,re.M)]
  assert result['exit_code']==1 and result['diagnostics'] and all(d['exit_code']==0 for d in result['detached']),(case,mode,'invalid edit accepted or missing diagnostics',log)
  failures.append(result);results.append(result);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(result),flush=True)
  if mode=='parallel':(work/'build').rename(work/'parallel-cache')
  else:
   shutil.rmtree(work/'build',ignore_errors=True);(work/'parallel-cache').rename(work/'build')
 assert failures[0]['diagnostics']==failures[1]['diagnostics'],(case,'invalid edit diagnostic code/location/message mismatch')
 shutil.rmtree(work/'build')
print('PASS '+str(root),flush=True)
