from pathlib import Path
import importlib.util,os,json,shutil,subprocess,hashlib,tempfile
spec=importlib.util.spec_from_file_location('cold','/workspace/silk/.scratch/benchmarks/cold_bench.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
source=Path(os.environ.get('PARITY_SOURCE','/workspace/silk-retained-build'));origin=Path(os.environ.get('PARITY_ORIGIN','/workspace/silk/.scratch/benchmarks/retained-build-pkntu63d'));root=Path(os.environ['PARITY_RESUME']) if os.environ.get('PARITY_RESUME') else Path(tempfile.mkdtemp(prefix='generated-parity-',dir='/workspace/silk/.scratch/benchmarks'))
Path('/workspace/silk/.scratch/retained-parity-root.txt').write_text(str(root))
env=dict(os.environ,SILK_CLANG='/workspace/silk/.scratch/llvm-22.1.8/bin/clang')
for k in list(env):
 if k.startswith('SILK_EXPERIMENT') or k in ('SILK_POSTCHECK_BUILD','SILK_FINITE_ARTIFACT','SILK_ARTIFACT_TRACE','SILK_RETAINED_BUILD'):env.pop(k)
compilers={mode:origin/('compiler-'+mode) for mode in os.environ.get('PARITY_MODES','off,on').split(',')};results=[r for r in json.loads((root/'results.json').read_text()) if r['case']!='compiler-init'] if os.environ.get('PARITY_RESUME') else []
def save(r):
 results.append(r);(root/'results.json').write_text(json.dumps(results,indent=2));print(json.dumps(r),flush=True)
def diagnostics(log):return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
def run(command,cwd,log):return m.measure([str(x) for x in command],cwd,env,log)
cases=['generic-static-parameter-callee','generic-lifetime-selected-cleanup','role-keyed-service-provider-selection','composed-mutable-provider-identities','local-shared-lifecycle-operations','local-shared-nested-owned-result-cleanup','local-shared-clone-drop-during-access','local-shared-recursive-cleanup','effect-lambda-flat-map','effect-suspended-map-flat-map','effect-heterogeneous-owned-failure-result-drop','result-source-channel-maps','owned-provider-suspended-failure']
for case in ([] if os.environ.get('PARITY_RESUME') else cases):
 work=root/case;work.mkdir();shutil.copytree(source/'corpus/native'/case,work/'src');(work/'silk.toml').write_text('[package]\nname = "parity-case"\nversion = "0.0.0"\n')
 expected=json.loads((work/'src/outcome.json').read_text())['expected']['exitCode'];pair=[]
 for mode,compiler in compilers.items():
  if (work/'build').exists():shutil.rmtree(work/'build')
  log=work/(mode+'-check.log');check=run([compiler,'check','--stdlib',source/'stdlib','--json','--progress','never'],work,log)
  messages=diagnostics(log);build=run([compiler,'build','--stdlib',source/'stdlib','--progress','never'],work,work/(mode+'-build.log'))
  result={'case':case,'mode':mode,'check_exit':check['exit_code'],'diagnostics':messages,'build_exit':build['exit_code']}
  if not check['exit_code'] and not build['exit_code']:
   artifact=work/'build/llvm/x86_64-unknown-linux-gnu/debug/parity-case';execution=subprocess.run([str(artifact)],capture_output=True,timeout=30)
   result.update(exit_code=execution.returncode,stdout=execution.stdout.decode(errors='replace'),stderr=execution.stderr.decode(errors='replace'),sha256=hashlib.sha256(artifact.read_bytes()).hexdigest())
  save(result);pair.append(result)
  if result['check_exit'] or result['build_exit'] or result.get('exit_code')!=expected:raise SystemExit('unexpected corpus result '+case+' '+mode)
 for field in ('diagnostics','exit_code','stdout','stderr'):
  if pair[0][field]!=pair[1][field]:raise SystemExit('parity mismatch '+case+' '+field)
# Exercise the actual changed compiler function, including its success cleanup transaction.
for mode,compiler in compilers.items():
 work=Path(tempfile.mkdtemp(prefix='retained-init-'+mode+'-'))/'project';r=run([compiler,'init',work,'--name','parity-app'],work.parent,root/(mode+'-init.log'))
 files={str(p.relative_to(work)):p.read_text() for p in work.rglob('*') if p.is_file()} if work.exists() else {}
 save({'case':'compiler-init','mode':mode,'exit_code':r['exit_code'],'files':files})
 if r['exit_code']:raise SystemExit('init failed '+mode)
if results[-2]['files']!=results[-1]['files']:raise SystemExit('init files mismatch')
# Large source check exercises the generated compiler's own Type/Shared/Effect functions.
silk=root/'silk';nonstd=root/'nonstd';m.snapshot(Path('/workspace/silk-baseline'),silk);m.snapshot(Path('/workspace/nonstd'),nonstd)
checks=[]
for mode,compiler in compilers.items():
 if (nonstd/'build').exists():shutil.rmtree(nonstd/'build')
 log=root/(mode+'-harf-check.log');r=run([compiler,'check','--stdlib',silk/'stdlib','--json','--progress','never'],nonstd/'fonts/shape/tools/cli',log)
 result={'case':'harfrust-check','mode':mode,'exit_code':r['exit_code'],'diagnostics':diagnostics(log),'wall_s':r['wall_s']};save(result);checks.append(result)
 if r['exit_code']:raise SystemExit('large check failed '+mode)
if checks[0]['diagnostics']!=checks[1]['diagnostics']:raise SystemExit('large diagnostics mismatch')
print('PASS generated compiler parity',root,flush=True)
