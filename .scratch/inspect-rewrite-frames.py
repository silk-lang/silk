import struct,subprocess
from pathlib import Path
p=Path('/workspace/silk/.scratch/walk-fragment-budget-tests').read_bytes()
phoff=struct.unpack_from('<Q',p,32)[0];phnum=struct.unpack_from('<H',p,56)[0]
loads=[]
for i in range(phnum):
 t,f,o,v,_,fs,ms,a=struct.unpack_from('<IIQQQQQQ',p,phoff+56*i)
 if t==1: loads.append((v,v+fs,o))
def off(a):
 for lo,hi,o in loads:
  if lo<=a<hi:return o+a-lo
 raise ValueError(hex(a))
def u(a):return struct.unpack_from('<Q',p,off(a))[0]
shoff=struct.unpack_from('<Q',p,40)[0];n,si=struct.unpack_from('<HH',p,60);sects=[struct.unpack_from('<IIQQQQIIQQ',p,shoff+64*i) for i in range(n)];names=sects[si];names=p[names[4]:names[4]+names[5]]
for sec in sects:
 name=names[sec[0]:].split(b'\0')[0]
 if name!=b'silk_frames':continue
 for at in range(sec[4],sec[4]+sec[5],16):
  fn,st=struct.unpack_from('<QQ',p,at);ptr=u(st);length=u(st+8);label=p[off(ptr):off(ptr)+length].rstrip(b'\0').decode()
  if not label.startswith('semantic/Type.rewrite'):continue
  if 'Node' not in label and label not in ('semantic/Type.rewriteType','semantic/Type.rewriteTypeInside','semantic/Type.rewriteNominal'):continue
  out=subprocess.check_output(['objdump','-d',f'--start-address={fn}',f'--stop-address={fn+40}','/workspace/silk/.scratch/walk-fragment-budget-tests'],text=True)
  import re
  m=re.search(r'sub\s+\$0x([a-f0-9]+),%rsp',out)
  print(label,int(m[1],16) if m else 'no sub',hex(fn))
