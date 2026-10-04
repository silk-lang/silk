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
scalar, reference, record and sequence forms through demanded MIR and LLVM text. It emits a
`SILK_GAP borrow-check` summary when reached bodies retain safety obligations. Field/index
projections now use neutral record/sequence layouts in backend roadmap step 4. Runtime slice
descriptors and checked element places use the same internal aggregate slots; subrange primitives
remain a named `intrinsic-member` gap. A repeated inferred shared-slice lifetime with distinct
actual Local regions of the same caller requires the deferred common-validity proof and reports
`slice-region-relation`; this does not admit fixed Static, incompatible access/element, or foreign
owner evidence. That gap exits through the later checked caller-region/outlives stage. Immediate raw
pointer weakening removes mutation capability and adds nullability, preserving invariant
pointee/extent and identical other qualifiers; it does not implement reverse access, nested pointee
covariance, alignment weakening, or other qualifier conversions. Ownership, lifetime, and cleanup
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
- **Evidence:** in `compiler/src/semantic/SemanticCases.silk`, `selectedTypeSelectionReadsReflectedKinds`
  covers the two-type static selection, `reflectedKindCodesMatchTheLibrary` covers both kind codes
  and the unsupported owner, and `reflectedDescriptorsStayOutOfRuntimeCode` covers each runtime
  boundary. The shared corpus program `static-type-selection` exercises the bootstrap natively.
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
- **Evidence:** in `compiler/src/semantic/SemanticCases.silk`, `moduleArmsSelectNativeDeclarations`,
  `conditionOrderSelectNativeAnswers` (both demand orders in fresh stores) and
  `mixedConditionalNameSelectNativeBoundary`.
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
  `compiler/src/semantic/SemanticCases.silk`.

### Selfhost reports cleanup it cannot lower yet as the `cleanup` gap

- **Status:** narrowed on 2026-10-03 by Step 6c, which lowers drops at every scope exit, and by
  Step 6d, which lowers partial moves, and Step 7, which substitutes complete generic nominal
  instance payloads before selecting and building drop glue.
- **Rule:** an owned value whose type carries `impl Drop` in its owned structure is cleaned when it
  leaves scope without being moved.
- **Compilers:** both lower drops, replacement drops, drop flags and partial moves. Selfhost still
  reports the backend gap `cleanup` instead of lowering a partially moved owner whose holes differ
  between joining paths or that is moved on only some paths, a write at a runtime index beside a
  moved element, a loop iteration that leaves an owner in a different state than it found it, a
  guard that changes an owner's state, a borrowing match result whose arm created temporaries, and
  drop glue for callable and Effect environments and unions without a canonical member order.
- **Source migration:** none.
- **Evidence:** `cleanupStackDropsWhatEachExitLeaves`, `cleanupFollowsLoopsAndConditionalPaths`,
  `partialMovesDropTheRemainingChildren` and `dropGlueCleansHookThenChildren` in
  `compiler/src/semantic/SemanticCases.silk` cover the lowered forms and the holes, runtime-index,
  guard and loop gaps. Not checked by a test: a partially moved owner moved on only some paths, the
  borrowing match result gap, which current typing cannot reach because it borrows only places and
  Drop-free array literals, and the deferred glue forms.

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
  `compiler/src/semantic/SemanticCases.silk`.

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
  all four source controls execute successfully. Linux cost and final integrated-head execution
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
  their remaining callable availability and lowering work belongs to Step 8, not generic records.
- **Open questions:** whether the bootstrap should narrow OWN0008 to provisional bindings, or the
  reference should widen it, before extending selfhost's general guard ownership checking.

### Plain mutable callable parameter forwarding in selfhost

- **Status:** temporary native view lowering implemented on 2026-10-04; exact native CI pending.
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
  validity obligations remain honestly NotChecked for Step 14; raw owned-callable return
  diagnostics and remaining callable-bearing storage are still required Step 8 work.

### Unary callable pipelines in selfhost

- **Status:** PIPE-001 conformance implemented during Step 8d; verification pending exact-head CI.
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
- **Rule:** construction may defer target binders mentioned by remaining parameters. Unused or
  result-only unresolved binders report `SEM0052` at the construction call. Each invocation solves
  independently; immutable construction evidence keeps its original binder ordinal.
- **Compilers:** selfhost opens a generic section's target binders for each concrete callable
  promise, proves its target bounds, and preserves the shared blueprint. A later operand may first
  fix a consumer's type parameter. MIR selects the target from closed invocation operands rather
  than the comparison contract. Direct staging over a schema appends captures and selects any new
  evidence supplied at that stage. Staging through an abstract callable parameter normalizes its
  closed schema recipe before MIR, preserving the original target blueprint and exact capture
  record. Storage mode follows the actual base and newly stored fields; source promises still
  determine consuming transport. Quantified contextual promises and sections requiring deferred lifetime/row binders, enclosing
  scope or static evidence. Bootstrap rejects some closed contextual forwarding of a stored generic
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

