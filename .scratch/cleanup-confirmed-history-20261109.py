import pathlib,hashlib,json,gzip,os,shutil,time
S=pathlib.Path('/workspace/silk/.scratch')
receipt=S/'benchmarks/profiling-confirmed-history-cleanup-20261109.json'
assert not receipt.exists()
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
 return h.hexdigest()
meta=json.loads((S/'frontier-streamed-hir-facets-build.json').read_text())
assert sha(meta['binary'])==meta['sha256']
roots=[S/'frontier-streamed-hir-facets-package/build/cache',S/'frontier-streamed-hir-facets-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler.units',S/'shared-typed-body-codec-tests.units',S/'executable-closure-roots-selector-test.units']
files=[]
for root in roots:
 assert root.is_dir(),root
 for p in sorted(root.rglob('*')):
  assert not p.is_symlink(),p
  if p.is_file():
   st=p.stat();files.append(dict(path=str(p),bytes=st.st_size,mtime_ns=st.st_mtime_ns,sha256=sha(p)))
archives=[]
for name in ['shared-typed-body-codec-tests','executable-closure-roots-selector-test']:
 p=S/name;dst=S/(name+'.gz');tmp=S/(name+'.gz.partial')
 assert not dst.exists() and not tmp.exists()
 before=p.stat();digest=sha(p)
 with open(p,'rb') as src,gzip.open(tmp,'wb',compresslevel=1) as out: shutil.copyfileobj(src,out,1024*1024)
 h=hashlib.sha256();size=0
 with gzip.open(tmp,'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b);size+=len(b)
 assert h.hexdigest()==digest and size==before.st_size
 tmp.rename(dst)
 archives.append(dict(path=str(p),bytes=before.st_size,mtime_ns=before.st_mtime_ns,mode=before.st_mode,sha256=digest,archive=str(dst),archive_bytes=dst.stat().st_size,archive_sha256=sha(dst),verified_decompressed=True))
r=dict(created_ns=time.time_ns(),status='verified-before-prune',authorization='Owner confirmations: interning streamed package; worker_forks codec; build_pipeline roots-selector. Frozen performance binaries and failure cohorts excluded.',frozen_binary=meta['binary'],frozen_sha256=meta['sha256'],roots=list(map(str,roots)),files=files,archives=archives,free_before_prune=shutil.disk_usage(S).free)
receipt.write_text(json.dumps(r,indent=2)+'\n')
for f in files:
 p=pathlib.Path(f['path']);assert p.stat().st_mtime_ns==f['mtime_ns'] and p.stat().st_size==f['bytes']
for a in archives:
 p=pathlib.Path(a['path']);assert p.stat().st_mtime_ns==a['mtime_ns'] and p.stat().st_size==a['bytes']
for root in roots:shutil.rmtree(root)
for a in archives:pathlib.Path(a['path']).unlink()
assert sha(meta['binary'])==meta['sha256']
r.update(status='completed',generated_bytes_pruned=sum(x['bytes'] for x in files),archive_net_bytes=sum(x['bytes']-x['archive_bytes'] for x in archives),free_after=shutil.disk_usage(S).free)
receipt.write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({k:r[k] for k in ['status','generated_bytes_pruned','archive_net_bytes','free_after']}));print(receipt)
