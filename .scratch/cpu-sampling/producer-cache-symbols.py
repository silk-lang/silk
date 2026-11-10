#!/usr/bin/env python3
"""Read pinned producer4a1fa332 CacheImage10/BuildRecord10; never guesses addresses."""
import argparse,hashlib,json,re,subprocess
from pathlib import Path
FORMAT=10
class Reader:
 def __init__(self,b):self.b=b;self.at=0
 def take(self,n):
  if n<0 or n>len(self.b)-self.at:raise ValueError(f'truncated at{self.at}, wanted{n}')
  out=self.b[self.at:self.at+n];self.at+=n;return out
 def word(self):return int.from_bytes(self.take(8),'big')
 def var(self):
  n=0
  for shift in range(0,64,7):
   v=self.take(1)[0];n|=(v&127)<<shift
   if v<128:
    if n>2**64-1:raise ValueError('varint overflow')
    return n
  raise ValueError('unterminated varint')
 def count(self):
  n=self.var()
  if n>len(self.b)-self.at:raise ValueError('count exceeds remaining bytes')
  return n
 def field(self):return self.take(self.word())
 def chunk(self):return self.take(self.count())
 def done(self):
  if self.at!=len(self.b):raise ValueError(f'trailing bytes at{self.at}/{len(self.b)}')
 def packed(self,before=b'',prefix=0,keep=True):
  length=self.var();written=self.count();raw=self.take(written)
  if prefix>len(before) or length>written*256:raise ValueError('invalid packed bound')
  if not keep:return None
  out=bytearray(before[:prefix]);i=0
  while i<len(raw):
   v=raw[i];i+=1
   if v:out.append(v)
   else:
    if i==len(raw):raise ValueError('missing zero run')
    out.extend(b'\0'*(raw[i]+1));i+=1
   if len(out)>prefix+length:raise ValueError('packed expansion overflow')
  if len(out)!=prefix+length:raise ValueError('packed expansion short')
  return bytes(out)
def header(r):
 if r.chunk()!=b'silk-semantic-cache' or r.var()!=FORMAT:raise ValueError('unsupported producer CacheImage')
 return r.chunk(),r.take(16)
def declaration(raw):
 # BuildCapture.enter appends recorded specialization shape after this declaration field.
 # Attribution needs only the declaration; the exact digest joins the original full entry.
 outer=Reader(raw);content=outer.field();r=Reader(content)
 origin,package,path=r.field(),r.field(),r.field();names=[]
 for _ in range(r.word()):
  kind=r.word();named=r.word()
  if named not in (0,1):raise ValueError('invalid named owner')
  names.append(r.field() if named else b'_');r.word()
 r.done()
 return (package+b':'+path+b'::'+b'.'.join(names)).decode('utf8'),origin.hex()
def facts(r,refs):
 flags=r.var()
 if not flags&1:return
 r.take(16)
 if flags&64:r.take(16)
 if flags&2:r.take(8)
 for _ in range(r.count()):
  if r.var()>1:raise ValueError('invalid exact obligation')
  for _ in range(r.count()):r.take(32)
  for _ in range(r.count()):r.chunk()
 if flags&256:
  for _ in range(r.count()):r.take(16)
 if flags&1024:
  for _ in range(r.count()):
   if r.var()>=refs:raise ValueError('callee index outside references')
def build_record(raw):
 r=Reader(raw)
 if r.word()!=FORMAT:raise ValueError('unsupported producer BuildRecord')
 observed,patterned=r.var(),r.var()
 if observed>3 or patterned>1:raise ValueError('bad build flags')
 for _ in range(r.count()):r.take(16)
 edgecount=r.count();r.take(edgecount*16);total=r.count();prior=b'';result={}
 for i in range(total):
  exact=r.take(16);r.word();family=r.var();prefix=r.var()
  if prefix>len(prior):raise ValueError('declaration prefix overflow')
  named=prior[:prefix]+r.chunk();prior=named
  parent,position,requested,alias,leaf=r.var(),r.var(),r.var(),r.var(),r.var()
  if parent>i or alias>i or requested>1 or leaf>2:raise ValueError('invalid build entry')
  refs=r.count()
  for _ in range(refs):
   if r.var()>=total or r.var()>=edgecount:raise ValueError('reference index')
  r.take(16);facts(r,refs)
  name,origin=declaration(named)
  value=(family,name,origin)
  if exact in result and result[exact]!=value:raise ValueError('conflicting exact declaration')
  result[exact]=value
 r.done();return result
def definition(raw):
 r=Reader(raw)
 if r.word()!=FORMAT:raise ValueError('unsupported definition')
 r.field();symbol=r.field().decode('utf8')
 for _ in range(r.word()):r.field();r.field();r.field()
 if r.word()>1:raise ValueError('invalid borrow state')
 r.done();return symbol
