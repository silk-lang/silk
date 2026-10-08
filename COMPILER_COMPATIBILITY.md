# Compiler compatibility and intentional language changes

Read this file before treating a standard-library or compiler build failure as a compiler defect.
It records deliberate language changes and the places where Silk's two compilers do not yet agree.
It does not list every failure. A compile error that no entry explains still needs ordinary
diagnosis, and it may be a real bug.

## What decides the right behavior

- The [prescriptive language reference](apps/docs/content/reference/index.md) states intended
  behavior. A **Confirmed** rule there, or an entry below marked **Approved**, wins over what
  either compiler currently does.
- The repository is green-field (see [AGENTS.md](AGENTS.md)). Existing compiler behavior is
  evidence, not a compatibility promise. Do not add compatibility shims, fallbacks, or old-behavior
  paths to make a failing program compile. Update the program, the compiler, or both, toward the
  approved rule.
- An approved change is not an implemented change. Each entry says separately what has been
  approved, what has been implemented, and what has been verified.

## The two compilers

| Compiler                       | Location                                                        | Role today                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript bootstrap (stage 0) | `packages/compiler`, `packages/cli`                             | Builds and checks every Silk program today: the standard library in `packages/compiler/stdlib`, examples, and the self-hosted compiler's own sources. Repairs start from `main` (see the [development branches and bootstrap](compiler/README.md#development-branches-and-bootstrap) section).                                   |
| Self-hosted native frontend    | `compiler/` (developed on `selfhost` and `selfhost-*` branches) | Lexer, parser, HIR lowering, demanded semantic queries, and native `silkc build` for the documented closed-body subset. Its semantic and backend coverage is incomplete. The TypeScript CLI commands `silk build`, `check`, and `test` still use the bootstrap. [compiler/README.md](compiler/README.md) lists what it supports. |

Consequences:

- A standard-library build failure comes from the **bootstrap**. Check the entries below and the
  reference before deciding whether the bootstrap, the library source, or the rule is wrong.
- An `Unsupported` answer from the native semantic queries does not prove that the form is valid
  Silk, and it does not promise a future implementation. Check the reference and the supported
  scope in [compiler/README.md](compiler/README.md) to tell apart a planned feature, a deliberate
  language boundary, and syntax the language does not have. For example, `where` clauses are absent
  from the first stable language, not pending support. A rejection with a specific code, such as
  `InvalidRequirement` or `NestedQuantifier`, is meant to implement a reference rule. Check that
  rule rather than assuming either compiler is right.
- Do not change the bootstrap merely to mirror native behavior, or the reverse. Change either one
  only toward the approved rule, through that compiler's normal branch and review path.

The native frontend's completed M2.3 scope is contract-level semantic analysis: interface and
service scopes, coherent implementation heads, conditional conformance, witnesses, generic
application and abstract body typing, method and eligible operator selection, and validated reuse
across held source revisions. A fresh per-request specialization Pool builds identities from those
validated facts; cached Pool or instance answers are outside M2.3. See
[compiler/README.md](compiler/README.md#semantic-scope-and-later-waves) and the reconciled M2
coverage ledger (workspace note `fc5536e2-4ce3-4989-8600-43c96f4104d5`). A `ContractTyped` body
still carries ownership, lifetime, cleanup, and Effect safety obligations for M2.5. This does not
claim borrow checking or general executable support. The selfhost build CLI currently lowers closed
scalar, reference, record and sequence forms through demanded MIR and LLVM text. The selector
`silkc build <source> -o <file.ll> --emit llvm-ir` writes the completed backend answer directly;
the default output links an executable. IR output does not invoke Clang. Successful builds emit a
`SILK_GAP borrow-check` summary when reached bodies retain safety obligations. Field/index
projections now use neutral record/sequence layouts in backend roadmap step 4. Runtime slice
descriptors and checked element places use the same internal aggregate slots; subrange primitives
remain a named `intrinsic-member` gap. A repeated inferred shared-slice lifetime with distinct
actual Local regions of the same caller is admitted at the region the binder already holds, and the
body retains a `RegionRelation` safety obligation for the later checked caller-region/outlives
stage; this does not admit fixed Static, incompatible access/element, or foreign owner evidence.
See "Native typing retains unproven caller-local region relations" below. Immediate raw
pointer weakening removes mutation capability, adds nullability, and weakens alignment as the
bootstrap does (any requirement to `align(1)`, a written alignment to a smaller written one),
preserving invariant pointee/extent; it does not implement reverse access, nested pointee
covariance, or other qualifier conversions. Ownership, lifetime, and cleanup
checking remains step 14. The TypeScript bootstrap still builds the native compiler and remains the
complete language oracle.

## Entry format

Each entry records:

- **Status**: Approved, Implemented, Verified, Deferred proposal, or Retired, with the date and
  decision source.
- **Rule**: the programmer-visible behavior and its reference clauses.
- **Compilers**: current bootstrap and native behavior, stating what has and has not been checked.
- **Source migration**: what programs and library code should write now.
- **Diagnostics and limits**: expected outcomes and explicit boundaries.
- **Evidence**: tests or runs that prove the implemented parts.
- **Open questions**: unresolved boundaries.

## Entries

### Native integer C variadic imports

- **Status:** implemented and locally verified on 2026-10-07; Linux integration remains pending.
- **Rule:** a C import with at least one fixed parameter accepts closed integer tails. Signed and
  unsigned 8/16-bit tails promote to signed i32; wider and target-sized integers retain their
  widths and signs. Calls and declarations retain the true C variadic function type.
- **Compilers:** the bootstrap already implements this subset. The native frontend now retains
  authored variadic status in canonical signature identity and call evidence, including imported
  revision invalidation. MIR retains independently validated integer promotion records; LLVM
  emits the actual ellipsis and variadic call type, including a zero-tail call.
- **Source migration:** use the ordinary C import and unsafe call syntax; no library spelling is
  recognized by the compiler.
- **Diagnostics and limits:** noninteger tails, zero-fixed imports, variadic exports and bodies,
  ordinary variadic functions, first-class variadic values and GNU AArch64 remain refused. Fixed
  C contract, unsafe, failure, provider, retention and callback boundaries still apply.
- **Evidence:** four existing SemanticLoweringCases actors cover actual Body/MIR/LLVM facts, exact
  negative outcomes, original signature identity and warm/fresh imported revisions. Local focused
  execution passed all four actors plus the global semantic canary (5 PASS, 0 FAIL, 77 ms).
  Actual optimized N0 integer calls linked to an independently compiled C receiver returned 42
  with Clang O0 and O2 on Darwin; this does not claim Linux ABI execution or an N1 executable.
- **Open questions:** remaining native compiler self-build refusals are measured separately.


### Shared-loan lifetime shortening in selfhost call inference

- **Status:** implemented on 2026-10-04 on PR #787; verification is pending exact-head CI.
- **Rule:** a shared loan `&'x T` or `&'x [T]` requires `T: 'x` (LIFE-002). A lifetime in a
  covariant position of `T` may therefore be shortened to `'x`. Covariance follows the bootstrap
  `NominalVariance`: reference, slice and `string` lifetimes are covariant, a shared referent keeps
  its position's variance, and exclusive referents and pointees are invariant. A nominal lifetime
  argument is covariant only when its struct, tuple, union or enum declaration stores that binder
  only in covariant positions.
- **Compilers:** the bootstrap checks every argument by subtyping over the complete variance
  summary. Selfhost call inference still unifies exactly. Only when an inferred argument fails with
  `TypeMismatch`, and both the argument and the parameter are shared loans, does selfhost match one
  shortened argument against the same inference state. In that argument, each referent lifetime in
  a covariant position is shortened to the argument's loan region, but only where the parameter
  writes its own loan lifetime. Every other lifetime keeps its evidence.
- **Source migration:** none.
- **Diagnostics and limits:** selfhost is stricter than the bootstrap. Type arguments, requirement
  rows, callable and Effect positions, services, interfaces, recursive declarations still being
  summarized, and declarations whose member shape is unavailable are treated as invariant. Such
  calls keep the original `TypeMismatch` at the call.
- **Evidence:** `sharedLoansShortenCovariantNominalArguments` in
  `compiler/src/semantic/SemanticLoweringCases.silk`.
- **Open questions:** when selfhost replaces exact call inference with subtyping, fold this rule into
  the matcher using a cached per-declaration variance summary.

### Result-only call lifetimes in selfhost

- **Status:** implemented on 2026-10-06 on PR #1076.
- **Rule:** a lifetime binder that only a call's result, failure or requirements mention, such as
  the impl lifetime of `impl<'names> TrailerPolicy<'names> { fn defaultPolicy() ->
  TrailerPolicy<'names> }`, is chosen by the call's use (LIFE-003): no operand constrains it.
- **Compilers:** the bootstrap solves the region with the rest of the body. Selfhost fixes it at the
  call: a complete ordinary call takes the region its expected result names, and otherwise binds
  `'static`, since the outcome retains no operand region through that binder. A lifetime binder
  nothing mentions, such as `fn advanceFinalStage<'head>(...)`, binds `'static` too, which the
  bootstrap also accepts; only type and row binders stay `UninferredParameter`. Sections and
  function values keep their existing result-only binder gaps.
- **Source migration:** none.
- **Diagnostics and limits:** when a later use needs a shorter region in an invariant position,
  selfhost reports that use's exact type mismatch or the deferred lifetime-shortening gap where the
  bootstrap infers the shorter region.
- **Evidence:** `resultOnlyLifetimeBindersFollowTheirUse` in
  `compiler/src/semantic/SemanticCaptureCases.silk` and
  `bodyChecksDirectCallsWithoutDemandingCalleeBodies` in
  `compiler/src/semantic/SemanticConformanceCases.silk`.

### Caller-local region relations and 'static binder shortening in selfhost

- **Status:** implemented on 2026-10-07 on PR #1091.
- **Rule:** a region the bootstrap infers by flow meets a declared region at the boundary that
  fixes it (LIFE-002).
- **Compilers:** the bootstrap solves every such region with the rest of the body. Selfhost keeps
  its regions fixed at typing and instead retains a caller-local region meeting a declared region
  as an open `RegionRelation` obligation at a loan through a descriptor (`&view[at]` over a
  call-local view), at an operand of an already fixed type binder (`Option.some<&'a T>(&values[at])`),
  and at a variant pattern that writes its regions, which admits the subject by covariant region
  subtyping (a `'static` subject meets `Maybe<&'a i32>`, as in the bootstrap). An inferred lifetime binder that earlier `'static` evidence fixed
  shortens to a later operand's caller-local region when every parameter stores the binder
  covariantly and no bound or environment names it.
- **Source migration:** `checkExpressionUnder` held an integer suffix slice borrowed from a
  borrowed `if let` binding past its conditional. That binding is a pattern-local loan that ends
  with the selected body (PATT-009), so the source now keeps the suffix in one owned `Bytes`.
- **Diagnostics and limits:** a fresh loan of body-owned storage still needs a declared premise,
  a pattern region longer than the subject's stays `TypeMismatch`, and a
  binder that a parameter stores invariantly keeps its first `'static` evidence and reports the
  operand's `TypeMismatch` where the bootstrap infers the shorter region. A view derived from a
  borrowed pattern binding that outlives its conditional is `TypeMismatch` in selfhost; the
  bootstrap accepts it, against PATT-009.
- **Evidence:** `callerLocalRegionsRelateAtFixedBoundaries` and
  `patternElisionInfersOmittedLifetimesFromTheSubject` in
  `compiler/src/semantic/SemanticCallableCases.silk`.

### Catalog-defined runtime intrinsic coverage in selfhost

- **Status:** native coverage classification approved by the B8 coordinator on 2026-09-30;
  implementation verification is pending exact-head CI on PR #615.
- **Rule:** source-callable compiler primitives retain their canonical sealed `Intrinsic`
  identities from the [intrinsic reference](apps/docs/content/reference/unsafe-intrinsics-and-targets.md).
  A misspelled member is an error; a catalog-defined runtime or mixed-phase member that selfhost
  has not implemented is an explicit `intrinsic-member` build gap.
- **Compilers:** the bootstrap catalog defines the complete membership and phase metadata.
  Selfhost implements its target/static-text subset, the scalar `i32`/`bool`/float-bit
  primitives, `isizeToUsize`, and the raw-pointer primitives `pointerFromSlice`, `pointerAt`,
  `pointerRead` and `pointerRequalify`; the membership check itself adds no primitive.
- **Source migration:** none. Keep ordinary standard-library wrappers in Silk source rather than
  adding privileged library actors or substituting unsupported runtime implementations.
- **Diagnostics and limits:** the semantic lane retains `IntrinsicUnavailable` at the authored
  member span, and the backend reports `intrinsic-member`. A noncatalog spelling remains
  `UnknownMember`, including with explicit generic arguments. Other rejection codes and build
  timeouts are not converted by this classification.
- **Evidence:** the existing `staticIntrinsicContractsRejectUnknownMembersAndMismatches` fixture
  asserts known versus unknown membership and the exact backend gap span. The corpus runner check
  compares the complete committed runtime/mixed spellings with `Intrinsic.inventory()`.

### Sealed core storage in selfhost

- **Status:** implemented on 2026-10-06 on PR #1080 (Stage 1 sealed core storage workstream);
  verification is pending that PR's CI.
- **Rule:** the storage core types follow the reference, the standard library and the bootstrap.
  `Allocation` is six target words, `RawBuffer<T>` is its allocation and element count,
  `Slot<'storage, T>` is one element address, and `Intrinsic.SharedCore<T>` addresses a local,
  non-atomic control block. Only the primitives the standard library calls are implemented, each
  expanding to ordinary MIR; shared-core drop glue counts references, and raw-buffer and slot
  contents stay owned by library code.
- **Compilers:** both compilers name the standard library's `silk/layout` `Layout` record in the
  contracts of `layoutOf`, `sharedLayout` and `systemAllocationAcquire`; selfhost resolves it from
  the standard-library module and requires its storage to be exactly two `usize` fields. Selfhost
  calls the sealed C `malloc`, `free`, `memmove` and `memset` declarations where the bootstrap emits
  LLVM memory intrinsics; the observable allocation, refusal and trap behavior is the same.
  Execution storage (`Intrinsic.Execution`, `Intrinsic.Wake`) remains the `core-type` deferral.
- **Source migration:** none. A source type named `Slot`, `RawBuffer` or `Allocation` cannot be
  named in type position; inherent owners and expression paths of the same spelling stay ordinary.
  A stored core contributes only its written element types to its container's field lifetimes.
- **Diagnostics and limits:** contract violations reject with `TypeMismatch`, `CallArity`,
  `TypeArity`, `MissingConformance` for a non-Copy read, and the unsafe acknowledgement codes. A
  stored `systemAllocationAcquire` Effect that is not run in place reports the `effect-form` gap.
- **Evidence:** `sealedCoreLayoutsAndCleanup` and `storagePrimitivesFollowTheirContracts` in
  `compiler/src/semantic/SemanticCallableCases.silk`, and the native corpus programs that use the
  storage core.

### Generic record union members and cleanup re-entry in selfhost

- **Status:** implemented on 2026-10-06 on PR #1089 (Stage 1 self-build, the `union-form` gap in
  `silk/vector.silk`).
- **Rule:** a nominal application is a structural-union member even while its arguments are open,
  so a generic body injects into and matches `Empty<T> | Full<T>`; each closed instance maps the
  authored member to its canonical tag. Instance discovery admits a re-entry with changed type
  arguments while it runs inside a Drop hook's cleanup and every type argument stays within the
  owned structure of the value whose cleanup selected the hook (GEN-006).
