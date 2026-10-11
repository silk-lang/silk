# Per-declaration invalidation

**Status:** proposal. Nothing here is implemented, and implementation waits for Julia's approval.
Measured on `selfhost` `e1022f2`; line numbers refer to `31fc6e3`.

## Summary

Every semantic answer in the native compiler stays valid only while the exact bytes of every
module it transitively touched stay the same. The query keys are already per declaration, but
validity is per module. An edit anywhere in a module therefore restarts every answer that touched
that module. Two answer kinds survive the restart:

- A checked body can keep its payload, but only if its own source positions did not move.
- LLVM text is content-addressed and survives.

MIR has no such escape and is lowered again every time. In the probe below, editing one leaf body
re-lowers 4 of 5 functions, and adding a comment line re-checks every body in that file.

This note proposes four changes:

1. Key declaration facts by stable declaration identity instead of syntax position.
2. Observe per-declaration projections (header digest, body digest, name buckets) instead of whole
   module bytes.
3. Validate each answer through its direct dependencies and stop at equal results, so the early
   cutoff that only Body has today applies to every family.
4. Make positions and syntax references declaration-local, with current-revision location maps.

With all four, an ordinary runtime body edit invalidates that body's affected instances and the
facts that evaluated it statically. Runtime callers can keep their answers when the callee's
signature stays equal. A signature edit propagates through facts that read that signature.

## 1. What keys on the module today, and why

**Keys.** `Key` (`semantic/Semantic.silk:948`) is
`{family, module, name, declaration, member, external}`. They fall into four groups:

- **Declaration families** (`declarationFamily`, :845), from Import through Body and the
  origin families. These key on `(module ordinal, declaration ordinal)`. The declaration
  ordinal is the declaration's position in the module's `ModuleIndex`, so it is a syntax position:
  inserting a declaration renumbers every later one.
- **Applied families** (MemberShape, ConformanceHeads, ProofBounds, AppliedOperation,
  AppliedInherent). These add interned applied types in `name` and `member`.
- **Per-module families:** Name (per symbol), OperatorInterfaces, Implementations and
  ProfileInput.
- **Instance families:** Mir, EmissionInputs, Layout and LlvmText key only on an interned
  instance, layout type or content index (`sameKey`, :3491). Their module and declaration fields
  are informational.

**Validity.** This is where the module granularity comes from.

- `source` (:4027) records an `Observation` (`semantic/SourceRevision.silk:41`) holding the
  module's complete bytes, or the fact that it is absent.
- `declarationAt` (:4060) and `header` read through `source`, so reading one header observes the
  whole file.
- `demandChild` (:5272) also observes the declaring module of every declaration-family child. The
  reason given in the code: "a declaration ordinal names a declaration only in one source
  revision".
- `mergeEvidence` (:3985) copies the child's observations into the parent, so observations are
  transitive.
- On every later demand, `validAnswer` (:1573) compares each observation byte for byte. A single
  mismatch forgets the answer.

The design is sound and simple: positional ordinals and absolute spans are only meaningful
against the exact bytes they came from, so the whole file is what gets observed.

**Existing cutoffs.**

- **Body.**
  - A forgotten Body answer becomes a candidate (`priorCandidate`, :3290).
  - `reuseBody` (:44276) keeps the typed payload when two checks pass.
  - First, the declaration's `BodyInput` (`semantic/BodyInput.silk:24`) is equal. That compares
    the header and body fingerprints, exact declaration text, syntax index and span, stable
    declaration identity, and recursively the enclosing input for a literal (`equals`, :85).
  - Second, every recorded direct dependency returns the same `answerId` or an equal identity
    value (`identityOfFact`, :3088).
- **LlvmText** (`resolveLlvmText`, :52030) is named by a SHA-256 of its content, so an unchanged
  instance keeps its text.
- **Everything else has no cutoff.**
  - `identityOfFact` returns nothing for Mir, Layout and EmissionInputs, so `resolveMir`
    (:50341) re-lowers after any observed byte change, even when its Body was reused.
  - Every restarted answer also re-reads and re-observes the module, which costs time even when
    the payload is kept.

## 2. What an edit invalidates today

