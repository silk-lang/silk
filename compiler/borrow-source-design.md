# Complete sources: B design for independent review

Status: **repair2 proposal for NEW independent design review3; no C implementation or Silk
acceptance**. Exact reviewed baseline `985eb0ea2d07fecd3cccc08939d07be901d20967` and its models
are preserved. Accepted main `6c1608657dbdb11efce96ca973213e8cbd809f64` is merged cleanly; its
PR1983 caller/CFG policy is now the migration baseline. This continuation has no production delta
against that main, changes no published PR, and imports no unpublished environment/#1957 work.

Read this document with the normative [policy rules](borrow-source-policy-rules.md) and jointly
agreed [Semantic preparation/API](borrow-source-preparation.md). They form one proposal. The
rules replace the baseline's missing directness/precision/stop translation; the preparation
package replaces its unsupplied shape/query boundary. The accepted A extraction and inventory
remain in [borrow-policy-staging.md](borrow-policy-staging.md). Original baseline/repair1 model evidence
is distinct from the repair2 correspondence probes in section 8. Neither is compiler acceptance.

The intended contract is the value actually reaching a queried read. Historical definitions
which cannot reach it are not operands. This is an intentional correction to eager enumeration,
not a requirement to reproduce its incidental decisions. Equivalence means: identical valid
ordered inputs and observation states give identical policy decisions/effects. It does **not**
mean all acyclic bodies keep their old verdict. Neither source completeness nor this design
waives original caller/static obligations, ownership checks or source-local diagnostics.

## 1. The necessary semantic choice, with a minimal witness

At the A head:

- `hold` appends definitions and appends their IDs to `walker.held[holder]`; deduplication is
  within that invocation, not across different writes.
- `replace` marks the replacement point as defining the holder. An RHS carrying no Loan still
  kills old definitions but creates no Holding for its actual caller/loan-free value.
- `useHolder` enumerates every ID in `walker.held[holder]`, before `reachingHoldings` filters
  by kills and paired reads. `keepCarried` and `finish` can already mutate global state.

The smallest flow witness is one loan L, two writes and a read:

```
d0: q = Borrow(L)
d1: q = Entry(caller)       // unconditional; has a real value, no Loan ID
r:  use(q)
```

Actual read sources are `{(d1, Entry(caller))}`. Eager loan inputs still contain `(d0,L,r)`.
If the call's sink is Universal, the carried loan is not the operand's own borrow and L is typed
locally, `keptSink` classifies it Unknown and `keepCarried` sets storing. The reaching-value input
contains no such borrowed operand. This establishes a decision-input/effect difference at the
helper boundary; it does not claim a newly measured full Silk verdict.

Small actual-Silk source shapes for later acceptance (not compiled in this design task):

```silk
fn inspect<'a>(x: &'a i32) -> i32 { return x.* }
fn killed<'a>(caller: &'a i32) -> i32 {
  let local = 1
  let mut q = &local
  q = caller
  return inspect(q)
}
fn repeated<'a>(caller: &'a i32) -> i32 {
  let mut q = caller
  q = q
  return inspect(q)
}
fn copiedBeforeReset<'a>(caller: &'a i32) -> i32 {
  let local = 1
  let mut q = &local
  let saved = q
  q = caller
  return inspect(saved) + inspect(q)
}
```

Expected **source semantics**: killed's final q has only caller; repeated's final q is one
value-component source with the genuine earlier read/write chain; copiedBeforeReset's saved
retains local while q has caller. These snippets are not claims that the simple inspect call
exercises the Universal sink witness above. Existing environment review fixtures separately
expose killed/local and backedge obligations; their old verdicts are not new measurements here.

Two writes of the same L to the same position produce two historical Holding IDs. The old read
can present both, so an unknown-result policy observes L's precision Exact then Unknown. The
actual read after an unconditional replacement has one reaching definition, not two simultaneous
references. Conversely `pair(q, q)` has two real operand occurrences and must not collapse to one
merely because their Loan ID matches. This distinction defines the representation below.

Intentional differences to audit in C: killed inputs no longer set storing/escape, degrade
precision, supply complete/declared witnesses, add whole-hold records or trigger source-sensitive
unsupported gates. New backedge inputs can do all of those when genuinely reaching. Copy-before-
reset alternatives survive. No eliminated candidate is converted to LoanFree or proof of safety.
A removed witness cannot justify complete/drop: a new certificate needs independently grounded
actual witnesses. Removing a non-witness that blocked an all-sources guard is permissible only
when every remaining actual source and positive witness is proved, not by vacuous emptiness.

## 2. One finite skeleton, including effect dependencies

