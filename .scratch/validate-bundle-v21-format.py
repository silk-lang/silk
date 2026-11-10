"""Caller holds shared lock; candidate cache versus fresh matched V19 control."""
import sys,struct
from pathlib import Path
basepath=Path('/workspace/silk/.scratch')
sys.argv=['completed-body-cache-lifecycle.py','--compiler',str(basepath/'frontier-cache-bundle-v21'),'--stdlib',str(basepath/'performance-bundle-v21-source/stdlib'),'--reuse-off']
source=(basepath/'completed-body-cache-lifecycle.py').read_text().split('\nfor stage,entry,body,status in stages')[0]
exec(compile(source,'completed-body-cache-lifecycle.py','exec'))
candidate=compiler;control=basepath/'frontier-native-checkpoint-completed-v19'
original_invoke=invoke
receipts=[]
def invoke(mode,stage,command='check'):
 global compiler
 compiler=candidate if mode=='parallel' else control
 try: result=original_invoke(mode,stage,command)
 finally: compiler=candidate
 if command=='build' and result['code']==0:
  result['binary_sha256']=hashlib.sha256((work/'build/llvm/x86_64-unknown-linux-gnu/debug/boundary-cache').read_bytes()).hexdigest()
 return result

def image():
 manifests=[x for x in (work/'build/cache/boundary-cache').glob('semantic-*') if x.is_file() and x.name.count('.')==0]
 assert len(manifests)==1,manifests
 manifest=manifests[0];data=manifest.read_bytes();at=0
 def word():
  nonlocal at
  v=struct.unpack_from('<Q',data,at)[0];at+=8;return v
 def field():
  nonlocal at
  n=word();v=data[at:at+n];at+=n;return v
 assert field()==b'silk-semantic-bundle'
 version=word();stamp=field();count=word();blobs=[]
 for _ in range(count):
  high,low,size=word(),word(),word();p=Path(str(manifest)+'.shards')/(f'{high:016x}{low:016x}');assert p.stat().st_size==size
  blobs.append(p)
 assert blobs
 receipt={'manifest':str(manifest),'format':version,'required_shards':len(blobs),'manifest_bytes':len(data),'shard_bytes':sum(p.stat().st_size for p in blobs)}
 receipts.append(receipt);(base/'bundle-receipts.json').write_text(json.dumps(receipts,indent=2)+'\n')
 return blobs
prefix='pub fn identity<T>(item: T) -> T { let _checked: i32 = value() return move item }\n'
(work/'silk.toml').write_text('[package]\nname = "boundary-cache"\nversion = "0.0.0"\nmain = "main.silk"\n')
def stage(name,body,expected=0):
 (src/'parking.silk').write_text(prefix+body);compare(name,expected);return image()
blobs=stage('cold',clean)
# Exactly two source edits directly after the cold publication; no unchanged warm priming.
blobs=stage('direct-edit-one',clean.replace('return 0','return 1'))
blobs=stage('direct-edit-two',clean.replace('return 0','return 2'))
assert any('escape materialized' in x for row in results if row['mode']=='parallel' and row['stage']=='direct-edit-one' for x in row['trace']), 'must adopt persisted View, not merely write new format'
compare('native-artifact',0,'build',42)
assert results[-2]['binary_sha256']==results[-1]['binary_sha256'], 'V21/V19 artifact byte parity'
# Delete/corrupt a referenced required shard, retain manifest, and demand an authored error.
# No warm-refork assertion here: cache refusal is expected to run fresh checking.
for kind in ['missing','corrupt']:
 blobs=image();victim=max(blobs,key=lambda p:p.stat().st_size);old=victim.read_bytes()
 if kind=='missing':victim.unlink()
 else:victim.write_bytes(bytes([old[0]^1])+old[1:])
 receipts.append({'fault':kind,'required_shard':str(victim),'bytes':len(old)})
 (src/'parking.silk').write_text(prefix+'pub fn value() -> i64 { return 0 }\n')
 actual=invoke('parallel',kind)
 (work/'build').rename(work/'saved-parallel-cache')
 try:fresh=invoke('serial',kind)
 finally:shutil.rmtree(work/'build',ignore_errors=True);(work/'saved-parallel-cache').rename(work/'build')
 assert actual['code']==fresh['code']==1 and actual['diagnostics']==fresh['diagnostics'],(kind,actual,fresh)
 assert not any('escape materialized' in x for x in actual['trace']), (kind,'broken bundle must not adopt Views')
 # Repair with source recovery; then unchanged adoption must remain valid and avoid a new pool.
 (src/'parking.silk').write_text(prefix+clean)
 repaired=invoke('parallel',kind+'-repair');assert repaired['code']==0;image()
 unchanged=invoke('parallel',kind+'-unchanged');assert unchanged['code']==0 and not unchanged['split'];image()
(base/'bundle-receipts.json').write_text(json.dumps(receipts,indent=2)+'\n')
(base/'results.json').write_text(json.dumps(results,indent=2)+'\n')
print('PASS FORMAT '+str(base),flush=True)
