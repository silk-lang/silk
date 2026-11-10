"""Stream captured BC. Count internal fallible shape and call-site slot evidence.
No type-based ABI eligibility claim: unused/zero-copy args can include unreachable
success paths. i8 slots alone do not prove unit. Source-level layout guards required.
"""
from pathlib import Path
import argparse,collections,json,re,subprocess
p=argparse.ArgumentParser();p.add_argument('capture',type=Path);p.add_argument('output',type=Path);a=p.parse_args()
files={}
for f in (a.capture/'commands').glob('*.json'):
 r=json.loads(f.read_text())
 if '-c' in r['argv']:
  for i in r['inputs']:
   if i['bitcode']:files[i['sha256']]=i['saved']
def split_args(text):
 parts=[];start=0;depth=0
 for i,c in enumerate(text):
  if c in '([{<':depth+=1
  elif c in ')]}>':depth-=1
  elif c==',' and depth==0:parts.append(text[start:i].strip());start=i+1
 parts.append(text[start:].strip());return parts if text.strip() else []
definitions={};calls=collections.Counter();tails=collections.Counter();zero_memcopies=0;fn=None;slots={};uses={};signature='';hidden=None;body_return=False
names={p[0]:p[2] for line in Path('/workspace/silk/.scratch/construction-9279952db/pgo/training-debug.ll.symbols').read_text().splitlines() if len(p:=line.split('\t',2))==3}
def finish():
 global fn
 if fn is not None and hidden:
  out,fail,offset=hidden
  definitions[fn]=dict(name=names.get(fn,fn),signature=signature,tail_offset=offset,result_uses=dict(uses[out]),failure_uses=dict(uses[fail]),has_success_return=body_return)
 fn=None
for file in files.values():
 child=subprocess.Popen(['/workspace/silk/.scratch/llvm-22.1.8/bin/llvm-dis',file,'-o','-'],stdout=subprocess.PIPE,text=True)
 for line in child.stdout:
  if line.startswith('define '):
   finish();signature=line.strip();m=re.search(r'@([^ (]+)\((.*)\)',line);fn=m[1];slots={};uses={};hidden=None;body_return=False
   if re.search(r'\bi1 @silk_[a-f0-9]+\(',line):
    params=split_args(m[2])
    for offset in [2,3]:
     if len(params)>=offset and (o:=re.fullmatch(r'ptr noalias (%[\w.]+)',params[-offset])) and (f:=re.fullmatch(r'ptr (%[\w.]+)',params[-offset+1] if offset>1 else '')):
      hidden=(o[1],f[1],offset);uses={o[1]:collections.Counter(),f[1]:collections.Counter()};break
   continue
  if fn is None:continue
  if line.startswith('}'):finish();continue
  m=re.match(r'\s*(%[\w.]+) = alloca (.*)',line)
  if m:slots[m[1]]=m[2].split(', align')[0].strip()
  if re.search(r'\bret i1 false\b',line):body_return=True
  zero_copy=bool(re.search(r'@llvm\.(?:memcpy|memmove|memset).*i64 0, i1 false',line))
  if zero_copy:zero_memcopies+=1
  if hidden:
   refs=set(re.findall(r'%[\w.]+',line))
   for var in uses:
    if var in refs:uses[var]['zero_memory_intrinsic' if zero_copy else 'other']+=1
  m=re.search(r'\bcall (?:zeroext )?i1 @(silk_[a-f0-9]+)\((.*)\)',line)
  if m:
   callee=m[1];args=split_args(m[2]);calls[callee]+=1
   for offset in [1,2,3]:
    if len(args)>=offset:
     arg=args[-offset];v=re.search(r'(%[\w.]+)$',arg)
     ty=slots.get(v[1]) if v else None
     category='zero_array' if ty=='[0 x i8]' else 'i8_slot_ambiguous' if ty=='i8' else 'other_known_slot' if ty else 'not_direct_known_slot'
     tails[(callee,offset,category)]+=1
 assert child.wait()==0
finish();summary=collections.Counter();examples=[]
for symbol,d in definitions.items():
 d['direct_calls']=calls[symbol]
 summary['recognized_fallible_definitions']+=1;summary['direct_calls_to_recognized_definitions']+=calls[symbol]
 for label,field in [('result','result_uses'),('failure','failure_uses')]:
  use=d[field];unused=not use;zero_only=not use.get('other',0)
  if unused:summary[label+'_unreferenced_definitions']+=1;summary[label+'_unreferenced_definition_direct_calls']+=calls[symbol]
  if zero_only:summary[label+'_unused_or_zero_memory_only_definitions']+=1;summary[label+'_unused_or_zero_memory_only_direct_calls']+=calls[symbol]
  offset=d['tail_offset']-(1 if label=='failure' else 0)
  for category in ['zero_array','i8_slot_ambiguous','other_known_slot','not_direct_known_slot']:
   summary[label+'_call_argument_'+category]+=tails[(symbol,offset,category)]
 if not d['result_uses'].get('other',0) and not d['failure_uses'].get('other',0):
  summary['both_unused_or_zero_memory_only_definitions']+=1;summary['both_unused_or_zero_memory_only_direct_calls']+=calls[symbol]
 if 'collections/list.silk::' in d['name'] and d['name'].endswith('.append'):
  d['direct_calls']=calls[symbol];examples.append(d)
summary['zero_length_memory_intrinsics']=zero_memcopies
# Keep most frequently called recognition examples, even if old name map misses List wrappers.
most=sorted(definitions.items(),key=lambda x:-calls[x[0]])[:30]
a.output.write_text(json.dumps(dict(summary=summary,list_append_examples=examples,most_called=[dict(symbol=k,**v) for k,v in most],definitions=definitions,note='Shape recognition uses exact trailing noalias result pointer from current ordinary ABI. Not a zero-size layout proof. i8 call arguments remain ambiguous.'),indent=2)+'\n')
print(json.dumps(summary),flush=True)
