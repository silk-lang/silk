import sys,re
from pathlib import Path
sys.path.insert(0,'/workspace/silk/.scratch')
from silk_edit_helpers import item_span
p=Path('/workspace/silk/.scratch/finite-platform-cleanup/compiler/src/semantic/Semantic.silk');s=p.read_text()
def delete(pattern):
 global s
 a,b=item_span(s,pattern)
 while a>0:
  line=s.rfind('\n',0,a-1)+1
  if s[line:a].lstrip().startswith('//'):a=line
  else:break
 s=s[:a]+s[b:]
# Closedness is intrinsic to the canonical application; finite admission does not depend on ancestors.
a=s.index('        let mut entered = false\n',s.index('  effect fn rewalkBuild('))
b=s.index('        if visited != usize.MAX { continue }',a)
s=s[:a]+'''        if u64.bitAnd(facts.flags, BuildRecord.FACT_APPLICATION) != 0 {
          let closed = u64.bitAnd(facts.flags, BuildRecord.FACT_CLOSED) != 0
          if !closed { return Option<BackendBuild>.none() }
        }
'''+s[b:]
a=s.index('        if entered {',a);_,b=item_span(s,r'^        if entered \{') # only one remains nearbuild
s=s[:a]+s[b:]
a=s.index('      let mut admitted = false\n',s.index('  effect fn rewalkEscapes('))
b=s.index('      if visited != usize.MAX { continue }',a)
s=s[:a]+'''      if u64.bitAnd(facts.flags, BuildRecord.FACT_APPLICATION) != 0 {
        let closed = u64.bitAnd(facts.flags, BuildRecord.FACT_CLOSED) != 0
        if !closed { return Option<EscapeReplay>.none() }
      }
'''+s[b:]
a=s.index('      if admitted {',a)
# balanced body starting precisely at this location
_,relative=item_span(s[a:],r'^      if admitted \{');s=s[:a]+s[a+relative:]
s=re.sub(r'^    let mut frames = List<RewalkFrame>\.make\(\)\n','',s,flags=re.M)
s=re.sub(r'^\s*drop List<RewalkFrame>\.pop\(&mut frames\)\n','\n',s,flags=re.M)
for name in ['rewalkDecide','rewalkEdge']:
 delete(r'^  effect fn '+name+r'\(')
for name in ['rewalkAdmits','rewalkBuildDecide']:
 delete(r'^(?:effect )?fn '+name+r'\(')
delete(r'^struct RewalkFrame\b')
s=re.sub(r'^impl Copy for RewalkFrame \{\}\n|^const REWALK_\w+: u64 = \d\n','',s,flags=re.M)
s=s.replace('    if Admission.argumentFree(&application) { facts.flags = u64.bitOr(facts.flags, BuildRecord.FACT_ARGUMENT_FREE) }\n','')
s=s.replace('    facts.body = run bodyHash(Admission.body(&application))\n','')
s=s.replace(' + BuildRecord.FACT_ARGUMENT_FREE','').replace('  kept.body = facts.body\n','')
a=s.index('  // Admission is decided on the record\'s word')
b=s.index('  // local-shared access',a)
s=s[:a]+'''  // Every reached application must remain closed; the visited-definition graph establishes
  // finite specialization independently of the route to a node. The build walks instead when
  // a body lowered during replay suspends, parks, escapes a
'''+s[b:]
a=s.index('  // An admission is taken from the record')
b=s.index('  effect fn rewalkEscapes(',a)
s=s[:a]+'''  // Closedness is retained with each application's canonical key facts. Recursion closes through
  // the exact visited-definition graph, so changing the path does not require an ancestry proof.
  // Missing closedness facts or any unproved callback/escape obligation force the live walk.
'''+s[b:]
s=re.sub(r'\n{3,}','\n\n',s)
p.write_text(s)
# Remove stale ancestry-only record evidence; FORMAT rejects older payload shapes.
p=Path('/workspace/silk/.scratch/finite-platform-cleanup/compiler/src/semantic/BuildRecord.silk');s=p.read_text()
s=s.replace('pub const FORMAT: u64 = 11','pub const FORMAT: u64 = 12')
s=re.sub(r'^pub const FACT_ARGUMENT_FREE: u64 = 4\n','',s,flags=re.M)
s=re.sub(r'^  pub body: u64,\n','',s,flags=re.M)
s=s.replace('body: 0, ','').replace('body: facts.body, ','')
s=s.replace('  if u64.bitAnd(facts.flags, FACT_APPLICATION) != 0 { run Encoding.word(&mut output.*, facts.body) }\n','')
s=s.replace('  if u64.bitAnd(facts.flags, FACT_APPLICATION) != 0 { facts.body = readFixed(bytes, &mut cursor.*) }\n','')
p.write_text(s)
# Remove the no-longer-used ancestry projection methods and their private predicate.
p=Path('/workspace/silk/.scratch/finite-platform-cleanup/compiler/src/semantic/Specialization.silk');s=p.read_text()
for name in ['argumentFree','body','edges']:
 delete(r'^  pub (?:effect )?fn '+name+r'\(')
delete(r'^fn argumentFree\(')
s=re.sub(r'\n{3,}','\n\n',s)
p.write_text(s)
