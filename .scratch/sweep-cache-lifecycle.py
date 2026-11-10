import ctypes,json,os,re,shutil,subprocess,sys,tempfile
from pathlib import Path
compiler=Path(sys.argv[1]).resolve()
source=Path(sys.argv[2] if len(sys.argv)>2 else '/workspace/silk/.scratch/finite-integration')
base=Path(tempfile.mkdtemp(prefix='sweep-cache-',dir='/workspace/silk/.scratch/benchmarks'))
if ctypes.CDLL(None).prctl(36,1,0,0,0):raise RuntimeError('subreaper unavailable')
p=base/'parallel';p.mkdir()
(p/'silk.toml').write_text('[package]\nname = "sweep-cache"\nversion = "0.0.0"\nsource = "."\n')
pads=[f'pad{i:02}' for i in range(40)]
for pad in pads:(p/f'{pad}.silk').write_text('pub fn answer() -> i32 { return 1 }\n')
(p/'main.silk').write_text('\n'.join(['import large',*[f'import {pad}' for pad in pads],'pub fn main() -> i32 { return large.value130() + '+' + '.join(f'{pad}.answer()' for pad in pads)+' }','']))
# Comments deliberately make authored body ranges cross the production chunk-work threshold.
# Semantic workload stays small, while the test must exercise the real chunk scheduler.
comment='//'+('chunk coverage source padding '*38)+'\n'
original='\n'.join(f'pub fn value{i}() -> i32 {{\n{comment}return 1\n}}' for i in range(320))+'\n'
assert len(original)>262144
stages=[('cold',original,0),
 ('first-body-edit',original.replace('pub fn value130() -> i32 {','pub fn value130() -> i32 {',1).replace('return 1\n}\npub fn value131','return 2\n}\npub fn value131',1),0),
 ('second-body-edit',original.replace('return 1\n}\npub fn value131','return 3\n}\npub fn value131',1),0),
 ('unchanged',original.replace('return 1\n}\npub fn value131','return 3\n}\npub fn value131',1),0),
 ('invalid-body',original.replace('return 1\n}\npub fn value131','return true\n}\npub fn value131',1),1),
 ('unused-body-error',original.replace('return 1\n}\npub fn value271','return true\n}\npub fn value271',1),1),
 ('recovery',original,0),('new-name-collision',original+'pub fn value1() -> i32 { return 9 }\n',1),
 ('new-invalid-declaration',original+'pub fn unused_bad() -> i32 { return true }\n',1),
 ('warning',original.replace('return 1\n}\npub fn value131','let unused = 2\nreturn 1\n}\npub fn value131',1),0),
 ('warning-shift','\n\n'+original.replace('return 1\n}\npub fn value131','let unused = 2\nreturn 1\n}\npub fn value131',1),0)]
results=[]
def run(folder,mode,stage):
 env=dict(os.environ)
 for k in list(env):
  if k.startswith('SILK_FRONTIER_') or k in ['SILK_EXPERIMENT_FRONTIER','SILK_RETAINED_CACHE','SILK_EXPERIMENT_FORK_CHECK']:env.pop(k)
 if mode=='parallel':env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_CHUNKS='1',SILK_FRONTIER_WARM='0',SILK_RETAINED_CACHE='1')
 q=subprocess.run([str(compiler),'check','--manifest-path',str(folder/'silk.toml'),'--stdlib',str(source/'stdlib'),'--progress','never','--json'],env=env,capture_output=True,text=True,timeout=120)
 while True:
  try:os.waitpid(-1,0)
  except ChildProcessError:break
 (base/f'{stage}-{mode}.log').write_text(q.stderr)
 diagnostic=[];trace=[]
 for line in q.stderr.splitlines():
  if line.startswith('frontier '):trace.append(line)
  elif line.strip():
   diagnostic.append(json.loads(line.replace(str(folder),'<fixture>')))
 return dict(code=q.returncode,out=q.stdout,diagnostics=diagnostic,trace=trace)
for stage,text,expected in stages:
 (p/'large.silk').write_text(text)
 serial=base/'serial'
 if serial.exists():shutil.rmtree(serial)
 shutil.copytree(p,serial,ignore=shutil.ignore_patterns('build'))
 actual=run(p,'parallel',stage);fresh=run(serial,'serial',stage)
 assert actual['code']==fresh['code']==expected,(stage,actual,fresh)
 assert actual['diagnostics']==fresh['diagnostics'],(stage,actual['diagnostics'],fresh['diagnostics'])
 assert actual['out']==fresh['out'],stage
 if stage=='cold':
  assert any(x=='frontier accepted' for x in actual['trace']),actual['trace']
  assert any(x.startswith('frontier declaration chunk ') for x in actual['trace']),actual['trace']
  assert any(re.search(r'module sweep cache assembled .* a=[1-9]\d* b=[1-9]\d*',x) for x in actual['trace']),actual['trace']
 if stage.startswith('warning'):assert any(x.get('severity')=='warning' for x in actual['diagnostics']),actual
 row=dict(stage=stage,status='pass',diagnostics=len(actual['diagnostics']),frontier=any(x=='frontier accepted' for x in actual['trace']))
 results.append(row);print(json.dumps(row),flush=True)
 (base/'results.json').write_text(json.dumps(results,indent=2)+'\n')
print(base,flush=True)
