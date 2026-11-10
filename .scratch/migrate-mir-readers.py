from pathlib import Path
import re
root=Path('/workspace/silk/.scratch/immutable-executable-bodies/compiler/src/backend')
body='result parameters locals blocks externs contexts traps cancels features inlining optimizeSize frame lines variables'.split()
logical='borrow references observes suspension parks releasesPackages nonParking accesses escapes'.split()
for name in ['Coroutine','InstanceRecipe','InstanceText','LlvmCode','LoweringPlan','MirText','MirVerification','StackLifetimes','WasmLower']:
 p=root/(name+'.silk');s=p.read_text()
 s=s.replace('MirFunction.', 'MirDraft.')
 s=re.sub(r'\bMirFunction\b','MirView',s)
 for field in body:s=re.sub(r'\bfunction\.'+field+r'\b','function.body.'+field,s)
 for field in logical:s=re.sub(r'\bfunction\.'+field+r'\b','function.logical.'+field,s)
 s=re.sub(r'&((?:[A-Za-z_]\w*\.)*function)\.key\b',r'\1.key',s)
 if 'MirDraft.' in s:s='import backend.Mir {MirDraft}\n'+s
 p.write_text(s)
