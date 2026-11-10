#!/usr/bin/env python3
"""Separate Linux process-tree memory audit; do not use its wall time as a benchmark."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import subprocess
import time


def sample(root):
    parents = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            parents[int(entry.name)] = int(fields[1])
        except (OSError, ValueError, IndexError):
            pass
    selected = {root}
    while True:
        following = selected | {pid for pid, parent in parents.items() if parent in selected}
        if following == selected:
            break
        selected = following
    pss = rss = read = 0
    for pid in selected - {root}:
        try:
            values = {}
            for line in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines():
                name, _, value = line.partition(':')
                if name in ('Pss', 'Rss'):
                    values[name] = int(value.split()[0])
            pss += values.get('Pss', 0)
            rss += values.get('Rss', 0)
            read += 1
        except (OSError, ValueError, IndexError):
            pass
    return {'pss_kib': pss, 'rss_kib': rss, 'readable_processes': read}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--log', type=Path, required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('a command is required')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0):
        raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER')
    peak_pss = peak_rss = count = 0
    peak_sample = None
    exits = []
    with args.log.open('wb') as log:
        child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                 stdin=subprocess.DEVNULL)
        while True:
            current = sample(os.getpid())
            count += 1
            if current['pss_kib'] > peak_pss:
                peak_pss = current['pss_kib']
                peak_sample = current
            peak_rss = max(peak_rss, current['rss_kib'])
            try:
                while True:
                    pid, status, _ = os.wait4(-1, os.WNOHANG)
                    if pid == 0:
                        break
                    code = os.waitstatus_to_exitcode(status)
                    exits.append({'pid': pid, 'exit_code': code})
                    if pid == child.pid:
                        child.returncode = code
            except ChildProcessError:
                break
            time.sleep(0.1)
    print(json.dumps({'command': command, 'sample_interval_s': 0.1, 'samples': count,
                      'peak_aggregate_pss_kib': peak_pss,
                      'peak_aggregate_rss_kib': peak_rss,
                      'at_peak_pss': peak_sample, 'exits': exits,
                      'note': 'Sampled PSS apportions shared pages; summed RSS double counts them. '
                              'Brief peaks may be missed; memory reads are not simultaneous.'}))


if __name__ == '__main__':
    main()
