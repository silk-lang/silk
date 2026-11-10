import importlib.util,json,collections,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('reader','/workspace/silk/.scratch/cpu-sampling/producer-cache-symbols.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);R=m.Reader
path=Path(sys.argv[1]);r=R(path.read_bytes());assert r.chunk()==b'silk-semantic-cache';assert r.var()==12;stamp=r.chunk();r.take(16);count=r.count();prior=b'';selected={};records=[];totals=collections.Counter();conflicts=0
for _ in range(count):
 prefix=r.var();key=r.packed(prior,prefix);prior=key;r.var();k=R(key)
 try:tag=k.field()
 except ValueError:tag=b''
 ans=r.packed(keep=tag==b'silk.escape.record')
 if ans is None:continue
 a=R(ans);assert a.field()==b'silk.escape.answer.v1';kind=a.word()
 if kind!=0:totals['view']+=1;continue
 rec=R(a.field());a.done();assert rec.word()==12
 mode=rec.var();patterns=rec.var();roots=[rec.take(16) for i in range(rec.count())];edges=[rec.take(16) for i in range(rec.count())];n=rec.count();entries=[];previous=b''
 for i in range(n):
  exact=rec.take(16);rec.word();rec.var();prefix=rec.var();decl=previous[:prefix]+rec.chunk();previous=decl
  parent,position,requested,alias,leaf=[rec.var() for x in range(5)];refs=[(rec.var(),rec.var()) for x in range(rec.count())];summary=rec.take(16);flags=rec.var()
  if flags&1:
   definition=rec.take(16)
   if flags&64:rec.take(16)
   if flags&16777216:rec.var()
   for x in range(rec.count()):
    rec.var()
    for y in range(rec.count()):rec.take(32)
    for y in range(rec.count()):rec.chunk()
   if flags&256:
    for x in range(rec.count()):rec.take(16)
   if flags&1024:
    for x in range(rec.count()):rec.var()
  entries.append((exact,leaf,flags,alias,summary,refs,decl))
 rec.done();totals['records']+=1;totals['rows']+=n;totals['bytes']+=len(ans)
 if mode or patterns:totals['ineligible_mode']+=1;continue
 records.append((roots,entries,len(ans)))
 for exact,leaf,flags,alias,summary,refs,decl in entries:
  totals['leaf_'+str(leaf)]+=1;totals['aliases']+=bool(alias)
  normalized=(leaf,flags,alias,summary,tuple((entries[x][0],edges[e]) for x,e in refs),decl)
  old=selected.get(exact)
  if old and old[0]==0 and leaf==0 and old[3:5]!=normalized[3:5]:conflicts+=1
  if old is None or (old[0] in (2,3) and leaf in (0,1)):selected[exact]=normalized
required=1+16777216+33554432
out=dict(totals=totals,unique_rows=len(selected),unique_leaf_counts=dict(collections.Counter(x[0] for x in selected.values())),duplicate_definition_conflicts=conflicts,unknown_required_facts=sum((x[1]&required)!=required for x in selected.values()),not_closed=sum(bool(x[1]&2 and not x[1]&8388608) for x in selected.values()),full_without_summary=sum(x[0]==0 and not(x[1]&128) for x in selected.values()),unresolved_roots=sum(root not in selected for roots,es,size in records for root in roots))
print(json.dumps(out,indent=2))

parents=collections.defaultdict(list)
for key,entry in selected.items():
 for child,edge in entry[4]:parents[child].append(key)
bad={key for key,entry in selected.items() if entry[0] not in (0,1)};pending=list(bad)
while pending:
 child=pending.pop()
 for parent in parents[child]:
  if parent not in bad:bad.add(parent);pending.append(parent)
valid=[(roots,es,size) for roots,es,size in records if all(root not in bad for root in roots)]
print(json.dumps(dict(closed_records=len(valid),closed_original_rows=sum(len(es) for roots,es,size in valid),closed_original_bytes=sum(size for roots,es,size in valid),unresolved_tainted_nodes=len(bad),untainted_unique_nodes=len(selected)-len(bad)),indent=2))
