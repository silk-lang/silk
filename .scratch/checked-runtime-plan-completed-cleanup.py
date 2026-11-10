import gzip,hashlib,json,os,shutil,time
from pathlib import Path
s=Path('/workspace/silk/.scratch')
revisions=['b42e67b2d','a7f34e639','2edd58c05']
receipt=s/'checked-runtime-plan-completed-cleanup.json'
def digest(path, opener=open):
 h=hashlib.sha256()
 with opener(path,'rb') as f:
  for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
 return h.hexdigest()
meta={'purpose':'Receipt-prune completed superseded checked-plan test units/sourcecheck cache; retain current957 runner, all sources/logs/results, gzip exact obsolete ELF bytes','started_unix':time.time(),'free_before':shutil.disk_usage(s).free,'elf':[],'files':[],'removed':[]}
for rev in revisions:
 elf=s/f'checked-runtime-plan-{rev}-tests'; packed=elf.with_name(elf.name+'.gz'); original=digest(elf)
 with open(elf,'rb') as source, gzip.open(packed,'wb',compresslevel=3) as target: shutil.copyfileobj(source,target,1024*1024)
 assert digest(packed,gzip.open)==original
 meta['elf'].append({'path':str(elf),'bytes':elf.stat().st_size,'sha256':original,'gzip':str(packed),'gzip_bytes':packed.stat().st_size,'gzip_sha256':digest(packed),'decoded_sha256':original})
 receipt.write_text(json.dumps(meta,indent=2)+'\n');elf.unlink();meta['removed'].append(str(elf))
folders=[s/f'checked-runtime-plan-{r}-tests.units' for r in revisions]+[s/'checked-runtime-plan-package/build/cache']
for folder in folders:
 assert folder.exists() and not folder.is_symlink()
 for path in sorted(folder.rglob('*')):
  if path.is_file():
   assert not path.is_symlink()
   meta['files'].append({'path':str(path),'bytes':path.stat().st_size,'sha256':digest(path)})
 receipt.write_text(json.dumps(meta,indent=2)+'\n');shutil.rmtree(folder);meta['removed'].append(str(folder))
meta.update(finished_unix=time.time(),free_after=shutil.disk_usage(s).free)
receipt.write_text(json.dumps(meta,indent=2)+'\n')
print(json.dumps({'receipt':str(receipt),'free_before':meta['free_before'],'free_after':meta['free_after'],'reclaimed':meta['free_after']-meta['free_before'],'files':len(meta['files']),'elf':len(meta['elf'])}),flush=True)
