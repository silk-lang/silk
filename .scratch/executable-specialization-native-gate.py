"""Count executable identity, source/debug and cache correctness. Caller holds shared lock."""
import argparse,ctypes,hashlib,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--compiler',type=Path,required=True);p.add_argument('--tree',type=Path,required=True);p.add_argument('--first-only',action='store_true');p.add_argument('--fixture',type=Path);p.add_argument('--cached',action='store_true');a=p.parse_args()
s=Path('/workspace/silk/.scratch');root=Path(tempfile.mkdtemp(prefix='executable-count-native-',dir=s/'benchmarks'));print(root,flush=True)
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
original=(a.fixture or s/'executable-specialization-fixtures/count.silk').read_text();rows=[]
blocked=('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_NATIVE_','SILK_PROFILE_','SILK_EXECUTABLE_','SILK_CACHE_')
env={k:v for k,v in os.environ.items() if not k.startswith(blocked) and k not in ('LD_PRELOAD','LLVM_PROFILE_FILE')};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
work=root/'work';(work/'src').mkdir(parents=True);(work/'silk.toml').write_text('[package]\nname="executable-count-gate"\nversion="0.0.0"\n[profiles.gate]\noptimization="none"\ndebug=true\ncodegen-units=1\n[profiles.gate-speed]\noptimization="speed"\ndebug=true\ncodegen-units=1\n');source=work/'src/main.silk';source.write_text(original)
def reaped():
 result=[]
 while True:
  try:pid,status=os.waitpid(-1,0);result.append({'pid':pid,'exit':os.waitstatus_to_exitcode(status)})
  except ChildProcessError:return result

