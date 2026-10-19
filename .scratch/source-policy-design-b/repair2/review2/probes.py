"""Independent ROUND2 specification probes. No Silk execution.

The two falsifiers use fixed helper-boundary inputs read from production main6c.
The sink reference below is an explicitly identified small production transcription,
NOT an independent proof of source construction. Expected tables and truth-completion
oracles are specified separately. The author model is not imported or changed.
"""
from itertools import product
from pathlib import Path
import json

LOCAL, UNIVERSAL, UNKNOWN = 'Local', 'Universal', 'Unknown'

def joined(a, b):
    return max((a, b), key={LOCAL: 0, UNIVERSAL: 1, UNKNOWN: 2}.__getitem__)

# Specialization of BC 8188-8227/8329-8367 to holds=true, own=false,
# typedLocally=true, whole=Universal, wholeApproximate=Local, described slots.
# Inputs are transferSlotPath's actual Same/Different/Unknown result, view,
# compatible Type.mayHoldLoan result, kept and approximate classification.
def accepted_sink(direct, slots):
    kept, approximate = UNIVERSAL, LOCAL
    precise, wider = LOCAL, LOCAL
    occupied = positioned = uncertain = False
    aborted = False
    for match, view, fits_type, slot_kept, slot_approx in slots:
        fits = match == 'Same'
        if match == 'Unknown':
            if not direct:
                aborted = True
                break
            fits = fits_type
        if fits:
            occupied = True
            positioned |= match == 'Same' and view
            uncertain |= match == 'Unknown' or not view
            precise = joined(precise, slot_kept if view else UNIVERSAL)
            wider = joined(wider, slot_approx if view else LOCAL)
    located = occupied and positioned and not uncertain and not aborted
    if occupied and not aborted:
        kept, approximate = precise, wider
    if not located and kept == UNIVERSAL:
        kept = UNKNOWN
    if kept != UNIVERSAL and approximate == UNIVERSAL:
        kept = UNKNOWN  # fixed locally typed loan
    elif kept == LOCAL and approximate == UNKNOWN:
        kept = UNKNOWN
    return kept, located

same_local = [('Same', True, True, LOCAL, LOCAL)]
unknown_local = [('Unknown', True, True, LOCAL, LOCAL)]
different_local = [('Different', True, True, LOCAL, LOCAL)]
expected = {
    ('same', True): (LOCAL, True), ('same', False): (LOCAL, True),
    ('unknown', True): (LOCAL, False), ('unknown', False): (UNKNOWN, False),
    ('different', True): (UNKNOWN, False), ('different', False): (UNKNOWN, False),
}
slots_by_name = {'same': same_local, 'unknown': unknown_local, 'different': different_local}
for (name, direct), answer in expected.items():
    assert accepted_sink(direct, slots_by_name[name]) == answer

# R2-1 exact field0 input and slot have identical field paths; old directness
# example is not the main6c contract. Mixed history still has only one position.
def author_route_sink(direct, placement):
    return LOCAL if direct and placement == 'field0' else UNKNOWN
sink_falsifier = {
    'input': {'own': False, 'holds': True, 'typedLocally': True,
              'whole': UNIVERSAL, 'wholeApproximate': LOCAL, 'undescribed': False,
              'carryField': ['Field(0)'], 'slotPath': ['Field(0)'], 'slotView': True,
              'slotKept': LOCAL, 'slotApproximate': LOCAL, 'direct': False},
    'accepted_main6c': accepted_sink(False, same_local),
    'author_model': author_route_sink(False, 'field0'),
    'mixed_exact_histories_expected': sorted({accepted_sink(d, same_local)[0] for d in (False, True)}),
    'mixed_exact_histories_author': sorted({author_route_sink(d, 'field0') for d in (False, True)}),
}
assert sink_falsifier['accepted_main6c'] == (LOCAL, True)
assert sink_falsifier['author_model'] == UNKNOWN

# Parent promotion must not synthesize located. An actual local parent can be
# promoted from Unknown to Universal; the initial Unknown must not separately
# set storing after it has been overridden. Different route alternatives retain
# their own located values, not a unioned certificate.
parent_control = {'initial': (UNKNOWN, False), 'final': (UNIVERSAL, False),
                  'required_effect': 'independent escape, not located caller retention'}

# R2-2 distinguish cleanup interval gate from its STRICTLY NARROWER loss gate.
# Original lines 4421-4425: every matching definition gets the interval; precision
# changes only for an empty loan.regions vector. A nonempty matching region is
# legal and ordinary, with no earlier outside or unknownHeld issue.
cleanup_rows = []
for quality, empty_named, shares_observed, everything in product(range(4), (False, True), (False, True), (False, True)):
    interval = everything or empty_named or shares_observed
    expected_quality = 3 if empty_named else quality
    # Literal repair1 table row: original MATCH gate -> S+A.
    literal_quality = quality | (3 if interval else 0)
    cleanup_rows.append({'before': quality, 'empty_named': empty_named,
                         'shares_observed': shares_observed, 'everything': everything,
                         'interval': interval, 'main6c_after': expected_quality,
                         'matched_gate_after': literal_quality})
cleanup_falsifier = next(r for r in cleanup_rows if r['before'] == 0 and not r['empty_named']
                        and r['shares_observed'] and not r['everything'])
assert cleanup_falsifier['main6c_after'] == 0 and cleanup_falsifier['matched_gate_after'] == 3

