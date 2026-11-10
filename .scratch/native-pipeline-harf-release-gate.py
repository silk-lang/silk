"""Caller holds performance.lock; native release correctness only unless run exclusively."""
import argparse, hashlib, importlib.util, json, os, shutil, subprocess, tempfile
from pathlib import Path
s=Path('/workspace/silk/.scratch')
spec=importlib.util.spec_from_file_location('cold',s/'benchmarks/cold_bench.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
p=argparse.ArgumentParser();p.add_argument('--compiler',type=Path,required=True);p.add_argument('--stdlib',type=Path,required=True)
p.add_argument('--source-revision',required=True);p.add_argument('--require-early-checkpoint',action='store_true');p.add_argument('--require-checkpoint-completion',action='store_true');p.add_argument('--feature',action='append',default=[])
a=p.parse_args();compiler=a.compiler.resolve();stdlib=a.stdlib.resolve()
allowed=sorted(os.sched_getaffinity(0));cpus={0,1,2,3} if {0,1,2,3}<=set(allowed) else set(allowed[:4])
assert len(cpus)==4,'positive pool gate requires four allowed CPUs'
os.sched_setaffinity(0,cpus)
assert shutil.disk_usage(s).free>700*1024*1024,'need700MiB before source snapshot/build'
r=Path(tempfile.mkdtemp(prefix='native-pipeline-harf-release-',dir=s/'benchmarks'));tree=r/'nonstd'
revision=b.snapshot(Path('/workspace/nonstd'),tree)
assert revision=='ccb168b773bb56d7bd60a3495141d427149766d0',revision
cwd=tree/'fonts/shape/tools/cli'
profile='\n[profiles.pipeline-release]\noptimization = "speed"\ndebug = false\ncodegen-units = 4\n'
# Both workspace and direct package selection see the same explicit profile.
for manifest in [tree/'silk.toml',cwd/'silk.toml']:
 text=manifest.read_text();assert '[profiles.pipeline-release]' not in text;manifest.write_text(text+profile)
font=Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');assert font.is_file()
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_','SILK_NATIVE_BUILD_PIPELINE','SILK_CACHE_WORK_'))}
env.update(SILK_CLANG=str(s/'llvm-22.1.8/bin/clang'),SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_WARM='0',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1',SILK_RETAINED_BUILD='1',SILK_RETAINED_CACHE='1',SILK_FRONTIER_REUSE_COMPLETED='1')
for feature in a.feature:
 name,sep,value=feature.partition('=');assert sep and name.startswith('SILK_') and name!='SILK_NATIVE_BUILD_PIPELINE';env[name]=value
meta=dict(compiler=str(compiler),compiler_sha256=hashlib.sha256(compiler.read_bytes()).hexdigest(),compiler_source=a.source_revision,stdlib=str(stdlib),workload_revision=revision,cpus=sorted(cpus),profile='pipeline-release',codegen_units=4,optimization='speed',debug=False,font=str(font),font_sha256=hashlib.sha256(font.read_bytes()).hexdigest(),purpose='Same-binary cold optimized native overlap, standard4MiB partition threshold unchanged; exact artifacts and real shaping output. No performance claim from contended execution.')
(r/'metadata.json').write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps({'root':str(r),**meta}),flush=True)
rows=[]
for mode in ('off','on'):
 shutil.rmtree(tree/'build',ignore_errors=True)
 e=dict(env)
 if mode=='on':e['SILK_NATIVE_BUILD_PIPELINE']='1'
 cmd=[str(compiler),'build','--profile','pipeline-release','--stdlib',str(stdlib),'--progress','plain','--timings']
 log=r/f'cold-{mode}.log'
 row=dict(mode=mode,command=cmd,environment={k:v for k,v in e.items() if k.startswith('SILK_')},**b.measure(cmd,cwd,e,log))
 trace=log.read_text();row.update(frontier='frontier accepted' in trace,started='frontier native coordinator started' in trace,published='frontier native objects published' in trace,refused='frontier native coordinator refused' in trace,diagnostics=[v for v in trace.splitlines() if ': warning[' in v or ': error[' in v])
 rows.append(row);(r/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
 assert row['exit_code']==0 and all(v['exit_code']==0 for v in row['detached']),log
 assert row['frontier'] and row['started']==(mode=='on') and row['published']==(mode=='on') and not row['refused'],('required native engagement',row)
 if a.require_early_checkpoint:
  assert trace.count('frontier native cache checkpoint')==int(mode=='on'),('checkpoint count',row)
  if mode=='on':assert trace.index('frontier native cache checkpoint')<trace.index('frontier native objects published'),('late checkpoint',row)
 if a.require_checkpoint_completion:
  assert trace.count('frontier native cache completed')==int(mode=='on'),('completion count',row)
  if mode=='on':
   assert trace.index('frontier native objects published')<trace.index('frontier native cache completed'),('completion must follow native publication',row)
   assert row['detached']==[],('accepted checkpoint writer must be parent-reaped',row)
 binary=tree/'build/llvm/x86_64-unknown-linux-gnu/pipeline-release/font-shape-cli';assert binary.is_file(),binary
 row['binary_sha256']=hashlib.sha256(binary.read_bytes()).hexdigest();shutil.copy2(binary,r/f'font-shape-{mode}')
 objects=Path(str(binary)+'.units');row['objects']={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(objects.glob('*.o'))}
 assert len(row['objects'])>=2,('release workload must actually split',row)
 row['runtime']=[]
 for n,args in enumerate([['--help'],[str(font),'office AV kerning'],[str(font),'مرحبا بالعالم','--direction=rtl','--script=Arab']]):
  run=subprocess.run([str(binary),*args],cwd=cwd,capture_output=True,timeout=30)
  (r/f'{mode}-runtime-{n}.stdout').write_bytes(run.stdout);(r/f'{mode}-runtime-{n}.stderr').write_bytes(run.stderr)
  row['runtime'].append({'args':args,'exit':run.returncode,'stdout_sha256':hashlib.sha256(run.stdout).hexdigest(),'stderr_sha256':hashlib.sha256(run.stderr).hexdigest()})
  assert run.returncode==0 and run.stdout,('runtime failed',mode,n,run.returncode,run.stderr)
 assert not list((tree/'build').rglob('.silk-native-*')),('private staging leaked',mode)
 (r/'results.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(row),flush=True)
 if mode=='on':
  for key in ('binary_sha256','objects','runtime','diagnostics'):assert row[key]==rows[0][key],('off/on mismatch',key)
 shutil.rmtree(tree/'build')
print('PASS '+str(r),flush=True)