Build the skeleton from the **complete** typed body, before policy output selection. Use the
existing visitor's structural evaluation order and CFG construction, including statement/arm
scopes, cleanup, break/continue/return and noncompletion. Do not unroll loops. Each static visit
has `EvalId=(node, evaluation-role, occurrence-within-structural-expansion)`; a reused NodeId
visited twice has two EvalIds. IDs are assigned by structural traversal, never worklist discovery.
The body is finite after static expansion. Let N count these expanded evaluations/ports, rather
than assuming a DAG node visited several times costs one event.

Conditional operations reserve event/definition/effect slots even when they eventually do
nothing. Their activity predicate controls generated facts, never the existence of the slots.
Examples include an argument-initiated store, a parent loan carried by a read, and a cleanup
observation. There is a fixed later-source location before inference begins. A stop/unsupported
policy records a gated coverage fact; structural construction may continue to record the rest
without claiming its semantics supported. Source-sensitive unknown/refuted policy cannot
silently omit an unknown successor. Existing genuinely unsupported shapes remain explicit gaps.
No new While feasibility rule is introduced; accepted CFG semantics are a dependency.
Structural occurrence creation must not consult mutable `holds`/carry length: reserve its
use/borrow/store slots, then gate their activity by the solved facts. Repeated implicit borrows
are keyed by their real static evaluation role; reservation itself creates no Loan witness.

IDs and domains:

| Identity | Finite construction and meaning |
| --- | --- |
| EvalId / PortId | static evaluation and written operand/result/arm/cleanup role |
| PointId / ReadId | existing CFG event sites; read has holder, exact selection and EvalId |
| DefId | every entry, binding, replacement and actual field-write site, independent of loans |
| LeafId | Entry(local), Borrow(actual loan site), Expression(real producer), LoanFree(positively nonretaining producer), Unknown(origin/reason) |
| ComponentId | owner-local typed component or external selector port, described below |
| FactId | `(DefId or value PortId, ComponentId, LeafId, role)`; role distinguishes real/shadow/inherited |
| WitnessId | paired `(source DefId/FactId, ReadId, receiving transfer slot)`; never independent definition/read unions |
| RouteCaseId | occurrence + paired transfer + typed input/output placement + direct evidence; applicability and source-quality version remain conditional together |
| EffectId | `(EvalId, phase, occurrence, target LeafId/LoanId, output placement, effect kind, policy reason)` |

Whole-value definition/producer identity and its retained-loan projection have distinct types
inside this same representation. Original loan policies iterate only actual Borrow facts; Entry,
Expression and LoanFree do not inflate `carried.length` or participate as fake borrowed witnesses.
An Expression identity marks the genuine RHS whose declaration route Semantic must interpret;
it is not an extra independent origin added on top of already described borrowed components,
and never grounds an input source merely because a call result exists. Crossing a deferred route
retains the producer/operand link and an unresolved-route predicate until that route is proved.

Unknown is a real alternative with incomplete interpretation. Entry is not LoanFree and not
implicitly universal. Borrow(implicit node absent) retains its real loan site/origin and cannot
be made a manufactured typed borrow. Uninitialized and unreachable are distinct coverage facts,
not empty successful source vectors. A node not evaluated has MissingEvaluation. Ordinary and
anonymous recovery preparation never produces a certifying coverage state.

### Typed components without growing path strings

Semantic first builds the immutable SourcePreparation described in
[the preparation contract](borrow-source-preparation.md), using the active body's tracked
Members/MemberShape/Signature/AppliedOperation demands. Types interning and typed Field nodes
alone cannot supply the inventory. Its complete exact nominal applications, original binder
correspondences, verified typed maps and finite predicate roots are required inputs. No query
runs during solving and no solved source selects a new shape demand.

A component is a **slot in a value/storage representation**, not the full history of field
prefixes through which its contents arrived. For each typed value/definition root reserve its
finite inline field/member structure. Fixed-array selectors use the finitely mentioned constant
indices plus the symbolic remaining-elements class, not allocation proportional to an array's
numeric bound. Computed indices retain their may-overlap policy and never kill all elements.
Exact known index classes remain distinct. A member tag stays part of the slot identity.

References/slices end the inline slot expansion. Their referent is a directed relation to source
storage/selector ports, not another prefix appended to a copied field vector. Borrow makes an
edge from its descriptor slot to the actual borrowed place; copying preserves that edge. A
projection follows the authored selector edges. A recursive reference can revisit a vertex;
it cannot allocate successively longer components on each fixed-point visit. Owned recursive
inline layout cannot be finite; it must already have its existing type/layout refusal, not be
silently accepted by this analysis.