def root_tag(key):
 r=Reader(key)
 try:
  tag=r.field()
  if tag==b'silk.build.record':r.done();return tag,None
  if tag==b'silk.build.entry':
   exact=r.field();r.done()
   if len(exact)!=16:raise ValueError('bad exact digest')
   return tag,exact
 except ValueError:pass
 return None,None
def read_roots(path):
 raw=path.read_bytes();r=Reader(raw);stamp,seal=header(r)
 graph=Path(str(path)[:-len('.roots')])
 with graph.open('rb') as f:graphhead=f.read(65536)
 gr=Reader(graphhead);otherstamp,otherseal=header(gr)
 if (stamp,seal)!=(otherstamp,otherseal):raise ValueError('roots/graph header identity differs')
 previous=b'';records=[];defs={};count=r.count()
 for _ in range(count):
  prefix=r.var();key=r.packed(previous,prefix);previous=key;r.var();tag,exact=root_tag(key)
  answer=r.packed(keep=tag is not None)
  if tag==b'silk.build.record':records.append(build_record(answer))
  elif tag==b'silk.build.entry' and answer:
   symbol=definition(answer)
   if exact in defs and defs[exact]!=symbol:raise ValueError('conflicting definition root')
   defs[exact]=symbol
 r.done();mapped=[];missing=[]
 for record in records:
  for exact,value in record.items():
   if exact in defs:mapped.append((defs[exact],*value))
   else:missing.append(exact.hex())
 return mapped,dict(path=str(path),sha256=hashlib.sha256(raw).hexdigest(),bytes=len(raw),stamp_sha256=hashlib.sha256(stamp).hexdigest(),seal=seal.hex(),graph_path=str(graph),graph_header_matches=True,root_count=count,build_records=len(records),definitions=len(defs),record_entries_without_definition=len(missing))
def main():
 p=argparse.ArgumentParser();p.add_argument('--binary',type=Path,required=True);p.add_argument('--cache',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
 symbols={};inputs=[]
 for path in sorted(a.cache.rglob('semantic-*.roots')):
  rows,meta=read_roots(path);inputs.append(meta)
  for symbol,family,name,origin in rows:symbols.setdefault(symbol,set()).add((family,name,origin))
 if not any(x['build_records'] for x in inputs):raise ValueError('no producer build record')
 nm=subprocess.check_output(['nm','--defined-only','--format=posix',str(a.binary)],text=True)
 Path(str(a.output)+'.nm.txt').write_text(nm)
 lines=[];unmapped=[];ambiguous=[];clones=0;elfcount=0
 for line in nm.splitlines():
  fields=line.split()
  if len(fields)<3:continue
  name=fields[0]
  if not re.fullmatch(r'silk_[0-9a-f]{32}(?:\.llvm\.\d+)?',name):continue
  elfcount+=1;base=re.sub(r'\.llvm\.\d+$','',name);found=symbols.get(base)
  if not found:unmapped.append(name);continue
  # Multiple origin identities are not silently collapsed to the same printed source name.
  if len(found)!=1:ambiguous.append(dict(symbol=name,candidates=sorted(found)));continue
  family,source,origin=next(iter(found));clones+=int(name!=base)
  lines.append(f'{name}\t'+{0:'function',1:'export',2:'drop',3:'helper'}.get(family,f'unknown-{family}')+f'\t{source}\n')
 a.output.write_text(''.join(sorted(lines)))
 report=dict(producer_source='4a1fa332',cache_format=FORMAT,build_record_format=FORMAT,binary=str(a.binary),binary_sha256=hashlib.sha256(a.binary.read_bytes()).hexdigest(),reader_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),inputs=inputs,emitted_symbol_count=len(symbols),elf_silk_symbols=elfcount,mapped_elf_symbols=len(lines),exact_base_clones=clones,unmapped=unmapped,ambiguous=ambiguous,seal_validation='Exact header seal/stamp pairing only; no full SipHash recomputation. Original files and SHA receipts retained. This is attribution, never cache validity authorization.',limitation='Mapping is declaration ownership, not inline source lines. BuildRecord specialization-shape suffix is retained opaque, not validated/reconstructed. LLVM clone suffix is accepted only with exact emitted base symbol; no nearest-address or cross-build map matching.')
 Path(str(a.output)+'.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:report[k] for k in ['elf_silk_symbols','mapped_elf_symbols','exact_base_clones']},sort_keys=True))
 if not lines:raise ValueError('no exact ELF symbol mappings')
if __name__=='__main__':main()
