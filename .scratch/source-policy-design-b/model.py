"""Small independent flow/property model, NOT Silk/compiler acceptance.

The CFG oracle enumerates finite acyclic executions. A separate static gen/kill solver
is checked against it. The eager holder input model represents the audited constructor
contract (append on hold; read all recorded definitions). Policies below are deliberately
small witness projections, not a translation of BorrowCheck or an acceptance oracle.
"""
from itertools import product, permutations
from collections import deque
import json

# Definition identity includes the write occurrence even when leaf identity repeats.
def enumerate_paths(edges, start, end):
    todo = [(start, ())]
    while todo:
        p, prior = todo.pop()
        assert p not in prior, 'acyclic oracle only'
        path = prior + (p,)
        if p == end:
            yield path
        else:
            todo.extend((n, path) for n in edges[p])

def path_sources(edges, writes, read):
    out = set()
    for path in enumerate_paths(edges, 0, read):
        last = None
        for p in path[:-1]:
            if p in writes: last = writes[p]
        out.add(last)
    return out

def reaching(edges, writes):
    ins = [set() for _ in edges]
    outs = [set() for _ in edges]
    # None is genuine uninitialized input, not an absent alternative.
    ins[0].add(None)
    changed = True
    while changed:
        changed = False
        for p in range(len(edges)):
            new = {writes[p]} if p in writes and ins[p] else set(ins[p])
            if new != outs[p]: outs[p] = new; changed = True
            for n in edges[p]:
                before = len(ins[n]); ins[n] |= outs[p]
                changed |= len(ins[n]) != before
    return ins

# Distinct test property: source enumeration equals possible last writes along all
# executable paths. Loan-free caller X must not be removed because it has no Loan ID.
acyclic = 0
for bits in product((0,1), repeat=6):
    pairs = [(i,j) for i in range(4) for j in range(i+1,4)]
    edges = [[] for _ in range(4)]
    for on,(i,j) in zip(bits,pairs):
        if on: edges[i].append(j)
    for assignment in product((None,'owned','caller'), repeat=3):
        writes = {i:(i,kind) for i,kind in enumerate(assignment) if kind}
        if not list(enumerate_paths(edges,0,3)): continue
        assert reaching(edges,writes)[3] == path_sources(edges,writes,3)
        acyclic += 1

# One existing Loan, one real caller/loan-free replacement, one actual read.
edges = [[1],[2],[]]
writes = {0:(0,'owned'),1:(1,'caller')}
actual = reaching(edges,writes)[2]
historical_loan_input = [(0,'owned')] # hold has no entry for the loan-free RHS
assert actual == {(1,'caller')}
assert set(historical_loan_input).isdisjoint(actual)
# Semantic source predicates must use actual; eager keptSink can still see historical.
# Pick its code-backed own=false, whole=Universal, typedLocally=true => Unknown
# classification; keepCarried turns any such carry into storing=true.
eager_storing = bool(historical_loan_input)
actual_storing = False # no actual Borrow source; caller source discharged separately
assert eager_storing and not actual_storing

# A separate old/new precision example: two definitions of the SAME loan and same
# position at distinct writes. hold dedups within one invocation, not across writes.
# An unknown-result decision (known=false, stores=false) degrades the loan immediately.
inputs = [(0,'L'),(1,'L')]
precision='Exact'; observed=[]
for _,loan in inputs:
    observed.append(precision); precision='Unknown'
assert observed == ['Exact','Unknown']
assert reaching(edges,{0:inputs[0],1:inputs[1]})[2] == {inputs[1]}

# Sentinel scan compared with an independent first-non-MAX characterization:
# MAX before the first ordinary operand is ignored, MAX after it counts as a
# different operand. This falsifies an unordered unique-operand formulation.
def scan(xs):
    name=None; several=False
    for x in xs:
        if name is None: name=x
        elif name != x: several=True
    return name,several

def characterization(xs):
    pos=next((i for i,x in enumerate(xs) if x is not None),None)
    if pos is None: return None,False
    name=xs[pos]
    return name,any(x!=name for x in xs[pos+1:])
scans=0
for n in range(6):
    for xs in product((None,0,1),repeat=n):
        assert scan(xs)==characterization(xs); scans+=1
assert scan((None,0)) == (0,False)
assert scan((0,None)) == (0,True)

# Real backedge vs before-loop: caller entry, read/store, then local replacement.
loop_edges=[[1],[2,4],[3],[1],[]]
loop_writes={0:(0,'caller'),3:(3,'owned')}
assert reaching(loop_edges,loop_writes)[2] == {(0,'caller'),(3,'owned')}
before_edges=[[1],[2],[3,5],[4],[2],[]]
before_writes={0:(0,'caller'),4:(4,'owned')}
assert reaching(before_edges,before_writes)[1] == {(0,'caller')}
assert reaching(before_edges,before_writes)[3] == {(0,'caller'),(4,'owned')}
# Grounded cyclic positive, plus absent ground: genuine source vs self-support.
assert reaching([[1],[2],[1]],{0:(0,'O')})[2] == {(0,'O')}
assert reaching([[1],[2],[1]],{})[2] == {None}

