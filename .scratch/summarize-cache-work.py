"""Summarize optional nested cache-work diagnostics, never sum inclusive stage times."""
import argparse,json,re
from collections import defaultdict
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('logs',nargs='+');a=p.parse_args()
for filename in a.logs:
 rows=defaultdict(list)
 for label,nanos,first,second in re.findall(r'^cache-work ([a-z-]+) ns=(\d+) a=(\d+) b=(\d+)$',Path(filename).read_text(),re.M):
  rows[label].append(tuple(map(int,(nanos,first,second))))
 print(json.dumps({'log':filename,'note':'Stages nest and prefetch overlaps other work; do not add their times. Budget a=visited rows, b=new definitions; green a=rows/bytes, b=accepted.','stages':{label:{'calls':len(r),'inclusive_ms':round(sum(v[0] for v in r)/1e6,3),'max_ms':round(max(v[0] for v in r)/1e6,3),'a_total':sum(v[1] for v in r),'b_total':sum(v[2] for v in r)} for label,r in sorted(rows.items())}},indent=2))
