from pathlib import Path
import gzip,re,json
root=Path('/workspace/silk/.scratch/benchmarks/scalar-ssa-ir-sk7c1swx');names={}
for line in (root/'compiler-candidate.ll.symbols').read_text().splitlines():
 parts=line.split('\t')
 if len(parts)>=3:
  desc=parts[2]
  if 'shared.silk::.withMut' in desc: names[parts[0]]='shared_with_mut'
  elif 'collections/list.silk::.get' in desc:names[parts[0]]='list_get'
  elif 'num/i32.silk::' in desc and ('add' in desc or 'to' in desc):names[parts[0]]='numeric_wrapper'
found={};lines=None;name=None;category=None
with gzip.open(root/'compiler-candidate.ll.gz','rt') as source:
 for line in source:
  if line.startswith('define '):
   m=re.search(r'@([^ (]+)\(',line);name=m[1] if m else None;category=names.get(name);lines=[line] if category and category not in found else None
  elif lines is not None:
   lines.append(line)
   if line.strip()=='}':
    if len(lines)<500:
     (root/(category+'.ll')).write_text(''.join(lines));found[category]={'symbol':name,'lines':len(lines)}
    lines=None
    if len(found)==3:break
print(json.dumps(found,indent=2))
