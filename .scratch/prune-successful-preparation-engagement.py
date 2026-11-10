import pathlib,json,hashlib,os,shutil
B=pathlib.Path('/workspace/silk/.scratch/benchmarks');rows=[];receipt=pathlib.Path('/workspace/silk/.scratch/successful-preparation-engagement-cache-prune.json')
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  while data:=f.read(1024*1024):h.update(data)
 return h.hexdigest()
for name in ['executables-engagement-yh7dhxx_']:
 root=B/name;passed=json.loads((root/'passed.json').read_text());meta=json.loads((root/'metadata.json').read_text());run=json.loads((root/'runtime.json').read_text());proof=json.loads((root/'proof-runtime.json').read_text());result=json.loads((root/'result.json').read_text())
 assert passed['all_children_reaped'] and proof['all_children_reaped']
 assert run['exit_code']==result['exit_code']==0 and all(r['exit_code']==0 for r in result['detached']+run['detached'])
 artifact=root/'artifact';output=root/'silk/build/llvm/x86_64-unknown-linux-gnu/debug/silk-compiler'
 assert artifact.stat().st_ino==output.stat().st_ino and artifact.stat().st_dev==output.stat().st_dev
 assert sha(artifact)==passed['artifact_sha256']==proof['artifact_sha256']
 assert (root/'silk/compiler/src/main.silk').is_file() and meta['workload_revision']=='a63f612150a0b91a118c8111b910b12c3e124b50'
 targets=[root/'silk/build/cache',output.with_name(output.name+'.units')]
 files=[]
 for target in targets:
  if not target.exists():continue
  for p in sorted(target.rglob('*')):
   assert not p.is_symlink(),str(p)
   if p.is_file():files.append(dict(path=str(p),bytes=p.stat().st_size,sha256=sha(p)))
 row=dict(cohort=str(root),artifact=str(artifact),artifact_sha256=passed['artifact_sha256'],artifact_inode=artifact.stat().st_ino,preserved_proof_sha256=sha(root/'proof-runtime.json'),metadata_sha256=sha(root/'metadata.json'),files=files,bytes=sum(f['bytes'] for f in files));rows.append(row)
 receipt.write_text(json.dumps(dict(purpose='Authorized successful engagement generated cache/object prune; artifact, source, counters, proof, logs and results retained',cohorts=rows),indent=2)+'\n')
 for target in targets:
  if target.exists():shutil.rmtree(target)
 assert artifact.is_file() and output.is_file()
 print(name,row['bytes'],'free',os.statvfs(root).f_bavail*os.statvfs(root).f_frsize,flush=True)
print('TOTAL',sum(r['bytes'] for r in rows),'free',os.statvfs(B).f_bavail*os.statvfs(B).f_frsize,flush=True)
