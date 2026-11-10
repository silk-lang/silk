import sys,re
from pathlib import Path
sys.path.insert(0,'/workspace/silk/.scratch')
from silk_edit_helpers import item_span
p=Path('/workspace/silk/.scratch/finite-platform-cleanup/compiler/src/semantic/Semantic.silk');s=p.read_text()
def delete(pattern,comments=True):
 global s
 a,b=item_span(s,pattern)
 if comments:
  while a>0:
   line=s.rfind('\n',0,a-1)+1
   if s[line:a].lstrip().startswith('//'):a=line
   else:break
 s=s[:a]+s[b:]
# Blocks produced by the former admission heuristic are unreachable under finite admission.
for kind in ['Rejected','ChangingStatic','Reused']:
 pattern=r'^\s*Decision\.'+kind+r'\s*\{[^\n]*?\}\s*=>\s*(?=\{)'
 while re.search(pattern,s,re.M):delete(pattern,False)
# One expression arm in the soon-removed replay helper.
s=re.sub(r'^\s*Decision\.Reused \{\.\.\} => REWALK_REUSED\n','\n',s,flags=re.M)
s=s.replace('  /// The application grows a recursive specialization along `path`.\n  Growing {path: List<Application>},\n','')
delete(r'^    Option<OriginRefusal>\.Some \{value: OriginRefusal\.Growing \{path\}\} => ',False)
# Apply the finite entry result directly, retaining all closedness/resource diagnostics.
s=re.sub(r'let refused = (run Admission\.enterCanonical\([^\n]+\))\n\s*let decision = run admitOwnedDescent\([^\n]+\)',r'let decision = \1',s)
s=s.replace('        let enteredEdge = Edge.copy(&reaching)\n','').replace('          let enteredEdge = Edge.copy(&reaching)\n','')
for name in ['cleanupAdmits','ownedDescentAdmits','cleanupTransition','withinCleanup','searchCleanup','containsRuntimeType','strictlySmallerNominal','admitOwnedDescent','withinOwned','ownedMemberTypes','rejectSpecialization']:
 delete(r'^effect fn '+name+r'\(')
delete(r'^struct CleanupAnswer\b')
s=s.replace('  OwnedStep,\n','')
s=re.sub(r'^    let mut (certified = List<Application>\.make\(\)|certifiedLookup = InternIndex\.make\(\)|cleanupAnswers = List<CleanupAnswer>\.make\(\))\n','',s,flags=re.M)
s=re.sub(r'// The most types one owned-structure search visits\.[\s\S]*?const ownedStructureTypes: usize = 256\n','',s)
# This related site was only consumed by the deleted expansion diagnostic arm.
s=s.replace('  let root = RelatedSite {module: ModuleId.copy(&incoming.module), span: incoming.span}\n','')
p.write_text(s)
p=Path('/workspace/silk/.scratch/finite-platform-cleanup/compiler/src/semantic/Specialization.silk');s=p.read_text()
for name in ['ownedSteps','activeUpToStatics','isActive','sameNonTypeArguments']:
 delete(r'^  pub (?:effect )?fn '+name+r'\(')
for name in ['sameExceptStatics','clearScopeStatics','opaqueEffect','activeAnywhere']:
 delete(r'^(?:effect )?fn '+name+r'\(')
delete(r'^pub struct OwnedStep\b')
s=s.replace('  Reused {pub ancestor: usize},\n','').replace('  Rejected {pub path: List<Application>},\n','')
s=s.replace('  /// The nearest active application of the same target differs only in static values. Non-static\n  /// growth was already ruled out; admission needs a finite closure certificate for this edge.\n  ChangingStatic {pub ancestor: usize},\n','')
s=s.replace('/// A finite request, a repeated runtime identity, or the exact path that grows recursively.','/// Whether a requested application is concrete and its bounded identity was established.')
s=re.sub(r'\n{3,}','\n\n',s)
p.write_text(s)
