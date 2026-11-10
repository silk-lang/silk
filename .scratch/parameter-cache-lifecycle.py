"""Parameter forwarding direct edit parity; caller owns shared performance lock."""
import argparse,ctypes,hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path
s=Path('/workspace/silk/.scratch');p=argparse.ArgumentParser();p.add_argument('--candidate',type=Path,required=True);p.add_argument('--tree',type=Path,required=True);a=p.parse_args()
root=Path(tempfile.mkdtemp(prefix='parameter-cache-',dir=s/'benchmarks'));work=root/'fixture';(work/'src').mkdir(parents=True);print(root,flush=True)
(work/'silk.toml').write_text('[package]\nname = "parameter-cache"\nversion = "0.0.0"\n')
source=a.tree/'corpus/native/parameter-value-forwarding/main.silk';original=source.read_text();fixture=work/'src/main.silk'
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
blocked=('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_NATIVE_','SILK_PROFILE_')
env={k:v for k,v in os.environ.items() if not k.startswith(blocked)};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
old='fn ownWrite(mut value: i32) -> i32 { value = value + 1 return value }';assert old in original
stages=[('cold',original,42),('first-body-edit',original.replace(old,old.replace('value + 1','value + 2')),4),('second-body-edit',original.replace('fn set(value: &mut i32) -> () { value.* = 42 }','fn set(value: &mut i32) -> () { value.* = 43 }'),5),('header-edit',original.replace(old,old.replace('i32','i64')),42),('own-address-edit',original.replace(old,'fn ownWrite(mut value: i32) -> i32 { set(&mut value) return value }'),42),('invalid-body',original.replace(old,'fn ownWrite(mut value: i32) -> i32 { return missingName }'),None),('recovery',original,42)]
rows=[]
(root/'metadata.json').write_text(json.dumps({'candidate':str(a.candidate),'candidate_sha256':hashlib.sha256(a.candidate.read_bytes()).hexdigest(),'tree':str(a.tree),'baseline':str(s/'frontier-native-checkpoint-completed-v19'),'purpose':'Correctness only; fresh V19 reference for every stage; no cache priming before first edit.'},indent=2)+'\n')
for stage,text,expected in stages:
 fixture.write_text(text);pair=[]
 for mode,compiler in [('candidate',a.candidate),('reference',s/'frontier-native-checkpoint-completed-v19')]:
  output=root/(mode+'-program')
  cmd=[str(compiler),'build',str(fixture),'--stdlib',str(a.tree/'stdlib'),'--optimization','none','--debug','true','--output',str(output)]
  q=subprocess.run(cmd,cwd=work,env=env,capture_output=True,text=True,timeout=120);children=[]
  while True:
   try:_,status=os.waitpid(-1,0);children.append(os.waitstatus_to_exitcode(status))
   except ChildProcessError:break
  (root/(stage+'-'+mode+'.log')).write_text(q.stdout+q.stderr)
  assert all(code==0 for code in children),(stage,mode,children)
  row={'stage':stage,'mode':mode,'build_exit':q.returncode,'detached':children}
  if expected is None:
   assert q.returncode!=0 and 'missingName' in q.stderr,(stage,mode,q.stderr)
   row['diagnostics']=q.stderr
  else:
   assert q.returncode==0,(stage,mode,q.stderr)
   result=subprocess.run([str(output)],capture_output=True,timeout=20)
   row.update(program_exit=result.returncode,stdout=result.stdout.decode(),stderr=result.stderr.decode())
   assert result.returncode==expected and not result.stdout and not result.stderr,(stage,mode,row)
  rows.append(row);pair.append(row);(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(row),flush=True)
  if mode=='candidate':
   if (work/'build').exists():(work/'build').rename(work/'saved-cache')
   if Path(str(output)+'.units').exists():Path(str(output)+'.units').rename(root/'saved-units')
  else:
   shutil.rmtree(work/'build',ignore_errors=True)
   if (work/'saved-cache').exists():(work/'saved-cache').rename(work/'build')
   if (root/'saved-units').exists():(root/'saved-units').rename(root/'candidate-program.units')
 if expected is None:assert pair[0]['diagnostics']==pair[1]['diagnostics'],(stage,'diagnostic mismatch')
print('PASS '+str(root),flush=True)
