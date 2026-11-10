"""Caller holds shared performance lock. Cache policy and semantic parity, never timings."""
import argparse,ctypes,hashlib,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--compiler',type=Path,required=True);p.add_argument('--stdlib',type=Path,required=True);a=p.parse_args()
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
s=Path('/workspace/silk/.scratch');root=Path(tempfile.mkdtemp(prefix='streamed-hir-policy-',dir=s/'benchmarks'));work=root/'fixture';src=work/'src';src.mkdir(parents=True);print(root,flush=True)
(work/'silk.toml').write_text('[package]\nname = "streamed-hir-policy"\nversion = "0.0.0"\n')
(src/'main.silk').write_text('import callee\npub fn main() -> i32 { return callee.value() + 2 }\n')
clean='pub fn value() -> i32 { return 40 }\n';(src/'callee.silk').write_text(clean)
env={k:v for k,v in os.environ.items() if not k.startswith('SILK_')};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
metadata={'compiler':str(a.compiler.resolve()),'sha256':hashlib.sha256(a.compiler.read_bytes()).hexdigest(),'stdlib':str(a.stdlib.resolve()),'purpose':'Same populated-cache mode switches must refill, unchanged same-policy must reuse; edited errors match fresh OFF JSON and native output bytes/runtime match. All subprocesses/writers settled; no timing claims.'};(root/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n');rows=[]
def invoke(label,on,command='check',json_mode=False):
 e=dict(env)
 if on:e['SILK_STREAMED_BODY_HASH']='1'
 args=[str(a.compiler.resolve()),command,'--stdlib',str(a.stdlib.resolve()),'--progress','never' if json_mode else 'plain']
 if json_mode:args+=['--json']
 elif command=='check':args+=['--timings']
 q=subprocess.run(args,cwd=work,env=e,capture_output=True,text=True,timeout=120);children=[]
 while True:
  try:pid,status=os.waitpid(-1,0);children.append([pid,os.waitstatus_to_exitcode(status)])
  except ChildProcessError:break
 assert all(status==0 for _,status in children),(label,children)
 text=q.stdout+q.stderr;(root/(label+'.log')).write_text(text)
 row={'label':label,'streamed':on,'command':command,'exit':q.returncode,'body_runs':sum(map(int,re.findall(r'^\s*\S+\s+\S+\s+(\d+)\s+Body\s*$',text,re.M))),'children':children}
 if json_mode:row['diagnostics']=[json.loads(line) for line in q.stderr.splitlines() if line.strip()]
 if command=='build' and q.returncode==0:
  binary=work/'build/llvm/x86_64-unknown-linux-gnu/debug/streamed-hir-policy';run=subprocess.run([str(binary)],capture_output=True,timeout=10)
  row.update(binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),program_exit=run.returncode,stdout=run.stdout.hex(),stderr=run.stderr.hex())
 rows.append(row);(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(row),flush=True);return row
for label,on,refill in [('off-cold',False,True),('on-policy-switch',True,True),('on-unchanged',True,False),('off-policy-switch',False,True),('off-unchanged',False,False),('on-policy-switch-again',True,True)]:
 row=invoke(label,on);assert row['exit']==0,(label,row);assert (row['body_runs']>0)==refill,('policy adoption evidence',row,refill)
(src/'callee.silk').write_text(clean.replace('40','41'))
row=invoke('on-direct-body-edit',True);assert row['exit']==0 and row['body_runs']>0,row
row=invoke('on-edited-unchanged',True);assert row['exit']==0 and row['body_runs']==0,row
(src/'callee.silk').write_text('pub fn value() -> i32 { return true }\n')
actual=invoke('on-invalid-edit',True,json_mode=True);assert actual['exit']!=0 and actual['diagnostics'],actual
(work/'build').rename(work/'saved-cache')
try:
 fresh=invoke('fresh-off-invalid',False,json_mode=True);assert actual['exit']==fresh['exit'] and actual['diagnostics']==fresh['diagnostics'],(actual,fresh)
finally:
 shutil.rmtree(work/'build',ignore_errors=True);(work/'saved-cache').rename(work/'build')
(src/'callee.silk').write_text(clean)
actual=invoke('on-recovery-build',True,'build');assert actual['exit']==0 and actual['program_exit']==42,actual
(work/'build').rename(work/'saved-cache')
try:
 fresh=invoke('fresh-off-build',False,'build');assert fresh['exit']==0
 for key in ['binary_sha256','program_exit','stdout','stderr']:assert actual[key]==fresh[key],(key,actual,fresh)
finally:
 shutil.rmtree(work/'build',ignore_errors=True);(work/'saved-cache').rename(work/'build')
print('PASS '+str(root),flush=True)
