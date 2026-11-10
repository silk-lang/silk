#!/usr/bin/env python3
"""Scheduled attribution: one CPU, retained cache, intentional settlement before each stage.
Not an immediate-edit performance benchmark. Preserves source/cache and all raw evidence.
"""
import argparse,fcntl,hashlib,json,os,re,shutil,subprocess,sys,time
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--binary',type=Path,required=True)
p.add_argument('--compiler-source',required=True)
p.add_argument('--operation',choices=['check','build'],default='check')
p.add_argument('--control',action='store_true',help='Keep phase events; omit perf sampling')
p.add_argument('--query-census',action='store_true')
p.add_argument('--stack-bytes',type=int,choices=[0,8192,32768],default=32768)
p.add_argument('--name',default='cpu0-cache-sequence')
a=p.parse_args()
here=Path(__file__).resolve().parent;s=here.parent
assert 0 in os.sched_getaffinity(0),'CPU0 unavailable; do not silently substitute affinity'
lock=(s/'performance.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX)
cold_command=[sys.executable,str(here/'v22-native-phases.py'),'--binary',str(a.binary.resolve()),'--compiler-source',a.compiler_source,'--cpus','0','--operation',a.operation,'--name',a.name,'--stack-bytes',str(a.stack_bytes)]
if a.control:cold_command.append('--control')
if a.query_census:cold_command.append('--query-census')
# The existing cold launcher is a subreaper and returns only after its compiler AND writers settle.
result=subprocess.run(cold_command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
print(result.stdout,end='',flush=True)
if result.returncode:raise SystemExit(result.returncode)
roots=[Path(line) for line in result.stdout.splitlines() if line.startswith(str(s/'benchmarks')+'/')]
assert len(roots)==1,roots
root=roots[0];spec=json.loads((root/'spec.json').read_text());launch=json.loads((root/'launch.json').read_text())
assert spec['cpus']==[0] and launch['settled_ns']>=launch['root_wait_ns']
shutil.copy2(__file__,root/'sequence-runner.py')
source=Path(spec['cwd']);edited=source/'compiler/src/main.silk';original=edited.read_bytes()
needle=b'Create a package or a workspace\\n';replacement=b'Create a package or a workspace (revision one)\\n'
assert original.count(needle)==1
(root/'original-main.bin').write_bytes(original)
metadata={'purpose':'Intentional settled CPU0 attribution; no immediate-edit or baseline speed claim','sequence':['cold','first-edit','unchanged'],'original_sha256':hashlib.sha256(original).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'cold_runner_sha256':hashlib.sha256((here/'v22-native-phases.py').read_bytes()).hexdigest(),'stages':[]}
(root/'sequence.json').write_text(json.dumps(metadata,indent=2)+'\n')
perf=str(s/'profilers/root/usr/bin/perf');env=dict(os.environ,LD_LIBRARY_PATH=str(s/'profilers/root/usr/lib/x86_64-linux-gnu'),DEBUGINFOD_URLS='')
pattern=re.compile(r'^cpu0-cache (.*?) at_ns=(\d+) pid=(\d+) tid=(\d+) ns=(\d+) a=(\d+) b=(\d+) c=(\d+)$')
def receipt(directory,stage):
    launch=json.loads((directory/'launch.json').read_text())
    assert launch['exit_code']==0 and all(x['exit_code']==0 for x in launch['detached'])
    text=(directory/'compiler.log').read_text()
    assert 'frontier split ' not in text and 'frontier accepted' not in text and 'frontier native coordinator started' not in text
    # Warm reuse may not ask host eligibility at all. Cold must prove automatic refusal.
    if stage=='cold':assert 'frontier host capacity refused' in text
    rows=[]
    for line in (directory/'native-phases.log').read_text().splitlines():
        m=pattern.fullmatch(line)
        if m:rows.append(dict(zip(['label','at_ns','pid','tid','ns','a','b','c'],[m[1],*map(int,m.groups()[1:])])) )
    assert rows,'missing phase events'
    # Each save snapshot is cumulative; retain last per PID/label, never sum them.
    snapshots={}
    for row in rows:
        if row['label'].startswith(('green-','budget-','directory-')):snapshots[(row['pid'],row['label'])]=row
    out={'stage':stage,'directory':str(directory),'source_sha256':hashlib.sha256(edited.read_bytes()).hexdigest(),'launch':launch,'phase_records':len(rows),'last_cumulative_snapshots':list(snapshots.values()),'phase_labels':sorted({r['label'] for r in rows})}
    (directory/'phase-events.json').write_text(json.dumps(rows,indent=2)+'\n')
    return out
metadata['stages'].append(receipt(root,'cold'))
previous=launch['settled_ns']
for stage in ('first-edit','unchanged'):
    if shutil.disk_usage(s).free<900*1024*1024:raise SystemExit(f'STOP disk below900MiB; preserved {root}')
    if stage=='first-edit':edited.write_bytes(original.replace(needle,replacement))
    assert replacement in edited.read_bytes()
    stage_root=root/stage;stage_root.mkdir()
    stage_spec={**spec,'sequence_stage':stage,'previous_settled_ns':previous,'launch_after_settlement_ns':time.monotonic_ns(),'edited_source_sha256':hashlib.sha256(edited.read_bytes()).hexdigest()}
    assert stage_spec['launch_after_settlement_ns']>=previous
    (stage_root/'spec.json').write_text(json.dumps(stage_spec,indent=2)+'\n')
    command=[sys.executable,str(root/'launcher.py'),str(stage_root)]
    if not a.control:command=[perf,'record','-e','cpu-clock:u','-F','99','--clockid','mono','--no-bpf-event','-B','-N',*(['--user-callchains','--call-graph',f'dwarf,{a.stack_bytes}'] if a.stack_bytes else []),'-o',str(stage_root/'perf.data'),'--',*command]
    (stage_root/'perf-command.json').write_text(json.dumps(command,indent=2)+'\n')
    os.sched_setaffinity(0,{0})
    with (stage_root/'perf.log').open('wb') as log:run=subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT)
    if run.returncode:raise SystemExit(f'FAILED {stage}; preserved {root}')
    if not a.control:
        with (stage_root/'samples.txt').open('wb') as output:subprocess.run([perf,'script','-G','--ns','-i',str(stage_root/'perf.data'),'-F','comm,pid,tid,time,event,ip,sym,dso,period'],env=env,stdout=output,check=True)
    if not a.control and a.stack_bytes:
        with (stage_root/'stack-samples.txt').open('wb') as output:subprocess.run([perf,'script','--ns','-i',str(stage_root/'perf.data'),'-F','comm,pid,tid,time,event,ip,sym,dso,period'],env=env,stdout=output,check=True)
    row=receipt(stage_root,stage);previous=row['launch']['settled_ns'];metadata['stages'].append(row)
    (root/'sequence.json').write_text(json.dumps(metadata,indent=2)+'\n')
    print(json.dumps({'stage':stage,'root':str(stage_root),'settled':True}),flush=True)
metadata['complete']=True
(root/'sequence.json').write_text(json.dumps(metadata,indent=2)+'\n')
print('Sequence complete; retained source/cache: '+str(root),flush=True)
