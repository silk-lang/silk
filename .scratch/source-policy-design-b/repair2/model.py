"""Repair2 bounded accepted-main6c policy correspondence, not Silk execution.

The helpers below are explicitly identified specializations/transcriptions of
BorrowCheck's slot/retention/cleanup policy. Tables are separately specified
boundary contracts. No claim of an independent whole-compiler oracle is made.
"""
from itertools import product
from pathlib import Path
import json

LOCAL, UNIVERSAL, UNKNOWN = 'Local', 'Universal', 'Unknown'
def join(a, b):
    return max((a, b), key={LOCAL: 0, UNIVERSAL: 1, UNKNOWN: 2}.__getitem__)

# BC narrowSlots+keptSink specialization: holds=true, own=false, locally typed,
# whole=Universal, wholeApproximate=Local. Path result and type compatibility are
# genuine helper INPUTS, not inferred from definition labels or equal region atoms.
def classify(direct, slots, referent=True, undescribed=False):
    kept, approximate = UNIVERSAL, LOCAL
    occupied = positioned = uncertain = False
    precise, wider = LOCAL, LOCAL
    aborted = undescribed or not slots
    if not aborted:
        for matched, view, compatible, slot_kept, slot_approximate in slots:
            fits = matched == 'Same'
            if matched == 'Unknown':
                if not direct:
                    aborted = True
                    break
                fits = referent and compatible
            if fits:
                occupied = True
                positioned |= matched == 'Same' and view
                uncertain |= matched == 'Unknown' or not view
                precise = join(precise, slot_kept if view else UNIVERSAL)
                wider = join(wider, slot_approximate if view else LOCAL)
    located = occupied and positioned and not uncertain and not aborted
    if occupied and not aborted:
        kept, approximate = precise, wider
    if not located and kept == UNIVERSAL:
        kept = UNKNOWN
    if kept != UNIVERSAL and approximate == UNIVERSAL:
        kept = UNKNOWN  # locally typed fixed input
    elif kept == LOCAL and approximate == UNKNOWN:
        kept = UNKNOWN
    return kept, located


def slot(match, view=True, compatible=True, kept=LOCAL, approximate=LOCAL):
    return match, view, compatible, kept, approximate

# Separate boundary table, including the actual Unknown-path directness distinction.
slot_expected = {
    ('Same', False): (LOCAL, True), ('Same', True): (LOCAL, True),
    ('Different', False): (UNKNOWN, False), ('Different', True): (UNKNOWN, False),
    ('Unknown', False): (UNKNOWN, False), ('Unknown', True): (LOCAL, False),
}
for (match, direct), answer in slot_expected.items():
    assert classify(direct, [slot(match)]) == answer
assert classify(True, [slot('Unknown', compatible=False)]) == (UNKNOWN, False)
assert classify(True, [slot('Unknown')], referent=False) == (UNKNOWN, False)
assert classify(False, [slot('Same')], referent=False) == (LOCAL, True)
assert classify(True, [slot('Same', view=False)]) == (UNKNOWN, False)
assert classify(False, [slot('Same'), slot('Unknown')]) == (UNKNOWN, False)  # abort loses partial accumulator
assert classify(True, [slot('Same'), slot('Unknown')]) == (LOCAL, False)
assert classify(False, [slot('Same'), slot('Different')]) == (LOCAL, True)
assert classify(False, [slot('Same', kept=UNIVERSAL)]) == (UNIVERSAL, True)
assert classify(False, [slot('Same', approximate=UNIVERSAL)]) == (UNKNOWN, True)
assert classify(False, [slot('Same')], undescribed=True) == (UNKNOWN, False)
assert classify(False, []) == (UNKNOWN, False)

