# Borrow operation policy boundary

This note accompanies a behavior-preserving extraction in `BorrowCheck.silk`. It does not
implement complete value provenance, a new source solver, or the proposed source-query API.
The cyclic design below requires independent review before implementation.

## A: implemented boundary and observation order

`retainedSinks` accepts immutable loans, structural paths, carries, operand sinks, owner and the
optional operand selector. Its result contains one `CallSink` and actual-slot witness per carry,
in the original order. `keepCarried` records located Exact/Stored universal retention as a
`CallerRetention` at the operation point for later operand-read source validation. Other Universal
reasons set `Loan.escapes = true`; Unknown sets `Walker.storing = true`; Local has no effect.
Neither classification nor parent closure reads either of these output flags. No decision is
recomputed after application. The initial queue is seeded in carry order. Each dequeued child
scans candidate parents in carry order, marking/enqueuing once; same-operand restrictions,
`meetMember`, and the distinction between traversing a parent and promoting an owned parent
are unchanged. A nonlocal parent may be traversed without being promoted.

`keptSink` receives the actual loan. Its complete loan read set is origin, regions, referent,
and exclusive (the last two through `narrowSlots`). Parent closure additionally reads parent,
borrowed and local. It does not read precision, escapes, bound, unretained or wholeHolds.
Sink inputs include holds, whole/outer classification and approximation, span/view identity,
undescribed, and the slot paths/types/access/classifications. Carry field/direct and immutable
Walker paths supply structural correspondence. Parent promotion changes only the sink, never the
actual-slot witness. Owner identity classifies region atoms. Removing the Walker argument removes
no dependency; paths are passed explicitly. The adapter alone reads precision and records effects.

`resultDecision` accepts an immutable loan, the actual carry, immutable `ResultFacts`, owner,
named and required regions, retention relations and implied signature facts, plus mapped field
and whether typed operands exist. It returns kept, next precision, set-bound, append-unretained,
declared placement, whole-result recording and its described flag. It allocates only through the
existing conditional `mayOutlive` query. It changes no input or global state. Its loan read set
is precision, local, regions, borrowed and parent (including `unneededOwnedLoan`); carry reads
are operand and field. Other carry identity/placement is preserved by the effect application.

The sampling and application sequence remains:

1. Allocate the result point; record sealed/unheld metadata.
2. Classify/apply `keepCarried` at its original point, before result consumption.
3. Consume carries into intervals, in order. Nonretaining results do no result classification.
4. Compute named/known/outside, retained-parent closure, declared-result sources and required
   sources from the then-current loans. Compute naming/several/unnamed, complete and implied
   facts. These are operation-wide snapshots, deliberately not recomputed during the carry loop.
5. For each carry, map/intern its result path first. Then read the **current** loan for its pure
   decision. Retained-operand metadata is immutable; its boolean is now loaded into the facts
   even when `stores` short-circuits its use (no allocation or observable state access).
6. Apply set-bound and next precision immediately. Append declared result carries or the ordinary
   carry, then the whole-result record, then the unretained record. Only then advance to the next
   carry. A repeated loan observes earlier carries' precision effects. An unchanged precision
   value is assigned back; no prior precision is restored from an operation-wide snapshot.

The bound-setting branch cannot execute `mayOutlive`; consequently delaying that assignment
until the pure decision returns crosses no allocation or other observable decision. Precision
changes previously occurred after the last fallible decision and still do. Appending result
carries/whole holds/unretained remains fallible in the same order. `declaredResultCarries` still
executes at the original site after precision application. All original branch precedence is
preserved, including a declared-result placement when an earlier outside-result branch kept a
loan. The integrated caller-slot repair keeps authenticated declared-source exactness after the
owned/outlives-result gates and immediately before coarse outside-drop. No source authentication
is added here. No batching, deduplication or sorting of effects is introduced.

Other retention policies are **unchanged**, not moved into the new helper: capture construction,
written-operand escape, return escape, stores, cleanup, field filtering and solver consumption.
`keepCarried` invocation sites in `finish` and `defer` are unchanged. `construct`, `consume`,
`rejoin` and `storeIntoLent` still execute their existing work at their existing positions. This
is a pure boundary for result selection and call retention, not a claim that the entire Walker
has become a pure operation graph.

## Global state inventory

All entries refer to the pre-extraction supporting base `93bbb8c1a` so the audit survives moved
lines. Test-only writes are listed separately. No global copy/rebase constructor exists: Walker
is invocation-local, Loan objects are appended at `takeLoan`, and Carry/Holding copy only loan
indices. Vector movement/reallocation preserves these fields; it does not reinitialize them.