The probe uses two modules. `lib` has `leaf` and `other`. `main` has `a`, which calls
`Lib.leaf()`, `b`, which is independent, and `c`, which calls `Lib.other()`. Every edit
demands the Body and the MIR of all five functions, then counts query events. "Restarted" counts
Body starts, and the figure in parentheses counts how many of those reused their payload.

These are the original author's reported measurements, not independently reproduced results.
The PR does not include the probe source or invocation. Preserve the baseline revision above;
before using these counts as an implementation acceptance check, commit a reproducible probe
with its fixtures, demand order, event filters, and command. Count provider starts, Body payload
reuse, and MIR lowering separately; a validated hit is not a provider restart.

| Edit                                      | Bodies restarted (payload reused) | MIR lowered | Ideal              |
| ----------------------------------------- | --------------------------------- | ----------- | ------------------ |
| same-width edit to `leaf`'s body          | 4 (3)                             | 4           | 1 body, 1 MIR      |
| same-width edit to `b`'s body             | 3 (2)                             | 3           | 1, 1               |
| edit to `leaf`'s body that shifts `other` | 4 (2)                             | 4           | 1, 1               |
| `leaf` result type `i32` to `i64`         | 4 (2)                             | 4           | 2 (`leaf`, `a`), 2 |
| comment line at the top of `main`         | 3 (0)                             | 3           | 0, 0               |

- **Signatures.** The edited module's Signature queries also restart: 2 or 3 per edit. Ideally
  that happens only for the edited declaration's own Signature.
- **Shifted positions.** `other` loses reuse once `leaf` grows by one byte, and every body in
  `main` loses it after the comment. That is the span comparison in `BodyInput.equals`.
- **Lowering.** MIR is re-lowered for every restarted body, including the reused ones, because
  MIR has no identity.

## 3. Proposed design

### 3.1 Stable declaration keys

Declaration families key on an interned `DeclarationId` instead of a `ModuleIndex` position.
`semantic/DeclarationId.silk` already represents the canonical module and owner chain, including
each owner's kind, name, and same-key occurrence. Reuse that representation rather than adding
another identity type. The position becomes a per-revision lookup from identity to syntax
(`declarationAt`). Semantic readers observe existence and unambiguous selection, not the current
ordinal or absolute span; otherwise a reorder would still invalidate them.

Occurrence is an address within a revision, not proof that two revisions contain the same
declaration. Same-key siblings, unnamed owners, and ambiguous ancestors need conservative
invalidation unless matching can be proved. Inserting or reordering uniquely identified named
declarations preserves keys; inserting another same-key sibling must never transfer an old answer
to a different declaration. Deletion and rename change existence or name-bucket observations.

### 3.2 Projection observations instead of module bytes

Replace `Observation {id, content}` with typed leaf reads, each holding a digest:

| Read                  | Digest                                         | Who records it                                          |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| module presence       | present or absent                              | imports and source lookup, including failed lookup      |
| declaration selection | absent, unique, or ambiguous identity          | declaration lookup                                      |
| module shape          | imports, declaration identities and kinds      | Name, Implementations, OperatorInterfaces, ProfileInput |
| declaration header    | `Fingerprint.headerDigest`                     | Signature, Contract, Members, Identity, ...             |
| declaration body      | `Fingerprint.bodyDigest`                       | Body, Constant, Initializer, static evaluation          |
| name bucket           | the candidate `DeclarationId` set for one name | Name                                                    |

- `hir/Fingerprint.silk` already produces canonical header and body encodings independent of
  absolute positions and intern indices; `BodyInput` stores these bytes. Its header encoding
  includes documentation and owner occurrence. Body binder ordinals depend on the header's
  structure, so some header edits also change the body digest. These are conservative inputs,
  not a guarantee that every comment or reorder leaves every digest equal.
- Define module shape and name buckets in a canonical order when written order is irrelevant.
  Preserve order for observations whose consumers depend on it, such as member layout. Import
  aliases, visibility, conditional activation, and implementation-header reads must be covered;
  a set of declaration names alone cannot validate resolution or coherence.
- `source` stops observing anything. Each provider records exactly the projection it read.
- `demandChild` no longer observes the child's module, because the key is now a stable identity.

### 3.3 Direct-dependency validation with early cutoff

