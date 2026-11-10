#!/usr/bin/env python3
import ctypes,json,os,subprocess,sys,time
from pathlib import Path
root=Path(sys.argv[1]);spec=json.loads((root/'spec.json').read_text())
env=dict(os.environ)
for key in list(env):
 if key.startswith(('SILK_FRONTIER_','SILK_EXPERIMENT_','SILK_RETAINED_','SILK_POSTCHECK_','SILK_ARTIFACT_','SILK_FINITE_','SILK_PROMOTION_')):env.pop(key)
env.pop('LD_LIBRARY_PATH',None)
if spec['original_ld_library_path'] is not None:env['LD_LIBRARY_PATH']=spec['original_ld_library_path']
env.update(spec['environment']);os.sched_setaffinity(0,set(spec['cpus']))
libc=ctypes.CDLL(None,use_errno=True);assert libc.prctl(36,1,0,0,0)==0
meta={'launcher_pid':os.getpid(),'start_ns':time.monotonic_ns()}
child=subprocess.Popen(spec['command'],cwd=spec['cwd'],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
meta['root_pid']=child.pid
(root/'launch.json').write_text(json.dumps(meta,indent=2)+'\n')
with (root/'compiler.log').open('wb') as log,(root/'trace-arrival.jsonl').open('w') as trace:
 for line in child.stdout:
  now=time.monotonic_ns();log.write(line)
  trace.write(json.dumps({'ns':now,'line':line.decode('utf8','replace').rstrip('\n')})+'\n')
child.stdout.close()
_,status,usage=os.wait4(child.pid,0);child.returncode=os.waitstatus_to_exitcode(status)
meta.update(root_wait_ns=time.monotonic_ns(),exit_code=child.returncode,root_inclusive_user=usage.ru_utime,root_inclusive_sys=usage.ru_stime,detached=[])
while True:
 try:
  pid,status,usage=os.wait4(-1,0)
  meta['detached'].append(dict(pid=pid,exit_code=os.waitstatus_to_exitcode(status),user=usage.ru_utime,sys=usage.ru_stime,wait_ns=time.monotonic_ns()))
 except ChildProcessError:break
meta['settled_ns']=time.monotonic_ns()
(root/'launch.json').write_text(json.dumps(meta,indent=2)+'\n')
sys.exit(child.returncode)
