---
name: test-audit
description: 'Author and audit the self-hosted Silk compiler tests in compiler/: source-written Silk test roots and selfhost corpus coverage. Use when writing, changing, reviewing, or sweeping those tests for independent proof and unnecessary cost.'
---

# Selfhost Test Audit

**Authoring** checks new or changed tests in an implementation task. **Audit**
examines a requested scope for low-value tests and test-only production seams.
**Campaign** covers a whole selfhost subsystem; read [CAMPAIGN.md](CAMPAIGN.md)
only for that mode. Ordinary test work does not start a broader audit. Optimize
for confidence, not deletion count.

Read root and scoped `AGENTS.md` files, `compiler/README.md`, and the current
`.github/workflows/selfhost.yml` routing. The language definition lives in
`apps/docs/content/reference/`. Apply the green-field policy: replace superseded
paths and update callers, fixtures, and docs together. Create OpenSpec artifacts
only when Julia requests them. Read `COMPILER_COMPATIBILITY.md` before classifying
a bootstrap/selfhost difference as a defect.

## Authoring gate

Before adding or changing a test, name:

1. Its observable behavior, invariant, or independent contract.
2. A credible regression that makes it fail.
3. Why existing coverage cannot catch that failure at the cheapest adequate tier.
4. Whether it needs an export, flag, wrapper, or injection hook without a
   production purpose. Use the owning actor and existing Silk providers instead
   of adding test-only public APIs.

A missing answer means the test is not ready. A test that cannot fail for a
reason distinct from its neighbors is not a test;
delete it rather than retaining it for coverage optics. Prefer an existing test
root, case table, or fixture. For a regression, demonstrate failure on pre-fix
code for the intended reason and success after the repair when feasible. Use an
isolated checkout for controls and report missing control evidence explicitly.

## Cheapest adequate proof

- Parser, resolution, typing, ownership, Effect, target selection, and diagnostics
  use structured selfhost assertions. Keep one analysis snapshot per source
  program per test root: share the parsed revision and semantic session across
  assertions instead of reparsing or repeating whole-module demands. Distinct
  revisions or sessions need a claim that requires them, such as invalidation.
- Demand only the facts needed to falsify the claim. Assert diagnostic codes and
  byte spans, not message text. Negative controls must reach the intended phase.
- Compile-time execution uses the selfhost static evaluator, such as
  `StaticExecution`; successful typing or residual structure alone is not proof
  of execution.
- Target-neutral runtime behavior belongs in the shared native corpus, exercised
  by `compiler/scripts/runSelfhostCorpus.ts` and its `selfhostTrack.ts`. The corpus
  data in `packages/compiler/test/support/corpus.ts` is main-owned: route changes
  there through main, then bring them into selfhost. Do not add per-feature native
  compilations merely to show that the binary agrees.
- Lowering and ABI claims use retained MIR, LLVM IR, objects, symbols, relocations,
  disassembly, or separately compiled C fixtures. Execute Wasm only for intended
  WebAssembly behavior. Do not claim a deferred C/ABI fixture was checked.
- Per-feature determinism uses committed goldens in-process; fresh-process
  determinism belongs to designated global canaries.
- Performance claims belong in opt-in benchmarks. Do not add timing, byte-count,
  or instruction-count assertions to correctness tests.

Source-written tests use `test effect fn` and `silk.testing` assertions through
the existing providers. Write multiline fixtures with Silk triple-quoted strings,
not escaped `\n` strings or semicolon-separated statements. Keep support scoped
to its owning concept; do not introduce TypeScript test harnesses for Silk claims.

## Linux timing budget

Source-written selfhost tests should finish **within 1 s on Linux CI**; aim for
**under 500 ms**. `.github/scripts/check-selfhost-test-times.mjs` warns above the
1 s target and rejects timings of 2 s or longer and logs with no measured tests.
Keep this check outside compiler execution. Compile-and-run step duration includes compilation and is not the
per-test runtime budget.

