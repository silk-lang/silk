# Silk agent instructions

## Green-field policy

Treat this entire repository as a green-field project until this rule is explicitly removed. No
current or historical API, behavior, data format, build artifact, or internal representation is a
compatibility contract.

- Always implement the clean design intended for the eventual stable release, and update every
  caller, test, fixture, and document in the same change.
- Delete superseded code. Do not retain compatibility shims, adapters, aliases, fallbacks,
  migrations, deprecated entry points, dual paths, or code selected only for old behavior.
- Do not introduce technical debt to stage a transition. A change is incomplete while the obsolete
  path remains or its cleanup is deferred to a future task.
- Prefer a breaking change over a compromised design. Existing usage inside this repository is a
  migration target to update, not a reason to preserve the old shape.

These conventions apply to the entire repository. The current `effect-patterns` skill is the
authoritative source for Effect architecture. When this file and that skill differ, follow the
skill and update this file rather than preserving an older convention.

## Papercuts

Maintain PAPERCUTS.md, a global log shared by all agents sessions of anything that slowed down development. When you lose time to one mid-session, append date · symptom · fix · project. Check this file first when tooling fails mysteriously.

## Compiler compatibility

Before treating a standard-library or compiler build failure as a compiler defect, read
[COMPILER_COMPATIBILITY.md](COMPILER_COMPATIBILITY.md). It records approved language changes, how
the TypeScript bootstrap and the self-hosted frontend currently differ, and which changes are still
unimplemented. Add or retire entries there when an intentional divergence starts or ends.

## Agent skills

Follow [ATOM-REACT-STYLEGUIDE.md](ATOM-REACT-STYLEGUIDE.md) for Effect Atom and `@effect/atom-react` code.

Create or update an OpenSpec change only when Julia explicitly requests one. Do not infer that an
OpenSpec artifact is required from the kind, scope, or size of a task. The prescriptive language
definition and reference live in `apps/docs/content/reference/`.

## Repository workflow

- The workspace uses pnpm, Turbo, strict TypeScript, Oxfmt, Oxlint, and Vitest.
- Put public LLVM code in `packages/llvm/src` and tests in `packages/llvm/test`.
- Keep the public barrel at `packages/llvm/src/index.ts` explicit.
- Prefer opening a draft PR early, as soon as there is a coherent task-scoped commit to publish.
  Reuse the task's existing PR when available so CI starts while implementation and review
  continue.
- Run the cheapest relevant focused checks while implementing. Run a broader local command only
  when it gives change-specific evidence that CI does not provide, reproduces or diagnoses a CI
  failure, or Julia explicitly requests it. Do not rerun the complete CI-covered suite locally as
  handoff ceremony.
- Before the final push, finish every repository mutation, including generated artifacts and any
  implementation-task checkboxes in an explicitly requested OpenSpec change, then audit, commit,
  and push the intended head. Required
  pull-request CI on that exact head is the authoritative full-repository completion guard; wait
  for it to pass before handoff. If it fails, fix the cause, run affected focused checks, push the
  new head, and wait for that head's CI.
- CI, review, PR updates, and handoff are workflow gates, not implementation tasks. Do not add
  OpenSpec task-list items whose sole action is running or recording checks, obtaining approval,
  waiting for CI, or reporting the handoff. A passing gate never requires a follow-up repository
  edit or empty push. Report the exact failure and whether it predates the change.

## Minimal compiler privilege

- All source-callable compiler operations belong to the sealed `Intrinsic` namespace. Do not add a
  compiler-known standard-library actor or recognize a library declaration by spelling in semantic
  analysis, HIR, MIR, evaluation, or a backend.
- A new compiler feature exposes only the smallest target-neutral primitive needed to build its
  public API in ordinary Silk source. Keep validation, policy, generic selection, provider types,
  and safe reusable wrappers in the standard library.
- Use `service` for runtime-provided Effect contracts and lexical provider replacement. Use
  `interface` for compile-time conformance and specialization only; interfaces never create
  requirement rows, service slots, or runtime dispatch.

## Collaborative decision sessions

When a task requires a multi-decision interview, grilling session, or other branching design
process, publish a visible Codex task plan at the start. Show the major decision branches, mark
exactly one current branch in progress, and keep completed and pending branches visible so the user
can orient themselves. Treat the plan as a live map: update, split, reorder, add, or remove branches
as answers expose new dependencies or invalidate earlier assumptions.

