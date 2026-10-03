---
name: silk-discover
description: Verify the checkout is exactly current remote main, then run a deep parallel Silk sweep for stabilization, documentation drift, simplification, dead-code, and technical-debt leads and file every lead passing the Triage intake bar in Linear. Use only when Julia explicitly invokes this skill or asks for a Silk maintenance sweep.
---

# Discover Silk maintenance work

Read these project-local references completely before acting:

- `../../silk-manager/WORKFLOW.md`
- `../../silk-manager/LINEAR.md`
- `../../silk-manager/DISCOVERY.md`
- `../../silk-manager/REVIEW_BASELINE.md`

This is an inspection and intake skill. It may create or enrich Linear issues. It must not edit
repository source, change GitHub state, switch branches, fetch, or clean the working tree.
It must not run `pnpm check`, the full test suite, or native differential acceptance unless Julia
explicitly requests broader validation. Focused tests and
minimal reproducers are allowed only to give one lead a concrete breadcrumb.

Follow `DISCOVERY.md`'s required three-subagent fan-out, coordinator assignment, coverage ledger,
cross-check, and gap-driven second pass. Respect a user-supplied scope or limit. Without one, do not
cap the result or stop after the first strong finding.

## Procedure

1. Run `DISCOVERY.md`'s remote-main freshness gate before any Linear read, source inspection, or
   subagent spawn. Stop immediately unless local `HEAD` exactly equals the SHA returned by
   `git ls-remote --exit-code origin refs/heads/main`. Never trust a local tracking ref and never
   update the checkout on Julia's behalf.
2. Fetch the canonical Linear project by ID from `LINEAR.md` and verify its team. Never recreate it
   from its display name. If it cannot be resolved, stop before writing. Read all canonical-project
   issues in every status for deduplication.
3. Record the verified remote-main SHA and dirty paths. Review recent commits, active agent tasks or
   worktrees visible in the current environment, open PRs, and active OpenSpec changes so work
   underway is not rediscovered.
4. Execute the parallel assignments in `DISCOVERY.md`. Use the codebase graph first for structural
   discovery. If an index lookup fails, select the index that corresponds to the current repository
   rather than abandoning that lens.
5. Wait for all scouts, then re-run the remote-main freshness gate before doing more expensive work.
   Stop without Linear writes if remote `main` moved. Build the coverage ledger, remove exact
   duplicates and clearly owned work, and spot-check lead provenance. Do not perform triage's
   skeptical review, debatable consolidation, worth judgment, sizing, or prioritization. Run the
   required second pass when the first pass yields fewer than five novel investigable leads or any
   material coverage area remains weak or unchecked.
6. Apply the Triage intake bar from `WORKFLOW.md`. Immediately before the first Linear write,
   re-run the remote-main freshness gate once more and stop if it moved. File every distinct
   investigable lead into the native Triage inbox with its honest confidence, a visible
   `## Why this matters` section, and
   triage questions, including low-confidence leads with a specific starting point. The rationale
   must connect the observation to a concrete affected workflow or system property and a possible
   consequence if ignored; distinguish evidence from inference. Record the verified remote-main SHA
   as both Source baseline and the `discovery intake` Review baseline. Record
   `Triage disposition: intake`. Use no priority or estimate.
   When code or an example clarifies the lead, include the exact current-baseline excerpt and a
   concrete provisional desired-behavior snippet under `WORKFLOW.md`; do not invent a target API
   merely to make the pair complete.
   Use `Bug` only for directly demonstrated defects; otherwise use `Improvement` or no broad label.
   Apply the optional Area label from `LINEAR.md` only when the lead has one clear primary owning
   surface. Leave Area empty when none applies or ownership is uncertain.
7. For an existing issue, add only genuinely new evidence as a dated comment. Do not reopen,
   reprioritize, rewrite a triaged issue, or advance its Review baseline during discovery. A
   mechanical legacy migration from its Source baseline is allowed.
8. Read every changed issue back. Report new issues, enriched issues, and intake exclusions limited
   to exact duplicates, clearly owned active work, or observations too vague to investigate. Also
   report scout completion, the full coverage ledger, commands run, and material gaps.

Every new issue must meet the Triage intake bar in `WORKFLOW.md`, include concrete breadcrumbs,
an explicit causal justification, useful current/desired snippets when applicable, triage
questions, an explicit Area-label decision, and both baseline sections. Draft acceptance is optional
because triage owns the final specification. One excellent issue is not evidence of a thorough
sweep; breadth is demonstrated by completed scout assignments, coverage, and the second-pass rule.