For external Entry/opaque producers with no local concrete storage, reserve selector ports
`(leaf, authored selector-site, endpoint type evidence)`. These are source routes, **not distinct
owned storage objects**: different ports cannot establish disjoint owners. Repeated application
of a selector site is represented by a graph cycle. Known declaration/result/capture/kept-slot
paths contribute their finite selector tries up front. Existing unknown output position is an
explicit OpaquePosition port, different from an unknown source. Unknown element/referent/opaque
boundaries retain their present precision restrictions; the representation introduces no depth
limit and no "cycle means Unknown" conversion.

Prefix/strip become edge maps between value slots. `referencedPath` becomes a referent edge plus
its residual selector route. `declaredResultCarries` connects each declared result slot to its
authenticated input slot; `destinationField` connects the actual lent place to the declared
eligible destination slot. Equality/dedup uses the same physical owner/component, not equal
lifetime atoms or equal endpoint type. Reference routes never prove field disjointness merely
because selector-port IDs differ. The existing exact owned-path predicates still decide kills
and disjointness; no source routing grants a new owner alias exemption.

This is finite with O(N*C + L*S) component/selector vertices, where C is the total finite inline
component description demanded by the typed body/contracts, L the real leaves and S the authored
selector-trie positions. It is polynomial in these explicit inputs; no claim is made that
expanding arbitrary recursive types or every array element is polynomial in source text.
Construction must consume finite typed component descriptions, not recursively instantiate
unobserved generic fields. Queries outside the prepared typed selector interface fail validated route access. A genuine
language/proof limitation retains its explicit coverage record; a missing supported selector
map is a construction blocker, never a new accepted UnknownSelection gap.

Concrete construction order is: (1) reserve evaluation/definition roots and their typed inline
component descriptors; (2) intern the authored/declared selector tries; (3) reserve external ports
for the finite leaf-by-selector product, without reading selected outputs; (4) connect each
constructor/projection/borrow/store by its fixed typed edge map; (5) close source and conditional
edge facts on these fixed IDs. A source query may form a temporary finite product of its selector
trie and this graph; it allocates no new analysis fact/definition and does not mutate the CFG.
An index outside the known classes still maps to the existing remainder/may-overlap class; a
failed typed component map is an explicit constructor coverage defect, not permission to silently
fall back to unknown for a previously supported operation.

The agreed API is `prepare(..., SourcePreparation, coverage)`, then immutable
`sourcesAt(read, SelectionId)` and stamped route/port/edge/case access. SelectionId references
an already prepared selector; arbitrary new vector paths cannot trigger late graph growth.
SourceRouteId exposes starts, accepts, typed endpoint/application evidence and paired cases.
Semantic's finite product uses prepared PredicateIds and checks every possible accepting route;
visited coverage never proves Contents/outlives. A missing supported map is a construction
blocker, not a legitimate new UnknownSelection gap. The exact design signatures, original
application/result/success split, three worked examples, stamp/rebase/recovery lifecycle and
#1957 metadata constraints are in the jointly agreed preparation document. Archived env WIP is
preserved and must migrate atomically; it is not an alternate implementation.

## 3. Conditional routes, multiplicity and observation order

[The policy rules](borrow-source-policy-rules.md) define the exact normalization and consumer
quantifiers. One physical operand/component/leaf observation contains all paired alternative
RouteCases. Historical definitions are not copies. Directness and typed placement stay together
with their definition/read witness: declared placement can be Exact yet indirect. Evaluate each
case against the same incoming state, union conditional effects once, then advance the observation
version. Genuinely separate components/operands observe earlier effects even for the same loan.
Target leaf/loan and output placement distinguish EffectIds.

Original operand order (including MAX), structural component order, parent visitation and the
original branch order remain meaningful. All-case coverage/release needs all possible cases;
an undefined case cannot supply a positive witness. Conditional effects keep their source and
policy reason. Entry/LoanFree are genuine definitions but do not inflate Borrow carry counts.
Exact field writes kill their actual storage components; copies retain their original read;
referent reads follow current addressed storage, not a stale descriptor value snapshot.

## 4. Grounded precision and policy gates

The policy-rules document supplies the missing translation: positive S/A loss bits, actual
presence, per-source Q and structural per-loan P versions, input barriers, fixed operation
snapshots and sequential real positions. Loss-free positive cycles derive Exact from presence
and the proved absence of loss; no quality category or candidate borrow is optimistically seeded.
Undefined loss is not false. Kept exact branches preserve bits; result alternatives add A;
unknown results and eligible cleanup of empty named regions add S+A; retained stores add S.
Nonempty cleanup observations add intervals without loss, even with everything=true.
Drops preserve earlier state/effects.
Only an actual value path can bring later loss backward into an earlier read. The saved pre-loop
snapshot is not overwritten merely by equal LoanId. Full rules, category admission, complete/drop
feedback and mid-constructor observations are normative there, rather than an unspecified table.