Each answer stores its own leaf reads and its direct dependencies, each dependency as a key plus
the dependency's result fingerprint. It no longer stores transitive observations, so
`mergeEvidence` goes away. Validating an answer works like this:

1. Check its leaf reads against the current revision.
2. Validate each direct dependency recursively, in recorded order.
3. Compare each dependency's current fingerprint with the recorded one.
4. Stop validation at the first mismatch and re-run the provider, recording fresh reads. Do not
   demand the remaining old dependencies: the changed branch may no longer need them. If the
   re-run yields an equal fingerprint, its own dependents stay valid. That is the cutoff.

Validation stays within one held immutable revision and memoizes completed validation for that
revision. An answer currently being validated is not a hit: use the query reservation and cycle
rules rather than recursively accepting an unfinished answer. Publish new evidence even when
the result is equal, since the set of dependencies may have changed.

This is `reuseBody`'s rule (`answerId` or equal identity) applied to every family, and it
replaces the Body-only candidate path. Every `Value` needs a fingerprint:

- `identityOfFact` supplies structural equality for many front-end facts, not a universal digest.
  It excludes OriginPlan, OriginEvidence, unsupported outcomes, and rejected diagnostics as well
  as the backend families. Audit all outcomes, including absence and rejection, before removing
  whole-module observations.
- Mir, Layout and EmissionInputs need canonical result identities covering everything their
  consumers read, including target, profile, ABI and provider inputs where applicable. LlvmText
  already has a content subject. Store stable references rather than revision-local table indices
  in cross-revision identities.

The bootstrap's `jul-217-semantic-revision-validation` change used the same model: typed query
and leaf reads with expected fingerprints, admitted by one ordered validator that stops at equal
results. That change targets the TypeScript stack, but its rules carry over.

### 3.4 Declaration-relative positions

Checked bodies, MIR origins and gap spans store offsets relative to their declaration's start,
plus that declaration's identity. A per-revision declaration base converts them to absolute spans
only when a diagnostic, gap or debug location is reported. This handles edits before a declaration;
it does not handle whitespace inserted inside it, which changes its internal offsets. For trivia
edits within a declaration, use stable syntax anchors and a current-revision position map, or
invalidate the position-bearing payload conservatively.

`TypedBody` also retains revision-local `HirId`s in origins, literals, and selected static facts.
Replace them with declaration-local syntax identities and resolve them against the current
revision before reading authored syntax. Keeping an old `HirId` with a new source observation is
unsound even if its declaration's digest is equal. Only after these consumers are updated can
`BodyInput.equals` drop its exact-text, span, and syntax-index checks. Semantic equality and
location refresh must be distinct so diagnostics stay current without forcing callers to recheck.

### 3.5 What each edit invalidates under this design

- **Body edit:** the body digest of that declaration changes.
  - Its Body re-runs. Changed results propagate to Mir, EmissionInputs and LlvmText; an equal
    result stops propagation at that family.
  - Ordinary runtime callers that read only the callee's Signature are untouched. This matches the
    `mir-core-shape.md` rule that body edits do not change callers' content subjects.
  - Static evaluation that executed the edited body recorded a body read, so it re-runs.
- **Signature edit:** the header digest changes.
  - Its Signature re-runs, and if the result fingerprint differs, every answer that recorded that
    Signature as a dependency re-runs: the callers' Bodies, then their MIR.
  - Bodies that do not call it keep their answers without re-running.
- **Comment before a declaration:** semantic results can remain equal, while its location map
  refreshes. Documentation comments may change header inputs.
- **Whitespace inside a declaration:** semantic reuse requires the syntax-anchor mapping above;
  declaration-relative byte offsets alone are insufficient.
- **Reorder:** uniquely identified declarations can retain answers when the observations they
  read are order-independent. Ambiguous owners and order-sensitive member shapes invalidate.

### 3.6 Compiling only what is used

Builds are already demand-driven: `buildApplication` lowers the instances reachable from the
entry, and only those. Two changes keep it that way:

- The per-module families (Implementations, OperatorInterfaces) stay per module, but they read
  the relevant module shape, import and activation facts, and implementation or interface
  headers. An unrelated runtime body edit therefore need not disturb them. Scans still inspect
  unused declaration headers where resolution or coherence requires them; this does not require
  checking every unused runtime body.
