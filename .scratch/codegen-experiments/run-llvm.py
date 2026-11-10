import json, resource, subprocess, sys, time
from pathlib import Path
base=Path('/workspace/silk/.scratch/codegen-experiments')
mode=sys.argv[1]
command=json.loads((base/'mono-command.json').read_text())
args=command['argv']
args[args.index('-o')+1]=str(base/('compiler-'+mode))
if mode == 'full4':
    args[args.index('-O2')]='-O0'
    args += ['-flto=full', '-Wl,--lto-O2,--lto-partitions=4', '-Wl,--time-trace='+str(base/'full4.trace.json')]
    for flag in ['-enable-tail-merge=false','-unroll-runtime=false','-x86-cmov-converter=false','-mattr=+sse2']:
        args += ['-Xlinker','-mllvm','-Xlinker',flag]
elif mode == 'mono':
    args += ['-ftime-report']
else:
    raise SystemExit('supported modes: full4, mono')
(base/(mode+'.argv.json')).write_text(json.dumps(args,indent=2))
start=time.monotonic()
with (base/(mode+'.log')).open('w') as log:
    p=subprocess.run(args,cwd=command['cwd'],stdout=log,stderr=subprocess.STDOUT)
r=resource.getrusage(resource.RUSAGE_CHILDREN)
result={'mode':mode,'wall':time.monotonic()-start,'user':r.ru_utime,'sys':r.ru_stime,'rss_kb':r.ru_maxrss,'returncode':p.returncode}
(base/(mode+'.result.json')).write_text(json.dumps(result,indent=2))
print(json.dumps(result),flush=True)
raise SystemExit(p.returncode)
