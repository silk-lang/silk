import sys,json
from pathlib import Path
class Cursor:
 def __init__(self,data):self.data=data;self.at=0;self.entry=None
 def take(self,n):
  assert self.at+n<=len(self.data),(self.at,n,len(self.data))
  v=self.data[self.at:self.at+n];self.at+=n;return v
 def var(self):
  v=0;s=0
  while True:
   b=self.take(1)[0];v|=(b&127)<<s
   if b<128:return v
   s+=7;assert s<=63
 def count(self,what='count'):
  at=self.at;v=self.var()
  assert v<=len(self.data)-self.at,dict(reason=what,entry=self.entry,offset=at,value=v,remaining=len(self.data)-self.at)
  return v
 def word(self):return int.from_bytes(self.take(8),'big')
 def digest(self):return self.take(16).hex()
 def packed(self):
  length=self.var();written=self.var();end=self.at+written;out=bytearray()
  while self.at<end:
   b=self.take(1)[0]
   if b==0:out.extend(bytes(self.take(1)[0]+1))
   else:out.append(b)
  assert len(out)==length;return bytes(out)
 def chunk(self):return self.take(self.var())
 def header(self):assert self.chunk()==b'silk-semantic-cache';assert self.var()==10;stamp=self.chunk();self.take(16);return stamp

def records(data):
 c=Cursor(data);c.header();leaves=c.var();c.take(c.var());c.take(c.var());c.take(c.var());c.header();n=c.var();prior=b''
 for i in range(n):
  shared=c.var();key=prior[:shared]+c.packed();prior=key;node=c.var();answer=c.packed()
  if b'silk.escape.record' in key:yield i,key,answer
 assert c.at==len(data)

def record(data,strict=True,full=False):
 c=Cursor(data);fmt=c.word();assert fmt==10,fmt
 observed=c.var();patterned=c.var();roots=[c.digest() for _ in range(c.count())];edges=[c.digest() for _ in range(c.count())];total=c.count();previous=b'';items=[]
 for i in range(total):
  c.entry=i;keyexact=c.digest();h=c.word();family=c.var();common=c.var();decl=previous[:common]+c.take(c.count());previous=decl
  parent=c.var()-1;position=c.var()-1;requested=c.var();alias=c.var()-1;leaf=c.var();refs=[]
  assert parent<i and alias<i,dict(reason='parent/alias',i=i,parent=parent,alias=alias)
  assert not(requested==1 and parent<0),dict(reason='requestedroot',i=i)
  assert leaf<=3,dict(reason='leaf',i=i,leaf=leaf)
  for r in range(c.count()):
   target=c.var();edge=c.var();assert target<total and edge<len(edges);refs.append((target,edges[edge]))
  summary=c.digest();flags=c.var();calls=[];definition=None;bare=None;body=0;family_sig=None;callbacks=[];application=None;witnesses=[];key_bytes=None
  if flags&1:
   definition=c.digest()
   if flags&64:bare=c.digest()
   if flags&2:body=c.word()
   if flags&8192:family_sig=c.digest()
   if flags&4194304:application=c.digest()
   if flags&16777216:key_bytes=c.var()
   for obligation in range(c.count()):
    exact=c.var();assert exact<=1
    for callee in range(c.count()):c.take(32)
    for declaration in range(c.count()):c.take(c.count())
   if flags&256:
    for callback in range(c.count()):callbacks.append(c.digest())
   if flags&1024:
    for callee in range(c.count()):calls.append(c.count('callee-index-byte-bound') if strict else c.var())
   if flags&2097152:
    for witness in range(c.count()):witnesses.append(c.var())
  assert all(x<len(refs) for x in calls),dict(reason='callee-ref-bounds',i=i,refs=len(refs),calls=calls)
  items.append(dict(key=keyexact,hash=h,family=family,decl=decl,parent=parent,position=position,requested=requested,alias=alias,leaf=leaf,refs=refs,summary=summary,flags=flags,definition=definition,bare=bare,body=body,family_sig=family_sig,callbacks=callbacks,calls=calls,application=application,witnesses=witnesses,key_bytes=key_bytes))
 assert c.at==len(data),(c.at,len(data))
 if full:return dict(entries=items,roots=roots,bytes=len(data))
 return dict(entries=total,roots=len(roots),bytes=len(data))

if __name__=='__main__':
 
 for path in map(Path,sys.argv[1:]):
  print('image',path)
  for ordinal,key,answer in records(path.read_bytes()):
   try:record(answer)
   except AssertionError as e:
    name=path.with_name(path.stem+'-record-'+str(ordinal))
    name.with_suffix('.record').write_bytes(answer);name.with_suffix('.key').write_bytes(key)
    print(json.dumps(dict(ordinal=ordinal,failure=str(e),corrected=record(answer,False),path=str(name)),sort_keys=True))
