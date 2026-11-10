from pathlib import Path
import gzip,json,collections
ROOT=Path('/workspace/silk/.scratch/benchmarks/cache-work-v14-h12ixxhj')
class R:
 def __init__(self,b):self.b=b;self.at=0
 def w(self):
  assert self.at+8<=len(self.b);v=int.from_bytes(self.b[self.at:self.at+8],'big');self.at+=8;return v
 def f(self):
  n=self.w();assert n<=len(self.b)-self.at;v=self.b[self.at:self.at+n];self.at+=n;return v
names=['Presence','Implementations','Imports','VisibleNames','Identity','Member','Name','Selection','Declaration','Location','Prefix','Inherents','Resolution','Request']
facets={0:'Alive',1:'Identity',2:'Arm',3:'Import',4:'Header',5:'Binders',6:'Members',8:'Operations',9:'Parent',10:'Body',11:'Written',12:'Enclosed',13:'Directives'}
counts=collections.Counter();exports=collections.Counter();unique=collections.defaultdict(set);headeruses=collections.Counter();stamps=set();files=[]
for p in sorted(ROOT.glob('*.input-census.gz')):
 r=R(gzip.decompress(p.read_bytes()));assert r.f()==b'silk-input-census-v1';worker=r.w();stamp=r.f();stamps.add(stamp);roots=r.w();leaves=r.w();pending={r.w() for _ in range(r.w())};n=r.w();local=collections.Counter()
 for ordinal in range(n):
  authored=r.w();facet=r.w();key=r.f();digest=(r.w(),r.w());export=r.w()
  if ordinal not in pending:continue
  s=R(key);mod=(s.f(),s.f(),s.f());kind=s.w();name=names[kind];decl=None
  if kind==8:decl=s.f();code=s.w();name+='.'+facets[code]
  elif kind==9:decl=s.f()
  counts[name]+=1;exports[name]+=export;local[name]+=1;unique[name].add((key,digest))
  if kind==9 or (kind==8 and code in (3,11)):headeruses[(worker,mod,decl)]+=1
 assert r.at==len(r.b);files.append({'file':p.name,'worker':worker,'counts':dict(local)})
assert len(stamps)==1
out={'scope':'Existing V14 four-core source-input census only; counts are not timings and do not establish CPU0 savings.','kinds':[{'kind':k,'pending':counts[k],'exported':exports[k],'unique_exact_key_value':len(unique[k]),'cross_dump_repetition':counts[k]-len(unique[k])} for k in counts],'same_store_full_header_encoder_calls':sum(headeruses.values()),'same_store_unique_full_header_declarations':len(headeruses),'same_store_header_repetition_lower_bound':sum(headeruses.values())-len(headeruses),'notes':['Header call count includes Location, Declaration.Import and Declaration.Written only; Selection/name may add more.','Each worker counted independently; no cross-worker sharing assumed.','No timings or encoded fingerprint byte lengths were recorded in this census.'],'files':files}
(ROOT/'source-input-kind-summary.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({k:v for k,v in out.items() if k!='files'},indent=2))
