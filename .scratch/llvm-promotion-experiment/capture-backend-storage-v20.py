#!/usr/bin/env python3
"""Untimed backend-storage native-pack capture, using the exact scheduled matrix's source/CPU lane.
No workloads run unless explicitly invoked under a scheduled shared lock.
"""
from pathlib import Path
import argparse, hashlib, importlib.util, io, json, os, re, subprocess, sys, tarfile, shutil
s=Path('/workspace/silk/.scratch')
p=argparse.ArgumentParser()
p.add_argument('output',type=Path)
p.add_argument('--workload',choices=['compiler','harfrust'],required=True)
p.add_argument('--matrix',type=Path,default=s/'benchmarks/integrated-incremental-q8sjib9c/metadata.json')
p.add_argument('--binary',type=Path,required=True)
p.add_argument('--compiler-metadata',type=Path,required=True)
a=p.parse_args();metadata=json.loads(a.matrix.read_text());construction=json.loads(a.compiler_metadata.read_text());candidate={'path':str(a.binary.resolve()),'source_revision':construction['source'],'sha256':construction['sha256']}
assert construction['source']=='0b984e03229d055fceb9d9eac71fce27a236e24e' and construction['codegen_units']==4 and construction['profile_use'] is None,construction
binary=Path(candidate['path']);assert hashlib.sha256(binary.read_bytes()).hexdigest()==candidate['sha256']
assert metadata['profile']=='default'
os.sched_setaffinity(0,set(metadata['cpus']))
assert shutil.disk_usage(s).free >= 900*1024*1024, 'Capture needs at least900MiB free before source/cache/input staging'
root=a.output.resolve();root.mkdir(parents=True,exist_ok=False)
def archive(repo,name):
    revision=metadata['revisions'][name]
    data=subprocess.check_output(['git','archive',revision],cwd=repo)
    source=root/name;source.mkdir()
    with tarfile.open(fileobj=io.BytesIO(data)) as bundle:bundle.extractall(source,filter='data')
    return source,hashlib.sha256(data).hexdigest()
silk,silk_hash=archive('/workspace/silk-baseline','silk')
archives={'silk':silk_hash}
if a.workload=='compiler':
    cwd=silk;package=['--package','silk-compiler']
else:
    nonstd,nonstd_hash=archive('/workspace/nonstd','nonstd');archives['nonstd']=nonstd_hash
    cwd=nonstd/'fonts/shape/tools/cli';package=[]
sys.path.insert(0,str(s/'incremental_reporting'))
from lane import candidate_environment
base={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_PROMOTION_','SILK_PROFILE_')) and k not in ['LLVM_PROFILE_FILE','LD_PRELOAD']}
base['SILK_CLANG']=str(s/'llvm-22.1.8/bin/clang')
env=candidate_environment(base,metadata['features'],metadata['worker_policy'],'candidate','build')
env.update(SILK_PROMOTION_CLANG=env['SILK_CLANG'],SILK_CLANG=str(s/'llvm-promotion-experiment/capture-clang.py'),SILK_PROMOTION_CAPTURE=str(root/'capture'))
command=[str(binary),'build',*package,'--stdlib',str(silk/'stdlib'),'--progress','plain','--timings']
record=dict(workload=a.workload,matrix=str(a.matrix),matrix_sha256=hashlib.sha256(a.matrix.read_bytes()).hexdigest(),revisions=metadata['revisions'],source_archive_sha256=archives,compiler=candidate,command=command,environment={k:v for k,v in env.items() if k.startswith('SILK_')},cpus=sorted(os.sched_getaffinity(0)),purpose='Untimed capture, wrapper overhead excluded from replay')
(root/'metadata.json').write_text(json.dumps(record,indent=2)+'\n')
spec=importlib.util.spec_from_file_location('bench',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
# NativeToolchain strips custom child environment, so stage settings also
# travel through the fixed wrapper sidecar. Do not overlap other capture jobs.
sidecar=s/'llvm-promotion-experiment/capture-clang.config.json'
assert not sidecar.exists(), 'Another native capture owns the wrapper sidecar'
pending=sidecar.with_name(sidecar.name+'.'+str(os.getpid())+'.tmp')
pending.write_text(json.dumps(dict(capture=str(root/'capture'),clang=env['SILK_PROMOTION_CLANG'],mode='bitcode')))
os.replace(pending,sidecar)
try:
    result=b.measure(command,cwd,env,root/'capture-build.log')
finally:
    sidecar.unlink()

(root/'capture-result.json').write_text(json.dumps(result,indent=2)+'\n')
assert result['exit_code']==0 and all(r['exit_code']==0 for r in result['detached']),result
records=[json.loads(f.read_text()) for f in (root/'capture/commands').glob('*.json')]
pack=next(r for r in records if '-c' in r['argv'] and '-x' in r['argv'] and r['argv'][r['argv'].index('-x')+1]=='ir')
flags=pack['argv'][1:pack['argv'].index('-x')];flags.remove('-c')
probe=[pack['argv'][0],*flags,'-S','-emit-llvm','-x','c','/dev/null','-o','-']
text=subprocess.check_output(probe,text=True);(root/'layout-probe.ll').write_text(text)
layout=dict(triple=re.search(r'target triple = "([^"]+)"',text).group(1),data_layout=re.search(r'target datalayout = "([^"]+)"',text).group(1),probe_command=probe,clang_sha256=hashlib.sha256(Path(pack['argv'][0]).read_bytes()).hexdigest(),cpus=sorted(os.sched_getaffinity(0)))
(root/'layout.json').write_text(json.dumps(layout,indent=2)+'\n')
# Preserve the final artifact and captured bitcode, remove only this run's completed build caches.
import shutil
project=silk if a.workload=='compiler' else root/'nonstd'
artifact=project/'build/llvm/x86_64-unknown-linux-gnu/debug'/('silk-compiler' if a.workload=='compiler' else 'font-shape-cli')
assert artifact.exists(),artifact
shutil.copy2(artifact,root/'artifact')
if Path(str(artifact)+'.symbols').exists():shutil.copy2(Path(str(artifact)+'.symbols'),root/'artifact.symbols')
(root/'artifact-sha256.txt').write_text(hashlib.sha256(artifact.read_bytes()).hexdigest()+'\n')
if a.workload=='compiler':
 smoke=root/'generated-check';(smoke/'src').mkdir(parents=True)
 (smoke/'silk.toml').write_text('[package]\nname="generated-check"\nversion="0.0.0"\n')
 (smoke/'src/main.silk').write_text('import helper\npub fn main() -> i32 { return helper.twice(21) }\n')
 (smoke/'src/helper.silk').write_text('pub fn twice(value: i32) -> i32 { return value * 2 }\n')
 smoke_command=[str(root/'artifact'),'check','--manifest-path',str(smoke/'silk.toml'),'--stdlib',str(silk/'stdlib')]
 smoke_result=b.measure(smoke_command,smoke,base,root/'generated-compiler-check.log')
 (root/'generated-compiler-check.json').write_text(json.dumps(smoke_result,indent=2)+'\n')
 assert smoke_result['exit_code']==0 and all(r['exit_code']==0 for r in smoke_result['detached']),smoke_result
 shutil.rmtree(smoke/'build',ignore_errors=True)
for tree in [silk, root/'nonstd']:
 build=tree/'build'
 if build.exists():shutil.rmtree(build)
print('Captured '+str(root),flush=True)