# All-case release against an exhaustive independent truth-completion oracle.
# -1 means analysis Undefined, NOT a runtime false branch. A positive witness
# outside this slice is held true. Every possible present case must prove Drop.
def completions(values):
    return product(*[(False, True) if v == -1 else (bool(v),) for v in values])

def conservative_release(pairs):
    return all(p == 0 or d == 1 for p, d in pairs)
release_checks = 0
for values in product((-1, 0, 1), repeat=4):
    pairs = (values[:2], values[2:])
    every_completion_releases = all(all(not bits[i] or bits[i + 1] for i in (0, 2))
                                    for bits in completions(values))
    assert conservative_release(pairs) == every_completion_releases
    release_checks += 1
assert not conservative_release(((1, 1), (1, -1)))
assert not conservative_release(((1, 1), (-1, 0)))

# Standard normal-program evaluator for small grounded precision probes. It is
# not imported from the author. It enumerates no execution paths or compiler types.
def closure(rules, assumed):
    pending = [(h, set(p)) for h, p, n in rules if not set(n) & assumed]
    result = set()
    while True:
        new = {h for h, p in pending if p <= result}
        if new <= result:
            return result
        result |= new

def well_founded(rules):
    atoms = {a for h, p, n in rules for a in (h, *p, *n)}
    lower, upper = set(), atoms
    while True:
        next_lower = closure(rules, upper)
        next_upper = closure(rules, next_lower)
        assert lower <= next_lower <= next_upper <= upper
        if (lower, upper) == (next_lower, next_upper):
            return lower, upper
        lower, upper = next_lower, next_upper

def quality_rules(prefix):
    return [(prefix+'Exact', (prefix+'H',), (prefix+'S', prefix+'A')),
            (prefix+'Stored', (prefix+'H', prefix+'S'), (prefix+'A',)),
            (prefix+'Alternatives', (prefix+'H', prefix+'A'), (prefix+'S',)),
            (prefix+'Unknown', (prefix+'H', prefix+'S', prefix+'A'), ())]

# Stable loss rules with global versions and source snapshots together, including
# the transport that author 784-case oracle doesn't contain. Expected facts below
# come from explicit phase order, not same-LoanId equality. savedQ is emitted before
# loop; later saved consumer sees the now degraded global P.
def loss_program(backedge, store):
    r = [('savedH', (), ()), ('loopH', (), ()), ('laterH', (), ())]
    for b in 'SA':
        r += [('saved'+b, ('P0'+b,), ()),
              ('bar'+b, ('P0'+b,), ()),
              ('post'+b, ('bar'+b,), ()),
              ('loop'+b, ('post'+b,), ()),
              ('later'+b, ('post'+b,), ()),
              ('later'+b, ('saved'+b,), ())]
        if backedge:
            r += [('bar'+b, ('loop'+b,), ())]
    if store:
        r += [('postS', ('loopH',), ())]
    for p in ('saved', 'loop', 'later'):
        r += quality_rules(p)
    return r
loss_controls = []
for backedge, store in product((False, True), repeat=2):
    lo, hi = well_founded(loss_program(backedge, store))
    assert lo == hi
    assert 'savedExact' in lo
    assert ('barS' in lo) == (backedge and store)
    assert ('loopStored' in lo) == store
    assert ('laterStored' in lo) == store
    loss_controls.append({'backedge': backedge, 'store': store, 'facts': sorted(lo)})
# Source-free cycles cannot manufacture H, loss or a quality.
r = [('aH', ('bH',), ()), ('bH', ('aH',), ())] + quality_rules('a')
assert well_founded(r) == (set(), set())
# Undefined loss does not produce a definite category.
r = [('xH', (), ()), ('xS', (), ('other',)), ('other', (), ('xS',))] + quality_rules('x')
lo, hi = well_founded(r)
assert lo == {'xH'} and {'xExact', 'xStored'} <= hi - lo

# A read/definition cross-join is not authentication. Genuine distinct components
# advance the same loan twice; two alternative history cases share an incoming P.
paired = {('d0', 'r1'), ('d1', 'r0')}
assert ('d0', 'r0') not in paired
assert 'd0' in {d for d, _ in paired} and 'r0' in {r for _, r in paired}

report = {
    'kind': 'independent ROUND2 bounded specification probes; no compiler execution',
    'sink_contract_controls': [{'path': n, 'direct': d, 'expected': a} for (n, d), a in expected.items()],
    'R2_1_counterexample': sink_falsifier,
    'parent_promotion_control': parent_control,
    'R2_2_literal_cleanup_gate_counterexample': cleanup_falsifier,
    'cleanup_domain': cleanup_rows,
    'all_case_release_truth_assignments': release_checks,
    'global_P_and_source_Q_controls': loss_controls,
    'undefined_and_source_free_controls': 'PASS',
    'paired_read_control': 'PASS',
    'limits': ['fixed helper inputs, not typed Silk programs',
               'sink reference is a documented production transcription; expectations are separate',
               'cleanup finding is a literal-rule ambiguity, not an implemented compiler regression',
               'no full policy translator, type proof, shape construction, diagnostics or cost proof'],
    'assertions': 'PASS: counterexamples reproduced and positive controls hold',
}
Path(__file__).with_suffix('.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps({k: v for k, v in report.items() if k != 'cleanup_domain'}, indent=2))
