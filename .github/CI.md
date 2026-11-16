# Running CI on a branch

Selfhost CI (`.github/workflows/selfhost.yml`) runs on every push to a pull request into `main`; a
newer push cancels the PR's older run. A branch without a pull request into `main`, such as the
head of a stack, runs it only when someone dispatches the workflow on that branch (below).

A push to `main` does not run the gate: the merged PR already passed it. Main runs the gate only to
publish (the nightly dev release, a dispatched release, or the merge of the stable release PR).

Every check must name the regression it catches and be the only check that catches it. Before
adding one, find the existing check that would turn red first; if there is one, do not add it.

The managed release PR (`release/compiler-stable`) is refreshed after every main push but not
verified. Merging it runs every gate on `main` before publishing, so dispatch the workflow on it
only when you want a verdict ahead of the merge.

## Dispatching a run

Before you trigger:

- Commit and push everything. The run tests the branch head as pushed.
- Merge `main` into the branch first when the run is meant to gate the merge. The run tests the
  branch head, not a merge with `main`.
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

Every release archive is built on Linux. Selfhost invokes `release-cross.yml` with N1 and the
immutable source snapshot. Its `cross` matrix runs `.github/scripts/release-build.sh` with N1, one
job per target (`x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `aarch64-apple-darwin`,
`x86_64-apple-darwin`, `x86_64-pc-windows-msvc`), with no SDK or sysroot: Linux and macOS links use
Silk's own glibc and libSystem stubs, Windows links its own import libraries. On publishing runs
the `compiler-profile` job trains a profile first and every compiler but Windows is optimized by
it; pull requests build without a profile. The job packs `silk-<version>-<target>.tar.gz` (a ZIP
for Windows) with `ReleaseArchive.ts`.

Each target's runner then only verifies, with `.github/scripts/release-check.sh`
(`windows-release.ps1` on Windows): the archive's compiler emits its own IR, which must be the IR
N1 emitted on Linux. Apple Silicon and Windows also rebuild the silk tool, which must be the
archive's bytes: that one link proves the link is deterministic and takes nothing from the host. A
difference is a determinism bug in the compiler or its link: fix it, never compare around it. The
runner then smokes the archive and runs the corpus with the release compiler. Intel macOS runs a
corpus cross-built on Linux, because its libSystem stubs differ from Apple Silicon's. Windows also
runs the Windows runtime fixtures and the installers. Publication signs and publishes the
cross-built archives only after every verification passes; each target's receipt and seed
candidate come from its verification.

`compiler/native-seed.json` pins only the x86-64 Linux seed: every other target's compiler is
cross-built from it. Changing the pin is a separate, explicit decision. A release's own
`native-seed.json` names every target's compiler; a pin bump keeps only its x86-64 Linux entry.
The installers do not read it: they trust the archive's minisign signature.
