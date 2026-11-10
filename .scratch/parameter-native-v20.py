"""Native scalar call-result parity; caller holds shared performance lock."""
import argparse, ctypes, hashlib, json, os, shutil, subprocess, tempfile
from pathlib import Path
s=Path('/workspace/silk/.scratch')
p=argparse.ArgumentParser();p.add_argument('--candidate',type=Path,default=s/'frontier-native-work-v20');p.add_argument('--tree',type=Path,default=s/'performance-native-v20-source');a=p.parse_args();tree=a.tree;source=tree/'corpus/native/parameter-value-forwarding/main.silk'
root=Path(tempfile.mkdtemp(prefix='parameter-native-v20-',dir=s/'benchmarks'));print(root,flush=True)
work=root/'fixture';(work/'src').mkdir(parents=True)
(work/'silk.toml').write_text('[package]\nname = "parameter-value-forwarding"\nversion = "0.0.0"\n')
fixture=work/'src/main.silk';fixture.write_text(source.read_text());source=fixture
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
base={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_NATIVE_','SILK_PROFILE_'))};base['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
rows=[]
for compiler in [s/'frontier-native-checkpoint-completed-v19',a.candidate]:
 name=compiler.name
 for debug in ['false','true']:
  shutil.rmtree(work/'build',ignore_errors=True)
  output=root/(name+'-'+debug)
  cmd=[str(compiler),'build',str(source),'--stdlib',str(tree/'stdlib'),'--optimization','none','--debug',debug,'--output',str(output)]
  p=subprocess.run(cmd,env=base,cwd=work,capture_output=True,text=True,timeout=120);children=[]
  while True:
   try:
    _,status=os.waitpid(-1,0);children.append(os.waitstatus_to_exitcode(status))
   except ChildProcessError:break
  (root/(output.name+'.log')).write_text(p.stdout+p.stderr)
  assert p.returncode==0 and all(x==0 for x in children),(name,debug,p.stderr)
  run=subprocess.run([str(output)],capture_output=True,timeout=20)
  row={'compiler':name,'compiler_sha256':hashlib.sha256(compiler.read_bytes()).hexdigest(),'debug':debug,'exit':run.returncode,'stdout':run.stdout.decode(),'stderr':run.stderr.decode(),'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'detached':children}
  assert run.returncode==42 and not run.stdout and not run.stderr,row
  if debug=='true':
   dump=s/'llvm-22.1.8/bin/llvm-dwarfdump'
   if dump.exists():
    verify=subprocess.run([str(dump),'--verify',str(output)],capture_output=True,text=True)
    (root/(output.name+'.dwarf-verify.log')).write_text(verify.stdout+verify.stderr);assert verify.returncode==0
    row['dwarf_verified']=True
  rows.append(row);(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(row),flush=True)
print('PASS '+str(root),flush=True)
