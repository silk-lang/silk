"""Executable-closure correctness; caller holds shared performance.lock. No timing assertions."""
import argparse, ctypes, hashlib, json, os, re, shutil, subprocess, tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--compiler',type=Path,required=True);p.add_argument('--tree',type=Path,required=True);p.add_argument('--first-only',action='store_true');a=p.parse_args()
s=Path('/workspace/silk/.scratch');root=Path(tempfile.mkdtemp(prefix='executable-closure-native-',dir=s/'benchmarks'));print(root,flush=True)
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
fixture=s/'executable-closure-fixtures';main=(fixture/'main.silk').read_text();body=(fixture/'operations.silk').read_text();called=main.replace('return ignore(proofOnly)','return invoke(proofOnly)');assert called!=main
work=root/'work';src=work/'src';src.mkdir(parents=True)
(work/'silk.toml').write_text('[package]\nname="executable-closure-gate"\nversion="0.0.0"\n[profiles.gate]\noptimization="none"\ndebug=true\ncodegen-units=1\n')
blocked=('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_NATIVE_','SILK_PROFILE_','SILK_EXECUTABLE_','SILK_CACHE_')
env={k:v for k,v in os.environ.items() if not k.startswith(blocked) and k not in ('LD_PRELOAD','LLVM_PROFILE_FILE')};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
rows=[]
(root/'metadata.json').write_text(json.dumps(dict(compiler=str(a.compiler),sha256=hashlib.sha256(a.compiler.read_bytes()).hexdigest(),tree=str(a.tree),purpose=__doc__),indent=2)+'\n')
def save(): (root/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
def reap():
 out=[]
 while True:
  try: pid,status=os.waitpid(-1,0);out.append([pid,os.waitstatus_to_exitcode(status)])
  except ChildProcessError:return out

def build(label,on,caller=main,callee=body,expected=42,present=False,fresh=False,fail=False):
 if fresh:shutil.rmtree(work/'build',ignore_errors=True)
 (src/'main.silk').write_text(caller);(src/'operations.silk').write_text(callee)
 selected=dict(env)
 if on:selected.update(SILK_EXECUTABLE_CLOSURE='1',SILK_EXECUTABLE_TRACE='1')
 cmd=[str(a.compiler),'build','--manifest-path',str(work/'silk.toml'),'--stdlib',str(a.tree/'stdlib'),'--profile','gate','--progress','plain']
 q=subprocess.run(cmd,cwd=work,env=selected,capture_output=True,timeout=240);children=reap();log=q.stdout+q.stderr;(root/(label+'.log')).write_bytes(log)
 masks=[list(map(int,m)) for m in re.findall(rb'executable closure selected[^\n]*a=(\d+) b=(\d+)',log)]
 row=dict(label=label,on=on,exit=q.returncode,children=children,selection=masks,refused=b'executable closure refused' in log,source_sha256=hashlib.sha256((caller+'\0'+callee).encode()).hexdigest());rows.append(row);save()
 assert all(code==0 for _,code in children),(label,children)
 if fail:
  assert q.returncode!=0,(label,'expected selected backend rejection');print(label,'PASS rejection',flush=True);return row
 assert q.returncode==0,(label,log.decode(errors='replace'))
 exe=work/'build/llvm/x86_64-unknown-linux-gnu/gate/executable-closure-gate'
 result=subprocess.run([str(exe)],capture_output=True,timeout=20);row['runtime']=result.returncode;row['sha256']=hashlib.sha256(exe.read_bytes()).hexdigest();save();assert result.returncode==expected,(label,result.returncode,expected,result.stderr)
 dwarf=s/'llvm-22.1.8/bin/llvm-dwarfdump';verify=subprocess.run([str(dwarf),'--verify',str(exe)],capture_output=True);(root/(label+'.verify.log')).write_bytes(verify.stdout+verify.stderr);assert verify.returncode==0,(label,'DWARF invalid')
 info=subprocess.run([str(dwarf),'--debug-info',str(exe)],capture_output=True,check=True).stdout
 names=[part for part in re.split(rb'(?=0x[0-9a-f]+:\s+DW_TAG_subprogram)',info) if re.search(rb'DW_AT_name\s+\("(?:operations\.)?proofOnly"\)',part)]
 row['proof_only_subprograms']=len(names);save();assert bool(names)==present,(label,'wrong emitted proofOnly presence',len(names),present)
 print(label,'PASS',flush=True);return row

off=build('off-cold',False,present=True,fresh=True)
base=build('on-cold',True,fresh=True)
assert base['selection'] and any(total>selected>0 for total,selected in base['selection']) and not base['refused'],('closure did not actually prune',base)
if a.first_only:raise SystemExit(0)
first=build('proof-only-becomes-called',True,caller=called,expected=9,present=True)
restored=build('called-becomes-proof-only',True)
assert restored['sha256']==base['sha256'],'restoring omitted closure changed artifact'
# The ordinary cache publisher prunes packs not used by current codegen units. The following
# call must recover selected text after that publication, not depend on an old retained pack.
second=build('proof-only-selected-again',True,caller=called,expected=9,present=True)
assert second['sha256']==first['sha256'],'recovered selected definition differs'
build('omit-before-layout-edit',True)
layout=body.replace('first: i32, second: i32','second: i32, first: i32');assert layout!=body
build('proof-only-layout-edit',True,callee=layout)
build('layout-edited-becomes-called',True,caller=called,callee=layout,expected=9,present=True)
restored=build('restore-original',True)
unchanged=build('unchanged',True);assert not unchanged['selection'],'unchanged build reran closure selection'
assert unchanged['sha256']==restored['sha256']==base['sha256']
policy_off=build('policy-off',False,present=True)
policy_on=build('policy-on',True)
assert policy_off['sha256']==off['sha256'] and policy_on['sha256']==base['sha256'],'policy returned stale/wrong artifacts'
unsupported='pub fn proofOnly() -> i32 { if Intrinsic.wasmMemorySize() == 0 { return 9 } return 8 }\n'
build('unused-backend-gap-on',True,callee=unsupported,fresh=True)
build('used-backend-gap-on',True,caller=called,callee=unsupported,fail=True)
build('unused-backend-gap-off',False,callee=unsupported,fresh=True,fail=True)
invalid='pub fn proofOnly() -> i32 { return "wrong" }\n'
# Both policies must reject unused invalid source with exactly equal structured diagnostics.
diags=[]
for on in (False,True):
 shutil.rmtree(work/'build',ignore_errors=True);(src/'main.silk').write_text(main);(src/'operations.silk').write_text(invalid)
 selected=dict(env)
 if on:selected['SILK_EXECUTABLE_CLOSURE']='1'
 q=subprocess.run([str(a.compiler),'check','--stdlib',str(a.tree/'stdlib'),'--progress','never','--json'],cwd=work,env=selected,capture_output=True,timeout=180);children=reap()
 (root/('invalid-source-'+str(on)+'.log')).write_bytes(q.stdout+q.stderr);assert q.returncode!=0 and all(code==0 for _,code in children)
 records=[json.loads(line) for line in q.stderr.splitlines() if line.strip()];assert records
 diags.append(records);rows.append(dict(label='invalid-source-'+str(on),exit=q.returncode,diagnostics=records,children=children));save()
assert diags[0]==diags[1],'closure policy changed ordinary source rejection'
print('PASS '+str(root),flush=True)