def build(label,enabled,text=original,expected=42,optimization='none',fresh=False,need_scope=False):
 if fresh:shutil.rmtree(work/'build',ignore_errors=True)
 source.write_text(text);out=work/label;selected=dict(env)
 if enabled:selected['SILK_EXECUTABLE_SPECIALIZATION']='1';selected['SILK_EXECUTABLE_TRACE']='1'
 cmd=[str(a.compiler),'build',str(source),'--stdlib',str(a.tree/'stdlib'),'--optimization',optimization,'--debug','true','--output',str(out)]
 if a.cached:
  profile='gate' if optimization=='none' else 'gate-speed'
  cmd=[str(a.compiler),'build','--manifest-path',str(work/'silk.toml'),'--stdlib',str(a.tree/'stdlib'),'--profile',profile,'--progress','plain','--timings']
 result=subprocess.run(cmd,cwd=work,env=selected,capture_output=True,timeout=180);children=reaped();log=result.stdout+result.stderr;(root/(label+'.log')).write_bytes(log)
 row={'label':label,'enabled':enabled,'optimization':optimization,'source_sha256':hashlib.sha256(text.encode()).hexdigest(),'compiler_sha256':hashlib.sha256(a.compiler.read_bytes()).hexdigest(),'build_exit':result.returncode,'detached':children,'certified':log.count(b'executable count certified'),'text_emitted':log.count(b'executable count text emitted'),'text_reused':log.count(b'executable count text reused')};rows.append(row);(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
 assert result.returncode==0 and all(x['exit']==0 for x in children),(label,log.decode(errors='replace'))
 if a.cached:
  produced=work/'build/llvm/x86_64-unknown-linux-gnu'/profile/'executable-count-gate'
  assert produced.is_file(),(label,'manifest artifact missing',str(produced))
  shutil.copy2(produced,out)
  row['persistent_cache_files']=len([x for x in (work/'build/cache').rglob('*') if x.is_file()]);assert row['persistent_cache_files']>0,(label,'cache not written')
 run=subprocess.run([str(out)],capture_output=True,timeout=30);row.update(runtime_exit=run.returncode,stdout=run.stdout.decode(),stderr=run.stderr.decode(),binary_sha256=hashlib.sha256(out.read_bytes()).hexdigest());assert run.returncode==expected,(label,run.returncode,expected,run.stderr)
 dwarf=subprocess.run([str(s/'llvm-22.1.8/bin/llvm-dwarfdump'),'--verify',str(out)],capture_output=True);(root/(label+'.dwarf-verify.log')).write_bytes(dwarf.stdout+dwarf.stderr);assert dwarf.returncode==0,(label,'dwarf verification')
 if need_scope or (optimization=='none' and text==original):
  info=subprocess.run([str(s/'llvm-22.1.8/bin/llvm-dwarfdump'),'--debug-info',str(out)],capture_output=True,check=True).stdout
  (root/(label+'.dwarf-info.txt')).write_bytes(info)
  sections=re.split(rb'(?=0x[0-9a-f]+:\s+DW_TAG_subprogram)',info)
  selected_functions=[part for part in sections if re.search(rb'DW_AT_name\s+\("(?:main\.)?measure_slots"\)',part)]
  assert len(selected_functions)==(1 if enabled else 2),(label,'wrong policy artifact representation',len(selected_functions))
  row['count_definitions']=len(selected_functions)
  for function in selected_functions:
   assert (b'RawBuffer<opaque>' in function)==enabled,(label,'stale policy debug representation')
  if not enabled:
   row['dwarf_verified']=True;(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n');print(label,'PASS ordinary exact definitions',flush=True)
   shutil.rmtree(Path(str(out)+'.units'),ignore_errors=True)
   return row
  chosen=selected_functions[0];assert b'DW_AT_location' in chosen and re.search(rb'DW_AT_name\s+\("storage"\)',chosen),(label,'authored parameter location missing')
  parameter=chosen.split(b'DW_TAG_formal_parameter',1)[1]
  assert re.search(rb'DW_AT_decl_line\s+\(9\)',parameter),(label,'authored parameter declaration line is not 9')
  address=re.search(rb'DW_AT_low_pc\s+\(0x([0-9a-fA-F]+)\)',chosen);assert address,(label,'Count code range absent')
  symbols=subprocess.run([str(s/'llvm-22.1.8/bin/llvm-nm'),'--defined-only','--numeric-sort',str(out)],capture_output=True,check=True).stdout
  matched=[name.decode() for value,name in re.findall(rb'^([0-9a-fA-F]+)\s+[A-Za-z]\s+(\S+)$',symbols,re.M) if int(value,16)==int(address.group(1),16)]
  assert len(matched)==1,(label,'Count exact symbol not unique',matched)
  row['count_linkage']=matched[0];row['opaque_debug_verified']=True
  high=re.search(rb'DW_AT_high_pc\s+\(0x([0-9a-fA-F]+)\)',chosen);assert high
  lines=subprocess.run([str(s/'llvm-22.1.8/bin/llvm-dwarfdump'),'--debug-line',str(out)],capture_output=True,check=True).stdout
  selected_lines=[int(line) for pc,line in re.findall(rb'^0x([0-9a-fA-F]+)\s+(\d+)\s+',lines,re.M) if int(address.group(1),16)<=int(pc,16)<int(high.group(1),16)]
  assert 10 in selected_lines,(label,'authored Count operation line is absent',selected_lines)
  row['parameter_line']=9;row['operation_line']=10;row['code_lines']=selected_lines
  dis=subprocess.run([str(s/'llvm-22.1.8/bin/llvm-objdump'),'--disassemble-symbols='+matched[0],'--no-show-raw-insn','--no-leading-addr',str(out)],capture_output=True,check=True).stdout
  # Count has no callees or relocations; instruction lines exclude file/symbol headings.
  instructions=b'\n'.join(line.strip() for line in dis.splitlines() if re.match(rb'^\s+[a-z][a-z0-9.]+(?:\s|$)',line))
  assert instructions,(label,'disassembly absent');row['count_instruction_sha256']=hashlib.sha256(instructions).hexdigest();(root/(label+'.count-disassembly.txt')).write_bytes(dis)
 row['dwarf_verified']=True;(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n');print(label,'PASS',row['certified'],row['text_emitted'],row['text_reused'],flush=True)
 shutil.rmtree(Path(str(out)+'.units'),ignore_errors=True)
 return row
first=build('on-cold',True,fresh=True,need_scope=True)
assert first['certified']>=2 and first['text_reused']>=1 and first['text_emitted']>=1,('missing actual specialization',first)
if a.first_only:print('PASS first '+str(root),flush=True);raise SystemExit(0)
build('off-cold',False,fresh=True)
reordered=original.replace('    let firstCount = measure_slots<u8>(&narrow)\n    let secondCount = measure_slots<[u64; 3]>(&wide)', '    let secondCount = measure_slots<[u64; 3]>(&wide)\n    let firstCount = measure_slots<u8>(&narrow)')
assert reordered!=original
other=build('on-reordered',True,text=reordered,fresh=True,need_scope=True)
assert first['count_linkage']==other['count_linkage'] and first.get('count_instruction_sha256')==other.get('count_instruction_sha256'),('representative-dependent canonical code',first,other)
build('on-speed',True,optimization='speed',fresh=True)
build('off-speed',False,optimization='speed',fresh=True)
# Immediate separate-process cache edits: no priming or unrelated invocation between stages.
build('cache-cold',True,fresh=True)
changed=original.replace('return Intrinsic.rawBufferCount<T>(storage)','return Intrinsic.rawBufferCount<T>(storage) + 1')
assert changed!=original
build('cache-lost-certificate',True,text=changed,expected=44)
restored=build('cache-restored-certificate',True)
unchanged=build('cache-unchanged',True)
if a.cached:assert unchanged['certified']==0 and unchanged['text_emitted']==0 and unchanged['text_reused']==0,('unchanged manifest build unexpectedly reexecuted Count',unchanged)
policy_off=build('cache-policy-off',False)
policy_on=build('cache-policy-on',True)
policy_off_again=build('cache-policy-off-again',False)
assert restored['binary_sha256']==unchanged['binary_sha256']==policy_on['binary_sha256'], 'returning ON must recover the exact ON artifact'
assert policy_off['binary_sha256']==policy_off_again['binary_sha256'], 'returning OFF must recover the exact OFF artifact'
assert policy_off['binary_sha256']!=policy_on['binary_sha256'], 'policy must change native representation'
# Fresh reference for the changed body proves the expected result independently.
build('changed-fresh-off',False,text=changed,expected=44,fresh=True)
print('PASS '+str(root),flush=True)