The original gates must be translated literally, not reconstructed from generic graph reachability:

| Site | Gate / ordering to preserve after actual-input normalization |
| --- | --- |
| finish entry | result point, sealed/unheld; call-retention effects; consume; only retaining results enter result policy, and only if actual loan carries are nonempty |
| retainedParents | known AND not stores AND carry count >1, before per-carry effects; actual borrowed/parent closure, no precision promotion |
| declaredResultLoans | independent invocation on the carrying retaining-result path; original direct-call or immediate-run metadata and Exact source/parent checks |
| requiredRetainedRegions | known AND not stores; no edges or no unmatched local source means empty closure; otherwise named local seeds, original directed edges and borrowed identity |
| naming / complete | exact MAX-sensitive ordered scan; known/not-stores/not-outside/not-several/non-MAX-name/count>1 plus every actual source Exact and real matching local witnesses |
| callImplied | unnamed AND known AND not stores AND nonempty typed operands; original settled/open relation evidence |
| resultDecision | unchanged stores/excluded/known/outside-forward/outside-bound/outside-drop/declared/complete/several/unique/implied precedence; mapped versus original field distinction |
| whole hold | kept, not declared, mapped whole position, forwarding not Matched; described only ordinary typed call, as A |
| unreachableField | actual qualifying field read; Exact body source, required-source exclusion, **at least one prior whole hold** for this loan, every prior relevant hold described and its implied facts known, then mayOutlive exclusion |
| retainedSinks | Same view path narrows regardless of direct; Unknown uses direct/referent fallback; keep located separate; same operand/only selector and parent closure complete before effects, replacing promoted provisional sinks |
| defer | keepCarried immediately after each original argument visit, before appending it; correct direct caller is defer, not invoke |
| invoke | pipeline/callee/arguments order; finish, storeIntoLent, then storeThroughExclusive; original callee-loan exclusion |
| construct | original opaque pass before universal stored-region pass; CaptureHold gates, storable/inherited effects and reference-capture loans preserved |
| storeIntoLent | nonempty actual carries, not outside, completing point, callKept present; exclusive actual destination roots, source/target/slot predicates, reference-holder refusal and whole-value rehold semantics preserved |
| ReadPlace / attributeRead | original place-through/steps gate, nonempty loan carries or through-holder condition, nodeRetains; scalar excludes real shadow definitions, retaining read keeps its original field filtering/reborrow/declared gates |
| replace / hold | callable replacement with carried loans remains unsupported; retains gate uses the actual loan projection; every write still defines whole-value state; loopCleanup and mutable/callable gates remain conditional predicates |
| PlaceAssignment / Displace | original path-through/local-source/retaining predicates, exact write/shadow rules and unsupported displaced-view boundary; no general direct-caller-store allowance in C |
| cleanup / storage | preserve outer observation/refusal gates; interval on everything OR named.empty OR shares; S+A loss only for interval AND named.empty; loop-cleanup/must-init/real-shadow-inherited unchanged |

WholeHold, unretained, intervals, escape, storable and storing are conditional EffectIds, emitted
once after solving, in structural/occurrence order. A solver revisit never appends again. The
prior-whole-hold query reads only earlier effect IDs and retains its nonempty test. Region,
availability and universal proofs are unchanged except plumbing to the actual Borrow facts.
CFG-only source dependencies are insufficient: every guard's state/query dependency above is
also an edge, including input-quality joins and prior-whole-hold facts.

## 5. Grounded refinement and multiple solutions

Compile the finite transfers, gen/kill relations, gate circuits and effect versions into one
finite normal rule program. The existing CFG reaching equations supply the temporal part; there
is no second lexical scan and no parallel loan-only flow. A normal rule has one head and a
finite conjunction of positive/negative predicate inputs. Auxiliary gates keep rule size
polynomial: OR is multiple rules, AND one rule, negation a negative literal; finite-state naming
uses ordered conditional transitions. Precision uses the grounded S/A loss rules, not a cyclic
one-hot category join table. For example:

