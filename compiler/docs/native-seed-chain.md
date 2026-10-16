# Native seed chain

**Status:** milestone 1 of removing TypeScript from the selfhost development loop (roadmap #567).

CI builds the next native compiler with a published native compiler, pinned by SHA-256 in a
committed file. The TypeScript bootstrap never builds the compiler that CI tests; a broken chain
recovers from an earlier published native seed.

## Generations

| Name | Built by                   | From                                                       |
| ---- | -------------------------- | ---------------------------------------------------------- |
| seed | an earlier `main` push run | the pin                                                    |
| N1   | the seed                   | this checkout's `compiler/` and `packages/compiler/stdlib` |
| N2   | N1                         | the same inputs                                            |

Every generation compiles the exact committed inputs exported by `SourceSnapshot.mjs` from Git
objects, never the working tree. Each compiler build passes `--stdlib` pointing at the snapshot's
standard library, so the seed always compiles the stdlib of the checkout, not the one it was built
from.

## The pin

`compiler/native-seed.json` is the only seed authority. It holds independent release pins keyed by
native target. The active schema is version 2; `NativeSeed.mjs` rejects the former single-seed
schema. This change preserves every coordinate of the existing x86-64 pin and adds no ARM64 pin: the
first reviewed ARM64 pins follow publication after merge. A missing target is an explicit error when
requesting a seed.

```json
{
  "schemaVersion": 2,
  "seeds": {
    "x86_64-unknown-linux-gnu": {
      "_tag": "Release",
      "target": "x86_64-unknown-linux-gnu",
      "tag": "native-seed-<source commit>",
      "asset": "silk-compiler-x86_64-unknown-linux-gnu",
      "sha256": "<64 hex>",
      "sourceCommit": "<40 hex>",
      "runId": "<publishing main push run>"
    }
  }
}
```

Supported keys are `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, and
`aarch64-apple-darwin`; each asset is `silk-compiler-<target>`. Pins can name different source
commits on different targets. Every new published candidate carries a complete per-target pin as
`native-seed.json`, so advancing all targets copies that file verbatim. An individual target can
advance by copying only its entry and preserving the other targets' coordinates.

### Install a verified native seed

Install Node 24, the repository's pnpm version, GitHub CLI, and LLVM 22.1.8 for the host. Linux also
needs its C development libraries; macOS needs the Xcode command-line tools and SDK. From the
repository root, choose the host target and run:

```sh
pnpm install --frozen-lockfile
target=aarch64-unknown-linux-gnu # or aarch64-apple-darwin, x86_64-unknown-linux-gnu
node compiler/scripts/NativeSeed.mjs outputs compiler/native-seed.json "$target"
seed_dir=$(mktemp -d)
tag=$(jq -er --arg target "$target" '.seeds[$target].tag' compiler/native-seed.json)
asset=$(jq -er --arg target "$target" '.seeds[$target].asset' compiler/native-seed.json)
gh release download "$tag" --repo silk-lang/silk --pattern "$asset" --dir "$seed_dir/download"
node compiler/scripts/NativeSeed.mjs verify compiler/native-seed.json "$target" \
  "$seed_dir/download/$asset" "$seed_dir/silk"
export SILK_COMPILER="$seed_dir/silk"
export SILK_CLANG="$(command -v clang)"
# The pinned seed predates SILK_CLANG and reads SILKC_CLANG until the next re-pin.
export SILKC_CLANG="$SILK_CLANG"
# On macOS:
# export SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
```

The verification tooling uses JavaScript dependencies, but never invokes the TypeScript compiler.
The ARM64 commands become available once a reviewed pin entry exists. Until then, use a known
verified native compiler or a verified native CI candidate; no target pin is inferred or advanced by
an install command.

### Storage: GitHub Release assets

A seed is an asset of a prerelease named after its source commit. The seed job downloads it with `gh
release download` and `NativeSeed.mjs` checks its SHA-256 against the pin before it sets the
executable bit or runs it. A mismatch fails the job; nothing falls back.

Why releases:

- Actions artifacts expire after the retention window (7 days here, at most 90), so a pin to an
  artifact silently stops working when the branch is quiet for a week.
- A release asset is durable, addressable by tag and name, readable with the default
  `contents: read` token, and needs no extra service, registry or secret.
- Only one job needs write access: the publisher, on `main` pushes, with job-scoped
  `contents: write`. Pull requests never publish.
- A committed binary would grow the repository on every advance. The pin stays a few lines.

The SHA-256 in the pin is the trust anchor; the release only stores bytes. A replaced asset fails
verification instead of executing.

## The gate

Jobs in `.github/workflows/selfhost.yml`:

1. **Native N1 from pinned seed** obtains and verifies the seed, exports the snapshot, builds N1
   with it (`NativeBuild.ts`), smoke-tests N1 with the corpus program
   `trivial-features` (exit 42), and runs the native contract tests.
2. **Native seed chain (N2 fixpoint)** builds N2 with N1, emits the compiler's LLVM IR with both N1
   and N2, requires the two IR files to be byte-identical, and smoke-tests N2
   (`NativeBuild.ts --fixpoint`). The N2 build and N1's IR emission run concurrently; on the runner
   each peaked at 4.74 GB, at most 9.5 GB together, inside the 16 GB ubuntu-24.04 runner. This job is the required check that replaces
   **Authored native seed (N0)**.
3. **Selfhost native corpus** builds the formatter safety gate with N1 and verifies repository
   formatting with it, then runs the full corpus with N1 (the verification harness's
   `--mode corpus-full`). Any failed program fails the job. An invalid program the compiler accepts
   is a failure unless every expected diagnostic lies inside the block of a root-package body the
   build reports it did not borrow-check, with a code the build lists for that body; then it is a `BORROW_CHECK_GAP`,
   recorded as `carried` in `compiler/borrow-check-gap.txt`, and a new or vanished carry fails the
   gap check until `update` records it.
4. **Native chain and corpus / aarch64-unknown-linux-gnu** runs on `ubuntu-24.04-arm`;
   **Native chain and corpus / aarch64-apple-darwin** runs on `macos-15`. Both run on pull requests,
   in the merge queue, and on pushes that do not reuse a merge-group run. A pinned target verifies
   its own seed and builds N1 from the committed snapshot. Before its first pin, verified Linux
   x86-64 N1 cross-emits the target's compiler IR, and the native runner links N1 with LLVM 22.
   Each runner builds N2, requires byte-identical N1/N2 IR (and cross-emitted IR for the initial
   hop), runs the native corpus with N1, and uses N2 to compile and execute the `trivial-features`
   smoke program. The required aggregate check includes both targets.
5. **Native selfhost cases** shards build each source test root's runner with N1 (`silk test`)
   and run it under the per-test time guard.

N1 and N2 are compiled from the same source by different compilers, so identical IR shows that the
seed and N1 agree on the meaning of the compiler. A change to code generation still reaches a
fixpoint at N1/N2; only a seed miscompile or nondeterminism breaks it.

### Bootstrap DDC

**Bootstrap builds the compiler (T1 DDC)** keeps the chain from depending only on itself. It bundles
the TypeScript bootstrap from the checkout (`pnpm bundle:cli`) and builds `compiler/silk.toml` with
it. The result, T1, and N1 built by the pinned seed each emit the compiler's LLVM IR. The two files
must be byte-identical: a compiler built by an independent compiler agrees with the chain on the
meaning of the compiler source. The job records a receipt (checkout commit, bootstrap bundle
digest, stage times and peak memory, IR hashes) as the `selfhost-bootstrap-ddc` artifact, so drift
stays visible.

It runs in the merge queue, on every push that does not reuse a merge-group run, and on pull
requests that change `compiler/`, `packages/` or `pnpm-lock.yaml`; on other pull requests it exits
at once and passes. It is part of the required **Focused Linux Silk** check, so a change the
checkout's bootstrap cannot compile, or compiles differently, is red on its own pull request.
Measured locally on 4 cores, the T1 build took 19 minutes at 10.6 GB peak; the receipt records the
runner figures.

The bootstrap and the compiler come from the same commit, so no bootstrap artifact is downloaded and
none can expire. A red job means the compiler uses something the bootstrap cannot compile or
compiles differently: repair the bootstrap in the same pull request, or respell the compiler source
and record the divergence in `COMPILER_COMPATIBILITY.md`.

### Reusing the merge queue run

Every merge-group and `main` push run has its own concurrency group, so no merge's run is replaced
while it waits. The merge queue runs the full gate on the exact commit it then fast-forwards `main`
to. The first job of a push, **Reuse the merge queue run**, looks for a green `merge_group` run of
the pushed commit whose x86-64 N2 verifies by SHA-256 against its pin and receipt. When it finds
one, every gate job is skipped, the required check passes on that verdict, and publication uses that
run's candidates for all three targets. The run summary names the reused run. Otherwise, including a
push that bypassed the queue or an expired or unverifiable artifact, the full gate runs.

## Publication

A successful `main` push run (every job above green, or a reused green merge-group run of the same
commit) runs **Publish native seed candidate**. It creates the prerelease `native-seed-<commit>`
targeting that commit with:

- `silk-compiler-x86_64-unknown-linux-gnu`, `silk-compiler-aarch64-unknown-linux-gnu`, and
  `silk-compiler-aarch64-apple-darwin`: each target's native N2;
- `chain-receipt-<target>.json`: N1/N2 and IR identities for that target. The x86-64 receipt also
  includes its detailed smoke and toolchain facts; ARM64 logs and N2 smoke evidence remain in the
  run's diagnostics artifact;
- `native-seed.json`: the complete ready-to-commit per-target pin for these candidates.

Publication waits for the existing Linux gates, both ARM64 chains and corpora, and bootstrap DDC,
in its own run or in the merge-group run it reuses. Before the first ARM64 pins, this establishes
the initial candidates through native cross-emission, without building a compiler with TypeScript.
After a green post-merge push publishes the candidates, a reviewed PR copies the generated pin; this
infrastructure PR advances no pin.

A rerun of the same push run is idempotent: an existing release with byte-identical compiler assets
and pin, and matching receipt compiler/IR identities, passes; differing identities fail. Receipt
timings and runner paths may vary, but published receipts are never replaced. Publication never
edits the pin. The pin advances only by a reviewed commit that replaces `compiler/native-seed.json`
with a candidate's `native-seed.json`.

To verify publication after a push run: open the run's **Publish native seed candidate** job, then
the release `native-seed-<commit>`; `sha256sum` of the downloaded compiler must equal the `sha256`
in its target entry in `native-seed.json` and `output.sha256` of N2 in
`chain-receipt-<target>.json`.

### Retention

One prerelease per green push accumulates. **A release that any `main` pin has ever named is
never deleted**: [hop replay](#hop-replay) rebuilds each pinned seed from the one before it, so the
chain back to the first seed needs every hop. The rule also keeps the 20 newest candidates **per
target asset**. Since a release holds multiple targets, retention keeps the union of those target
rules; a release eligible for any target is kept. `native-seed-retention.yml` (on `main`, weekly)
applies it with `prune-native-seeds.mjs`, which reads the whole pin history of `main` first; the
script has no deletion mode. It reports the decision and target-specific reasons and checks that
every current pin names an existing asset. Candidates can be pruned by hand after review. Immutable
single-seed Git records still supply historical release facts; they are never accepted as an active
pin by `NativeSeed.mjs`.

## Advancing the pin

Advance when the compiler needs a feature that the pinned seed cannot compile, and otherwise
whenever convenient (a fresher seed builds faster code). Copy the candidate's `native-seed.json` to
`compiler/native-seed.json` in a PR to `main`, or copy just the target entries being advanced.
Its CI proves the new seed builds this checkout, reaches the fixpoint and passes the corpus. The
bump merges only once [the bootstrap DDC](#bootstrap-ddc) is green on its head.

## Recovery

When the pinned seed cannot build the checkout, the N1 job fails with an error annotation that
points here. Pick one path; neither happens automatically.

### Staged landing (default)

For a change that makes the compiler's own source use a feature the seed does not know:

1. Land the compiler support for the feature without using it in `compiler/` or in the stdlib.
   The current seed compiles that commit.
2. After its `main` push run publishes a candidate, land a PR that advances the pin to it.
3. Land the change that uses the feature.

The author of the feature runs these steps. Stdlib changes follow the same rule: the pinned seed
compiles them from the checkout, so stdlib source the seed cannot compile waits until the compiler
support has landed and the pin has advanced. A toolchain change, such as an LLVM upgrade that
the seed's output must follow, lands the same way.

### Hop replay

The chain is reproducible one hop at a time, not by jumping: an old seed rarely compiles current
source, because a language or standard-library spelling the compiler adopts invalidates every seed
older than its native support. Each target entry of the committed pin names its source commit, and
that commit's `compiler/native-seed.json` names its predecessor. The committed hash verifies the
current seed; a release-supplied pin does not replace that trust anchor. To reproduce or recover
pinned seed S(k):

1. Check out the source commit S(k) names, and download and verify the seed its pin names, S(k-1).
2. Build N1 from that checkout with S(k-1), then N2 with N1.
3. N2 must emit the compiler's LLVM IR byte for byte as the published S(k) does on the same
   checkout. Replay is established at the IR level; executables can differ with the link
   toolchain.

Repeating from the first pinned seed rebuilds the whole chain, which is why retention keeps every
pinned release. `native-seed-hop-drill.yml` (on `main`, weekly) replays each target's current hop on
its native runner and fails if N1, N2, or the published seed's IR differs. Targets without a
reviewed pin report that no hop exists. For a target's first cross-emitted candidate, its source has
only the x86-64 predecessor: the drill replays that predecessor's native N1 cross-emission, links it
on the target, builds N2, and compares all compiler IR. Historical release coordinates are extracted
from immutable Git records and verified with the current tooling; historical source is exported from
Git objects without replacing the tooling checkout. To recover a chain whose newest seed is lost or
suspect, replay forward from the newest seed that still verifies and pin the result.

The drill replays the pin of the ref it runs on. Schedules run it on `main`; dispatching it on a
pin proposal branch replays the proposed hops before review, which is the evidence a pin PR carries.

### Earlier published seed

For a broken chain: the pinned seed miscompiles, the fixpoint fails for a reason a different seed
fixes, or the pinned release asset is lost. Pick the newest published candidate that predates the
fault and still compiles the checkout, and restore that target's release coordinates in the
version-2 pin. Preserve the other targets. Older releases published before the per-target schema
have immutable single-seed metadata; copy their x86-64 coordinates into the current target entry
rather than installing their old schema. The rest of the gate is unchanged: N1 is built by that seed
from this checkout, so the published N2 carries every fix since. After the push run publishes a
candidate, advance the pin to it.

An older seed knows fewer language features. If the checkout already uses a feature that no
surviving candidate before the fault can compile, revert that use, recover the chain, and land the
feature again by staged landing. The orchestrator, or the author whose change needs it, runs this.

## What this replaces

- The **Authored native seed (N0)** job and **Restore authored native seed** job are removed, and
  so is the bootstrap re-seed: no seed is built with the TypeScript bootstrap. Only
  [the bootstrap DDC](#bootstrap-ddc) builds a compiler with it, as an independent check.
- `NativeSeed.mjs` owns the pin: reading it, verifying a downloaded seed, and writing a candidate.
  `NativeBuild.ts` builds any generation from a hash-verified compiler.
- `SourceSnapshot.mjs` still defines the exact inputs.
- `check-native-contracts` runs in the N1 job.
- The corpus and formatter verification no longer use the bootstrap: N1 compiles the corpus and
  builds the formatter safety gate, and the harness's formatter mode only verifies formatting.
