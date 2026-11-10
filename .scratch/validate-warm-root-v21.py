import hashlib,json,os,subprocess,time
from pathlib import Path
base=Path('/workspace/silk/.scratch');binary=base/'frontier-cache-bundle-v21';stdlib=base/'performance-bundle-v21-source/stdlib'
assert hashlib.sha256(binary.read_bytes()).hexdigest()=='be02b4c6f56081cb7cf5a67d52332e57797dc1ffff893b370f61123e6db68ba2'
env=dict(os.environ,SILK_ESCAPE_REPLAY_CENSUS='1')
common=['python3',str(base/'completed-body-cache-lifecycle.py'),'--compiler',str(binary),'--stdlib',str(stdlib),'--reuse-off']
rows=[]
for name,extra in [('lifecycle',[]),('41-errors',['--first-edit-only','--multiple-callsite-errors'])]:
 log=base/f'warm-root-v21-{name}.log';started=time.monotonic();print('START',name,flush=True)
 with log.open('wb') as output:p=subprocess.run(common+extra,env=env,cwd='/workspace/silk',stdout=output,stderr=subprocess.STDOUT)
 row={'case':name,'exit':p.returncode,'seconds_correctness_only':time.monotonic()-started,'log':str(log)};rows.append(row)
 (base/'warm-root-v21-validation.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(row),flush=True)