```
Witness(a) <- Present(i), ExactAtSnapshot(i), BorrowedEquals(i,a), RecordedOwnAtom(i)
BadExact   <- Present(i), not ExactAtSnapshot(i)
AllExact   <- not BadExact
Complete   <- OriginalOuterGuards, AllExact, Witness(a1), ..., Witness(ak)
Active(j)  <- Guard(j), not EarlierGuard(1), ..., not EarlierGuard(j-1)
```

Named local atoms a1..ak are fixed typed inputs; no-local-result and unknown-domain cases retain
their original false guard. `Present` requires a genuine leaf plus an actual transfer/reaching
witness. A raw member of the candidate universe is never a Present fact. ExactAtSnapshot requires
grounded presence and both loss bits proved absent at the appropriate source/loan versions.
AllExact alone cannot prove Complete; zero sources or merely possible witnesses are insufficient. Actual-read reaching
uses fixed kills, never an assumption that an absent loan means an absent write.

For a set S of assumed true atoms, define Gamma(S) by discarding rules with a negative literal
whose atom is in S, erasing remaining negative literals, and taking the **least** positive fixed
point of the resulting rules. Facts/actual entries seed that closure; cycles do not seed themselves.
Gamma is antitone. Initialize K=empty and U=the finite atom universe. Repeatedly compute
`K' = Gamma(U); U' = Gamma(K')` until stable. K grows, U shrinks. True means in K; false means
outside U; otherwise undefined. This is an alternating founded enclosure, not a maximal candidate
source set certified Exact. Every admissible grounded stable solution lies between K and U.

Each positive closure runs only the existing shared worklist equations specialized by the
current guard assumptions. No enumerating subsets/solutions in production. Let A be the number
of ground atoms and R the total rule-body incidences. With indexed Horn propagation, a Gamma
pass costs O(A+R); at most 2A strict fact additions/removals occur across alternating rounds,
giving a conservative O(A*(A+R)) bound. Reachability and component/typed-path predicates are
compiled/shared once rather than hidden exponential oracles inside a guard.

Source interpretation must respect this enclosure:

- A proved source alternative is in K and has finite grounded transfer evidence. A possible
  alternative in U\K remains possible; it cannot be used as a witness to discard another source.
- Universal source safety needs every possible alternative safe and every mandatory route/proof
  complete. A possible owned source is not automatically an exact rejection: rejection requires
  the existing exact loan/source evidence and event applicability, not just upper membership.
- No stable solution / inconsistent precision categories cannot imply anything by vacuity.
  Undefined or inconsistent reachable obligations prevent Checked. This is a precise unresolved
  policy result, not converting every cyclic component to Unknown.
- A total result on the reachable proof slice is uniquely justified by the rule program. A
  partial result can still contain useful independently proved facts/refutations, but cannot
  publish a mandatory success using an undefined source or guard.
- All supplied roots and original selected-operation contracts remain mandatory. They are not
  generated by this source closure. Semantic interprets declared routing and universal predicates
  through dependency-tracked queries; an Entry declaration still has to prove the required bound.

Two-operation complete/drop example has **two** grounded solutions: A and B both output O, or
A and B both output W. Neither the cross-selected `(A=W,B=O)` result nor either arbitrary stable
solution is justified as the unique answer. Alternation leaves all four output-membership facts
possible and none definite. Therefore neither cross-witness authorizes complete/drop. This
handles the ambiguity explicitly rather than picking the first fixed point visited.

The grounded identity loop is different: Entry/Borrow O reaches q via the zero-iteration edge;
copy and single-name retention preserve presence. No loss operation grounds S/A, so positive
loss closure is empty, both losses are outside U, and Exact derives. K=U on its source/quality
slice. A real Stored backedge instead grounds S and transports it to the loop read; no initial
Exact seed can bypass it. A source-free copy cycle produces no source;
if its read is reachable it reports uninitialized/ungrounded coverage, not LoanFree. The counter-
example's nonuniqueness does not force this positive to become unchecked.

This enclosure is conservative, not the best exponential correlation-aware abstraction. It may
leave some valid programs unresolved. Before publication the actual full positive controls must
show that this does not regress accepted precision. Unrelated Checked programs cannot be
relabeled or waved away because a theoretical enclosure is sound. A concrete unresolved necessary
positive requires a more precise finite guard representation or an explicit reviewed language/
policy decision; the implementation must not silently weaken a mandatory proof.

## 6. Lifecycle and consumers

Semantic's tracked `prepareSourceInputs` closes the immutable package before reservation.
`prepare` consumes that package, builds the complete structural skeleton once, solves the combined
temporal/source/state rules, and owns immutable Analysis-local IDs, route graph and effect facts. It is not permitted
to return an eager prefix as complete. `sourcesAt(actualRead, stampedSelection)` projects this same
analysis; multiple EvalIds for a NodeId are returned with their occurrence identities. No side
cache of temporally scanned assignments exists. Definition/read witnesses remain paired even
when alternatives are normalized into one component source.

