import ctypes,json,os,shutil,subprocess,sys
from pathlib import Path
base=Path('/workspace/silk/.scratch/cost-chunk-parity');base.mkdir(exist_ok=True)
if ctypes.CDLL(None).prctl(36,1,0,0,0): raise RuntimeError('subreaper unavailable')
compiler=Path(sys.argv[1] if len(sys.argv)>1 else '/workspace/silk/.scratch/chunk-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler')
source=Path('/workspace/silk-balanced-frontier')
results=[]
for case in ['valid','warning','body-error','name-collision']:
 d=base/case;d.mkdir(exist_ok=True)
 (d/'silk.toml').write_text('[package]\nname = "chunk-parity"\nversion = "0.0.0"\nsource = "."\n')
 pads=[f'pad{i:02}' for i in range(40)]
 for pad in pads:(d/f'{pad}.silk').write_text('pub fn answer() -> i32 { return 1 }\n')
 body=['pub fn main() -> i32 { return 2 }']
 for i in range(320):
  name=f'value{i}'
  if case=='name-collision' and i in [20,280]:name='collide'
  code='return 1'
  if case=='body-error' and i==130:code='return true'
  if case=='warning' and i==130:code='let unused = 2 return 1'
  # Padding stays inside the authored body span; it exercises cost partitioning
  # without making a correctness fixture expensive to compile.
  padding = '// ' + 'body span scheduling ' * 60 + '\n'
  body.append(f'pub fn {name}() -> i32 {{ {padding}{code} }}')
 (d/'large.silk').write_text('\n'.join(body)+'\n')
 (d/'main.silk').write_text('\n'.join(['import large',*[f'import {p}' for p in pads], 'pub fn main() -> i32 { return large.main() + '+' + '.join(f'{p}.answer()' for p in pads)+' }','']))
 if '--run' not in sys.argv:continue
 variants=[]
 for mode in ['off','on-1','on-2']:
  shutil.rmtree(d/'build',ignore_errors=True)
  env=dict(os.environ)
  for key in list(env):
   if key.startswith('SILK_FRONTIER_') or key=='SILK_EXPERIMENT_FRONTIER':env.pop(key)
  if mode!='off':env.update(SILK_EXPERIMENT_FRONTIER='1',SILK_FRONTIER_SHARED='1',SILK_FRONTIER_EPHEMERAL='1',SILK_FRONTIER_CHUNKS='1',SILK_FRONTIER_FORK_PRIVATE='1',SILK_FRONTIER_WARM='0')
  p=subprocess.run([str(compiler),'check','--manifest-path',str(d/'silk.toml'),'--stdlib',str(source/'stdlib'),'--progress','never','--json'],env=env,capture_output=True,text=True,timeout=60)
  while True:
   try:os.waitpid(-1,0)
   except ChildProcessError:break
  (d/f'{mode}.stdout').write_text(p.stdout);(d/f'{mode}.stderr').write_text(p.stderr)
  lines=p.stderr.splitlines();traces=[x for x in lines if x.startswith('frontier ')];diagnostics=[x for x in lines if not x.startswith('frontier ')]
  variants.append(dict(mode=mode,status=p.returncode,stdout=p.stdout,diagnostics=diagnostics,accepted='frontier accepted' in traces,chunks=sum(x.startswith('frontier declaration chunk ') for x in traces),split=any(x.startswith('frontier split ') for x in traces)))
 expected=0 if case in ['valid','warning'] else 1
 issues=[]
 if variants[0]['status']!=expected:issues.append('serial status')
 if case=='warning' and not any(json.loads(x).get('severity')=='warning' for x in variants[0]['diagnostics']):issues.append('missing warning')
 for v in variants[1:]:
  if any(v[k]!=variants[0][k] for k in ['status','stdout','diagnostics']):issues.append(v['mode']+' parity')
  if not v['split']:issues.append(v['mode']+' no split')
  if case in ['valid','warning'] and (not v['accepted'] or v['chunks']<2):issues.append(v['mode']+' incomplete chunk acceptance')
  if expected==1 and v['accepted']:issues.append(v['mode']+' invalid accepted')
 row=dict(case=case,variants=variants,issues=issues);results.append(row);print(json.dumps(row),flush=True)
 (base/'results.json').write_text(json.dumps(results,indent=2)+'\n')
if '--run' in sys.argv:sys.exit(any(row['issues'] for row in results))
print('Prepared four 320-declaration body-span fixtures; no compiler run.')
