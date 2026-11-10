"""Bounded-memory IR census over captured bitcode; never retains the full textual module."""
import argparse,collections,gzip,json,re,subprocess
from pathlib import Path
from parameter_spill_census import ParameterSpills
p=argparse.ArgumentParser();p.add_argument('capture',type=Path);p.add_argument('output',type=Path);a=p.parse_args()
files={}
for f in (a.capture/'commands').glob('*.json'):
 r=json.loads(f.read_text());argv=r['argv']
 if '-c' in argv and '-x' in argv and argv[argv.index('-x')+1]=='ir':
  for v in r['inputs']:
   if v['bitcode']:files[v['sha256']]=v['saved']
assert files,'No captured native bitcode'
def split_args(text):
 parts=[];start=depth=0
 for i,c in enumerate(text):
  if c in '([{<':depth+=1
  elif c in ')]}>':depth-=1
  elif c==',' and depth==0:parts.append(text[start:i].strip());start=i+1
 if text.strip():parts.append(text[start:].strip())
 return parts
summary=collections.Counter();definitions={};function=None

def finish():
 global function
 if function is None:return
 function.update(function.pop('_parameter_spills').finish())
 key=function.pop('symbol');summary['definitions']+=1
 for k in ['parameters','allocas','loads','stores','calls','zero_length_memory_intrinsics','ir_text_bytes','argument_spill_slots','argument_spill_loads']:summary['function_'+k]+=function.get(k,0)
 if key.startswith('silk_') and re.fullmatch(r'silk_[0-9a-f]+(?:\$[\w.]+)?',key):
  if key in definitions:
   for field in ['parameters','allocas','loads','stores','calls','zero_length_memory_intrinsics','alloca_types','callees']:
    assert definitions[key].get(field,0)==function.get(field,0),('different duplicate definition',key,field)
   summary['duplicate_internal_definitions']+=1
  definitions[key]=function
 function=None
for path in files.values():
 summary['bitcode_bytes']+=Path(path).stat().st_size
 child=subprocess.Popen(['/workspace/silk/.scratch/llvm-22.1.8/bin/llvm-dis',path,'-o','-'],stdout=subprocess.PIPE,text=True)
 for line in child.stdout:
  summary['ir_text_bytes']+=len(line.encode())
  if line.startswith('define '):
   finish();m=re.search(r'@([^ (]+)\((.*)\)',line);assert m,line
   parameters=split_args(m[2]);function={'symbol':m[1],'signature':line.strip(),'parameters':len(parameters),'alloca_types':collections.Counter(),'callees':collections.Counter(),'ir_text_bytes':len(line.encode()),'_parameter_spills':ParameterSpills(parameters)}
   continue
  if function is None:continue
  function['ir_text_bytes']+=len(line.encode())
  function['_parameter_spills'].line(line)
  if line.startswith('}'):finish();continue
  m=re.match(r'\s*%[\w.]+ = alloca (.*)',line) if ' = alloca ' in line else None
  if m:
   function['allocas']=function.get('allocas',0)+1;function['alloca_types'][m[1].split(', align')[0].strip()]+=1
  for k,hit in [('loads',' = load ' in line),('stores',line.lstrip().startswith('store ')),('calls',' call ' in line)]:
   if hit:function[k]=function.get(k,0)+1
  if '@llvm.mem' in line and 'i64 0, i1 false' in line:function['zero_length_memory_intrinsics']=function.get('zero_length_memory_intrinsics',0)+1
  m=re.search(r'\bcall .*?@(silk_[0-9a-f]+(?:\$[\w.]+)?)\((.*)\)',line) if ' call ' in line and '@silk_' in line else None
  if m:function['callees'][m[1]]+=1
 assert child.wait()==0,path
finish();summary['bitcode_packs']=len(files);summary['unique_internal_definitions']=len(definitions)
with gzip.open(str(a.output)+'.functions.json.gz','wt') as f:json.dump(definitions,f,separators=(',',':'))
a.output.write_text(json.dumps({'summary':summary,'function_details':str(a.output)+'.functions.json.gz','capture':str(a.capture),'note':'Actual emitted declarations/instructions and native input volume; static counts, not CPU attribution. Combined alloca delta is not by itself the number of eliminated MIR Temp slots.'},indent=2)+'\n')
print(json.dumps(summary),flush=True)