### Reached Effect literals in selfhost

- **Status:** deferred to #567 Step 9; named during the Step 8 corpus sweep on 2026-10-03.
- **Rule:** Effect blocks and anonymous `effect fn` values retain their indexed EffectBlock
  identity. Constructing their executable environments requires Effect lowering.
- **Compilers:** bootstrap lowers these values. Selfhost reports `effect-instance` when runtime
  typing reaches either literal, at the literal's span. It does not treat an anonymous effect
  function as an ordinary closure when the value is stored without being invoked.
- **Evidence:** `reachedEffectLiteralsKeepPreciseStepNineGap` checks both literal kinds and their
  gap spans, alongside an ordinary closure that still lowers successfully.
- **Owner:** #567 Step 9. Earlier unrelated gaps may still block an enclosing program first.

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
  `compiler/src/semantic/SemanticCases.silk` asserts:
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

### Native entry uses a generated C `main` until it compiles the source runtime

- **Status:** temporary divergence approved by Julia on 2026-10-02
  ([compiler/docs/effect-calling-convention.md](compiler/docs/effect-calling-convention.md), D5 and
  decision Q1). It is retired when selfhost compiles `silk/native_start` as the runtime root and
  the `Entry { main }` key is deleted.
- **Rule:** [ENTRY-001](apps/docs/content/reference/program-entry.md#entry-001--runtime-source-chooses-a-visible-application-function)
  to ENTRY-003 put program entry in source. The runtime module calls the application, provides
  `HostInput`, recovers unhandled typed failures, and chooses the exit status. The compiler has no
  generated invocation adapter.
- **Compilers:** the bootstrap follows the rule through `silk/native_start`. Selfhost's
  `Entry { main }` key emits a C `main` that calls `fn main() -> i32` directly and reports
  `entry-signature` for every other signature, including `pub effect fn main`. Compiling
  `native_start` needs `Execution` frames and the diagnostic observer intrinsics, which follow the
  suspension stage.
- **Source migration:** none. Programs whose `main` returns `i32` behave the same under both
  compilers. A `fn main` can only `run` closed Effects (EFF-006), so no unhandled typed failure
  reaches the generated `main`.
- **Diagnostics and limits:** `entry-signature` is a structured backend gap, not a language error.
- **Evidence:** the native corpus runner reports `entry-signature` for each affected program.

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
  `compiler/src/semantic/SemanticCases.silk` checks both environment capture sets through production
  body queries. Native runtime execution is not claimed by this typing test.

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
  Uninferred result-only binders, quantified section lifetimes, runtime static parameters and
  enclosing owner recipes keep their existing precise gaps. Unsafe acknowledgement belongs to
  invocation, including zero-argument targets. Foreign function values remain SEM0189; callable
  values remain forbidden source static data. Opaque callable result realization and retained
  mutable callable parameter views remain required Step 8 work.
- **Source migration:** none.
- **Evidence:** `namedFunctionValuesConstructEmptyEnvironmentsAndReturnExactTypes`,
  `genericNamedFunctionValuesSelectEachDirectInvocation` and
  `namedCallableRepresentationsKeepExactIdentity` assert construction, original-target ABI,
  independent applications, visibility, static-data exclusion and diagnostic codes/spans.
  `qualifiedFunctionValuesRetainOwnerSelectionAndDirectAbi` covers namespace and imported
  inherent values, applied-owner selections, empty construction, unsafe invocation and foreign
  callback/visibility diagnostics.

### Native direct opaque callable results retain exact environments

- **Status:** source implementation recorded on 2026-10-04; native assertions and exact-head CI
  remain pending. Plain callable result contracts remain separate required Step 8 work.
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
- **Remaining Step 8 scope:** contextual opaque slots inside aggregate results and projected
  structural-union tags stay explicitly unsupported, rather than inventing leaf evidence from
  nullary variants or emitting an uninjected value. Descriptor or phantom-metadata recursion may
  also retain the explicit projection gap after physical inline validation; it is not reported
  as SEM0115 merely for crossing a reference. Detached/nonParking executable-property proof and
  ordinary callable result provenance remain required work.
- **Evidence:** `opaqueCallableReturnsRealizeOriginalSectionStorage`,
  `opaqueCallableReturnsRejectDivergenceAndLeaflessCycles`,
  `opaqueCallableReturnsRequireAffineTransfers` and
  `callableReturnFlowExcludesMembersWithExitingGuards` assert storage, original-target invocation,
  unreachable evidence exclusion, guard transfer and primary/related diagnostic spans.
- **Source migration:** none.

### Native callable captures retain loans of owned environments

- **Status:** source repair recorded on 2026-10-04; native assertions and exact-head CI pending.
- **Rule:** an exact closure, section, staged callable or opaque returned callable owns its stored
  environment. Shared and mutable capture access retain a reference to that owner. Copy captures
  still take a Copy snapshot, and moved captures still transfer the environment explicitly.
- **Compilers:** native no longer classifies exact callable representations as borrowed descriptors
  when constructing an anonymous environment. The capture field, construction operand and body
  alias all retain the same loan. Reference/slice/string descriptors and source raw callable views
  retain their existing descriptor handling; raw mutable parameter view lowering remains required
  Step 8 work. Borrow checking obligations remain visible for Step 14.
- **Evidence:** `anonymousBorrowedCallableCapturesRetainOneCleanupOwner` checks a shared capture of
  an owned once callable: a reference field, original-place construction borrow, dereferenced body
  alias, one caller cleanup owner and cleanup-free outer capture glue. Bootstrap analysis accepts
  the fixture with no diagnostics; bootstrap executable lowering retains its pre-existing SEM0219
  gap for the plain callable-reference parameter. A stale native CLI probe establishes that this
  fixture reaches native lowering, without claiming the repaired head's behavior.
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
  Native public callable promises and returned callable contracts report `Unsupported` at the
  value or invocation boundary when those contents remain unresolved, including callables inside
  stored aggregates. The direct public-promise bootstrap control instead reports `SEM0212` on its generic declaration for a
  `'static` promise with unbounded `T`; its complete borrow/lifetime analysis can prove additional
  finite and escaping cases. The nested aggregate control is bootstrap-admitted; native intentionally retains the explicit
  unresolved-contents gap until that proof is available. Native general borrow checking remains
  `NotChecked`.
- **Evidence:** `genericOwnedCapturesRetainLocalContentsAndSubstitutedLoans` checks the exact
  parameter, once mode, local obligation and mixed known/unknown region retention;
  `abstractCallableStagesRetainNewlySubstitutedCaptureLoans` keeps the base abstract while revealing
  a capture loan. Direct and nested public promise controls assert native gap codes and spans.
  `genericOwnedCaptureTransfersCleanupToOriginalTarget` checks the ordinary direct target and
  transferred capture cleanup. The reduced owned program builds with bootstrap `build-exe` and
  returns 42; native assertions and timing require exact-head CI.
- **Owner:** Step 8 owns construction and direct lowering; Step 14 owns discharging local Contents
  and general borrow obligations and proving additional escaping validity.

### Native plain callable results retain original storage and public permissions

- **Status:** direct acyclic ordinary producers implemented during Step 8; native assertions and
  exact-head CI remain pending.
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
- **Remaining Step 8 scope:** recursive origin cycles, divergent plain origins, callable-valued
  results reached through abstract or invocation-selected higher-order targets and interface
  invocation, and retained mutable callable parameter loans remain explicit gaps. Fully selected
  stored producer values and inherent receiver methods use the same original-result query and
  runtime ABI projection as direct producers. This layer does not mark Step 8 complete.
- **Evidence:** `plainCallableReturnsKeepOriginalStorageAndPublicContracts`,
  `plainCallableOriginsUnifyAcrossProducers`, `plainCallableViewsKeepWeakerInvocationPermissions`
  and `plainCallableViewStagingRetainsPublicModeAndArgumentOrder` inspect original storage,
  complete relay applications, exact identity, public permission rejection and direct suffix order.
  `plainCallableResultsFromStoredProducersAndMethodsUseOriginalTargets` covers fully selected
  stored and inherent producer calls. `plainOnceCallableReturnsTransferCaptureCleanupExactlyOnce`
  checks producer/caller transfer, a moved stored-field operand, target cleanup, abandonment glue
  and OWN0003 at a bare returned affine owner. Native execution of these assertions is pending.
- **Source migration:** none.


### Native raw owned-callable return identity guard

- **Status:** bootstrap parity implemented during Step 8 on 2026-10-04; exact native CI pending.
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

- **Status:** implemented during Step 8 on 2026-10-04; exact native CI pending.
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
- **Source migration:** none. Opaque and plain Effect members retain `EffectFormUnavailable`
  at their producer call, including unions; this prevents a callable sweep from hiding the next
  Step 9 boundary behind a generic typed-form gap.
