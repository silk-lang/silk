"""Conservative scalar temporary runtime parity; caller holds shared performance.lock."""
import argparse, hashlib, importlib.util, json, os, re, subprocess, tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--baseline',type=Path,required=True);p.add_argument('--candidate',type=Path,required=True);p.add_argument('--source',type=Path,default=Path('/workspace/silk/.scratch/scalar-ssa-expanded'));a=p.parse_args()
scratch=Path('/workspace/silk/.scratch');root=Path(tempfile.mkdtemp(prefix='scalar-ssa-runtime-',dir=scratch/'benchmarks'));print(root,flush=True)
spec=importlib.util.spec_from_file_location('b',scratch/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_'))};env['SILK_CLANG']=str(scratch/'llvm-22.1.8/bin/clang')
results=[]
for case in ['scalar-temporary-storage','pointer-slice-offset-write','checked-conversion-pointer-width','scalar-enum-equality-from-borrowed-variant','effect-suspended-map-flat-map','direct-suspend-continuation','float-to-subword-out-of-range-trap','scalar-projected-temporary','scalar-call-temporaries']:
 source=a.source/'corpus/native'/case/'main.silk';text=source.read_text();splice=re.fullmatch(r'/\*@splice (.*?)\*/\s*',text)
 if splice:source=a.source/json.loads(splice[1])['file']
 expected=json.loads((a.source/'corpus/native'/case/'outcome.json').read_text())['expected'];assert expected['kind'] in ['completes','trap']
 work=root/case;(work/'src').mkdir(parents=True);(work/'silk.toml').write_text('[package]\nname = \"ssa-fixture\"\nversion = \"0.0.0\"\n')
 (work/'src/main.silk').write_bytes(source.read_bytes());source=work/'src/main.silk'
 runs=[]
 for mode,compiler in [('baseline',a.baseline),('candidate',a.candidate)]:
  out=root/(case+'-'+mode);log=out.with_suffix('.log')
  command=[str(compiler.resolve()),'build',str(source),'-o',str(out),'--stdlib',str(a.source/'stdlib'),'--optimization','none','--debug','true']
  result={'case':case,'mode':mode,'compiler_sha256':hashlib.sha256(compiler.read_bytes()).hexdigest(),**b.measure(command,a.source,env,log)}
  assert result['exit_code']==0 and all(d['exit_code']==0 for d in result['detached']),(case,mode,log)
  executed=subprocess.run([str(out)],capture_output=True,timeout=20);runtime=(executed.returncode,executed.stdout,executed.stderr)
  result.update(program_exit=executed.returncode,stdout=executed.stdout.decode(errors='replace'),stderr=executed.stderr.decode(errors='replace'),artifact_sha256=hashlib.sha256(out.read_bytes()).hexdigest())
  results.append(result);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(result),flush=True)
  assert (executed.returncode==expected['exitCode'] if expected['kind']=='completes' else executed.returncode<0),(case,mode,runtime)
  runs.append(runtime)
 assert runs[0]==runs[1],(case,'runtime parity failed',runs)
print('PASS '+str(root),flush=True)
