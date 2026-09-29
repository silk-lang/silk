---
name: test-audit
description: 'Author and audit Silk tests for independent behavioral or structural proof. Use when writing, changing, reviewing, or sweeping tests to reject duplication, implementation coupling, and unnecessary test-only production seams.'
---

# Test Audit

Three modes share one value bar. **Authoring** checks new or changed tests within
an implementation task. **Audit** examines a requested scope for low-value tests
and the production seams they keep alive. **Campaign** covers a whole package or
compiler subsystem; read [CAMPAIGN.md](CAMPAIGN.md) for that mode. Ordinary test
work does not start a broader audit. Optimize for confidence, not deletion count.

Read root and scoped `AGENTS.md` files first. Silk's language definition lives in
`apps/docs/content/reference/`. Apply the green-field policy: historical APIs,
formats, and implementation choices are not compatibility contracts. Preserve
proof of the intended design and update callers, fixtures, and docs together when
that design changes. Create OpenSpec artifacts only when Julia requests them.

## Authoring gate

Before adding or changing a test, answer:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure? Choose the cheapest
   tier that can falsify the claim. Another layer needs a distinct risk, such as
   lowering, ABI, lifecycle, or target behavior that the first layer cannot prove.
4. Does it require an export, flag, wrapper, or injection hook with no production
   purpose? Prefer the real owning boundary and existing replaceable Effect
   services; do not add test-only public APIs.

A missing answer means the test is not ready. Prefer extending an existing file,
case table, or shared fixture. A regression test should fail on the pre-fix code
for the intended reason and pass after the repair; use an isolated checkout when
necessary to preserve in-progress work. Report when a failing control could not
be obtained rather than claiming demonstrated regression coverage.

## Choose the proof tier

Follow `AGENTS.md`'s **Keep tests cheap** rules:

- Parser, resolution, typing, ownership, Effect, target-selection, and diagnostic
  claims use structured analysis assertions. Share one `Analysis` snapshot per
  source program per file. Assert diagnostic codes and spans; the generated
  diagnostic catalog owns wording.
- Compile-time execution is proven through `Evaluation`.
- Target-neutral runtime behavior belongs in
  `packages/compiler/test/support/corpus.ts`, exercised by
  `DriverNativeAcceptance`. Do not add per-feature `Driver.compile` executions
  merely to show that the native binary agrees.
- Lowering and ABI claims use LLVM IR, objects, symbols, relocations, disassembly,
  or separately compiled C fixtures. Add LLVM-to-Wasm execution only for intended
  WebAssembly behavior. Structural proof is valuable when structure is the claim.
- Per-feature determinism uses committed-golden byte comparisons in-process;
  fresh-process determinism belongs to designated global canaries.
- Performance claims belong in opt-in benchmarks, not timing, byte-count, or
  instruction-count assertions in correctness tests.

For TypeScript Effect tests, use `it` and `assert` from `@effect/vitest`, ordinary
`it` for synchronous tests, and `it.effect` for Effects. Use `it.layer` only for a
shared service graph. Keep assertions inside the Effect generator; do not create
per-test `ManagedRuntime` harnesses or run Effects through `runPromise`/`runSync`.
Keep error and requirement types precise and avoid casts and non-null assertions.

## Suspect patterns

Check new tests and audit candidates for:

- assertion-free probes, self-comparisons, or expected values calculated by the
  same helper being tested;
- copied inventories, export lists, source text, or mock call shapes with no
  independent contract;
- duplicated assertions of one contract across features, providers, or engines;
- mocks or fixtures that implement the behavior the production owner should
  produce, such as supplying the cleanup order or expected lowering themselves;
- tests keeping otherwise dead code or test-only exports and reset hooks alive;
- negative controls passing for the wrong reason, such as a typing failure that
  prevents the claimed ownership or target diagnostic from ever being reached;
- names claiming execution, cleanup, or ABI behavior while assertions prove only
  successful analysis or the existence of an artifact;
- repeated compiler pipelines on the same source, per-feature native agreement
  tests, or per-feature fresh-process determinism checks.

A match requires evidence, not automatic deletion. Exact bytes can be an
independent golden; a structural assertion can protect a lowering invariant.

## Retention bar