# Exhaustively solve the minimal complete/drop feedback equations, independently
# from the interval enclosure. A has direct O; B direct W. Each drops the direct
# source iff the opposite source actually arrives as a complete witness.
universe=frozenset(('O','W'))
sets=[frozenset(x for x,on in zip(('O','W'),bits) if on) for bits in product((0,1),repeat=2)]
def transfer(named, sources):
    return frozenset((named,)) if named in sources and len(sources)>1 else sources
solutions=[]
for a,b in product(sets,repeat=2):
    if a==transfer('W',frozenset(('O',))|b) and b==transfer('O',frozenset(('W',))|a):
        solutions.append((a,b))
assert len(solutions)==2
frozen=(transfer('W',universe),transfer('O',universe))
assert frozen not in solutions
assert all(not (a==frozenset(('W',)) and b==frozenset(('O',))) for a,b in solutions)
# No cross-witness is common to every grounded solution; selecting either is policy.
assert set.intersection(*(set(a) for a,b in solutions))==set()
assert set.intersection(*(set(b) for a,b in solutions))==set()

report={
 'kind':'standalone finite flow/property model; no Silk acceptance',
 'acyclic_cfg_assignment_cases':acyclic,'sentinel_permutations':scans,
 'minimum_overwrite':{'historical_loan_input':historical_loan_input,'actual_read':sorted(actual),
   'eager_storing':eager_storing,'actual_borrow_storing':actual_storing},
 'repeated_id_precision_observations':observed,
 'temporal_probes':['earlyStore includes caller+backedge owned','beforeLoopStore caller only',
   'zero-iteration caller retained','grounded copy cycle O','ungrounded cycle remains uninitialized'],
 'complete_drop_fixed_points':[[sorted(a),sorted(b)] for a,b in solutions],
 'invalid_frozen_outputs':[sorted(x) for x in frozen],
 'all_assertions':'PASS'
}


# Generic normal-rule well-founded enclosure checked against exhaustive stable
# interpretations. The oracle enumerates interpretations, removes negative rules,
# then closes positive rules. It does not call the alternating refiner.
def closure(rules, assumed):
    reduct=[(h,pos) for h,pos,neg in rules if not (neg & assumed)]
    facts=set()
    while True:
        new=facts|{h for h,pos in reduct if pos <= facts}
        if new==facts:return frozenset(facts)
        facts=new

def alternating(rules, atoms):
    low=frozenset(); high=frozenset(atoms)
    steps=0
    while True:
        newlow=closure(rules, high)
        newhigh=closure(rules, newlow)
        assert low <= newlow <= newhigh <= high
        steps+=1
        if (newlow,newhigh)==(low,high): return low,high,steps
        low,high=newlow,newhigh

def exhaustive_stable(rules, atoms):
    answer=[]
    for flags in product((0,1),repeat=len(atoms)):
        assumed={a for a,flag in zip(atoms,flags) if flag}
        # Independent repeated scanning with an explicit enabled-rule table.
        enabled=[(h,tuple(pos)) for h,pos,neg in rules if all(n not in assumed for n in neg)]
        reached=[]
        for _ in range(len(atoms)+1):
            for h,pos in enabled:
                if h not in reached and all(p in reached for p in pos):reached.append(h)
        if set(reached)==assumed:answer.append(frozenset(assumed))
    return answer

atoms=('a','b')
options=[]
for head in atoms:
    options.append((head,frozenset(),frozenset()))
    for a in atoms:
        options.append((head,frozenset((a,)),frozenset()))
        options.append((head,frozenset(),frozenset((a,))))
programs=0; nostable=0; maxsteps=0
for selected in product((0,1),repeat=len(options)):
    rules=[r for r,flag in zip(options,selected) if flag]
    low,high,steps=alternating(rules,atoms)
    stable=exhaustive_stable(rules,atoms)
    for solution in stable:assert low <= solution <= high
    if not stable:nostable+=1
    # If refiner is total it is the unique stable interpretation, not an arbitrary
    # stable interpretation chosen by iteration order.
    if low==high:assert stable==[low]
    maxsteps=max(maxsteps,steps);programs+=1

rules=[('AO',frozenset(),frozenset(('BW',))),
       ('AW',frozenset(('BW',)),frozenset()),
       ('BW',frozenset(),frozenset(('AO',))),
       ('BO',frozenset(('AO',)),frozenset())]
low,high,_=alternating(rules,('AO','AW','BW','BO'))
assert not low and high==frozenset(('AO','AW','BW','BO'))
assert len(exhaustive_stable(rules,('AO','AW','BW','BO')))==2
positive=[('entry',frozenset(),frozenset()),('p',frozenset(('entry',)),frozenset()),
          ('q',frozenset(('p',)),frozenset()),('p',frozenset(('q',)),frozenset())]
