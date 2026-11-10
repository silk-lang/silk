"""Compare fixture source identities and addressable locations, ignoring machine PC/stack offsets."""
import collections,json,re,subprocess,sys
from pathlib import Path
root=Path(sys.argv[1]);dump=Path('/workspace/silk/.scratch/llvm-22.1.8/bin/llvm-dwarfdump')
def parse(path):
 text=subprocess.check_output([str(dump),'--debug-info',str(path)],text=True)
 path.with_name(path.name+'.dwarf-info.txt').write_text(text)
 entries=[];stack=[];current=None
 for line in text.splitlines():
  m=re.match(r'^0x[0-9a-f]+:( +)(DW_TAG_\w+|NULL)',line)
  if m:
   depth=(len(m[1])-1)//2
   while stack and stack[-1]['depth']>=depth:stack.pop()
   current=None
   if m[2]!='NULL':
    current={'depth':depth,'tag':m[2],'fields':{},'parents':list(stack)};entries.append(current);stack.append(current)
   continue
  if current:
   m=re.match(r'\s*DW_AT_(\w+)\s+\((.*)',line)
   if m:current['fields'][m[1]]=m[2]
 def quoted(value):
  q=re.findall(r'"([^\"]*)"',value);return q[-1] if q else value.rstrip(')')
 identities=[];missing=[];counts=collections.Counter()
 for entry in entries:
  f=entry['fields'];file=quoted(f.get('decl_file',''))
  if not file.endswith('/fixture/src/main.silk'):continue
  if entry['tag'] not in ('DW_TAG_variable','DW_TAG_formal_parameter'):continue
  counts[entry['tag']]+=1
  scope=[]
  for parent in entry['parents']:
   if parent['tag'] in ('DW_TAG_subprogram','DW_TAG_lexical_block'):
    pf=parent['fields'];scope.append((parent['tag'],quoted(pf.get('name','')),pf.get('decl_line',''),pf.get('decl_column','')))
  ops=tuple(re.findall(r'DW_OP_[A-Za-z0-9_]+',f.get('location','')))
  identity=(entry['tag'],quoted(f.get('name','')),quoted(f.get('type','')),file,f.get('decl_line',''),f.get('decl_column',''),tuple(scope),ops)
  identities.append(identity)
  if not ops:missing.append(identity)
 return collections.Counter(identities),dict(counts),missing
files=[root/'frontier-native-checkpoint-completed-v19-true',root/'frontier-native-work-v20-repaired-true']
before,bc,bm=parse(files[0]);after,ac,am=parse(files[1]);report={'baseline_counts':bc,'candidate_counts':ac,'identities_and_location_kinds_equal':before==after,'baseline_missing_locations':bm,'candidate_missing_locations':am,'removed':list((before-after).elements()),'added':list((after-before).elements()),'scope':'Only authored parameter fixture source; names, types, source positions, enclosing scope identity, and DW_OP location kinds. Absolute PCs and stack offsets excluded. DWARF verifier passed separately. Manual debugger writes are not tested.'}
(root/'parameter-dwarf-parity.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
assert bc and before==after and not bm and not am
