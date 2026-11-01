# Running CI on a branch

The separate, non-required `Windows native execution` workflow consumes the
`windows-no-crt-programs` artifact from a Selfhost dispatch with `windows-smoke=true`.
It checks out the artifact's source commit and verifies its recorded revision before executing
the fixtures on `windows-2025`. It does not rebuild N1 or change Linux/macOS gates:

```sh
gh api -X POST repos/silk-lang/silk/actions/workflows/windows.yml/dispatches \
  -f ref=feature/windows-support -f 'inputs[source-run]=<selfhost run id>'
```

The source commit must contain the Windows setup action and execution harness. Native results
are retained in `windows-native-results`, with unexecuted claims reported separately.

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