# Preserve conditional pairs, with one physical occurrence for both histories.
# tuple: physical, leaf, definition, read, direct, match. Histories never become
# real copy positions; direct/path/read are never independently unioned attributes.
def outcomes(cases):
    groups = {}
    for physical, leaf, definition, read, direct, match in cases:
        groups.setdefault((physical, leaf), set()).add((definition, read, direct, match))
    return {key: {classify(direct, [slot(match)]) for _, _, direct, match in routes}
            for key, routes in groups.items()}

aggregate = ('field0', 'L', 'aggregateDef', 'aggregateRead', True, 'Same')
declared = ('field0', 'L', 'declaredDef', 'declaredRead', False, 'Same')
assert outcomes([declared]) == {('field0', 'L'): {(LOCAL, True)}}
assert outcomes([aggregate, declared]) == {('field0', 'L'): {(LOCAL, True)}}
assert outcomes([aggregate, declared] * 3) == outcomes([aggregate, declared])
assert len(outcomes([aggregate, ('field1', *declared[1:])])) == 2
unknown_direct = (*aggregate[:5], 'Unknown')
unknown_indirect = (*declared[:5], 'Unknown')
assert outcomes([unknown_direct, unknown_indirect]) == {('field0', 'L'): {(LOCAL, False), (UNKNOWN, False)}}
assert {('aggregateDef', 'declaredRead')} .isdisjoint({(c[2], c[3]) for c in (aggregate, declared)})

# Parent closure transcription. Links represent authenticated parent/borrowed
# matches; located is immutable across closure. Effects are produced ONLY after it.
def parent_closure(initial, located, local, operands, links, only=False):
    final = list(initial)
    reached = {i for i, sink in enumerate(initial) if sink == UNIVERSAL}
    queue = sorted(reached)
    cursor = 0
    while cursor < len(queue):
        child = queue[cursor]
        cursor += 1
        for parent in range(len(initial)):
            if parent not in reached and (only or operands[parent] == operands[child]) and (child, parent) in links:
                reached.add(parent)
                queue.append(parent)
                if local[parent]:
                    final[parent] = UNIVERSAL
    return tuple(zip(final, located))

# Independent reachability characterization (set closure, not queue mutation):
# promotion applies to exactly local reachable ancestors, and no located bit changes.
parent_cases = 0
for edges_mask, only in product(range(8), (False, True)):
    links = {edge for bit, edge in enumerate(((0, 1), (1, 2), (0, 2))) if edges_mask & (1 << bit)}
    initial, located, local, operands = [UNIVERSAL, UNKNOWN, UNKNOWN], [True, False, False], [False, False, True], [0, 0, 1]
    reached = {0}
    while True:
        next_reached = reached | {b for a, b in links if a in reached and (only or operands[a] == operands[b])}
        if next_reached == reached:
            break
        reached = next_reached
    oracle = tuple((UNIVERSAL if i in reached and local[i] else initial[i], located[i]) for i in range(3))
    assert parent_closure(initial, located, local, operands, links, only) == oracle
    parent_cases += 1
promoted = parent_closure([UNIVERSAL, UNKNOWN], [True, False], [False, True], [0, 0], {(0, 1)})
assert promoted[1] == (UNIVERSAL, False)

# Accepted keepCarried adapter. Record site evidence here; actual operation
# reachability/caller source validation remain a later qualification, never a
# reason to clear an independent capture/return/written-operand escape.
def effect(final, field_known, point_real, quality):
    sink, located = final
    if sink == UNIVERSAL:
        if located and field_known and point_real and quality in ('Exact', 'Stored'):
            return 'CallerRetention'
        return 'IndependentEscape'
    if sink == UNKNOWN:
        return 'Storing'
    return 'None'
