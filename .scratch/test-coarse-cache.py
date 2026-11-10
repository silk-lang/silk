import hashlib,json,os,pathlib,shutil,subprocess,sys,time
root=pathlib.Path('/workspace/silk')
binary=root/'.scratch/coarse-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
work=root/'.scratch/coarse-acceptance'
work.mkdir(exist_ok=True)
results=[]
def put(p,s):
 p.parent.mkdir(parents=True,exist_ok=True);p.write_text(s)
def manifest(p,name='coarse-fixture',extra=''):
 put(p/'silk.toml',f'[package]\nname = "{name}"\nversion = "0.0.0"\nsource = "."\n'+extra)
def invoke(p,coarse=True,command='check',extra=()):
 env=os.environ.copy();env["SILK_CLANG"]=str(root/".scratch/llvm-22.1.8/bin/clang")
 for k in ['SILK_EXPERIMENT_COARSE_CHECK','SILK_EXPERIMENT_COARSE_BUILD','SILK_EXPERIMENT_COARSE_TRACE','SILK_EXPERIMENT_ADAPTIVE_CACHE']:
  env.pop(k,None)
 if coarse:
  env['SILK_EXPERIMENT_COARSE_CHECK']='1';env['SILK_EXPERIMENT_COARSE_BUILD']='1';env['SILK_EXPERIMENT_COARSE_TRACE']='1'
  if os.environ.get('COARSE_TEST_ADAPTIVE')=='1':env['SILK_EXPERIMENT_ADAPTIVE_CACHE']='1'
 args=[str(binary),command,'--manifest-path',str(p/'silk.toml'),'--stdlib',str(root/'.scratch/coarse-cache-experiment/stdlib'),'--progress','never',*extra]
 if command=='check':args+=['--json']
 started=time.monotonic();proc=subprocess.run(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 stderr=proc.stderr.decode(errors='replace')
 hit='whole-check hit\n' in stderr
 trace=[l for l in stderr.splitlines() if l.startswith('whole-check ')]
 clean='\n'.join(l for l in stderr.splitlines() if not l.startswith(('whole-check ','adaptive ')))
 results.append({'fixture':p.name,'coarse':coarse,'command':command,'status':proc.returncode,'wall':time.monotonic()-started,'hit':hit,'trace':trace})
 return proc.returncode,proc.stdout,clean,hit

def equal(p,label,expected=None):
 off=invoke(p,False);on=invoke(p,True)
 assert off[:3]==on[:3],(label,off,on)
 if expected is not None:assert on[0]==expected,(label,on)
 # One initial warm pass may establish load observations after fresh generated outputs.
 warm=invoke(p,True)
 assert warm[:3]==on[:3],(label,'warm diagnostics',on,warm)
 if not warm[3]:warm=invoke(p,True)
 assert warm[3],(label,'no warm hit',results[-3:])
 assert warm[:3]==on[:3],(label,'second warm diagnostics',on,warm)
 print(label,'PASS',flush=True)

phase=sys.argv[1] if len(sys.argv)>1 else 'check'
if phase=='check':
 for fixture in ['simple','generated','tooled','workspace']:shutil.rmtree(work/fixture,ignore_errors=True)
 p=work/'fresh';shutil.rmtree(p,ignore_errors=True);manifest(p,'coarse-fresh')
 (p/'silk.toml').write_text((p/'silk.toml').read_text().replace('source = "."','source = "src"'))
 put(p/'src/main.silk','pub fn main() -> i32 { return 0 }\n')
 first=invoke(p,True);second=invoke(p,True)
 assert first[:3]==second[:3] and first[0]==0 and second[3],('first warm must hit',first,second)
 print('first warm hit PASS',flush=True)
 p=work/'simple';manifest(p)
 put(p/'main.silk','pub fn main() -> i32 { return 0 }\n')
 equal(p,'valid',0)
 put(p/'main.silk','pub fn main() -> i32 { return true }\n')
 assert not invoke(p,True)[3], 'edited source reused result'
 equal(p,'rejected',1)
 put(p/'main.silk','import Missing\npub fn main() -> i32 { return Missing.value() }\n')
 equal(p,'missing module',1)
 put(p/'Missing.silk','pub fn value() -> i32 { return 0 }\n')
 assert not invoke(p,True)[3], 'new module reused missing result'
 equal(p,'created module',0)
 put(p/'main.silk','import Missing\nimport silk.core.option {Option}\npub fn main() -> i32 { return Missing.value() }\n')
 equal(p,'warning',0)
 # A build plan generates bytes that are not source files and must enter the revision key.
 p=work/'generated';manifest(p,'coarse-generated')
 put(p/'main.silk','import generated\npub fn main() -> i32 { return generated.VALUE }\n')
 def generated(value):return 'import silk.build.plan {Plan}\npub const PLAN: string = Plan.module(Plan.empty(), "generated", "pub const VALUE: i32 = '+value+'\\n")\n'
 put(p/'build.silk',generated('1'));equal(p,'generated module',0)
 put(p/'build.silk',generated('true'));assert not invoke(p,True)[3]
 equal(p,'generated rejection',1)
 # Declared external tools still run/validate before whole semantic result lookup.
 p=work/'tooled';manifest(p,'coarse-too1','\n[build]\nunsandboxed-tools = true\n')
 put(p/'main.silk','import generated\npub fn main() -> i32 { return generated.VALUE }\n')
 put(p/'build.silk','''import silk.build.plan {Plan}
static fn plan() -> string<'static> {
 let mut plan = Plan.empty()
 plan = Plan.tool(plan, "gen", "tools/gen.sh")
 plan = Plan.toolArgument(plan, "input.txt")
 plan = Plan.toolInput(plan, "input.txt")
 plan = Plan.toolOutput(plan, "generated.silk")
 plan = Plan.toolModule(plan, "generated", "gen", "generated.silk")
 return plan
}
pub const PLAN: string = plan()
''')
 put(p/'tools/gen.sh','#!/bin/sh\nprintf "pub const VALUE: i32 = %s\\n" "$(cat "$SILK_PACKAGE_DIR/$1")" > generated.silk\n')
 (p/'tools/gen.sh').chmod(0o755)
 put(p/'input.txt','2\n');equal(p,'tool generation',0)
 generated_output=p/'build/tools/coarse-too1/gen/generated.silk'
 assert generated_output.exists(),generated_output
 put(generated_output,'pub const VALUE: i32 = true\n');assert not invoke(p,True)[3]
 equal(p,'tool output edit',1)
 put(p/'input.txt','3\n');assert not invoke(p,True)[3]
 equal(p,'tool input edit',0)
 # Shared workspace SourceSnapshot reads must remain in each member's key.
 p=work/'workspace';put(p/'silk.toml','[workspace]\nmembers=["a", "b"]\n')
 for name in ['a','b']:
  manifest(p/name,'coarse-'+name,'\n[dependencies]\nshared={path="../shared"}\n')
  put(p/name/'main.silk','import shared.Shared\npub fn main() -> i32 { return Shared.value() }\n')
 manifest(p/'shared','shared','')
 put(p/'shared/silk.toml','[package]\nname="shared"\nversion="0.0.0"\nkind="library"\nsource="."\nexports=["Shared"]\n')
 put(p/'shared/Shared.silk','pub fn value() -> i32 { return 0 }\n')
 equal(p,'shared snapshot workspace',0)
 put(p/'shared/Shared.silk','pub fn value() -> i32 { return true }\n')
 equal(p,'shared snapshot edit',1)
elif phase=='artifact':
 p=work/'artifact';manifest(p,'coarse-artifact','\n[profiles.fast]\noptimization="none"\ndebug=false\n')
 fixtures={
  'scalar':'pub fn main() -> i32 { return 13 }\n',
  'generic':'fn identity<T>(x: T) -> T { return move x }\npub fn main() -> i32 { return identity<i32>(17) }\n',
  'control':'import silk.num.i32\npub fn main() -> i32 { let mut n: i32 = 0 while n < 9 { n = n + 1 } return n }\n',
 }
 for name,source in fixtures.items():
  put(p/'main.silk',source)
  hashes=[]
  for coarse in [False,True]:
   shutil.rmtree(p/'build',ignore_errors=True)
   outcome=invoke(p,coarse,'build',['--profile','fast'])
   assert outcome[0]==0,(name,coarse,outcome)
   artifact=p/'build/llvm/x86_64-unknown-linux-gnu/fast/coarse-artifact'
   if not artifact.exists():
    matches=[q for q in (p/'build').rglob('coarse-artifact') if q.is_file()];assert len(matches)==1,matches;artifact=matches[0]
   hashes.append(hashlib.sha256(artifact.read_bytes()).hexdigest())
   before=artifact.stat().st_mtime_ns
   warm=invoke(p,coarse,'build',['--profile','fast']);assert warm[0]==0,warm
   assert artifact.stat().st_mtime_ns==before,(name,'warm artifact rewritten')
  assert hashes[0]==hashes[1],(name,'artifact mismatch',hashes)
  print(name,'byte-identical',hashes[0],flush=True)
else:raise ValueError(phase)
(work/f'{phase}-results.json').write_text(json.dumps(results,indent=2))
print('ALL PASS',phase,len(results),flush=True)
