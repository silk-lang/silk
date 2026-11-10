from pathlib import Path
import struct,json
for p in Path('/workspace/silk/.scratch/artifact-wire').glob('*.bin'):
 raw=p.read_bytes();out=bytearray();i=0
 while i<len(raw):
  n=struct.unpack_from('Q',raw,i)[0];i+=8;out.extend(raw[i:i+n]);i+=n
 if not out or out[0]!=1:continue
 i=1;packet=0;bad=[];counts=[]
 while i<len(out):
  n=int.from_bytes(out[i:i+8],'big');i+=8;data=out[i:i+n];i+=n
  if len(data)==1:counts.append('mode');packet+=1;continue
  k=0;count=int.from_bytes(data[k:k+8],'big');k+=8;states=[]
  for j in range(count):
   state=int.from_bytes(data[k:k+8],'big');k+=8;states.append(state)
   if state==1:
    size=int.from_bytes(data[k:k+8],'big');k+=8+size
  counts.append(count)
  if any(s!=1 for s in states):bad.append({'packet':packet,'count':count,'bad':[(j,s) for j,s in enumerate(states) if s!=1],'parsed':k,'length':len(data)})
  packet+=1
 print(p.name,'packets',packet,'tailcounts',counts[-8:],'bad',bad[-6:])
