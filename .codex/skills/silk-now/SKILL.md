---
name: silk-now
description: Capture one immediate Silk request in Linear, independently triage it, implement the verified issue, and finish with a draft PR and In Review handoff. Use only when Julia explicitly invokes this skill or asks to track and implement a request immediately.
---

# Deliver an immediate Silk request

Read these files completely before acting:

- `../../silk-manager/WORKFLOW.md`
- `../../silk-manager/LINEAR.md`
- `../../silk-manager/TRIAGE.md`
- `../../silk-manager/REVIEW_BASELINE.md`
- `../../silk-manager/TEST_REVIEW.md`
- `../silk-demand/SKILL.md`
- `../silk-triage/SKILL.md`
- `../silk-work/SKILL.md`

Then read the repository `AGENTS.md` and every specialized skill required by the implementation.
The demand, triage, and work contracts apply in that order. This skill composes them into one run;
it does not weaken or skip a stage.

Explicit invocation authorizes the scoped Linear writes, repository changes, issue-only commit,
branch push, and draft pull request required by this flow. It does not authorize changes unrelated
to the current request. Treat Julia's request as an explicit named work item: it overrides automatic
queue selection and the soft cap on attention-bearing items, but it does not automatically make the
issue Urgent or justify distorting its intrinsic Linear priority. Other Linear issues are read-only
context during this combined run: do not change their priority, status, labels, estimate, or
specification merely to normalize the queue.

## Keep the phases visible

At the start, publish and maintain a task plan covering:

1. demand capture and deduplication;
2. independent investigation and skeptical triage;
3. specification and Linear admission;
4. implementation, early draft PR, focused checks, and independent reviews;
5. exact-head CI guard, draft PR update, and Linear handoff.

Only one phase is in progress at a time. Do not begin repository edits while intake or triage is
unfinished.

## 1. Capture the demand

Verify the canonical Linear project by ID and team before writing. Search that project in every
status for the same requested outcome and affected surface.

- Reuse one clear match and record the new direct demand as a dated comment. Do not create a second
  issue merely because the existing title or wording differs.
- When several issues plausibly match, stop before writing and ask Julia to choose.
- When no issue matches, create one Triage issue under the `silk-demand` contract, with no priority
  or estimate, a faithful requested outcome, `## Why this matters`, evidence, draft acceptance, and
  a repository baseline. Read it back.
- Follow a confirmed Duplicate to its canonical survivor. Do not reopen a Canceled issue unless the
  new demand changes the reason it was canceled. Do not recreate work that is already delivered.
- Do not seize an In Progress or In Review issue owned by another task. Continue it only when the
  current checkout and task already own that implementation; otherwise report the existing owner or
  PR and stop.

The resulting issue or canonical survivor is the sole subject of the remaining flow.

## 2. Triage the selected issue

Run the complete `silk-triage` process on this issue even when it was previously Backlog or Todo. Triage MUST
use subagents and remains read-only with respect to repository files:

1. Give one investigator the full issue, previous Review baseline, current triage commit,
   old-to-new changed relevant paths, and suspected overlaps. Require evidence for all five triage
   claims and a queue-ready shape.
2. Give a different subagent the issue and proposed verdict for independent skeptical review.
3. Adjudicate both passes against primary repository, Linear, and GitHub evidence.

Direct demand is strong evidence of value, not proof that the requested diagnosis or solution is
correct. Preserve Julia's desired outcome while allowing triage to replace a proposed mechanism
with the clean bounded design that actually satisfies it. Require a concrete `## Why this matters`,
observable acceptance, priority, estimate, and any genuine gate.

Do not implement unless the final issue is read back as an unblocked Backlog or Todo issue with
`Triage disposition: queue-ready`. Normal triage admission goes to Backlog; this explicit named
immediate flow may claim it directly without adding it to Julia's Todo queue. If triage concludes
Duplicate, continue only through the canonical survivor after the final survivor itself receives
both required independent triage passes, unless current evidence on that exact issue already records
equivalent investigator and skeptic coverage. If the verdict is Canceled or needs more
investigation, stop after recording the truthful Linear outcome. If the request must split, continue
only when one bounded issue clearly delivers the complete immediate outcome; otherwise finish the
planning work and ask Julia which independent slice to implement.

Triage may correct the requested mechanism while preserving the observable outcome. Pause for Julia
before implementation when the evidence instead calls for different user-visible semantics, a
different affected surface, or materially broader scope. Do not reinterpret an ambiguous request
into a behavioral change merely to keep the one-call flow moving.

