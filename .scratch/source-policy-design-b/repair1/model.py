"""B repair1 finite specification probes; not Silk/compiler acceptance.

Concrete state machines/path oracles are separate from set/rule solvers. All
inputs and domain bounds are below. No production module or native runner used.
"""
from collections import deque
from itertools import product
import json
from pathlib import Path


def closure(rules, assumed):
    selected = [(h, p) for h, p, n in rules if not set(n) & assumed]
    out = set()
    while True:
        before = set(out)
        for h, p in selected:
            if set(p) <= out:
                out.add(h)
        if before == out:
            return out


def bounds(rules):
    domain = {a for h, p, n in rules for a in (h, *p, *n)}
    lo, hi = set(), domain
    for _ in range(2 * len(domain) + 2):
        new_lo = closure(rules, hi)
        new_hi = closure(rules, new_lo)
        assert lo <= new_lo <= new_hi <= hi
        if (lo, hi) == (new_lo, new_hi):
            return lo, hi
        lo, hi = new_lo, new_hi
    raise AssertionError('not finite')


def bits(mask):
    return [b for b in (1, 2) if mask & b]


# Concrete machine. Store cells are absent or (source leaf, accumulated loss).
# Copying snapshots a cell; writing a constant kills its old source and loss.
# Weak call writes nondeterministically retain old or install a received cell.
def execute(store, action):
    kind, dst, arg = action
    if kind == 'id':
        return [store]
    updated = list(store)
    if kind == 'const':
        updated[dst] = arg
    elif kind == 'copy':
        updated[dst] = store[arg]
    elif kind == 'loss':
        if store[dst] is not None:
            leaf, quality = store[dst]
            updated[dst] = (leaf, quality | arg)
    elif kind == 'weak':
        updated[dst] = arg
        return [store, tuple(updated)]
    else:
        raise AssertionError(kind)
    return [tuple(updated)]


def concrete(edges, actions, initial):
    seen, pending = set(), deque([(0, initial)])
    at = {}
    while pending:
        pc, store = pending.popleft()
        if (pc, store) in seen:
            continue
        seen.add((pc, store))
        for v, cell in enumerate(store):
            if cell is not None:
                at.setdefault((pc, v, cell[0]), set()).add(cell[1])
        for nxt in edges.get(pc, ()):
            for value in execute(store, actions.get(pc, ('id', 0, None))):
                pending.append((nxt, value))
    return at


# Independent finite set equations. Presence and each loss bit are separate atoms.
# They do not carry concrete stores, enumerate runtime paths, or use execute().
def equations(edges, actions, initial):
    nodes = set(edges) | {n for values in edges.values() for n in values}
    leaves = {cell[0] for cell in initial if cell is not None}
    for kind, _, arg in actions.values():
        if kind in ('const', 'weak') and arg is not None:
            leaves.add(arg[0])
    rules = [('reach:0', (), ())]
    def h(pc, v, leaf): return ('H', pc, v, leaf)
    def q(pc, v, leaf, b): return ('Q', pc, v, leaf, b)
    for v, cell in enumerate(initial):
        if cell is not None:
            rules.append((h(0, v, cell[0]), (), ()))
            rules += [(q(0, v, cell[0], b), (), ()) for b in bits(cell[1])]
    for pc in nodes:
        kind, dst, arg = actions.get(pc, ('id', 0, None))
        for nxt in edges.get(pc, ()):
            rules.append((f'reach:{nxt}', (f'reach:{pc}',), ()))
            for v in range(len(initial)):
                strong = v == dst and kind in ('const', 'copy')
                source_var = arg if v == dst and kind == 'copy' else v
                if not strong or kind == 'copy':
                    for leaf in leaves:
                        rules.append((h(nxt, v, leaf), (h(pc, source_var, leaf),), ()))
                        for b in (1, 2):
                            rules.append((q(nxt, v, leaf, b),
                                          (h(pc, source_var, leaf), q(pc, source_var, leaf, b)), ()))
                        if v == dst and kind == 'loss':
                            rules += [(q(nxt, v, leaf, b), (h(pc, v, leaf),), ()) for b in bits(arg)]
                if v == dst and kind in ('const', 'weak') and arg is not None:
                    rules.append((h(nxt, v, arg[0]), (f'reach:{pc}',), ()))
                    rules += [(q(nxt, v, arg[0], b), (f'reach:{pc}',), ()) for b in bits(arg[1])]
    lo, hi = bounds(rules)
    assert lo == hi
    result = {}
    for pc in nodes:
        for v in range(len(initial)):
            for leaf in leaves:
                if h(pc, v, leaf) in lo:
                    result[pc, v, leaf] = sum(b for b in (1, 2) if q(pc, v, leaf, b) in lo)
    return result