Reduce fixture size, irrelevant declarations, repeated parsing, and demand cost
before splitting a slow test. Split only independent claims and retain every
distinct assertion. Prefer existing focused roots from `selfhost.yml`; a new root
adds native compilation cost and must earn it. Do not add whole-tree verifiers,
exhaustive matrices, stress sweeps, or repeated native builds to the hot path.
Use broader checks only for a milestone or a specific regression that needs them.

## LOUD GAPS

Every deferral must remain a structured `Unsupported` or not-checked result,
with its code/reason or missing fact visible. Audit deferrals record
`{status: not-checked, claim, reason}` rather than an empty ledger entry.
Never turn a deferred demand into
success, an assertion-free return, an unreported skip, or a generic boolean that
looks like proof. These results are evidence of incomplete coverage, not noise.

Preserve semantic unsupported outcomes and corpus gap records, failure records,
and separate pass/fail/unsupported totals. A malformed or absent unsupported
record remains a failure; an unsupported case is never a pass. Keep track cases
required to pass. Do not shrink the track or delete gap assertions to make CI
appear green. Record unexamined scope as not checked in the audit handoff.

## Evidence before edits

Keep discovery read-only. Prefer the codebase graph for symbols and callers when
it supports the Silk sources; use text search for literals/configuration or when
the graph is insufficient. Inspect complete candidate tests, their production
owners, callers, overlapping roots/corpus cases, relevant history, and CI routing.

For each deletion or consolidation, record the exact test and root, the failure
it can detect, production callers, stronger remaining proof and its tier (or why
the contract is obsolete), history, removal unlocked, risk, and focused check.
Suspicious patterns include self-comparisons, expected values from the tested
helper, copied implementation inventories, fixtures supplying the expected
behavior, test-only seams, repeated pipelines, and names claiming more than the
assertions prove. A pattern is a candidate, not evidence for automatic deletion.

Retain independent semantics, lifecycle/provider replacement, diagnostics,
query reuse/invalidation, sealed `Intrinsic` boundaries, service/interface
separation, ABI and target contracts. Structural proof and observable ordering
can be valuable. A baseline failure may be a product defect: do not delete a
valid assertion to hide it. A slow test needs cheaper proof, not lost proof.

## Edits and verification

Edit one owning boundary at a time. Move retained assertions to their canonical
root before deleting duplicates; remove dead production paths and obsolete
support in the same change. Preserve useful provider boundaries and unrelated
work. Inspect imports and `selfhost.yml` filters when moving tests so retained
cases are still discovered. Do not invent inventories or line-count gates.

Use the existing bootstrap CLI and prerequisites from `selfhost.yml`. From the
repository root, select an existing root and, when useful, a test-name filter:

```sh
node packages/cli/dist/bin.js check --manifest-path compiler/silk.toml
NODE_OPTIONS=--max-old-space-size=6144 node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/semantic/SemanticStaticCases.silk --filter '<test-name>' --no-cache > /tmp/selfhost-tests.log
cat /tmp/selfhost-tests.log
node .github/scripts/check-selfhost-test-times.mjs /tmp/selfhost-tests.log
```

Check the test command's exit status before accepting the timing result. Replace
placeholders with real names; `--root` paths are relative to `compiler/`. Use
`--no-cache` so assertions execute. Local timings are diagnostic; Linux CI is the
budget authority. Honor session restrictions on local builds: use focused Linux
CI when native compilation is prohibited, and report what was not run.

For corpus work, use the runner command in `selfhost.yml` with `SILKC` naming the
built selfhost executable; `SILK_SELFHOST_CORPUS_CASES` selects comma-separated
existing case names. The runner's TypeScript tests protect runner classification,
not compiler semantics. Parser comparison work uses the existing
`compiler/scripts/test-parser.mjs` harness and an already-built executable.
Do not run the full bootstrap suite or rebuild compilers as handoff ceremony.

## Publish and hand off

Follow existing authorization and repository workflow. Normally reuse the task's
PR targeting `selfhost`; an explicit direct-push instruction takes precedence.
Finish all edits before the final push and use CI on that exact head as the
completion guard. Report failures and whether they predate the change.

Report retained proof owners, removed duplication/seams, controls and checks
actually run, Linux timings, structured gaps/not-checked scope, and commit/PR/CI
state. Further audit batches stay within the user's requested scope.
