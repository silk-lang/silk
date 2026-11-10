#!/usr/bin/env python3
"""Tiny trace/ELF/runtime parity gate. Caller holds scheduled shared performance lock."""
import argparse,hashlib,json,os,re,shutil,subprocess,tempfile
from pathlib import Path
S=Path('/workspace/silk/.scratch');HERE=Path(__file__).resolve().parent

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def validate_events(path,launch):
 raw=path.read_text();events=[]
 pattern=re.compile(r'^cpu0-cache (.+) at_ns=(\d+) pid=(\d+) tid=(\d+) ns=(\d+) a=(\d+) b=(\d+) c=(\d+)$')
 for line in raw.splitlines():
  m=pattern.fullmatch(line)
  if not m:raise AssertionError(('malformed event: missing evidence',line))
  label,at,pid,tid,ns,a,b,c=m.groups();e=dict(label=label,at_ns=int(at),pid=int(pid),tid=int(tid),ns=int(ns),a=int(a),b=int(b),c=int(c))
  assert e['pid']>0 and e['tid']>0 and launch['start_ns']<=e['at_ns']<=launch['settled_ns'],e
  events.append(e)
 coordinators={e['pid'] for e in events if e['label']=='native-coordinator-work-begin'}
 assert coordinators and launch['root_pid'] not in coordinators,coordinators
 # These events occur after silenceChild. Their presence proves the explicit trace fd survived.
 native=[e for e in events if e['label'].startswith('native-')]
 jobs={}
 for e in native:
  if e['label'] in {f'native-{phase}-{end}' for phase in ['job','bitcode','write','clang'] for end in ['begin','end']}:
   key=(e['pid'],e['tid'],e['a']);bucket=jobs.setdefault(key,{})
   assert e['label'] not in bucket,('duplicate/unpairable stage',key,e['label'])
   bucket[e['label']]=e
 assert jobs
 for key,stages in jobs.items():
  assert key[0] in coordinators,('job outside coordinator',key)
  order=['job-begin','bitcode-begin','bitcode-end','write-begin','write-end','clang-begin','clang-end','job-end']
  selected=[stages['native-'+label] for label in order]
  assert all(a['at_ns']<=b['at_ns'] for a,b in zip(selected,selected[1:])),key
  assert stages['native-clang-end']['b']==0,key
 labels={e['label'] for e in native}
 for name in ['native-save-checkpoint-begin','native-save-checkpoint-end','native-cache-checkpoint','native-wait-begin','native-wait-end','native-promote-begin','native-promote-end','native-cache-completed']:assert name in labels,name
 return dict(event_count=len(events),native_event_count=len(native),native_jobs=len(jobs),coordinator_pids=sorted(coordinators),all_intervals_paired=True,trace_fd_survives_silence=True,nonzero_process_thread_clock=True)

