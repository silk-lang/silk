"""Reproduce the relation split using only the existing current receipts."""
import collections
import json
from pathlib import Path

from analyze import analyze

folder = Path(__file__).parent
corpus = analyze(folder / 'current-corpus-census.log.gz')
self_build = analyze(folder / 'current-self-build.log.gz', [
    row['body'].rsplit('#', 1)[0] for row in corpus['floorBodies']
])


def summary(result):
    floor_split = collections.defaultdict(collections.Counter)
    for body in result['sharedFloorBodies']:
        for key, counts in body['relationSplit'].items():
            floor_split[key].update(counts)
    return {
        'emitted': result['emitted'], 'maskCounts': result['maskCounts'],
        'relationSplit': result['relationSplit'],
        'universalRelationBodies': result['universalRelationBodies'],
        'mixedRelationBodies': result['mixedRelationBodies'],
        'floorBodies': result['sharedFloorBodies'],
        'absentFloorLabels': result['absentFloorLabels'], 'floorSplit': dict(floor_split),
    }


print(json.dumps({
    'countingUnit': 'retained obligations weighted once per final emitted definition, and emitted bodies; universal/local classification is not a discharged verdict',
    'corpus': summary(corpus), 'selfBuild': summary(self_build),
}, indent=2))
