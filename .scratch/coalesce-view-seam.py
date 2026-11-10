from pathlib import Path
import re
ns={};s0=Path('/workspace/silk/.scratch/split-mir-owned.py').read_text();exec(s0[:s0.index('for file in')],ns);end=ns['end_brace']
p=Path('/workspace/silk/.scratch/immutable-executable-bodies/compiler/src/backend/MirCoalesce.silk');s=p.read_text()
funcs=[]
for m in re.finditer(r'\bfn\s+(\w+)\(',s):
 a=s.index('{',m.end());b=end(s,a);sig=s[m.start():a];funcs.append((m.start(),a,b,m[1],sig))
readonly={name for _,_,_,name,sig in funcs if re.search(r': &MirDraft\b',sig)}
for start,a,b,name,sig in reversed(funcs):
 part=s[start:b+1]
 if re.search(r': &MirDraft\b',sig):
  part=part.replace('&MirDraft',"&MirView<'_>").replace('&MirDraft.view(function)','function')
 elif re.search(r': &mut MirDraft\b',sig):
  for target in readonly:
   part=re.sub(r'\b'+target+r'\((?:&)?(function|owner)(?:\.\*)?(?=[,)])',lambda m:target+'(&MirDraft.view('+m[1]+')',part)
 s=s[:start]+part+s[b+1:]
s=s.replace('  MirDraft,','  MirDraft, MirView,');p.write_text(s)
print('migrated readonly helpers:',sorted(readonly))
