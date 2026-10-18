---
name: silk-work
description: Claim and implement one triaged Silk Linear issue, follow repository rules, verify the change, and finish with a draft pull request. Use only when Julia explicitly invokes this skill, names an issue to implement, or asks to work the next queued Silk issue.
---

# Work a Silk issue

Read `../../silk-manager/WORKFLOW.md`, `../../silk-manager/LINEAR.md`,
`../../silk-manager/REVIEW_BASELINE.md`, and `../../silk-manager/TEST_REVIEW.md` completely before
acting. Then read the repository `AGENTS.md` and every specialized skill required by the issue.

Subagents are authorized for investigation, bounded non-overlapping implementation, and review.
Keep one coordinator responsible for the Linear issue and do not let agents edit overlapping files.

Input is an explicit Linear issue or an automatic queue selection under `LINEAR.md`. Fetch and
verify the canonical project by ID; never recreate it from its display name. For automatic
selection, first read all Todo issues. If Todo is nonempty, choose its highest-priority oldest
unblocked issue; when every Todo issue is blocked, stop rather than falling back. Only when Todo is
literally empty, fall back to the highest-priority oldest unblocked Backlog issue whose description
records `Triage disposition: queue-ready`. A named queue-ready Backlog issue or a Todo issue
overrides automatic selection; never claim an issue still in Triage.

## Admission and claim

Every selected implementation ticket must have completed triage research and independent
skeptical review recorded on the issue, with `Triage disposition: queue-ready`. This applies to
named tickets, Todo, and implementation children. If the marker or evidence is missing, use
`silk-triage` before claiming or editing implementation; preserve a manually curated Todo tier
while reviewing it. Existing recorded research can be reused and its marker normalized after
verification. Never create a research-only ticket to satisfy this gate. Selection and the
attention-cap override do not bypass triage.

Before automatic selection, show existing In Progress issues and In Review issues that currently
need Julia. Do not automatically start a third attention-bearing item. A named issue is an explicit
override of this soft cap.

Record whether the selected issue came from Todo or Backlog before claiming it. This pre-claim tier
controls where interrupted or blocked work returns; agents never promote fallback work into Julia's
Todo queue.

Re-read the selected issue and its Review baseline. Resolve the exact verified work-base commit and
inspect the changed relevant paths from the previous review commit under `REVIEW_BASELINE.md`.
Revalidate whether the work is still wanted, already delivered, outdated, superseded, or incorrectly
specified before claiming it. If it is already delivered or invalid, apply the truthful Linear state
and, for a Canceled or Duplicate result, set `Triage disposition: terminal`; then update Review
baseline at the work-base commit with the corresponding Outcome. Select the next issue only when
selection was automatic. If the delta cannot be reviewed, do not claim or
advance an established baseline. A legacy unresolved or unknown baseline requires the full
current-state recovery review from `REVIEW_BASELINE.md` before claiming. Otherwise update the issue
specification if needed, including refreshing or removing current/desired snippets invalidated by
the reviewed delta and correcting the Area label when primary ownership changed, set Review
baseline to `Stage: work admission` and
`Outcome: implementation ready`, then set it to In Progress and read it back before editing.

## Implementation

- Work in the current agent task checkout. Preserve the current task's branch or create a
  `julia/`-prefixed feature branch when needed for the required draft PR. Do not switch to or commit
  on `main`.
- Preserve unrelated and uncommitted changes. Stop if they overlap in a way that cannot be handled
  safely.
- Implement the clean green-field design and update all callers, tests, fixtures, generated
  artifacts, and docs in the same change. Remove the superseded path.
- Meet the Linear acceptance criteria literally. If investigation changes the correct solution,
  update the issue specification before implementing the new scope.

## Early draft PR

Prefer committing and pushing a coherent issue-scoped change early in implementation, then creating
a draft PR targeting `main` so CI can start. Audit the staged patch and complete branch diff for
unrelated work before publishing. Reuse an existing PR only when its branch and scope belong to this
issue, and keep it a draft. Follow the Pull request quality bar in `WORKFLOW.md`, with remaining
implementation, checks, and reviews explicitly pending. Link the draft from Linear while keeping
the issue In Progress and preserving its work-admission Review baseline until handoff.

