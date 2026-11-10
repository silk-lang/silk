import importlib.util,sys,re,json,time,collections
from pathlib import Path
spec=importlib.util.spec_from_file_location('parse','/workspace/silk/.scratch/parse-frontier-record.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
start=time.monotonic();fragments=[]
for image in map(Path,sys.argv[1:]):
 for ordinal,key,answer in p.records(image.read_bytes()):
  rec=p.record(answer,False,True);rec['where']=(str(image),ordinal);fragments.append(rec)
print('parsed',len(fragments),'fragments',time.monotonic()-start,flush=True)
union={};certs=collections.defaultdict(list)
def rank(e):return {0:2,1:2,2:1,3:0}[e['leaf']]
def refs(rec,e):return [(rec['entries'][index]['key'],edge) for index,edge in e['refs']]
for rec in fragments:
 for i,e in enumerate(rec['entries']):
  if e['leaf']==0 or (e['leaf']==3 and e['flags']&4096):certs[e['key']].append((rec,i))
  known=union.get(e['key'])
  if known:
   prior,old=known
   if (e['leaf']==1 and old['leaf'] not in (1,3)) or (old['leaf']==1 and e['leaf'] not in (1,3)):raise ValueError('foreign conflict')
   if e['leaf']==old['leaf']==0:
    assert e['summary']==old['summary'],('summary',rec['where'],i)
    assert refs(rec,e)==refs(prior,old),('references',rec['where'],i)
   if rank(e)>rank(old):union[e['key']]=(rec,e)
  else:union[e['key']]=(rec,e)
for key,(rec,e) in union.items():
 assert e['leaf']!=3,('unresolved external',key)
 e['next']=refs(rec,e)
print('union',len(union),'nodes',time.monotonic()-start,flush=True)
entries={key:e for key,(_,e) in union.items()};reasons=collections.Counter();cert_used=0

def certificate(key,parent,position,parents,positions):
 global cert_used
 for rec,candidate in certs[key]:
  current=key;up=parent;pos=position;known=candidate;first=True;good=True
  for _ in range(len(entries)+1):
   old=rec['entries'][known]
   if (old['leaf']!=0 and not(first and old['leaf']==3 and old['flags']&4096)) or old['alias']!=-1:reason='not full/admitted';good=False;break
   if old['key']!=current:reason='ancestry identity';good=False;break
   if old['flags']&512:reason='bounded restart';good=False;break
   if up is None or old['parent']==-1:
    if up is None and old['parent']==-1:cert_used+=1;return True
    reason='different root depth';good=False;break
   if old['parent']>=known or old['position']!=pos:reason='origin position';good=False;break
   actual=entries[up]['next'];prior=rec['entries'][old['parent']]['refs']
   if pos>=len(actual) or pos>=len(prior):reason='position bounds';good=False;break
   target,edge=prior[pos]
   if rec['entries'][target]['key']!=old['key'] or actual[pos][1]!=edge:reason='edge';good=False;break
   current=up;up=parents[current];pos=positions[current];known=old['parent'];first=False
  if not good:reasons[reason]+=1
 return False

def spelling(e):return [v.decode() for v in re.findall(rb'[ -~]{3,}',e['decl'])]
def samefamily(a,b):return a['flags']&24576!=24576 or b['flags']&24576!=24576 or a['family_sig']==b['family_sig']
groups=set();visits=0;admitted=True
for groupno,rec in enumerate(fragments):
 roots=tuple(rec['roots'])
 if roots in groups:continue
 groups.add(roots);pending=[(key,None,i,False) for i,key in enumerate(roots)];visited=set();frames=[];parents={};positions={}
 while pending:
  key,parent,position,leave=pending.pop();visits+=1
  if leave:frames.pop();continue
  e=entries[key]
  if e['leaf'] in (1,2):continue
  assert e['flags']&1
  application=e['flags']&2
  if application:
   for ancestor in reversed(frames):
    a=entries[ancestor]
    if a['body']==e['body'] and samefamily(a,e):
     if ancestor!=key and not certificate(key,parent,position,parents,positions):
      print(json.dumps(dict(failure='argument comparison',group=groupno,source=rec['where'],entry=spelling(e),ancestor=spelling(a),certificates=len(certs[key]),reasons=dict(reasons),flags=e['flags'],ancestorFlags=a['flags']),sort_keys=True),flush=True)
      print('active frames',[(spelling(entries[k]),entries[k]['flags']) for k in frames[-12:]],flush=True)
      admitted=False
     break
    if a['flags']&4:break
  if not admitted:break
  if key in visited:continue
  visited.add(key);parents[key]=parent;positions[key]=position
  if application:frames.append(key);pending.append((key,None,0,True))
  for pos,(child,edge) in reversed(list(enumerate(e['next']))):pending.append((child,key,pos,False))
 if not admitted:break
print('admission',admitted,'groups',len(groups),'visits',visits,'cert_used',cert_used,'seconds',time.monotonic()-start,flush=True)