def compare(edges, actions, initial):
    oracle = concrete(edges, actions, initial)
    # Independent union: bitwise loss join over all actually visited concrete states.
    expect = {key: int(any(m & 1 for m in values)) + 2 * int(any(m & 2 for m in values))
              for key, values in oracle.items()}
    actual = equations(edges, actions, initial)
    assert actual == expect, (edges, actions, expect, actual)
    return actual


# 16 CFGs: optional entry skip, self loop, backedge, and early exit; base 0->1->2->3.
# 7^2 action pairs: identity, copy in each direction, both losses, caller kill, weak call.
# Finite concrete states, not bounded loop unrolling. Each of two cells holds at most
# L/C plus four masks (and absent); masks only increase until a real constant kill.
choices = [('id', 0, None), ('copy', 1, 0), ('copy', 0, 1),
           ('loss', 0, 1), ('loss', 0, 2), ('const', 0, ('C', 0)), ('weak', 0, ('C', 0))]
count = 0
for optional in product((False, True), repeat=4):
    edges = {0: [1], 1: [2], 2: [3], 3: []}
    for selected, (a, b) in zip(optional, ((0, 3), (1, 1), (2, 1), (1, 3))):
        if selected:
            edges[a].append(b)
    for a, b in product(choices, repeat=2):
        compare(edges, {1: a, 2: b}, (('L', 0), None))
        count += 1
assert count == 784

# Identity source cycle is Exact without any quality-category seed. Real store
# backedge reaches the loop read, but cannot rewrite a saved pre-loop observation.
loop = {0: [1], 1: [2, 3], 2: [1], 3: []}
identity = compare(loop, {}, (('L', 0), None))
assert identity[1, 0, 'L'] == 0
stored = compare(loop, {0: ('copy', 1, 0), 2: ('loss', 0, 1)}, (('L', 0), None))
assert stored[1, 0, 'L'] == 1 and stored[1, 1, 'L'] == 0
# Copy performed in the loop sees that backedge (not a blanket saved-name exemption).
loopcopy = compare({0: [1], 1: [2, 4], 2: [3], 3: [1], 4: []},
                   {1: ('copy', 1, 0), 3: ('loss', 0, 1)}, (('L', 0), None))
assert loopcopy[2, 1, 'L'] == 1
weak = compare({0: [1], 1: []}, {0: ('weak', 0, ('C', 0))}, (('L', 0), None))
kill = compare({0: [1], 1: []}, {0: ('const', 0, ('C', 0))}, (('L', 0), None))
assert set(k for k in weak if k[0] == 1) == {(1, 0, 'L'), (1, 0, 'C')}
assert set(k for k in kill if k[0] == 1) == {(1, 0, 'C')}
# No loss/loan kind is allowed to erase an explicitly unknown source.
unknown = compare(loop, {2: ('const', 0, ('Unknown', 0))}, (('C', 0), None))
assert (1, 0, 'Unknown') in unknown

# Category/admission uses negative literals only after grounded presence.
# Negative cycle creates undefined loss; it must not be read as false.
def category_rules(prefix, present):
    h, s, a = prefix + 'H', prefix + 'S', prefix + 'A'
    return ([(h, (), ())] if present else []) + [
        (prefix + 'Exact', (h,), (s, a)),
        (prefix + 'Stored', (h, s), (a,)),
        (prefix + 'Alternatives', (h, a), (s,)),
        (prefix + 'Unknown', (h, s, a), ())]


def admission(lo, hi, p):
    names = [p + x for x in ('Exact', 'Stored', 'Alternatives', 'Unknown')]
    return p + 'H' in lo and sum(n in lo for n in names) == 1 and all(
        n in lo or n not in hi for n in names)

