"""Resize native/source/cache gate. Caller must hold shared performance.lock; no timings scored."""
import argparse,ctypes,hashlib,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--compiler',type=Path,required=True);p.add_argument('--tree',type=Path,required=True);p.add_argument('--first-only',action='store_true');p.add_argument('--reference',type=Path);a=p.parse_args()
s=Path('/workspace/silk/.scratch');root=Path(tempfile.mkdtemp(prefix='executable-resize-native-',dir=s/'benchmarks'));print(root,flush=True)
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
original=(s/'executable-resize-fixtures/resize.silk').read_text();adopted=(s/'executable-resize-fixtures/resize-adopted.silk').read_text();rows=[]
blocked=('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_NATIVE_','SILK_PROFILE_','SILK_EXECUTABLE_','SILK_CACHE_')
env={k:v for k,v in os.environ.items() if not k.startswith(blocked) and k not in ('LD_PRELOAD','LLVM_PROFILE_FILE')};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
work=root/'work';(work/'src').mkdir(parents=True);(work/'silk.toml').write_text('[package]\nname="executable-resize-gate"\nversion="0.0.0"\n[profiles.gate]\noptimization="none"\ndebug=true\ncodegen-units=1\n[profiles.gate-speed]\noptimization="speed"\ndebug=true\ncodegen-units=1\n');source=work/'src/main.silk'
compiler_hash=hashlib.sha256(a.compiler.read_bytes()).hexdigest()
def save(): (root/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
def reap():
 children=[]
 while True:
  try:pid,status=os.waitpid(-1,0);children.append([pid,os.waitstatus_to_exitcode(status)])
  except ChildProcessError:return children

def build(label,on,text=original,expected=42,profile='gate',fresh=False,definitions=None,opaque=None):
 if fresh:shutil.rmtree(work/'build',ignore_errors=True)
 source.write_text(text);selected=dict(env)
 if on:selected.update(SILK_EXECUTABLE_SPECIALIZATION='1',SILK_EXECUTABLE_TRACE='1')
 cmd=[str(a.compiler),'build','--manifest-path',str(work/'silk.toml'),'--stdlib',str(a.tree/'stdlib'),'--profile',profile,'--progress','plain']
 r=subprocess.run(cmd,cwd=work,env=selected,capture_output=True,timeout=240);children=reap();log=r.stdout+r.stderr;(root/(label+'.log')).write_bytes(log)
 row=dict(label=label,on=on,profile=profile,compiler_sha256=compiler_hash,source_sha256=hashlib.sha256(text.encode()).hexdigest(),exit=r.returncode,children=children,
  certified=log.count(b'executable schema certified'),templates_reused=log.count(b'executable mir template reused'),text_emitted=log.count(b'executable schema text emitted'),text_reused=log.count(b'executable schema text reused'))
 rows.append(row);save();assert r.returncode==0 and all(code==0 for _,code in children),(label,log.decode(errors='replace'))
 artifact=work/'build/llvm/x86_64-unknown-linux-gnu'/profile/'executable-resize-gate';out=root/label;shutil.copy2(artifact,out)
 result=subprocess.run([str(out)],capture_output=True,timeout=30);row.update(runtime=result.returncode,binary_sha256=hashlib.sha256(out.read_bytes()).hexdigest());save();assert result.returncode==expected,(label,result.returncode,expected,result.stderr)
 verified=subprocess.run([str(s/'llvm-22.1.8/bin/llvm-dwarfdump'),'--verify',str(out)],capture_output=True);(root/(label+'.verify.log')).write_bytes(verified.stdout+verified.stderr);assert verified.returncode==0,(label,'invalid DWARF')
 if definitions is not None:
  info=subprocess.run([str(s/'llvm-22.1.8/bin/llvm-dwarfdump'),'--debug-info',str(out)],capture_output=True,check=True).stdout
  (root/(label+'.debug.txt')).write_bytes(info)
  functions=[part for part in re.split(rb'(?=0x[0-9a-f]+:\s+DW_TAG_subprogram)',info) if re.search(rb'DW_AT_name\s+\("(?:main\.)?grow_buffer"\)',part)]
  assert len(functions)==definitions,(label,'definition count',len(functions),definitions)
  symbols=subprocess.run([str(s/'llvm-22.1.8/bin/llvm-nm'),'--defined-only','--numeric-sort',str(out)],capture_output=True,check=True).stdout
  names=[]
  for part in functions:
   assert (b'RawBuffer<opaque>' in part)==opaque,(label,'incorrect generic debug representation')
   for parameter in (b'storage',b'count'):
    assert re.search(rb'DW_AT_name\s+\("'+parameter+rb'"\)',part),(label,'missing authored parameter',parameter)
   assert b'DW_AT_location' in part,(label,'missing parameter machine location')
   if opaque:
    # Member DIEs belong to the referenced composite, not the subprogram's children.
    dies=list(re.finditer(rb'^0x([0-9a-f]+):( +)DW_TAG_([^\n]+)',info,re.M))
    def die(offset):
     for index,entry in enumerate(dies):
      if int(entry.group(1),16)==offset:
       end=len(info)
       for later in dies[index+1:]:
        if len(later.group(2))<=len(entry.group(2)):end=later.start();break
       return info[entry.start():end]
     raise AssertionError((label,'missing referenced debug DIE',offset))
    pointer=re.search(rb'DW_AT_type\s+\(0x([0-9a-f]+) "RawBuffer<opaque> \*"\)',part);assert pointer,(label,'opaque parameter pointer absent')
    target=re.search(rb'DW_AT_type\s+\(0x([0-9a-f]+)',die(int(pointer.group(1),16)));assert target
    header=die(int(target.group(1),16));assert b'DW_TAG_structure_type' in header
    for field in (b'base',b'count',b'context',b'reclaim'):
     assert re.search(rb'DW_AT_name\s+\("'+field+rb'"\)',header),(label,'missing opaque header field',field)
   pc=re.search(rb'DW_AT_low_pc\s+\(0x([0-9a-fA-F]+)\)',part);assert pc
   matching=[name.decode() for addr,name in re.findall(rb'^([0-9a-fA-F]+)\s+[A-Za-z]\s+(\S+)$',symbols,re.M) if int(addr,16)==int(pc.group(1),16)]
   assert len(matching)==1,(label,'canonical linkage ambiguous',matching);names+=matching
  row['linkages']=sorted(names);row['definitions']=len(functions)
 row['cache_files']=sum(x.is_file() for x in (work/'build/cache').rglob('*'));assert row['cache_files']>0
 save();print(label,'PASS',flush=True)
 # Discard redundant copied runners after retaining digests and debug evidence; cache remains for edits.
 out.unlink()
 return row

reference=None
if a.reference:
 candidate=a.compiler;a.compiler=a.reference;compiler_hash=hashlib.sha256(a.compiler.read_bytes()).hexdigest()
 reference=build('reference-on-cold',True,fresh=True,definitions=3,opaque=True)
 a.compiler=candidate;compiler_hash=hashlib.sha256(a.compiler.read_bytes()).hexdigest()
first=build('on-cold',True,fresh=True,definitions=3,opaque=True)
if reference:assert reference['binary_sha256']==first['binary_sha256'],'preparation changed identical-program native artifact'
assert first['certified']>=5 and first['templates_reused']>=2 and first['text_reused']>=2,('specialization not actually used',first)
if a.first_only:raise SystemExit(0)
build('off-cold',False,fresh=True,definitions=5,opaque=False)
reordered=original.replace('  let first = run signed()\n  let second = run unsigned()\n  let third = run nominal()', '  let third = run nominal()\n  let second = run unsigned()\n  let first = run signed()')
assert reordered!=original
other=build('on-reordered',True,text=reordered,fresh=True,definitions=3,opaque=True)
assert first['linkages']==other['linkages'],'representative order changed executable identities'
build('on-speed',True,profile='gate-speed',fresh=True)
build('off-speed',False,profile='gate-speed',fresh=True)
build('on-adopted',True,text=adopted,fresh=True,definitions=1,opaque=True)
build('off-adopted',False,text=adopted,fresh=True,definitions=1,opaque=False)
base=build('cache-cold',True,fresh=True,definitions=3,opaque=True)
layout=original.replace('struct Element {value: i32}','struct Element {value: i32, padding: i32}').replace('Element {value: 17}','Element {value: 17, padding: 91}').replace('Element {value: 25}','Element {value: 25, padding: 92}')
assert layout!=original
layout_on=build('cache-layout-edit',True,text=layout,definitions=4,opaque=True)
assert len(set(layout_on['linkages'])-set(base['linkages']))==1,'one changed element layout must add one canonical body'
restored=build('cache-layout-restored',True,definitions=3,opaque=True)
assert restored['binary_sha256']==base['binary_sha256'],'layout restore changed canonical artifact'
certificate=original.replace('return Intrinsic.rawBufferResize<T>(&mut storage, count)','let grown = Intrinsic.rawBufferResize<T>(&mut storage, count) return grown')
assert certificate!=original
build('cache-certificate-refusal',True,text=certificate,definitions=5,opaque=False)
body=original.replace('return Intrinsic.rawBufferResize<T>(&mut storage, count)','return false')
build('cache-body-change',True,text=body,expected=4,definitions=5,opaque=False)
restored=build('cache-body-restored',True,definitions=3,opaque=True)
unchanged=build('cache-unchanged',True,definitions=3,opaque=True)
assert unchanged['certified']==0 and unchanged['text_emitted']==0 and unchanged['templates_reused']==0,'unchanged build did compiler work'
policy_off=build('cache-policy-off',False,definitions=5,opaque=False)
policy_on=build('cache-policy-on',True,definitions=3,opaque=True)
assert restored['binary_sha256']==unchanged['binary_sha256']==policy_on['binary_sha256'],'ON artifact not recovered exactly'
assert policy_off['binary_sha256']!=policy_on['binary_sha256'],'policy change returned stale representation'
print('PASS '+str(root),flush=True)
