"""Read captured bitcode only; stream llvm-dis, keep no full textual IR.
Syntactic lower bounds, not an escape/dominance or ABI-change proof.
"""
from pathlib import Path
import argparse,collections,hashlib,json,re,subprocess
p=argparse.ArgumentParser();p.add_argument('capture',type=Path);p.add_argument('output',type=Path);a=p.parse_args()
inputs={}
for f in (a.capture/'commands').glob('*.json'):
 r=json.loads(f.read_text())
 if '-c' in r['argv']:
  for i in r['inputs']:
   if i['bitcode']:inputs[i['sha256']]=i
summary=collections.Counter();examples=[];function=None;slots={};callvalues=set();debug=set();address=set();resultslots=set();call_returns=collections.Counter();definition_returns=collections.Counter();slot_types={};mentions=collections.Counter();slot_type_counts=collections.Counter()
def finish():
 global function,slots,callvalues,debug,address,resultslots,slot_types,mentions
 if function is None:return
 summary['definitions']+=1;summary['allocas']+=len(slots)
 unused={k for k in slots if mentions[k]==0}
 summary['unused_allocas_no_body_or_debug_mention']+=len(unused)
 summary['unused_scalar_allocas']+=sum(slots[k] for k in unused)
 summary['unused_i8_allocas']+=sum(slot_types[k].startswith('i8,') for k in unused)
 summary['zero_byte_array_allocas']+=sum(slot_types[k].startswith('[0 x i8]') for k in slots)
 summary['unused_zero_byte_array_allocas']+=sum(slot_types[k].startswith('[0 x i8]') for k in unused)
 for k in slots:slot_type_counts[slot_types[k].split(', align')[0]]+=1
 scalar={k for k,v in slots.items() if v}
 summary['scalar_single_element_allocas']+=len(scalar)
 summary['scalar_debug_declared']+=len(scalar&debug)
 summary['scalar_passed_by_address_directly_to_call']+=len(scalar&address)
 summary['scalar_debug_or_direct_call_address']+=len(scalar&(debug|address))
 summary['scalar_receives_direct_call_result']+=len(scalar&resultslots)
 candidate=scalar&resultslots-debug-address
 summary['scalar_call_result_without_debug_or_direct_call_address']+=len(candidate)
 if candidate and len(examples)<30:examples.append(dict(function=function,slots=sorted(candidate),signature=signature))
 function=None
for item in inputs.values():
 child=subprocess.Popen(['/workspace/silk/.scratch/llvm-22.1.8/bin/llvm-dis',item['saved'],'-o','-'],stdout=subprocess.PIPE,text=True)
 for line in child.stdout:
  if line.startswith('define '):
   finish();signature=line.strip();m=re.search(r'@([^ (]+)\(',line);function=m[1];slots={};callvalues=set();debug=set();address=set();resultslots=set();slot_types={};mentions=collections.Counter()
   definition_returns[line.split('@',1)[0].split()[-1]]+=1
   continue
  if function is None:continue
  if line.startswith('}'):
   finish();continue
  m=re.match(r'\s*(%[\w.]+) = alloca (.*)',line)
  if m:
   slot_types[m[1]]=m[2].strip()
   slots[m[1]]=bool(re.match(r'(?:ptr|i\d+|float|double|half), align ',m[2]));continue
  mentions.update(re.findall(r'%[\w.]+',line))
  if '#dbg_declare' in line or '@llvm.dbg.declare' in line:
   debug.update(x for x in re.findall(r'ptr (%[\w.]+)',line) if x in slots)
  if re.search(r'\bcall\b',line) and not '@llvm.dbg.' in line:
   address.update(x for x in re.findall(r'ptr(?: [a-z]+(?:\([^)]*\))?)* (%[\w.]+)',line) if x in slots)
   m=re.match(r'\s*(%[\w.]+) = (?:tail |musttail )?call (.*?) [@%][^ (]+\(',line)
   if m:
    ty=m[2].split()[-1];call_returns[ty]+=1
    if re.fullmatch(r'(?:ptr|i\d+|float|double|half)',ty):callvalues.add(m[1])
   elif re.search(r'\bcall void ',line):call_returns['void']+=1
  m=re.match(r'\s*(%[\w.]+) = (?:trunc|zext|sext|bitcast) \S+ (%[\w.]+) to ',line)
  if m and m[2] in callvalues:callvalues.add(m[1])
  m=re.match(r'\s*store \S+ (%[\w.]+), ptr (%[\w.]+)',line)
  if m and m[1] in callvalues and m[2] in slots:resultslots.add(m[2])
 assert child.wait()==0,item['saved']
finish()
a.output.write_text(json.dumps(dict(pack_count=len(inputs),summary=summary,slot_type_counts=slot_type_counts,definition_returns=definition_returns,call_returns=call_returns,examples=examples,note='Emitted definitions and slots, including repeated internal helpers. Syntactic direct-address uses only; not a promotability proof. i1 includes both bool values and fallible status.'),indent=2)+'\n')
print(json.dumps(summary),flush=True)
