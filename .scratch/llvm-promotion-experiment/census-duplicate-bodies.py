"""Conservative exact internal-body census. Source preparation only until a slot is granted.
One llvm-dis stream per pack; stores hashes/counters, not whole modules or function bodies.
Own symbol and debug records are normalized. ABI/attributes/other symbols/constants stay exact.
Module-local dependencies and unresolved metadata conservatively restrict comparisons to one pack.
"""
import argparse,collections,hashlib,json,re,subprocess
from pathlib import Path
SYMBOL=re.compile(r'@(?:"(?:[^"\\]|\\.)*"|[-a-zA-Z$._0-9]+)')
INTERNAL=re.compile(r'@silk_[0-9a-f]+(?:\$[\w.]+)?\Z')
ATTR=re.compile(r'#(\d+)\b')
DBG=re.compile(r'(?:,)?[ \t]+!(?:dbg|DIAssignID) !\d+')
META=re.compile(r'(?<![A-Za-z0-9_])!\d+\b')
DIRECT=re.compile(r'\b(?:call|invoke|callbr)\b[^@\n]*(@(?:"(?:[^"\\]|\\.)*"|[-a-zA-Z$._0-9]+))\s*\(')
LABEL=re.compile(r'^[-a-zA-Z$._0-9]+:\s*(?:;.*)?$')

QUOTED=re.compile(r'"(?:[^"\\]|\\.)*"')

def outside_strings(line,transform):
 out=[];start=0
 for match in QUOTED.finditer(line):
  out.append(transform(line[start:match.start()]));out.append(match[0]);start=match.end()
 out.append(transform(line[start:]));return ''.join(out)

def syntax(line):
 # Preserve quoted LLVM identifiers while hiding literal strings from token scans.
 return QUOTED.sub(lambda m:m[0] if m.start()>0 and line[m.start()-1] in '@%' else ' '*len(m[0]),line)

def normalize(line,own):
 scanned=syntax(line)
 if scanned.lstrip().startswith('#dbg_') or re.search(r'\bcall\b.*@llvm\.dbg\.',scanned):return None
 return outside_strings(line,lambda text:SYMBOL.sub(lambda m:'@SELF' if m[0]==own else m[0],DBG.sub('',text)))

def module_flag_facts(lines,nodes,module_hash):
 facts=[];restricted=False
 def expand(value,seen):
  nonlocal restricted
  def replace(m):
   nonlocal restricted
   n=m[0][1:]
   if n in seen or n not in nodes:restricted=True;return 'UNRESOLVED('+module_hash+':'+n+')'
   return '('+expand(nodes[n],seen|{n})+')'
  return outside_strings(value,lambda text:META.sub(replace,text))
 for line in lines:
  for ref in META.findall(line):
   raw=nodes.get(ref[1:],'')
   # These flags describe debug encoding, not executable function semantics.
   if re.search(r'!"(?:Dwarf Version|Debug Info Version|CodeView|CodeViewGHash|Split DWARF File)"',raw):continue
   facts.append(expand(ref,set()))
 return facts,restricted

