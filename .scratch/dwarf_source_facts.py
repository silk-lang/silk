"""Source identity inventory from llvm-dwarfdump; excludes PCs and physical storage locations."""
import collections,json,re,subprocess

def facts(text):
 records=[];stack=[];current=None
 for line in text.splitlines():
  match=re.match(r'^0x[0-9a-f]+:(\s+)(DW_TAG_\w+)',line)
  if match:
   depth=len(match[1]);tag=match[2]
   while stack and stack[-1]['depth']>=depth:stack.pop()
   current={'depth':depth,'tag':tag,'parent':stack[-1] if stack else None,'attributes':{}}
   records.append(current);stack.append(current)
  elif current:
   m=re.search(r'\b(DW_AT_\w+)\s+\((.*)',line)
   if m:
    value=m[2];quoted=re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"',value)
    if quoted:value=quoted[-1]
    elif m[1] in ['DW_AT_decl_line','DW_AT_decl_column']:value=value.strip(')')
    elif m[1]=='DW_AT_location':value='present'
    else:continue
    current['attributes'][m[1]]=value
 out=collections.Counter()
 for r in records:
  if r['tag'] not in ['DW_TAG_variable','DW_TAG_formal_parameter']:continue
  a=r['attributes'];parent=r['parent'];scopes=[]
  while parent:
   if parent['tag'] in ['DW_TAG_subprogram','DW_TAG_inlined_subroutine']:
    pa=parent['attributes'];scopes.append((parent['tag'],pa.get('DW_AT_name'),pa.get('DW_AT_decl_file'),pa.get('DW_AT_decl_line')))
   parent=parent['parent']
  if not a.get('DW_AT_name'):continue
  key=(tuple(reversed(scopes)),r['tag'],a.get('DW_AT_name'),a.get('DW_AT_decl_file'),a.get('DW_AT_decl_line'),a.get('DW_AT_decl_column'),a.get('DW_AT_type'),a.get('DW_AT_location'))
  out[key]+=1
 return out

def compare(left,right):
 a=facts(left);b=facts(right)
 return {'baseline_entries':sum(a.values()),'candidate_entries':sum(b.values()),'lost':[{'identity':k,'count':v} for k,v in (a-b).items()],'gained':[{'identity':k,'count':v} for k,v in (b-a).items()]}
if __name__=='__main__':
 import sys
 from pathlib import Path
 print(json.dumps(compare(Path(sys.argv[1]).read_text(),Path(sys.argv[2]).read_text()),indent=2))