assert effect(promoted[1], True, True, 'Exact') == 'IndependentEscape'
assert effect(promoted[1], True, True, 'Exact') != 'Storing'  # no provisional Unknown effect
assert {effect(x, True, True, 'Exact') for x in outcomes([aggregate, declared])[('field0', 'L')]} == {'None'}
adapter_cases = 0
for quality, located, field, point, reachable, independent in product(
        ('Exact', 'Stored', 'Alternatives', 'Unknown'), (False, True), (False, True),
        (False, True), (False, True), (False, True)):
    selected = effect((UNIVERSAL, located), field, point, quality)
    expected_record = all((located, field, point)) and quality in {'Exact', 'Stored'}
    assert (selected == 'CallerRetention') == expected_record
    qualified_retention = selected == 'CallerRetention' and reachable  # fixed Actual-source boundary
    has_independent = independent or selected == 'IndependentEscape'
    applies = has_independent or qualified_retention
    if independent:
        assert applies  # never revoked by operation reachability
    if expected_record and not reachable and not independent:
        assert not applies
    adapter_cases += 1

# observeCleanup specialization includes its early refusal/empty-observation and
# holder match gates; named/observed are ACTUAL sets, not inconsistent shares flags.
def cleanup(quality, named, observed, unknown_held, hidden, holder_matches):
    if unknown_held and not hidden:
        return False, quality, True
    everything = unknown_held and hidden
    if not everything and not observed:
        return False, quality, False
    interval = holder_matches and (everything or not named or bool(named & observed))
    after = quality
    if interval and not named:
        after |= 3
    return interval, after, False

cleanup_rows = []
for q, named, observed, unknown_held, hidden, holder in product(
        range(4), (frozenset(), frozenset('r'), frozenset('s')), (frozenset(), frozenset('r')),
        (False, True), (False, True), (False, True)):
    actual = cleanup(q, named, observed, unknown_held, hidden, holder)
    # Declarative allowed-observation relation, independent of imperative order.
    refused = unknown_held and not hidden
    observing = not refused and (bool(observed) or (unknown_held and hidden))
    eligible_names = not named or bool(named & observed) or (unknown_held and hidden)
    interval = observing and holder and eligible_names
    expected = (interval, 3 if interval and not named else q, refused)
    assert actual == expected
    cleanup_rows.append({'before': q, 'named': sorted(named), 'observed': sorted(observed),
                         'unknownHeld': unknown_held, 'hidden': hidden, 'holderMatches': holder,
                         'interval': actual[0], 'after': actual[1], 'refusal': actual[2]})
assert len(cleanup_rows) == 192
for q in range(4):
    assert cleanup(q, {'r'}, {'r'}, False, False, True) == (True, q, False)
    assert cleanup(q, {'s'}, set(), True, True, True) == (True, q, False)  # everything, nonempty
    assert cleanup(q, set(), {'r'}, False, False, True) == (True, 3, False)
    assert cleanup(q, set(), set(), False, False, True) == (False, q, False)  # early return
    assert cleanup(q, set(), {'r'}, False, False, False) == (False, q, False)

report = {'kind': 'repair2 bounded policy correspondence; no Silk execution',
          'slot_boundaries': [{'match': m, 'direct': d, 'sink': r[0], 'located': r[1]} for (m, d), r in slot_expected.items()],
          'exact_indirect_and_mixed': 'Local, located=true; one physical observation; no storing',
          'unknown_path_directness': 'direct compatible Local/unlocated; indirect Unknown/unlocated',
          'parent_closure_cases': parent_cases, 'parent_promotion': list(promoted[1]),
          'retention_adapter_cases': adapter_cases, 'cleanup_cases': len(cleanup_rows),
          'cleanup_rows': cleanup_rows,
          'limits': ['policy helpers are explicit accepted-main specializations, not a full independent compiler oracle',
                     'slot matching/type compatibility supplied as fixed helper inputs, not constructed by this model',
                     'retention applicability probe fixes source=Actual; full classifier/CFG unexecuted',
                     'no source/shape/API translation, availability, native diagnostics or cost acceptance'],
          'assertions': 'PASS'}
Path(__file__).with_name('results.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps({k: v for k, v in report.items() if k != 'cleanup_rows'}, indent=2))
