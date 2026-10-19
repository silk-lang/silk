"""Review-only specification probes. No compiler verdicts or source acceptance."""
import json
from itertools import product

# Independent, small normal-program evaluator for comparing two proposed encodings.
# Rule = (head, required truths, required falsities).
def gamma(rules, assumption):
    enabled = [(h, p) for h, p, n in rules if not set(n).intersection(assumption)]
    reached = set()
    while True:
        before = set(reached)
        for head, required in enabled:
            if set(required).issubset(reached):
                reached.add(head)
        if before == reached:
            return reached

def enclosure(rules):
    atoms = {x for h, p, n in rules for x in (h, *p, *n)}
    lo, hi = set(), atoms
    for _ in range(2 * len(atoms) + 2):
        next_lo = gamma(rules, hi)
        next_hi = gamma(rules, next_lo)
        assert lo <= next_lo <= next_hi <= hi
        if (lo, hi) == (next_lo, next_hi):
            return lo, hi
        lo, hi = next_lo, next_hi
    raise AssertionError('finite enclosure failed to converge')

# 0 Exact, 1 Stored, 2 Alternatives, 3 Unknown. Quality join is bitwise OR.
# This is the ordinary independently specified lattice equation for seeded identity.
fixed_qualities = [q for q in range(4) if q == (0 | q)]
assert fixed_qualities == [0, 1, 2, 3]
# The no-loss execution has Exact at every iteration; any loss needs a real event.
trace = 0
for _ in range(12):
    trace = 0 | trace
assert trace == 0

# Literal finite-category join/identity table, with grounded source membership and
# grounded entry precision. Every backedge quality category is an input to the join.
# The design does not supply a translation to distinguish this from loss-bit encoding.
table = [('source_entry', (), ()), ('source_in', ('source_entry',), ()),
         ('source_out', ('source_in',), ()), ('source_in', ('source_out',), ()),
         ('entry_exact', (), ())]
for q in range(4):
    table.append((f'in_{q}', ('entry_exact', f'out_{q}'), ()))
    table.append((f'out_{q}', (f'in_{q}',), ()))
lo, hi = enclosure(table)
assert lo == hi == {'source_entry', 'source_in', 'source_out', 'entry_exact'}
assert not any(f'in_{q}' in hi for q in range(4))

# A concrete candidate repair: represent accumulated loss bits with positive rules,
# derive Exact only for a grounded source with both loss bits false. This needs review
# for all actual policy branches; this probe establishes only the identity/store cases.
loss_rules = [('source_entry', (), ()), ('source_in', ('source_entry',), ()),
              ('source_out', ('source_in',), ()), ('source_in', ('source_out',), ())]
for bit in ('stored', 'alternatives'):
    loss_rules += [(f'in_{bit}', (f'out_{bit}', 'source_out'), ()),
                   (f'out_{bit}', (f'in_{bit}', 'source_in'), ())]
loss_rules += [('in_exact', ('source_in',), ('in_stored', 'in_alternatives')),
               ('out_exact', ('source_out',), ('out_stored', 'out_alternatives'))]
loss_lo, loss_hi = enclosure(loss_rules)
assert loss_lo == loss_hi
assert {'in_exact', 'out_exact'} <= loss_lo
store_lo, store_hi = enclosure(loss_rules + [('out_stored', ('source_in',), ())])
assert store_lo == store_hi
assert {'in_stored', 'out_stored'} <= store_lo
assert 'in_exact' not in store_hi and 'out_exact' not in store_hi

# Concrete policy inputs witnessed in keptSink/narrowSlots: not own, local loan,
# whole Universal, precise compatible view slot Local, approximate Local.
# No Lifetime/type oracle is modeled: these fixed inputs are the helper boundary.
def sink_for(direct):
    selected = 'Local' if direct else 'Universal'
    return 'Unknown' if selected == 'Universal' else selected
assert sink_for(True) == 'Local'
assert sink_for(False) == 'Unknown'
# Both genuine alternatives have one receiver/physical component/leaf/role.
def fact_key(witness):
    return ('receiver_port', 'field_0', 'L', 'real')
witnesses = [{'def': 'aggregate', 'direct': True}, {'def': 'declared_call', 'direct': False}]
assert fact_key(witnesses[0]) == fact_key(witnesses[1])
assert len({sink_for(w['direct']) for w in witnesses}) == 2

# EffectId as literally printed omits the source leaf, even though precision effects
# target different loans. Payload-indexed facts or a leaf index are necessary.
printed_effect_keys = [('call', 'result', 'operand0_component0', 'precision') for _ in ('L', 'M')]
assert len(set(printed_effect_keys)) == 1

print(json.dumps({
    'kind': 'review-only operation/rule probes, not compiled Silk',
    'precision': {
        'identity_loss_lattice_fixed_points': fixed_qualities,
        'no_loss_execution_quality': trace,
        'category_table_enclosure_total': lo == hi,
        'category_table_grounded_sources': sorted(lo),
        'category_table_has_any_input_quality': any(f'in_{q}' in hi for q in range(4)),
        'loss_bit_identity_exact': sorted(loss_lo),
        'loss_bit_backedge_store': sorted(store_lo),
        'limit': 'contrasts encodings left unspecified; does not assert author implemented the failing encoding'
    },
    'normalization': {
        'same_printed_fact_key': list(fact_key(witnesses[0])),
        'direct_sink': sink_for(True), 'indirect_sink': sink_for(False),
        'required': 'conditional direct/placement evidence must survive witness normalization'
    },
    'effect_identity': {'two_leaf_targets': ['L', 'M'], 'distinct_printed_effect_keys': len(set(printed_effect_keys))},
    'assertions': 'PASS'
}, indent=2))
