"""Caller holds shared performance lock. Exact serial/warm diagnostic and runtime parity."""
import argparse, ctypes, hashlib, json, os, re, shutil, subprocess, tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--compiler',required=True);p.add_argument('--stdlib',required=True);a=p.parse_args()
compiler=Path(a.compiler).resolve();stdlib=Path(a.stdlib).resolve()
base=Path(tempfile.mkdtemp(prefix='boundary-cache-',dir='/workspace/silk/.scratch/benchmarks'));work=base/'fixture';work.mkdir();src=work/'src';src.mkdir()
print(base,flush=True)
if ctypes.CDLL(None).prctl(36,1,0,0,0):raise RuntimeError('subreaper unavailable')
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_'))}
env['SILK_CLANG']='/workspace/silk/.scratch/llvm-22.1.8/bin/clang'
parallel=dict(env,SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_WARM='0',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1',SILK_RETAINED_BUILD='1',SILK_RETAINED_CACHE='1')
(base/'metadata.json').write_text(json.dumps({'compiler':str(compiler),'sha256':hashlib.sha256(compiler.read_bytes()).hexdigest(),'stdlib':str(stdlib),'environment':{k:v for k,v in parallel.items() if k.startswith('SILK_')},'purpose':'Correctness only. Cold parallel check goes directly to invalid callee body edit. Same source path/cache identity, fresh serial cache each comparison. Full JSON diagnostics, related sites and order compared.'},indent=2)+'\n')
names=[f'pad{i:02}' for i in range(40)]
for name in names:(src/(name+'.silk')).write_text('pub fn answer() -> i32 { return 0 }\n')
imports='\n'.join(['import holder',*[f'import {name}' for name in names]])
for main,answer in [('main',42),('alternate',43)]:
 (src/(main+'.silk')).write_text(imports+'\nfn use(core: &Intrinsic.SharedCore<i32>) -> i32 { return holder.access(core) }\npub fn main() -> i32 { return '+str(answer)+' + '+' + '.join(name+'.answer()' for name in names)+' }\n')
(src/'holder.silk').write_text('''import callback
fn busy() -> i32 { return 0 }
pub fn access(core: &Intrinsic.SharedCore<i32>) -> i32 {
  return Intrinsic.sharedWithMut<i32, i32>(core, callback.read, busy)
}
''')
(src/'callback.silk').write_text('''import parking
pub fn read(value: &mut i32) -> i32 { return value.* + parking.value() }
''')
clean='pub fn value() -> i32 { return 0 }\n'
invalid='pub fn value() -> i32 {\n  run Intrinsic.relinquish()\n  return 0\n}\n'
stages=[('cold','main',clean,0),('first-edit-parking','main',invalid,1),('recovery','main',clean.replace('return 0','return 1'),0),('shifted-parking','main','\n\n'+invalid,1),('switch-application','alternate',clean,0),('alternate-parking','alternate',invalid,1),('alternate-recovery','alternate',clean,0),('restore-application','main',clean,0)]
results=[]
def invoke(mode,stage,command='check'):
 args=[str(compiler),command,'--stdlib',str(stdlib),'--progress','never']
 if command=='check':args+=['--json']
 q=subprocess.run(args,cwd=work,env=parallel if mode=='parallel' else env,capture_output=True,text=True,timeout=180)
 children=[]
 while True:
  try:
   pid,status=os.waitpid(-1,0);children.append(os.waitstatus_to_exitcode(status))
  except ChildProcessError:break
 log=base/f'{stage}-{command}-{mode}.log';log.write_text(q.stdout+q.stderr)
 assert all(x==0 for x in children),(log,children)
 diagnostics=[];trace=[]
 for line in q.stderr.splitlines():
  if line.startswith('frontier '):trace.append(line)
  elif line.strip() and command=='check':diagnostics.append(json.loads(line))
 row={'stage':stage,'command':command,'mode':mode,'code':q.returncode,'out':q.stdout,'diagnostics':diagnostics,'frontier':any(x=='frontier accepted' for x in trace),'split':any(x.startswith('frontier split') for x in trace),'trace':trace}
 results.append(row);(base/'results.json').write_text(json.dumps(results,indent=2)+'\n')
 print(json.dumps({k:v for k,v in row.items() if k not in ['trace','diagnostics','out']}),flush=True)
 return row

def compare(stage,expected,command='check',expected_run=None):
 actual=invoke('parallel',stage,command)
 if command=='build' and actual['code']==0:
  exe=work/'build/llvm/x86_64-unknown-linux-gnu/debug/boundary-cache'
  run=subprocess.run([str(exe)],capture_output=True,timeout=20)
  actual['program']={'code':run.returncode,'out':run.stdout.decode(),'err':run.stderr.decode()}
  actual['artifact_sha256']=hashlib.sha256(exe.read_bytes()).hexdigest()
  assert run.returncode==expected_run,(stage,actual)
 (work/'build').rename(work/'saved-parallel-cache')
 try:
  fresh=invoke('serial',stage,command)
  if command=='build' and fresh['code']==0:
   exe=work/'build/llvm/x86_64-unknown-linux-gnu/debug/boundary-cache'
   run=subprocess.run([str(exe)],capture_output=True,timeout=20)
   fresh['program']={'code':run.returncode,'out':run.stdout.decode(),'err':run.stderr.decode()}
   fresh['artifact_sha256']=hashlib.sha256(exe.read_bytes()).hexdigest()
   assert actual['artifact_sha256']==fresh['artifact_sha256'],(stage,'native artifact hash mismatch',actual,fresh)
   assert actual['program']==fresh['program'],(stage,actual,fresh)
 finally:
  shutil.rmtree(work/'build',ignore_errors=True);(work/'saved-parallel-cache').rename(work/'build')
 assert actual['code']==fresh['code']==expected,(stage,actual,fresh)
 if command=='check':
  assert actual['diagnostics']==fresh['diagnostics'],(stage,actual,fresh)
  assert actual['out']==fresh['out'],(stage,actual,fresh)
  if expected:
   assert any(x.get('code')=='OWN0016' for x in actual['diagnostics']),(stage,'expected escaped shared access rejection',actual)
 if stage=='cold':
  assert actual['frontier'],('cold fixture never engaged accepted parallel proof',actual)
  assert any(x.startswith('frontier runtime exports cached') for x in actual['trace']),('runtime subset evidence not published',actual)
 elif command=='check' and stage not in ['switch-application','restore-application']:
  assert not actual['split'],('warm body edit restarted cold workers',stage,actual)
 (base/'results.json').write_text(json.dumps(results,indent=2)+'\n')

for stage,entry,body,status in stages:
 (work/'silk.toml').write_text('[package]\nname = "boundary-cache"\nversion = "0.0.0"\nmain = "'+entry+'.silk"\n')
 (src/'parking.silk').write_text(body)
 compare(stage,status)
 if stage in ['recovery','alternate-recovery']:compare(stage,0,'build',42 if entry=='main' else 43)
print('PASS '+str(base),flush=True)
