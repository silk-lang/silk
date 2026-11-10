#!/usr/bin/env python3
"""Scheduled preparation only: compile a plugin with the EXACT host LLVM headers/ABI."""
from pathlib import Path
import argparse,hashlib,json,shlex,subprocess
p=argparse.ArgumentParser();p.add_argument('output',type=Path);p.add_argument('--mode',choices=['mem2reg','sroa'],default='mem2reg');a=p.parse_args()
s=Path('/workspace/silk/.scratch');tool=s/'llvm-22.1.8/bin';source=Path(__file__).with_name('PromotionPlugin.cpp')
version=subprocess.check_output([str(tool/'llvm-config'),'--version'],text=True).strip();assert version=='22.1.8',version
flags=shlex.split(subprocess.check_output([str(tool/'llvm-config'),'--cxxflags'],text=True))
a.output.mkdir(parents=True,exist_ok=False)
plugin=a.output/('promotion-'+a.mode+'.so')
command=[str(tool/'clang++'),*flags,'-O2','-fPIC','-shared','-DSILK_PROMOTION_SROA='+str(int(a.mode=='sroa')),str(source),'-o',str(plugin)]
# No -lLLVM: the host Clang must resolve its own LLVM symbols when loading this
# plugin. Failure is an availability result, not permission to load another LLVM.
meta=dict(mode=a.mode,llvm_version=version,command=command,command_sha256=hashlib.sha256(json.dumps(command,separators=(',',':')).encode()).hexdigest(),source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),clang_sha256=hashlib.sha256((tool/'clang').read_bytes()).hexdigest(),verification='unbuilt')
(a.output/'build.json').write_text(json.dumps(meta,indent=2)+'\n')
subprocess.run(command,check=True)
meta.update(plugin_sha256=hashlib.sha256(plugin.read_bytes()).hexdigest(),verification='compiled only; Clang loading, O0 callback, debug fidelity and native parity unverified')
(a.output/'build.json').write_text(json.dumps(meta,indent=2)+'\n')
print(plugin,flush=True)
