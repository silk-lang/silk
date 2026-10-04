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
coverage ledger (workspace note `fc5536e2-4ce3-4989-8600-43c96f4104d5`). A `ContractTyped`
body still carries ownership, lifetime, cleanup, and Effect safety obligations for M2.5. This
does not claim borrow checking or general executable support. The selfhost build CLI currently
lowers closed scalar, reference, record and sequence forms through demanded MIR and LLVM text. It emits a
`SILK_GAP borrow-check` summary when reached bodies retain safety obligations. Field/index
projections now use neutral record/sequence layouts in backend roadmap step 4. Runtime slice
descriptors and checked element places use the same internal aggregate slots; subrange primitives
remain a named `intrinsic-member` gap. A repeated inferred shared-slice lifetime with distinct
actual Local regions of the same caller requires the deferred common-validity proof and reports
`slice-region-relation`; this does not admit fixed Static, incompatible access/element, or foreign
owner evidence. That gap exits through the later checked caller-region/outlives stage. Immediate
raw pointer mutation-capability weakening preserves invariant pointee/extent and identical other
qualifiers; it does not implement reverse access, nested pointee covariance, or other qualifier
conversions. Ownership, lifetime, and cleanup checking remains step 14. The TypeScript bootstrap
still builds the native compiler and remains the complete language oracle.

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
  Selfhost implements only its existing target/static-text subset; the new membership check adds
  no runtime primitive, contract validation, evaluation, or lowering.
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
  Step 6d, which lowers partial moves.
- **Rule:** an owned value whose type carries `impl Drop` in its owned structure is cleaned when it
  leaves scope without being moved.
- **Compilers:** both lower drops, replacement drops, drop flags and partial moves. Selfhost still
  reports the backend gap `cleanup` instead of lowering a partially moved owner whose holes differ
  between joining paths or that is moved on only some paths, a write at a runtime index beside a
  moved element, a loop iteration that leaves an owner in a different state than it found it, a
  guard that changes an owner's state, a borrowing match result whose arm created temporaries, and
  drop glue for Effect environments, generic nominal unions and unions without a
  canonical member order.
- **Source migration:** none.
- **Evidence:** `cleanupStackDropsWhatEachExitLeaves`, `cleanupFollowsLoopsAndConditionalPaths`,
  `partialMovesDropTheRemainingChildren` and `dropGlueCleansHookThenChildren` in
  `compiler/src/semantic/SemanticCases.silk` cover the lowered forms and the holes, runtime-index,
  guard and loop gaps. Not checked by a test: a partially moved owner moved on only some paths, the
  borrowing match result gap, which current typing cannot reach because it borrows only places and
  Drop-free array literals, and the deferred glue forms.

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
  Source callable-bearing record patterns remain blocked by generic record typing and are not
  claimed as native runtime coverage here.
- **Open questions:** whether the bootstrap should narrow OWN0008 to provisional bindings, or the
  reference should widen it, before extending selfhost's general guard ownership checking.

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