Before every user-facing decision question in that session, also include a compact, friendly
Markdown checklist showing the overall session state. Use `✅` for completed branches, `🟡` for the
single current branch, and `⬜` for pending branches. Keep it pleasant and quickly scannable; group
items only when the map becomes unwieldy, and never omit the current branch or remaining work. Keep
this in-message checklist synchronized with the visible Codex task plan.

## One module per actor

Organize Effect code by actor, not by kind of implementation. An actor is a module named after one
concept, such as `Target.ts`, `Module.ts`, or `Compiler.ts`. It contains:

- the data or service named after the module; and
- sibling functions operating on that value, with the value as their first parameter.

The main export is mostly data. Data types carry no core methods, while services may expose a few
getters. Put behavior in sibling functions so the API remains composable and tree-shakeable. Use
`dual` from `effect/Function` when both data-first and pipeable call forms are useful.

```ts
import * as Function from 'effect/Function'

export interface Target {
  readonly triple: string
}

export const make = (triple: string): Target => ({ triple })

export const matches = Function.dual<
  (triple: string) => (self: Target) => boolean,
  (self: Target, triple: string) => boolean
>(2, (self, triple) => self.triple === triple)
```

Do not create class-per-entity designs, `utils.ts` or `helpers.ts` grab bags, or modules whose
exports do not orbit one concept. A new concept gets a new actor module.

Re-export public actors as namespaces from `packages/llvm/src/index.ts`:

```ts
export * as Target from './Target.js'
```

Prefer one namespace import per actor. Within the package, import the actor module directly. For a
public actor, add its explicit package subpath export and prefer the deep import:

```ts
import * as Effect from 'effect/Effect'
import * as Target from '@silklang/llvm/Target'
```

Avoid a growing destructured import from the package barrel.

## Wrap external APIs in Effect

Nothing that can throw or return a bare `Promise` crosses an external boundary unwrapped. Each
external dependency has one owning boundary actor. That actor converts failures to the typed error
channel and resources to a `Scope`; everything inward of the boundary stays effectful.

- Prefer Effect's built-in service modules. Use Effect's HTTP client instead of raw `fetch`, and
  Effect's filesystem service instead of `node:fs/promises`. Provide platform layers once at the
  application edge so tests can replace services without mocking globals.
- For an API with no Effect integration, wrap synchronous calls with `Effect.try` and promises with
  `Effect.tryPromise`.
- Wrap acquire/release pairs with `Effect.acquireRelease`. Do not use manual `try/finally`, expose
  `dispose()` bookkeeping, or scatter `new ExternalThing()` across modules.
- Keep boundary wrappers thin. Do not build a large imperative core and bolt Effect onto its outer
  constructor or entry point.

Use the LLVM-specific `LlvmError` family for expected package failures. Preserve the operation and
message, and distinguish invalid input, invalid state or ownership, and wrapped external failure
with a discriminated reason. Only wrapped failures carry JavaScript causal ancestry; rejected
values belong in semantic error details. Introduce another public tag only when callers need a
distinct recovery branch.

```ts
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'

export class LlvmError extends Data.TaggedError('LlvmError')<{
  readonly operation: string
  readonly message: string
  readonly reason: {
    readonly _tag: 'WrappedFailure'
    readonly cause: unknown
  }
}> {}

export const fromExternal = Effect.fn('Llvm.fromExternal')(function* (input: string) {
  return yield* Effect.try({
    try: () => externalApi(input),
    catch: (cause) =>
      new LlvmError({
        operation: 'Llvm.fromExternal',
        message: `LLVM operation failed for ${input}`,
        reason: { _tag: 'WrappedFailure', cause },
      }),
  })
})
```

never throw yieldable errors across a public boundary, use a tagged error as synchronous control
flow, swallow errors in `catch`, or expose `unknown` as a public Effect error channel. Synchronous
mutable transitions return a typed `Result`; unexpected JavaScript throws remain
defects. Public fallible helpers return Effects. Private synchronous encoders may abort with a
private non-yieldable implementation failure that is translated once at the outer Effect boundary.

## Effectful functions are Effect.fn

Define named public actor operations with `Effect.fn('Actor.operation')`; these are the package's
observability boundaries. Define reusable internal Effect-returning functions and recipe callbacks
with `Effect.fnUntraced`. Keep inline `Effect.gen` for one-off composition rather than reusable
arrows that merely return a generator.

