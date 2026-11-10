import struct,re,sys,bisect
from pathlib import Path
binary=Path(sys.argv[1]);p=binary.read_bytes();phoff=struct.unpack_from('<Q',p,32)[0];loads=[]
for i in range(struct.unpack_from('<H',p,56)[0]):
 t,f,o,v,_,fs,ms,a=struct.unpack_from('<IIQQQQQQ',p,phoff+56*i)
 if t==1:loads.append((v,v+fs,o))
def off(a):
 for lo,hi,o in loads:
  if lo<=a<hi:return o+a-lo
 raise ValueError(hex(a))
def u(a):return struct.unpack_from('<Q',p,off(a))[0]
shoff=struct.unpack_from('<Q',p,40)[0];n,si=struct.unpack_from('<HH',p,60);secs=[struct.unpack_from('<IIQQQQIIQQ',p,shoff+64*i) for i in range(n)];names=secs[si];names=p[names[4]:names[4]+names[5]];frames=[]
for sec in secs:
 if names[sec[0]:].split(b'\0')[0]!=b'silk_frames':continue
 for at in range(sec[4],sec[4]+sec[5],16):
  fn,st=struct.unpack_from('<QQ',p,at);ptr=u(st);length=u(st+8);label=p[off(ptr):off(ptr)+length].rstrip(b'\0').decode();frames.append((fn,label))
frames.sort();starts=[x[0] for x in frames]
for line in Path(sys.argv[2]).read_text().splitlines():
 m=re.search(re.escape(binary.name)+r'.*?\[(0x[0-9a-f]+)\]',line)
 if m:
  a=int(m[1],16);i=bisect.bisect_right(starts,a)-1
  print(hex(a),frames[i][1],f'+{a-starts[i]}')
 elif not line.startswith('/lib') and '.so(' not in line:print(line)
