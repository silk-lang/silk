"""Conservative streaming IR-only candidates, not MIR-kind/dominance or debug-editability proof."""
import re
TOKEN=r'%[-a-zA-Z$._0-9]+'
class ParameterSpills:
 def __init__(self,arguments):
  self.arguments=set()
  for argument in arguments:
   names=re.findall(TOKEN,argument)
   if names:self.arguments.add(names[-1])
  self.slots={}
 def line(self,line):
  # The census intentionally excludes volatile/atomic accesses and every address use except
  # LLVM debug records. Lifetime markers are also excluded rather than assumed harmless.
  made=re.match(r'\s*('+TOKEN+r') = alloca ([^,]+)',line)
  if made:
   ty=made[2].strip()
   if re.fullmatch(r'i[1-9][0-9]*|ptr|half|bfloat|float|double',ty):
    self.slots[made[1]]=dict(type=ty,stores=0,argument_store=False,loads=0,other=0)
   return
  names=set(re.findall(TOKEN,line));mentioned=names&self.slots.keys()
  if not mentioned:return
  stripped=line.strip()
  if stripped.startswith('#dbg_') or re.search(r'\bcall void @llvm\.dbg\.',line):return
  loaded=re.match(r'\s*'+TOKEN+r' = load (?!atomic\b|volatile\b)[^,]+, ptr ('+TOKEN+r')(?:,|\s*$)',line)
  stored=re.match(r'\s*store (?!atomic\b|volatile\b)([^,]+), ptr ('+TOKEN+r')(?:,|\s*$)',line)
  allowed=None
  if loaded and loaded[1] in self.slots:
   allowed=loaded[1];self.slots[allowed]['loads']+=1
  elif stored and stored[2] in self.slots:
   allowed=stored[2];slot=self.slots[allowed];slot['stores']+=1
   words=stored[1].split();slot['argument_store']=slot['stores']==1 and words[-1] in self.arguments
  for name in mentioned:
   if name!=allowed:self.slots[name]['other']+=1
 def finish(self):
  eligible=[dict(slot=name,**slot) for name,slot in self.slots.items() if slot['stores']==1 and slot['argument_store'] and slot['other']==0]
  return dict(argument_spill_slots=len(eligible),argument_spill_loads=sum(x['loads'] for x in eligible),argument_spill_details=eligible)
