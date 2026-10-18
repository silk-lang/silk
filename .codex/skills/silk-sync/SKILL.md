---
name: silk-sync
description: Reconcile Silk Linear issues with repository, branch, and GitHub PR reality, applying only unambiguous status corrections and reporting uncertain drift. Use only when Julia explicitly invokes this skill or asks to sync the Silk queue.
---

# Sync the Silk queue

Read `../../silk-manager/WORKFLOW.md`, `../../silk-manager/LINEAR.md`, and
`../../silk-manager/REVIEW_BASELINE.md` completely before acting.

This skill performs periodic reconciliation. It may update existing Linear issues. It must not edit
repository source, switch branches, delete worktrees, clean files, push, merge, close PRs, or create
new maintenance issues.

## Procedure

1. Fetch the canonical Linear project by ID from `LINEAR.md` and verify its team. Never resolve or
   recreate it by display name. Read its nonterminal issues. If it cannot be resolved, stop before
   writing.
2. Inspect the current checkout, local and remote branch information already available, and GitHub PRs for `julia-script/silk`. Do not fetch unless Julia asks.
   For each issue selected for technical reconciliation, read its Review baseline, resolve the exact
   main, PR-head, or merged commit that can support the conclusion, and inspect the changed relevant
   paths since its previous review.
3. Match by explicit Linear link, Linear-generated branch identifier, or an unambiguous issue
   identifier in a branch or PR. Never match by title alone when more than one issue is plausible.
4. Apply high-confidence corrections directly:

   - legacy Backlog intake with missing, `intake`, or `needs-more-investigation` Triage disposition
     -> Triage, preserving its baseline;
   - issue with `Triage disposition: queue-ready` accidentally left in Triage -> Backlog unless
     Julia already curated it into Todo;
   - merged PR or otherwise proven delivery -> Done;
   - open PR with matching work and confirmed completion of required implementation, verification,
     and reviews -> In Review; an early draft with work or checks pending stays In Progress while
     its implementation task is active. Draft existence alone is not handoff evidence;
   - unambiguously abandoned In Progress work with no live task, branch, or PR owner -> its
     pre-claim Todo or Backlog tier from issue history, defaulting to Backlog when unknown;
   - closed unmerged PR with unfinished work -> its pre-claim Todo or Backlog tier, with a comment;
   - issue proven owned by another issue -> Duplicate with a native relation;
   - resolved `## Gate` -> remove `Blocked` without changing its existing Backlog or Todo tier;
   - Backlog or Todo claim already implemented on the recorded baseline -> Done when delivery is
     proven, otherwise Canceled with evidence.

5. Re-read every issue before and after mutation. Preserve priority, estimate, relations, and
   specification unless the observed transition requires a focused note. When reconciliation fully
   revalidates the issue, apply the state/specification conclusion first and then advance Review
   baseline to the exact supporting commit with `Stage: sync`. During that review, also reconcile
   the optional Area label and description line under `LINEAR.md` when primary ownership changed;
   leave the Linear Area field empty and record `none` when no Area applies. Use
   `Outcome: delivered` or `Outcome: terminal` for final states and the accurate nonterminal Outcome
   otherwise. If the old-to-new delta for an established baseline cannot be inspected, retain it and report the gap.
   A legacy unresolved or unknown baseline may advance only after the full current-state recovery
   review in `REVIEW_BASELINE.md`.
6. Report but do not automatically reset ambiguous stale In Progress work, In Review issues without
   a PR, possible overlaps, unresolved gates, dirty worktrees, or branches that may belong to a live
   agent task. Give the evidence and the smallest next decision.
7. Report applied transitions, unresolved drift, previous-to-current review commits, queue head,
   and coverage. A fully consistent sync is a useful result; do not invent cleanup.

Obvious reconciliation does not need a separate proposal/apply ceremony because invocation of this
skill is the scoped authorization. Ambiguous or destructive action still requires Julia's decision.