Keep independent proof of the intended language semantics, public APIs, resource
lifecycles, service replacement, diagnostics, ABI, binary formats, protocols,
security, platform behavior, packaging, release, and architectural constraints.
Examples include the sealed `Intrinsic` boundary and the distinction between
runtime services and compile-time interfaces.

Keep call ordering when observable, regressions with distinct failure modes, and
source inspection when it is the cheapest independent guard of a real contract
and survives irrelevant identifier changes. A test breaking under an irrelevant
refactor is suspect; one breaking because a required IR or ABI invariant changed
may be doing its job. Static or slow alone is not a deletion reason.

A baseline failure is a possible product defect. Investigate it; do not delete a
valid assertion to make the suite pass. Green-field policy permits deliberate
design changes, not silently discarding proof of current requirements.

## Discovery and candidate evidence

Keep discovery read-only and report evidence before editing. Prefer the codebase
knowledge graph for symbols, callers, and dependencies; index the repository if
needed. Use text search for literals, configuration, non-code files, or when the
graph is insufficient. Inspect complete candidate tests, their production owners,
entry points, callers, callees, overlapping tests, relevant history, and CI routing.
Inspect dependency source or types when a claim depends on external behavior.

Partition broad scope by owners: compiler analysis/evaluation/lowering, LLVM,
standard-library runtime behavior, CLI/LSP/platform packages, or apps and tooling.
Include shared corpus and conformance cases that prove the same contract.

Before deleting or consolidating a candidate, record:

- exact test name and location;
- the failure it can actually detect;
- production callers and whether a public entry point is used outside the repo;
- stronger remaining proof and its tier, or why the contract is obsolete;
- relevant history and why the test or seam exists;
- production or test-support removal unlocked;
- risk and the focused validation command.

Outside campaign mode, prefer a few proven candidates over a speculative inventory.

## Edit shape

Change one coherent owner boundary at a time. Move retained assertions into their
canonical owner before deleting duplicates. Remove superseded production paths
and test-only seams in the same change; retain no compatibility aliases. Preserve
useful Effect service boundaries even when tests are their only current substitute
provider. Do not add replacement tests that restate the same implementation, or
chase a line-count target at the expense of proof.

## Validation

Use current package scripts and `.github/workflows/ci.yml` to establish test routing
and prerequisites. Finish source and test edits before starting a test run in that
checkout. Run the smallest relevant checks; from the repository root, examples are:

```sh
pnpm --filter @silklang/compiler exec vitest run test/<Owner>.test.ts
pnpm --filter @silklang/llvm exec vitest run test/<Owner>.test.ts
pnpm --filter <package-name> exec vitest run <test-path> -t '<test-name>'
node --test scripts/<owner>.test.mjs
pnpm exec oxfmt --check <changed-files>
pnpm exec oxlint <changed-typescript-files>
git diff --check
```

Replace placeholders with existing owners and files. Use `exec vitest` for focused
filters; do not assume arguments forwarded through package script wrappers arrive
at Vitest. Build required dependencies or refresh generated artifacts only as
needed by the affected test. For removed source greps or plan assertions, validate
the executable contract they claimed to protect. Run relevant package typechecks
when changing TypeScript signatures or test types.

Do not run `pnpm check` or the complete CI-covered suite as local handoff ceremony.
Broader local checks need change-specific evidence, a CI failure to diagnose, or
Julia's request. Review the final diff for lost contracts and inspect
`git diff --numstat`, separating production/tooling from tests/support.

## Publishing and handoff

Follow the user's existing authorization and the repository workflow. Normally,
open a draft PR once a coherent task-scoped commit is ready, reusing the task's PR.
An explicit instruction to commit directly to `main` takes precedence. Complete
all intended edits and generated artifacts before the final push. Required PR CI
on that exact head is the full-repository completion guard; wait for it, fix
failures, and report whether they predate the change. Do not add gate-only OpenSpec
tasks, empty pushes, or mandatory review skills that this repository does not use.

Report removed categories, production simplifications, retained false positives,
proof actually run, production versus test/support changes, and commit/PR/CI state.
Name unresolved contracts and follow-ups. Continue another audit batch only within
the user's requested scope, with fresh discovery against the current base.
