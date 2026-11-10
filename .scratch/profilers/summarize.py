from pathlib import Path
import re,collections,json,sys
symbols={}
for line in Path('/workspace/silk/.scratch/N0.symbols').read_text().splitlines():
 p=line.split('\t',2)
 if len(p)==3:symbols[p[0]]=p[2]+' ['+p[1]+']'
files=[Path(x) for x in sys.argv[1:]]
own=collections.Counter(); edges=collections.Counter(); counts=collections.Counter();total=0
for path in files:
 lines=path.read_text().splitlines(); names={}; current=callee=None; iscall=False
 for l in lines:
  m=re.match(r'(?:c)?fn=\((\d+)\) (.+)',l)
  if m:
   value=re.sub(r"'\d+$",'',m[2]);names[m[1]]=symbols.get(value,value)
  if l.startswith('summary:'):total+=int(l.split()[1])
 for l in lines:
  m=re.match(r'fn=\((\d+)\)',l)
  if m:current=m[1];iscall=False;continue
  m=re.match(r'cfn=\((\d+)\)',l)
  if m:callee=m[1];continue
  if l.startswith('calls='):
   iscall=True;count=int(l[6:].split()[0]);continue
  if not l or l[0] not in '0123456789+-*':continue
  pieces=l.split()
  if len(pieces)!=2:continue
  cost=int(pieces[1]);caller=names.get(current,current)
  if iscall:
   key=(caller,names.get(callee,callee));edges[key]+=cost;counts[key]+=count;iscall=False
  else:own[caller]+=cost
print('Total:',total,'sum own:',sum(own.values()))
for title,counter in [('EXCLUSIVE',own),('INCLUSIVE',{k:v+sum(c for (a,b),c in edges.items() if a==k) for k,v in own.items()})]:
 print(title)
 for name,cost in sorted(counter.items(),key=lambda x:x[1],reverse=True)[:80]:print(f'{100*cost/total:6.2f}% {cost:14,d} {name}')
if len(sys.argv)>1:
 Path('/workspace/silk/.scratch/profilers/summary.json').write_text(json.dumps({'total':total,'own':dict(own),'edges':[{'caller':a,'callee':b,'cost':v,'calls':counts[a,b]} for (a,b),v in edges.items()]},indent=2))