- **Compilers:** both compilers admit nominal union members and follow cleanup re-entry under an
  immutable root. The bootstrap tracks the root together with the selected hook's own type
  arguments as a frame; selfhost keeps the single root the reference names and requires every
  later type argument, including a nested hook's, to lie within that root's structural parts and
  nominal fields, unfolding a declaration again only at a strictly smaller instantiation.
- **Source migration:** none.
- **Diagnostics and limits:** growth outside the root's owned structure, including a hook that
  drops a larger value of its own type, keeps `ExpandingSpecialization`. A closed instance whose
  members collapse to one runtime identity keeps the `union-form` gap.
- **Evidence:** `genericRecordUnionsInjectAndMatchInGenericBodies` in
  `compiler/src/semantic/SemanticLoweringCases.silk` and `cleanupReentryStaysWithinItsOwnedRoot` in
  `compiler/src/semantic/SemanticCaptureCases.silk`.

### Static aggregate reflection subset in selfhost

- **Status:** implemented on 2026-10-02 on PR #664 (B12 c39, decision D2); verification is pending
  that PR's exact-head CI.
- **Rule:** `Intrinsic.reflectType<Owner>()` yields the phase-only `Intrinsic.Type<Owner>`
  descriptor, and `Intrinsic.reflectTypeKind<Owner>(descriptor)` yields the stable `silk.reflect`
  kind code. Both exist only during static evaluation; a descriptor has no runtime representation.
- **Compilers:** the bootstrap implements the complete reflection family, including fields and
  field metadata. Selfhost implements only `reflectType` and `reflectTypeKind`, and only for a
  source-declared struct (kind 0) or tuple (kind 1), during static evaluation. It has no
  `reflectFields`, `reflectFieldKind`, `reflectFieldLabel`, `reflectFieldOrdinal`, or
  `borrowField`, and no occurrence-generated aggregate kinds (2 and 3).
- **Source migration:** none. `silk.reflect` keeps its source wrappers; selfhost checks
  `Reflect.typeOf` and `Reflect.typeKind` and leaves the others unchecked until demanded.
- **Diagnostics and limits:** in selfhost, a reflection call outside static evaluation, a runtime
  signature mentioning `Intrinsic.Type<Owner>`, and a descriptor reaching runtime code through a
  selection pass are `StaticPhaseViolation`. A non-aggregate or occurrence-generated owner is an
  `Unsupported` static evaluation failure for a missing intrinsic operation, reported as
  `StaticViolation` at the `reflectTypeKind` call, never a fallback code. An unlisted reflection
  member remains `UnknownMember`.
- **Evidence:** in `compiler/src/semantic/SemanticStaticCases.silk`,
  `selectedTypeSelectionReadsReflectedKinds` covers the two-type static selection,
  `reflectedKindCodesMatchTheLibrary` covers both kind codes and the unsupported owner, and
  `reflectedDescriptorsStayOutOfRuntimeCode` covers each runtime boundary. The shared corpus program
  `static-type-selection` exercises the bootstrap natively.
- **Open questions:** when selfhost needs fields, add the remaining members with the same
  phase-only descriptor rules.

### Module static selection subset in selfhost

- **Status:** implemented on 2026-10-04 on PR #773 (roadmap #567 Step 10b); verification is pending
  that PR's exact-head CI.
- **Rule:** declarations in module-level `static if` arms belong to the module namespace; only
  selected arms exist, a failed or cyclic condition admits neither arm, and package parameters
  cannot be conditional ([module static
  selection](apps/docs/content/reference/module-static-selection.md), MODULE-STATIC-001 to 003).
- **Compilers:** the bootstrap implements the complete rule. Selfhost selects arms for names,
  imports, impl heads and inherent members through `Condition` queries, never reads an inactive
  arm's imports, and rejects conditional package parameters by syntax. It does not yet select arms
  inside mixed-body static routing, and it bounds interface scans during condition evaluation as
  described below.
- **Source migration:** none. Standard-library modules keep their module-level arms.
- **Diagnostics and limits:** a non-`bool` condition is `ConditionNotBool` at the condition; a
  condition that depends on its own arm is `Cycle`; a conditional package parameter is
  `ConditionalParameter` at its declaration. Static routing of a mixed body (a function containing
  `static if` or static parameters) reads only the syntax index, so naming a declaration that has
  any conditional candidate there fails with fault `ConditionalName` and code `Unsupported` at the
  name, even when an arm admits it. While a condition is evaluated, every demand is keyed by that
  condition, and interface scans for operator and method syntax skip names whose every candidate
  sits in that condition's own arms. Answers are therefore deterministic, but an operator or method
  used by the condition or its helpers cannot be supplied by an interface that only the condition's
  own arm imports or declares: the condition resolves as if that interface were absent instead of
  reporting `Cycle`.
- **Evidence:** `moduleArmsSelectNativeDeclarations` and `conditionOrderSelectNativeAnswers` (both
  demand orders in fresh stores) in `compiler/src/semantic/SemanticSignatureCases.silk`, and
  `mixedConditionalNameSelectNativeBoundary` in `compiler/src/semantic/SemanticStaticCases.silk`.
- **Open questions:** expose arm availability through the static port so mixed-body routing can
  select arms, and decide whether the scan bound should instead report `Cycle` when a skipped
  interface would apply.

### Selfhost rejects moves out of `match place` bindings

- **Status:** implemented on 2026-10-03 with Step 6a.
- **Rule:** a `match place` binding denotes a refined place of the subject; an explicit move may
  extract it after a guard succeeds (MATCH-001).
- **Compilers:** the bootstrap treats the move as a partial move of the subject's root, checked
  against its Drop boundary. Selfhost rejects `move` of any `match place` binding, and `drop` of a
  non-Copy one, as `Unsupported`, because its consumed places do not yet carry the subject path's
  owner types.
- **Source migration:** none.
- **Evidence:** the `placed` and `droppedPlaced` fixtures of `unextractablePlacesAreRejected` in
  `compiler/src/semantic/SemanticLoweringCases.silk`.

### Selfhost reports cleanup it cannot lower yet as the `cleanup` gap

- **Status:** narrowed on 2026-10-03 by Step 6c, which lowers drops at every scope exit, and by
  Step 6d, which lowers partial moves, and Step 7, which substitutes complete generic nominal
  instance payloads before selecting and building drop glue.
- **Rule:** an owned value whose type carries `impl Drop` in its owned structure is cleaned when it
  leaves scope without being moved.
- **Compilers:** both lower drops, replacement drops, drop flags and partial moves. On 2026-10-07,
  selfhost component cleanup was locally verified for conditional partial transfers, joins with
  opposite authored move orders, receiving-owner cleanup and component refill. It retains canonical
  projected components and independent edge-written flags rather than consuming-site hole lists.
  Selfhost still reports the backend gap `cleanup` for a write at a runtime index beside a moved
  element, a loop iteration that leaves an owner in a different state than it found it, a
  guard that changes an owner's state, a borrowing match result whose arm created temporaries, and
  drop glue for callable and Effect environments and unions without a canonical member order.
  Since 2026-10-08 a type parameter owns no cleanup when a declared premise proves it Copy, as
  `K: Copy` or a shared callable representation does; an unbounded abstract owner of a generic
  named instance keeps the `cleanup` gap.
- **Source migration:** none.
- **Evidence:** `cleanupStackDropsWhatEachExitLeaves` and `dropGlueCleansHookThenChildren` in
  `compiler/src/semantic/SemanticLoweringCases.silk`, and `cleanupFollowsLoopsAndConditionalPaths`
  and `partialMovesDropTheRemainingChildren` in `compiler/src/semantic/SemanticCaptureCases.silk`
  cover the lowered forms and the holes, runtime-index, guard, loop and borrowing match result gaps.
  The extended partial-move actor authenticates real Move/Copy chains, exact source checkpoints,
  both conditional cleanup paths, receiving glue, distinct component flags and literal refill. Seven
  focused tests passed in 247 ms (maximum 71 ms), with the timing gate passing. Deferred glue forms
  and real N1 completion remain unproved.

### Selfhost keeps unavailable conditional sealed-property proofs explicit

- **Status:** recorded on 2026-10-04 with Step 7 review corrections.
- **Rule:** generic Copy and Drop implementations apply only when their exact provider head and
  substituted bounds hold. Drop hooks use the head's unification bindings, including reordered,
  fixed and nested provider arguments, rather than nominal argument positions.
- **Compilers:** selfhost proves lexical premises, Copy, outlives, retained-region and interface
  conformance constraints through the ordinary semantic queries. It does not yet execute every
  intrinsic property or representation proof supported by the bootstrap. Such an unavailable
  concrete proof remains `Unsupported`, never absence of a required Drop hook. Without proof of
  an abstract conditional Copy head, ordinary abstract checking conservatively keeps it affine.
- **Source migration:** none; the remaining property/representation solver is a named follow-up,
  not a generic-instance layout or library-constructor exception.
- **Evidence:** `genericSealedCopyUsesLexicalAndLifetimePremises`,
  `genericSealedDropRetainsExactHeadBindings` and `genericSealedUnknownDropProofIsNotAbsence` in
  `compiler/src/semantic/SemanticLoweringCases.silk`.

### Selfhost resolves complete selected instance recipes before emission sharing

- **Status:** implemented on 2026-10-04. Execution, independent-review and exact-head Linux CI
  acceptance receipts are published on PR #761; source implementation is not itself a CI receipt.