| State | Initialization/writes | Reads and observation points |
| --- | --- | --- |
| Loan.precision | `takeLoan` 2028 Exact; `finish` 2685–2688 Exact→Alternatives, Stored→Unknown or unconditional Unknown; `observeCleanup` 4364 Unknown; `visitNode` field assignment 4662–4664 Exact→Stored, Alternatives→Unknown | `unreachableField` 1597 at the actual field read; `completeLocalResultSources` 2273/2287 and `declaredResultLoans` 2348/2384 before per-carry result effects; `unneededOwnedLoan` 2305 and `finish` 2670/2685/2686 at each carry; completed-body `check` 6231/6259/6293; `symbolicParentsProved` 6638, `loanParentBoundProved` 6783, `finiteParentRoots` 6831, `initializedOwnedRegion` 7265, `regionPoints` 7470, `ownedStorageLoan` 7593, `localRelationsProved` 7773 |
| Loan.escapes | `takeLoan` 2035 false; `keepWrittenOperands` 2149; `construct` 3608/3635 (opaque phase first, then universal stored-region phase); `visitNode` return 4598; `keepCarried` 8101, each sets true only | `check` 6220/6271; `localAvailable` 7019; `releasedLoanPoints` 7341. Result and call-retention decisions do not read it. |
| Loan.bound | `takeLoan` 2040 false; `finish` 2653 sets true only on the outside/local/outlives-result branch | `check` 6215 defers to return-slot refutation only when a returned escape exists |
| Walker.unretained | `check` 6005 empty; `finish` 2702 appends the carry's loan on the outside-result drop branch only | `check` 6112 traverses the ordered list to create `UnretainedChain`s; not an input to result selection |
| Walker.wholeHolds | `check` 6003 empty; `finish` 2698 appends after carrying a nondeclared whole result, unless forwarding is Matched | `unreachableField` 1606 scans all earlier holds for that loan, requires every hold described and implied facts known, then asks `mayOutlive`; absence is not a release proof |

`ownedStorageLoan` is also called during construction and storage processing, before completed-body
checking. Its precision read therefore must not be treated as a final-state-only consumer.
`provable` implements the shared Exact/Stored/Alternatives classification, with Unknown excluded.

Test constructors initialize these fields in wrappedRegionClaims, symbolicTestLoan,
symbolicRootClaims, finiteParentClaims, intervalRequirementClaims, ownedInitializationClaims,
offeredMeetClaims and regionChoiceClaims (some test constructors share setup functions).
Explicit test precision mutations occur at base lines 8614/8619/8624, 8907/8909/8920/8923,
9044/9050, 9217/9223/9246/9250 and 9434/9438. They remain unchanged. They are not production
policy or evidence for complete sources. The exact source occurrence inventory, including
constructors, is retained with the implementation handoff.

The result/call extraction preserves the old observation points rather than making these fields
order independent. In particular `wholeHolds` records created by an earlier operation can change
a later field decision; later precision degradation can affect a later operation-wide complete
or declared-source certificate. B must model these dependencies explicitly.

The integrated caller-slot repair additionally initializes/appends `Walker.callerRetentions` and
validates each paired definition/read source after reaching holdings are computed. Before that
finalization, `independentEscapes` snapshots the existing written/capture/opaque/result reasons.
Access and End conflicts use those independent reasons or operation-to-event-qualified caller
retention; availability and release still see the conservative aggregate escape bits. These
observation points are unchanged by the extraction. The inventory above remains the explicitly
pinned pre-extraction record, not a claim that it lists these later additions.

## B: concrete information-order design, not implemented

### Finite identities and state versions

A source alternative needs a leaf, occurrence/read, definition and component selection; loan ID
alone is insufficient. Absence, LoanFree and Unknown are distinct. The graph must be built from
a complete typed body with actual CFG kill/backedge edges. A missing evaluation is explicit
Unknown, not an empty source set. Pure transfers can be closed with the existing fixed point.

Global policy state needs observation-point versions: precision before each operation-wide
certificate and before/after each carry; escape/bound and ordered whole-hold/unretained events at
their original sites. A single final precision value cannot feed all earlier certificates. This
is state-versioning inside the same equation graph, not a second reaching-definition engine.

For a fixed finite candidate graph, use possible-value sets: boolean {false}, {true}, or both;
precision a nonempty subset of the four existing values. Narrowing sets is gaining information.
Source membership is boolean per candidate, not a loan list with missing loan-free cases.
True source membership also requires a grounded transfer derivation from an actual leaf.
A source-free cycle never earns a true leaf simply because it is a fixed point.

Component paths must be a finite set of typed, authored selections and their prefixes/suffixes,
including declared result paths and aggregate placements. Model transformations as edges between
these typed path states. A borrow/dereference changes referent state, not by appending unlimited
steps around a cycle. Unknown index/opaque selection is an explicit distinct unknown state.
This needs a closure check: if an operation requires a new recursively growing path outside the
finite typed selection states, the proposed finite domain does **not** establish its precision.
No length cutoff, broad unknown fallback or equivalence of such paths is approved here. This is
an implementation obligation before C, not an assertion that all current paths already fit.

