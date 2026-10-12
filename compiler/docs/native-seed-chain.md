# Native seed chain

**Status:** milestone 1 of removing TypeScript from the selfhost development loop (roadmap #567).

CI builds the next native compiler with a published native compiler, pinned by SHA-256 in a
committed file. The TypeScript bootstrap never builds the compiler that CI tests; a broken chain
recovers from an earlier published native seed.

## Generations

| Name | Built by                       | From                                                       |
| ---- | ------------------------------ | ---------------------------------------------------------- |
| seed | an earlier `selfhost` push run | the pin                                                    |
| N1   | the seed                       | this checkout's `compiler/` and `packages/compiler/stdlib` |
| N2   | N1                             | the same inputs                                            |

Every generation compiles the exact committed inputs exported by `SourceSnapshot.mjs` from Git
objects, never the working tree. Each compiler build passes `--stdlib` pointing at the snapshot's
standard library, so the seed always compiles the stdlib of the checkout, not the one it was built
from.

## The pin

`compiler/native-seed.json` is the only seed authority. It names one published release:

```json
{
  "schemaVersion": 1,
  "seed": {
    "_tag": "Release",
    "target": "x86_64-unknown-linux-gnu",
    "tag": "native-seed-<source commit>",
    "asset": "silk-compiler-x86_64-unknown-linux-gnu",
    "sha256": "<64 hex>",
    "sourceCommit": "<40 hex>",
    "runId": "<publishing selfhost push run>"
  }
}
```

Every published candidate carries its pin as `native-seed.json` in this exact form, so moving to
any published seed, newer or older, commits that file verbatim.

### Storage: GitHub Release assets

A seed is an asset of a prerelease named after its source commit. The seed job downloads it with
`gh release download` and `NativeSeed.mjs` checks its SHA-256 against the pin before it sets the
executable bit or runs it. A mismatch fails the job; nothing falls back.

Why releases:

- Actions artifacts expire after the retention window (7 days here, at most 90), so a pin to an
  artifact silently stops working when the branch is quiet for a week.
- A release asset is durable, addressable by tag and name, readable with the default
  `contents: read` token, and needs no extra service, registry or secret.
- Only one job needs write access: the publisher, on `selfhost` pushes, with job-scoped
  `contents: write`. Pull requests never publish.
- A committed binary would grow the repository on every advance. The pin stays a few lines.

The SHA-256 in the pin is the trust anchor; the release only stores bytes. A replaced asset fails
verification instead of executing.

## The gate

Jobs in `.github/workflows/selfhost.yml`:

1. **Native N1 from pinned seed** obtains and verifies the seed, exports the snapshot, builds N1
   with it (`NativeBuild.ts`), smoke-tests N1 with the corpus program
   `trivial-features` (exit 42), and runs the native contract tests. On pull requests it also runs
   the main-first bootstrap provenance check.
2. **Native seed chain (N2 fixpoint)** builds N2 with N1, emits the compiler's LLVM IR with both N1
   and N2, requires the two IR files to be byte-identical, and smoke-tests N2
   (`NativeBuild.ts --fixpoint`). The N2 build and N1's IR emission run concurrently; on the runner
   each peaked at 4.74 GB, at most 9.5 GB together, inside the 16 GB ubuntu-24.04 runner. This job is the required check that replaces
   **Authored native seed (N0)**.
3. **Selfhost native corpus** builds the formatter safety gate with N1 and verifies repository
   formatting with it, then runs the full corpus with N1 (the verification harness's
   `--mode corpus-full`) and keeps the baseline-pass and accepted-failure checks.
4. **Native selfhost cases** shards build each source test root's runner with N1 (`silkc test`)
   and run it under the per-test time guard.

N1 and N2 are compiled from the same source by different compilers, so identical IR shows that the
seed and N1 agree on the meaning of the compiler. A change to code generation still reaches a
fixpoint at N1/N2; only a seed miscompile or nondeterminism breaks it.

### Reusing a pull request run

Every `selfhost` push runs in its own concurrency group, so no merge's run is replaced while it
waits. A pull request run records the full Git tree it tested (`refs/pull/N/merge`). The first job
of a push or dispatch, **Reuse a green PR run of the same tree**, looks for a completed, fully green
pull request run of the merge commit's second parent whose recorded tree equals `HEAD^{tree}` and
whose N2 artifact verifies by SHA-256 against its pin and receipt. When it finds one, the gate jobs
are skipped, the required check passes on that verdict, the macOS leg runs from the reused run's
N1, and publication uses the reused N2: its pin names the push commit, while its
`chain-receipt.json` still names the pull request merge ref that N2 was built from, whose tree is
identical. The run summary names the reused run. Otherwise, including an expired or unverifiable
artifact, the full gate runs.

## Publication

A successful `selfhost` push run (every job above green) runs **Publish native seed candidate**. It
creates the prerelease `native-seed-<commit>` targeting that commit with:

- `silk-compiler-x86_64-unknown-linux-gnu`: N2;
- `chain-receipt.json`: seed identity, N1/N2 hashes, IR hash, smoke and toolchain facts;
- `native-seed.json`: the ready-to-commit pin for this candidate.

A rerun of the same push run is idempotent: an existing release with byte-identical assets passes,
different bytes fail. Publication never edits the pin. The pin advances only by a reviewed commit
that replaces `compiler/native-seed.json` with a candidate's `native-seed.json`.

To verify publication after a push run: open the run's **Publish native seed candidate** job, then
the release `native-seed-<commit>`; `sha256sum` of the downloaded compiler must equal the `sha256`
in its `native-seed.json` and `output.sha256` of N2 in `chain-receipt.json`.

### Retention

One prerelease per green push accumulates. Older candidates are the recovery path, so pruning must
leave enough of them. Proposed rule, not automated yet: keep the release named by the pin on
`selfhost`, every release named by a pin in the last 30 days of `selfhost` history (so a revert can
return to it), and the 20 newest candidates; delete the rest. Deletion, when added, must read the
current pin first and never touch its tag. Until then candidates are pruned by hand.

## Advancing the pin

Advance when the compiler needs a feature that the pinned seed cannot compile, and otherwise
whenever convenient (a fresher seed builds faster code). Copy the candidate's `native-seed.json` to
`compiler/native-seed.json` in a PR to `selfhost`. Its CI proves the new seed builds this checkout,
reaches the fixpoint and passes the corpus.

## Recovery

When the pinned seed cannot build the checkout, the N1 job fails with an error annotation that
points here. Pick one path; neither happens automatically.

### Staged landing (default)

For a change that makes the compiler's own source use a feature the seed does not know:

1. Land the compiler support for the feature without using it in `compiler/` or in the stdlib.
   The current seed compiles that commit.
2. After its `selfhost` push run publishes a candidate, land a PR that advances the pin to it.
3. Land the change that uses the feature.

The author of the feature runs these steps. Stdlib changes follow the same rule: they keep landing
on `main` first and reach `selfhost` through a sync, and the pinned seed compiles them from the
checkout. A sync that brings stdlib source the seed cannot compile waits until the compiler support
has landed on `selfhost` and the pin has advanced. A toolchain change, such as an LLVM upgrade that
the seed's output must follow, lands the same way.

### Earlier published seed

For a broken chain: the pinned seed miscompiles, the fixpoint fails for a reason a different seed
fixes, or the pinned release asset is lost. Pick the newest published candidate that predates the
fault and still compiles the checkout, and commit its `native-seed.json` as
`compiler/native-seed.json`. The rest of the gate is unchanged: N1 is built by that seed from this
checkout, so the published N2 carries every fix since. After the push run publishes a candidate,
advance the pin to it.

An older seed knows fewer language features. If the checkout already uses a feature that no
surviving candidate before the fault can compile, revert that use, recover the chain, and land the
feature again by staged landing. The orchestrator, or the author whose change needs it, runs this.

## What this replaces

- The **Authored native seed (N0)** job and **Restore authored native seed** job are removed, and
  so is the bootstrap re-seed: no CI path builds a compiler with the TypeScript bootstrap.
- `NativeSeed.mjs` owns the pin: reading it, verifying a downloaded seed, and writing a candidate.
  `NativeBuild.ts` builds any generation from a hash-verified compiler.
- `SourceSnapshot.mjs` still defines the exact inputs.
- `check-native-contracts` runs in the N1 job.
- The corpus and formatter verification no longer use the bootstrap: N1 compiles the corpus and
  builds the formatter safety gate, and the harness's formatter mode only verifies formatting.
