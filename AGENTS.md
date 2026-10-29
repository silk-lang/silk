# Silk agent instructions

## Layout

- `compiler/` is the native Silk compiler, written in Silk. It builds itself from the seed pinned in
  `compiler/native-seed.json`; `compiler/scripts/` holds the TypeScript tooling CI runs around it.
- `stdlib/` is the standard library, `corpus/` the shared native acceptance corpus, and
  `reference/` the prescriptive language reference.
- There is no TypeScript compiler. The first native compiler, n0, was built by a TypeScript
  bootstrap that now lives only in git history and the `bootstrap-v0.0.0` release; every later
  compiler is built from a pinned native seed.

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

## Repository workflow

- The Node tooling in `compiler/scripts` uses pnpm and Vitest; `pnpm test:scripts` tests it, and
  Selfhost CI runs it too. Node runs the `.ts` files directly by stripping types; there is no
  TypeScript compiler, formatter or linter.
- `main` is the only integration branch. A pull request merges when its required checks pass on its
  exact head: `Focused Linux Silk`. Selfhost CI runs on every push to a pull request into `main`
  (a newer push cancels the older run); a stack head or a branch without such a PR is dispatched
  as `.github/CI.md` describes. If a check fails, fix the cause and push the new head; report the
  exact failure and whether it predates the change.
- Open a draft PR as soon as there is a coherent commit, and reuse the task's PR. Run the cheapest
  relevant checks locally; do not rerun the CI-covered suite as handoff ceremony.
- Changesets (`.changes/<random>.md`, written by `silk change`) become the release notes, one
  list item each. Write the summary as one line saying what changed for users, such as "Add
  `List.reserveExact`." Details belong in the reference and guides, not the changeset. Internal
  work with no visible effect (refactors, caching, speedups users cannot observe) needs no
  changeset.
- Add a `## Migration` section only when code or builds written against the previous release
  must change. Readers are agents upgrading their libraries, so give the concrete edit, such as
  "Import `List` from `silk.collections.list` instead of `Vector` from `silk.vector`." Leave it out otherwise;
  no section means no action is needed.
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

## Text and bytes

Use `string` for text and byte slices (`&[u8]`, `b"..."`) only for data that is not text or may
not be UTF-8, such as file contents, wire formats, hashes, or raw host values.

- A public API that takes or returns text, such as a name, a message, a flag, a version, or a path
  written by the user, uses `string`. When callers also have the same value as host bytes, add a
  second function with a `Bytes` suffix, as `Path.join` and `Path.joinBytes` do.
- In code, tests, and doc examples, write text as a string literal. Write `b"..."` only where the
  callee takes bytes.

## Doc comments

Follow `reference/documentation-style-guide.md` for every `//!` and `///` comment. Two rules are
easy to miss:

- An item's own comment carries its description. Editors show only that comment on hover, never the
  module comment. A module comment can give an overview, but each fact a user of a type, service,
  function, field, or operation needs must also be in that item's comment.
- Each comment is self-sufficient. Never assume the reader has seen another comment: no "see above",
  "as described in the module docs", or "like [`other`]" in place of the facts.

After changing stdlib doc comments, regenerate `reference/stdlib` with `doc-reference`; CI checks it.

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