cat = category_rules('x', True)
lo, hi = bounds(cat)
assert lo == hi and 'xExact' in lo and admission(lo, hi, 'x')
u_lo, u_hi = bounds(cat + [('xS', ('xH',), ('notS',)), ('notS', (), ('xS',))])
assert 'xS' in u_hi - u_lo and not admission(u_lo, u_hi, 'x')
a_lo, a_hi = bounds(category_rules('x', False))
assert not admission(a_lo, a_hi, 'x') and 'xExact' not in a_hi
# A one-hot encoding with no quality must not pass even if its truth assignment is total.
assert not admission({'xH'}, {'xH'}, 'x')

# Explicit transition contract: immutable operation policy never repairs prior loss.
# Oracle is the four-element lattice join; rules generate each positive loss bit.
transition_count = 0
for initial_mask, kind in product(range(4), ('exact', 'alternative', 'unknown', 'drop', 'store', 'cleanup')):
    rules = [('inputH', (), ())]
    rules += [(('P0', b), (), ()) for b in bits(initial_mask)]
    for b in (1, 2):
        rules.append((('P1', b), (('P0', b),), ()))
    produced = {'exact': (), 'alternative': (2,), 'unknown': (1, 2),
                'drop': (), 'store': (1,), 'cleanup': (1, 2)}[kind]
    rules += [(('P1', b), ('inputH',), ()) for b in produced]
    if kind != 'drop':
        rules.append(('outputH', ('inputH',), ()))
        rules += [(('outQ', b), ('outputH', ('P1', b)), ()) for b in (1, 2)]
    t_lo, t_hi = bounds(rules)
    assert t_lo == t_hi
    lattice_effect = {'exact': 0, 'alternative': 2, 'unknown': 3, 'drop': 0, 'store': 1, 'cleanup': 3}[kind]
    assert sum(b for b in (1, 2) if ('P1', b) in t_lo) == initial_mask | lattice_effect
    assert ('outputH' in t_lo) == (kind != 'drop')
    transition_count += 1

# A complete/drop certificate needs a real surviving Exact witness. Removal of a
# killed witness cannot prove drop; Stored/undefined quality cannot count as Exact.
for witness_present, witness_stored in product((False, True), repeat=2):
    certificate = category_rules('w', witness_present) + [
        ('otherH', (), ()), ('witness', ('wH', 'wExact'), ()),
        ('complete', ('otherH', 'witness'), ()), ('dropOther', ('complete',), ())]
    if witness_stored and witness_present:
        certificate.append(('wS', ('wH',), ()))
    c_lo, c_hi = bounds(certificate)
    assert c_lo == c_hi
    assert ('dropOther' in c_lo) == (witness_present and not witness_stored)
# Two-operation feedback: enumerate Boolean output assignments independently of
# Gamma; neither supported solution authorizes selecting it as the unique result.
feedback = [('AO', (), ('BW',)), ('AW', ('BW',), ()),
            ('BW', (), ('AO',)), ('BO', ('AO',), ())]
f_lo, f_hi = bounds(feedback)
solutions = [(ao, aw, bo, bw) for ao, aw, bo, bw in product((False, True), repeat=4)
             if ao == (not bw) and aw == bw and bw == (not ao) and bo == ao]
assert solutions == [(False, True, False, True), (True, False, True, False)]
assert not f_lo and f_hi == {'AO', 'AW', 'BO', 'BW'}
assert (False, True, True, False) not in solutions  # Frozen cross-certificate.
# Explicit loan-free replacement is a genuine non-loan definition, not absence.
loanfree = compare({0: [1], 1: []}, {0: ('const', 0, ('LoanFree', 0))}, (('L', 3), None))
assert (1, 0, 'LoanFree') in loanfree and (1, 0, 'L') not in loanfree

# Per-case directness/placement classification vs an independent case execution oracle.
# Classification input is exactly the review's helper boundary, not a type proof.
def normalize_cases(cases):
    grouped = {}
    for physical, leaf, definition, read, direct, placement in cases:
        grouped.setdefault((physical, leaf), set()).add((definition, read, direct, placement))
    return grouped


def policy_effects(cases):
    output = set()
    for (physical, leaf), witnesses in normalize_cases(cases).items():
        for definition, read, direct, placement in witnesses:
            sink = 'Local' if direct and placement == 'field0' else 'Unknown'
            output.add(('call', 'retention', physical, leaf, placement, sink))
    return output