`checkPrepared` materializes each existing effect once, then runs ownership/region consumers with
Borrow-only source identities and the existing policy. All initialization/release/end/move/drop
masks are preserved. An incomplete source-request analysis prevents Checked. The explicit terminal
schedule and runtime-vs-policy-stop translation in the policy rules
preserve guard/nonreturn/outside/event/storing/imprecision/inherited/region precedence. Source
enumeration continues past checker stops without treating them as runtime noncompletion. New
later conflicts cannot leap over an earlier outside gate; worklist order is never report order.
Foreign/missing/duplicate request ordinals remain Pending; only the Analysis's
private stamp plus the exact retained obligation can accept Proved. Recovery cannot certify.

Ordinary body, anonymous ClosedBody/CheckedLiteral, derived Effect, clone/rebase/recheck lifecycle
is still the env owner's responsibility. The archived environment WIP is not imported. Its
Vector-only residual path handling is not proof for the route-graph amendment. Semantic must
consume route edges without another temporal engine; unresolved declared/type routing is Pending.
No-loan bodies with mandatory requests still prepare, because Entry and LoanFree definitions are
essential even when the existing loan vector is empty.

Constructor migration is atomic: Carry/Flow become references to normalized value ports/facts;
Holding/HoldingSource become the definition/fact/witness relations, with no dummy loan index.
`takeLoan`, entry setup, holdTemporary, binding/replace/field writes, shadow, result placement,
construct, invoke/defer, storeIntoLent, cleanup and rejoin all use those identities. Existing
consumer code must explicitly select Borrow leaves before indexing loans. Source request routes,
loan intervals, holding liveness and final region proof consume the same facts, not rival tables.
The existing analysis's several bitset passes can remain specialized consumers of the same graph;
"one analysis" does not require conflating must-initialization with may-reaching sources.

Accepted PR1983 at main6c160865 supplies the caller-retention policy. Its classifier must migrate
to complete paired source facts and actual operation reachability. Creation order, forward-link absence or the first
parent visited cannot establish Actual/Absent. Preserve independent escape reasons and its exact
applicability policy. Accepted literal-Boolean loop feasibility is CFG input. No unpublished policy is imported.

## 7. Bounds, invariants and explicit review assumptions

Given finite N,C,L,S above, let V=O(N*C+L*S) slots and D=O(N*C) definition sites. Normalized value
facts number at most O((N+D)*V*L*3) before fixed finite precision/coverage tags. Witness pairs are
bounded by facts * reads * receiving slots; case count adds finite placement/transfer/direct tags,
and effect count includes finite target/placement/reason products. Predicate products use the
prepared obligation/endpoint/application/case IDs, never growing type expressions; a conservative polynomial product is sufficient for
allocation planning, not a promise that eagerly allocating the Cartesian product is cheap.
Sparse demand construction may avoid unused facts, but it must be a structural least closure
which ignores policy selection; deleting a candidate because a tentative policy dropped it is
forbidden. Nothing creates a new identity during refinement. A loop changes fact truth, not IDs.

Input normalization removes unbounded history multiplicity. Recursive selector routes use finite
graph edges, not strings grown by copying. Branch/value source alternatives and state versions are
finite. The cost target still requires sparse indexing and shared closures; no correctness test
will assert timing. This design's bounds are in the finite elaborated representation, not a
claim that arbitrary source-level generic expansion is finite.

Required invariants for C implementation/review:

1. Every real initialized value write has a definition, including caller/loan-free/unknown RHS;
   every actual value read has an occurrence and all reachable definitions. No absent data proves
   safety. Copy-before-reset keeps the earlier read predicate; later backedges reach only reads
   they can actually revisit.
2. Each actual source mapping has a grounded leaf and paired witness. Normalization merges only
   same physical component/leaf/role alternatives, preserving each conditional direct/placement
   case and its source/read pair. Distinct real copies/components survive.
3. Component routing preserves source/field and owner identity. External selector IDs cannot
   prove distinct storage. All original supported field/reference transformations must fit the
   finite graph; using Unknown merely to avoid representing a recursive route is prohibited.
4. Every policy read has the right version and complete input gates. Snapshot complete/declared
   facts do not change midway through per-carry application. Repeated real loan occurrences see
   earlier effects. Possible Exact is never a grounded witness.
5. Effects never make their own input candidate exist. Founded closure, original constraints and
   exact report origins are mandatory. Removing stale witnesses is not a release certificate.
