"""Summarize numbered R3 probe receipts, including emission identity weights."""
import collections
import gzip
import json
import re
import sys
from pathlib import Path

for argument in sys.argv[1:]:
    path = Path(argument)
    data = gzip.decompress(path.read_bytes()) if path.suffix == '.gz' else path.read_bytes()
    groups = collections.defaultdict(lambda: {
        'units': [], 'maps': {}, 'includes': collections.defaultdict(list),
        'emits': [], 'ambiguous': set(),
    })
    for line in data.decode().splitlines():
        match = re.search(r'; PROBE R3 ((?:\d+ ?){8})$', line)
        if not match:
            continue
        kind, first, second, a, b, c, d, e = map(int, match[1].split())
        program = re.search(r'^R3_PROGRAM=(\S+)', line)
        group = groups[program[1] if program else 'self-build']
        if kind == 1:
            group['units'].append((first, a))
        elif kind == 2:
            if first in group['maps'] and group['maps'][first] != (second, a):
                group['ambiguous'].add(first)
            group['maps'][first] = (second, a)
        elif kind == 3:
            group['includes'][first].append((second, a))
        elif kind == 4:
            group['emits'].append(first)
    masks = collections.Counter()
    missing = []
    for program, group in groups.items():
        for encoding in group['emits']:
            chosen = next(((key, reason) for key, reason in group['includes'][encoding]
                           if reason != 18446744073709551615), None)
            if chosen is None or chosen[1] != 1 or chosen[0] not in group['maps']:
                missing.append((program, encoding, chosen))
                continue
            masks[group['maps'][chosen[0]][1]] += 1
    print(json.dumps({
        'file': str(path), 'programs': len(groups),
        'units': sum(len({owner for owner, mask in group['units']}) for group in groups.values()),
        'rawUnits': sum(len(group['units']) for group in groups.values()),
        'emitted': sum(masks.values()), 'maskCounts': dict(sorted(masks.items())),
        'overlapCategories': [sum(count for mask, count in masks.items() if mask & flag)
                              for flag in [1, 2, 4, 8]],
        'missing': len(missing),
        'ambiguousMaps': sum(len(group['ambiguous']) for group in groups.values()),
        'zeroMasks': masks[0],
    }, indent=2))
    if missing or any(group['ambiguous'] for group in groups.values()) or masks[0]:
        raise SystemExit('Incomplete or ambiguous census mapping')
