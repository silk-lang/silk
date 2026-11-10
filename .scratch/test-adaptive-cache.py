import importlib.util,json,os,pathlib,re,shutil
root=pathlib.Path('/workspace/silk');work=root/'.scratch/adaptive-acceptance';work.mkdir(exist_ok=True)
binary=root/'.scratch/coarse-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
spec=importlib.util.spec_from_file_location('bench',root/'.scratch/benchmarks/cold_bench.py');bench=importlib.util.module_from_spec(spec);spec.loader.exec_module(bench)
records=[]
def fixture(name):
 p=work/name;shutil.rmtree(p,ignore_errors=True);(p/'src').mkdir(parents=True)
 (p/'silk.toml').write_text(f'[package]\nname="adaptive-{name}"\nversion="0.0.0"\nsource="src"\n\n[profiles.other]\noptimization="none"\ndebug=false\n')
 (p/'src/Shared.silk').write_text('pub fn keep() -> i32 { return 42 }\n')
 edit(p,0);return p

def edit(p,n):
 (p/'src/main.silk').write_text('import Shared\nimport silk.num.i32\npub fn main() -> i32 { return Shared.keep() + '+str(n)+' }\n')

def run(p,operation,stage,extra=(),executable=binary):
 env=dict(os.environ)
 for k in ['SILK_EXPERIMENT_COARSE_CHECK','SILK_EXPERIMENT_COARSE_BUILD']:env.pop(k,None)
 env['SILK_EXPERIMENT_ADAPTIVE_CACHE']='1';env['SILK_EXPERIMENT_COARSE_TRACE']='1';env['SILK_CLANG']=str(root/'.scratch/llvm-22.1.8/bin/clang')
 log=work/f'{p.name}-{operation}-{stage}.log'
 result=bench.measure([str(executable),operation,'--manifest-path',str(p/'silk.toml'),'--stdlib',str(root/'.scratch/coarse-cache-experiment/stdlib'),'--progress','never',*extra],p,env,log)
 text=log.read_text();result.update(fixture=p.name,operation=operation,stage=stage,mode='cached' if 'adaptive cached\n' in text else 'transient' if 'adaptive transient\n' in text else 'artifact-hit',whole_hit='whole-check hit\n' in text)
 roots=re.search(r'adaptive fine roots (\d+)',text);result['roots']=int(roots.group(1)) if roots else None
 records.append(result);(work/'results.json').write_text(json.dumps(records,indent=2));print(json.dumps(result),flush=True)
 assert result['exit_code']==0,text
 return result

def images(p):return [x for x in (p/'build').rglob('semantic-*') if x.is_file() and re.fullmatch(r'semantic-[0-9a-f]+',x.name)]
for operation in ['check','build']:
 p=fixture(operation)
 first=run(p,operation,'cold');assert first['mode']=='transient';assert not images(p),images(p)
 warm=run(p,operation,'warm');assert warm['whole_hit'] if operation=='check' else warm['mode']=='artifact-hit'
 edit(p,1);firstedit=run(p,operation,'edit1');assert firstedit['mode']=='cached';assert not firstedit['whole_hit'];assert images(p)
 edit(p,2);secondedit=run(p,operation,'edit2');assert secondedit['mode']=='cached';assert not secondedit['whole_hit'];assert secondedit['roots'] and secondedit['roots']>0
 warm=run(p,operation,'edit2-warm');assert warm['whole_hit'] if operation=='check' else warm['mode']=='artifact-hit'
 variant=run(p,operation,'new-profile',['--profile','other']);assert variant['mode']=='transient'
 print(operation,'two distinct edits populate then reuse fine cache PASS',flush=True)
# Same source/cache paths, different compiler bytes: a new identity must be cold.
copy=work/'compiler-identity-probe';shutil.copy2(binary,copy)
with copy.open('ab') as f:f.write(b'\nsilk-adaptive-compiler-identity-probe\n')
r=run(work/'check','check','new-compiler',executable=copy);assert r['mode']=='transient'
# Same package/cache, a different entry root also starts cold.
p=work/'check';(p/'src/Other.silk').write_text('pub fn main() -> i32 { return 0 }\n')
s=(p/'silk.toml').read_text().replace('source="src"','source="src"\nmain="Other.silk"');(p/'silk.toml').write_text(s)
r=run(p,'check','new-root');assert r['mode']=='transient'
print('ALL ADAPTIVE GUARDS PASS',len(records),flush=True)
