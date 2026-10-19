# Concrete translation and terminal precedence (repair1)

These rules specify proposed C obligations; they do not change production or claim
Silk acceptance. Preserve every A guard in the gate table, now with accepted #1983
operation/read applicability and independent escape reasons.

## Runtime flow, policy stop and conditional writes

Three predicates are distinct: RuntimeReach(point), PolicyCovered(site), and the
checker's terminal refusal frontier. A typed return/never/break/continue and the
accepted While direct-Boolean feasibility rules determine runtime CFG edges.
`walker.outside` is not a runtime predicate. It records that the checker cannot
interpret a construct, not that execution stops there. Source reservation and
straightforward typed read/copy/write transfer after that site are never gated by
`not Outside`. Unknown semantics of the offending expression is an explicit
Unknown leaf/transfer coverage failure; known later writes still exist.

For the complete earlyStore shape (C does not yet authorize this store):

```
EntryCaller(q) -> Has(entry,caller)
AtStore(caller) <- Has(entry,caller), EntryToHeader, HeaderToRead
Has(after,L) <- RuntimeReach(localBorrow), ActualBorrow(L), ExactWrite(q)
AtStore(L) <- Has(after,L), WriteToBackedge, BackedgeToHeader, HeaderToRead
Outside(store) <- AtStore(L), OriginalUnsupportedStoreGate
```

Neither WriteToBackedge nor Has(after,L) depends on `not Outside(store)`. Thus the
negative cycle `Outside <- L; L <- not Outside` is not constructed. beforeLoopStore
has no backedge to its read, so it retains only entry. A return between the store
and borrow removes the runtime path genuinely; analysis refusal does not. This
preserves the invalid source for the later direct-store proof without prematurely
claiming C alone hard-refutes it. Original outside/nonreturn refutations still
have their original terminal roles.

Call-induced destination changes are **weak writes**. `storeIntoLent` and
`storeThroughExclusive` keep the original completing-call, not-outside-at-that-
policy-phase, callKept, exclusive destination, source/target/slot and reference-
holder guards. They reserve old+received rehold ports before solving. Equations:

```
AfterOld(dst,f) <- Before(dst,f), CallCompletes
AfterReceived(dst,f) <- Received(f), CallCompletes, SupportedStore(case)
CallWriteCoverageGap <- PossibleStore(case), not PolicyCovered(case)
```

When the modeled supported rehold is inactive, original values pass through. A
possible supported store adds received values; it never kills the old value by
absence of a selected output. A source-dependent unresolved gate adds a coverage
obligation; it does not prove the call cannot write. Original refusal gates still
refuse. No unconditional new caller-slot permission is added here. Effects and
policy gates after a definite checker stop are not published as original-policy
successes; runtime source enumeration continues to explain that stop.

Actual exact `PlaceAssignment`/replace strongly kills only its authenticated local
storage components. A computed index/referent/opaque target preserves original
may-alias/unsupported behavior; it cannot kill the whole remainder class. A copy
records the RHS read, not the holder's final value. A referent read follows the
reference target to the **current storage definition at that read**, not forever
to a value snapshot from when the descriptor was copied. Conditional call writes
and explicit assignment kills therefore cannot share one unqualified Gen/Kill flag.
Move/drop/end availability and shadow/inherited policy are separate consumers of
these same definitions; no changed availability proof is proposed.

## State translation, not final-state replay

For an operation with positions 0..m, reserve m+1 P versions and exactly one
snapshot at its documented barrier. A case at position i reads P_i, not P_final.
Its guarded S/A effects join P_i into P_(i+1). An inactive position passes P_i
through. Escape reasons, bound, storing, whole holds and unretained facts have
matching phase/effect IDs; their readers reference the version used in the source.
All alternative cases at i share P_i; repeated real positions have different i.
This yields explicit finite state edges, including parent closure queue order.

Naming is a finite automaton over `(naming in {MAX, operand labels}, several,
unnamed)` at each position, with the original branch precedence. Conditional
presence gives guarded skip/process transitions. May states are alternatives,
never an optimistic choice. Complete can be certified only if all possible
observation states satisfy its tests and the positive source witnesses are K-
true. `retainedParents` remains known&&!stores&&count>1, independently of declared
sampling and required-source closure. Multiplicity is over physical occurrence/
leaf entries, not history cases. The nonempty prior whole-hold guard remains.

For resultDecision encode ordered guards as `Chosen_j <- Guard_j, not Guard_0,
... not Guard_(j-1)` (include the original else grouping). Its direct immutable
inputs come from case + snapshot + P_i. Exact output decisions never erase loss.
Store adds S; alternatives result adds A; unknown result/cleanup adds both.
Drop removes that output only, not earlier effects or its input certificate.
Complete/declared/implied predicates use the exact snapshot/source identities,
not a current approximation cached across refinement. An undefined earlier guard
prevents treating a later branch as certain. This is one founded rule system.

