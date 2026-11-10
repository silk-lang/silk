from pathlib import Path
import hashlib,importlib.util,json,os,shutil,subprocess
root=Path('/workspace/silk/.scratch/cache-bundle-indexed-fields')
pkg=Path('/workspace/silk/.scratch/frontier-cache-bundle-v23-package');pkg.mkdir(exist_ok=True)
s=(Path('/workspace/silk/.scratch/frontier-cache-bundle-v21-package/silk.toml').read_text().replace('/workspace/silk/.scratch/performance-bundle-v21-source',str(root)))
(pkg/'silk.toml').write_text(s)
for name,target in [('src',root/'compiler/src'),('manifest.schema.toml',root/'compiler/manifest.schema.toml')]:
 p=pkg/name
 if not p.exists():p.symlink_to(target)
spec=importlib.util.spec_from_file_location('bench','/workspace/silk/.scratch/benchmarks/cold_bench.py');bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
seed=Path('/workspace/silk/.scratch/ci-n1-4a1fa332/N1');clang=Path('/workspace/silk/.scratch/llvm-22.1.8/bin/clang')
env={k:v for k,v in os.environ.items() if not k.startswith('SILK_')};env['SILK_CLANG']=str(clang)
cmd=[str(seed),'build','--manifest-path',str(pkg/'silk.toml'),'--stdlib',str(root/'stdlib'),'--profile','speed-four','--progress','plain','--timings']
result=bench.measure(cmd,root,env,Path('/workspace/silk/.scratch/frontier-cache-bundle-v23-build.log'))
result.update(source=subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip(),command=cmd,optimization='speed',debug=False,codegen_units=4,profile_use=None,purpose='V23 exact V21 base plus validated scalar offsets, direct-leaf/file memoization, private validation/digest reuse; four-unit O2 noPGO controlled component candidate; no performance claim before both CPU lanes')
if result['exit_code']==0:
 output=pkg/'build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler';dest=Path('/workspace/silk/.scratch/frontier-cache-bundle-indexed-fields')
 shutil.copy2(output,dest);result['binary']=str(dest);result['sha256']=hashlib.sha256(dest.read_bytes()).hexdigest()
Path('/workspace/silk/.scratch/frontier-cache-bundle-v23-build.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2),flush=True)
raise SystemExit(result['exit_code'])