def main():
 p=argparse.ArgumentParser();p.add_argument('--candidate',type=Path,required=True);p.add_argument('--tree',type=Path,required=True);p.add_argument('--reference',type=Path,default=S/'frontier-native-work-v22');a=p.parse_args()
 assert shutil.disk_usage(S).free>=900*1024*1024,'hold: less than900MiB free'
 root=Path(tempfile.mkdtemp(prefix='native-trace-v24-',dir=S/'benchmarks'));work=root/'fixture';(work/'src').mkdir(parents=True)
 (work/'silk.toml').write_text('[package]\nname="native-phase-gate"\nversion="0.0.0"\n')
 text=(a.tree/'corpus/native/raw-buffer-resize-preserves-elements/main.silk').read_text().replace('pub fn main() -> i32','fn storageMain() -> i32')
 names=['pad'+str(i).zfill(2) for i in range(40)]
 for name in names:(work/'src'/(name+'.silk')).write_text('pub fn answer() -> i32 { return 0 }\n')
 (work/'src/main.silk').write_text('\n'.join('import '+n for n in names)+'\n'+text+'\npub fn main() -> i32 { return storageMain() + '+' + '.join(n+'.answer()' for n in names)+' }\n')
 environment={k:'1' for k in ['SILK_RETAINED_CACHE','SILK_FRONTIER_EPHEMERAL','SILK_EXPERIMENT_FRONTIER','SILK_FRONTIER_SHARED','SILK_FRONTIER_FORK_PRIVATE','SILK_FRONTIER_CHUNKS','SILK_RETAINED_BUILD','SILK_EXPERIMENT_DEV_PACKS','SILK_NATIVE_BUILD_PIPELINE']}
 # Only a correctness fixture: lower the useful-work threshold, never host capacity admission.
 environment.update(SILK_FRONTIER_WARM='0',SILK_CLANG=str(S/'llvm-22.1.8/bin/clang'))
 metadata=dict(purpose='Native trace correctness only; no performance claim',candidate=str(a.candidate),candidate_sha256=sha(a.candidate),reference=str(a.reference),reference_sha256=sha(a.reference),source=subprocess.check_output(['git','-C',str(a.tree),'rev-parse','HEAD'],text=True).strip(),fixture_sha256=sha(work/'src/main.silk'),runner_sha256=sha(__file__),launcher_sha256=sha(HERE/'launch-native-phases.py'),environment=environment,cpus=[0,1,2,3])
 (root/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n');print(root,flush=True);rows=[]
 for label,binary,traced in [('reference',a.reference,False),('disabled',a.candidate,False),('enabled',a.candidate,True)]:
  stage=root/label;stage.mkdir();env=dict(environment)
  if traced:env['SILK_CPU0_CACHE_TRACE']='1'
  command=[str(binary),'build','--stdlib',str(a.tree/'stdlib'),'--progress','plain','--timings']
  spec=dict(command=command,cwd=str(work),cpus=[0,1,2,3],original_ld_library_path=os.environ.get('LD_LIBRARY_PATH'),environment=env)
  (stage/'spec.json').write_text(json.dumps(spec,indent=2)+'\n')
  result=subprocess.run(['python3',str(HERE/'launch-native-phases.py'),str(stage)],timeout=150)
  launch=json.loads((stage/'launch.json').read_text())
  assert result.returncode==launch['exit_code']==0 and all(d['exit_code']==0 for d in launch['detached'])
  log=(stage/'compiler.log').read_text()
  for marker in ['frontier accepted','frontier artifact proved','frontier artifact accepted','frontier native coordinator started','frontier native objects published','frontier native cache completed']:assert marker in log,(label,marker)
  assert 'host capacity refused' not in log and 'artifact refused' not in log
  assert 'cpu0-cache ' not in log,'dedicated FD events leaked into stderr'
  trace=validate_events(stage/'native-phases.log',launch) if traced else dict(disabled_empty=(stage/'native-phases.log').stat().st_size==0)
  if not traced:assert trace['disabled_empty']
  artifact=work/'build/llvm/x86_64-unknown-linux-gnu/debug/native-phase-gate';out=stage/'artifact';shutil.copy2(artifact,out)
  ran=subprocess.run([str(out)],capture_output=True,timeout=10);(stage/'runtime.stdout').write_bytes(ran.stdout);(stage/'runtime.stderr').write_bytes(ran.stderr)
  assert ran.returncode==42 and not ran.stdout and not ran.stderr
  row=dict(stage=label,artifact_sha256=sha(out),runtime_exit=ran.returncode,trace=trace,processes=launch);rows.append(row)
  (root/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
  # Fresh caches for each parity build, preserving per-file receipts and generated executable.
  files=[dict(path=str(f.relative_to(work)),bytes=f.stat().st_size,sha256=sha(f)) for f in sorted((work/'build').rglob('*')) if f.is_file()]
  (stage/'completed-build-files.json').write_text(json.dumps(files,indent=2)+'\n');shutil.rmtree(work/'build')
 assert len({r['artifact_sha256'] for r in rows})==1,'diagnostic flags/compiler changed artifact bytes'
 (root/'passed.json').write_text(json.dumps(dict(native_builds=3,artifact_byte_parity=True,disabled_empty=True,enabled_trace=rows[-1]['trace'],all_processes_reaped=True),indent=2)+'\n')
 print('PASS '+str(root),flush=True)
if __name__=='__main__':main()
