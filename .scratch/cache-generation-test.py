import ctypes
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time

scratch = Path('/workspace/silk/.scratch')
tree = scratch/'incremental-cache-segments'
log = scratch/'cache-generation-test.log'
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
env = {k: v for k, v in os.environ.items() if not k.startswith('SILK_') and k not in ('LLVM_PROFILE_FILE', 'LD_PRELOAD')}
env['SILK_CLANG'] = str(scratch/'llvm-22.1.8/bin/clang')
command = [str(scratch/'ci-n1-4a1fa332/N1'), 'test', str(tree/'compiler/src/semantic/CacheGenerationCases.silk'),
           '--stdlib', str(tree/'stdlib'), '--filter', 'generation', '--optimization', 'none',
           '--debug', 'false', '--output', str(scratch/'cache-generation-test'), '--no-cache']
with (scratch/'performance.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_SH)
    started = time.monotonic()
    with log.open('wb') as stream:
        result = subprocess.run(command, cwd=tree, env=env, stdout=stream, stderr=subprocess.STDOUT)
    reaped = []
    while True:
        try:
            pid, status = os.waitpid(-1, 0)
            reaped.append({'pid': pid, 'exit': os.waitstatus_to_exitcode(status)})
        except ChildProcessError:
            break
    report = {'command': command, 'log': str(log), 'exit': result.returncode,
              'elapsed_s': time.monotonic()-started, 'reaped': reaped,
              'scope': 'Pure generation authority and bounded codec; segment production source frozen during the test.'}
    (scratch/'cache-generation-test.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report), flush=True)
    print(log.read_text()[-5000:], flush=True)
    assert result.returncode == 0 and all(row['exit'] == 0 for row in reaped)
    assert '4 passed, 0 failed (0 cached, 4 executed, 4 selected,' in log.read_text()
