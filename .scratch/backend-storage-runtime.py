"""V15 ABI/unused-slot acceptance and DWARF evidence; caller owns shared performance lock."""
import argparse,hashlib,importlib.util,json,os,re,shutil,subprocess,tempfile
import dwarf_source_facts
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--baseline',type=Path,required=True);p.add_argument('--candidate',type=Path,required=True);p.add_argument('--source',type=Path,required=True);p.add_argument('--resume',type=Path);a=p.parse_args()
s=Path('/workspace/silk/.scratch');root=a.resume or Path(tempfile.mkdtemp(prefix='backend-storage-runtime-',dir=s/'benchmarks'));print(root,flush=True)
spec=importlib.util.spec_from_file_location('b',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_','SILK_PROFILE_','SILK_ARTIFACT_')) and k not in ['LLVM_PROFILE_FILE','LD_PRELOAD']};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
cases=['zero-storage-outcome-lanes','unit-parameter-lanes','effect-suspended-map-flat-map','direct-suspend-continuation','suspension-native-depth-and-unit-retry','diagnostic-observer-capturing-callback','independent-execution-zero-sized-guard-cancel','foreign-export-scalars','foreign-export-import-bound','scalar-temporary-storage']
meta={'baseline_sha256':sha(a.baseline),'candidate_sha256':sha(a.candidate),'source':str(a.source),'source_commit':subprocess.check_output(['git','-C',str(a.source),'rev-parse','HEAD'],text=True).strip(),'optimization':'none','debug':True,'cases':cases,'note':'Shared correctness run, no performance claim.'};(root/'metadata.json').write_text(json.dumps(meta,indent=2)+'\n')
results=json.loads((root/'results.json').read_text()) if a.resume else [];dwarf=s/'llvm-22.1.8/bin/llvm-dwarfdump'
for case in cases:
 if (root/(case+'-dwarf-source-facts.json')).exists() and len([r for r in results if r['case']==case])==2:continue
 fixture=a.source/'corpus/native'/case;source=fixture/'main.silk';text=source.read_text();splice=re.fullmatch(r'/\*@splice (.*?)\*/\s*',text)
 if splice:source=a.source/json.loads(splice[1])['file']
 expected=json.loads((fixture/'outcome.json').read_text())['expected'];assert expected['kind']=='completes'
 work=root/case;(work/'src').mkdir(parents=True,exist_ok=True);(work/'src/main.silk').write_bytes(source.read_bytes())
 manifest='[package]\nname = "storage-fixture"\nversion = "0.0.0"\n'
 if (fixture/'imports').exists():shutil.copytree(fixture/'imports',work/'src',dirs_exist_ok=True)
 if (fixture/'c').exists():
  shutil.copytree(fixture/'c',work/'c',dirs_exist_ok=True)
  for header in (a.source/'corpus/fixtures').glob('*.h'):shutil.copy2(header,work/'c'/header.name)
  cs=sorted((work/'c').glob('*.c'));manifest+='[native]\nsources = ['+','.join('{c='+json.dumps(str(c.relative_to(work)))+',include=['+json.dumps('c')+']}' for c in cs)+']\n'
 (work/'silk.toml').write_text(manifest);runs=[];stats=[];dies=[]
 for mode,compiler in [('baseline',a.baseline),('candidate',a.candidate)]:
  # Separate output units, and remove the shared package build cache between compilers.
  shutil.rmtree(work/'build',ignore_errors=True)
  out=root/(case+'-'+mode);log=out.with_suffix('.log')
  cmd=[str(compiler.resolve()),'build',str(work/'src/main.silk'),'-o',str(out),'--stdlib',str(a.source/'stdlib'),'--optimization','none','--debug','true']
  result={'case':case,'mode':mode,**b.measure(cmd,work,env,log)}
  assert result['exit_code']==0 and all(d['exit_code']==0 for d in result['detached']),(case,mode,log)
  executed=subprocess.run([str(out)],capture_output=True,timeout=45);runtime=(executed.returncode,executed.stdout,executed.stderr)
  result.update(program_exit=executed.returncode,stdout=executed.stdout.decode(errors='replace'),stderr=executed.stderr.decode(errors='replace'),artifact_sha256=sha(out));assert executed.returncode==expected['exitCode'],(case,mode,runtime)
  for stream in ['stdout','stderr']:
   f=fixture/('expected.'+stream)
   if f.exists():assert getattr(executed,stream)==f.read_bytes(),(case,mode,stream)
  verify=subprocess.run([str(dwarf),'--verify',str(out)],capture_output=True);(root/(case+'-'+mode+'-dwarf-verify.log')).write_bytes(verify.stdout+verify.stderr);assert verify.returncode==0,(case,mode,'DWARF verify')
  st=json.loads(subprocess.check_output([str(dwarf),'--statistics',str(out)]));(root/(case+'-'+mode+'-dwarf-statistics.json')).write_text(json.dumps(st,indent=2)+'\n');stats.append(st)
  dies.append(subprocess.check_output([str(dwarf),'--debug-info',str(out)],text=True));result['dwarf_verified']=True;results.append(result);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n');runs.append(runtime);print(case,mode,'PASS',flush=True)
  shutil.rmtree(Path(str(out)+'.units'),ignore_errors=True)
 assert runs[0]==runs[1],(case,'runtime parity')
 # Debug variables/types/scopes remain source-equivalent; PCs and range lengths may shrink.
 keys=['#functions','#unique source variables','#params','#local vars','#source variables with location']
 comparison={k:{'baseline':stats[0].get(k),'candidate':stats[1].get(k)} for k in keys}
 (root/(case+'-dwarf-comparison.json')).write_text(json.dumps(comparison,indent=2)+'\n')
 source_facts=dwarf_source_facts.compare(dies[0],dies[1]);(root/(case+'-dwarf-source-facts.json')).write_text(json.dumps(source_facts,indent=2)+'\n')
 assert not source_facts['lost'],(case,'source debug identities/locations lost',source_facts['lost'])
 assert stats[0].get('#functions')==stats[1].get('#functions'),(case,'function scopes changed')
 shutil.rmtree(work/'build',ignore_errors=True)
# The direct Wasm emitter shares the same lane contract, including suspend/return/status paths.
work=root/'zero-storage-outcome-lanes'
for mode,compiler in [('baseline',a.baseline),('candidate',a.candidate)]:
 out=root/('zero-storage-'+mode+'.wasm');log=root/('zero-storage-'+mode+'-wasm.log')
 cmd=[str(compiler.resolve()),'build',str(work/'src/main.silk'),'-o',str(out),'--stdlib',str(a.source/'stdlib'),'--optimization','none','--debug','false','--target','wasm32-unknown-unknown','--backend','direct']
 result={'case':'zero-storage-outcome-lanes-wasm','mode':mode,**b.measure(cmd,work,env,log)}
 assert result['exit_code']==0 and all(d['exit_code']==0 for d in result['detached']),(mode,log)
 code="const fs=require('fs');const m=new WebAssembly.Module(fs.readFileSync(process.argv[1]));const i=new WebAssembly.Instance(m,{});const n=i.exports.main();console.log(n);if(n!==42)process.exit(1)"
 run=subprocess.run(['node','-e',code,str(out)],capture_output=True);assert run.returncode==0,(mode,run.stdout,run.stderr)
 result.update(program_exit=42,stdout=run.stdout.decode(),artifact_sha256=sha(out));results.append(result);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n');print('direct Wasm',mode,'PASS',flush=True)
print('PASS '+str(root),flush=True)
