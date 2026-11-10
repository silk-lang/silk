"""Read settled capture evidence and attribute dirty unit definitions using DWARF files."""
import argparse,collections,json,re,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('root',type=Path);a=p.parse_args();root=a.root
rows=json.loads((root/'results.json').read_text());summary=[]
for row in rows:
    out={k:row[k] for k in ['workload','packing','stage','wall_s','settled_wall_s','objects']}
    out['new_object_count']=len(row['new_objects']);out['new_object_bytes']=sum(v['bytes'] for v in row['new_objects']);out['native']=row['native']['categories'];out['dirty_units']=[]
    if row['stage']=='first-edit':
      for command in row['native']['commands']:
        if command['kind']!='unit':continue
        for item in command['inputs']:
          if not item['bitcode'] or 'saved' not in item:continue
          ir=subprocess.check_output(['/workspace/silk/.scratch/llvm-22.1.8/bin/llvm-dis',item['saved'],'-o','-'],text=True)
          files={};subs={};definitions=[];declares=[];types=0
          for line in ir.splitlines():
            f=re.match(r'^!(\d+) = !DIFile\(filename: "((?:\\.|[^"])*)", directory: "((?:\\.|[^"])*)"',line)
            if f:files[int(f[1])]=str(Path(f[3])/f[2])
            s=re.match(r'^!(\d+) = (?:distinct )?!DISubprogram\((.*)',line)
            if s:
              named=re.search(r'(?<![A-Za-z])name: "((?:\\.|[^"])*)"',s[2]);file=re.search(r'file: !(\d+)',s[2])
              subs[int(s[1])]={'name':named[1] if named else None,'file_id':int(file[1]) if file else None}
            if line.startswith('define '):definitions.append(line)
            if line.startswith('declare '):declares.append(line)
            if re.match(r'^%.* = type ',line):types+=1
          members=[];module_counts=collections.Counter()
          for line in definitions:
            symbol=re.search(r'@("(?:\\.|[^"])*"|[^ (]+)\(',line);dbg=re.search(r'!dbg !(\d+)',line)
            sub=subs.get(int(dbg[1]),{}) if dbg else {};file=files.get(sub.get('file_id'),'[no source debug file]')
            module_counts[file]+=1;members.append({'symbol':symbol[1] if symbol else None,'name':sub.get('name'),'file':file})
          report={'bitcode':item['saved'],'bytes':item['bytes'],'definitions':len(definitions),'declarations':len(declares),'named_types':types,'modules':dict(module_counts.most_common()),'members':members}
          out['dirty_units'].append(report)
    summary.append(out)
(root/'native-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
lines=['# Exact-V11 global packing diagnostic','',
 'CPU0, explicit serial policy; global packing is the only compiler feature toggle. Python wrapper startup biases cold total time per invocation, so cold totals are diagnostic-only. Native child times exclude Python startup. Edited captures additionally hash/copy their small dirty bitcode; that capture overhead is recorded separately.','',
 '| Workload | Packing | Stage | Total / settled s | New objects / bytes | Native unit count / bitcode bytes / CPU s / wall sum s | Link count / CPU s / wall sum s |',
 '|---|---|---|---:|---:|---:|---:|']
for r in summary:
 u=r['native'].get('unit',{});l=r['native'].get('link',{})
 lines.append(f"| {r['workload']} | {r['packing']} | {r['stage']} | {r['wall_s']:.3f} / {r['settled_wall_s']:.3f} | {r['new_object_count']} / {r['new_object_bytes']} | {u.get('count',0)} / {u.get('bitcode_bytes',0)} / {u.get('cpu_s',0):.3f} / {u.get('wall_s',0):.3f} | {l.get('count',0)} / {l.get('cpu_s',0):.3f} / {l.get('wall_s',0):.3f} |")
for r in summary:
 if not r['dirty_units']:continue
 lines+=['',f"## {r['workload']} {r['packing']} dirty membership",'']
 for unit in r['dirty_units']:
  lines.append(f"{unit['definitions']} definitions; {unit['declarations']} declarations; {unit['named_types']} named types; {unit['bytes']} bitcode bytes.")
  for file,count in unit['modules'].items():lines.append(f'- {file}: {count} definitions')
(root/'REPORT.md').write_text('\n'.join(lines)+'\n');print(root/'REPORT.md')
