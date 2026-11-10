import pathlib,os,json,hashlib,shutil,tarfile,gzip,stat
B=pathlib.Path('/workspace/silk/.scratch/benchmarks'); R=pathlib.Path('/workspace/silk/.scratch/historical-headroom-recovery-nonstd-20261109.json'); rows=[]
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  while b:=f.read(1024*1024):h.update(b)
 return h.hexdigest()
def save():R.write_text(json.dumps(dict(purpose='Authorized completed historical cache pruning and verified lossless source archival; failed V20/current prototypes/CPU0/frozen binaries excluded',actions=rows),indent=2)+'\n')

names=['retained-build-nz1pyy_l', 'retained-build-7e4_s5co', 'retained-build-ebunwmy5', 'retained-build-s0386s3g']
for name in names:
 root=B/name/'nonstd'; out=B/name/'preserved-nonstd-source-snapshot.tar.gz'
 if not root.exists() or (root/'.git').exists() or out.exists():raise RuntimeError('unexpected source state '+str(root))
 entries=sorted(p for p in root.iterdir() if p.name!='build'); inventory={}
 for top in entries:
  for p in [top,*sorted(top.rglob('*'))] if top.is_dir() and not top.is_symlink() else [top]:
   st=p.lstat();k=str(p.relative_to(root));row=dict(mode=stat.S_IMODE(st.st_mode),mtime_ns=st.st_mtime_ns)
   if p.is_symlink():row.update(kind='symlink',target=os.readlink(p))
   elif p.is_dir():row.update(kind='directory')
   elif p.is_file():row.update(kind='file',bytes=st.st_size,sha256=sha(p))
   else:raise RuntimeError('unsupported '+str(p))
   inventory[k]=row
 temp=out.with_suffix(out.suffix+'.partial')
 with tarfile.open(temp,'w:gz',compresslevel=1,dereference=False,format=tarfile.PAX_FORMAT) as tf:
  for p in entries:tf.add(p,arcname=p.name,recursive=True)
 checked=set()
 with tarfile.open(temp,'r:gz') as tf:
  for m in tf:
   row=inventory[m.name]; checked.add(m.name)
   assert m.mode==row['mode'],m.name
   if row['kind']=='file':
    assert m.isfile() and m.size==row['bytes'];h=hashlib.sha256();f=tf.extractfile(m)
    while b:=f.read(1024*1024):h.update(b)
    assert h.hexdigest()==row['sha256'],m.name
   elif row['kind']=='symlink':assert m.issym() and m.linkname==row['target']
   else:assert m.isdir()
 assert checked==set(inventory)
 for k,v in inventory.items():assert (root/k).lstat().st_mtime_ns==v['mtime_ns'],k
 temp.rename(out)
 receipt=out.with_name('preserved-nonstd-source-snapshot.receipt.json.gz')
 with gzip.open(receipt,'wt',compresslevel=1) as f:json.dump(dict(source=str(root),archive=str(out),archive_sha256=sha(out),verified_members=len(checked),files=inventory),f)
 total=sum(x.get('bytes',0) for x in inventory.values()); rows.append(dict(action='lossless source archive',source=str(root),archive=str(out),receipt=str(receipt),bytes=total,archive_bytes=out.stat().st_size,receipt_bytes=receipt.stat().st_size,sha256=sha(out)));save()
 for p in entries:
  if p.is_dir() and not p.is_symlink():shutil.rmtree(p)
  else:p.unlink()
 print('archived',name,total,'->',out.stat().st_size,'free',os.statvfs(B).f_bavail*os.statvfs(B).f_frsize,flush=True)
print('DONE',json.dumps(dict(logical_reclaimed=sum(x['bytes']-x.get('archive_bytes',0)-x.get('receipt_bytes',0) for x in rows),free=os.statvfs(B).f_bavail*os.statvfs(B).f_frsize,receipt=str(R))),flush=True)
