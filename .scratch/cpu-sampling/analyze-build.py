from pathlib import Path
import collections,json,re,sys
root=Path(sys.argv[1]);s=Path('/workspace/silk/.scratch')
launch=json.loads((root/'launch.json').read_text()); names={}
for line in (s/'construction-9279952db/pgo/training-debug.ll.symbols').read_text().splitlines():
 fields=line.split('\t',2)
 if len(fields)==3:names[fields[0]]=fields[2]
pattern=re.compile(r'^\s*(\S+)\s+(\d+)/(\d+)\s+([\d.]+):\s+(\d+)\s+cpu-clock:u:\s+(\S+)\s+(.+)\s+\((.*)\)$')
rows=[]; bad=[]
for line in (root/'samples.txt').read_text().splitlines():
 if not line.strip():continue
 m=pattern.match(line)
 if not m:bad.append(line);continue
 comm,pid,tid,ts,period,ip,sym,dso=m.groups();pid=int(pid)
 base=sym.split('.llvm.',1)[0];name=names.get(base,sym)
 role='compiler-worker' if comm.startswith('frontier-index') else 'native-tool' if comm.startswith(('clang','ld.','lld')) else comm
 if pid==launch['root_pid']:role='compiler-parent'
 if pid in [d['pid'] for d in launch['detached']]:role='cache-writer'
 if pid==launch['launcher_pid']:role='observer'
 rows.append(dict(comm=comm,pid=pid,tid=int(tid),time=float(ts),cpu_s=int(period)/1e9,symbol=sym,name=name,dso=dso,role=role))
assert not bad,bad[:3]
byrole=collections.Counter();hot=collections.defaultdict(collections.Counter);dso=collections.Counter()
for row in rows:
 byrole[row['role']]+=row['cpu_s'];hot[row['role']][row['name']]+=row['cpu_s'];dso[row['dso']]+=row['cpu_s']
summary={'sample_count':len(rows),'sampled_user_cpu_s':sum(byrole.values()),'wait4_user_cpu_s':launch['root_inclusive_user']+sum(x['user'] for x in launch['detached']), 'by_role':dict(byrole),'dsos':dso.most_common(),'hotspots':{k:v.most_common(35) for k,v in hot.items()},'note':'99Hz user-CPU samples; shared-slot diagnostic, no wall-speed claim. Exact hashed symbol matches only against source927 mapping; unmatched symbols retained, no address remapping.'}
(root/'parsed.json').write_text(json.dumps(rows)+'\n');(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({k:summary[k] for k in ['sample_count','sampled_user_cpu_s','wait4_user_cpu_s','by_role']},indent=2))
for role,counts in hot.items():
 print(role)
 for name,cpu in counts.most_common(15):print(f'{cpu:.3f} {name}')