Constructor translation reserves capture visits and their nested policy effects
before opaque then universal/CaptureHold passes. `ownedStorageLoan` at that second
pass observes its midwalk P, not final P. Later unrelated cleanup cannot poison
that earlier decision backward solely by the loan ID. A real value backedge into
a capture input can change its barrier and therefore its proof. Storable and
inherited status are separate ordered outcomes. Defer observes each argument's
retention before evaluating the next; invoke retains finish -> lent -> exclusive
store order. Cleanup's real definition/read match and scope/loop marker remain
part of each loss generator, including replace-before-write cleanup. No final
snapshot substituted for these observation sites is equivalent.

## Terminal admission and diagnostic order

Keep two projections of the one solved graph: full runtime source facts for
completeness, and policy effect applicability through the first original checker
stop. The latter is a visibility predicate on original visit/phase IDs, not a
second source analysis. `BeforeStop(e)` requires no earlier definite or possible
stopping gate along the structural checker visit schedule. This schedule includes
the original arm order and scoped guards; it is not source-span sorting. Undefined
stop means downstream policy claims cannot certify; full runtime facts remain.
Visible loan metadata includes actual creations before the stop and genuine source
leaves reaching those visible reads, including a later lexical borrow returning on
a runtime backedge. A later reserved loan with no such read/creation evidence
cannot independently win an earlier diagnostic merely by having a lower span.
The exact original stop site/reason is the terminal outside result. ReleaseScopes
has its own later stop phase, as current check does.

The terminal schedule is:

1. Original visible guard-consumption refusal.
2. Original nonreturn lifetime refutation over visible actual loan/retained
   obligation evidence. Compute returnedEscape separately for `refutedOr`.
3. Outside stop (including scope-release stop): returnedEscape substitutes as in
   `refutedOr`; later event conflicts do not leap over this stage.
4. Existing loop-header/event conflict scan in evaluation order and original
   reporting/stopping rules. The first conflict remains primary; only additional
   reports use the existing bySpan behavior.
5. Storing, imprecision, inherited-body status, in that order, each through
   `refutedOr`. Partial policy uncertainty is not materialized as a fabricated
   exact event; it prevents later Checked and retains its explicit coverage reason.
6. Region/crossing/local relation closure with all original obligations; returned
   escape fallback. Source requests never bypass these checks.

Environment request outcomes join the existing region-obligation boundary, with
an explicit terminal suborder: keep any ordinary exact conflict/refutation from
stages 1–4 as primary; after the event scan, independently grounded mandatory
source refutations may replace a non-conflict candidate (including a gap), in
structural request ordinal then source occurrence order. An outside candidate is
still selected before event scan; no downstream event is newly reported. An env
refutation can replace that candidate only using complete independently grounded
read/contract evidence, not effects hidden after the stop. Missing, duplicate,
foreign, recovery or unresolved request outcomes remain Pending. They never
replace an ordinary conflict or certify Checked. Multiple request refusals retain
the environment owner's requested report order/dedup and exact actual source spans;
no global sorting changes which diagnostic is primary. This placement is a
proposed integration contract requiring the existing localEscape OWN0019 and
multiple SEM0212 controls, not a measured verdict claim.

Admission additionally requires complete graph/package coverage, category and
presence invariants, consistent mandatory dependency slices and all original
region/ownership checks. Total well-founded truth alone is insufficient. Unresolved
reachable proof/effect facts remain loud; source-free/uninitialized cycles and
Recovery never certify. No stable interpretation may be used vacuously. Unrelated
undefined atoms outside the full mandatory dependency closure do not force failure.

## Accepted #1983 migration boundary

Main6c160865 is the accepted policy baseline; no unpublished code is imported.
Future C must replace creation-ordered paired Holding traversal in its caller
classifier with these actual read/case facts, not retain it as a second authority.
Missing/forward/cyclic links are not Absent. Actual caller source requires genuine
Entry/Expression contract provenance; Unknown remains Unknown. Retention-operation
reachability is an Eval/event/read predicate tied to the same paired case. Keep
independent capture/return/written-operand escape reasons and the preactivation
snapshot distinct from invocation-retention reasons. Reclassifying the latter
cannot clear the former. Exact/Stored applicability and `(shared==1 || indexed)`
conflict condition remain the accepted policy; only inputs migrate. Literal While
feasibility is accepted CFG input, not a new B rule. #1957 selected section metadata
is a separate owner dependency, never inferred from an open runtime recipe.