6. Final consumers read one representation; old eager classification is deleted, not retained as
   a fallback. Actual source correction and future inference remain separately reviewable changes.

**Not established by the scratch model:** correspondence of every compiler constructor to the
component graph; preservation of all supported recursive/opaque precision; full soundness of
rule compilation for Type/signature predicates; practical cost; actual compiler diagnostics or
any formerly Checked fixture. These are concrete independent-review/implementation obligations,
not authorization to fill an uncovered case with guessed semantics. In particular the jointly agreed preparation/route API, conditional-case normalization and
grounded loss rules are proposed design changes, not part of A's approval. Independent design review must accept/reject them before production migration.

## 8. Model evidence and acceptance contract

The original 985eb0ea archive remains byte-identical. Its executable is a specification probe,
not a compiler test or bootstrap shim.
It has independent oracles:

- 1,269 reachable acyclic four-point CFG/write assignments: a path interpreter records the last
  executed write; a separate gen/kill fixed point must return exactly those sources. Writes are
  absent, owned or caller, with write occurrence identity. All 64 ordered four-vertex DAG edge
  subsets and 27 write assignments are considered, excluding no-path graphs.
- 8,000 four-point DAG/action combinations with two variables: a separate concrete machine
  explores `(program point, two-variable store)` states, compared with a copy/gen/kill set solver.
  Actions are no write, q=owned, q=caller, saved=q and q=saved. Additional cyclic probes distinguish
  saved=q before a later backedge replacement from a saved copy before the loop, and transport an
  explicit Unknown source without treating it as empty.
- 364 operand sequences of lengths 0..5 over {MAX,0,1}: scan compared with a first-non-MAX/suffix
  characterization; includes both `[MAX,0]` and `[0,MAX]` and repeated operands.
- Explicit earlyStore/backedge versus beforeLoopStore, zero-iteration caller, copy-cycle ground,
  and source-free cycle probes. Same-loan historical writes show Exact then Unknown eager
  observations while the actual overwrite read has one definition.
- 1,024 normal programs over two atoms: exhaustive stable-interpretation enumeration independent
  of alternating refinement. Every stable interpretation is enclosed; every total enclosure is
  the unique stable interpretation. 308 have no stable interpretation; none is used to prove
  safety. Maximum observed refinement count is three (not a performance guarantee).
- Complete/drop equations have the two stated solutions and reject the frozen cross-output.
  The grounded copy-cycle is total; the ungrounded cycle has no real source.
- 127 selector words of length 0..6 on a four-vertex cyclic component graph: set traversal equals
  independently enumerated walks. This verifies finite graph traversal, **not** completeness of
  the compiler-to-component-graph translation.

The repair1 archive additionally contains the exact independent review/probes and a separate
model with these bounded checks:

- 784 graph/action pairs: all 16 specified optional-edge CFGs × 49 action pairs, concrete finite
  store-state exploration versus positive presence/loss equations. Two cells, L/C leaves, absent
  or four masks; identity/copy/S-loss/A-loss/caller-kill/weak-call actions. This includes backedges
  without finite loop unrolling, not arbitrary policy programs.
- Focused identity Exact, real Stored backedge, saved pre-loop vs in-loop copy, conditional call
  old+received vs strong kill, explicit Unknown source, undefined/absent/category-invalid admission.
- Twenty-four precision transitions cover all four initial masks and exact/alternative/unknown/
  drop/store/cleanup; four complete/drop witness controls preserve presence and loss requirements.
  Independent Boolean enumeration retains both complete/drop feedback solutions, rejecting the
  frozen cross-output. Explicit LoanFree replacement is separate from Unknown and absence.
- Eight direct/indirect/opaque route subsets compared with individual case outcomes; historical
  duplicate invariance, actual repeated positions 1..5, paired read authentication and four
  distinct target/placement effect keys.
- Sixteen prepared recursive route graphs compared with simple-path reachability and independent
  accepting predicates; a visited cycle cannot prove a false/missing terminal predicate.
- Small explicit nominal field-kill/copy, original nested-success sibling-binder, checker-stop
  versus runtime-flow and diagnostic-stage probes. These last probes state narrow contracts;
  they are not a full result/retention/query/diagnostic oracle.