route_count = 0
routes = [('aggregate', 'rA', True, 'field0'), ('declared', 'rD', False, 'field0'),
          ('opaque', 'rO', False, 'opaque')]
for mask in product((False, True), repeat=3):
    cases = [('component0', 'L', *route) for active, route in zip(mask, routes) if active]
    oracle = set()
    for physical, leaf, definition, read, direct, placement in cases:
        # Enumerate alternate executions; no merged attributes are visible here.
        allowed_local = (definition == 'aggregate' and read == 'rA')
        oracle.add(('call', 'retention', physical, leaf, placement, 'Local' if allowed_local else 'Unknown'))
    assert policy_effects(cases) == oracle
    assert policy_effects(cases + cases) == oracle  # Historical duplicates aren't real copies.
    route_count += 1
both = [('component0', 'L', *routes[i]) for i in (0, 1)]
assert len(normalize_cases(both)) == 1
assert {e[-1] for e in policy_effects(both)} == {'Local', 'Unknown'}
# Target and placement must independently distinguish effects.
collisions = [('c0', leaf, 'd', 'r', False, place) for leaf, place in product(('L', 'M'), ('field0', 'field1'))]
assert len(policy_effects(collisions)) == 4
# No read/definition cross-authentication: each selector checks the original pair.
authenticated = {('d1', 'r1')}
assert not any((d, r) in authenticated for d, r in [('d1', 'r2'), ('d2', 'r1')])

# Sequential same-loan real positions see preceding effects; histories share pre.
# Oracle executes actual positions; rule graph represents explicit version edges.
def sequential_reference(real_count):
    p, observed = 0, []
    for _ in range(real_count):
        observed.append(p)
        p |= 3  # Original unknown-result loss.
    return observed


def sequential_rules(real_count):
    rules = [('activeL', (), ())]
    for i in range(real_count):
        for b in (1, 2):
            rules += [((i + 1, b), ((i, b),), ()), ((i + 1, b), ('activeL',), ())]
    lo, hi = bounds(rules)
    assert lo == hi
    return [sum(b for b in (1, 2) if (i, b) in lo) for i in range(real_count)]
for n in range(1, 6):
    assert sequential_reference(n) == sequential_rules(n)
assert sequential_rules(2) == [0, 3] and sequential_rules(1) == [0]
# Constructor observation precedes later cleanup, not final-quality replay.
assert sequential_rules(2)[0] == 0 and sequential_rules(2)[1] == 3

# Runtime backedge exists independently of checker Outside. Contrast the erroneous
# stop-gated source encoding; the correct rules retain a definite reason to refuse.
runtime = [('caller', (), ()), ('borrowL', (), ()), ('atStoreL', ('borrowL',), ()),
           ('outside', ('atStoreL',), ())]
r_lo, r_hi = bounds(runtime)
assert r_lo == r_hi and {'atStoreL', 'outside'} <= r_lo
wrong = [('caller', (), ()), ('borrowL', (), ('outside',)),
         ('atStoreL', ('borrowL',), ()), ('outside', ('atStoreL',), ())]
w_lo, w_hi = bounds(wrong)
assert 'atStoreL' in w_hi - w_lo and 'outside' in w_hi - w_lo

# Diagnostic oracle is explicit stage priority, independent of span sorting.
def terminal_candidates(candidates):
    # (priority stage, structural order, span, code), conflicts stop later stages.
    return min(candidates, key=lambda c: (c[0], c[1]))[-1]
assert terminal_candidates([(2, 1, 100, 'outside'), (3, 2, 5, 'laterConflict')]) == 'outside'
assert terminal_candidates([(0, 3, 100, 'guard'), (1, 0, 1, 'lifetime')]) == 'guard'
assert terminal_candidates([(3, 1, 100, 'event'), (4, 0, 1, 'storing')]) == 'event'

# Prepared maps: nominal exact field kill with caller/no-loan components and copy.
# Independent named dictionary oracle vs indexed cell machine.
entry = {'left': ('CallerLeft', 0), 'right': ('CallerRight', 0)}
saved = dict(entry)
written = dict(entry)
written['right'] = ('BorrowBad', 0)
nominal = compare({0: [1], 1: [2], 2: []},
                  {0: ('copy', 2, 1), 1: ('const', 1, ('BorrowBad', 0))},
                  (entry['left'], entry['right'], None))
