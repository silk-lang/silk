import re, sys, collections
src=open('/tmp/claude-0/-home-user-silk/d9ccf688-4f2f-5c3e-8b5f-ab0dafd01db4/scratchpad/tools/census.py').read().split("bits = collections.Counter()")[0]
target=int(sys.argv[2]); sys.argv=[sys.argv[0],sys.argv[1]]
exec(src)
c=collections.Counter()
for prog,g in groups.items():
  for e in g['emit']:
    mk=0
    for key in g['inc'].get(e,()):
      for m in g['maps'].get(key,()): mk|=m
    if (mk & ~(1048576|8192)) == target: c[prog]+=1
for p,v in c.most_common(25): print(v,p)
