"""Native one-core opt-in refusal gate; caller holds a shared performance lock."""
from pathlib import Path
import argparse, hashlib, importlib.util, json, os, shutil, subprocess, tempfile
p=argparse.ArgumentParser();p.add_argument('--compiler',required=True);p.add_argument('--stdlib',required=True);a=p.parse_args()
scratch=Path('/workspace/silk/.scratch');compiler=Path(a.compiler).resolve();stdlib=Path(a.stdlib).resolve()
spec=importlib.util.spec_from_file_location('cold',scratch/'benchmarks/cold_bench.py');bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
root=Path(tempfile.mkdtemp(prefix='indexed-host-gate-',dir=scratch/'benchmarks'));print(root,flush=True)
source=scratch/'retained-smokes/lifetimes_local_first';shutil.copytree(source/'src',root/'src');shutil.copy2(source/'silk.toml',root/'silk.toml')
main=root/'src/main.silk';text=main.read_text().replace('pub fn main() -> i32','fn originalMain() -> i32',1)
names=['pad'+str(i).zfill(2) for i in range(40)]
for name in names:(root/'src'/(name+'.silk')).write_text('pub fn answer() -> i32 { return 0 }\n')
main.write_text('\n'.join('import '+n for n in names)+'\n'+text+'\npub fn main() -> i32 { return originalMain() + '+' + '.join(n+'.answer()' for n in names)+' }\n')
base={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_'))};base['SILK_CLANG']=str(scratch/'llvm-22.1.8/bin/clang')
enabled=dict(base,SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_WARM='0',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_RESHARE='1',SILK_FRONTIER_CHUNKS='1',SILK_RETAINED_BUILD='1',SILK_RETAINED_CACHE='1')
core=min(os.sched_getaffinity(0));results=[]
(root/'metadata.json').write_text(json.dumps({'compiler':str(compiler),'sha256':hashlib.sha256(compiler.read_bytes()).hexdigest(),'stdlib':str(stdlib),'core':core,'environment':{k:v for k,v in enabled.items() if k.startswith('SILK_')},'purpose':'Correctness only: one-core affinity must automatically refuse experimental workers despite explicit opt-in, matching ordinary serial check/build.'},indent=2)+'\n')
for command in ['check','build']:
 rows=[]
 for mode,env in [('opt-in',enabled),('serial',base)]:
  shutil.rmtree(root/'build',ignore_errors=True)
  args=['taskset','-c',str(core),str(compiler),command,'--stdlib',str(stdlib),'--progress','plain','--timings']
  log=root/(command+'-'+mode+'.log');result={'command':command,'mode':mode,**bench.measure(args,root,env,log)};trace=log.read_text()
  assert result['exit_code']==0 and all(d['exit_code']==0 for d in result['detached']),(command,mode,log)
  result['host_refusal']='frontier host capacity refused' in trace
  result['split']='frontier split' in trace;result['artifact']='artifact accepted' in trace
  assert not result['split'] and not result['artifact'],(command,mode,'one-core worker engagement',log)
  if mode=='opt-in':assert result['host_refusal'],(command,'one-core did not reach/decline the host gate',log)
  if command=='build':
   candidates=[f for f in (root/'build/llvm/x86_64-unknown-linux-gnu/debug').iterdir() if f.is_file() and os.access(f,os.X_OK) and f.suffix=='']
   assert len(candidates)==1,candidates
   binary=candidates[0];run=subprocess.run([str(binary)],capture_output=True)
   result.update(binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),program_exit=run.returncode,stdout=run.stdout.decode(errors='replace'),stderr=run.stderr.decode(errors='replace'))
   assert run.returncode==42,(mode,run.returncode)
  rows.append(result);results.append(result);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(result),flush=True)
 if command=='build':assert rows[0]['binary_sha256']==rows[1]['binary_sha256'],'one-core opt-in changed code generation'
shutil.rmtree(root/'build',ignore_errors=True)
print('PASS '+str(root),flush=True)
