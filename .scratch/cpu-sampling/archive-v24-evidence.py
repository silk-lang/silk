import gzip,hashlib,json,pathlib,os,time
root=pathlib.Path('/workspace/silk/.scratch/benchmarks/v24-cpu-build-3ebpgyqm')
paths=sorted((root/'query-runs').glob('*.query-runs'))+[root/n for n in ['perf.data','stack-samples.txt','tasks-and-samples.txt','samples.txt']]
receipt=root/'lossless-raw-evidence-archive.json'
rows=[]
for p in paths:
 if not p.exists():continue
 before=p.stat();out=p.with_name(p.name+'.gz');temp=out.with_name(out.name+'.partial'); h=hashlib.sha256()
 if out.exists():raise RuntimeError('refuse overwrite '+str(out))
 with p.open('rb') as src,gzip.open(temp,'wb',compresslevel=1) as dst:
  while data:=src.read(1024*1024):h.update(data);dst.write(data)
 check=hashlib.sha256();size=0
 with gzip.open(temp,'rb') as src:
  while data:=src.read(1024*1024):check.update(data);size+=len(data)
 if size!=before.st_size or h.digest()!=check.digest():raise RuntimeError('verification failed '+str(p))
 if p.stat().st_mtime_ns!=before.st_mtime_ns:raise RuntimeError('source changed '+str(p))
 temp.rename(out);ch=hashlib.sha256()
 with out.open('rb') as src:
  while data:=src.read(1024*1024):ch.update(data)
 rows.append(dict(original=str(p),compressed=str(out),bytes=before.st_size,compressed_bytes=out.stat().st_size,sha256=h.hexdigest(),compressed_sha256=ch.hexdigest(),decompressed_verified=True))
 receipt.write_text(json.dumps(dict(purpose='Lossless archival after all raw census and sample analyses; no evidence loss',files=rows),indent=2)+'\n')
 p.unlink();print(p.name,before.st_size,'->',out.stat().st_size,flush=True)
print('reclaimed',sum(x['bytes']-x['compressed_bytes'] for x in rows),flush=True)
print('free',os.statvfs(root).f_bavail*os.statvfs(root).f_frsize,flush=True)