Use early pushes to get CI feedback while implementation continues. Before the final push, finish
all repository mutations, including generated artifacts, then audit, commit, and push the intended issue head. After a review or CI fix, run the
affected focused checks, audit, commit, and push the replacement head.

## Verification and review

Use the cheapest focused tests that falsify each claim. Run a broader local command only when it
provides change-specific evidence that pull-request CI does not, reproduces or diagnoses a CI
failure, or Julia explicitly requests it. Required pull-request CI on the exact final head is the
authoritative full-repository completion guard; do not duplicate its full suite locally as handoff
ceremony. Do not say work is complete while required CI is pending or failed; name the exact gap
and whether it predates the change.

Task lists contain implementation deliverables, not workflow gates. Never add or retain a
task whose sole action is running or recording verification commands, obtaining review approval,
waiting for CI, updating the PR or Linear issue, or reporting handoff. Test code and other durable
acceptance evidence may be implementation tasks; executing the eventual gate is not. Complete all
implementation-task checkboxes before the final push so a green CI result never requires a
follow-up repository edit or empty push.

Do not add tests by default merely because production code changed. Every new or expanded test must
justify its unique signal, execution complexity, optimization state, and measured contribution to
default-suite time under `TEST_REVIEW.md`.

Self-review every diff through three lenses: does it solve the acceptance criteria, is it simpler
than the code it replaces, and would the tests fail if the behavior regressed? Use an independent
reviewer subagent when it materially improves confidence, especially for medium, large,
cross-package, or high-risk changes. Independently verify its findings.

After focused implementation checks stabilize, assign a separate mandatory test-economics reviewer
subagent. It must follow `TEST_REVIEW.md`, inspect the exact issue-scoped diff and affected test
execution, measure the runtime cost, and return `approve` before handoff. The coordinator verifies
and fixes valid findings, reruns affected checks, and repeats the review until the final committed
PR diff is approved. A general reviewer cannot double as the test-economics reviewer.

## Draft PR and handoff

A `silk-work` run is not finished until the completed change has a confirmed draft pull request,
required CI is green on its exact final head, and the required reviews are complete. Finalize the
draft opened during implementation:

1. Confirm every implementation task is complete and the latest intended issue changes are
   committed and pushed on the non-`main` branch.
2. Give the test-economics reviewer the exact committed issue diff. If commit hooks, generated
   artifacts, or review fixes alter it, audit, commit, and push the update before rerunning affected
   focused checks and repeating review until the committed diff is approved.
3. Wait for every required CI job to pass on that exact pushed head. A failure starts a new
   fix-and-push cycle; a pass requires no repository change.
4. Update the draft PR under the Pull request quality bar in `WORKFLOW.md`. Include the Linear
   issue link, outcome, acceptance evidence, focused checks run, exact-head CI result,
   test-review verdict and timing delta, and risks or deferred checks.
   Strongly prefer concise `Before` and `After` code or output examples when they materially clarify
   the delivered change; omit them only when examples would add no useful signal or would
   misrepresent the work.
5. Reuse the branch's existing PR rather than creating a duplicate and ensure it is
   still a draft. Never mark the PR ready for review as part of this skill.
6. Read the PR back and confirm its URL, draft state, head SHA, and required CI result match the
   verified committed change before treating the run as complete.
7. Add the confirmed draft PR link and the same verification evidence to Linear. Update Review
   baseline to the exact committed PR-head SHA with `Context: PR <number> head`,
   `Stage: implementation handoff`, and `Outcome: implementation complete`; then move the issue to In
   Review and read it back.

Draft-PR creation is a required delivery step, not an optional action requiring a separate prompt.
If committing, pushing, or creating or confirming the draft PR fails, do not claim completion and
do not move the issue to In Review. Preserve the work and report the exact blocker.

If blocked before handoff, do not hide partial work. Add or update `## Gate`, apply `Blocked`, return
the issue to its pre-claim queue tier, and comment with what completed and exactly what unblocks it.
Use Backlog when the prior tier cannot be established; never fill Todo by inference. If
implementation fails without a real external gate, leave it In Progress only while this task
remains the active owner and will continue the same implementation. If the run is ending or
abandoned with no live owner, restore the pre-claim tier, do not apply `Blocked`, and comment with
the completed work and unresolved failure.
