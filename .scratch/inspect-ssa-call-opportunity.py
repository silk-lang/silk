import gzip,re,json
from pathlib import Path
root=Path('/workspace/silk/.scratch/benchmarks/scalar-ssa-ir-sk7c1swx');found=[];n=0;function=[]
def inspect(lines):
 global n
 n+=1
 header=lines[0];block='entry';slots={};definitions={};uses={}
 for i,line in enumerate(lines):
  m=re.match(r'(%l\d+) = alloca (i8|i16|i32|i64|float|double|ptr),',line)
  if m:slots[m[1]]={'allocation':i,'stores':[],'loads':[],'other':[]}
 for i,line in enumerate(lines):
  if re.match(r'[A-Za-z][A-Za-z0-9_]*:',line):block=line.strip().rstrip(':')
  m=re.match(r'(%v\d+) = (.*)',line)
  if m:definitions[m[1]]=(i,m[2])
  for v in re.findall(r'%v\d+',line):uses.setdefault(v,[]).append(i)
  for name in re.findall(r'%l\d+',line):
   if name not in slots or i==slots[name]['allocation']:continue
   store=re.match(r'store (?:i\d+|float|double|ptr) ([^,]+), ptr '+re.escape(name)+r',',line)
   load=re.match(r'(%v\d+) = load (?:i\d+|float|double|ptr), ptr '+re.escape(name)+r',',line)
   if store:slots[name]['stores'].append((i,block,store[1]))
   elif load:slots[name]['loads'].append((i,block,load[1]))
   else:slots[name]['other'].append(i)
 for name,slot in slots.items():
  if name=='%l0' or slot['other'] or len(slot['stores'])!=1 or not slot['loads']:continue
  at,where,value=slot['stores'][0]
  if value.startswith('%p') or any(i<=at or b!=where for i,b,v in slot['loads']):continue
  if value.startswith('%'):
   definition=definitions.get(value)
   if not definition or not re.match(r'(?:load (?:i\d+|float|double|ptr), ptr %l\d+,|(?:add|sub|mul|icmp|fcmp|fadd|fsub|fmul|xor|and|or) )',definition[1]):continue
  calls=[]
  for _,_,v in slot['loads']:
   for u in uses.get(v,[]):
    if re.search(r'call (?:i8|i16|i32|i64|float|double|ptr) @silk_[a-f0-9]+\(',lines[u]):calls.append(u)
  if calls:
   selected=sorted(set([slot['allocation'],at]+([definitions[value][0]] if value in definitions else [])+[i for i,b,v in slot['loads']]+calls))
   found.append({'function':header.strip(),'slot':name,'evidence':[lines[i].strip() for i in selected]})
with gzip.open(root/'compiler-candidate.ll.gz','rt') as ir:
 for line in ir:
  if line.startswith('define '):function=[line]
  elif function:
   function.append(line)
   if line.strip()=='}':
    inspect(function);function=[]
    if n>=500 or len(found)>=5:break
report={'functions_inspected':n,'scope':'first functions in existing V8 LLVM, examples only; not total eligibility or performance estimate','examples':found};(root/'call-argument-examples.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