assert alternating(positive,('entry','p','q'))[:2]==(frozenset(('entry','p','q')),)*2
assert alternating(positive[2:],('p','q'))[:2]==(frozenset(),)*2

# Component graph: recursive reference edge, no growing concrete path IDs. A finite
# query follows the edge; enumerating walks independently gives the same reachable
# endpoint sets even when the same type/component is revisited.
components={0:{'next':{0,1},'item':{2}},1:{'next':{0},'item':{3}},2:{},3:{}}
def query(word):
    reached={0}
    for step in word:reached={n for p in reached for n in components[p].get(step,set())}
    return reached
component_cases=0
for length in range(7):
    for word in product(('next','item'),repeat=length):
        walks=[(0,)]
        for step in word:
            walks=[w+(n,) for w in walks for n in components[w[-1]].get(step,set())]
        assert query(word)=={w[-1] for w in walks}
        component_cases+=1
report['alternating_refinement']={'normal_programs':programs,'without_stable_model':nostable,
 'max_refinement_rounds':maxsteps,'encloses_all_stable_models':True,
 'total_results_are_unique_stable_model':True,'complete_drop_lower':sorted(low),'complete_drop_upper':sorted(high),
 'grounded_copy_cycle':'total entry,p,q','ungrounded_cycle':'no sources; not LoanFree'}
report['component_graph']={'vertices':4,'finite_queries':component_cases,'max_query_steps':6,
 'property':'finite graph traversal equals independently enumerated walks; not a compiler path-closure proof'}
from pathlib import Path
Path(__file__).with_name('model-results.json').write_text(json.dumps(report,indent=2)+'\n')



# Separate concrete small-machine oracle for aliases: enumerate reachable (pc,store)
# states, not dataflow sets. Compare to a distributive copy/gen/kill solver.
def machine(edges, actions):
    todo=deque([(0,('uninitialized','uninitialized'))]); seen=set(); values=[set() for _ in edges]
    while todo:
        pc,state=todo.popleft()
        if (pc,state) in seen:continue
        seen.add((pc,state)); values[pc].add(state)
        out=list(state)
        if pc in actions:
            dst,kind,arg=actions[pc]
            out[dst]=state[arg] if kind=='copy' else arg
        todo.extend((n,tuple(out)) for n in edges[pc])
    return [{i:{state[i] for state in states} for i in range(2)} for states in values]

def alias_flow(edges, actions):
    ins=[[set(),set()] for _ in edges]; ins[0]=[{'uninitialized'},{'uninitialized'}]
    change=True
    while change:
        change=False
        for p in range(len(edges)):
            out=[set(x) for x in ins[p]]
            if p in actions and ins[p][0]:
                dst,kind,arg=actions[p]
                out[dst]=set(ins[p][arg]) if kind=='copy' else {arg}
            for n in edges[p]:
                for v in range(2):
                    size=len(ins[n][v]);ins[n][v]|=out[v]
                    change |= len(ins[n][v])!=size
    return [{i:s for i,s in enumerate(row)} for row in ins]

choices=(None,(0,'constant','owned'),(0,'constant','caller'),(1,'copy',0),(0,'copy',1))
alias_cases=0
for bits in product((0,1),repeat=6):
    edges=[[] for _ in range(4)]
    for on,(i,j) in zip(bits,[(i,j) for i in range(4) for j in range(i+1,4)]):
        if on:edges[i].append(j)
    for chosen in product(choices,repeat=3):
        actions={i:a for i,a in enumerate(chosen) if a is not None}
        assert alias_flow(edges,actions)==machine(edges,actions)
        alias_cases+=1
# saved=q is before the later q replacement in each iteration; next iteration must
# copy the new source. A copy before the loop remains caller-only.
edges=[[1],[2,5],[3],[4],[1],[]]
actions={0:(0,'constant','caller'),2:(1,'copy',0),4:(0,'constant','owned')}
assert alias_flow(edges,actions)==machine(edges,actions)
assert machine(edges,actions)[3][1]=={'caller','owned'}
edges2=[[1],[2],[3,5],[4],[2],[]]
actions2={0:(0,'constant','caller'),1:(1,'copy',0),4:(0,'constant','owned')}
assert alias_flow(edges2,actions2)==machine(edges2,actions2)
assert machine(edges2,actions2)[3][1]=={'caller'}
# Explicit unknown is transported as a source, never interpreted as empty.
assert alias_flow([[1],[2],[]],{0:(0,'constant','unknown'),1:(1,'copy',0)})[2][1]=={'unknown'}
report['alias_flow']={'acyclic_cfg_action_cases':alias_cases,'variables':2,'acyclic_points':4,
 'actions':['no-write','q=owned','q=caller','saved=q','q=saved'],
 'oracle':'reachable (pc,concrete two-variable store) states; independent of set equations',
 'backedge_copy':'saved includes caller+owned','before_loop_copy':'saved caller only',
 'unknown_copy':'unknown remains explicit','all_assertions':'PASS'}
Path(__file__).with_name('model-results.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
