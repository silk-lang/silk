import hashlib,importlib.util,json,os,pathlib,shutil
root=pathlib.Path('/workspace/silk');fixture=root/'.scratch/benchmarks/coarse-xa9ikfet';project=fixture/'nonstd';cwd=project/'fonts/shape/tools/cli'
binary=root/'.scratch/coarse-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
spec=importlib.util.spec_from_file_location('bench',root/'.scratch/benchmarks/cold_bench.py');bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
hashes=[]
for mode in ['off','adaptive']:
 shutil.rmtree(project/'build',ignore_errors=True)
 env=dict(os.environ,SILK_CLANG=str(root/'.scratch/llvm-22.1.8/bin/clang'))
 for k in ['SILK_EXPERIMENT_COARSE_CHECK','SILK_EXPERIMENT_COARSE_BUILD','SILK_EXPERIMENT_ADAPTIVE_CACHE','SILK_EXPERIMENT_COARSE_TRACE']:env.pop(k,None)
 if mode=='adaptive':env['SILK_EXPERIMENT_ADAPTIVE_CACHE']='1';env['SILK_EXPERIMENT_COARSE_TRACE']='1'
 log=root/f'.scratch/harf-dwarf-fixed-{mode}.log'
 result=bench.measure([str(binary),'build','--stdlib',str(fixture/'silk/stdlib'),'--progress','never'],cwd,env,log)
 assert result['exit_code']==0,log.read_text()
 artifact=project/'build/llvm/x86_64-unknown-linux-gnu/debug/font-shape-cli'
 digest=hashlib.sha256(artifact.read_bytes()).hexdigest();hashes.append(digest)
 result.update(mode=mode,sha256=digest);print(json.dumps(result),flush=True)
 target=fixture/f'harfrust-fixed-{mode}-build';shutil.rmtree(target,ignore_errors=True);shutil.move(project/'build',target)
assert hashes[0]==hashes[1],hashes
print('Harf entire executable byte-identical including DWARF',hashes[0],flush=True)
