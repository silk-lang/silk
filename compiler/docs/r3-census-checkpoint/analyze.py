"""Read-only R3 receipt census: checked owners and weighted emitted definitions.

Names annotate canonical owners; they never join MIR/emission mappings. Each
emission keeps the checkpoint's exact-key mapping and a single inclusion weight.
"""
import collections
import gzip
import json
import re
import sys
from pathlib import Path


def analyze(path):
    raw = path.read_bytes()
    if path.suffix == '.gz':
        raw = gzip.decompress(raw)
    groups = collections.defaultdict(lambda: {
        'units': collections.defaultdict(set), 'maps': {}, 'includes': collections.defaultdict(list),
        'emits': [], 'labels': {}, 'relations': collections.defaultdict(set),
    })
    for line in raw.decode().splitlines():
        program = re.search(r'^R3_PROGRAM=(\S+)', line)
        group = groups[program[1] if program else 'self-build']
        name = re.search(r'; PROBE R3 NAME (\d+) (.*)$', line)
        if name:
            owner, label = int(name[1]), name[2]
            if owner in group['labels'] and group['labels'][owner] != label:
                raise ValueError('Ambiguous owner label')
            group['labels'][owner] = label
            continue
        match = re.search(r'; PROBE R3 ((?:\d+ ?){8})$', line)
        if not match:
            continue
        kind, first, second, a, b, c, d, e = map(int, match[1].split())
        if kind == 1:
            unit = (a, b, c, d, e)
            # The same owner can be checked with distinct instantiated lifetime
            # atoms. Its exact instance key below selects the emitted cause mask.
            group['units'][first].add(unit)
        elif kind == 2:
            mapping = (second, a)
            if first in group['maps'] and group['maps'][first] != mapping:
                raise ValueError('Ambiguous exact-key mapping')
            group['maps'][first] = mapping
        elif kind == 3:
            group['includes'][first].append((second, a))
        elif kind == 4:
            group['emits'].append(first)
        elif kind == 5:
            group['relations'][first].add((a, b, c, d))

    masks = collections.Counter()
    owner_masks = collections.Counter()
    variant_masks = collections.Counter()
    bodies = collections.defaultdict(lambda: {
        'emitted': 0, 'programs': set(), 'masks': collections.Counter(),
        'relationCounts': set(), 'relationShapes': set(), 'atomBits': set(),
    })
    program_bodies = collections.defaultdict(collections.Counter)
    for program, group in groups.items():
        for units in group['units'].values():
            merged = 0
            for unit in units:
                merged |= unit[0]
                variant_masks[unit[0]] += 1
            owner_masks[merged] += 1
        if len(group['emits']) != len(set(group['emits'])):
            raise ValueError('Duplicate final emission')
        for encoding in group['emits']:
            chosen = next(((key, reason) for key, reason in group['includes'][encoding]
                           if reason != 18446744073709551615), None)
            if chosen is None or chosen[1] != 1 or chosen[0] not in group['maps']:
                raise ValueError('Missing exact-key emission mapping')
            owner, mask = group['maps'][chosen[0]]
            matching = [unit for unit in group['units'][owner] if unit[0] == mask]
            if not mask or not matching:
                raise ValueError('Missing or inconsistent cause mask')
            starts = {unit[4] for unit in matching}
            if len(starts) != 1:
                raise ValueError('Ambiguous body root for mapped owner')
            label = group['labels'].get(owner, f'owner-{owner}')
            # Keep the exact owner identity: names and root-relative spans alone
            # can coincide across different declarations or packages.
            identity = f'{label}@{next(iter(starts))}#{owner}'
            row = bodies[identity]
            row['emitted'] += 1
            row['programs'].add(program)
            row['masks'][mask] += 1
            row['relationCounts'].update(item[1] for item in matching)
            row['relationShapes'].update((a, b) for a, b, _, _ in group['relations'][owner])
            row['atomBits'].update(item[3] for item in matching)
            masks[mask] += 1
            program_bodies[program][identity] += 1

    def categories(counts):
        return dict(zip(['RegionRelation', 'Contents', 'Crossed', 'OutsideOwner'],
                        [sum(n for mask, n in counts.items() if mask & bit)
                         for bit in [1, 2, 4, 8]]))

    def body_row(identity):
        row = bodies[identity]
        return {'body': identity, 'emitted': row['emitted'],
                'programs': len(row['programs']), 'masks': dict(sorted(row['masks'].items())),
                'relationCounts': sorted(row['relationCounts']),
                'relationShapes': sorted(row['relationShapes']), 'atomBits': sorted(row['atomBits'])}

    floor_program = 'algorithm-crc-32'
    floor = program_bodies.get(floor_program, {})
    return {'programs': len(program_bodies), 'emitted': sum(masks.values()),
            'maskCounts': dict(sorted(masks.items())), 'categories': categories(masks),
            'checkingUnitVariants': sum(variant_masks.values()),
            'checkingVariantMaskCounts': dict(sorted(variant_masks.items())),
            'checkingVariantCategories': categories(variant_masks),
            'checkingOwners': sum(owner_masks.values()),
            'checkingOwnerMaskCounts': dict(sorted(owner_masks.items())),
            'checkingOwnerCategories': categories(owner_masks),
            'distinctEmittedBodies': len(bodies),
            'topBodies': [body_row(identity) for identity in
                          sorted(bodies, key=lambda key: (-bodies[key]['emitted'], key))[:40]],
            'floorProgram': floor_program, 'floorEmitted': sum(floor.values()),
            'floorBodies': [dict(body_row(identity), perFloorProgram=weight)
                            for identity, weight in sorted(floor.items())]}


for argument in sys.argv[1:]:
    path = Path(argument)
    print(json.dumps({'file': str(path), **analyze(path)}, indent=2))
