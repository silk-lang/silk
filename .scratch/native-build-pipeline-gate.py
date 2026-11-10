"""Caller holds shared performance lock. Native pipeline correctness, never timing evidence."""
import argparse, ctypes, hashlib, json, os, shutil, subprocess, tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--compiler',required=True);p.add_argument('--stdlib',required=True);p.add_argument('--require-early-checkpoint',action='store_true');p.add_argument('--require-checkpoint-completion',action='store_true');a=p.parse_args()
compiler=Path(a.compiler).resolve();stdlib=Path(a.stdlib).resolve()
base=Path(tempfile.mkdtemp(prefix='native-pipeline-',dir='/workspace/silk/.scratch/benchmarks'));work=base/'fixture';src=work/'src';src.mkdir(parents=True)
print(base,flush=True)
if ctypes.CDLL(None).prctl(36,1,0,0,0):raise RuntimeError('subreaper unavailable')
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_NATIVE_BUILD_PIPELINE'))}
env.update(SILK_CLANG='/workspace/silk/.scratch/llvm-22.1.8/bin/clang',SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_WARM='0',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1',SILK_RETAINED_BUILD='1',SILK_RETAINED_CACHE='1')
(work/'silk.toml').write_text('[package]\nname = "native-pipeline"\nversion = "0.0.0"\nmain = "main.silk"\n[profiles.speed-four]\noptimization = "speed"\ndebug = false\ncodegen-units = 4\n')
names=[f'pad{i:02}' for i in range(40)]
for name in names:(src/(name+'.silk')).write_text('pub fn answer() -> i32 { return 0 }\n')
(src/'main.silk').write_text('\n'.join('import '+n for n in names)+'\npub fn main() -> i32 { return 42 + '+' + '.join(n+'.answer()' for n in names)+' }\n')
(base/'metadata.json').write_text(json.dumps({'compiler':str(compiler),'sha256':hashlib.sha256(compiler.read_bytes()).hexdigest(),'stdlib':str(stdlib),'environment':{k:v for k,v in env.items() if k.startswith('SILK_')},'purpose':'Private native object pipeline: exact same-path artifact/runtime parity, warm no-fork, injected coordinator failure, error publication refusal.'},indent=2)+'\n')
allowed_cpus = sorted(os.sched_getaffinity(0))
single_cpu = 0 if 0 in allowed_cpus else allowed_cpus[0]
results=[]
def invoke(stage,profile,mode,expected,affinity=None):
 e=dict(env)
 if mode == 'serial':
  e={k:v for k,v in e.items() if not k.startswith(('SILK_FRONTIER_', 'SILK_EXPERIMENT_', 'SILK_RETAINED_'))}
 if mode not in ('off','serial'):e['SILK_NATIVE_BUILD_PIPELINE']='1'
 if mode=='fault':e['SILK_NATIVE_BUILD_PIPELINE_FAIL']='1'
 args=[str(compiler),'build','--stdlib',str(stdlib),'--progress','never']
 if profile!='debug':args+=['--profile',profile]
 q=subprocess.run(args,cwd=work,env=e,capture_output=True,text=True,timeout=240,
  preexec_fn=(lambda: os.sched_setaffinity(0, affinity)) if affinity is not None else None)
 children=[]
 while True:
  try:pid,status=os.waitpid(-1,0);children.append(os.waitstatus_to_exitcode(status))
  except ChildProcessError:break
 log=base/f'{stage}-{profile}-{mode}.log';log.write_text(q.stdout+q.stderr)
 assert q.returncode==expected,(log,q.returncode,expected)
 assert all(x==0 for x in children),(log,children)
 row=dict(stage=stage,profile=profile,mode=mode,status=q.returncode,started='frontier native coordinator started' in q.stderr,published='frontier native objects published' in q.stderr,refused='frontier native coordinator refused' in q.stderr,frontier='frontier accepted' in q.stderr,split='frontier split' in q.stderr,
  checkpoint_count=q.stderr.count('frontier native cache checkpoint'),completion_count=q.stderr.count('frontier native cache completed'),detached_children=children,host_refused='frontier host capacity refused' in q.stderr,affinity=sorted(affinity) if affinity is not None else None)
 if a.require_early_checkpoint:
  assert row['checkpoint_count']==int(row['started'] and expected==0),(log,'accepted checkpoint must occur exactly once',row)
  if row['checkpoint_count']:
   marker='frontier native objects published' if row['published'] else 'frontier native coordinator refused'
   assert q.stderr.index('frontier native cache checkpoint')<q.stderr.index(marker),(log,'cache starts before native join/publication')
 if a.require_checkpoint_completion:
  assert row['completion_count']==row['checkpoint_count'],(log,'every accepted checkpoint must finish before return',row)
  if row['completion_count']:
   assert children==[],(log,'the parent must reap its own checkpoint writer',children)
   marker='frontier native objects published' if row['published'] else 'frontier native coordinator refused'
   assert q.stderr.index(marker)<q.stderr.index('frontier native cache completed'),(log,'completion follows native publication/refusal')
 if expected==0:
  artifact=work/'build/llvm/x86_64-unknown-linux-gnu'/profile/'native-pipeline'
  row['sha256']=hashlib.sha256(artifact.read_bytes()).hexdigest()
  run=subprocess.run([str(artifact)],capture_output=True,timeout=15)
  row['program']=[run.returncode,run.stdout.decode(),run.stderr.decode()]
 results.append(row);(base/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(row),flush=True)
 assert not list((work/'build').rglob('.silk-native-*')),(stage,'staging leaked')
 return row

def fresh_pair(stage,profile,mode,exitcode=42,engaged=True):
 shutil.rmtree(work/'build',ignore_errors=True)
 off=invoke(stage,profile,'off',0)
 shutil.rmtree(work/'build')
 on=invoke(stage,profile,mode,0)
 assert on['frontier'],(stage,'semantic frontier never engaged')
 assert on['started']==engaged,(stage,'wrong native admission',on)
 assert on['program']==off['program']==[exitcode,'',''],(stage,'runtime mismatch',on,off)
 assert on['sha256']==off['sha256'],(stage,'artifact bytes differ',on,off)
 assert on['published']==(engaged and mode!='fault'),(stage,'wrong private publication state',on)
 if not engaged:assert not on['refused'],(stage,'small monolithic release should avoid coordinator entirely')
 if mode=='fault':assert on['refused'],(stage,'fault was not observed')
 return on

for profile in ['debug','speed-four']:
 # This fixture is below the unchanged 4MiB release partition threshold.
 # Large release overlap is validated separately on compiler/Harf workloads.
 fresh_pair('cold',profile,'on',engaged=profile=='debug')
 warm=invoke('unchanged',profile,'on',0);assert not warm['started'],('warm coordinator',warm)
(src/'pad00.silk').write_text('pub fn answer() -> i32 { return 1 }\n')
# Keep the release cache from the immediately preceding cold/unchanged pair.
warm=invoke('direct-body-edit','speed-four','on',0);assert not warm['started'] and warm['program']==[43,'',''],warm
saved=work/'saved-cache';(work/'build').rename(saved)
try:
 serial=invoke('direct-body-edit','speed-four','off',0)
 assert serial['sha256']==warm['sha256'] and serial['program']==warm['program'],('edited parity',serial,warm)
finally:
 shutil.rmtree(work/'build',ignore_errors=True);saved.rename(work/'build')
(src/'pad00.silk').write_text('pub fn answer() -> i32 { return 0 }\n')
fresh_pair('failed-child','debug','fault')
artifact=work/'build/llvm/x86_64-unknown-linux-gnu/debug/native-pipeline';before=hashlib.sha256(artifact.read_bytes()).hexdigest()
(src/'pad00.silk').write_text('pub fn answer() -> i32 { return missing }\n')
invalid=invoke('invalid-edit','debug','on',1)
assert not invalid['started'] and not invalid['published'],invalid
assert hashlib.sha256(artifact.read_bytes()).hexdigest()==before,'invalid build changed final artifact'
# Cold opt-in refusal must happen before either semantic workers or the native coordinator.
# Pin the compiler before exec; every compiler/native/cache child inherits this mask.
# CPU0 may be outside the container cpuset, so use the first allowed CPU in that case.
(src/'pad00.silk').write_text('pub fn answer() -> i32 { return 0 }\n')
shutil.rmtree(work/'build',ignore_errors=True)
single_serial=invoke('cold-one-core','speed-four','serial',0,{single_cpu})
shutil.rmtree(work/'build')
single_optin=invoke('cold-one-core','speed-four','on',0,{single_cpu})
assert single_optin['host_refused'],('single-core admission did not refuse',single_optin)
assert not any(single_optin[k] for k in ('split','frontier','started','published')),single_optin
assert single_optin['sha256']==single_serial['sha256'],('single-core artifact mismatch',single_serial,single_optin)
assert single_optin['program']==single_serial['program']==[42,'',''],('single-core runtime mismatch',single_serial,single_optin)
print('PASS '+str(base),flush=True)