- Instance families keep keying on the instance. An approved region-erasure design could change
  that key to code identity (see §4).

## 4. Cost, risks and the region-sensitivity work

**Suggested work breakdown.** Establish a reproducible probe first. These are design components,
not permission to land a second validation path. The green-field policy requires the generalized
validator and removal of the Body-only candidate path to land together.

1. **Fingerprints and cutoff for Mir, Layout and EmissionInputs.** Mir keeps its answer when its
   Body and Signature dependencies are unchanged.
   - Before: every MIR answer that touched an edited module is lowered again.
   - After: only the edited instance's MIR, and the MIR of instances whose Body or Signature
     actually changed, provided its other direct inputs remain equal.
2. **Declaration-local syntax and positions.** Replace revision-local HIR references and add
   location maps alongside declaration-relative spans. This removes the position-shift losses in
   the probe and allows trivia reuse where syntax anchors remain equal. Update TypedBody, MIR
   origins, gap spans and diagnostic rebasing together.
3. **Stable `DeclarationId` keys and projection observations.** This is the largest step. Every
   `declarationAt` and `source` caller changes, and so do `SourceRevision` and `SourceIndex`.
4. **Direct-dependency validation.** Drop transitive observations and the Body-only candidate
   path, which removes the dual reuse mechanism.

**Risks.**

- **Soundness depends on complete reads.** Any provider that reads source or another fact without
  recording it can now keep a stale answer. Today the whole-module observation hides such gaps.
  Mitigation: a verification mode that, whenever it reuses an answer, recomputes it and compares
  fingerprints. It would run in the Cases roots and in one corpus CI leg. The reads most at risk:
  - static evaluation that executes other declarations' bodies;
  - reflection (`Reflect.fields`), which reads members;
  - conformance coherence, which reads every `impl` header in scope;
  - the module shape, which decides name resolution.
- **Fingerprint cost.** Canonical MIR encoding and hashing cost time on cold builds. Measure
  cold-build time and retained bytes as well as warm provider counts. Typed leaf reads can
  outnumber whole-module observations, whose bytes are shared today; memory cost is not yet known.
- **Diagnostics.** Rebasing must happen in exactly one place, or spans will drift. The
  diagnostic catalog tests that assert spans would catch that.
- **Verification oracle.** Recompute against a fresh resolver that cannot hit the same cached
  answers, and compare semantic outcomes plus diagnostics rebased to the current revision.
  Recomputing through the cache under test or comparing the same incomplete fingerprint is not
  sufficient evidence that all reads were recorded.

**Required acceptance cases.** In addition to the reported probe, cover a failed name lookup
becoming present, module deletion and restoration, declaration rename and deletion, same-key
sibling insertion, unnamed-owner insertion, trivia inside a body, documentation changes, and
conditional dependencies that disappear after an edit. Verify static evaluation, reflection,
coherence, cycle diagnostics, nested captures, current diagnostic spans, and target/profile
changes against fresh results. Assert query-event counts structurally; measure time and memory
in opt-in benchmarks.

**Interaction with 01DLG's region-sensitivity work (#1242).**

As of 2026-10-10 (America/Sao_Paulo), #1242 is closed without merging. Its draft reported that
per-pattern validation still expanded combinatorially and required language decisions. Treat it
as a design reference, not an implemented prerequisite or an approved validity algorithm.

- #1242 proposed splitting instance code identity (regions erased) from region-pattern validity
  (a new `Family.Validity`).
- If a region-erased code identity is adopted, instance families (Mir, EmissionInputs, LlvmText)
  can key on it only after proving that erased distinctions cannot select different code. An edit
  still affects every demanded specialization of the declaration, rather than exactly one instance.
- A validity family can use cutoff, but must record all semantic inputs read by its checks,
  including conformance and cleanup selection. Signature and Body fingerprints alone are not a
  demonstrated complete dependency set. Equal code may allow emission reuse while validity checks
  re-run; semantic validity does not follow from that code equality.
- The designs can compose, but canonical instance encodings and validation dependencies must be
  agreed with #1242 before implementation. Region-pattern obligations remain separate inputs;
  equal emitted code does not prove equal validity. An approved identity split may shrink the
  number of answers to fingerprint and revalidate.
