"""Untimed helper native/DWARF, Wasm32, or fresh-process cache gates. Scheduled shared lock required."""
import argparse,hashlib,importlib.util,json,os,shutil,subprocess,tempfile
from pathlib import Path
import dwarf_source_facts
s=Path('/workspace/silk/.scratch');p=argparse.ArgumentParser()
p.add_argument('--baseline',type=Path,default=s/'frontier-performance-v17');p.add_argument('--candidate',type=Path,required=True)
p.add_argument('--source',type=Path,default=s/'shared-storage-helpers');p.add_argument('--phase',choices=['native','wasm','cache'],required=True);a=p.parse_args()
assert shutil.disk_usage(s).free>=900*1024*1024,'Need900MiB before native gates'
root=Path(tempfile.mkdtemp(prefix='shared-storage-'+a.phase+'-',dir=s/'benchmarks'));print(root,flush=True)
sha=lambda path:hashlib.sha256(Path(path).read_bytes()).hexdigest()
spec=importlib.util.spec_from_file_location('b',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
blocked=('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_NATIVE_','SILK_PROFILE_','SILK_CACHE_WORK_')
env={k:v for k,v in os.environ.items() if not k.startswith(blocked) and k not in ['LLVM_PROFILE_FILE','LD_PRELOAD']};env['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
meta=dict(phase=a.phase,baseline=str(a.baseline),baseline_sha256=sha(a.baseline),candidate=str(a.candidate),candidate_sha256=sha(a.candidate),source=str(a.source),source_revision=subprocess.check_output(['git','-C',str(a.source),'rev-parse','HEAD'],text=True).strip(),purpose='Correctness only; shared CPU contention and fresh subprocesses, no speed claim')
(root/'metadata.json').write_text(json.dumps(meta,indent=2)+'\n');rows=[]
def measure(command,work,label):
 row=dict(label=label,command=command,**b.measure(command,work,env,root/(label+'.log')));rows.append(row);(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
 assert row['exit_code']==0 and all(x['exit_code']==0 for x in row['detached']),(label,root/(label+'.log'));return row
def package(name,text):
 work=root/name;(work/'src').mkdir(parents=True);(work/'silk.toml').write_text('[package]\nname="storage-test"\nversion="0.0.0"\n');(work/'src/main.silk').write_text(text);return work

def build(compiler,work,out,label,wasm=False):
 command=[str(compiler),'build',str(work/'src/main.silk'),'--output',str(out),'--stdlib',str(a.source/'stdlib'),'--optimization','none','--debug','false' if wasm else 'true']
 if wasm:command+=['--target','wasm32-unknown-unknown','--backend','direct']
 return measure(command,work,label)
if a.phase in ['native','wasm']:
 cases=['raw-buffer-resize-preserves-elements','raw-buffer-copy-range','raw-buffer-over-aligned','zero-sized-copy-list-read']
 if a.phase=='native':cases+=['owned-allocation-slot-bounds-trap','diagnostic-observer-capturing-callback']
 for case in cases:
  fixture=a.source/'corpus/native'/case;work=package(case,(fixture/'main.silk').read_text())
  if (fixture/'c').exists():
   shutil.copytree(fixture/'c',work/'c')
   with (work/'silk.toml').open('a') as f:f.write('[native]\nsources=['+','.join('{c='+json.dumps(str(x.relative_to(work)))+'}' for x in sorted((work/'c').glob('*.c')))+']\n')
  expected=json.loads((fixture/'outcome.json').read_text())['expected'];runs=[];debug=[]
  for mode,compiler in [('baseline',a.baseline),('candidate',a.candidate)]:
   shutil.rmtree(work/'build',ignore_errors=True);out=root/(case+'-'+mode+('.wasm' if a.phase=='wasm' else ''));row=build(compiler,work,out,case+'-'+mode,a.phase=='wasm')
   if a.phase=='wasm':
    code="const fs=require('fs'); const m=new WebAssembly.Module(fs.readFileSync(process.argv[1])); const i=new WebAssembly.Instance(m,{}); const n=i.exports.main(); console.log(n); if(n!==Number(process.argv[2]))process.exit(1)"
    run=subprocess.run(['node','-e',code,str(out),str(expected['exitCode'])],capture_output=True,timeout=30);assert run.returncode==0,(case,mode,run.stderr)
   else:
    run=subprocess.run([str(out)],capture_output=True,timeout=30)
    assert run.returncode==expected['exitCode'] if expected['kind']=='completes' else run.returncode<0,(case,mode,run.returncode)
    dwarf=s/'llvm-22.1.8/bin/llvm-dwarfdump';verified=subprocess.run([str(dwarf),'--verify',str(out)],capture_output=True)
    (root/(case+'-'+mode+'-dwarf.log')).write_bytes(verified.stdout+verified.stderr);assert verified.returncode==0
    debug.append(subprocess.check_output([str(dwarf),'--debug-info',str(out)],text=True))
   row.update(program_exit=run.returncode,stdout=run.stdout.decode(errors='replace'),stderr=run.stderr.decode(errors='replace'),artifact_sha256=sha(out));runs.append((run.returncode,run.stdout,run.stderr));(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
   shutil.rmtree(Path(str(out)+'.units'),ignore_errors=True)
  assert runs[0]==runs[1],(case,'runtime parity',runs)
  if debug:
   facts=dwarf_source_facts.compare(*debug);(root/(case+'-source-debug.json')).write_text(json.dumps(facts,indent=2)+'\n');assert not facts['lost'],(case,'lost typed source debug facts',facts['lost'])
  shutil.rmtree(work/'build',ignore_errors=True);print(case,'PASS',flush=True)
else:
 original=(a.source/'corpus/native/raw-buffer-resize-preserves-elements/main.silk').read_text()
 variants=[('cold',original,42)]
 for stage,kind,number,expected in [('first-edit','u32','18',43),('second-edit','i64','19',44)]:
  text=original.replace('import silk.num.usize','import silk.num.usize\nimport silk.num.'+kind).replace('<i32>','<'+kind+'>').replace('[i32;','['+kind+';').replace('17',number).replace('return first + second','return '+kind+'.toI32(first + second)')
  variants.append((stage,text,expected))
 variants.append(('unchanged',variants[-1][1],44))
 for mode,compiler in [('baseline',a.baseline),('candidate',a.candidate)]:
  work=package(mode,original)
  for stage,text,expected in variants:
   (work/'src/main.silk').write_text(text);out=work/'program'
   row=build(compiler,work,out,mode+'-'+stage)
   run=subprocess.run([str(out)],capture_output=True,timeout=30);assert run.returncode==expected and not run.stdout and not run.stderr,(mode,stage,run.returncode)
   shutil.copy2(out,root/(mode+'-'+stage));row.update(program_exit=run.returncode,artifact_sha256=sha(out));(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
   measure([str(compiler),'check','--manifest-path',str(work/'silk.toml'),'--stdlib',str(a.source/'stdlib'),'--timings'],work,mode+'-'+stage+'-fresh-check')
   # Keep emitted objects/cache through this mode: no reset may hide a missing generated-key replay.
  shutil.rmtree(work/'build',ignore_errors=True);shutil.rmtree(Path(str(work/'program')+'.units'),ignore_errors=True)
print('PASS '+str(root),flush=True)
