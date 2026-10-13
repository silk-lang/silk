import json,os,resource,subprocess,sys,time
from pathlib import Path
base=Path(sys.argv[1]);command=sys.argv[2:]
with base.with_suffix('.log').open('w') as log:
 started=time.monotonic();proc=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT);_,status,usage=os.wait4(proc.pid,0);code=os.waitstatus_to_exitcode(status);proc.returncode=code
row={'command':command,'exit':code,'wallSeconds':round(time.monotonic()-started,3),'userSeconds':usage.ru_utime,'systemSeconds':usage.ru_stime,'peakRSSKiB':usage.ru_maxrss}
base.with_suffix('.time.json').write_text(json.dumps(row,indent=2)+'\n');print(json.dumps(row));raise SystemExit(code)
