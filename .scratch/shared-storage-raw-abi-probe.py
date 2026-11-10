"""Generated copy-helper ABI probe; not authored shared-slice aliasing coverage.
Caller owns one scheduled shared performance slot. Two tiny candidate builds only.
"""
import argparse,ctypes,hashlib,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
s=Path('/workspace/silk/.scratch');p=argparse.ArgumentParser();p.add_argument('--candidate',type=Path,required=True);p.add_argument('--tree',type=Path,required=True);a=p.parse_args()
assert shutil.disk_usage(s).free>=900*1024*1024
root=Path(tempfile.mkdtemp(prefix='storage-raw-abi-',dir=s/'benchmarks'));print(root,flush=True)
(root/'src').mkdir();(root/'c').mkdir()
(root/'silk.toml').write_text('[package]\nname="storage-raw-abi"\nversion="0.0.0"\n[native]\nsources=[{c="c/probe.c"}]\n')
text=(a.tree/'corpus/native/raw-buffer-copy-range/main.silk').read_text()
text=text.replace('RawBuffer.copy<i32>(&mut target, 2, prefix, 2)','copyForAbi(&mut target, 2, prefix, 2)')
text=text.replace('pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }','''unsafe extern "C" fn verify_raw_storage_abi() -> i32
unsafe fn copyForAbi(buffer: &mut Intrinsic.RawBuffer<i32>, offset: usize, source: &[i32], length: usize) -> () {
  unsafe { return Intrinsic.rawBufferCopy<i32>(&mut buffer, offset, source, length) }
}
pub fn main() -> i32 {
  let result = run Effect.catchAll(store(), recover)
  if result != 76 { return 99 }
  return unsafe verify_raw_storage_abi()
}''')
(root/'src/main.silk').write_text(text);(root/'c/probe.c').write_text('int verify_raw_storage_abi(void) { return 0; }\n')
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_NATIVE_','SILK_PROFILE_')) and k not in ['LD_PRELOAD','LLVM_PROFILE_FILE']};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang');rows=[]
def invoke(command,label):
 r=subprocess.run(command,cwd=root,env=env,capture_output=True);exits=[]
 while True:
  try:_,status=os.waitpid(-1,0);exits.append(os.waitstatus_to_exitcode(status))
  except ChildProcessError:break
 (root/(label+'.log')).write_bytes(r.stdout+r.stderr);rows.append({'label':label,'command':command,'exit':r.returncode,'detached':exits});(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n');assert r.returncode==0 and all(x==0 for x in exits),label
base=[str(a.candidate),'build',str(root/'src/main.silk'),'--stdlib',str(a.tree/'stdlib'),'--optimization','none','--debug','true']
ir=root/'probe.ll';invoke(base+['--emit','llvm-ir','--output',str(ir)],'emit')
lines=Path(str(ir)+'.symbols').read_text().splitlines();wrapper=[x.split('\t')[0] for x in lines if x.endswith('::copyForAbi')];assert len(wrapper)==1,wrapper
functions={}
for m in re.finditer(r'^define\b[^\n]*@([A-Za-z0-9_.$]+)\([^\n]*\)[^\n]*\{\n(.*?)^\}',ir.read_text(),re.M|re.S):functions[m.group(1)]=m.group(0)
helpers={x.split('\t')[0] for x in lines if '\thelper\t' in x and x.endswith('::RawBuffer')}
selected=helpers & set(re.findall(r'@([A-Za-z0-9_.$]+)\(',functions[wrapper[0]]));assert len(selected)==1,selected
helper=selected.pop();signature=functions[helper].splitlines()[0];assert re.search(r'\bi1\s+@',signature),signature
code=r'''#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
extern bool shared_copy(void *, size_t, const void *, size_t, size_t) __asm__("HELPER");
int verify_raw_storage_abi(void) {
  int32_t a[4]={1,2,3,4}; uintptr_t h[4]={(uintptr_t)a,4,0,0};
  if (!shared_copy(h,1,a,4,3)) return 1;
  const int32_t right[4]={1,1,2,3}; if(memcmp(a,right,sizeof a))return 2;
  if (!shared_copy(h,0,a+1,3,3)) return 3;
  const int32_t left[4]={1,2,3,3}; if(memcmp(a,left,sizeof a))return 4;
  if (!shared_copy(h,4,a,0,0)) return 5;
  if (shared_copy(h,5,a,4,0)) return 6;
  if (shared_copy(h,3,a,4,2)) return 7;
  if (shared_copy(h,0,a,1,2)) return 8;
  if(memcmp(a,left,sizeof a))return 9;
  return 0;
}
'''.replace('HELPER',helper)
(root/'c/probe.c').write_text(code)
out=root/'program';invoke(base+['--output',str(out)],'build');invoke([str(out)],'runtime')
meta={'source':subprocess.check_output(['git','-C',str(a.tree),'rev-parse','HEAD'],text=True).strip(),'candidate':str(a.candidate),'candidate_sha256':hashlib.sha256(a.candidate.read_bytes()).hexdigest(),'helper':helper,'signature':signature,'purpose':'Raw generated-helper ABI alias/range test. No authored shared-slice overlap is constructed. Four-word sealed header representation is an internal lowering fixture, not a source API promise.'};(root/'metadata.json').write_text(json.dumps(meta,indent=2)+'\n')
shutil.rmtree(root/'build',ignore_errors=True);shutil.rmtree(Path(str(out)+'.units'),ignore_errors=True)
print('PASS '+str(root),flush=True)
