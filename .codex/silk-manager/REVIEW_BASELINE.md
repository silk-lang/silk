# Linear issue review baselines

Read this reference whenever a `silk-*` workflow creates an issue or technically reviews an existing
one.

## Two different baselines

Keep provenance and currentness separate:

- `## Source baseline` records the context that originally produced the issue. It is immutable.
- `## Review baseline` records the most recent commit against which an agent completed the review
  appropriate to the named stage. It moves only after real revalidation.

Every new issue includes both. Preserve an existing Source baseline when triage rewrites the issue.
For a legacy issue with no Review baseline, use its trustworthy Source baseline as the previous
review context with `Stage: legacy source (depth unknown)` and `Outcome: intake only`. If no
trustworthy commit exists, use the explicit unknown legacy shape below; never invent one.

Use this description shape:

```markdown
## Review baseline

- Commit: `<full SHA>` | unknown (legacy only)
- Context: remote main | checkout HEAD | PR `<number>` head | merged commit | legacy source (unresolved) | legacy source (unknown)
- Stage: legacy source (depth unknown) | demand intake | discovery intake | triage | work admission | implementation handoff | sync
- Outcome: intake only | confirmed current | specification revised | implementation ready | implementation complete | delivered | terminal
- Working tree: clean | dirty | not applicable | unknown (legacy only)
- Relevant paths: `<paths or repository-wide>`
- Reviewed at: `<ISO-8601 timestamp>` | unknown (legacy only)
```

`Commit` is always the full object SHA actually inspected. `Context` prevents a PR-head or checkout
commit from being mistaken for remote main. Intake stages capture context but do not claim full
technical validation; later stages must not treat `intake only` as a triage verdict.

The only exception is mechanical legacy migration. When Source baseline contains a full SHA that is
not currently resolvable, copy it with `Context: legacy source (unresolved)`. When no trustworthy
SHA exists, use `Commit: unknown` and `Context: legacy source (unknown)`. Copy Source working-tree,
paths, and timestamp when present; otherwise use the allowed unknown values. This section records
inherited provenance, not a completed technical review, and cannot be advanced until an agent can
perform the comparison required below or the one-time full legacy review described below.

## Advancing a review baseline

Before changing the section:

1. Read the existing Source and Review baselines.
2. Resolve the exact commit appropriate to the stage. Discovery uses its verified remote-main SHA;
   triage and work admission use the reviewed checkout or verified work base; implementation
   handoff uses the exact committed PR head; sync uses the exact main, PR-head, or merged commit that
   supports its conclusion.
3. Compare the previous review commit with the target commit. Start with changed relevant paths and
   commit history, then inspect the affected symbols, docs, tests, issues, and PRs
   needed to answer:

   - Is the requested outcome still wanted under current explicit demand and project direction?
   - Has it already been implemented, fixed, removed, or otherwise delivered?
   - Did code or documentation changes make the evidence, rationale, scope, or proposed mechanism
     stale?
   - Does another issue, branch, or PR now own or supersede the work?
   - Do the acceptance criteria still describe the smallest correct remaining change?

4. Apply the resulting specification, relation, gate, priority, or status correction first.
5. Only after the issue reflects that conclusion, replace Review baseline with the target commit and
   read the issue back.

Do not advance the baseline merely because an agent opened the issue, observed a newer commit, or
changed an unrelated field. For an established technical Review baseline, if the previous commit is
unavailable or the delta cannot be evaluated, retain it and comment with the exact missing evidence
or access required.

A legacy unresolved or unknown baseline has one recovery path: perform a full current-state
technical review of the entire issue, inspect all available repository and issue history, explicitly
record that the historical commit delta was unavailable, and then establish the first real Review
baseline at the target commit. This is a from-scratch review, not a presumed no-change bump.

When the delta changes the conclusion, add a dated Linear comment naming the previous and new full
SHAs, the relevant changed paths, and the effect on the issue. Keep the description as the current
specification rather than a review log.