```ts
export const compile = Effect.fn('Compiler.compile')(function* (
  target: Target.Target,
): Effect.fn.Return<Artifact.Artifact, LlvmError, CompilerService> {
  const compiler = yield* CompilerService
  return yield* compiler.compile(target)
})
```

The explicit `Effect.fn.Return<A, E, R>` annotation is optional for internal functions. Use it to
pin public and recursive signatures. Prefer `Function.dual` for immutable actor transformations
that are useful both data-first and in a pipe; preserve the existing data-first argument order and
defaults.

Raw imperative code is allowed only inside a documented performance-critical inner loop, such as
per-instruction or per-byte processing. Keep that loop behind an effectful API, keep construction
and teardown in Effect, and add a comment naming the measured reason for the exception. A claim
that an entire package is a hot path is not an exception.

## Tests use @effect/vitest

Import `it` and `assert` from `@effect/vitest`. Use ordinary `it` for synchronous tests and
`it.effect` for Effect-returning tests. Use `it.layer` only when tests genuinely share a service
graph. Assertions stay inside the Effect generator.

```ts
import * as Effect from 'effect/Effect'
import { assert, it } from '@effect/vitest'

it.effect('compiles a target', () =>
  Effect.gen(function* () {
    const artifact = yield* Compiler.compile(Target.make('wasm32'))
    assert.strictEqual(artifact.target, 'wasm32')
  }),
)
```

Do not build a `ManagedRuntime` test harness, call `Effect.runPromise` or `Effect.runSync` inside
each test, rebuild common layers per test, or wrap Effect code in `async` callbacks. A test that
genuinely needs isolation may scope a distinct layer within that test.

## Keep tests cheap

The compiler suite is the critical path of `pnpm check`; every test pays for the compiler
pipelines it runs. Prove each claim at the cheapest tier that can falsify it.

- Prove parser, resolution, typing, ownership, Effect, target-selection, and diagnostic claims with
  structured analysis assertions. Prove compile-time execution only through `Evaluation`.
- Put target-neutral runtime behavior in the shared native acceptance corpus. Use LLVM IR, object,
  symbol, relocation, disassembly, or separately compiled C fixtures for lowering and ABI claims,
  and add an LLVM-to-Wasm leg only for intended WebAssembly behavior.
- Never add a per-feature "the native binary agrees" test. That claim is proven differentially by
  `DriverNativeAcceptance` — add your program to `test/support/corpus.ts` instead of calling
  `Driver.compile` in a feature file.
- Do not write per-feature fresh-process determinism tests. Fresh-process determinism is a global
  property, guarded by the designated canary determinism tests; per-feature determinism is proven
  by committed-golden byte comparisons in-process.
- Build one `Analysis` snapshot per source program per file and share it across assertions and
  engines. Do not re-run `ofSourceRealized` on the same source.
- Assert diagnostic codes and spans, not message text. The generated diagnostic catalog gates
  wording.
- No timing assertions, byte counts, or instruction counts in the correctness suite. Structural
  claims assert structure; performance claims live in opt-in bench targets.
- In failure-ordinal and stress sweeps, prefer structural compiler assertions. When execution is
  the only adequate oracle, consolidate the distinguishing boundary cases in the native corpus.
- Prefer adding a case to an existing file over creating a new test file: each new file costs
  ~0.5s of worker startup and re-imports the compiler.
- A test that cannot fail for a reason distinct from its neighbors is not a test; delete it rather
  than keeping it for coverage optics.

## Scope resource lifecycles

Use `Effect.acquireRelease`, `Effect.acquireUseRelease`, or an equivalent scoped bracket whenever
an operation acquires a reservation, draft, handle, or external resource. Release must run after
success, typed failure, defect, and interruption without replacing the original exit. Do not rely
on duplicated cleanup branches or manual `try/finally`. Preserve generic success, error, and
requirement channels through the bracket.

## Stay type-safe

- never use non-null assertions (`!`), including in tests.
- Use `test/support/raise.ts` when a test invariant makes a nullable value impossible:
  `values.at(-1) ?? unreachable('expected a value')`.
- Use casts only for truths TypeScript cannot express, such as a conditional return type or a
  variance gap inside a generic combinator. Fix signatures instead of casting call sites.
- never add lint suppressions to permit a cast or non-null assertion.
- Keep public Effect error and requirement channels precise; do not erase them to `unknown` or
  `never` for convenience.