assert nominal[2, 0, written['left'][0]] == 0
assert nominal[2, 1, written['right'][0]] == 0
assert nominal[2, 2, saved['right'][0]] == 0
assert (2, 1, 'CallerRight') not in nominal

# Finite prepared recursive route: visited coverage is not a terminal predicate.
# Set closure implementation vs independently enumerated graph paths up to n vertices
# (simple paths suffice to witness reachability); predicates are checked at accepts.
def reachable(graph, start):
    out, todo = set(), [start]
    while todo:
        v = todo.pop()
        if v not in out:
            out.add(v)
            todo.extend(graph.get(v, ()))
    return out


def simple_paths(graph, current, visited=()):
    yield current
    for nxt in graph.get(current, ()):
        if nxt not in visited + (current,):
            yield from simple_paths(graph, nxt, visited + (current,))


def route_proves(graph, start, accepts, predicates):
    reached = reachable(graph, start)
    terminals = reached & accepts
    return bool(terminals) and all(predicates[t] for t in terminals)

route_checks = 0
for e0, e1, grounded, predicate in product((False, True), repeat=4):
    graph = {'Node<T>': ['Node<T>'] if e0 else []}
    if e1:
        graph['Node<T>'].append('value:a')
    if grounded:
        graph['Node<T>'].append('entry:a')
    expected = set(simple_paths(graph, 'Node<T>'))
    assert reachable(graph, 'Node<T>') == expected
    terminals = expected & {'value:a', 'entry:a'}
    assert route_proves(graph, 'Node<T>', {'value:a', 'entry:a'},
                        {'value:a': predicate, 'entry:a': predicate}) == (bool(terminals) and predicate)
    route_checks += 1
assert not route_proves({'N': ['N']}, 'N', {'entry'}, {'entry': True})
assert not route_proves({'N': ['N', 'entry']}, 'N', {'entry'}, {'entry': False})
# Original sibling binder correspondence must survive instantiated equality.
original = {'success.success.left': 'a', 'success.success.right': 'b'}
arguments = {'a': 'caller', 'b': 'bad'}
instantiated = {'a': 'sameAtom', 'b': 'sameAtom'}
assert arguments[original['success.success.left']] == 'caller'
assert arguments[original['success.success.right']] == 'bad'
assert instantiated['a'] == instantiated['b']  # Equality is not correspondence.
# Type applications cannot close a recursive cycle solely by nominal spelling.
assert ('Node', 'T') != ('Node', 'List<T>')

result = {
    'kind': 'bounded design specification evidence, not executed Silk acceptance',
    'concrete_vs_loss_rules': {'graphs': 16, 'action_pairs': 49, 'cases': count,
                             'domain': 'two cells; L/C leaves; absent or 4 loss masks; complete finite-state exploration'},
    'route_case_subsets': route_count,
    'precision_transitions': transition_count,
    'complete_drop_certificate_controls': 4,
    'complete_drop_feedback_solutions': solutions,
    'sequential_real_occurrence_lengths': [1, 2, 3, 4, 5],
    'recursive_route_graph_cases': route_checks,
    'focused': ['identity Exact without seed', 'Stored backedge', 'saved preloop source Q stays Exact; later P not asserted',
                'in-loop copy gains real backedge loss', 'weak call keeps old+received', 'strong kill removes old',
                'Unknown/LoanFree distinction preserved', 'undefined loss blocks admission', 'absent/invalid category blocks',
                'direct/indirect paired routes', 'effect leaf+placement identity', 'no cross-pair authentication',
                'outside is not runtime noncompletion', 'diagnostic stage vs span order',
                'nominal field kill and saved copy', 'recursive cycle cannot prove predicate',
                'original success sibling binders survive coalescing'],
    'limits': ['no compiler constructor/query translation', 'no full result/retention policy oracle',
               'no field alias or availability proof', 'no general correlated route combinations',
               'no Silk diagnostics or cost acceptance', 'diagnostic/contract probes are small contracts, not full checker'],
    'assertions': 'PASS'
}
encoded = json.dumps(result, indent=2) + '\n'
Path(__file__).with_name('results.json').write_text(encoded)
print(encoded, end='')
