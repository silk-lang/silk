---
name: silk-demand
description: Capture a direct request from Julia as one deduplicated Silk issue in Linear without prematurely prioritizing or implementing it. Use only when Julia explicitly invokes this skill or asks to record a request.
---

# Capture direct demand

Read `../../silk-manager/WORKFLOW.md`, `../../silk-manager/LINEAR.md`, and
`../../silk-manager/REVIEW_BASELINE.md` completely before acting.

Julia's current statement is sufficient evidence that the request was made. A link is useful but
not required. Preserve the requester, requested outcome, context, deadline, and wording when Julia
provides them. Do not invent missing detail or require a person's name when a role is sufficient.

Capture the requested implementation or concrete shipped outcome, not a research, specification,
definition, or ticket-writing deliverable. Keep uncertain acceptance provisional in Triage and
record the research questions on that implementation issue. Research and independent skeptical
review are mandatory triage work before implementation admission; every decomposed child must
pass that process too.

## Procedure

1. Fetch the canonical Linear project by ID from `LINEAR.md` and verify its team. Never resolve or
   recreate it by display name. If it cannot be resolved, stop before writing.
2. Search canonical-project issues in every state for the same requested outcome and affected
   surface.
3. When one issue clearly matches, append the demand as a dated comment. Preserve its status,
   priority, estimate, and specification. A Canceled issue may return to Triage with
   `Triage disposition: intake` only when the new demand directly changes the value judgment that
   caused cancellation; technical invalidation remains canceled until triage. Demand capture alone
   is not a technical review and does not advance Review baseline. If the issue is legacy and lacks
   that section, mechanically seed it from a trustworthy Source baseline under `REVIEW_BASELINE.md`
   rather than using the current commit.
4. When several issues plausibly match, make no write and ask Julia to choose among their links.
5. When no issue matches, create one issue in the native Triage inbox with no priority or estimate.
   Use the issue shape in `WORKFLOW.md`, `Origin: direct demand`, `Triage disposition: intake`, the
   faithful request as evidence, draft acceptance, an immutable Source baseline, and an initial
   Review baseline at the same full commit with
   `Stage: demand intake` and `Outcome: intake only`. Preserve Julia's stated reason in
   `## Why this matters`.
   If no reason was supplied, say that the request is direct demand and list the missing impact as
   a triage question instead of inventing one. When Julia's request or the current repository gives
   enough evidence, add the short paired current/desired snippets described in `WORKFLOW.md`. Copy
   current code exactly and keep a user-supplied desired example faithful; otherwise omit the
   uncertain side and make it a triage question rather than inventing code. Use `Feature`, `Bug`,
   or `Improvement` only when the request clearly fits; otherwise omit the label. Set the optional
   Area label from `LINEAR.md` only when the request has one clear primary owning surface; otherwise
   record `Area label: none` and leave the Linear Area field empty.
6. Read the issue back and report its identifier, title, link, requester, captured outcome, and
   Review baseline commit and stage.

This skill records demand. It does not decide that the requested solution is correct, admit the
issue to Backlog or Todo, edit code, or create a PR.
