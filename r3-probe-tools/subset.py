import re, sys, collections
sys.argv=[sys.argv[0]]+sys.argv[1:]
exec(open('/tmp/claude-0/-home-user-silk/d9ccf688-4f2f-5c3e-8b5f-ab0dafd01db4/scratchpad/tools/census.py').read().split("bits = collections.Counter()")[0])
def count(allowed):
  n=0
  for prog,g in groups.items():
    for e in g['emit']:
      mk=0
      for key in g['inc'].get(e,()):
        for m in g['maps'].get(key,()): mk|=m
      mk &= ~(1048576|8192)
      if mk and mk & ~allowed == 0: n+=1
  return n
A = 2|16384|65536|32768
print('A closed atoms', count(A))