- **Rule:** semantic instances retain exact lifetime evidence for conditional conformance and
  cleanup. MIR remains layout-free, and emitted identities use the canonical selected graph
  described in [MIR core shape §2](compiler/docs/mir-core-shape.md#2-places-and-types-question-1).
- **Compilers:** selfhost resolves every exact semantic glue and function application before
  deciding whether its selected runtime recipe can be shared. Equal complete recipes share;
  incompatible recipes receive distinct symbols, including all transitive callers. The erased
  family alone is not emitted-code identity. Generic named-section types likewise retain fixed
  selected lifetimes and the remaining contract's free validity in exact equality, even when
  their runtime projections agree; copied immutable schema handles remain equal. The bootstrap currently compiles the reduced
  conditional Drop fixture but its local-only execution traps; source inspection identifies a
  missing substituted impl-lifetime-bound check in conformance discovery. A fixed-lifetime local
  control succeeds alone but traps when both lifetimes reach one generic caller declaration.
  The shared runtime control uses a fixed head and separate caller declarations, and observes
  both payload drops through borrowed counters. That control passes both compilers; the harder
  bound-sensitive and same-declaration caller cases remain native structured acceptance claims.
  Bootstrap bound proof and caller-sharing repairs are separate bootstrap follow-ups, not native
  gaps or reasons to weaken these controls.
- **Source migration:** none. This is a native emitted-instance follow-up, not an Option/Result
  exception or an effect/closure deferral.
- **Evidence:** review counterexample: `Guard<'a>` always owns a droppable `Token`, but its own
  `impl<'a: 'static> Drop` hook applies to a static instance and not a local one. Both demand
  orders and equal-recipe sharing controls are retained as structured acceptance assertions;
  all four source controls execute successfully. Linux cost and current integrated-head execution
  are separate acceptance gates, not implied by source review.

### Selfhost generic aggregate diagnostics retain existing family differences

- **Status:** recorded on 2026-10-04 with Step 7 review corrections; native test execution is
  pending.
- **Rule:** written constructor prefixes are fixed evidence, only omitted parameters may be
  inferred, record patterns must select the scrutinee's exact owner, and applied generic bounds
  must follow lexical premises.
- **Compilers:** bootstrap reports `SEM0025` for a fixed-prefix field type mismatch and `SEM0042`
  for a different record owner in a pattern. The native frontend uses its existing `TypeMismatch`
  family at the offending field operand and record pattern, respectively. An unresolved aggregate
  parameter is anchored at its declaration. A missing abstract Copy proof remains `Unsupported`
  at the constrained constructor, not a fabricated proof.
- **Source migration:** none.
- **Evidence:** `genericRecordConstructionPrefixesRemainFixedAndQualified`,
  `genericRecordPatternsCheckAbstractlyBeforeCompleteMir` and
  `genericNominalConstructionRetainsLexicalBounds` contain independent code/span
  controls; execution is not yet claimed.

### Inherent members retain their bounded nominal owner's domain premises

- **Status:** intentional native correction authored on 2026-10-04 during Step 7 review;
  native execution and exact-head CI are pending.
- **Rule:** a local whole-family `impl<T> Box<T>` for `Box<T: Copy>` operates within the
  owner's valid domain. Its receiver/header and ordinary abstract body inherit `Copy(T)`.
  These are substituted owner premises, not extra authored implementation bounds. Ordinary
  applications and conformance heads must still prove the owner's bounds.
- **Compilers:** the bootstrap accepts this inherent head but rejects returning `self.value`
  from a borrowed `Box<T>` with `OWN0002`. Its ownership `Project` path classifies the field
  with the member's Copy assumptions and treats it as a partial move when the owner's premise
  is absent. Native signatures explicitly retain the validated owner's premises; this avoids
  a concrete specialization concealing an invalid abstract body.
- **Source migration:** keep the whole-family head `impl<T> Box<T>`; adding `T: Copy` to
  the authored implementation binders is not a workaround for this domain-premise omission.
- **Evidence:** bootstrap reduced probe `bounded-copied.silk` rejects `self.value`; native
  structured control `genericBoundedOwnerSuppliesReceiverHeaderAndFieldCopy` separately checks
  the caller's borrowed receiver, exact member header and ContractTyped field projection.
  Native results remain pending. The unbounded-construction negative remains in
  `genericNominalConstructionRetainsLexicalBounds`.
- **Owner:** bootstrap nominal-domain premise propagation follow-up; no Option/Result exception.

### Selfhost bounds inline stored-property proof recursion

- **Status:** authored on 2026-10-04 during final Step 7 correction verification; native execution
  and exact-head CI remain pending.
- **Rule:** Copy and cleanup proofs must terminate without treating impossible inline storage as
  Copy or cleanup-free. Consuming a strict runtime-subterm argument discharges only that ancestor
  frame; older cycle evidence remains. Finite descent through an opaque nominal argument's fields
  is allowed, including `A<B>` followed by `B` and `A<i32>`.
- **Compilers:** bootstrap's declaration-completion storage SCC reports `SEM0020` at an aggregate
  name. Native on-demand Copy validation reports its existing `InvalidCopyConformance` family at
  the selecting Copy implementation; cleanup reports `InlineStorageUnavailable` at the repeated
  aggregate's whole declaration with the named `inline-storage-recursion` gap. Both module and
  span come from that same selecting declaration, including imported cycles.
- **Source migration:** none; infinitely expanding inline storage has no finite runtime layout.
- **Evidence:** `genericCopyRejectsAffineStoredFieldsAndOwnDrop`,
  `genericCopyCyclesKeepCompleteImportedDiagnosticSite` and
  `genericCleanupPropertiesKeepFiniteOpaqueDescentAndRejectGrowth`; corrected execution pending.

### Selfhost keeps generic aggregate borrow regions tied to actual places

- **Status:** authored on 2026-10-04 during final Step 7 correction verification; native execution
  and exact-head CI remain pending.
- **Rule:** fixed lifetime arguments cannot be replaced by local inference or manufacture a
  stronger loan than the borrowed storage. Reborrowing a parameter referent retains its source
  region; a static result annotation cannot turn owned local storage into a static loan.
- **Compilers:** bootstrap reports `SEM0212` at the invalid local borrow and `OWN0019` at its
  enclosing return use. The native aggregate operand boundary retains `TypeMismatch` at that
  borrow, consistent with its existing field type-mismatch family. Complete and partial written
  prefixes remain fixed evidence.
- **Source migration:** none.
- **Evidence:** positive complete/partial prefixes and the local-to-static negative in
  `genericNominalBorrowArgumentsPreserveActualRegions`; reduced-fixture native execution pending.

### Selfhost guard ownership checking is limited to callable availability

- **Status:** recorded on 2026-10-03 with Step 6c; callable availability extended with Step 8d.
- **Rule:** the reference reports OWN0008 for moving a provisional pattern binding inside its guard
  (ownership-and-borrowing.md, MATCH-002); it states no rule for other places a guard moves.
- **Compilers:** the bootstrap checks explicit moves, callable captures and consuming arguments
  in guard mode, including ordinary locals, which is broader than the reference. Both compilers
  admit the implicit receiver transfer of an ordinary stored once invocation or staging while
  preserving guard checks on nested explicit moves and supplied arguments. Selfhost reports
  `GuardConsumesPattern` at a forbidden transfer span in bodies checked by callable availability,
  including environments that need no drop glue. It also rejects implicit receiver transfer from
  a provisional matched subject, following MATCH-002; the bootstrap currently bypasses its guard
  check for that receiver path. Other bodies still type a guard that moves an owner; MIR
  reports the `cleanup` gap when the guard changes an acquired cleanup owner's state. General
  ownership checking outside callable availability remains incomplete.
- **Source migration:** none.
- **Evidence:** `plainCallableParameterRejectsCleanupFreeGuardTransfer` checks retained guard
  control flow independently of layout and Drop, with an unguarded transfer control.
  `plainCallableParameterDistinguishesGuardTransfers` checks source argument, invocation and nested
  explicit callee moves with diagnostic spans. The
  `guardMoves` fixture of `cleanupFollowsLoopsAndConditionalPaths` retains the ordinary-body gap.
  Source callable-bearing record patterns are not claimed as native runtime coverage here;
  unexamined record-pattern combinations retain explicit callable availability/lowering follow-ups,
  rather than being counted as proven generic-record or closure coverage.
- **Open questions:** whether the bootstrap should narrow OWN0008 to provisional bindings, or the
  reference should widen it, before extending selfhost's general guard ownership checking.

### Plain mutable callable parameter forwarding in selfhost

- **Status:** temporary native view lowering implemented on 2026-10-04 in #783;
  the final exact-head verification receipt belongs to #567 Step 8.
- **Rule:** CALLABLE-003 separates reusable exclusive environment access from ownership of newly
  supplied arguments. Bootstrap keeps a source-written plain `mut fn` parameter as a callable
  view: forwarding that parameter without `move` does not consume it. An exact affine closure
  value or an authored constrained `F` argument still requires an explicit transfer.
- **Compilers:** selfhost specializes plain callable parameters with exact environment types.
  A bare plain mutable parameter passed to another plain mutable parameter stores a temporary
  reference to its original environment before inference. Its public capture contract is
  separate from the local storage loan, including when the public captures are static.
  Runtime projection keeps the reference descriptor. Direct anonymous invocation borrows the
  dereferenced original place; sections snapshot only that descriptor and dereference it before
  reading the stored trailing arguments. No environment copy, adapter or function pointer is
  introduced. Constrained parameters, exact closure locals, references and explicit moves keep
  their ordinary ownership roles.
- **Evidence:** `plainCallableParameterForwardedMutableViewRetainsOriginalEnvironment` checks
  the local storage loan, static-public-contract retention, original mutable call operand and
  Shared-capable targets. `plainMutableCallableSectionViewProjectsBeforeStoredArguments` checks
  descriptor snapshot, Deref-before-Field order and absent consumer cleanup.
  `plainCallableParameterRejectsAffineArgumentCopies` retains the consuming controls. Bootstrap
  accepts reached mutable-capture, Shared named-target and section forwarding controls, but
  does not publish an explicit hidden forwarding loan; the native reference descriptor is its
  transport design rather than a claimed matching bootstrap ownership fact.
- **Owner:** Step 8 owns view construction and direct lowering. General borrow and parent-loan
  validity obligations remain honestly NotChecked for Step 14. Raw owned-callable return
  diagnostics and exact callable union storage are implemented separately in #784 and #785.

### Unary callable pipelines in selfhost

- **Status:** PIPE-001 conformance implemented during Step 8d; operator-pipeline is a native
  PASS at exact head 2eda17b (CI 37212293538).
- **Rule:** a pipeline completes its input once, evaluates a unary callable, and invokes it with
  that input. A section on the right side is constructed after the input, then invoked directly.
- **Compilers:** selfhost lowers anonymous and stored callable pipelines with their exact ordinary
  function target. It retains a transferred input for cleanup if evaluating the callee exits.
  It reports `CallArity` at the complete pipe when the target is not unary. Bootstrap currently
  also permits piping into a multi-parameter callable as partial trailing application; that
  behavior differs from the confirmed unary PIPE-001 boundary and is not adopted by selfhost.
- **Evidence:** `callablePipelineCompletesInputBeforeCapture`,
  `callablePipelineStagesAndAppendsArguments` and
  `callablePipelineDropsTransferredInputOnCalleeExit` assert source-order MIR, original-target
  suffix appending and cleanup transfer. `callablePipelineRejectsNonUnaryTargets` checks arity
  codes and pipe spans. Interface-operation and Effect pipeline coverage remain separate gaps.
- **Source migration:** construct a unary section on the right, for example `2 |> add(3)`.

### Generic named sections in selfhost

- **Status:** direct invocation and closed contextual callable admission implemented in the Step 8
  generic-section layers; direct generic-schema staging retains the same immutable blueprint.
  Named callback construction also uses determined parameter and result-channel evidence while
  another consumer requirement row remains open; unresolved consumer positions are not evidence.
- **Rule:** construction may defer target binders mentioned by remaining parameters. Unused or
  result-only unresolved binders report `SEM0052` at the construction call. Each invocation solves
  independently; immutable construction evidence keeps its original binder ordinal. A named
  function value passed to a callable parameter takes its remaining type binders from determined
  positions in the promised contract before deferral, as does a checked scalar intrinsic's carrier
  parameter. A still-open consumer type or row supplies no target evidence; the callback's actual
  requirements determine an inferred consumer row. This follows the bootstrap's function-item
  inference; lifetime binders and borrowed type evidence still wait for the invocation.
- **Enclosing impl binders:** a section or function value whose target is an inherent member of a
  generic `impl` selects every impl binder at construction, from written arguments, the supplied
  suffix or the promised contract, and stores it as selected owner evidence beside the deferred
  own binders (`&tokens |> Vector.get<Token>(index)`, `Option.some` passed as a carrier). A schema
  cannot defer an impl binder, so such a value without that evidence keeps the generic
  `Unsupported` gap.
- **Compilers:** selfhost opens a generic section's target binders for each concrete callable
  promise, proves its target bounds, and preserves the shared blueprint. A later operand may first
  fix a consumer's type parameter. MIR selects the target from closed invocation operands rather
  than the comparison contract. Direct staging over a schema appends captures and selects any new
  evidence supplied at that stage. Staging through an abstract callable parameter normalizes its
  closed schema recipe before MIR, preserving the original target blueprint and exact capture
  record. Storage mode follows the actual base and newly stored fields; source promises still
  determine consuming transport. Ordinary named sections defer invocation lifetimes through their
  original recipe; quantified contextual admission uses a proved private comparison contract, as
  detailed below. Deferred requirement rows, deferred enclosing impl binders and runtime
  static evidence retain their separate selection boundaries; selected enclosing evidence is preserved. Bootstrap rejects some closed contextual forwarding of a stored generic
  section with `SEM0052`/`SEM0122`: its callable comparison does not open the offered section's
  type binders. This is a bootstrap limitation against the confirmed closed-static-chain rule in
  [the generic specification](openspec/specs/bootstrap-type-generics/spec.md). Selfhost's deferred
  lanes remain named gaps rather than signature-mismatch diagnostics. The implemented native
  contextual lane intentionally extends this bootstrap limitation according to that specification.
  Bootstrap also reports `SEM0122` for the reduced generic-schema staging fixtures; their syntax
  passes `build-exe` checking before that complete-application evidence limitation.
- **Evidence:** `genericNamedSectionsInferEachInvocationIndependently` and
  `genericNamedSectionsPreserveSparseSelectedOrdinals` assert ordinary direct instances for both
  `i32` and `bool`, stored suffix operands, immutable metadata and capture-only layout.
  `contextualGenericSectionsReuseTheirBlueprintAcrossConsumers` and
  `contextualGenericSectionsWaitForLaterOperandInference` inspect the consumer instances' direct
  target calls. The contextual diagnostic and owned-capture claims cover target bounds, conflicting
  signatures and a single transferred capture cleanup. `genericSectionsStageWithDeferredLeadingEvidence`,
  `genericSectionsSelectEvidenceSuppliedByAStage` and `genericSectionsStageOwnedCapturesWithOneCleanupOwner`
  cover staged blueprint selection, capture layout, argument appending and ownership.
  `enclosingOwnerSectionsRetainTheirClosedParameterTypes` covers a piped deferred section over an
  impl member and impl members used as carrier values; `providedCallPrefixesMapLifetimesSeparately`
  covers a result-only binder taken from a closed promise and the open-promise result-inference
  deferral. `sealedScalarAndPointerFamiliesTypeAndLowerFromTheCatalog` covers generic impl members as
  checked scalar carriers. `namedEffectCallbacksUseKnownChannelsWhileConsumerRowsAreInferred`
  follows two concrete wrapper/callback applications through MIR, proves empty and nonempty
  consumer rows from actual callbacks, and retains unknown-success and excess-channel refusals.
  The production compiler check and six focused native controls pass on macOS/aarch64; the new
  actor takes 41 ms. Optimized N1 and Linux corpus outcomes remain separate CI evidence.

### Effect joins in selfhost

- **Status:** Implemented in #567 Step 9 (PR #819, 2026-10-05); narrower remainders below.
- **Rule:** [EFF-013](apps/docs/content/reference/effect-contracts.md#eff-013--compatible-effects-may-join-across-construction-sites)
  lets Effects from different construction sites with one compatible contract join behind a finite
  hidden variant, and a declared `Effect<...>` position may hold any of them.
- **Compilers:** both lower finite joins without allocation or dispatch tables. Selfhost represents
  a join as `Type.EffectJoin { contract, alternatives }`: one alternative is stored as itself,
  several as their structural union, and `run` switches on the tag to each alternative's own runner
  (Effect note D1); drop glue cleans only the stored alternative. Divergences from the bootstrap:
  - A declared `Effect<...>` result of a function body is a producer-owned family, realized like an
    opaque result from the body's returns; distinct returns are injected into their join behind the
    declared contract. The bootstrap infers the composite at the call instead. Values of two
    producers therefore join as two families, each realized at layout.
  - A `match` join without a declared contract retains the intersection of the arms' environments;
    the bootstrap requires equal environments.
- **Diagnostics and limits:** a `match` mixing an Effect with another value is
  `IncompatibleMatchResults`. A return or arm that already holds several alternatives of a
  different join reports the named `nested-effect-join` gap. An Effect result with no producer
  body (an interface operation's declared `Effect<...>` result) remains `effect-form`. An
  `effect fn` handler passed to `Effect.catch`, `catchAll` or `flatMap`, including a generic one
  such as `effect<'env> fn failed<E: 'env, 'env>(error: E) -> i32`, is instantiated from the
  parameters its use determined, and its constructed Effect infers the call's remaining channels.
  A handler whose callable bound still cannot be inferred remains `effect-form`. Interface
  `effect fn` calls have their own entry below.
- **Evidence:** `effectJoinsRunOnlyTheSelectedAlternative`, `effectJoinsCleanOnlyTheStoredAlternative`
  and `effectJoinsAdmitOnlyCoveredEffects` assert injections, tag switches calling the block on each
  tag's payload, failure edges, join glue, Copy derivation, admission failures and the gap codes;
  the native corpus pins `finite-effect-join-capture-arity`, `effect-return-site-join-once`,
  `effect-higher-order-values`, `opaque-effect`, `ordinary-union-executable-members`,
  `match-statement-arm-control` and `effect-access-forwarding`.
- **Owner:** nested join re-injection and Effect-producing callable inference: #567 Step 9
  follow-ups.

### Interface `effect fn` operations in selfhost

- **Status:** qualified calls run in place implemented in PR #1071 (2026-10-06); narrower
  remainders below.
- **Rule:** [INTF-006](apps/docs/content/reference/generics-interfaces-and-specialization.md#intf-006--a-qualified-interface-call-requires-one-static-application)
  lets an unapplied qualified call `Interface.operation(value)` take its one application from the
  provider's conformances. Under
  [INTF-005](apps/docs/content/reference/generics-interfaces-and-specialization.md#intf-005--interface-operations-use-their-declared-ownership-and-effect-contracts)
  and [EFF-009](apps/docs/content/reference/effect-contracts.md#eff-009--declared-failure-and-requirement-channels-are-upper-bounds),
  calling an `effect fn` operation constructs the Effect its applied contract promises, with the
  interface's failure `E` and row `?R`; those channels bound every conforming witness.
- **Compilers:** both infer the application from the provider's conformance heads and reject a
  provider with several applications (bootstrap `SEM0202`, selfhost `AmbiguousConformanceMethod`)
  or none (`MissingConformance`). Selfhost executes a `run` whose immediate operand is such a call
  as one direct call of the selected witness; there is no adapter or runtime dispatch. The call's
  failure edge has the witness's own declared failure, which EFF-009 bounds by the promised one,
  and injects it into the promised failure's sink; a `never` witness gets no edge. Service
  operations dispatched to a provider's witness lower the same way. Selfhost infers the provider
  from the first operand only; the bootstrap uses the operand whose declared type is `Self` or
  `&Self`.
- **Diagnostics and limits:** an `effect fn` interface call that no `run` executes in place (bound
  to a local or returned), a receiver-method call (`value.take()`), operator syntax and a callable
  success report `InterfaceEffectUnavailable` (gap `interface-effect-witness`) at the call. The
  pipeline form `run value |> Interface<Arguments>.operation` remains the pipeline-interface gap.
- **Evidence:** `qualifiedEffectCallsInferTheirApplication` asserts the operation signature's `E`
  and `?R` binders, the inferred contract and selected witness, one witness reference in MIR, a
  failure edge on a fallible witness call, `UnhandledFailure` for an uncovered run, no edge on a
  `never` witness of a fallible operation, and the ambiguous, missing, bound and returned
  rejections at their call spans. `ownedProviderServesGenericBinding` asserts the same edges for
  service witnesses run directly and inside a bound section. `providersServeRowsInKeyOrder` lowers
  `run Present.present(value)` to a witness call. The native corpus pins `borrowed-outcome-stream`,
  `generic-inline-effect-conformance` and `scalar-display`.
- **Owner:** stored constructions, receiver-method, operator and pipeline forms: #567 Step 9
  follow-ups.

### Omitted Effect environments elaborated from inputs

- **Status:** approved by Julia on 2026-09-26. The parameterless rule was approved first; owned
  and borrowed inputs, the earlier Q1/Q2, were approved at 19:10 UTC.
  - **Reference:** [LIFE-004](apps/docs/content/reference/lifetimes.md#life-004--invocation-lifetimes-and-retained-environments-are-independent)
    states the rules, and
    [EFF-008](apps/docs/content/reference/effect-contracts.md#eff-008--an-effect-function-declares-the-contract-of-its-returned-effect)
    links its equivalence to them.
  - **Native:** implemented and verified at the signature level on draft PR #517.
  - **Bootstrap:** implemented on main by PR #522 (merge `263d9c30`) and synced here through
    PR #524 (merge `106d821e`).
- **Rule:**
  - **Retained regions:** an input retains the regions of its borrows, its non-`'static` nominal
    lifetime arguments, and its callable or Effect environments. The parameter and channel types
    of a callable or Effect input are not stored. A representation parameter, bound by
    `F: fn(A) -> B` or `F: Effect<A>`, retains its bound contract's environment. Stored contents
    involving any other type parameter, such as `value: T` or `Box<T>`, have no nameable region.
  - **`effect fn` capture environment:** it captures every input. Its omitted `effect<...>`
    environment is the order-independent, duplicate-free intersection of the regions its inputs
    retain, `'static` when they retain none. Generic stored contents make it ambiguous (SEM0210) at
    that input.
  - **Ordinary named `fn` returning `Effect<A>`:** the omitted environment of the result is
    `'static` when no input retains anything. Otherwise LIFE-003 applies unchanged: a single
    borrowed input supplies it, and any other case requires it written.
  - **`effect fn` whose success type is an Effect:** that Effect's omitted environment is an output
    lifetime, elided by LIFE-003 independently of the capture environment above. A single borrowed
    input supplies it, as in `effect fn nested(value: &Schema) -> Effect<i32>`. It gets no `'static`
    default, so `effect fn f() -> Effect<i32>` is ambiguous (SEM0210) and writes
    `Effect<'static; i32>` where that is intended.

  ```silk,ignore
  fn closed() -> Effect<i32> { return effect { return 42 } }      // Effect<'static; i32>
  fn answerExplicit(input: i32) -> Effect<i32> { ... }            // Effect<'static; i32>
  effect fn two(left: &i32, right: &i32) -> i32 { return 0 }     // environment 'left & 'right
  ```

- **Scope limits:**
  - Generic stored contents are never treated as closed. The declaration writes the environment,
    for example `effect<'env> fn`. The written environment carries the obligation that every
    captured value outlives it; calls and interface or service witnesses must satisfy it. A
    `T: 'env` bound states that obligation explicitly and is optional.
  - The default covers only the result's own environment. `fn f() -> Effect<'static; Effect<i32>>`
    gives the inner Effect none. Callables and Effects nested inside a callable contract, and
    anonymous callables, get no default.
  - Capture and lifetime checks still apply.
- **Compilers:**
  - **Native self-hosted frontend (`compiler/`):**
    - `fn closed() -> Effect<i32>`, `fn later(value: i32) -> Effect<i32>` and a function taking
      `Held<'static, i32>` all resolve to `Effect<'static; i32>`.
    - `fn f<T>(value: T) -> Effect<i32>`, `fn f(left: &i32, right: &i32) -> Effect<i32>` and
      `fn f<'a>(value: Held<'a, i32>) -> Effect<i32>` reject as `AmbiguousLifetime` at the result.
    - An `effect fn` records a `'static`, single-region or two-member environment as above,
      `'a` for a `Held<'a, i32>` input, `'static` for `once Effect<'static; A ! E>` or
      `fn<'static>(A) -> A` inputs, and the pending region for `once Effect<A>`. A stored `T`
      input rejects as `AmbiguousLifetime` at that parameter's type.
    - A representation parameter retains its contract's environment, looked up from the
      declaration's own `Represents` bounds: `F: fn<'a>(i32) -> i32` gives `'a`, and
      `F: once Effect<'static; A>` gives `'static`. An interface-bounded `T: Hash` stays unknown.
  - **TypeScript bootstrap (`packages/compiler`, from main PR #522):**
    - Implements the rules above. It reports SEM0210 at the first parameter type whose stored
      contents involve a type parameter, and at an ordinary function's result when an input
      retains something and LIFE-003 supplies no default.
    - A written environment's storage obligations are checked at direct, inherent, and interface
      or service operation calls. A witness whose Effect environment is shorter than the promised
      one is rejected. An owned operand lent to a witness by its adapter is exempt, and that
      borrow still cannot escape through the success value.
    - A witness binder that occurs only in the witness's written environment is inferred from the
      promised environment. An intersection of free binders against one promised region is
      rejected, not guessed.
  - **`Intrinsic.Detached`:** both compilers give a Detached-bounded representation parameter no
    retained region, so its contribution is `'static`, and treat a plain `T: Intrinsic.Detached`
    value parameter as unknown, like any stored generic. Native does not yet check the standard
    library, so this entry claims agreement only for the cases listed here.
  - **Shared rejection:** a parameterless `effect fn outer() -> Effect<i32>` reports SEM0210 in the
    bootstrap and `AmbiguousLifetime` in native, because its success Effect has no borrowed input
    to supply the output lifetime.
- **Source migration:**
  - Omitting an environment is the approved form where the rules above give it a value:
    - an ordinary function's Effect result whose inputs retain nothing, or that has one borrowed
      input;
    - an `effect fn` capture environment when its inputs store no generic contents other than
      representation parameters;
    - an `effect fn` success Effect's environment when a single borrowed input supplies it under
      LIFE-003.
  - Otherwise source writes it. An `effect fn` with generic stored inputs writes `effect<'env> fn`,
    optionally with `T: 'env` bounds. An `effect fn` whose success type is an Effect, with no single
    borrowed input, writes that Effect's environment, for example `Effect<'static; A>`; the
    parameterless omission is already a shared rejection.
  - **Migration done on main (PR #522):**
    - All 172 standard-library modules were checked on the host, x86_64 and aarch64 Linux, and
      wasm32 targets. The bootstrap's pre-migration SEM0210 inventory had 101 declarations: 97
      on host and Linux, plus 4 wasm-only. All are migrated.
    - Afterwards, every target's diagnostics are byte-identical to base `be390ddc`: none on host
      and Linux, 21 pre-existing on wasm32 from native-only imports.
    - Also migrated: `compiler/src/semantic/Query.silk` `demand`, the reference examples, and the
      test fixtures. The native acceptance corpus's analysis diagnostics are identical to base.
    - Receipts with provenance, recorded in task note `814eae87`: sha256
      `4c430583c4c23a5532c1cf9b403da821effc2ccef690ee7dee3c655871ddf8c7`, captured at head
      `368c3675`.
  - The explicit spelling `Effect<'static; A>` is equivalent valid syntax, not a compatibility shim.
    Source may choose it intentionally, for example to compile with the current bootstrap.
  - Do not silently redefine the rule, and do not patch a compiler, without first classifying the
    mismatch against this entry.
- **Evidence:** the `callableAndEffectSignatureContracts` case in
  `compiler/src/semantic/SemanticSignatureCases.silk` asserts:
  - `closedEffect`, `inputEffect` and `heldEffect` equal `explicitStatic`;
  - `genericEffect`, `twoBorrowEffect` and `nestedStatic` reject as `AmbiguousLifetime`, and
    `heldOpenEffect` does so spanning its written `Effect<i32>` result;
  - `effectSuccess` (`effect fn` returning `Effect<i32>`) rejects as `AmbiguousLifetime`, while
    `effectSuccessStatic` resolves with a `'static` capture environment;
  - `closedDeferred`, `inputDeferred`, `runPending` and `callbackDeferred` are `'static`;
  - `borrowedDeferred`, `heldDeferred` and `keepPending` have one region, `twoBorrowed` two, and
    `sameRegion` (the same lifetime twice) one;
  - `genericDeferred` rejects as `AmbiguousLifetime` spanning its stored type parameter;
  - `representedBorrowed` (`F: fn<'a>(i32) -> i32`) has one region, `representedStatic`
    (`F: once Effect<'static; A>`) is `'static`, and `conformedStored` (`T: Hash`) rejects as
    `AmbiguousLifetime`.

  In the bootstrap, `packages/compiler/test/DeclarationIndex.test.ts` covers environment
  elaboration and diagnostic spans, witness binder inference with its ambiguous and
  shorter-environment rejections, and lent-operand escape. `Type.test.ts` covers call
  obligations through inherent and interface operations, and `UserServices.test.ts` covers
  lowering a generic service witness that names its environment.

### Effect lowering, execution storage, `Exit`, and panic behavior

- **Status:** the first two directions below are the approved native design in
  [compiler/docs/effect-calling-convention.md](compiler/docs/effect-calling-convention.md)
  (roadmap step 5, approved by Julia on 2026-10-02). They are not implemented yet; Step 9
  implements them. The other directions remain deferred proposals. Nothing here changes the
  bootstrap.
- **Summary:** the design discussion considered several directions:
  - a target-neutral lowering boundary that turns non-suspending Effects into ordinary closures,
    provider operands, tagged outcomes, and cleanup (native step 5 design);
  - keeping coroutine lowering for suspension (native step 5 design reserves it; reached
    suspension reports the `suspension` gap until then);
  - letting source execution infrastructure choose frame storage;
  - reifying completed outcomes, and how panics and traps relate to Effect outcomes.

  None of these changes current language rules.

- **Compilers:** the bootstrap is unchanged. Its lowering, storage, and failure behavior are what
  the reference already states, including
  [FAIL-007](apps/docs/content/reference/typed-failures.md#fail-007--a-trap-is-fatal-and-remains-outside-effect-outcomes)
  for traps.
- **Source migration:** none. Do not write code that relies on these proposals.
- **Background:** the workspace design-checkpoint note "Effect architecture — design checkpoint"
  (note `201bb5aa-9e93-4b5b-ab5c-d5e4caedf259`), recorded 2026-09-26. It is a decision record, not
  an implementation plan.

### Native entry uses a generated C `main` unless the build selects a source runtime

- **Status:** temporary divergence approved by Julia on 2026-10-02
  ([compiler/docs/effect-calling-convention.md](compiler/docs/effect-calling-convention.md), D5 and
  decision Q1). Selected source runtimes are implemented natively as of 2026-10-06. The rest is
  retired when selfhost compiles `silk/native_start` as the default hosted runtime root and the
  `Entry { main }` key is deleted.
- **Rule:** [ENTRY-001](apps/docs/content/reference/program-entry.md#entry-001--runtime-source-chooses-a-visible-application-function)
  to ENTRY-003 put program entry in source. The runtime module calls the application, provides
  `HostInput`, recovers unhandled typed failures, and chooses the exit status. The compiler has no
  generated invocation adapter.
  [ARTIFACT-001](apps/docs/content/reference/artifact-roots-and-requirements.md#artifact-001--form-stage-and-runtime-are-separate)
  and ARTIFACT-002 select the runtime from the build composition and bind `Intrinsic.application`
  to the application module.
- **Compilers:** the bootstrap follows the rule through `silk/native_start`, or through the runtime
  that `[build].composition` selects. Selfhost reads the `defaults` and `runtimes` of
  `[build].composition` in the nearest `silk.toml`. One default selects that runtime module as a
  second analysis root. Its active module-level `export "C" fn` declarations are then the only
  build roots. Each one is a C ABI definition with the requested symbol that forwards
  immediate scalar and pointer lanes, including C narrow-integer extensions, to the ordinary Silk
  definition. `import Intrinsic.application` binds the application module. Two defaults, or a
  default that `runtimes` does not list, stop the build. An absent source is a `MissingModule`
  rejection at the runtime module. No default keeps the generated entry: `Entry { main }` emits
  a C `main` that calls `fn main() -> i32` directly and reports `entry-signature` for every other
  signature, including `pub effect fn main`. Compiling `native_start` needs `Execution` frames and
  the diagnostic observer intrinsics, which follow the suspension stage.

  Selfhost does not yet read profile `runtime` requests (`none` or a named runtime), composition
  `retention`, `components` or `requirements`, and it does not make exports declared outside the
  selected runtime module build roots. A Silk call to an exported definition remains the
  `foreign-export` gap. An export lane outside the immediate C subset keeps its C ABI gap. Compiling
  the bodies of `silk/native_start_sync` natively also depends on the generic Effect handler,
  provider, callable-bound and core storage work that other selfhost stages own. An `unsafe` read
  of an imported C static of scalar or pointer type loads the external object named by its linkage
  symbol; exported statics remain `ForeignStaticUnavailable`.
- **Source migration:** none. Programs whose `main` returns `i32` behave the same under both
  compilers. A `fn main` can only `run` closed Effects (EFF-006), so no unhandled typed failure
  reaches the generated `main`. The compiler package selects `silk/native_start_sync` in
  `compiler/silk.toml`. An unhandled failure from the compiler's `main` exits with status 1 and
  no diagnostic report.
- **Diagnostics and limits:** `entry-signature` is a structured backend gap, not a language error.
- **Evidence:** the native corpus runner reports `entry-signature` for each affected program.
  `SemanticLoweringCases` covers runtime C export roots, lane extensions, inactive arms, absent
  runtime sources, and manifest default selection.

### Selfhost failure reports carry origin only

- **Status:** temporary divergence, roadmap [#567](https://github.com/julia-script/silk/issues/567)
  decision Q2, designed in
  [compiler/docs/failure-observer-and-trace.md](compiler/docs/failure-observer-and-trace.md)
  (2026-10-05). It is retired row by row by that note's N7 follow-up (frames, causes, fatal traps)
  and by the suspension stage's executable-closure summary (SEM0216, SEM0217).
- **Rule:** [TERM-004](apps/docs/content/reference/program-termination-and-reporting.md#term-004--a-failure-report-has-one-stable-minimum)
  to TERM-008 and
  [FAIL-006](apps/docs/content/reference/typed-failures.md#fail-006--typed-failure-applies-ordinary-cleanup-and-preserves-diagnostic-context):
  a report under a lexical observer names the failure's identity, its origin, the logical path to
  `main`, and `while handling` causes; observed traps report a fatal line.
- **Compilers:** both compilers thread an observer and a cause through every function, drop glue
  included, once the program runs any observation, and nothing otherwise. The bootstrap builds the
  full logical trace. Selfhost lowers `observeDiagnostics` and `observeUnhandled` (note N1-N4) with
  origin-only context carried by `FailureContext`:
  - `observeUnhandled` passes handle `0`, so the hosted report prints the identity and origin, then
    `[trace truncated]`. No logical frames and no `while handling` causes are recorded.
  - Observed traps stay bare traps (no event 6).
  - SEM0216 and SEM0217 are not diagnosed; a context-free `observeUnhandled` returns `0` at run
    time, as the bootstrap's null observer does.
  - A capturing callback reports `observer-callback`; an observed `fail` of a type that is not
    nominal, primitive or unit reports `failure-identity`.
  - Selfhost infers omitted `observeDiagnostics` type arguments from the operands; the bootstrap
    requires all four (SEM0051). A fallible body or a misshapen callback is an argument type
    mismatch at that argument in both (bootstrap SEM0012).
- **Source migration:** write the four type arguments, as `silk/native_diagnostics` does. No
  corpus program reaches an observer under selfhost until `silk/native_start` compiles (Q1).
- **Diagnostics and limits:** the missing report parts are runtime presentation only; status and
  cleanup are unchanged.
- **Evidence:** `observedFailuresCarryOriginContext`, `observationsCarryContextThroughExpansions`,
  `nestedObservationsStartFresh` and `observedInstancesEmitTheContextAbi` in
  `compiler/src/semantic/SemanticCallableCases.silk`.

### Selfhost admits `Intrinsic.NonParking` bounds before the suspension stage

- **Status:** temporary divergence, Step 9e of
  [#567](https://github.com/julia-script/silk/issues/567), 2026-10-05. It is retired by the
  suspension stage or native provider lowering, whichever first lets a reached executable park.
- **Rule:** an `Intrinsic.NonParking` bound holds only when the specialized transitive graph
  cannot reach external parking.
- **Compilers:** the bootstrap proves the bound during executable analysis
  (`ExecutableOrigin.ts` NonParking obligations for `finalizeEffectNonParking` and
  `useReleaseNonParking`; `CallResolution.ts` for service operations) and rejects a finalizer or
  release whose targets are not exact or not proven. Selfhost discharges the bound at the call
  without that analysis. Any parking it would have rejected is still reached, and selfhost reports
  it as `SuspensionUnavailable` (the `suspension` gap) at the `park` or `suspendEffect` site
  (Effect note D6), not as an unsatisfied bound at the call.
- **Source migration:** none; no program that compiles under selfhost parks.
- **Diagnostics and limits:** the failure is a structured `suspension` gap at the parking site
  instead of the bootstrap's unsatisfied-property diagnostic at the bounded call.
- **Evidence:** `nonParkingFinalizersAreAdmitted` in
  `compiler/src/semantic/SemanticCaptureCases.silk`.

### Nominal qualification requires an inherent member

CALL-003 and STYLE-002 require a nominal-qualified function to be published in that type's
inherent `impl`. A top-level function whose first parameter is that type is not an inherent
member. Operator mappings follow the same ordinary lookup rule (OP-009).

The TypeScript bootstrap currently accepts the old `operator-interface-contract` fixture's
`Vector.scale` and `Vector.dot` mappings even though those functions were top-level declarations.
The native acceptance job in [run 36627847695](https://github.com/julia-script/silk/actions/runs/36627847695)
confirmed that acceptance. The self-hosted frontend correctly rejects those unpublished members.
The fixture now declares both functions in `impl Vector`, retaining its expected result of 42.
The bootstrap is frozen during backend development; retire this entry when it enforces the
same owner lookup rule.

### Borrowed operator operand inference in selfhost

- **Status:** focused native verification passed on 2026-10-07; optimized N0, actual self-build
  and integrated verification are pending.
- **Rule:** OP-009 uses ordinary interface operation contracts after operand-only selection.
  Written borrowed operands infer the operation's own lifetime parameters; fixed lifetimes,
  caller parameters, reference access and interface/provider arguments remain rigid. Expected
  results and operation obligations do not select between competing suppliers.
- **Compilers:** the bootstrap instantiates operation references and checks their operand
  contracts. Selfhost previously compared applied operation parameters by exact equality before
  inferring operation-owned lifetimes, refusing both bounded and concrete borrowed operators.
  Concrete discovery now distinguishes open runtime type/row shape from retained caller
  validity lifetimes. The native source probes each complete operand list privately, publishes
  canonical operation/ordinal bindings, applies them to the result and callable witness recipe, and proves
  instantiated bounds using actual caller premises. Unsafe operations require a lexical unsafe
  boundary. Generic type/row, static-argument and Effect operator applications remain explicit
  gaps; an operation lifetime that no operand determines also remains an explicit gap.
- **Evidence:** the existing-root actor `borrowedOperatorsInferOnlyTheirLifetimesAndProveBounds`
  asserts target and binding identities, borrowed results, caller-proven and unproved bounds,
  fixed static/access/unsafe boundaries and repeated-lifetime consistency. The new actor passed
  in 23 ms with five related/global controls passing (46 ms total); the timing guard passed.
- **Open questions:** reference operands do not yet contribute their referent's owner module to
  concrete discovery. This separate provider-bucket limitation is unchanged by operand inference.

### Struct declaration fields use whitespace separators

STRUCT-002 and GEN-002 show whitespace/newline-separated declaration fields. The TypeScript
bootstrap currently accepts commas between struct declaration fields; the self-hosted parser
previously stopped after the first field without preserving the remaining declaration.
B10 diagnoses an authored comma as `UnexpectedToken` with its exact byte span and recovers to
continue parsing fields. Struct literal initializers still use commas. The bootstrap is frozen;
its comma acceptance is an intentional recorded divergence until a separately authorized repair.
The structured parser assertion lives in `hir/LoweringCases.structFieldCommaReportsAuthoredSyntax`.

### Escaping local array loans report a type mismatch in selfhost

- **Status:** divergence recorded by the coordinator on 2026-10-02 for PR #688 (B9-S8). It is
  retired when region escape checking lands with roadmap step 14.
- **Rule:** BORROW-006 lets a borrowed array literal own hidden storage. A view of that storage
  or of a local array cannot outlive its function, and returning it reports `OWN0019`.
- **Compilers:** the bootstrap reports `OWN0019` at the escape. Selfhost types the loan with a
  caller-local region, so a `'static` result rejects it as `TypeMismatch` at the borrow span. This
  applies to `return &local` and `return &[42]` alike. Selfhost has no validity-escape code before
  step 14.
- **Source migration:** none; both compilers reject the program.
- **Diagnostics and limits:** for these direct returns, only the code differs. Other escape forms
  are step 14 scope and are not claimed here.
- **Evidence:** `sliceConversionsRetainRegionAccessAndDiagnostics` asserts `TypeMismatch` at
  `&local` and `&[42]`. The bootstrap's `RuntimeSliceOwnership.test.ts` asserts `OWN0019`.

### Selfhost test declaration diagnostics

- **Status:** recorded on 2026-10-08 with the Stage 1 census tail.
- **Rule:** [TEST-001](apps/docs/content/reference/testing.md#test-001--test-marks-a-parameterless-unit-function)
  admits a module-level, safe, non-static function with a body, no generic or value parameters and
  unit success as a test entry; [TEST-002](apps/docs/content/reference/testing.md#test-002--ordinary-builds-do-not-execute-or-retain-tests)
  analyzes an active test entry like any other function in an ordinary build.
- **Compilers:** both analyze a valid test entry as an ordinary function. The bootstrap reports an
  invalid entry as `InvalidTestDeclaration`; selfhost has no test declaration diagnostic yet and
  refuses that signature as `Unsupported`.
- **Source migration:** none.
- **Diagnostics and limits:** selfhost does not discover, describe or run tests.
- **Evidence:** `callableAndEffectSignatureContracts` in
  `compiler/src/semantic/SemanticSignatureCases.silk` checks a valid `test effect fn` signature and
  body and the refused parameterized entry.
- **Owner:** the test declaration diagnostic and discovery: #567 follow-ups.

## Maintaining this file

- Add an entry when a language change is approved that existing library or program source, or
  either compiler, does not yet follow. Also add one when the two compilers intentionally diverge
  for longer than one pull request. Put the entry in the same change that records the decision or
  first exposes the divergence.
- Update an entry's status as it is implemented and verified. Link the tests or runs, and say which
  compiler each piece of evidence covers.
- Do not record ordinary bugs, papercuts, or tooling failures here. Those go in
  [PAPERCUTS.md](PAPERCUTS.md) or an issue. Do not add an entry just because a compile error was
  surprising.
- When both compilers and the reference agree and no source migration remains, retire the entry:
  delete it, or reduce it to a one-line note in the reference's evidence.

### Native anonymous bodies retain nested lexical captures

- **Status:** intentional native support in #567 Steps 8b and 8c, 2026-10-03.
- **Rule:** every non-effect anonymous literal is its own function declaration and stores its
  ordered captures in an exact environment (functions-callables.md, CAPTURE-001;
  compiler/docs/mir-core-shape.md §7). A nested literal captures the lexical values visible in its
  immediate checked body; the enclosing literal retains any outer values that construction needs.
- **Compilers:** the bootstrap rejects an anonymous literal inside another anonymous body with
  SEM0199 because its transitive capture lifting is unimplemented. Native typing keeps both
  declaration identities, checked bodies, and capture fields. This follows the approved ordinary
  declaration/environment design; it introduces no implicit box, code pointer, or adapter. Native
  lowering constructs those environments and directly invokes their ordinary function instances.
- **Source migration:** none.
- **Evidence:** `anonymousNestedBodiesRetainTheirOwnCaptures` in
  `compiler/src/semantic/SemanticCaptureCases.silk` checks both environment capture sets through
  production body queries. Native runtime execution is not claimed by this typing test.

### Native stored-section loans retain an explicit borrow obligation

Step 8 retains each captured local reference's access and region in the exact section environment.
Native `TypedBody.borrowStatus` remains `NotChecked`; general overlapping writes while a section
holds that loan belong to roadmap Step 14. The bootstrap rejects those writes through its loan
checker. The native availability pass diagnoses moved places and consumption during an assignment
RHS; it does not claim to check outstanding loan conflicts. `genericNamedSectionsRetainMutableCaptureStorage`
asserts retained exclusive local provenance and the explicit unchecked status, alongside direct
repeated invocation and capture-only drop glue.

### Named callable values in selfhost

- **Status:** implemented with #567 Step 8d on 2026-10-04.
- **Rule:** a named function value is an exact callable environment with no captures. `typeof`
  resolves that same ordinary application, preserving complete selected arguments, visibility
  and applied bounds. Invocation calls the original function directly with its written arguments.
- **Compilers:** selfhost now uses the same canonical callable-value representation for named
  items and anonymous bodies. Only anonymous bodies receive a hidden environment parameter.
  Generic named values retain a schema when invocation inputs can supply deferred type evidence.
  Qualified namespace and inherent function values use the same construction and direct-call
  path, including a selected applied owner such as `Box<i32>.identity`. Bootstrap currently
  rejects that applied-owner value form with SEM0168 (it treats the selector as a union member),
  although the confirmed named-callable rule admits every resolved named function as a value.
  Simple qualified inherent values build and run with the bootstrap. This native extension
  retains exact owner evidence and does not add union-member or callback privilege.
  Authored `typeof` rejects still-open type or row selections as SEM0111, following REP-006 and
  the bootstrap; abstract applications inside checked generic bodies remain internal templates.
  Uninferred result-only binders, explicitly quantified public section contracts, runtime static parameters and
  enclosing owner recipes keep their existing precise gaps. Unsafe acknowledgement belongs to
  invocation, including zero-argument targets. Foreign function values remain SEM0189; callable
  values remain forbidden source static data. Opaque callable result realization and retained
  mutable callable parameter views use the separate implementations documented below.
- **Source migration:** none.
- **Evidence:** `namedFunctionValuesConstructEmptyEnvironmentsAndReturnExactTypes`,
  `genericNamedFunctionValuesSelectEachDirectInvocation` and
  `namedCallableRepresentationsKeepExactIdentity` assert construction, original-target ABI,
  independent applications, visibility, static-data exclusion and diagnostic codes/spans.
  `qualifiedFunctionValuesRetainOwnerSelectionAndDirectAbi` covers namespace and imported
  inherent values, applied-owner selections, empty construction, unsafe invocation and foreign
  callback/visibility diagnostics.

### Native direct opaque callable results retain exact environments

- **Status:** implemented and verified in #776 (CI 37208391909); opaque-callable is pinned
  after its exact-head native PASS. Plain callable result contracts use the separate origin query below.
- **Rule:** each complete ordinary producer application establishes one finite exact returned
  environment. Only its own return boundary may establish its opaque family; callers retain the
  authored contract and family identity. Runtime projection does not mutate semantic proof keys.
- **Ownership:** affine return operands use the existing consuming-place rules. Bare owners
  require `move` (OWN0003), borrowed extraction rejects as OWN0012, and expression match arms
  retain their own consumed places. Moving a computed match does not make its arms copyable.
  Operands that never complete establish no extra outer construction.
- **Compilers:** native gathers reachable return operands before solving forwarding components,
  then validates physical capture and substituted nominal-field edges before publishing storage.
  Divergence, leafless forwarding cycles, inline capture cycles and missing evidence use the
  existing SEM0113, SEM0114, SEM0115 and SEM0117 families at the complete opaque result. Invalid
  offered callable contracts use SEM0129 at the returned construction. Native retains the first
  returned construction as the related divergence site; its current single-rejection model does
  not aggregate bootstrap's multiple return sites or simultaneous realization diagnostics.
  Discovery that exceeds the existing finite node bound stays unsupported, without claiming
  an infinite specialization proof. Effect contracts retain their named Step 9 gap.
- **Remaining projection follow-ups:** contextual opaque aggregate construction and structural-union
  tag projection are covered by the later entries below. Representation-sensitive descriptor or
  phantom-metadata recursion may retain the explicit projection gap after physical inline
  validation; it is not reported as SEM0115 merely for crossing a reference. Detached/nonParking executable-property proof
  remains Effect/property work. Ordinary callable result provenance uses the
  separate origin query below.
- **Evidence:** `opaqueCallableReturnsRealizeOriginalSectionStorage`,
  `opaqueCallableReturnsRejectDivergenceAndLeaflessCycles`,
  `opaqueCallableReturnsRequireAffineTransfers` and
  `callableReturnFlowExcludesMembersWithExitingGuards` assert storage, original-target invocation,
  unreachable evidence exclusion, guard transfer and primary/related diagnostic spans.
- **Source migration:** none.

### Native callable captures retain loans of owned environments

- **Status:** repaired and verified in #777 (CI 37210948406).
- **Rule:** an exact closure, section, staged callable or opaque returned callable owns its stored
  environment. Shared and mutable capture access retain a reference to that owner. Copy captures
  still take a Copy snapshot, and moved captures still transfer the environment explicitly.
- **Compilers:** native no longer classifies exact callable representations as borrowed descriptors
  when constructing an anonymous environment. The capture field, construction operand and body
  alias all retain the same loan. Reference/slice/string descriptors and source raw callable views
  retain their existing descriptor handling; raw mutable parameter view lowering is documented
  separately above. Borrow checking obligations remain visible for Step 14.
- **Evidence:** `anonymousBorrowedCallableCapturesRetainOneCleanupOwner` checks a shared capture of
  an owned once callable: a reference field, original-place construction borrow, dereferenced body
  alias, one caller cleanup owner and cleanup-free outer capture glue. Bootstrap analysis accepts
  the fixture with no diagnostics; bootstrap executable lowering retains its pre-existing SEM0219
  gap for the plain callable-reference parameter. Exact-head native CI executes the retained
  environment, construction borrow and cleanup assertions.
- **Source migration:** none.

### Native generic captures retain finite local contents obligations

- **Status:** owned generic captures admitted for finite body use in Step 8; public escape remains
  explicitly unsupported when the stored contents have no declared validity proof.
- **Rule:** unknown stored `T` is not `'static`. A constructed closure or section retains exact
  capture types and a local Contents obligation, separate from declared premises. Reference,
  slice and callable retention stops at the stored loan or environment; invocation inputs and
  results do not constitute stored contents.
- **Compilers:** native construction permits unresolved owned contents with a `Lifetime.Local`
  environment restriction and `TypedBody.SafetyObligation.Contents`. Every callable constructor,
  including unresolved staging, rebuilds its intersection after substitution to preserve concrete
  capture regions revealed by a binding. The original local restriction remains conservatively
  retained even for a scalar substitution; this lane does not prove escaping validity.
  Applied generic contents obligations can also follow from an actual caller
  `Contents(subject, longer)` premise when the complete subject is identical and the existing
  lifetime proof establishes `longer` outlives the required region. Target obligations never
  become caller premises. This implication is implemented and locally verified on 2026-10-07;
  absent, reversed and different-subject premises retain their refusals.
  Native public callable promises and returned callable contracts report `Unsupported` at the
  value or invocation boundary when those contents remain unresolved, including callables inside
  stored aggregates. The direct public-promise bootstrap control instead reports `SEM0212` on its generic declaration for a
  `'static` promise with unbounded `T`; its complete borrow/lifetime analysis can prove additional
  finite and escaping cases. The nested aggregate control is bootstrap-admitted; native intentionally retains the explicit
  unresolved-contents gap until that proof is available. Native general borrow checking remains
  `NotChecked`.
- **Evidence:** `genericOwnedCapturesRetainLocalContentsAndSubstitutedLoans` checks the exact
  parameter, once mode, local obligation and mixed known/unknown region retention;
  `declaredPremisesProveNominalRegions` additionally checks actual selected generic applications,
  caller-owned local loans and distinct declared-region implications, with strict missing/reversed/
  wrong-subject/target-only controls. Its focused execution passed (2 tests, 0 failures, 30 ms);
  the previous native generic-local reduction now emits LLVM IR, alongside unchanged exact and
  concrete controls. This does not claim general borrow checking or an N1 executable.
  `abstractCallableStagesRetainNewlySubstitutedCaptureLoans` keeps the base abstract while revealing
  a capture loan. Direct and nested public promise controls assert native gap codes and spans.
  `genericOwnedCaptureTransfersCleanupToOriginalTarget` checks the ordinary direct target and
  transferred capture cleanup. The reduced owned program builds with bootstrap `build-exe` and
  returns 42; native assertions and timing require exact-head CI.
- **Owner:** Step 8 owns construction and direct lowering; Step 14 owns discharging local Contents
  and general borrow obligations and proving additional escaping validity.

### Native plain callable results retain original storage and public permissions

- **Status:** direct acyclic ordinary producers verified in #779 (CI 37212252807);
  selected stored/method producers and moved-once cleanup verified in #782 (CI 37212293538).
- **Rule:** a source-written callable result contract does not create a new function identity.
  Returned named values, anonymous environments and sections retain their original declaration,
  complete application and ordered captures. Producers returning the same original representation
  unify; equal public contracts alone do not make different original targets equal.
- **Compilers:** the native origin query checks the producer under its own declared premises and
  applies its complete selected application to reachable return operands. A weaker public contract
  is retained as a use view over the original storage. Exact equality compares both; runtime
  projection removes the public view before layout, cleanup and direct invocation. Staging keeps
  the public invocation permission while building the original target's supplied argument record.
  It never gains Shared permission merely because hidden storage supports reusable calls.
  Bootstrap currently accepts a reached generic `same<F>` call supplied with callable results
  from different original targets when their public contracts agree. Native preserves the
  approved exact representation identity and rejects the second argument with `RejectionCode.TypeMismatch` at
  `other()`: unconstrained `F` has already been inferred from the first argument. Equal contracts
  cannot select one direct target for two different environments. The reduced
  bootstrap control builds successfully, so this rejection is an intentional divergence.
- **Ownership:** returned affine values retain the existing explicit-transfer diagnostics and
  consumed places. Shared source promises may copy; weaker Once promises consume at their source
  use boundary. This is separate from the original physical target's environment passing mode.
- **Admission:** origin queries retain application, profile and conditional proof context. Growth
  is checked before body demands, including cached-body edges. The depth bound spans conditional
  context transitions; exhaustion stays unsupported rather than claiming infinite specialization.
- **Return-origin coverage:** finite recursive origins, higher-order selection and selected
  interface results are implemented and verified by the entries below. Leafless cycles and
  divergent exact plain origins retain their explicit rejection; they cannot invent dispatch.
  Abstract and invocation-selected higher-order results retain an original source selection recipe. Fully selected stored producer values and
  inherent receiver methods use the same original-result query and runtime ABI projection as direct
  producers. Retained mutable parameter storage loans use #783. General escape and parent-loan
  proof remain NotChecked for Step 14. These limitations are not claimed as native PASS.
- **Evidence:** `plainCallableReturnsKeepOriginalStorageAndPublicContracts`,
  `plainCallableOriginsUnifyAcrossProducers`, `plainCallableViewsKeepWeakerInvocationPermissions`
  and `plainCallableViewStagingRetainsPublicModeAndArgumentOrder` inspect original storage,
  complete relay applications, exact identity, public permission rejection and direct suffix order.
  `plainCallableResultsFromStoredProducersAndMethodsUseOriginalTargets` covers fully selected
  stored and inherent producer calls. `plainOnceCallableReturnsTransferCaptureCleanupExactlyOnce`
  checks producer/caller transfer, a moved stored-field operand, target cleanup, abandonment glue
  and OWN0003 at a bare returned affine owner. Both exact-head CI runs execute these assertions.
- **Source migration:** none.

### Native raw owned-callable return identity guard

- **Status:** bootstrap parity implemented during Step 8 on 2026-10-04 in #784;
  the final exact-head verification receipt belongs to #567 Step 8.
- **Rule:** returning a nonshared source-written callable parameter requires a known concrete
  callable identity (SEM0081). An authored constrained `F` retains its owned type identity and
  may return through the same public contract. Named values and constructed exact environments
  also retain known identity.
- **Compilers:** native classifies the original parameter owner and generated representation slot
  through its tracked function Signature. Nonfunction owners retain authored binders without
  querying a nonexistent function signature. Moved aliases and enclosing captures preserve that role; source
  syntax at the current return is not sufficient evidence. This guard follows the existing return
  transfer check: a bare affine owner first reports OWN0003 at the operand. Bootstrap can report
  OWN0003 and SEM0081 together; native retains its single primary rejection. Effect contracts
  are outside this guard and retain their Step 9 owner.
- **Evidence:** `rawOwnedCallableReturnKeepsBootstrapIdentityGuard` checks full move-expression
  spans for direct mutable/once parameters, a moved alias and a nested enclosing capture, with
  independent authored-F and known-target positives. Bootstrap Analysis reaches the four SEM0081
  sites and the bare OWN0003 site; a separate reached function-F/known-target positive reduction
  has available MIR. The nominal owner positive follows native whole-family owner premises;
  bootstrap instead rejects its constrained owner implementation head with SEM0194, as already
  documented for the nominal-domain premise difference.
- **Source migration:** use an authored constrained type parameter when the returned owner needs
  to preserve its exact callable type, or return a known construction.

### Exact callable members in native structural unions

- **Status:** implemented during Step 8 on 2026-10-04 in #785;
  the final exact-head verification receipt belongs to #567 Step 8.
- **Rule:** an exact closed callable environment is an ordinary storable structural-union member.
  Bare callable contracts and unresolved staging recipes cannot supply its runtime representation.
- **Compilers:** native admits runtime-closed callable values, schemas and use views in the existing
  tagged-union lane. Canonical ordering uses each environment's original owner and runtime encoding;
  colliding runtime identities remain unsupported. Injection, exact-member pattern binding and
  direct invocation retain the original callable type. Union glue selects only the active member
  and drops a captured environment through its ordinary exact glue.
- **Evidence:** `callableUnionMembersRetainCanonicalStorageAndDirectTargets` checks injection of
  the original empty environment, recovery/direct invocation and layout equality across reversed
  spellings. `plainOnceCallableReturnsTransferCaptureCleanupExactlyOnce` additionally inspects
  active-member cleanup for a union containing a Drop-bearing section. Independent bootstrap
  Analysis accepts the union source and a reached public-entry reduction has available MIR.
- **Source migration:** none. Opaque Effect result-family admission, including promised union
  members, retains `EffectFormUnavailable`, as the `selectedEffect() -> some<F: Effect<'static; i32>> F | i32`
  control proves. Supported closed Effect literals/compositions use the landed Step 9 implementation
  and are outside this gap. Public Effect representation joins are documented separately.

### Native higher-order callable result selection

- **Status:** merged through #788. The current integrated head `0f2a900e0` passes all 52 callable
  controls and preserves 84 corpus PASS programs with 0 FAIL in CI 37308766103. The only CI
  failure is the 2000 ms timing guard, explicitly waived by Julia with a timing follow-up.
- **Rule:** a checked invocation through an abstract callable retains its producer, public result
  contract, argument type evidence and selected invocation values/ordinals. This source recipe is
  resolved after substitution to the original returned environment before exact consumer inference.
  Selection evidence is not a physical capture. No adapter, code pointer or separate closure key is
  introduced; emitted identity still comes from the complete ordinary application and MIR graph.
- **Proof context:** only reachable return operands participate in origin normalization, under the
  producer's own applied premises. Closed source recipes are also normalized in capture fields and
  free original application arguments/scopes; opaque family identity and bound schema blueprints
  are preserved. Mutable storage views and staged schemas use the same original
  target selection and bound proof as direct invocation, retaining public permissions. Selected
  lifetime/row/type evidence participates in exact equality, substitution and unification.
  Invocation-local inference reifies supplied callable-valued operands through the ordinary
  representation binder operation, after quantified lifetime slots. Unsupplied leading operands
  keep their public section contracts; schema invocations retain original target slot mappings.
- **Bootstrap boundaries:** reduced constrained higher-order source is admitted by the bootstrap
  frontend but reaches SEM0219 when lowering the selected returned callable invocation. A generic
  stored-schema producer control is rejected with SEM0052 at its constrained `same` consumer even
  when both producers return the same original leaf. Native's source normalization is intended to
  retain exact leaf identity there; that structured native control passed in the first isolated run. No new acceptance
  corpus program is added from these bootstrap-blocked reductions.
- **Evidence:** `higherOrderCallableResultsKeepSelectedProducerAndLeafTargets`,
  `higherOrderCallableReturnsForwardOpenOriginsWithoutUnusedStorageDemands`,
  `higherOrderCallableSchemaResultsNormalizeBeforeExactInference`,
  `deferredCallableResultRetainsSelectedLifetimeEvidence`,
  `higherOrderBorrowedMutableProducersPreserveOriginalTargets` and
  `higherOrderStagedSchemaProducersRetainOriginalSelection`,
  `higherOrderAffineArgumentsAndOnceResultsHaveOneCleanupOwner` and
  `higherOrderNestedCaptureOriginsNormalizeOriginalApplicationChannels` and
  `higherOrderStagedSuffixRecipesNormalizeBeforeSchemaSelection` retain structured source/MIR claims.
  Source canonicalization includes free exact callable contracts and staged suffix evidence before
  target selection; schema bound blueprints keep their target declarations and quantifiers.
  Nested capture and staged Once controls compare the direct and higher-order construction
  through one exact-F scalar consumer. The nested control inspects actual MIR destinations;
  the Once control inspects independently recorded checked-body result types, public permissions
  and the original captured schema. Affine-result and staged-suffix controls retain MIR lowering
  and cleanup proof, avoiding a repeated backend demand for the Once source-inference claim.
  The affine reduction passes bootstrap typing/ownership and reaches SEM0219 at returned invocation;
  the owned nested-literal reduction likewise has only the bootstrap lowering boundary.
- **Source migration:** none.

### Finite recursive native callable origins

- **Status:** merged through #791; all finite-origin controls pass on current integrated head
  `0f2a900e0` in CI 37308766103. Exact whole-body replay and corpus preservation remain required;
  the current timing-only failure is recorded in compiler/docs/step8-callable-sweep.md.
- **Rule:** complete ordinary producer applications form a bounded private source graph. Reachable
  return operands provide environment equations; other checked expressions retain validation
  dependencies. Source recipes normalize before exact inference, and every selected producer
  plus its ordinary symbolic owner schema receives strict body replay before publication.
  Canonicalization preserves the immutable original request and all converging source evidence.
  Draft argument comparison examines earlier inferred assignments before locating a pending
  recipe; that temporary comparison cannot bypass the final exact replay.
  After substitution, only distinct origin-dependent node types enter the demand graph; exact
  deduplication preserves source identities. Every reachable return equation and whole-body replay
  remains required, including unused calls whose operands depend on an origin.
- **Proof boundaries:** leafless cycles remain unavailable; divergent exact environments cannot
  invent a dispatcher. Static residual bodies retain their selected-source rules. Selected interface
  projections and contextual opaque aggregate slots are covered by the later selected-interface
  and producer-construction entries. Unresolved origin recipes have no runtime storage or new
  key/MIR representation.
- **Evidence:** the nine `finiteCallableOrigins*` cases in `CallableResultCases` cover seeded
  recursion, convergence, exact replay, generic source rejection, free union/application channels,
  canonical roots and symbolic forwarding. Independent bootstrap Analysis reports SEM0037 at
  `factory()` in the invalid generic assignment control; it additionally treats represented F as
  affine at bare forwarding, unlike the documented native shared-callable Copy promise. Native
  code/span assertions and MIR inspection also pass on current integrated head `0f2a900e0`.
- **Source migration:** none.

- **Finite origin cost correction:** settled immutable source type trees share their original
  evidence during callable normalization, avoiding deep reconstruction on each solving/replay
  pass. Open recipes, views, structural unions and static-bearing callable applications remain
  on the normal path. Every producer still performs bounds checks and exact whole-body replay;
  unused dependencies and every distinct existing assertion remain unchanged. The current integrated
  Linux run executes these assertions; its remaining timing follow-up is recorded separately.

- **Direct normalization cost correction:** direct child/contract walkers use the same settled-tree
  sharing predicate as result normalization. Unions, unresolved recipes, views, stages and static-
  bearing applications retain full normalization. The suffix control reads its canonical section
  from the main call's actual MIR destination and its independent leaf from the factory's checked
  return operand, retaining the original invocation and rejection assertions while avoiding two
  redundant MIR demands. Final integrated Linux timings are recorded in compiler/docs/step8-callable-sweep.md.

### Native inferred opaque callable record fields

- **Status:** merged through #792; all record, field-dispatch and owner-role controls pass
  on current integrated head `0f2a900e0` in CI 37308766103.
- **Rule:** an inferred nominal construction retains its actual callable field types. Its own
  opaque return boundary proves each leaf contract and original parameter role; existing exact
  realization projects the public nominal result before layout and cleanup. A moved local record
  can forward another producer's family without changing either family's source identity.
- **Ownership:** generated raw Mutable/Once representation parameters cannot establish owned opaque
  leaves. Authored constrained F remains an owner. The native role guard reports SEM0081 at the
  returned constructor; bootstrap rejects these reduced raw-role constructors earlier at field
  inference (SEM0099/SEM0025), followed by SEM0117. This extends the existing native role check
  through an inferred record, without treating the bootstrap rejection as a positive.
- **Diagnostics:** invalid inferred record field bounds retain the existing native SEM0076 at
  the complete constructor; bootstrap emits SEM0106 at the field value plus SEM0117. The focused
  control asserts the native code/span, not bootstrap wording or diagnostic multiplicity.
- **Field invocation:** a present field is selected before methods and uses the ordinary callable
  checker, including pipeline invocation, access and ownership permissions. Its record expression
  is checked once. Invalid field annotations preserve their original rejection; a noncallable
  field reports SEM0075 at the complete field expression, matching the bootstrap control.
- **Projection and construction:** the opaque union entry below maps structural source ordinals
  to physical tags, including nominal fields and descriptor referents. Its symbolic owner proof
  avoids an arbitrary global type-count limit. Contextual construction opens only a producer’s
  own opaque aggregate arguments, as documented separately below; other family authority stays exact.
- **Evidence:** five `opaqueCallableRecords*` structured controls cover original named/anonymous
  fields, local forwarding, field-bound rejection, raw/authored roles, the exact record/environment/
  capture glue chain, and a descriptor-union gap. Bootstrap independently admits the positive
  records, authored-F control, repaired Drop fixture and descriptor-union source.
  `storedCallableFieldsShareInvocationAndPipelineChecking` independently covers receiver evaluation,
  pipeline dispatch and the bootstrap's exact SEM0075/SEM0001 rejection spans. All record controls, including repaired dispatch assertions,
  pass on current integrated head `0f2a900e0`.
  The earlier owner-claim control uses an explicit static environment and asserts a projected
  field `CallableCall` with no interface or named-call fallback; it retains the duplicate
  inherent-name collision rejection. Its original omitted-environment field remains a distinct
  `Unsupported` control at the complete struct declaration: member annotation resolution does
  not yet reuse the aggregate's generated field lifetime binder. That binder replay is a named
  follow-up, separate from field dispatch.
- **Source migration:** the field-dispatch positive now spells its static environment. The
  omitted-environment rejection is retained with its exact code and declaration span.

### Native callable results from selected interface operations

- **Status:** merged through #793; all selected-interface controls pass on current integrated
  head `0f2a900e0` in CI 37308766103. One original-target control takes 2000 ms; Julia waived
  this timing-only failure, and a follow-up must retain each distinct assertion.
- **Rule:** an operation returning a callable retains its original operation identity, complete
  contract/provider selection, original-owner invocation assignments, checked operand types and
  positional optional witness loans. A concrete conformance witness resolves the ordinary original
  implementation application before returned-origin selection. Source normalization and MIR share
  the same target slot and loan transport; there is no interface adapter or runtime dispatch value.
- **Lifetime evidence:** public descriptor operands cannot need owned-value witness borrowing and
  retain their existing regions without a fresh transport slot. An owned public operand may need a
  fresh loan after witness selection; its actual caller region fills the original target slot.
  Exact type equality preserves all selected/transport evidence. Only private pending returned-origin
  comparison can disregard differing transient Local loan values in two open witness recipes.
  Every original return equation remains immutable, and every closed equation is normalized with
  its own complete evidence and strictly compared before publication. Schema blueprints, binding
  owners/ordinals, rows, statics and all other lifetime evidence remain exact.
- **Bootstrap boundaries:** the two-provider and two-descriptor-return fixtures are independently
  admitted by bootstrap Analysis. The staged generic section fixture reports SEM0052 at the whole
  `apply(Factory.make(provider))`, an existing inference boundary; native acceptance is an intended
  extension. The invalid arbitrary-F assignment reports bootstrap SEM0037 at exactly
  `Factory.make(provider)` plus its existing affine-F forwarding diagnostic. Native's structured
  assignment assertion retains its existing TypeMismatch code and exact expression span.
- **Evidence:** seven `interfaceCallable*` controls cover original provider/implementation/leaf
  selection, symbolic descriptor and owned return replay, deferred section evidence, universal
  source rejection, independent loan-only source equality/substitution and optional presence, and
  original receiver-region transport through a captured MIR temporary. These assertions also pass on current integrated head `0f2a900e0`.
  Unresolved recipes never have storage or an executable key.
- **Source migration:** none.

### Native opaque structural union projection

- **Status:** merged through #797. All original mapping, root/nested selection, partial cleanup
  and immediate/latent collision controls pass on current integrated head `0f2a900e0` in
  CI 37308766103, preserving the complete parent PASS set.
- **Rule:** original source member ordinals are retained in typed injection, root/nested patterns
  and payload paths. A complete injective source-to-canonical-storage map selects every physical
  tag and payload type; cleanup remainder paths use the same map before exact glue selection.
  No new executable key, adapter or pointer representation is introduced.
- **Owned return boundary:** a bare original leaf may inject into its producer's outer opaque union
  only after contract, role and transfer proof. Evidence is collected from the original payload,
  not from its own injected envelope. Nested nominal fields and descriptor referents must already
  have their complete source storage shape. This root-only rule rejects a bare leaf under a nested
  promised union at the whole returned constructor (native ReturnTypeMismatch); bootstrap rejects
  the reduced nominal constructor with SEM0117/SEM0129 and a descriptor-bare header with SEM0117.
- **Carried ABI proof:** ordinary generic substitution precedes global validation, so T | i32 with
  T=i32 may become i32 when no source tag operation is present. Representation projection must
  preserve distinct union storage even when only a descriptor carries it. The proof follows fields
  and referents; growing nominal recurrences are summarized through a finite graph of symbolic
  authored owners before substitution can erase a latent union. Union-free or representation-
  insensitive recurrences are admitted. A recurrence with both union and representation-changing
  potential reports the existing union-form gap until uniform symbolic mapping is implemented.
  This is a conservative named follow-up, not a proof that every such program has incompatible ABI.
- **Evidence:** existing descriptor storage, complete reordered/colliding maps, original root-return
  injection, ordinary generic alias collapse, union-free growing pointer storage, and descriptor-only
  immediate/latent collision controls are source-written structured assertions. The new storage
  fixtures independently pass bootstrap Analysis and the current native assertion run.
  A root-match control independently derives its scalar physical tag from the original call
  destination and checks both switch routing and the recovered payload type. A nested-test control
  derives its nominal tag from the concrete definition parameter and checks the selector and full
  payload type. A partial-move control follows only the selected record arm: it requires the first
  field's Move into the original consumer, exactly one remaining second-field cleanup, no ancestor
  cleanup on that path, and exact glue identity from an independent type query. All three controls pass in the current native assertion run.
- **Nested-pattern bootstrap boundary:** the bootstrap rejects literal nested structural member
  patterns even for the pre-existing ordinary `Narrow | Wide` control. Its nested pattern checker
  compares the entire field union against the selected member instead of supplying expected
  context. The callable reduction reports SEM0042 at `Marker { value }` and downstream SEM0043
  at `_ => 42`. Native deliberately retains its existing structural member-pattern semantics;
  the new control extends that same semantic path to substituted callable members. The separate
  partial-move fixture is independently admitted by bootstrap Analysis without diagnostics.
  The immediate descriptor-collision fixture now writes `return move value`: bootstrap accepts
  the implicit and explicit forms, while native currently rejects the implicit nominal transport
  with `ExplicitMoveRequired` on `value`. This is a remaining ownership parity boundary, not an
  incompatible union-layout proof. The explicit form reaches the intended carried-union gap.
  Unchanged nominal descriptor identities do not demand unrelated field shapes: this guard proves
  ABI changes through projected nominal arguments. Fixed field-embedded opaque recipes beyond
  those arguments require separate discovery before admission; they are not covered by this proof.
- **Source migration:** none.

### Native callable parameters in ordinary anonymous declarations

- **Status:** merged through #801. All five anonymous-parameter controls, including the
  repaired SEM0212 retained-environment rejection, pass in CI 37308603747 at `8c851ec46`
  and again on current integrated head `0f2a900e0` in CI 37308766103. The integrated corpus
  reports 84 PASS, 0 FAIL, 309 Unsupported, track 70; all prior PASS names are preserved.
- **Rule:** an anonymous invocation uses the existing CallableSchema blueprint and ordinary
  Function application. Selected enclosing bindings remain free construction evidence; own
  invocation representation and lifetime slots remain bound until use. Only lexical captures form
  its environment. Staging stores that environment once, then appends supplied operands under their
  original parameter ordinals. No function pointer, adapter, closure key, or new MIR variant is used.
- **Ownership:** a raw Once or Mutable callable parameter retains the bootstrap SEM0081 role
  when returned from an anonymous body. An outer authored F retains its authored owner and can be
  forwarded. Elided invocation lifetimes accept caller evidence; a fixed Static contract rejects
  unsuitable evidence with SEM0212 at the supplied operand. A matching signature whose retained
  environment cannot outlive the promised one keeps this lifetime diagnostic; hidden plain-callable
  representation inference does not rewrite it into a shape error. Authored generic inference keeps
  its call-level diagnostic. Invocation-variance and Effect lifetime parity are separate lanes;
  this correction does not change them. General borrow safety remains Step 14.
- **Boundary:** anonymous invocation schemas retain their original lifetime-to-declaration map.
  Ordinary named sections now use that same map when still-unsupplied operands can infer the
  invocation lifetime, including staged sections and independent caller loans. Effect-valued
  targets with deferred invocation lifetimes retain their separate source-recipe boundary; generic
  requirement rows now defer through the upstream Step 10 section recipe. The guard
  inspects substituted result representations, union members, and target/caller contract premises;
  an Effect hidden behind a generic result cannot enter the ordinary section lane. Explicitly
  quantified public section contracts retain their existing gap. General borrow checking remains
  Step 14; accepting caller lifetime evidence does not certify loan conflicts or escaping loans.
- **Bootstrap lowering:** the focused positive probes pass bootstrap frontend analysis, but its
  build-exe backend cannot resolve the anonymous higher-order targets (the two-stage case reaches
  SEM0219). Native direct invocation deliberately implements the approved MIR design. These reduced
  programs are structured controls rather than new corpus fixtures until the main-first bootstrap
  build-exe boundary is repaired.
- **Source migration:** none.

### Contextual opaque callable aggregate results

- **Status:** merged through #802. All four contextual aggregate controls pass on exact
  head `0f2a900e0` in CI 37308766103: record/tuple storage, nested fixed arguments and order,
  contract/family proof, and assignment authority. The corpus remains 84 PASS, 0 FAIL,
  309 Unsupported, track 70 with no lost PASS. Timing-only failure is separately waived.
- **Rule:** a producer returning `some<F: fn(...)> Wrap<F>` may establish its own exact family
  through a contextual `.{ ... }` or tuple literal. The original nominal blueprint supplies field
  shape and fixed arguments; inference opens only this producer's opaque arguments. Nested literals
  receive construction permission from that blueprint. Explicit child constructors keep ordinary
  inference. Contract and repeated-family proof occur before publishing the concrete result.
- **Authority:** construction permission is explicit and local to the producer's return literal.
  Ordinary assignment, initialization and call arguments cannot use it to replace an exact family.
  Deriving Effect blocks continue to infer their return channels without an expected context.
- **Compilers:** bootstrap frontend currently treats the contextual opaque argument as fixed and
  rejects these record/tuple reductions (SEM0117 with SEM0104 or SEM0025 at the field). Explicit
  named construction is admitted. Native deliberately implements the approved exact environment
  design; reduced sources stay structured controls until bootstrap build-exe admits corpus fixtures.
- **Diagnostics:** wrong callback contracts retain `IncompatibleCallableSignature` at the complete
  literal; differing original callable families for a repeated opaque slot retain
  `DivergentOpaqueRealization` at the opaque result annotation. Ordinary assignment rejects the
  incompatible callback operand with `TypeMismatch`. No adapter, runtime code pointer, new instance
  key or MIR variant is introduced. General borrow obligations remain Step 14.
- **Source migration:** none.

### Native named sections with deferred invocation lifetimes

- **Status:** implemented on the Step 8 branch; native exact-head assertions and corpus verification
  remain pending corrected-head CI. At the first head, the reduced native program builds and returns
  74, all Effect boundary controls pass, and the positive assertion exposed an incorrect expected
  lifetime origin. The corrected assertion uses the enclosing call region, retaining the written
  Borrow source identity. Bootstrap build-exe admits the same ordinary reduced staged section.
- **Rule:** a named section can defer its original lifetime slot when an unsupplied operand carries
  the evidence. Each invocation opens a fresh inference owner, restores the selected lifetime to
  the original target ordinal, and directly calls that target. Captures append in construction
  order; invocation uses their original parameter ordinals. No adapter, pointer, MIR variant, or
  alternate emitted-identity path is introduced.
- **Evidence:** `namedLifetimeSectionsSelectOriginalTargetAtInvocation` checks two distinct source
  Borrow arguments and their typed caller/call-site regions, original application slot 0, two direct target
  calls, and stored suffix projection order 1/0. `namedLifetimeSectionsKeepEffectProviderBoundary`
  asserts Unsupported codes and exact spans for opaque, selected, union-member and caller-bound
  Effect result sections. Bootstrap currently reports SEM0052 on the selected generic Effect
  section controls; native retains its Unsupported provider-recipe boundary until Step 9 supplies
  that recipe, rather than admitting a partially inferred Effect construction.
- **Quantified contextual admission:** source implementation now opens outer promised invocation
  parameters, result and lifetime premises under a separate rigid owner. Only offered target slots
  infer; caller and promised premises must prove applied target obligations. A private comparison
  view re-closes direct deferred lifetime bindings through their original target ordinals. Selected
  evidence, actual schema and capture storage remain unchanged. Fixed lifetimes, mode, unsafe
  authority, exclusive content and callable environments retain ordinary contract proof. Nested
  invocation quantifiers and deferred type/row bindings embedding private rigids retain explicit
  `Unsupported` boundaries; explicitly quantified public section contracts and Effect-valued
  lifetime deferral remain separate gaps.
- **Quantified structural controls:** `quantifiedNamedCallbacksRetainTheirInvocationRecipes` in
  `CallableResultCases` demands concrete consumers and original callbacks, checks two independent
  invocation loans, original lifetime slots 0 and 1, and staged capture inputs/projections.
  Each original target call must use the distinct MIR local created at its corresponding source
  Borrow origin, so duplicated first-loan wiring cannot satisfy the structural proof.
  A mixed target contrasts selected type slot 0 with deferred lifetime slot 1 and promised
  invocation ordinal 0; once transport retains shared actual storage through concrete MIR.
  Its source-written negatives distinguish fixed Static, unproved/reversed bounds, exclusive
  content and fixed inner-lifetime preservation, unsafe authority, once storage, retained environments,
  and embedded proof rigids. Missing or reversed invocation premises retain the existing
  `Unsupported` result from bound proof; these cases are not admitted. The named-result control in
  `callableParameterKeepsInvocationRigidsAndBorrowedOwnersOutOfInference` preserves the outer
  inferred-result escape boundary and a cheap unused nested-metadata quantifier barrier. Source
  canonicalization still erases unused authored binders. Existing authored nested-quantifier
  rejection remains in `invalidWrittenSignatureContracts`; quantified comparison additionally
  refuses independently bound nested metadata. These controls do not establish a complete
  higher-rank inference solver, integrated corpus success or native self-build success.
- **Source migration:** none.

### Public generic bounds under caller-local specialization

- **Rule:** VIS-004 checks the authored public contract. A caller may instantiate its generic
  parameters with private types without publishing those types.
- **Compilers:** native callable and interface bounds use the same authored-contract visibility
  policy as parameters and results. The unspecialized signature still rejects an explicitly
  named private type; supplied own or enclosing arguments do not create a new public declaration.
- **Evidence:** `rejectsPrivateExposureAndCollisions` covers a public inherent callback bound
  specialized with a private enclosing type and retains exact authored-private-bound refusals.
  Quantified admission exposed the previously masked `HashMap.withMut` bound check during N1.
  This correction does not establish native self-build success.
- **Source migration:** none.

## Explicit synchronous source startup

The bootstrap can select `silk/native_start_sync` through ordinary runtime composition for an i32
Effect requiring shared or mutable `HostInput`. It captures an owned argument/environment snapshot, lends a
lexical provider, returns successful status unchanged, and drops typed initialization or application
failures before returning one. It installs no Execution or diagnostic observer. The default
`silk/native_start` and its broader application signatures retain their existing behavior.

This source addition does not remove the self-hosted compiler's generated plain-i32 entry or claim
native source-runtime support. Ordinary plain-i32 adaptation belongs to
[#931](https://github.com/julia-script/silk/issues/931); native routing and adapter removal follow
main-first integration of both contracts. See
[the source startup contract](compiler/docs/source-synchronous-startup.md) for selection, ownership,
and validation details. Fatal traps retain their existing behavior and do not promise cleanup.

### Native body-annotation lifetime elision by equality

Under LIFE-003 a body annotation infers the lifetimes it omits from its uses. The bootstrap gives
each one a body-scoped region and solves the body's outlives constraints. Native infers each one
by equality with the value the annotation describes: a pattern annotation or variant qualifier
from the subject it matches, a binding annotation from its initializer, and a written constructor
qualifier from its operands or a same-owner expectation. Every written part must still agree
exactly, so a conflicting explicit lifetime, a different owner, referent or access, and any other
mismatching argument keep `TypeMismatch`.

Equality is stricter than the bootstrap's region solve in two ways. A binding annotation that
elides a lifetime checks its initializer without contextual expectation, so a context-typed
initializer such as `&[1, 2]` for `&[u8]` is refused; and the binding keeps its initializer's
exact region, so a later assignment with a different nonlocal lifetime is refused. Ordinary
call-site generic arguments now infer omitted lifetimes in private invocation slots.
The actual operands or expected result must close every omitted slot before the compiler publishes
the selected application. Original target owners and sparse binder ordinals remain unchanged;
private slots never become target arguments or receive default `'static` evidence. A result-only
omission without evidence and an unresolved partial call retain `body-lifetime-elision`.
Qualified owner applications, generic interface-operation prefixes, and a constructor whose
elided lifetime is reached only through an alias remain separate unsupported lanes.

### Native typing retains unproven caller-local region relations

- **Status:** implemented on 2026-10-06 for the self-build workstream; native borrow checking
  (roadmap step 14) retires it.
- **Rule:** lifetimes are covariant in reference, slice and `string` regions, shared referents,
  array elements and covariant nominal storage (bootstrap `NominalVariance`). A `'static` region
  shortens to any region, and a lifetime of the declaration enclosing a body outlives every loan
  rooted in that body.
- **Compilers:** the bootstrap admits these subtypes and proves every region relation in its borrow
  checker. Native typing admits a `'static` region at a shorter expected or binder-fixed region as a
  proven subtype, for example `return b"zero"` at an elided input region, `""` at `string<'text>`,
  or by-value nominal storage at an inferred caller-local call lifetime. When a caller-local region
  meets another region that typing cannot relate (a declared lifetime, another caller-local region,
  or a region an earlier operand fixed for the same binder, including a `'static` Effect
  environment such as `Effect.provideMut(program(), &mut allocator)`), native admits the value at the
  expected region and the body keeps a `RegionRelation` safety obligation with the origin and both
  regions. Native fixes an inferred binder by its first evidence and shortens it when a later
  operand offers another region for a binder every parameter stores covariantly: to that region
  over `'static`, otherwise to the complete meet of both, as in `pair(left, right)` for
  `pair<'a>(&'a i32, &'a i32)`, including an `effect fn` environment binder. An inferred struct
  literal binder that the declaration stores covariantly shortens the same way at a later field,
  as in `Scoped {count: &mut count.*, view: view}` (added 2026-10-08). A `T: 'binder` bound
  that the binder's evidence does not cover shortens a covariant inferred binder to the meet of the
  regions `T` retains, so `Effect.useReleaseNonParking` with a borrowing resource and a capture-free
  callback no longer fixes `'env` to `'static`; an invariant or written binder never moves. The bootstrap solves for the shortest region directly, so a binder
  an earlier operand fixed to `'static` also relates a later loan of a declared lifetime, as in `Effect.provide<Clock>(work(), clock)` for a parameter `clock`. The
  relations a call's operands retain are outlives premises of that call's own bound proofs, so
  `program() |> Effect.provideMut<Allocator>(&mut allocator)` piped into a second provision section
  proves its representation bound once. Such bodies are `ContractTyped` and counted by the
  `SILK_GAP borrow-check` summary, so a program the bootstrap would reject for that relation still
  compiles natively until step 14.
- **Source migration:** none.
- **Diagnostics and limits:** a fixed `'static` expectation of a shorter region, a declared region
  widened to another, and owner, access, element, pointee, extent, type-argument and
  requirement-row differences keep `TypeMismatch`. An explicitly written lifetime slot is never
  shortened or widened, but an operand meets it by the same covariant subtyping. Native call arguments
  still unify exactly apart from shared-loan shortening and this binder-region relation.
- **Evidence:** `expectedBoundariesAdmitCovariantRegions`,
  `staticStringSubtypingPreservesOrdinaryMismatches`,
  `nominalRegionShorteningPreservesExactTypesAndFixedEvidence` and
  `callerLocalRegionsRelateAtFixedBoundaries` in
  `compiler/src/semantic/SemanticCallableCases.silk`, `providedCallPrefixesMapLifetimesSeparately`
  in `compiler/src/semantic/SemanticLoweringCases.silk`,
  `sliceConversionsRetainRegionAccessAndDiagnostics` in
  `compiler/src/semantic/SemanticCaptureCases.silk`, and `effectSectionDeferralClaims` in
  `compiler/src/semantic/CallableResultCases.silk`.

### Native scalar enum consuming matches

- **Status:** implemented; production check and five focused native controls pass on macOS/aarch64.
- **Rule:** a scalar enum remains a sealed Copy value without cleanup. A bare match copies its
  subject; `match move` records Consume access and the subject's owned local or projection, or no
  place for a fresh value. It uses the same extraction proof as a record or union consuming match.
  A Drop-hooked ancestor still prevents extraction of its enum field and reports
  `ExtractionBoundary` at the complete match. Copy classification does not bypass that proof.
- **Compilers:** the bootstrap already admits consuming scalar enum matches. Native now uses its
  existing scalar switch/guard lowering rather than refusing the ownership mode. Shared and
  mutable scalar enum matches retain their separate `Unsupported` boundary. Native ownership
  checking remains the Step 14 follow-up; this change records consumption and preserves extraction
  diagnostics without claiming a complete use-after-move check.
- **Evidence:** `scalarEnumsLowerMembersValuesAndSwitches` asserts consumed parameter/field
  coordinates, a fresh subject with no place, bare Copy access, guarded switch structure, no drop
  statements/glue/flags and the Drop-ancestor rejection. The actor passes in 23 ms; all five
  focused native controls pass in 104 ms. Linux and optimized N1 outcomes remain separate CI evidence.
- **Source migration:** none.

### Native unconsumed Effect and callable arguments

- **Status:** native gap; retires when native lowers a non-consuming by-value Effect argument.
- **Compilers:** the bootstrap consumes an Effect or callable argument only when its run access is
  `once` (`argumentConsumes`), and derives a composition's access from its retained environment
  (COMPOSE-001), so a let-bound `runCases(&headers) |> Effect.provideMut<Allocator>(&mut allocator)`
  may be passed by value without `move`, as in `run Effect.catchAll(program, recover)`. Native types
  an invoked section's Effect at the access its generic contract proves conservatively. It reports
  such an argument, and any shared- or mutable-access one, as unsupported (the `typed-form` gap)
  instead of `ExplicitMoveRequired`, which it keeps for an exact `once` value, a reference to a
  callable, and every return.
- **Evidence:** `plainCallableAffineArgumentClaims` in
  `compiler/src/semantic/SemanticCallableCases.silk` and `effectSectionDeferralClaims` in
  `compiler/src/semantic/CallableResultCases.silk`.

### Native member bodies without implementation head bounds

- **Status:** native gap; retires when native checks an implementation member's body under its
  implementation head's bounds.
- **Compilers:** the bootstrap checks `impl<T: Printable> Printable for Box<T>` members with
  `T: Printable` as a premise, so `value.value.print()` selects the bound operation. Native member
  bodies receive only the member signature's bounds, so a receiver call on such an enclosing type
  parameter finds no supplier. Native reports it as unsupported (the `typed-form` gap) instead of
  `UnknownMember`, which it keeps for a function's own unbounded type parameter.
- **Evidence:** `receiverSuppliersTieBeforeArgumentsOrResult` in
  `compiler/src/semantic/SemanticSignatureCases.silk`.

### Native service operations with a `Self` operand

- **Status:** native gap; retires when native dispatches such an operation on its operand.
- **Compilers:** the bootstrap dispatches `SchemaService.decode(value)` for
  `service SchemaService { fn decode(value: &Self) -> i32 }` on the operand's conformance, as for an
  interface. Native serves a service operation from the run site's requirement row with no provider
  operand, so it reports a call of an operation whose parameters mention `Self` as unsupported (the
  `typed-form` gap) instead of a `TypeMismatch` at the operand.
- **Evidence:** `receiverSuppliersTieBeforeArgumentsOrResult` in
  `compiler/src/semantic/SemanticSignatureCases.silk`.


### Finite scalar StaticSequence iteration in the native frontend

- **Definition:** Confirmed STATIC-009/STATIC-010 retain immutable phase-only sealed sequences, fresh ordered iteration scopes, exact element types, empty-body non-elaboration and atomic selected-body publication. Ordinary arrays are not static iterables.
- **Native subset:** focused locally verified on 2026-10-07. The genuine sealed `Intrinsic.StaticSequence<Element>` nominal and immutable admitted sequence value support empty/append and homogeneous complete scalar elements. Mixed selection retains a separate context per original for+ordinal; ordinary elaboration emits sequential blocks with distinct local/node ranges and authored spans. One evaluator and residual budget cover the whole expansion. Phase-only sequences/descriptors cannot occur in runtime contracts or stored member types.
- **Remaining native boundaries:** concat/length/at keep explicit Unsupported; reflected collections, nested static-for, generated closures/Effects, authored return/fail/break/continue inside iterations and newly generated loans remain unsupported. Existing outside loans and ordinary scalar reads are retained. No HIR cloning, static lifetime default, runtime iterator, library spelling privilege, or language-definition change is introduced.
- **Evidence:** the pre-repair optimized native reduction rejected the whole static-for as typed-form; the no-loop phase control rejected the sealed sequence type as core-type. The focused existing-actor run passed five tests in 50 ms, including distinct iteration locals, exact selected callee/MIR arguments, empty-body non-elaboration, borrowed outside storage and exact refusal codes/spans. Its timing gate passed; production pinned-bootstrap checking also passed. After integrating canonical finite lifetime meets, the same five focused tests passed in 8 ms on 2026-10-08. Sealed static sequences participate in the complete numbering transaction, including retained types and charged child traversal. This entry claims no optimized N0, SHA2 lowering, gap removal, N1 artifact or smoke success.

### Selfhost preserves unchanged inexact capture-loop availability

- **Status:** locally verified on 2026-10-07.
- **Rule:** LOOP-001 requires preservation of the incoming ownership facts on repeating paths. A pre-existing may/must distinction does not imply that an unrelated loop changes those facts.
- **Compilers:** selfhost compares active roots, separate may/must holes, uncertain roots and guard state after normal/continue arrivals. It preserves every may-hole and rejects acquisitions of maybe-missing storage. Conditions still run after copying the header; break and false-condition exits retain their actual post-condition state. Transfer history remains RHS/diagnostic evidence rather than a loop invariant.
- **Indexed writes:** replacing an element in a fully initialized owned array preserves its availability. A runtime-index write adds uncertainty only when that root already has a may-hole, including a hole introduced while evaluating the assignment's RHS. It never clears existing holes or uncertainty.
- **Indexed evidence:** the checked-body array-write/capture positive and exact whole-loop RHS-transfer negative passed in the four-test focused run on 2026-10-07: 54 ms total, maximum 30 ms, timing gate passed. All prior loop and guard controls remain. The integrated run on d7ac31b restored p256-key-agreement; the N1 inference failure remains.
- **Evidence:** `anonymousCapturesKeepLoopAndIndexedProofs` retains changed-header/indexed negatives and adds unchanged-inexact, consume/refill/continue, later-acquisition, unknown-index and consuming-condition controls. The focused run passed four tests in 40 ms (maximum 28 ms), including these exact diagnostic controls and the retained guard actors; its timing gate passed. Original N1 buildFrom state and advancement remain unproved.

### Native canonical finite lifetime meets

- **Rule:** LIFE-004's common validity is a canonical finite meet. Flatten nested meets, remove
  static and duplicate atoms, retain the complete meet in lifetime arguments, and keep identity
  independent of ambient bounds. Public substitution is simultaneous; inference follows only
  explicitly permitted owners and refuses seeded cycles with complete rollback. Meet outlives
  proof uses actual caller premises and the ordinary meet rules, never manufactured Contents or
  a chosen constituent.
- **Native source:** Lifetime, Type and Semantic now carry complete meets through environment
  inference, scoped applications and validity proof. Whole-domain caller-region numbering replaces
  the former streaming scalar representation. Canonical key construction is fallible under the
  structural limits documented in `compiler/README.md`; refusals are source-neutral in generated
  caches and become `Unsupported` at the genuine requesting origin. Runtime lifetime erasure and
  provider order are unchanged. The pinned bootstrap production check passes on the isolated
  feature snapshot. Parent-integrated focused execution passed all 19 tests in 44 ms on
  2026-10-07, including complete caller graphs, transactional inference, and retained-result
  cleanup. The parameter-to-local solver avoids a nested borrow of the same Shared allocation.
  Integrated CI and N1 self-build remain unproved.

### Invocation-scoped callable inputs and recovery

- **Definition:** LIFE-004 now distinguishes marked `for<use 'call>` invocation extents from independently quantified data lifetimes and retained capture environments. Input validity covers returned-computation execution, suspension, cancellation and cleanup; retained computations cannot escape those loans. `Effect.result` gains no retained-error bound.
- **Bootstrap:** implementation active. `Effect.result` retains its unrestricted error contract. The two selected borrowed-recovery native corpus cases pass their exact synchronous cleanup and park/resume/cancel traces (`7231` and `75842175421`, both returning `42`). Source-owned executable input views preserve the actual closure and independently authenticate the original caller domain and complete invocation inputs. Immutable stored Identifier, ordinary staged and anonymous adaptation retain independently held original producer/input provenance. The four selected stored/staged borrowed-recovery variants also pass; these focused runtime passes do not establish the complete feature, native lifetime safety or N1.
- **Native:** marker parsed, represented and checked. The parser accepts the contextual `use` only in a callable's outer `for` list; HIR lowering records it on the lifetime parameter, and `Type.Callable` carries the marked binder's canonical ordinal as contract identity (an unused marker vanishes with its binder). A second marker or authored bounds on the marked binder reject as `InvalidLifetime`. Opening a marked contract at a call adds `input: 'call` obligations for every opened input; a contextually checked callback and a callable compared against a marked promise receive the same conditions as premises, and a marked source requires a marked target at the same binder. Effect, `Effect.result` and the `'call & 'env` meets use the existing canonical-meet machinery. Executable input views, stored/staged adaptation provenance and the bootstrap's runtime recovery traces remain unimplemented natively. Strict census on the merged change: HP 42 to 33, UnknownMember 17 to 4 (`effect.silk` resolves again); the remaining `useReleaseNonParking` callers keep their pre-sync refusals. Integrated CI and N1 remain unproved.
