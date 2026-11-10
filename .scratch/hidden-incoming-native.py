"""Hidden-lane observer/provider/coroutine parity; caller holds shared performance lock."""
import argparse,ctypes,hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path
s=Path('/workspace/silk/.scratch');p=argparse.ArgumentParser();p.add_argument('--candidate',type=Path,required=True);p.add_argument('--baseline',type=Path,default=s/'frontier-native-work-v20-repaired');p.add_argument('--tree',type=Path,required=True);a=p.parse_args()
root=Path(tempfile.mkdtemp(prefix='hidden-incoming-native-',dir=s/'benchmarks'));print(root,flush=True)
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
cases=['diagnostic-observer-capturing-callback','diagnostic-observer-release-balance','diagnostic-observer-cancelled-handler-release','owned-provider-shared-dispatch','mixed-service-provider-suspension','owned-provider-suspended-failure']
trace='''
@foreign(noCapture: .("identity", "origin"))
unsafe extern "C" fn record_observer(event: u8, identity: ?[*]const u8, count: usize, origin: ?[*]const u8, length: usize) -> ()
fn logEvent(event: u8, identity: string<'static>, origin: string<'static>) -> () {
  let name = String.utf8Bytes(identity)
  let site = String.utf8Bytes(origin)
  unsafe record_observer(event, Pointer.fromSlice<u8>(name), name.length, Pointer.fromSlice<u8>(site), site.length)
}
'''
csource='#include <stdint.h>\n#include <stddef.h>\n#include <stdio.h>\nvoid record_observer(uint8_t event,const unsigned char* identity,size_t n,const unsigned char* origin,size_t m){fprintf(stderr,"%u|",(unsigned)event);fwrite(identity,1,n,stderr);fputc(\'|\',stderr);fwrite(origin,1,m,stderr);fputc(\'\\n\',stderr);fflush(stderr);}\n'
blocked=('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_NATIVE_','SILK_PROFILE_')
env={k:v for k,v in os.environ.items() if not k.startswith(blocked) and k not in ['LD_PRELOAD','LLVM_PROFILE_FILE']};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang');rows=[]
for case in cases:
 work=root/case;(work/'src').mkdir(parents=True);source=a.tree/'corpus/native'/case/'main.silk';text=source.read_text();observed=case.startswith('diagnostic-observer-')
 (work/'silk.toml').write_text('[package]\nname="hidden-incoming"\nversion="0.0.0"\n'+('[native]\nsources=[{c="c/observe.c"}]\n' if observed else ''))
 if observed:
  (work/'c').mkdir();(work/'c/observe.c').write_text(csource)
  if case.endswith('capturing-callback'):
   marker='    Shared.withMut(&state.*, weigh(event, weight))';assert text.count(marker)==1;text=text.replace(marker,'    logEvent(event, identity, origin)\n'+marker)
  else:
   marker='  return Shared.withMut(&state.state, event(operation, first))';assert text.count(marker)==1;text=text.replace(marker,'  logEvent(operation, identity, origin)\n'+marker)
  text='import silk.mem.pointer {Pointer}\nimport silk.text.string {String}\n'+text+'\n'+trace
 (work/'src/main.silk').write_text(text)
 expected=json.loads((source.parent/'outcome.json').read_text())['expected']['exitCode']
 for optimization in (['none','speed'] if case in ('diagnostic-observer-release-balance','owned-provider-shared-dispatch') else ['none']):
  pair=[]
  for mode,compiler in [('baseline',a.baseline),('candidate',a.candidate)]:
   shutil.rmtree(work/'build',ignore_errors=True);output=work/(mode+'-'+optimization)
   cmd=[str(compiler),'build',str(work/'src/main.silk'),'--stdlib',str(a.tree/'stdlib'),'--optimization',optimization,'--debug','true','--output',str(output)]
   q=subprocess.run(cmd,cwd=work,env=env,capture_output=True,timeout=180);children=[]
   while True:
    try:_,status=os.waitpid(-1,0);children.append(os.waitstatus_to_exitcode(status))
    except ChildProcessError:break
   (work/(mode+'-'+optimization+'.log')).write_bytes(q.stdout+q.stderr);assert q.returncode==0 and all(x==0 for x in children),(case,optimization,mode,q.stderr.decode())
   result=subprocess.run([str(output)],capture_output=True,timeout=30);assert result.returncode==expected,(case,optimization,mode,result.returncode,result.stderr)
   verify=subprocess.run([str(s/'llvm-22.1.8/bin/llvm-dwarfdump'),'--verify',str(output)],capture_output=True);(work/(mode+'-'+optimization+'.dwarf-verify.log')).write_bytes(verify.stdout+verify.stderr);assert verify.returncode==0
   if observed:assert result.stderr and b'|' in result.stderr,(case,'missing event trace')
   row={'case':case,'optimization':optimization,'mode':mode,'compiler_sha256':hashlib.sha256(compiler.read_bytes()).hexdigest(),'source_sha256':hashlib.sha256(text.encode()).hexdigest(),'exit':result.returncode,'stdout':result.stdout.decode(),'stderr':result.stderr.decode(),'dwarf_verified':True,'detached':children};rows.append(row);pair.append(row);(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n');print(case,optimization,mode,'PASS',flush=True)
   shutil.rmtree(Path(str(output)+'.units'),ignore_errors=True)
  assert [(x['exit'],x['stdout'],x['stderr']) for x in pair][0]==[(x['exit'],x['stdout'],x['stderr']) for x in pair][1],(case,optimization,'complete ordered runtime event/source mismatch')
  if optimization=='none':
   parity=subprocess.run(['python3',str(s/'fixture-dwarf-parity.py'),'--left',str(work/'baseline-none'),'--right',str(work/'candidate-none'),'--source',str(work/'src/main.silk'),'--output',str(work/'dwarf-parity.json')],capture_output=True,text=True)
   (work/'dwarf-parity.log').write_text(parity.stdout+parity.stderr);assert parity.returncode==0,(case,'DWARF fixture identity/location-kind mismatch')
 shutil.rmtree(work/'build',ignore_errors=True)
print('PASS '+str(root),flush=True)
