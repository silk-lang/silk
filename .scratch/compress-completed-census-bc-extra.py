from pathlib import Path
import hashlib,gzip,json,shutil
s=Path('/workspace/silk/.scratch');archive=s/'llvm-promotion-experiment/census-script-archive';archive.mkdir(exist_ok=True)
for name in ['capture-v20-storage-census.py','capture-backend-storage-v20.py','census-backend-storage.py','parameter_spill_census.py']:
 p=s/'llvm-promotion-experiment'/name;b=p.read_bytes();(archive/(hashlib.sha256(b).hexdigest()+'-'+name)).write_bytes(b)
for name in ['llvm-promotion-v11-compiler','backend-storage-v20-harfrust-capture','backend-storage-v17-harfrust-capture','backend-storage-v15-harfrust-capture']:
 if shutil.disk_usage(s).free>=1800*1024*1024:break
 root=s/'benchmarks'/name;result=json.loads((root/'capture-result.json').read_text());assert result['exit_code']==0 and all(x['exit_code']==0 for x in result['detached']);rows=[];receipt=root/'bitcode-lossless-compression.json'
 if receipt.exists():rows=json.loads(receipt.read_text())['files']
 for p in sorted((root/'capture/files').iterdir()):
  if not p.is_file() or p.suffix=='.gz':continue
  with p.open('rb') as f:magic=f.read(4)
  if magic!=b'BC\xc0\xde':continue
  n=p.stat().st_size;h=hashlib.sha256(p.read_bytes()).hexdigest();assert h==p.name
  out=p.with_name(p.name+'.gz')
  with p.open('rb') as src,gzip.open(out,'wb',compresslevel=1) as dst:shutil.copyfileobj(src,dst)
  d=hashlib.sha256();count=0
  with gzip.open(out,'rb') as f:
   while b:=f.read(1024*1024):d.update(b);count+=len(b)
  assert count==n and d.hexdigest()==h
  rows.append({'original':str(p),'gzip':str(out),'bytes':n,'compressed_bytes':out.stat().st_size,'sha256':h,'decompressed_verified':True})
  receipt.write_text(json.dumps({'reason':'Completed capture and streaming census; lossless archival for headroom. Restore original paths by gzip decompression for replay. Native argv/input receipts retain original hashes.','files':rows},indent=2)+'\n');p.unlink()
 print(name,'files',len(rows),'reclaimed',sum(x['bytes']-x['compressed_bytes'] for x in rows),'free',shutil.disk_usage(s).free,flush=True)
