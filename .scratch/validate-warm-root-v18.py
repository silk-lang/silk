import hashlib,json,os,subprocess,time
from pathlib import Path
base=Path('/workspace/silk/.scratch');binary=base/'frontier-native-checkpoint-diagnostic';stdlib=base/'performance-v18-source/stdlib'
assert hashlib.sha256(binary.read_bytes()).hexdigest()=='b0c3ae6b19a3745ffd42185e0fd69ce35ab6d44c993b7591433c0b0546d7e9ba'
env=dict(os.environ,SILK_ESCAPE_REPLAY_CENSUS='1')
common=['python3',str(base/'completed-body-cache-lifecycle.py'),'--compiler',str(binary),'--stdlib',str(stdlib),'--reuse-off']
rows=[]
for name,extra in [('lifecycle',[]),('41-errors',['--first-edit-only','--multiple-callsite-errors'])]:
 log=base/f'warm-root-v18-{name}.log';started=time.monotonic();print('START',name,flush=True)
 with log.open('wb') as output:p=subprocess.run(common+extra,env=env,cwd='/workspace/silk',stdout=output,stderr=subprocess.STDOUT)
 row={'case':name,'exit':p.returncode,'seconds_correctness_only':time.monotonic()-started,'log':str(log)};rows.append(row)
 (base/'warm-root-v18-validation.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(row),flush=True)
 if p.returncode:raise SystemExit(p.returncode)