## 3. Claim and implement

Run `silk-work`'s Admission and claim block before changing status: re-read the admitted issue,
resolve the verified work-base commit, inspect the delta from its previous Review baseline, apply
any resulting specification or state correction, and set the `work admission` Review baseline.
Only after that review succeeds, move the issue to In Progress and read it back before editing.
Then follow the full `silk-work` implementation contract:

- create or preserve a non-`main`, `julia/`-prefixed branch before source edits;
- preserve unrelated and uncommitted work, stopping when overlap cannot be handled safely;
- implement the clean green-field design, including callers, tests, fixtures, generated artifacts,
  and documentation, and delete the superseded path;
- keep the Linear specification current when implementation evidence changes the correct scope;
- follow the early draft publication steps below, using focused checks during implementation and
  completing all repository mutations before the final push;
- treat required pull-request CI on the exact final head as the authoritative full-repository
  completion guard; do not duplicate the complete CI-covered suite locally as handoff ceremony.

Do not let the word “immediate” justify skipping design work, characterization, required tests, or
the repository's CI guard.

### Publish the draft early

Prefer opening the draft as soon as there is a coherent issue-scoped commit during implementation.
Focused tests may run during development; do not wait for independent review approvals to publish
the draft.

1. Resolve the actual intended PR base, verify its current remote commit, and compute the issue
   branch's merge-base with it. Do not assume a possibly stale local `main` is the comparison base.
2. Stage only the selected issue's patch and audit the staged diff before committing. Commit it on
   the non-`main` branch, then audit working-tree residue, the issue commits since the verified
   merge-base, and the complete three-dot branch diff. The branch must contain only work owned by
   this issue. If it does not, safely isolate the issue on a clean `julia/` branch or stop; never
   publish unrelated commits or changes.
3. Push the audited branch and create or reuse a draft PR targeting the verified base. Reuse a PR
   only when its head branch and complete scope belong to this issue. Never repurpose an unrelated
   PR or turn a PR that is already ready for review back into a draft.
4. Follow the Pull request quality bar in `WORKFLOW.md`, linking the Linear issue and
   describing the current implementation. Mark remaining work, focused checks,
   CI, and reviews as pending where appropriate. Confirm the PR URL, base, head branch, and draft
   state, and link it from Linear. Keep the issue In Progress until the verified handoff.
5. Complete every repository mutation before the final push. If isolation, commit hooks, formatting, generated artifacts, or review fixes change the
   branch diff, audit, run affected focused checks, commit, push, and repeat the independent
   reviews as needed.

## 4. Review and hand off

After implementation and focused checks, require an independent reviewer subagent to inspect the
complete diff against the Linear problem, rationale, acceptance criteria, repository policy, test
strength, and accidental scope. The reviewer does not edit. Verify every finding yourself, fix valid
issues, commit and push fixes, and rerun affected checks. Repeat independent review after fixes. A
final review after the commit must inspect the exact published PR diff; handoff cannot rely only on
a review of the pre-commit working tree.

Assign a second, distinct reviewer subagent solely for test relevance, execution complexity,
optimization, scaling, and measured runtime cost under `TEST_REVIEW.md`. The general reviewer may
not fill this role. Both reviewers must approve the exact final committed PR diff.

Finish exactly as `silk-work` requires:

1. Confirm every implementation task is complete and the intended issue changes are committed and
   pushed. Require both reviewers to approve the exact committed three-dot diff with no unresolved
   material finding. For further fixes, run affected focused checks, push, and obtain updated
   reviews.
2. Wait for every required CI job to pass on that exact pushed head. A failure starts a new
   fix-and-push cycle; a pass requires no repository edit.
3. Update the existing draft under the Pull request quality bar in `WORKFLOW.md`. Include the
   Linear link, accepted outcome, focused local evidence, exact-head CI result, test-review verdict
   and timing delta, and risks in a clear PR body. Strongly prefer concise
   `Before` and `After` code or output examples when they
   materially clarify the delivered change; omit them only when examples would add no useful signal
   or would misrepresent the work.
4. Read the PR back and confirm its URL, verified base, expected head branch and SHA, draft state,
   required CI result, and issue-scoped diff.
5. Comment on Linear with the PR and verification evidence, move the issue to In Review, and read it
   back. The description must now carry the exact committed PR-head SHA as its
   `implementation handoff` Review baseline.

The run succeeds only when the draft PR and In Review handoff are confirmed. Follow `silk-work`'s
truthful blocked and failure states when any earlier phase cannot complete; never skip ahead or mark
the issue Done.
