# Running CI on a branch

Selfhost CI (`.github/workflows/selfhost.yml`) does not run on branch pushes or pull request
events. `main` still runs it on every push and on the nightly schedule. A branch runs it only when
someone dispatches the workflow on that branch, so push as often as you like and trigger CI once the
branch is ready for review or merge.

## Before you trigger

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
