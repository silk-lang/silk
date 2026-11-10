#!/usr/bin/env python3
"""Frozen-source mono/ThinLTO4/serial-PGO construction; no benchmarks are run.
Prepare is cheap. Other phases take the shared performance lock and must be scheduled.
"""
import argparse, ctypes, fcntl, hashlib, json, os, pathlib, shutil, subprocess, time

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('phase',choices=['prepare','mono','four','train','train-more','pgo'])
p.add_argument('--work',required=True,type=pathlib.Path)
p.add_argument('--repo',default='/workspace/silk',type=pathlib.Path)
p.add_argument('--revision')
p.add_argument('--stdlib-baseline',type=pathlib.Path,help='Exact JSON diagnostics from the verified baseline for the stdlib-root negative training input')
p.add_argument('--producer',type=pathlib.Path)
p.add_argument('--clang',default='/workspace/silk/.scratch/llvm-22.1.8/bin/clang',type=pathlib.Path)
a=p.parse_args(); work=a.work.resolve()
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def git(*args): return subprocess.check_output(['git','-C',str(a.repo),*args],text=True).strip()
if a.phase=='prepare':
    if not a.revision or not a.producer: p.error('prepare requires --revision and --producer')
    work.mkdir(parents=True,exist_ok=False)
    snapshot=work/'snapshot'; snapshot.mkdir()
    revision=git('rev-parse',a.revision+'^{commit}')
    archive=work/'source.tar'
    subprocess.run(['git','-C',str(a.repo),'archive',revision,'-o',str(archive)],check=True)
    source_archive_sha256=digest(archive)
    subprocess.run(['tar','-xf',str(archive),'-C',str(snapshot)],check=True); archive.unlink()
    manifest=snapshot/'compiler/silk.toml'
    with manifest.open('a') as f:
        for label,units in [('construction-four',4)]:
            f.write(f'\n[profiles.{label}]\noptimization="speed"\ndebug=false\ncodegen-units={units}\n')
    metadata={'revision':revision,'source_archive_sha256':source_archive_sha256,'producer':str(a.producer.resolve()),'producer_sha256':digest(a.producer),
      'clang':str(a.clang.resolve()),'clang_sha256':digest(a.clang),
      'manifest_sha256':digest(manifest),'training':'serial compiler check+IR, stdlib check, schema/effect/generic/static corpus check+IR',
      'held_out':['Harfrust (all operations)','compiler/Harfrust unchanged and edited workloads'],
      'note':'Only manifest construction profiles are added; all authored Silk sources are the frozen revision.'}
    (work/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
    print(json.dumps(metadata)); raise SystemExit
meta=json.loads((work/'metadata.json').read_text()); snapshot=work/'snapshot'
producer=pathlib.Path(meta['producer']); clang=pathlib.Path(meta['clang'])
assert digest(producer)==meta['producer_sha256']; assert digest(clang)==meta['clang_sha256']
lock=open('/workspace/silk/.scratch/performance.lock','a'); fcntl.flock(lock,fcntl.LOCK_SH)
# Adopt detached cache writers; each phase ends only after every descendant is reaped.
libc=ctypes.CDLL(None,use_errno=True)
if libc.prctl(36,1,0,0,0)!=0: raise OSError(ctypes.get_errno(),'PR_SET_CHILD_SUBREAPER')
env={k:v for k,v in os.environ.items() if not (k.startswith('SILK_EXPERIMENT_') or k.startswith('SILK_FRONTIER_') or k.startswith('SILK_PROFILE_') or k.startswith('SILK_RETAINED_') or k in ['SILK_POSTCHECK_BUILD','SILK_ARTIFACT_TRACE','LLVM_PROFILE_FILE','LD_PRELOAD'])}
env['SILK_CLANG']=str(clang)
records=[]
def run(label,cmd,cwd,extra=None,expected=0):
    started=time.monotonic(); log=work/(label+'.log')
    with log.open('wb') as f: result=subprocess.run([str(x) for x in cmd],cwd=cwd,env=env| (extra or {}),stdout=f,stderr=subprocess.STDOUT)
    while True:
        try: os.waitpid(-1,0)
        except ChildProcessError: break
    row={'label':label,'command':[str(x) for x in cmd],'cwd':str(cwd),'seconds':time.monotonic()-started,'exit':result.returncode,'log':str(log),'extra_environment':extra or {}}
    records.append(row)
    with (work/'construction.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
    if result.returncode!=expected: raise RuntimeError(f'{label}: exit{result.returncode}; see {log}')
def copy(name):
    dst=work/name; shutil.copytree(snapshot,dst); return dst
if a.phase in ['mono','four','pgo']:
    tree=copy('build-'+a.phase); package=tree/'compiler'; output=work/('compiler-'+a.phase)
    extra={}
    if a.phase=='pgo':
        profile=work/'pgo/compiler.profdata'; assert profile.is_file()
        extra['SILK_PROFILE_USE']=str(profile)
    if a.phase=='four':
        run(a.phase,[producer,'build','--manifest-path','silk.toml','--profile','construction-four','--stdlib','../stdlib','--progress','never'],package,extra)
        products=list(tree.glob('build/llvm/*/construction-four/silk-compiler'))
        if len(products)!=1: raise RuntimeError(f'Expected one four-unit executable, found {products}')
        shutil.copy2(products[0],output)
    else:
        # Single-source builds supply an explicit profile whose default unit count is one.
        run(a.phase,[producer,'build','src/main.silk','-o',output,'--stdlib','../stdlib','--optimization','speed','--debug','false'],package,extra)
    (work/(a.phase+'-binary.json')).write_text(json.dumps({'sha256':digest(output),'source_revision':meta['revision'],'profile_sha256':digest(profile) if a.phase=='pgo' else None},indent=2)+'\n')
else:
    tree=work/'build-training' if a.phase=='train-more' else copy('build-training')
    package=tree/'compiler'; trained=work/'pgo'
    # Existing supported tool performs compiler self-check and LLVM-IR training on a private copy.
    if a.phase=='train':
        run('train-compiler',[snapshot/'.github/scripts/profile-guided-build.sh',trained,producer,snapshot,'src/main.silk','-', '--stdlib','../stdlib','--optimization','speed','--debug','false'],package)
    instrumented=trained/'instrumented'
    standard=work/'training-stdlib'
    if not standard.exists():shutil.copytree(snapshot/'stdlib',standard)
    for name in ['silk.toml','stdlib_check.silk']:shutil.copy2(snapshot/'compiler/fixtures/stdlib-root'/name,standard/name)
    def profile(label):return {'LLVM_PROFILE_FILE':str(trained/'profiles'/(label+'-%p.profraw'))}
    stdlib_label='train-stdlib-confirmed' if a.stdlib_baseline else 'train-stdlib'
    run(stdlib_label,[instrumented,'check','--stdlib',standard,'--progress','never','--json'],standard,profile('stdlib-confirmed' if a.stdlib_baseline else 'stdlib'),expected=1 if a.stdlib_baseline else 0)
    if a.stdlib_baseline:
        def errors(path):
            return [row for line in path.read_text().splitlines() if line.startswith('{') and (row:=json.loads(line)).get('severity')=='error']
        assert errors(work/(stdlib_label+'.log'))==errors(a.stdlib_baseline), 'Stdlib negative training diagnostics differ from baseline'
    debug_ir=trained/'training-debug.ll'
    run('train-compiler-debug',[instrumented,'build','src/main.silk','-o',debug_ir,'--emit','llvm-ir','--stdlib','../stdlib','--optimization','none','--debug','true'],package,profile('compiler-debug'))
    ir_artifacts=[]
    for emitted in [trained/'training.ll',debug_ir]:
        if emitted.exists():
            ir_artifacts.append({'path':str(emitted),'sha256':digest(emitted),'bytes':emitted.stat().st_size,'removed_after_training':True})
            emitted.unlink()
    (work/'training-ir-artifacts.json').write_text(json.dumps(ir_artifacts,indent=2)+'\n')
    cases=['schema-json','effect-catchall-section-handler','generic-finite-type-cycle','static-parameter-finite-chains']
    # Pick named, source-pinned representatives; missing names fail rather than silently changing training.
    for case in cases:
        source=snapshot/'corpus/native'/case
        if not source.is_dir(): raise RuntimeError(f'Unknown training case {case}; select explicitly before starting train')
        target=work/('training-'+case); shutil.copytree(source,target)
        (target/'silk.toml').write_text('[package]\nname="construction-training"\nversion="0.0.0"\nsilk-version="0.0.0"\nsource="."\nmain="main.silk"\n')
        run('train-'+case+'-check',[instrumented,'check','--stdlib',snapshot/'stdlib','--progress','never'],target,profile(case+'-check'))
        run('train-'+case+'-emit',[instrumented,'build','main.silk','-o',target/'output.ll','--emit','llvm-ir','--stdlib',snapshot/'stdlib','--optimization','none','--debug','false'],target,profile(case+'-emit'))
    excluded=sorted(p for p in (trained/'profiles').glob('stdlib-*.profraw') if a.stdlib_baseline and not p.name.startswith('stdlib-confirmed-'))
    raw=sorted(p for p in (trained/'profiles').glob('*.profraw') if p not in excluded)
    run('merge-profile',[clang.parent/'llvm-profdata','merge','-o',trained/'compiler.profdata',*raw],work)
    run('profile-summary',[clang.parent/'llvm-profdata','show',trained/'compiler.profdata'],work)
    (work/'training-profile.json').write_text(json.dumps({'sha256':digest(trained/'compiler.profdata'),
      'raw_profiles':len(raw),'excluded_superseded_profiles':[str(p) for p in excluded],'instrumented_sha256':digest(instrumented),'stdlib_baseline':str(a.stdlib_baseline) if a.stdlib_baseline else None,'summary':str(work/'profile-summary.log'),
      'training_cases':cases,'serial':True,'held_out':meta['held_out']},indent=2)+'\n')
print(json.dumps({'phase':a.phase,'records':records},indent=2))