def jsonhash(x):return hashlib.sha256(json.dumps(x,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()

def main():
 p=argparse.ArgumentParser();p.add_argument('capture',type=Path);p.add_argument('output',type=Path);a=p.parse_args()
 files={}
 for path in (a.capture/'commands').glob('*.json'):
  record=json.loads(path.read_text());argv=record['argv']
  if '-c' in argv and '-x' in argv and argv[argv.index('-x')+1]=='ir':
   for x in record['inputs']:
    if x['bitcode']:files[x['sha256']]=x['saved']
 assert files,'No captured bitcode packs'
 # Every non-direct-call reference counts as address-observed, including aliases and llvm.used.
 observed=collections.Counter();direct_calls=collections.Counter();functions=[];warnings=[];totals=collections.Counter()
 for module_hash,path in sorted(files.items()):
  attributes={};globals_local=set();named_types=False;module_flags=[];triple='';layout='';pending=[];metadata={};function=None
  child=subprocess.Popen(['/workspace/silk/.scratch/llvm-22.1.8/bin/llvm-dis',path,'-o','-'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  def finish():
   nonlocal function
   if function is not None:
    function['body_hash']=function.pop('hasher').hexdigest();pending.append(function);function=None
  for line in child.stdout:
   scanned=syntax(line)
   if line.startswith('target triple ='):triple=line.strip()
   if line.startswith('target datalayout ='):layout=line.strip()
   if re.match(r'^%\S+ = type\b',line):named_types=True
   if line.startswith('attributes #'):
    m=re.match(r'attributes #(\d+) = (.*)',line);attributes[m[1]]=m[2].rstrip();continue
   if line.startswith('!'):
    if line.startswith('!llvm.module.flags'):module_flags.append(line.strip())
    m=re.match(r'!(\d+) = (.*)',line)
    if m:metadata[m[1]]=m[2].strip()
    continue
   definition=line.startswith('define ');declaration=line.startswith('declare ')
   if definition:
    finish();m=SYMBOL.search(line);assert m,line;own=m[0]
    dbg=re.search(r'!dbg !(\d+)',line)
    function={'symbol':own,'module':module_hash,'hasher':hashlib.sha256(),'attribute_ids':[],'references':set(),'nondebug_metadata':False,'instructions':0,'normalized_bytes':0,'debug_records_removed':0,'debug_root':dbg[1] if dbg else None,'linkage':'local' if re.search(r'\b(?:internal|private)\b',line[:m.start()]) else 'external','header':line.strip()}
   if function is not None and normalize(line,function['symbol']) is None:
    function['debug_records_removed']+=1;continue
   # Ignore declarations/definition symbol itself; record every remaining symbol use.
   symbols=SYMBOL.findall(scanned);callee=DIRECT.search(scanned) if not (definition or declaration) else None
   header_symbol=symbols[0] if (definition or declaration) and symbols else None
   skipped_definition=False;skipped_call=False
   if line.startswith('@') and re.search(r'=\s*(?:private|internal)\b',line):
    if symbols:globals_local.add(symbols[0])
   for symbol in symbols:
    if not INTERNAL.fullmatch(symbol):continue
    if header_symbol==symbol and not skipped_definition:
     skipped_definition=True;continue
    if callee and symbol==callee[1] and not skipped_call:
     direct_calls[symbol]+=1;skipped_call=True
    else:observed[symbol]+=1
   if function is None:continue
   normalized=normalize(line,function['symbol'])
   if normalized is None:function['debug_records_removed']+=1;continue
   function['references'].update(x for x in SYMBOL.findall(syntax(normalized)) if x!='@SELF')
   if META.search(syntax(normalized)):function['nondebug_metadata']=True
   outside_strings(normalized,lambda text:function['attribute_ids'].extend(ATTR.findall(text)) or text)
   normalized=outside_strings(normalized,lambda text:ATTR.sub('#ATTRIBUTE',text))
   data=normalized.encode();function['hasher'].update(data);function['normalized_bytes']+=len(data)
   text=normalized.strip()
   assigned=text.startswith('%') and '=' in text
   standalone=bool(re.match(r'^(?:(?:tail|musttail|notail) )?(?:store|br|ret|switch|unreachable|call|invoke|resume|indirectbr|callbr|fence|catchret|cleanupret)\b',text))
   if not definition and (assigned or standalone):function['instructions']+=1
   if line.startswith('}'):finish()
  finish();stderr=child.stderr.read();assert child.wait()==0,(path,stderr)
  if stderr:warnings.append({'module':module_hash,'stderr':stderr})
  flag_facts,flags_unresolved=module_flag_facts(module_flags,metadata,module_hash)
  for f in pending:
   if not INTERNAL.fullmatch(f['symbol']):continue
   restrictions=[]
   if named_types:restrictions.append('module_named_types')
   if f['nondebug_metadata']:restrictions.append('unresolved_nondebug_metadata')
   if f['references']&globals_local:restrictions.append('module_private_global')
   if any(re.fullmatch(r'@\d+',x) for x in f['references']):restrictions.append('unnamed_global')
   missing=[x for x in f['attribute_ids'] if x not in attributes]
   if missing:restrictions.append('unresolved_attribute_group')
   # Module flags can alter semantics (e.g. target/ABI features). Preserve module context unless absent.
   if flags_unresolved:restrictions.append('unresolved_module_flags')
   attrs=[attributes.get(x,'UNRESOLVED:'+x) for x in f.pop('attribute_ids')]
   f['fingerprint']=jsonhash([f['body_hash'],attrs,triple,layout,flag_facts,module_hash if restrictions else None])
   f['module_local_constraints']=restrictions;f['attribute_groups']=attrs;f['references']=sorted(f['references'])
   root=f.pop('debug_root');f['debug_subprogram']=metadata.get(root) if root is not None else None
   # Full debug variable/type graphs have NOT been proved equivalent; grouping is code-only.
   f['debug_identity_verified']=False
   totals['functions']+=1;totals['instructions']+=f['instructions'];totals['normalized_bytes']+=f['normalized_bytes'];functions.append(f)
 # Identical symbol copies are pack duplication, not redundant type specializations.
 unique={};same_symbol_copies=0
 for f in functions:
  if f['symbol'] in unique:same_symbol_copies+=1;continue
  unique[f['symbol']]=f
 groups=collections.defaultdict(list)
 for f in unique.values():
  f['address_observed']=observed[f['symbol']]>0;f['nondirect_reference_sites']=observed[f['symbol']];f['direct_call_sites']=direct_calls[f['symbol']];groups[f['fingerprint']].append(f)
 candidates=[];shares=collections.Counter();whole_instructions=sum(x['instructions'] for x in unique.values());whole_bytes=sum(x['normalized_bytes'] for x in unique.values())
 for digest,items in groups.items():
  if len(items)<2:continue
  items.sort(key=lambda x:x['symbol']);base=items[0];extra=len(items)-1
  noaddr=[x for x in items if not x['address_observed']];direct_extra=max(0,len(noaddr)-1)
  shares['duplicate_groups']+=1;shares['candidate_functions']+=len(items);shares['redundant_definitions']+=extra
  shares['redundant_instructions']+=extra*base['instructions'];shares['redundant_normalized_bytes']+=extra*base['normalized_bytes']
  shares['redundant_no_observed_address_definitions']+=direct_extra;shares['redundant_no_observed_address_instructions']+=direct_extra*base['instructions']
  candidates.append({'fingerprint':digest,'count':len(items),'redundant_instructions':extra*base['instructions'],'redundant_bytes':extra*base['normalized_bytes'],'no_observed_address_members':len(noaddr),'members':items})
 candidates.sort(key=lambda x:(-x['redundant_instructions'],-x['redundant_bytes'],x['fingerprint']))
 summary={**shares,'unique_internal_functions':len(unique),'unique_internal_instructions':whole_instructions,'unique_internal_normalized_bytes':whole_bytes,'repeated_same_symbol_copies':same_symbol_copies,'instruction_share':shares['redundant_instructions']/whole_instructions if whole_instructions else 0,'byte_share':shares['redundant_normalized_bytes']/whole_bytes if whole_bytes else 0,'no_observed_address_instruction_share':shares['redundant_no_observed_address_instructions']/whole_instructions if whole_instructions else 0}
 result={'capture':str(a.capture),'summary':summary,'warnings':warnings,'groups':candidates,'limitations':['Exact SSA names, other callee identities and private-constant names are preserved, so equivalent bodies can be missed.','Non-debug metadata, named types, unresolved module flags and private globals restrict matching to the same pack. Semantic module flags are otherwise retained structurally; debug-encoding flags are ignored.','Hash-shaped symbols are a compiler-internal naming heuristic, not proof that a symbol lacks a foreign export contract. External linkage remains explicit.','No-address-observed means none in captured LLVM inputs; external native objects, module assembly, dynamic lookup and foreign export contracts are not analyzed.','Debug metadata is ignored for code equivalence but full source debug identities are NOT proved shareable. Candidate totals are upper bounds on code-sharing opportunity, never safe-merger counts.']}
 a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(summary),flush=True)

if __name__=='__main__':main()
