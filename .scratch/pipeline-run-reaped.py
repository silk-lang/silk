import ctypes, os, subprocess, sys
if ctypes.CDLL(None).prctl(36,1,0,0,0):raise RuntimeError('subreaper unavailable')
result=subprocess.run(sys.argv[1:]);children=[]
while True:
 try:
  pid,status=os.waitpid(-1,0);children.append((pid,os.waitstatus_to_exitcode(status)))
 except ChildProcessError:break
print('reaped',children,flush=True)
sys.exit(result.returncode)
