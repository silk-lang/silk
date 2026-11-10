"""Summarize existing trace logs; never starts a compiler."""
import json,re,sys
from pathlib import Path
rows=[]
for path in map(Path,sys.argv[1:]):
 text=path.read_text()
 events=[]
 for line in text.splitlines():
  m=re.fullmatch(r'frontier (.*?) ms=(\d+) a=(\d+) b=(\d+)',line)
  if m:events.append(dict(label=m[1],ms=int(m[2]),a=int(m[3]),b=int(m[4])))
 def selected(*labels):return [e for e in events if e['label'] in labels]
 phases=selected('split','worker-runtime','worker-modules','merged-images','missing bodies','extension fragment','extended graph','proved','adopted','artifact proved','artifact emitted')
 row=dict(log=str(path),accepted='frontier accepted' in text,artifact_accepted='artifact accepted' in text,
  chunks=len(selected('declaration chunk')),actual_descendants=[e for e in selected('private fork') if e['a']>=4],phases=phases)
 rows.append(row)
print(json.dumps(rows,indent=2))
