import re,sys
from pathlib import Path
sys.path.insert(0,'/workspace/silk/.scratch')
from silk_edit_helpers import item_span
p=Path('/workspace/silk/.scratch/finite-platform-cleanup/compiler/src/semantic/Semantic.silk');s=p.read_text()
def transform(name):
 global s
 a,b=item_span(s,r'^  (?:pub )?effect fn '+name+r'\(')
 t=s[a:b]
 t=t.replace('    let mut admission = Admission.make()\n','')
 # Preserve the authored OpenInstance refusal exactly; only entry-path allocation disappears.
 start=t.index('      let mut leave = false') if name=='capturedEscapes' else t.index('        let mut leave = false')
 stop=t.index('      // Every region pattern',start) if name=='capturedEscapes' else t.index('        if run applicationVisited',start)
 guard=t[start:stop]
 ga,gb=item_span(guard,r'^\s*Decision.Open => ')
 body=guard[ga:gb];body=body[body.index('{')+1:body.rfind('}')].strip('\n')
 indent='      ' if name=='capturedEscapes' else '        '
 lines=body.splitlines();left=min(len(x)-len(x.lstrip()) for x in lines if x.strip());body='\n'.join(indent+'    '+x[left:] for x in lines)
 t=t[:start]+indent+'if let Option<Interned<Application>>.Some {value: application} = move InstanceKey.application(&instance) {\n'+indent+'  if !Interned<Application>.with<bool>(&application, Admission.closed) {\n'+body+'\n'+indent+'  }\n'+indent+'}\n'+t[stop:]
 pattern=r'^\s*BackendVisit.Leave => '
 while re.search(pattern,t,re.M):
  x,y=item_span(t,pattern);t=t[:x]+t[y:]
 pattern=r'^\s*if leave (?=\{)'
 while re.search(pattern,t,re.M):
  x,y=item_span(t,pattern);t=t[:x]+t[y:]
 assert 'Admission.leave' not in t
 assert 'BackendVisit.Leave' not in t
 s=s[:a]+t+s[b:]
transform('capturedEscapes');transform('buildFrom')
# An enter-only runtime queue needs neither synthetic leave markers nor scans to count tasks.
a,b=item_span(s,r'^fn frontierWidth\(');s=s[:a]+'fn frontierWidth(pending: &[BackendVisit]) -> usize { return pending.length }'+s[b:]
a,b=item_span(s,r'^effect fn selectFrontier\(');t=s[a:b];x,y=item_span(t,r'^\s*BackendVisit.Leave => ');t=t[:x]+t[y:];s=s[:a]+t+s[b:]
s=s.replace('// The inherited leave markers retain the exact admission ancestry of each selected task.','// Each worker owns a disjoint portion of the pending runtime requests.')
a,b=item_span(s,r'^union BackendVisit\b');t=s[a:b];t=re.sub(r'^  Leave,?\n','',t,flags=re.M);s=s[:a]+t+s[b:]
s=s.replace('    let application = run Application.copyShared(&shared)\n    facts.flags = u64.bitOr(facts.flags, BuildRecord.FACT_APPLICATION)\n    if Admission.closed(&application)', '    facts.flags = u64.bitOr(facts.flags, BuildRecord.FACT_APPLICATION)\n    if Interned<Application>.with<bool>(&shared, Admission.closed)')
p.write_text(s)
