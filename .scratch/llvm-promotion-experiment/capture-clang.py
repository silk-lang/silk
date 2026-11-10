#!/usr/bin/env python3
"""SILK_CLANG wrapper: record native calls; never change Clang arguments.
SILK_PROMOTION_CAPTURE_FILES=all (replay capture), bitcode (dirty packs), or
none (low-overhead command/size/resource diagnosis; no full input hashing).
"""
import hashlib, json, os, shutil, subprocess, sys, time
from pathlib import Path
# NativeToolchain intentionally allowlists child environment variables. The
# fixed sidecar is atomically replaced by the harness between settled stages;
# no product environment whitelist change or wrapper rewrite is necessary.
sidecar = Path(__file__).with_name('capture-clang.config.json')
config = json.loads(sidecar.read_text()) if sidecar.exists() else {}
root = Path(os.environ.get('SILK_PROMOTION_CAPTURE') or config['capture']).resolve()
real = os.environ.get('SILK_PROMOTION_CLANG') or config['clang']
mode = os.environ.get('SILK_PROMOTION_CAPTURE_FILES') or config.get('mode','all')
assert mode in {'all','bitcode','none'}, mode
(root / 'files').mkdir(parents=True, exist_ok=True)
(root / 'commands').mkdir(exist_ok=True)
args = sys.argv[1:]
output_index = args.index('-o') + 1 if '-o' in args else None
record = {'argv': [real, *args], 'cwd': os.getcwd(), 'start_ns': time.monotonic_ns(),
          'inputs': [], 'cpus': sorted(os.sched_getaffinity(0)), 'capture_files': mode}
for index, arg in enumerate(args):
    if index == output_index:
        continue
    prefix = '--version-script=' if arg.startswith('--version-script=') else ''
    value = arg[len(prefix):]
    if value.startswith('-') or not Path(value).is_file():
        continue
    path = Path(value).resolve()
    with path.open('rb') as stream:
        magic = stream.read(4)
    bitcode = magic == b'BC\xc0\xde'
    item = {'index': index, 'prefix': prefix, 'original': str(path),
            'bytes': path.stat().st_size, 'bitcode': bitcode}
    if mode == 'all' or (mode == 'bitcode' and bitcode):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        saved = root / 'files' / digest
        if not saved.exists():
            temp = saved.with_name(digest + '.' + str(os.getpid()))
            shutil.copyfile(path, temp)
            os.replace(temp, saved)
        item.update(saved=str(saved), sha256=digest)
    record['inputs'].append(item)
if output_index is not None:
    record['output'] = str(Path(args[output_index]).resolve())
record['argv_sha256'] = hashlib.sha256(json.dumps(record['argv'], separators=(',', ':')).encode()).hexdigest()
record['launch_ns'] = time.monotonic_ns()
child = subprocess.Popen([real, *args])
_, status, usage = os.wait4(child.pid,0)
child.returncode = os.waitstatus_to_exitcode(status)
record.update(exit_code=child.returncode, finish_ns=time.monotonic_ns(),
              user_s=usage.ru_utime, sys_s=usage.ru_stime, max_individual_rss_kib=usage.ru_maxrss,
              child_pid=child.pid)
record['native_wall_s']=(record['finish_ns']-record['launch_ns'])/1e9
record['capture_before_native_s']=(record['launch_ns']-record['start_ns'])/1e9
(root / 'commands' / (str(record['start_ns']) + '-' + str(os.getpid()) + '.json')).write_text(json.dumps(record, indent=2) + '\n')
sys.exit(child.returncode)
