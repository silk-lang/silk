"""Authored raw-buffer copy refusal observer parity, caller holds shared performance lock."""
import argparse,ctypes,hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path
s=Path('/workspace/silk/.scratch');p=argparse.ArgumentParser();p.add_argument('--candidate',type=Path,required=True);p.add_argument('--baseline',type=Path,default=s/'frontier-native-checkpoint-completed-v19');p.add_argument('--tree',type=Path,required=True);a=p.parse_args();assert shutil.disk_usage(s).free>=900*1024*1024
root=Path(tempfile.mkdtemp(prefix='storage-observer-',dir=s/'benchmarks'));print(root,flush=True);(root/'src').mkdir();(root/'c').mkdir();(root/'silk.toml').write_text('[package]\nname="storage-observer"\nversion="0.0.0"\n[native]\nsources=[{c="c/observe.c"}]\n')
(root/'c/observe.c').write_text('#include <stdint.h>\n#include <stddef.h>\n#include <stdio.h>\nvoid record_observer(uint8_t event, const unsigned char* identity,size_t n,const unsigned char* origin,size_t m){fprintf(stderr,"%u|",(unsigned)event);fwrite(identity,1,n,stderr);fputc(\'|\',stderr);fwrite(origin,1,m,stderr);fputc(\'\\n\',stderr);fflush(stderr);}\n')
original=(a.tree/'corpus/native/raw-buffer-copy-range/main.silk').read_text()
original='import silk.mem.pointer { Pointer }\nimport silk.text.string { String }\n'+original
original=original.replace('pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }','''@foreign(noCapture: .("identity", "origin"))
unsafe extern "C" fn record_observer(event: u8, identity: ?[*]const u8, count: usize, origin: ?[*]const u8, length: usize) -> ()
fn observe(state: &mut i32, event: u8, first: usize, second: usize, identity: string<'static>, origin: string<'static>) -> usize {
  let name = String.utf8Bytes(identity)
  let site = String.utf8Bytes(origin)
  unsafe record_observer(event, Pointer.fromSlice<u8>(name), name.length, Pointer.fromSlice<u8>(site), site.length)
  if event == 0 { return 1 }
  return 0
}
fn observing<'env, S: 'env, A, ?R, F: fn<'static>(&mut S, u8, usize, usize, string<'static>, string<'static>) -> usize + Intrinsic.NonParking>(state: S, observer: F, body: once Effect<'env; A ? R>) -> once Effect<'env; A ? R> {
  return Intrinsic.observeDiagnostics<S, A, R, F>(move state, move observer, move body)
}
pub fn main() -> i32 { return run observing(0, observe, Effect.catchAll(store(), recover)) }''')
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_NATIVE_','SILK_PROFILE_')) and k not in ['LD_PRELOAD','LLVM_PROFILE_FILE']};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang');rows=[]
for label,offset,length in [('destination-start',5,0),('destination-end',3,2),('source-length',0,3)]:
 text=original.replace('RawBuffer.copy<i32>(&mut target, 2, prefix, 2)',f'RawBuffer.copy<i32>(&mut target, {offset}, prefix, {length})');(root/'src/main.silk').write_text(text);pair=[]
 for mode,compiler in [('baseline',a.baseline),('candidate',a.candidate)]:
  shutil.rmtree(root/'build',ignore_errors=True);out=root/(label+'-'+mode)
  command=[str(compiler),'build',str(root/'src/main.silk'),'--stdlib',str(a.tree/'stdlib'),'--optimization','none','--debug','true','--output',str(out)]
  build=subprocess.run(command,cwd=root,env=env,capture_output=True);exits=[]
  while True:
   try:_,status=os.waitpid(-1,0);exits.append(os.waitstatus_to_exitcode(status))
   except ChildProcessError:break
  (root/(label+'-'+mode+'.log')).write_bytes(build.stdout+build.stderr);assert build.returncode==0 and all(x==0 for x in exits),(label,mode,'build')
  run=subprocess.run([str(out)],capture_output=True,timeout=15);assert run.returncode<0,(label,mode,run.returncode)
  assert run.stderr and b'raw_buffer' in run.stderr,(label,mode,'missing authored observer site',run.stderr)
  row={'case':label,'mode':mode,'command':command,'compiler_sha256':hashlib.sha256(compiler.read_bytes()).hexdigest(),'exit':run.returncode,'stdout':run.stdout.decode(errors='replace'),'stderr':run.stderr.decode(errors='replace'),'detached':exits};rows.append(row);(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n');pair.append((run.returncode,run.stdout,run.stderr));shutil.rmtree(Path(str(out)+'.units'),ignore_errors=True)
 assert pair[0]==pair[1],(label,'observer identity/source-origin changed',pair)
 print(label,'PASS',flush=True)
shutil.rmtree(root/'build',ignore_errors=True);print('PASS '+str(root),flush=True)
