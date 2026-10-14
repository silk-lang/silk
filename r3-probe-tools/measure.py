"""Alternating clean/candidate one-shot LLVM-IR builds of the same clean source; paired medians."""
import json, os, statistics, subprocess, sys, time
clean, cand, pairs, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
src = '/home/user/silk/.scratch/clean'
cpu = os.environ.get('PIN_CPU')
def steal(c):
    for line in open('/proc/stat'):
        f = line.split()
        if f[0] == f'cpu{c}': return int(f[8]) / os.sysconf('SC_CLK_TCK'), (int(f[1]) + int(f[3])) / os.sysconf('SC_CLK_TCK')
    return 0.0, 0.0
def busy():
    ps = subprocess.run(['ps', '-eo', 'comm'], capture_output=True, text=True).stdout.split()
    return [p for p in ps if p in ('node', 'clang', 'cand', 'clean', 'silkc', 'probe', 'probe2', 'cand-corpus')]
def run(producer):
    while os.getloadavg()[0] >= 1.0 or busy():
        time.sleep(10)
    load = os.getloadavg()[0]
    args = [producer, 'build', f'{src}/compiler/src/main.silk', '-o', f'/home/user/silk/.scratch/measure-{os.path.basename(producer)}.ll', '--stdlib', f'{src}/packages/compiler/stdlib',
            '--optimization', 'speed', '--debug', 'false', '--emit', 'llvm-ir']
    if cpu is not None: args = ['taskset', '-c', cpu] + args
    s0 = steal(cpu or 1)
    start = time.monotonic()
    p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    _, status, usage = os.wait4(p.pid, 0)
    wall = time.monotonic() - start
    s1 = steal(cpu or 1)
    assert status == 0, status
    return {'wall': round(wall, 3), 'user': round(usage.ru_utime, 6), 'rssKiB': usage.ru_maxrss, 'load': round(load, 3),
            'steal': round(s1[0] - s0[0], 2), 'userSystem': round(s1[1] - s0[1], 2)}
samples = []
for i in range(pairs):
    a = run(clean); b = run(cand)
    samples.append({'clean': a, 'cand': b})
    print(json.dumps(samples[-1]), flush=True)
d = {k: [s['cand'][k] - s['clean'][k] for s in samples] for k in ('wall', 'user', 'rssKiB')}
summary = {k: statistics.median(v) for k, v in d.items()}
json.dump({'samples': samples, 'deltas': d, 'median': summary}, open(out, 'w'), indent=1)
print('median', summary)