Repair1's route-subset classifier used a stale direct-and-field0 rule; its historical PASS
is **not** correspondence evidence for accepted main6c. Its 24 transitions test already-selected
loss events, not the cleanup eligibility/subgate. Review2 resolved the three architecture
blockers but required these two bounded corrections. Repair2's separate archive tests the
current Same/Different/Unknown classifier with located evidence, mixed indirect/direct histories,
parent-closure-before-effects, Exact/Stored adapter gates and cleanup interval/loss subgates.
Repair2 retains six slot-path/directness boundary answers plus exact indirect/mixed and
Unknown-path controls, 16 parent-closure graphs, 128 adapter/applicability/reason combinations
and 192 cleanup combinations over four qualities and actual named/observed sets. Helpers are
identified accepted-main specializations checked against boundary tables and a separate parent
reachability characterization, not independent whole-compiler oracles. Historical models and
both independent reviewer probes are replayed from temporary copies. The preparation contribution
and prior construction arguments are unchanged.

All recorded model assertions passed within their stated models. Counts, exact domain, commands,
hashes and limitations are in the repair1 and repair2 archive READMEs. They do not establish compiler
constructor correspondence, full policy correlations, availability, performance, diagnostics or
Silk acceptance. No native invocation, full source fixture execution, compiler build,
CI, corpus run or gap update occurred. The model intentionally does not mirror all production
branches or substitute its outcomes for exact Silk assertions.

After design approval, C's acceptance must include complete actual read sources for caller-only
replacement, loan-free overwrite, conditional/unconditional kill, forward/backedge aliases,
branch merges, earlyStore vs beforeLoopStore, and zero iteration; exact field/opaque boundaries;
repeated real copies vs historical duplicates; source/static/caller negatives; owner write/move/
drop; unchanged must-initialization and exact report order. Full original V10/V17 and inference
cannot advance until earlyStore is a hard refusal and temporal positives are Checked. Existing
A controls remain required, including complete-source release, ancestors, declared conflicts,
static demands, anonymous lifecycle, capture retention and holder release. Design approval alone
would not close #1944/#1952 or accept new gaps.

## 9. Reported section integration constraint

The #1957 owner supplied read-only candidate evidence on main6c: `storedNamedValid`
with `p:&'s mut Obj, out:&mut Slot<'s>`, `stage=put3(&mut out.*,&p.n); stage(1)`
followed by `return out.r.*`. Selected contract metadata removes StoredLoans but leaves
Regions. Their `t3-0b662c45/.scratch/sections-1957/trial.log` attributes goal14
Local37->Parameter0 at the second capture: loan0 rootout has parent Parameter1, loan1
rootp has parent Parameter0, both share Local37. Anonymous/Effect twins reportedly
have the analogous Local75/41 conflation. This is **owner-reported candidate evidence**,
not a fresh run or accepted metadata change in this branch. The owner separately reports
required namedSection/closureSection Checked and placeStored/placeStoredEffect OWN0011;
the three Regions bodies are extra controls, not failures of those required positives.
Constructor timing/unresolved-inference gates remain under their audit.

The package must retain actual capture/full-parameter correspondence and paired source
identity rather than using shared atom membership as source identity. This does not
authorize dropping the output's own region obligations, changing symbolic region/parent
proof, or asserting that provenance migration alone fixes these verdicts. Future C must
assess this exact boundary after #1957's independently accepted metadata integration;
a further proof-policy change requires explicit attribution/review, not a hidden fallback.

Further exact provenance supplied by the owner: the complete candidate source is
`t3-0b662c45/.scratch/sections-1957/candidate-probe.silk` at line822 onward. Goal14 is
SafetyObligation.RegionRelation, relative Location74..81 (`&p.n`), offered the
construction's fresh Local37, wanted Parameter0 ('s). Goal12 is P1->L37 at62..71
(`&mut out.*`), goal13 P0->L37 at74..81. Argument/reborrow typing creates these
before metadata; selected keptArguments does not create or change them. This is
why replacing all-source quantification merely to obtain P1->P0 is unauthorized.

The metadata candidate's eager keepCarried at construction is **not publishable**
per the parent's timing audit. Existing construct carries captures without an
authenticated physical capture-field/full-parameter map. The preparation contract
requires that map for future C; it does not claim today's route is supported.
Construction CaptureHold, invocation destination storage and delayed Effect Run
are distinct operation phases. Package routes must carry the actual selected
application, capture ordinal/full-parameter map, typed placement and execution
phase/Eval/read identity. Preparing a possible future invocation route is not
execution and cannot generate caller storage/escape. Existing constructor opaque/
universal capture rules remain the accepted policy. Same leaf or region cannot
stand in for selected capture argument identity. Holder's Type.fieldInputs/schema/
Carry.path/timing audit owns this dependency; no local escape shuffle or candidate
behavior is imported. A missing supported map must be resolved before migration,
not called Unknown or used to weaken an unrelated proof.
