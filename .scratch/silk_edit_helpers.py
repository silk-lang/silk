import re

def item_span(s, pattern):
 m=re.search(pattern,s,re.M)
 if not m: raise ValueError(pattern)
 start=m.start(); i=s.index('{',m.end()); depth=0; quote=False; line=False; block=0
 while i<len(s):
  c=s[i];n=s[i:i+2]
  if line:
   if c=='\n':line=False
  elif block:
   if n=='*/':block-=1;i+=1
   elif n=='/*':block+=1;i+=1
  elif quote:
   if c=='\\':i+=1
   elif c=='"':quote=False
  elif n=='//':line=True;i+=1
  elif n=='/*':block=1;i+=1
  elif c=='"':quote=True
  elif c=='{':depth+=1
  elif c=='}':
   depth-=1
   if depth==0:return start,i+1
  i+=1
 raise ValueError('unclosed '+pattern)
def remove(s,pattern):
 a,b=item_span(s,pattern);return s[:a]+s[b:]
def extract(s,pattern):
 a,b=item_span(s,pattern);return s[a:b]
