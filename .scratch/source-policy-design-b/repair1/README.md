# B repair1 evidence for NEW design review2

Design-only continuation of exact `985eb0ea2d07fecd3cccc08939d07be901d20967`.
Accepted main `6c1608657dbdb11efce96ca973213e8cbd809f64` merged cleanly as
`ad4c47e55`; all production changes in that merge belong to already accepted main.
No new production/schema/API implementation, PR, native invocation, compiler build,
source test, corpus run, gap update or issue closure occurred.

The three authoritative documents are:

- `compiler/borrow-source-design.md`: actual-read contract, finite skeleton,
  original guard table, founded enclosure, lifecycle and acceptance boundaries.
- `compiler/borrow-source-policy-rules.md`: repair1 route cases/quantifiers/effect
  IDs, positive precision loss rules, actual observation versions, conditional
  writes, checker-stop separation and terminal precedence. The two local drafting
  files `normalization-precision.md` and `translation.md` are concatenated there.
- `compiler/borrow-source-preparation.md`: exact jointly agreed environment-author
  contribution SHA b769dd2625bf54c7972da511648c8a51c7ba6310249f423a9f3084a64d84e9b8.
  Tracked finite shape/contract preparation; stamped selectors/routes/cases;
  original application/final binding split; finite predicate product; nominal,
  recursive and nested-success examples; lifecycle and #1957 ownership constraints.

`review1-report.md`, `review1-probes.py`, `review1-probes.json` are exact copies of
independent review artifacts from t3-d00dcd00. No approval is implied: that review
REQUESTED CHANGES. Environment author's cross-check/agreement is collaboration,
not independent approval. Parent must arrange NEW independent review2 before C.

## Model contract and independent oracles

`model.py` is a standalone Python specification probe. It neither imports Silk
nor invokes a compiler. `results.json` and `model.log` retain exact output.

1. 784 cases = 16 CFGs × 49 action pairs. Base graph 0->1->2->3; optional
   0->3, 1->1, 2->1, 1->3 edges. At points1/2 choose identity, saved=q,
   q=saved, q.Stored-loss, q.Alternatives-loss, q=caller, or weak caller write.
   Each cell is absent or (L/C, mask0..3), initial q=L/Exact and saved absent.
   The oracle explores all finite `(pc, store)` states, including loops to a
   fixed point; it does not use a loop-count cutoff. The separate equation
   builder has presence and individual loss-bit facts and no concrete stores.
   Compare source sets and bitwise loss joins over actual states at each point.
   These are distributive transfers; the model does NOT prove the non-distributive
   full compiler result/retention policy or correlations between separate cells.
2. Focused loops show Exact without a seed, real Stored backedge transport, a
   saved pre-loop **source Q** unchanged, and an in-loop copy receiving the loss.
   This does not assert that a later use of saved ignores later global P effects.
   Weak writes preserve old+received; strong writes kill; LoanFree is a real
   replacement, Unknown is a distinct retained source, not absence or safe entry.
3. 24 operation transition cases compare positive loss generators with the
   four-element join lattice. Category rules require actual presence; absent,
   undefined-loss and total-but-categoryless states cannot pass admission.
   Four complete/drop witness cases require a present Exact witness. A separate
   Boolean enumeration of the two-operation output equations yields both grounded
   solutions; the alternating enclosure does not select either or frozen cross.
4. Eight route subsets cover direct aggregate, indirect declared and opaque
   routes. A case-execution oracle sees one original paired route at a time;
   normalization retains the union, not mixed attributes. Duplicated histories
   do not add positions. Target/placement collision and read-pair probes remain.
   Real positions1..5 compare explicit sequential execution with version rules.
5. Sixteen small recursive route graphs compare set reachability with simple-path
   enumeration and separately supplied accepting predicates. A cycle cannot
   prove Contents/outlives. Nominal field kill/saved copy uses dictionary state
   versus indexed cells. Original success sibling binders retain separate input
   correspondence despite equal instantiated atoms. These hand-prepared maps
   do not prove Semantic query construction or dependency invalidation.
6. Checker outside vs runtime backedge and diagnostic stage-vs-span examples are
   small counterexample contracts, not a full checkPrepared/diagnostic oracle.
   They deliberately distinguish the incorrect stop-gated negative cycle.

The original baseline model source, results and log are untouched; its exact hashes
are checked by `sha256sum -c ../model.sha256` from repository root using the full
path shown in commands.txt. Old counts (1269/8000/364/1024/127) remain historical
baseline evidence, not new native acceptance. Review1 probes remain separate from
author repair probes. The repair does not claim execution of any displayed Silk
source, resolution of V10/V17/earlyStore, accepted new gaps, or practical costs.

## Remaining review/implementation obligations

The explicit rules are a proposal to assess against actual constructors. Unknown
or undefined dependencies cannot silently certify; missing supported maps are
construction blockers. Original region/availability/ownership policy, caller/static
obligations, must-initialization, exact errors and diagnostic order remain required.
Native acceptance must still cover full policy effects, all lifecycle/stamp/rebase
cases, original #1952 fixtures and earlyStore/beforeLoopStore before inference.
#1957 field layout is not settled and must be coordinated with its owner; B only
requires authenticated selected section metadata, never an open runtime recipe.
No unresolved mandatory positive may be relabeled to tolerate a new gap.
