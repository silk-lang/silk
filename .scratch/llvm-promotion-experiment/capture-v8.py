#!/usr/bin/env python3
"""Untimed, cold V8 build solely to retain its authentic binary bitcode packs.
Run under a root-scheduled shared correctness lock; replay timings use exclusive.
"""
from pathlib import Path
import argparse, hashlib, importlib.util, io, json, os, subprocess, tarfile
s=Path('/workspace/silk/.scratch')
p=argparse.ArgumentParser();p.add_argument('output',type=Path);args=p.parse_args()
root=args.output.resolve();root.mkdir(parents=True,exist_ok=False)
revision='3eb51811ab9f0cf8d2ca0529e47810f792e177a3'
binary=s/'frontier-cache-v8';expected='7f7ef0b6c309bb1da71e949ed5b66414591fa0fc2dd2225c8c7ed245122f5c68'
assert hashlib.sha256(binary.read_bytes()).hexdigest()==expected
source=root/'silk';source.mkdir()
data=subprocess.check_output(['git','archive',revision],cwd=s/'finite-integration')
with tarfile.open(fileobj=io.BytesIO(data)) as archive: archive.extractall(source,filter='data')
original=json.loads((s/'benchmarks/v8-retained-compiler-edv00r5x/metadata.json').read_text())
env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_'))}
env.update(original['environment'])
env.update(SILK_CLANG=str(s/'llvm-promotion-experiment/capture-clang.py'),
           SILK_PROMOTION_CLANG=original['environment']['SILK_CLANG'],SILK_PROMOTION_CAPTURE=str(root/'capture'))
command=[str(binary),'build','--manifest-path',str(source/'compiler/silk.toml'),'--stdlib',str(source/'stdlib'),'--progress','plain','--timings']
(root/'metadata.json').write_text(json.dumps(dict(source=revision,source_archive_sha256=hashlib.sha256(data).hexdigest(),compiler_sha256=expected,command=command,environment={k:v for k,v in env.items() if k.startswith('SILK_')},purpose='Untimed capture; wrapper overhead is excluded from replay measurements'),indent=2)+'\n')
spec=importlib.util.spec_from_file_location('bench',s/'benchmarks/cold_bench.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
# NativeToolchain strips custom child environment, so stage settings also
# travel through the fixed wrapper sidecar. Do not overlap other capture jobs.
sidecar=s/'llvm-promotion-experiment/capture-clang.config.json'
assert not sidecar.exists(), 'Another native capture owns the wrapper sidecar'
pending=sidecar.with_name(sidecar.name+'.'+str(os.getpid())+'.tmp')
pending.write_text(json.dumps(dict(capture=str(root/'capture'),clang=env['SILK_PROMOTION_CLANG'],mode='all')))
os.replace(pending,sidecar)
try:
    result=b.measure(command,source,env,root/'capture-build.log')
finally:
    sidecar.unlink()

(root/'capture-result.json').write_text(json.dumps(result,indent=2)+'\n')
assert result['exit_code']==0 and all(r['exit_code']==0 for r in result['detached']),result
records=[json.loads(f.read_text()) for f in (root/'capture/commands').glob('*.json')]
pack=next(r for r in records if '-x' in r['argv'] and r['argv'][r['argv'].index('-x')+1]=='ir' and '-c' in r['argv'])
# Use exactly the captured native target/feature flags to ask the same Clang
# for its effective layout. This tiny C probe is untimed setup, not a language build.
flags=pack['argv'][1:pack['argv'].index('-x')];flags.remove('-c')
probe=[pack['argv'][0],*flags,'-S','-emit-llvm','-x','c','/dev/null','-o','-']
text=subprocess.check_output(probe,text=True)
(root/'layout-probe.ll').write_text(text)
import re
layout=dict(triple=re.search(r'target triple = "([^"]+)"',text).group(1),data_layout=re.search(r'target datalayout = "([^"]+)"',text).group(1),probe_command=probe,clang_sha256=hashlib.sha256(Path(pack['argv'][0]).read_bytes()).hexdigest())
(root/'layout.json').write_text(json.dumps(layout,indent=2)+'\n')
print('Captured '+str(root),flush=True)
