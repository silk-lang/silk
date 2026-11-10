"""Run under the exclusive performance lock; each trial has an empty build cache."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys

scratch = Path('/workspace/silk/.scratch')
root = scratch / 'benchmarks/transport-family-ctvjs_tx'
candidate = scratch / 'chunk-candidate-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler'
baseline = scratch / 'N0-one'
spec = importlib.util.spec_from_file_location('cold', scratch / 'benchmarks/cold_bench.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)
rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 1
results = []
os.sched_setaffinity(0, {0, 1, 2, 3})
for workload in ['compiler', 'harfrust']:
    source = root / ('silk' if workload == 'compiler' else 'nonstd')
    cwd = source if workload == 'compiler' else source / 'fonts/shape/tools/cli'
    for round in range(rounds):
        modes = ['ephemeral', 'chunks']
        if round % 2:
            modes.reverse()
        for mode in modes:
            shutil.rmtree(source / 'build', ignore_errors=True)
            compiler = baseline if mode == 'baseline' else candidate
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(('SILK_FRONTIER_', 'SILK_EXPERIMENT_', 'SILK_POSTCHECK_', 'SILK_FINITE_'))}
            if mode in ['ephemeral', 'chunks']:
                env.update(SILK_EXPERIMENT_FRONTIER='1', SILK_FRONTIER_SHARED='1')
            if mode in ['ephemeral', 'chunks']:
                env['SILK_FRONTIER_EPHEMERAL'] = '1'
            if mode == 'chunks':
                env['SILK_FRONTIER_CHUNKS'] = '1'
            tag = f'declaration-chunks-{workload}-{round}-{mode}'
            command = [str(compiler), 'check']
            if workload == 'compiler':
                command += ['--package', 'silk-compiler']
            command += ['--stdlib', str(root / 'silk/stdlib'), '--progress', 'plain', '--timings']
            result = bench.measure(command, cwd, env, scratch / f'{tag}.log')
            log = (scratch / f'{tag}.log').read_text()
            result.update(workload=workload, mode=mode, round=round,
                          sha256=hashlib.sha256(compiler.read_bytes()).hexdigest(),
                          accepted='frontier accepted' in log,
                          ephemeral_workers=log.count('frontier worker-ephemeral '),
                          cpu_affinity=sorted(os.sched_getaffinity(0)),
                          chunks=log.count('frontier declaration chunk '))
            results.append(result)
            (scratch / 'declaration-chunks-comparison.json').write_text(json.dumps(results, indent=2) + '\n')
            print(json.dumps(result), flush=True)
            assert result['exit_code'] == 0 and all(item['exit_code'] == 0 for item in result['detached']), tag
            if mode in ['ephemeral', 'chunks']:
                assert result['accepted'], tag + ': parallel graph not accepted'
            if mode in ['ephemeral', 'chunks']:
                assert result['ephemeral_workers'] == 4, tag + ': workers did not freeze'

