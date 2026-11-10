import os,pathlib,subprocess,shutil,json
root=pathlib.Path('/workspace/silk');project=root/'.scratch/benchmarks/coarse-o7m9o4zq/silk';cache=project/'build/cache/silk-compiler'
binary=root/'.scratch/coarse-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
env=dict(os.environ,SILK_EXPERIMENT_COARSE_CHECK='1',SILK_EXPERIMENT_COARSE_TRACE='1')
for n in range(2):
 with (root/f'.scratch/coarse-key-{n}.log').open('wb') as f:
  p=subprocess.run([str(binary),'check','--package','silk-compiler','--stdlib',str(project/'stdlib'),'--progress','never'],cwd=project,env=env,stdout=f,stderr=subprocess.STDOUT)
 assert p.returncode==0
 keys=sorted(cache.glob('check-whole-*.key'),key=lambda p:p.stat().st_mtime_ns)
 key=keys[-1];shutil.copyfile(key,root/f'.scratch/coarse-key-{n}.bin')
 shutil.copyfile(str(key)+'.observations',root/f'.scratch/coarse-observations-{n}.bin')
 print(n,key,flush=True)
print('DONE',flush=True)
