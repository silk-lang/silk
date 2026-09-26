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

### Omitted environment of a no-input `fn` returning `Effect`

- **Status:** Approved by Julia on 2026-09-26. The reference states it in
  [LIFE-004](apps/docs/content/reference/lifetimes.md#life-004--invocation-lifetimes-and-retained-environments-are-independent).
  - **Native:** implemented and verified at the signature level on draft PR #517.
  - **Bootstrap:** not implemented. It rejects the omitted form.
- **Rule:** in a named function with no parameters, an omitted environment of the `Effect` result
  is `'static`. A parameterless `effect fn` constructs an Effect with the same `'static`
  environment.

  ```silk,ignore
  fn closed() -> Effect<i32> { return effect { return 42 } }
  // The result type is Effect<'static; i32>.
  ```

  Normal capture and lifetime checks still apply. The Effect cannot retain anything that is not
  valid for `'static`. Related clauses:
  [EFF-007](apps/docs/content/reference/effect-contracts.md#eff-007--an-effect-contract-has-success-failure-and-requirement-channels),
  whose example is this function, and
  [LIFE-003](apps/docs/content/reference/lifetimes.md#life-003--elision-is-determined-by-the-declaration-header).

- **Scope limits:** this is a narrow rule, not a general static default:
  - The input-based elision rules are unchanged. An omitted output lifetime or environment still
    comes from the single borrowed input when there is one.
  - It does not give a `'static` default to functions with owned or generic inputs, so
    `fn later(value: i32) -> Effect<i32>` still needs its environment written.
  - It does not apply to callables or Effects nested inside a callable contract, or to anonymous
    callables.
- **Compilers:**
  - **Native self-hosted frontend (`compiler/`):**
    - `fn closed() -> Effect<i32>` resolves to `Effect<'static; i32>`.
    - A parameterless `effect fn` records a `'static` environment.
    - `fn later(value: i32) -> Effect<i32>` stays `Unsupported`.
    - An `effect fn` with parameters and an omitted environment records none.
  - **TypeScript bootstrap:** checked 2026-09-26 with the CLI built from this checkout.
    - `fn closed() -> Effect<i32>` reports `SEM0210 The omitted output lifetime has no unique input`
      at the result.
    - `fn closed() -> Effect<'static; i32>` compiles and runs.
    - A parameterless `effect fn` compiles.
    - Aligning the bootstrap is a separate main-first repair, which has not been scheduled.
- **Source migration:**
  - The omission remains the approved form, and existing code that omits the environment here is
    correct.
  - The explicit spelling `fn closed() -> Effect<'static; i32>` is equivalent valid syntax, not a
    compatibility shim. Source may choose it intentionally, for example to compile with the current
    bootstrap.
  - Do not silently redefine the rule, and do not patch a compiler, without first classifying the
    mismatch against this entry.
- **Diagnostics and limits:**
  - The parameterless form resolves without a diagnostic.
  - A capture or retained borrow that is not valid for `'static` gets its ordinary lifetime or
    ownership diagnostic once body checking covers Effects.
  - A result with inputs and no single borrowed default keeps its ordinary outcome: `SEM0210` in
    the bootstrap, and `Unsupported` in the native frontend until that elaboration is implemented.
- **Evidence:** the `callableAndEffectSignatureContracts` case in
  `compiler/src/semantic/SemanticCases.silk` asserts:
  - `closedEffect` equals `explicitStatic`;
  - `inputEffect` is `Unsupported`;
  - `closedDeferred` records a `'static` environment and `inputDeferred` does not.
- **Open questions:**
  - The omitted environment of an `effect fn` with parameters.
  - Any case of "no inputs" beyond an empty parameter list.
  - Neither may be assumed until it is decided.

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
