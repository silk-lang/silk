# Running CI on a branch

The non-required `Windows native execution` workflow runs automatically after N1 on main pushes
and PR pushes carrying the `windows` label. It reuses the same N1, including the exact synthetic
merge revision on a PR. If main reuses a green same-tree run, Windows consumes that run's N1 and
recorded source revision. Neither the required Linux check nor publication depends on the full
Windows regression lane. Label a PR before its next push to opt it in, or dispatch Selfhost with
`inputs[windows-native]=true` for an existing branch head.

Standalone dispatch can consume a successful `selfhost-native-n1` artifact from an earlier
dispatched Selfhost run. It verifies the build receipt against that compiler's source commit,
cross-builds the workflow revision's fixtures on Linux, and executes them on `windows-2025`.
It also exports generated reference pages and optional replay controls without rebuilding N1:

```sh
gh api -X POST repos/silk-lang/silk/actions/workflows/windows.yml/dispatches \
  -f ref=feature/windows-support -f 'inputs[source-run]=<selfhost run id>'
```

The workflow revision must contain the Windows cross-build and execution harness. The run records
both the tested revision and the N1 compiler revision. A previous N1 can validate new library sources;
compiler changes need a new N1 before their behavior is validated. Standalone dispatch refuses PR
artifacts because their synthetic merge revision differs from the API head revision; the reusable
Selfhost invocation supplies that exact merge revision instead. Native results are retained in `windows-native-results`,
with unexecuted claims reported separately. This route can validate Windows even when unrelated
Selfhost jobs fail after producing a successful N1.

Selfhost CI (`.github/workflows/selfhost.yml`) runs on every push to a pull request into `main`; a
newer push cancels the PR's older run. `main` runs it on every push and on the nightly schedule.
A branch without a pull request into `main`, such as the head of a stack, runs it only when
someone dispatches the workflow on that branch (below).

A main push skips the gate when a fully green pull request or dispatch run of the merged PR's head
tested exactly the tree the merge produced. A pull request run tests the PR merged into `main`, so
it matches as long as `main` has not moved since that run.

The managed release PR (`release/compiler-stable`) is refreshed after every main push but not
verified. Merging it runs every gate on `main` before publishing, so dispatch the workflow on it
only when you want a verdict ahead of the merge.

## Dispatching a run

Before you trigger:

- Commit and push everything. The run tests the branch head as pushed.
- Merge `main` into the branch first when the run is meant to gate the merge. The run tests the
  branch head, not a merge with `main`, and a main push reuses its verdict only when the trees match.
- In a stack, trigger only the head of the stack.

## Trigger

REST through `gh api` (GraphQL `gh pr` commands are blocked in cloud sessions):

```sh
gh api -X POST repos/silk-lang/silk/actions/workflows/selfhost.yml/dispatches \
  -f ref=<branch> -f 'inputs[release]=none'
```

It prints nothing on success (HTTP 204). With the GitHub MCP server, call `actions_run_trigger`
with `method: run_workflow`, `owner: silk-lang`, `repo: silk`,
`workflow_id: selfhost.yml`, `ref: <branch>` and `inputs: {"release": "none"}`.

Never pass `release: dev` or `release: stable` on a branch; those modes only apply on `main`.

## Find the run

```sh
gh api "repos/silk-lang/silk/actions/workflows/selfhost.yml/runs?branch=<branch>&event=workflow_dispatch&per_page=1" \
  --jq '.workflow_runs[0] | {id, head_sha, status, conclusion, html_url}'
```

The run's checks attach to the branch head commit, so they show on the pull request. The merge gate
is `Focused Linux Silk` passing on the PR's exact head. A new push needs a new dispatch; an older
run's verdict does not carry over. Dispatching again on the same branch queues behind the current
run instead of cancelling it, so cancel a run you no longer need:

```sh
gh api -X POST repos/silk-lang/silk/actions/runs/<run id>/cancel
```

## Release archives

Every release archive is built on Linux. After the N2 fixpoint, Selfhost invokes
`release-cross.yml` with the verified Linux N1, the immutable source snapshot and the profile the
Linux N2 trained on. Its `cross` matrix runs `.github/scripts/release-build.sh` with N1, one job per
target, for each of
`x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `aarch64-apple-darwin`,
`x86_64-apple-darwin` and `x86_64-pc-windows-msvc`, with no SDK or sysroot: Linux and macOS links
use Silk's own glibc and libSystem stubs, Windows links its own import libraries. Every compiler
but Windows is optimized by that one profile, since the emitted IR names no target. The job packs
`silk-<version>-<target>.tar.gz` (a ZIP for Windows) with `ReleaseArchive.ts`.

Each target's runner then only verifies: it unpacks its archive and runs `release-build.sh` again
with the archive's compiler (`windows-release.ps1` on Windows), and the compiler and tool it
builds must be the cross-built bytes, and the compiler's IR the IR N1 emitted on Linux. A
difference is a determinism bug in the compiler or its link: fix it, never compare around it. The
runner then smokes the archive and runs the corpus with the release compiler (x86-64 Linux runs it
with N1 in the corpus job). `x86_64-apple-darwin` rebuilds on `macos-15` under Rosetta, because
LLVM publishes no Intel macOS Clang, and `macos-15-intel` runs the archive and the self-contained
corpus natively with Homebrew's LLVM. Publication signs and publishes the cross-built archives only after every verification
passes; each target's receipt and seed candidate come from its verification.

`compiler/native-seed.json` pins only the x86-64 Linux seed: every other target's compiler is
cross-built from it. Changing the pin is a separate, explicit decision. A release's own
`native-seed.json` names every target's compiler; a pin bump keeps only its x86-64 Linux entry.
The installers do not read it: they trust the archive's minisign signature.
