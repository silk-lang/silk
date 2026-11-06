#!/usr/bin/env python3
"""Opt-in W3C XML 1.0 Fifth Edition / Namespaces 1.0 conformance check.

Requires lxml to read the upstream suite's entity-based catalog, never to determine results.
Download and extract https://www.w3.org/XML/Test/xmlts20130923.tar.gz separately.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urljoin

from lxml import etree


def cases(suite):
    catalog = etree.parse(str(suite / 'xmlconf.xml'), etree.XMLParser(
        load_dtd=True, resolve_entities=True, no_network=True))
    skipped = Counter()
    selected = []
    for test in catalog.xpath('//TEST'):
        attrs = dict(test.attrib)
        kind = attrs['TYPE']
        recommendation = attrs.get('RECOMMENDATION', 'XML1.0')
        reason = None
        if not recommendation.startswith(('XML1.0', 'NS1.0')) or attrs.get('VERSION', '1.0') != '1.0':
            reason = 'different recommendation'
        elif attrs.get('NAMESPACE') == 'no':
            reason = 'not namespace well-formed'
        elif '5' not in attrs.get('EDITION', '5').split():
            reason = 'earlier XML edition'
        elif kind == 'error':
            reason = 'optional error'
        elif kind == 'not-wf' and attrs.get('ENTITIES', 'none') != 'none':
            reason = 'requires reading external entities'
        if reason:
            skipped[reason] += 1
            continue
        base = test.base
        # The 2013 master catalog accidentally nests this group under namespaces/.
        if attrs['ID'].startswith(('hst-bh-', 'hst-lhs-')):
            base = str(suite / 'eduni/misc') + '/'
        source = Path(urljoin(base, attrs['URI']))
        data = source.read_bytes()
        encoding = re.search(br'<\?xml[^?]*encoding=[\'"]([^\'"]+)', data)
        if kind != 'not-wf' and encoding and encoding[1].lower() not in (b'utf-8', b'utf-16', b'utf-16le', b'utf-16be'):
            skipped['optional encoding'] += 1
            continue
        expected = None
        # XMLTEST supplies the suite's canonical output for standalone documents.
        # External/parameter test outputs require entities this processor does not fetch.
        if kind == 'valid' and attrs.get('ENTITIES', 'none') == 'none' and 'OUTPUT' in attrs and 'xmltest' in source.parts:
            expected = Path(urljoin(base, attrs['OUTPUT'])).read_bytes()
        selected.append((attrs['ID'], kind != 'not-wf', data, expected))
    return selected, skipped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', type=Path, required=True, help='extracted xmlconf directory')
    parser.add_argument('--silk', type=Path, required=True, help='native silkc executable')
    parser.add_argument('--clang', type=Path, required=True)
    args = parser.parse_args()
    selected, skipped = cases(args.suite.resolve())
    root = Path(__file__).resolve().parents[3]
    with tempfile.TemporaryDirectory(prefix='silk-xml-conformance-') as temporary:
        work = Path(temporary)
        shutil.copyfile(Path(__file__).with_name('driver.silk'), work / 'driver.silk')
        (work / 'silk.toml').write_text('[package]\nname = "xml-conformance"\nversion = "0.1.0"\nsource = "."\n')
        binary = work / 'verify'
        subprocess.run([str(args.silk.resolve()), 'build', 'driver.silk', '-o', str(binary),
                        '--stdlib', str(root / 'stdlib'), '--clang', str(args.clang.resolve())], cwd=work, check=True)

        def run(case):
            identifier, valid, data, expected = case
            result = subprocess.run([str(binary)], input=data, capture_output=True, timeout=10)
            wanted = 0 if valid else 2
            if result.returncode != wanted:
                return f'{identifier}: exit {result.returncode}, expected {wanted}; {result.stderr.decode(errors="replace")}'
            if expected is not None and result.stdout != expected:
                return f'{identifier}: output differs\n  expected {expected!r}\n  actual   {result.stdout!r}'
            return None

        with ThreadPoolExecutor(max_workers=8) as workers:
            failures = [failure for failure in workers.map(run, selected) if failure is not None]
    for failure in failures:
        print('FAIL', failure)
    print(f'W3C XML: passed={len(selected) - len(failures)} failed={len(failures)} '
          f'output-compared={sum(case[3] is not None for case in selected)} skipped={sum(skipped.values())}')
    for reason, count in sorted(skipped.items()):
        print(f'  skipped {count}: {reason}')
    return bool(failures)


if __name__ == '__main__':
    raise SystemExit(main())
