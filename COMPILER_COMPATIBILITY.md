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

| Compiler                       | Location                                                        | Role today                                                                                                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript bootstrap (stage 0) | `packages/compiler`, `packages/cli`                             | Builds and checks every Silk program today: the standard library in `packages/compiler/stdlib`, examples, and the self-hosted compiler's own sources. Repairs start from `main` (see the [development branches and bootstrap](compiler/README.md#development-branches-and-bootstrap) section). |
| Self-hosted native frontend    | `compiler/` (developed on `selfhost` and `selfhost-*` branches) | Lexer, parser, HIR lowering, and demanded semantic queries. Its semantic coverage is incomplete and it is not wired into the CLI. Source compiled with `silk build`, `check`, or `test` never goes through it. [compiler/README.md](compiler/README.md) lists what it supports.                |

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
  - **Remaining native gap:** an `Intrinsic.Detached`-bounded representation parameter is not
    supported natively, because the native semantic queries have no `Intrinsic` handling. The
    bootstrap gives such a parameter no retained region, so its contribution is `'static`. The
    bootstrap treats a plain `T: Intrinsic.Detached` value parameter as unknown, like any stored
    generic. Native does not yet check the standard library, so this entry claims agreement only
    for the cases listed here.
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

- **Status:** Deferred proposals. Nothing here is approved as an implementation change, and neither
  compiler has changed because of it.
- **Summary:** the design discussion considered several directions:
  - a target-neutral lowering boundary that turns non-suspending Effects into ordinary closures,
    provider operands, tagged outcomes, and cleanup;
  - keeping coroutine lowering for suspension;
  - letting source execution infrastructure choose frame storage;
  - reifying completed outcomes, and how panics and traps relate to Effect outcomes.

  None of these changes current language rules.

- **Compilers:** unchanged. Today's lowering, storage, and failure behavior are what the bootstrap
  implements and what the reference already states, including
  [FAIL-007](apps/docs/content/reference/typed-failures.md#fail-007--a-trap-is-fatal-and-remains-outside-effect-outcomes)
  for traps.
- **Source migration:** none. Do not write code that relies on these proposals.
- **Background:** the workspace design-checkpoint note "Effect architecture — design checkpoint"
  (note `201bb5aa-9e93-4b5b-ab5c-d5e4caedf259`), recorded 2026-09-26. It is a decision record, not
  an implementation plan.

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
