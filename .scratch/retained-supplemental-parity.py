#!/usr/bin/env python3
"""Prepare/run focused generated-compiler parity; no compiler runs with --prepare-only.

Run only in a coordinated slot:
  flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/retained-supplemental-parity.py
Uses corpus expectations, never byte equality of compiler outputs as a correctness oracle.
"""
from pathlib import Path
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile

SOURCE = Path('/workspace/silk-retained-build')
ORIGIN = Path('/workspace/silk/.scratch/benchmarks/retained-build-pkntu63d')
PARENT = Path('/workspace/silk/.scratch/benchmarks')
INVALID = [
    'effect-generic-environment-escape',
    'closure-capture-store-alias',
    'closure-capture-store-expired',
    'returned-callable-effect-keeps-view',
    'callable-annotation-keeps-exact-type',
    'effect-callback-shared-result',
]
# Prefix vs suffix changes declaration-check order while leaving main and its inputs intact.
# These are parity probes; no claim is made that either edit necessarily changes the chosen
# representative without tracing it. Both forms must satisfy the original corpus oracle.
METAMORPHIC = {
    'callable-value-shortening': '''
fn parityUnusedFirst() -> i32 {
  let local = 9
  return applyValue(widen, local) + applyValue(same, local) + applyNamedValue(local)
}
''',
    'local-shared-nested-owned-result-cleanup': '''
effect fn parityUnusedFirst() -> i32 ! OutOfMemoryError ? &mut Allocator {
  return run exercise()
}
''',
}


def diagnostics(path):
    result = []
    for line in path.read_text(errors='replace').splitlines():
        if line.strip():
            result.append(json.loads(line))
    return result


def codes(value):
    found = []
    if isinstance(value, dict):
        code = value.get('code')
        if isinstance(code, str):
            found.append(code)
        for key, child in value.items():
            if key != 'code':
                found.extend(codes(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(codes(child))
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix='supplemental-parity-', dir=PARENT))
    Path('/workspace/silk/.scratch/retained-supplemental-root.txt').write_text(str(root))
    specs = []
    for case in INVALID:
        specs.append({'id': case, 'source': 'invalid/' + case, 'variant': 'original', 'negative': True})
    for case in METAMORPHIC:
        for variant in ('prefix', 'suffix'):
            specs.append({'id': case + '-' + variant, 'source': 'native/' + case,
                          'variant': variant, 'negative': False})
    for spec in specs:
        work = root / spec['id']
        shutil.copytree(SOURCE / 'corpus' / spec['source'], work / 'src')
        (work / 'silk.toml').write_text('[package]\nname = "supplemental-parity"\nversion = "0.0.0"\n')
        expected = json.loads((work / 'src' / 'outcome.json').read_text())['expected']
        spec['expected'] = expected
        if spec['variant'] != 'original':
            main_file = work / 'src' / 'main.silk'
            text = main_file.read_text()
            extra = METAMORPHIC[spec['source'].split('/', 1)[1]]
            if spec['variant'] == 'prefix':
                # Preserve initial imports/comments. Both source fixtures contain this marker.
                marker = '\nfn '
                where = text.find(marker)
                if where < 0:
                    raise RuntimeError('fixture has no top-level function insertion point')
                text = text[:where] + '\n' + extra + text[where:]
            else:
                text += '\n' + extra
            main_file.write_text(text)
    (root / 'manifest.json').write_text(json.dumps(specs, indent=2))
    print('Prepared', root, flush=True)
    if args.prepare_only:
        return

    bench_spec = importlib.util.spec_from_file_location('cold', '/workspace/silk/.scratch/benchmarks/cold_bench.py')
    bench = importlib.util.module_from_spec(bench_spec)
    bench_spec.loader.exec_module(bench)
    env = dict(os.environ, SILK_CLANG='/workspace/silk/.scratch/llvm-22.1.8/bin/clang')
    for key in list(env):
        if key.startswith('SILK_EXPERIMENT') or key in (
            'SILK_POSTCHECK_BUILD', 'SILK_FINITE_ARTIFACT', 'SILK_ARTIFACT_TRACE', 'SILK_RETAINED_BUILD'
        ):
            env.pop(key)
    results = []
    variants = {}

    def save(result):
        results.append(result)
        (root / 'results.json').write_text(json.dumps(results, indent=2))
        print(json.dumps(result), flush=True)

    for spec in specs:
        work = root / spec['id']
        pair = []
        for mode in ('off', 'on'):
            compiler = ORIGIN / ('compiler-' + mode)
            if (work / 'build').exists():
                shutil.rmtree(work / 'build')
            log = work / (mode + '-check.log')
            checked = bench.measure([str(compiler), 'check', '--stdlib', str(SOURCE / 'stdlib'),
                                     '--json', '--progress', 'never'], work, env, log)
            messages = diagnostics(log)
            result = {'case': spec['id'], 'mode': mode, 'check_exit': checked['exit_code'],
                      'diagnostics': messages, 'codes': codes(messages),
                      'detached': checked['detached']}
            if spec['negative']:
                expected_codes = {d['code'] for d in spec['expected']['diagnostics']}
                result['expected_codes'] = sorted(expected_codes)
                save(result)
                if not result['check_exit'] or not expected_codes.issubset(result['codes']):
                    raise SystemExit('expected rejection missing: ' + spec['id'] + ' ' + mode)
            else:
                if result['check_exit']:
                    save(result)
                    raise SystemExit('unexpected positive check failure: ' + spec['id'] + ' ' + mode)
                built = bench.measure([str(compiler), 'build', '--stdlib', str(SOURCE / 'stdlib'),
                                       '--progress', 'never'], work, env,
                                      work / (mode + '-build.log'))
                result['build_exit'] = built['exit_code']
                if built['exit_code']:
                    save(result)
                    raise SystemExit('unexpected build failure: ' + spec['id'] + ' ' + mode)
                artifact = work / 'build/llvm/x86_64-unknown-linux-gnu/debug/supplemental-parity'
                execution = subprocess.run([str(artifact)], capture_output=True, timeout=30)
                result.update(exit_code=execution.returncode, stdout=execution.stdout.decode(errors='replace'),
                              stderr=execution.stderr.decode(errors='replace'))
                save(result)
                if result['exit_code'] != spec['expected']['exitCode']:
                    raise SystemExit('runtime oracle failed: ' + spec['id'] + ' ' + mode)
                semantic = (result['exit_code'], result['stdout'], result['stderr'])
                key = (spec['source'], mode)
                if key in variants and semantic != variants[key]:
                    raise SystemExit('declaration-order runtime changed: ' + spec['source'] + ' ' + mode)
                variants[key] = semantic
            pair.append(result)
        fields = ['check_exit', 'diagnostics'] if spec['negative'] else ['diagnostics', 'exit_code', 'stdout', 'stderr']
        for field in fields:
            if pair[0][field] != pair[1][field]:
                raise SystemExit('compiler parity mismatch: ' + spec['id'] + ' ' + field)
    print('PASS supplemental generated compiler parity', root, flush=True)


if __name__ == '__main__':
    main()