### Polynomial guard circuits for a fixed candidate graph

Use finite truth-table transfer for NOT/AND/OR and equality on possible values. AND is definitely
true only if both inputs are true; false if either is false. OR is dual. Unknown is never a
positive certificate. Negation swaps true/false without reversing information order. A circuit
with repeated variables can lose correlation; it is a conservative enclosure, **not** the exact
exponential powerset lift. With singleton inputs every gate is exact.

The following are explicit circuits for actual result guards. Let p_i be carry membership, e_i
be its observation-point precision==Exact, h_i its retained-or-required predicate, and m_i its
nonempty regions sharing a named atom or required predicate. Immutable atom/type comparisons
are constants; their precision/source-dependent predicates are circuit inputs, not assumed true.

- For ordinary operand IDs, N_o = OR over i in operand o of p_i AND h_i AND
  (emptyRegions_i OR m_i). Distinct-name detection can be expressed as OR of N_o AND N_k.
  However **the actual code uses usize.MAX both as no-name and as a carry operand**, so that
  formula is not a general replacement. Preserve the ordered scan explicitly: start
  naming=MAX, several=false; for each qualifying carry, if naming==MAX set naming=operand_i,
  otherwise if naming!=operand_i set several=true. Nonqualifying carries preserve both.
  Transfer this finite-state machine over possible naming values {MAX and actual operand IDs}
  and boolean several, retaining their pair correlation. Its domain has at most 2*(operands+1)
  states and transition cost is polynomial. Test the actual resulting naming==operand_i and
  naming!=MAX guards. With singleton ordered inputs this reproduces even sentinel behavior.
- `unnamed` = OR_i(p_i AND h_i AND NOT(emptyRegions_i OR m_i) AND bodyRegions_i).
- More than one carry = OR over i!=j of p_i AND p_j. The domain must distinguish carries
  with different operand/path/definition/read identity even if they share a loan.
- All exact = AND_i(NOT p_i OR e_i). A merely possible nonexact source prevents proving it.
  For each named local atom a, witness W_a = OR_i(p_i AND e_i AND
  borrowedEquals_i,a AND regionsContainBorrowed_i). `completeLocalResultSources` additionally
  requires known domain for every named atom and at least one local atom. Its witness test uses
  exact atom equality, as the code does, not loose overlap. Then `complete` is the existing
  known/not-stores/not-outside/not-several/has-name/multiple/all-exact/all-W conjunction.
- The required-source gate is `missing = OR_i(p_i AND localBorrowed_i AND NOT
  sharesNamed_i)`. If no retained requirement edges exist it is false. When missing is true,
  seed the named local ordinals and follow RetentionEdge extent-to-source edges; otherwise the
  required set is empty. Membership of a required ordinal is missing AND its reachability bit.
  `requiredLoan` additionally authenticates the actual borrowed ordinal and its exact occurrence
  in that loan's recorded regions. This gate is not an unconditional required-region closure.
- Actual-parent reachability uses least monotone closure over authenticated
  edges, separately for definitely-present and possibly-present candidates. Edges requiring two
  sources conjoin both membership bits. Retained parents and declared-result parents retain their
  distinct predicates and operand restrictions; precision-dependent declared seeds include e_i.
  They must not be inferred from shared region membership alone.
- `unneededOwnedLoan` is local AND e_i AND NOT ancestor_i AND NOT required_i AND
  noParent_i AND singleOwnLocalRegion_i AND NOT proofContainsNamedOwn_i.
- Implied exclusion keeps its existing known/exact/not-ancestor/not-required/bodyRegions/
  not-mayOutlive conjunction. `mayOutlive` is ordinary atom reachability over the immutable
  implied graph at that observation point; lack of known implied facts never means exclusion.

For ordered branches g_1...g_n, active_1=g_1 and
active_j=g_j AND AND_{k<j}(NOT g_k); the default branch is the all-false prefix. Include the
outer stores/not-retained/known branches in this circuit, not just the inner chain. A result
property is the union of values of every possibly active branch, narrowed to singleton only
when all remaining branches agree. A source can be definitely discarded only when membership
implies kept=false for **all** remaining branches. Unknown kept retains a possible alternative;
it cannot justify either an Exact source or an unrelated-owner release.

For example the complete/unneeded drop does not override declared retention: its active mask
also requires outside-forward, outside-bound, declared and outside-drop branches false. The
implied drop additionally requires all preceding exact/complete branches false. The bound effect
is present only on its own active outside-bound branch. The unretained effect is present only on
the outside-drop branch. `declared` result placement is separately computed from metadata after
kept, just as A does; it is not synonymous with having taken the declared exact branch.

