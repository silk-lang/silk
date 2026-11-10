from pathlib import Path
p=Path('/workspace/silk/.scratch/shared-typed-bodies/compiler/src/semantic/BodyCapsule.silk');s=p.read_text()
def close(start):
 depth=1;i=start+1
 while depth:
  if s[i]=='{':depth+=1
  elif s[i]=='}':depth-=1
  i+=1
 return i-1
for ty in ['Expression','NodeKind']:
 start=s.index('effect fn read'+ty+'Value(');opening=s.index('{',start);end=close(opening)
 body=s[opening+1:end];matchstart=body.index('let result = match tag {')+len('let result = match tag {');pos=matchstart;cases=[]
 while True:
  import re
  m=re.match(r'\s*(\d+) => \{',body[pos:])
  if not m:break
  a=pos+m.end();depth=1;j=a
  while depth:
   if body[j]=='{':depth+=1
   elif body[j]=='}':depth-=1
   j+=1
  cases.append((m[1],body[a:j-1].strip()));pos=j
 assert len(cases)>10,(ty,len(cases))
 helpers=[];branches=[]
 for n,code in cases:
  lines=code.splitlines();construct=lines.pop().strip();assert construct.startswith(ty+'.'),construct
  helpers.append('effect fn read'+ty+'Case'+n+'(state: &mut Decode, bytes: &[u8], input: &mut BodyWire.Reader) -> Option<'+ty+'>\n! OutOfMemoryError ? &mut Allocator | &mut Types {\n  '+'\n  '.join(lines)+'\n  if input.failed { return Option<'+ty+'>.none() }\n  return Option<'+ty+'>.some('+construct+')\n}\n')
  branches.append('    '+n+' => run read'+ty+'Case'+n+'(&mut state.*, bytes, &mut input.*)')
 new='\n  let tag = BodyWire.readWord(bytes, &mut input.*)\n  return match tag {\n'+'\n'.join(branches)+'\n    _ => { input.failed = true\n      Option<'+ty+'>.none() }\n  }\n'
 s=s[:start]+'\n'.join(helpers)+'\n'+s[start:opening+1]+new+s[end:]
p.write_text(s)
