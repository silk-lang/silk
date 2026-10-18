---
name: silk-triage
description: Validate, deduplicate, specify, size, and prioritize Silk maintenance issues from Linear's native Triage inbox. Use only when Julia explicitly invokes this skill or asks to triage Silk issues.
---

# Triage Silk issues

Read `../../silk-manager/WORKFLOW.md`, `../../silk-manager/LINEAR.md`,
`../../silk-manager/REVIEW_BASELINE.md`, and `../../silk-manager/TRIAGE.md` completely before
acting. Follow `TRIAGE.md`'s required investigator and skeptic fan-out.

Input may be explicit Linear issue identifiers or a batch size. Default to the five strongest
Triage issues, selected by likely impact and evidence rather than identifier order. Unless Julia
says otherwise, choose stabilization leads before feature leads for the default batch.

## Procedure

1. Fetch the canonical Linear project by ID from `LINEAR.md` and verify its team. Never resolve or
   recreate it by display name. Read every Triage issue, the full triaged Backlog, the current Todo
   queue, and plausible duplicates in every state. Backlog is required context for relative
   prioritization; Todo is read-only context because Julia curates it manually. Resolve the exact
   current triage commit. For each selected issue, read its Source and Review baselines and inspect
   changed relevant paths from its previous review commit to the triage commit. If the canonical
   project is unavailable, stop before writing.
2. Launch the parallel investigation waves from `TRIAGE.md`. Every selected issue must receive a
   subagent investigation. Every proposed Backlog, Duplicate, or Canceled verdict must receive an
   independent skeptical pass from a different subagent. The coordinator adjudicates and writes;
   it does not substitute for either pass. Give both passes the previous and current SHAs plus the
   relevant changed-path delta.
3. Consolidate fragments that describe one coherent change. Preserve the best issue, add missing
   evidence there, and mark the others Duplicate with a native relation. Split an overly broad lead
   when independent changes have separate value. Leave uncertain groupings separate.
4. For each selected issue, verify the five triage claims in `WORKFLOW.md`. Use the current
   baseline, codebase graph, relevant docs, tests, package exports, and GitHub PRs. Treat the issue's proposed solution as a hypothesis. Explicitly decide
   whether the issue is still wanted, already delivered, outdated, newly owned elsewhere, or in need
   of revised acceptance because of changes since its Review baseline.
   When the issue concerns a language, compiler, runtime, ABI, ownership, or standard-library
   feature for which established implementations are informative, investigate and cite relevant
   reference implementations. Include direct repository links and, when possible, links to the
   exact source paths or revisions that support the comparison. Treat
   [Zig](https://codeberg.org/ziglang/zig) as a major standard-library reference and
   [Rust](https://github.com/rust-lang/rust) as a major ownership reference; also consult
   [GCC](https://github.com/gcc-mirror/gcc), [LLVM/Clang](https://github.com/llvm/llvm-project), or
   other relevant compiler repositories when their design bears on the feature. Choose references
   by relevance rather than citing every implementation mechanically, and record the behavior,
   tradeoff, or precedent the referenced code establishes.
5. Resolve investigator and skeptic disagreements against repository evidence. When evidence is
   still insufficient, leave normal intake in Triage, set
   `Triage disposition: needs-more-investigation`, and add a focused comment stating what remains to
   investigate. Preserve an explicitly selected Backlog or Todo issue's prior disposition and tier
   when the blocker is only unavailable new evidence. Do not advance an established Review baseline
   when the old-to-new range could not be evaluated. A legacy unresolved or unknown baseline may
   advance only through the full current-state recovery review in `REVIEW_BASELINE.md`.
6. If a claim fails, move the issue to Canceled and comment with the failed claim, evidence, and a
   concrete reopen condition. If another issue owns the work, use Duplicate instead. Apply the
   terminal decision with `Triage disposition: terminal` before updating Review baseline to
   `Stage: triage`, `Outcome: terminal`.
7. If all claims hold, rewrite the description into the queue-ready issue shape from `WORKFLOW.md`.
   Preserve the discovery rationale when verified or replace it with the stronger rationale from
   investigation. Include a concrete `## Why this matters` section that names the present cost or
   risk, affected workflow or system property, causal chain, and consequence of doing nothing.
   Whenever a short example materially clarifies the verified gap, include paired `## Current
state` and `## Desired behavior` snippets under `WORKFLOW.md`. Verify the current excerpt against
   the exact triage baseline, make the desired example express the accepted observable behavior,
   and replace or remove stale intake snippets.
   Never admit Backlog with only an outcome, scope, and acceptance list. Make every acceptance item
   observable. Assign priority, estimate, and a broad existing label. Verify, replace, or clear the
   optional Area label under `LINEAR.md`, keeping the description's `Area label` line synchronized;
   do not force an Area when none applies. Set `Triage disposition: queue-ready`. For a normal
   Triage intake, move it to Backlog. Preserve an explicitly selected issue that was already in
   Backlog or Todo when the verdict remains valid; never promote an issue into Todo.
   Then update Review baseline to the exact triage commit with `Stage: triage` and either
   `Outcome: confirmed current` or `Outcome: specification revised`.
   Preserve the applicable reference-implementation findings and direct repository/source links in
   the rewritten issue so they remain available to the implementer; do not leave them only in the
   investigator's transient notes.
8. When completion is genuinely blocked, admit normal Triage intake to Backlog, add the smallest
   accurate `## Gate`, and
   apply the `Blocked` label. Use native issue relations for issue-to-issue blockers. Split an
   independently useful unblocked slice only when it can ship on its own.
9. Unless Julia says otherwise, place validated stabilization issues from any of the five
   maintenance themes above feature issues within the full Backlog. Encode this in Linear using the
   priority floor and cap from `WORKFLOW.md`, comparing the triaged batch against every existing
   Backlog issue. Do not move, reprioritize, or otherwise normalize Julia's Todo queue, and do not
   reprioritize In Progress or In Review work.
10. The coordinator writes Linear sequentially, reads each changed issue back, and reports the
    verdict, priority, estimate, investigator/skeptic coverage, previous-to-current review commit,
    and one-line reason. Report the new Backlog order separately from the untouched Todo order, and
    name any untriaged Triage issue that plausibly outranks the new Backlog head.

Do not preserve compatibility paths merely because the current code has
them; this repository is green-field.