Precision output per carry is the original truth table: if absent or not kept or exact, preserve
input; otherwise, if alternatives, Exact→Alternatives, Stored→Unknown, Alternatives/Unknown
unchanged; otherwise Unknown. Apply this to each possible input/branch value (four values,
constant work per branch), then feed that version into the next carry. Do not join simultaneous
updates to a loan before computing their inputs.

Call retention starts from `keptSink`'s fixed ordered slot/own/approximation decisions. Its parent
queue becomes reachability from Universal seeds with actual same-operand parent edges. Traversed
nonlocal parents do not acquire Universal automatically; local parents do. With unresolved source
membership the lower/upper reachability queries use definite/possible edges respectively. For a
present carry, Universal records escape, Unknown records storing, Local neither. `joinSinks`
orders Unknown above Universal above Local; that policy order is separate from the information
order of possible sink classifications. No new Actual/Absent/Unknown classifier from unpublished
PR1983 is assumed; its reviewed integration will require a fresh migration audit.

### Convergence, effects, equivalence and the remaining blocker

On a **fixed** finite graph, truth tables, masked branch union and reachability give polynomial
conservative transfers. Narrowing inputs removes possible gate/branch values, never adds them.
A worklist that intersects inferred possible sets with the prior sets terminates after at most
one removal per finite value bit; an empty set is inconsistent evidence, never a proof. Grounded
source membership must be obtained from seeded reachability, with ungrounded cycles distinguished.
It must not be initialized optimistically to true to start this process.

Escapes/bound/storing are conditional OR effects. Precision uses the version chain above.
WholeHold and unretained are conditional event records keyed by original occurrence/carry order,
not a mutable list appended on every solver visit. Later field filtering must use earlier event
versions only and require all possible relevant whole holds described/known. Final diagnostics
consume committed effects in original evaluation order, so graph worklist order cannot change
report order. Unresolved policy effects cannot certify Checked or a definite source conflict.
These rules explain finite convergence of the proposed enclosure; they do not prove that it is
precise enough to replace the current policy on every cyclic program.

Acyclic equivalence has a concrete induction: feed the same ordered input carries, types and
entry state into each node in original order. All inputs are singleton; every guard and active
branch is exact, each returned effect matches A, and each next state version matches its old
observation point. Therefore every next node has identical inputs, outputs and diagnostics.
This proof assumes the new transfer representation reproduces the existing carry ordering,
placements and deduplication on acyclic programs; it does not license choosing a different order.

**Remaining blocker for C:** the actual ordered candidate/field domain and state versions must
be constructed without using policy-selected outputs to decide which input candidates exist.
A later read currently gets an ordered, deduplicated Carry list from eager operations; complete
provenance must add later backedge sources, yet `completeLocalResultSources` and declared-source
seeds read loan-global precision at earlier operation snapshots. No implemented representation
currently provides both this finite ordered domain and those observation versions. A generic
unordered set-of-leaves solver does not solve this. In particular, replacing `all Exact` with
"all possible loans initially Exact", or certifying W_a from an upper-bound candidate, is the
exact unsound guard. The circuits above leave it unresolved until its witness and precision are
grounded; no approved cyclic precision policy exists for the residual case. This limitation is
why this change publishes A and B's reviewable design, not a partial graph or C implementation.

### Two operation feedback and a grounded positive

Negative design counterexample (not a claimed compiled Silk fixture): A names local atom W and
B names O. Both have otherwise exact, compatible owned sources in one operand. A has a directly
grounded O plus B's output; B has a directly grounded W plus A's output. On maximal {O,W} inputs,
A uses W to certify complete and drops O; B uses O and drops W. Their selected outputs then leave
A only O and B only W, removing both certificates. Frozen maximal evaluation is invalid.
Under the circuits, A's W witness and B's O witness are initially only possible. Neither drop
is definitely active. Refinement may leave alternatives unresolved; this example provides no
permission to declare the cycle Checked or to invent a witness. It also shows why source-set
monotonicity is not the right order for complete/drop.

Grounded positive: an actual borrowed source O enters q, a loop copies q through an identity
result that names O and assigns it back. There are no precision-degrading operations; q's
zero-iteration edge retains O. On the fixed candidate domain {O}, the leaf grounds its membership
and Exact precision. The single operand names O, multiple=false, complete=false, and the ordinary
unique-name branch keeps O without changing precision on every pass. Copy/reaching closure is
{O}; the cycle needs neither a complete/drop witness nor Unknown. Real owner ends and conflicting
writes remain separate mandatory checks. A stores=true operation likewise preserves already
proved precision; it cannot turn Unknown into Exact. These are falsifiable acceptance shapes for
C, not new tests or evidence claimed by A.
