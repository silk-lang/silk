# Silk agent instructions

## Layout

- `compiler/` is the native Silk compiler, written in Silk. It builds itself from the seed pinned in
  `compiler/native-seed.json`; `compiler/scripts/` holds the TypeScript tooling CI runs around it.
- `stdlib/` is the standard library, `corpus/` the shared native acceptance corpus, and
  `reference/` the prescriptive language reference.
- `bootstrap/` is the frozen TypeScript compiler. It only has to build the anchored first native
  compiler (`bootstrap/anchor.json`); never extend it, and change it only when that build breaks.

## Green-field policy

Treat this repository as green-field until this rule is removed. No current or historical API,
behavior, data format, build artifact, or internal representation is a compatibility contract.

- Implement the clean design intended for the stable release, and update every caller, test,
  fixture, and document in the same change.
- Delete superseded code. Do not keep shims, adapters, aliases, fallbacks, migrations, deprecated
  entry points, or dual paths, and do not defer their cleanup to a later task.
- Bookkeeping that only serves a later revision, such as dependency edges or validation evidence,
  may be gated on whether the build can be revised: one code path whose recorder returns early in a
  one-shot build. It must not change what the compiler computes, and both modes need a test.

## Papercuts

Maintain PAPERCUTS.md, a global log shared by all agent sessions of anything that slowed down
development. When you lose time to one, append date · symptom · fix · project at the end of the file
on one physical line. Do not reorder or reformat existing entries. Check it first when tooling fails
mysteriously.

## Repository workflow

- The workspace uses pnpm, Oxfmt, Oxlint, and Vitest. `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, and `pnpm test:scripts` are the fast local checks.
- `main` is the only integration branch. A pull request merges when its required checks pass on its
  exact head: `CI result` and `Focused Linux Silk`. Merge `main` into the branch before its final
  run. If a check fails, fix the cause and push the new head; report the exact failure and whether
  it predates the change.
- Open a draft PR as soon as there is a coherent commit, and reuse the task's PR. Run the cheapest
  relevant checks locally; do not rerun the CI-covered suite as handoff ceremony.
- Never edit `compiler/borrow-check-gap.txt` by hand: after a corpus run, write it with
  `node .github/scripts/check-borrow-gap.mjs update <corpus log>`, and put the table that
  `check-borrow-gap.mjs diff <old> <new>` prints in the PR description.

## Minimal compiler privilege

- All source-callable compiler operations belong to the sealed `Intrinsic` namespace. Do not add a
  compiler-known standard-library actor or recognize a library declaration by spelling.
- A new compiler feature exposes only the smallest target-neutral primitive needed to build its
  public API in ordinary Silk source. Keep validation, policy, generic selection, provider types,
  and reusable wrappers in the standard library.
- Use `service` for runtime-provided Effect contracts and lexical provider replacement. Use
  `interface` for compile-time conformance and specialization only.

## Keep tests cheap

- Source-written compiler tests should finish within 1 s on Linux CI; aim for under 500 ms.
  Reduce fixture and demand cost before splitting a slow test, and keep every distinct assertion.
- Prove parser, resolution, typing, ownership, Effect, and diagnostic claims with structured
  assertions, and compile-time execution through the static evaluator.
- Put target-neutral runtime behavior in the shared native corpus. Use LLVM IR, object, symbol, or
  separately compiled C fixtures for lowering and ABI claims.
- Assert diagnostic codes and spans, not message text. No timing, byte-count, or instruction-count
  assertions in correctness tests.
- A test that cannot fail for a reason distinct from its neighbors is not a test; delete it.

## TypeScript tooling

`compiler/scripts/` follows the Effect conventions of the current `effect-patterns` skill:

- One module per actor: data or a service named after the module, with sibling functions taking the
  value first. No class-per-entity designs or `utils.ts` grab bags.
- Nothing that can throw or return a bare `Promise` crosses an external boundary unwrapped. Use
  Effect's platform services, `Effect.try`/`Effect.tryPromise`, and `Effect.acquireRelease` for
  resources; failures are typed errors with a discriminated reason.
- Name public operations with `Effect.fn('Actor.operation')` and reusable internal ones with
  `Effect.fnUntraced`.
- Tests import `it` and `assert` from `@effect/vitest` and keep assertions inside the Effect.
- Never use non-null assertions (`!`) or lint suppressions; cast only for truths TypeScript cannot
  express.

## Collaborative decision sessions

For a multi-decision interview or branching design process, publish a visible task plan of the
decision branches at the start, with exactly one in progress, and keep it current as answers change
the map. Before each decision question, include a compact checklist of the session state: `✅` done,
`🟡` current, `⬜` pending.
