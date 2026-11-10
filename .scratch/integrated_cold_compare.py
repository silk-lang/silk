"""Controlled original-versus-integrated cold checks/builds; run with performance.lock exclusive."""
import argparse, hashlib, importlib.util, json, os, shutil, subprocess, tempfile
from pathlib import Path
scratch = Path('/workspace/silk/.scratch')
spec = importlib.util.spec_from_file_location('cold', scratch / 'benchmarks/cold_bench.py')
bench = importlib.util.module_from_spec(spec); spec.loader.exec_module(bench)
p = argparse.ArgumentParser(); p.add_argument('--candidate', type=Path, required=True)
p.add_argument('--rounds', type=int, default=2); p.add_argument('--operations', default='check,build')
p.add_argument('--workloads', default='compiler,harfrust'); p.add_argument('--serial-parity', action='store_true')
a = p.parse_args(); os.sched_setaffinity(0, {0,1,2,3})
root = Path(tempfile.mkdtemp(prefix='integrated-cold-', dir=scratch/'benchmarks'))
revisions = {'silk':bench.snapshot(Path('/workspace/silk-baseline'), root/'silk'),
             'nonstd':bench.snapshot(Path('/workspace/nonstd'), root/'nonstd')}
assert revisions == {'silk':'a63f612150a0b91a118c8111b910b12c3e124b50','nonstd':'ccb168b773bb56d7bd60a3495141d427149766d0'}, revisions
binaries = {'baseline':scratch/'N0-one', 'integrated':a.candidate.resolve(), 'serial':a.candidate.resolve()}
metadata = {'revisions':revisions, 'binaries':{k:{'path':str(v),'sha256':hashlib.sha256(v.read_bytes()).hexdigest()} for k,v in binaries.items()},
            'rounds':a.rounds,'cpus':sorted(os.sched_getaffinity(0)), 'profile':'default',
            'cold':'Empty compiler build/cache directory; filesystem page cache not flushed.',
            'settlement':'All descendant and detached writer processes reaped before next trial.',
            'memory':'max_rss_kib is individual maximum, not aggregate concurrent memory.'}
(root/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
print(json.dumps({'root':str(root),'metadata':metadata}),flush=True); results=[]
for operation in a.operations.split(','):
 for workload in a.workloads.split(','):
  source=root/('silk' if workload=='compiler' else 'nonstd')
  cwd=source if workload=='compiler' else source/'fonts/shape/tools/cli'
  for repeat in range(a.rounds):
   modes=['baseline','integrated'] if repeat%2==0 else ['integrated','baseline']
   if a.serial_parity and repeat==0: modes.append('serial')
   for mode in modes:
    cache=source/'build'; assert not cache.is_symlink()
    if cache.exists(): shutil.rmtree(cache)
    env={k:v for k,v in os.environ.items() if not k.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_POSTCHECK_','SILK_RETAINED_','SILK_FINITE_'))}
    env['SILK_CLANG']=str(scratch/'llvm-22.1.8/bin/clang')
    if mode=='integrated':
     env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_CHUNKS='1')
     if operation=='build': env.update(SILK_RETAINED_BUILD='1', SILK_EXPERIMENT_DEV_PACKS='1')
    command=[str(binaries[mode]),operation]+(['--package','silk-compiler'] if workload=='compiler' else [])+['--stdlib',str(root/'silk/stdlib'),'--progress','plain','--timings']
    tag=f'{operation}-{workload}-{repeat}-{mode}'; log=root/(tag+'.log')
    result=dict(operation=operation,workload=workload,round=repeat,mode=mode,command=command,**bench.measure(command,cwd,env,log))
    trace=log.read_text(); result.update(frontier_accepted='frontier accepted' in trace,artifact_accepted='artifact accepted' in trace)
    if operation=='build' and result['exit_code']==0:
     binary=cache/'llvm/x86_64-unknown-linux-gnu/debug'/('silk-compiler' if workload=='compiler' else 'font-shape-cli')
     kept=root/tag; shutil.copy2(binary,kept); result['binary_sha256']=hashlib.sha256(kept.read_bytes()).hexdigest()
     result['artifacts']={str(f.relative_to(cache/'llvm')):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((cache/'llvm').rglob('*')) if f.is_file()}
     if workload=='compiler': result['version_exit_code']=subprocess.run([str(kept),'--version'],capture_output=True).returncode
    results.append(result); (root/'results.json').write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='artifacts'}),flush=True)
    assert result['exit_code']==0 and all(d['exit_code']==0 for d in result['detached']), tag
    if mode=='integrated':
     assert result['frontier_accepted'],tag+': frontier refused'
     if operation=='build': assert result['artifact_accepted'],tag+': retained build refused'
    # Preserve reports/final binaries/hashes; generated per-trial caches are reproducible.
    if cache.exists(): shutil.rmtree(cache)
