"""Cached emission body/header/layout invalidation; caller holds shared performance.lock."""
import argparse,ctypes,hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--compiler',type=Path,required=True);p.add_argument('--stdlib',type=Path,required=True);a=p.parse_args()
s=Path('/workspace/silk/.scratch');root=Path(tempfile.mkdtemp(prefix='immutable-emission-native-',dir=s/'benchmarks'));work=root/'fixture';src=work/'src';src.mkdir(parents=True);print(root,flush=True)
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
(work/'silk.toml').write_text('[package]\nname = "emission-cache"\nversion = "0.0.0"\n')
pads=[f'pad{x:02}' for x in range(40)]
for name in pads:(src/(name+'.silk')).write_text('pub fn answer() -> i32 { return 0 }\n')
(src/'main.silk').write_text('import item { Item }\nimport item\nimport callee\nimport silk.core.ownership { Copy }\n'+'\n'.join('import '+n for n in pads)+'\nfn second<T: Copy>(values: &[T]) -> T { return values[1] }\npub fn main() -> i32 {\n let values = item.make()\n let selected = second<Item>(&values)\n return selected.id + callee.bonus() + '+' + '.join(n+'.answer()' for n in pads)+'\n}\n')
small='import silk.core.ownership { Copy }\npub struct Item { pub id: i32 }\nimpl Copy for Item {}\npub fn make() -> [Item; 2] { return [Item {id: 5}, Item {id: 40}] }\n'
large='import silk.core.ownership { Copy }\npub struct Item { pub id: i32, pub extra: i64 }\nimpl Copy for Item {}\npub fn make() -> [Item; 2] { return [Item {id: 5, extra: 9}, Item {id: 40, extra: 11}] }\n'
stages=[('cold',small,'pub fn bonus() -> i32 { return 2 }\n',42),('body-edit',small,'pub fn bonus() -> i32 { return 3 }\n',43),('header-invalid',small,'pub fn bonus() -> bool { return true }\n',None),('header-recovery',small,'pub fn bonus() -> i32 { return 4 }\n',44),('layout-grow',large,'pub fn bonus() -> i32 { return 4 }\n',44),('layout-shrink',small,'pub fn bonus() -> i32 { return 4 }\n',44),('unchanged',small,'pub fn bonus() -> i32 { return 4 }\n',44)]
blocked=('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_CACHE_WORK_')
base={k:v for k,v in os.environ.items() if not k.startswith(blocked)};base['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
parallel=dict(base,SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_WARM='0',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1',SILK_RETAINED_BUILD='1',SILK_RETAINED_CACHE='1')
(root/'metadata.json').write_text(json.dumps({'compiler':str(a.compiler.resolve()),'sha256':hashlib.sha256(a.compiler.read_bytes()).hexdigest(),'stdlib':str(a.stdlib.resolve()),'env':{k:v for k,v in parallel.items() if k.startswith('SILK_')},'purpose':'Native invalidation and code parity only, not performance. Same-path cold serial reference per stage; no priming before first body edit.'},indent=2)+'\n')
results=[]
for stage,item,callee,expected in stages:
 (src/'item.silk').write_text(item);(src/'callee.silk').write_text(callee);pair=[]
 for mode,env in [('parallel',parallel),('serial',base)]:
  command=[str(a.compiler.resolve()),'build','--stdlib',str(a.stdlib.resolve()),'--progress','never']
  q=subprocess.run(command,cwd=work,env=env,capture_output=True,text=True,timeout=180);detached=[]
  while True:
   try:
    _,status=os.waitpid(-1,0);detached.append(os.waitstatus_to_exitcode(status))
   except ChildProcessError:break
  log=root/f'{stage}-{mode}.log';log.write_text(q.stdout+q.stderr);assert all(x==0 for x in detached)
  trace=[];diagnostics=[]
  for line in q.stderr.splitlines():
   if line.startswith('frontier '):trace.append(line)
   elif line.strip():diagnostics.append(line)
  row={'stage':stage,'mode':mode,'exit':q.returncode,'diagnostics':diagnostics,'split':any(x.startswith('frontier split') for x in trace),'frontier':any(x=='frontier accepted' for x in trace),'artifact':any(x.startswith('frontier artifact accepted') for x in trace),'detached':detached}
  if expected is None:assert q.returncode!=0 and diagnostics,(stage,mode,log)
  else:
   assert q.returncode==0,(stage,mode,log)
   binary=work/'build/llvm/x86_64-unknown-linux-gnu/debug/emission-cache';run=subprocess.run([str(binary)],capture_output=True,timeout=20)
   row.update(sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),program_exit=run.returncode,stdout=run.stdout.decode(),stderr=run.stderr.decode());assert run.returncode==expected,(stage,mode,row)
  if mode=='parallel':
   if stage=='cold':assert row['frontier'] and row['artifact'],('cold retained path not exercised',log)
   else:assert not row['split'],('warm refork',stage)
   (work/'build').rename(work/'saved-cache')
  else:shutil.rmtree(work/'build',ignore_errors=True);(work/'saved-cache').rename(work/'build')
  pair.append(row);results.append(row);(root/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(row),flush=True)
 assert pair[0]['diagnostics']==pair[1]['diagnostics'],(stage,'ordered diagnostic mismatch')
 if expected is not None:assert pair[0]['sha256']==pair[1]['sha256'],(stage,'binary mismatch')
print('PASS '+str(root),flush=True)
