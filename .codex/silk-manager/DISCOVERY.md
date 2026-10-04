# Thorough discovery procedure

Read this reference only for `silk-discover` runs.

## Remote-main freshness gate

Run this gate before reading Linear, inspecting sources, or spawning a subagent:

1. Read the local commit with `git rev-parse HEAD`.
2. Query the authoritative remote ref with
   `git ls-remote --exit-code origin refs/heads/main`.
3. Require exactly one full remote commit SHA and exact equality with local `HEAD`.

Do not trust the local `origin/main` ref; it can be stale. Do not fetch, pull, switch, merge, rebase,
or update the checkout. If the remote query fails, returns an ambiguous result, or differs from
`HEAD`, stop immediately before Linear reads, fan-out, or writes. Report the local and remote SHAs
when known and say that discovery requires a checkout at the latest remote `main`.

Record the verified remote SHA as both the immutable Source baseline and the initial Review baseline
for every new lead, with `Stage: discovery intake`, `Outcome: intake only`, and `Context: remote
main`. Give it to every scout. Re-run the same remote query after the first scout fan-in, before any
second pass, and once more immediately before the first Linear write. If remote `main` changed at
either checkpoint, stop without filing or enriching issues. Never publish leads from a superseded
baseline.

## Required fan-out

Use the available collaboration slots. After the coordinator captures the baseline and current
Linear/OpenSpec exclusion set, spawn three subagents in parallel. The coordinator remains active as
the fourth scout. If collaboration tools are unavailable or the required scouts cannot be started,
report the discovery run as incomplete and stop before filing issues. A sequential solo sweep does
not satisfy this skill.

No scout writes repository files, Linear, GitHub, git state, or shared scratch. Scouts return
evidence to the coordinator, which is the only Linear writer.

### Scout A — compiler and runtime stability

Inspect the compiler pipeline, ownership and cleanup planning, LLVM-native and LLVM-to-Wasm paths,
standard library runtime contracts, and acceptance tests. Look for reachable correctness gaps,
target disagreement, untested failure or cleanup paths, diagnostic mismatches, nondeterminism, and
brittle boundary handling.

### Scout B — documentation and public surfaces

Compare the prescriptive reference in `apps/docs/content/reference/`, tutorials, alpha-status page,
package READMEs, generated standard-library and diagnostic docs, public barrels, package exports,
examples, CLI help, editor behavior, and implemented APIs. Look for false claims, omissions, broken
links, stale examples, export asymmetry, and undocumented public behavior.

### Scout C — simplification, dead code, and debt

Use the codebase graph across the monorepo. Inspect isolated and low-use symbols, high-complexity or
high-fan-out areas, duplicate concepts, obsolete parallel paths, unused exports and fixtures,
compatibility remnants, suppressions, disabled tests, unsafe casts, TODO/FIXME markers, generated
artifacts, scripts, and configuration. Verify dynamic entry points and package exports before
calling anything dead.

### Coordinator — integration and project health

Inspect build, test, release, CI, package boundaries, active and archived OpenSpec state, recent
churn, issue/PR duplication, and repository-wide gaps between packages. Inspect validation
configuration and existing test coverage without running the full validation suite. Own fan-in,
gap analysis, candidate clustering, and Linear writes.

## Scout return contract

Each scout returns:

```text
coverage:
  - areas and representative files/symbols actually inspected
candidates:
  - title
    theme
    area_label: Docs | Standard library | Compiler | LSP | none
    scope
    confidence: high | medium | low
    observation
    why_it_might_matter:
      affected_workflow_or_property
      causal_chain
      consequence_if_ignored
      uncertainty
    evidence
    current_snippet_if_useful:
      path_and_symbol
      exact_excerpt
      observed_behavior
    provisional_desired_snippet_if_useful:
      concrete_example
      intended_observable_difference
    draft_acceptance_if_obvious
    triage_questions
    possible_overlap
intake_exclusions:
  - exact duplicate, clearly owned work, or vague observation and the evidence for exclusion
not_checked:
  - area and reason
```

High-, medium-, and low-confidence leads can all be valid Triage material when they identify a
specific investigable subject and state the open question honestly. Confidence guides triage; it
is not a discovery gate. The justification may be a hypothesis, but it must connect the observed
condition to a concrete possible consequence rather than restating that the code is large,
duplicated, old, or unusual. Reject vague suspicions with no reproducible starting point or no
articulable reason to investigate them.

## Fan-in and second pass

Wait for every scout. Normalize lead wording and merge only obvious duplicates that cite the same
subject and suspected problem. Leave debatable grouping and splitting to triage. Search all Linear
states, open PRs, and active OpenSpec changes before creating anything.

Spot-check lead identity, provenance, and rationale during fan-in. This is not a skeptical or
adversarial review. Confirm that the cited subject exists, the evidence was not fabricated, the
lead is not an exact duplicate or clearly owned by active work, and `Why this matters` states a
specific causal hypothesis rather than merely repeating the observation. Verify that any proposed
Area label names one clear primary owning surface under `LINEAR.md`; use `none` rather than guessing.
Leave verification of that impact, final design, and worth to triage.

Build a coverage ledger for these areas:

- compiler frontend, analysis, HIR, MIR, ownership, compile-time evaluation, and diagnostics;
- LLVM-native and LLVM-to-Wasm lowering, finalization, and runtime support;
- standard library and runtime services;
- CLI, formatter, LSP, editor support, docgen, VS Code, and webcontainer platform;
- reference docs, tutorials, generated docs, READMEs, and examples;
- tests, scripts, package exports, CI, release validation, and OpenSpec hygiene.

Run a gap-driven second pass whenever the first fan-in yields fewer than five novel investigable
leads OR the coverage ledger contains a material weak or unchecked area. Lead count never excuses a
coverage gap. Page through broad graph results rather than inspecting one arbitrary result page.
Run focused read-only commands or a narrow candidate-specific test when it can give a vague
suspicion a concrete starting point. Continue until every material ledger area has a meaningful
check or an explicit unavailable-source reason.

There is no target quota and no maximum issue count. File every distinct lead that passes the
Triage intake bar. The expected result of a broad sweep is often several issues; zero or one is
credible only after the second pass and a coverage ledger that shows where the search found no
additional investigable lead.

## Test boundary

Discovery does not run `pnpm check`, the full test suite, or native differential acceptance by
default. Those commands validate solutions; they
belong to triage when needed to decide a lead, or to work when verifying an implementation.

A scout may run one focused test, package check, dry run, or minimal reproducer when that is the
cheapest way to turn a suspected lead into a concrete starting point. Keep the scope narrow and
record the exact command. Run broader validation only when Julia explicitly asks for a validation
sweep as part of discovery.

## Linear write phase

After the final remote-main freshness check succeeds, the coordinator writes sequentially after
fan-in. New issues enter the native Triage inbox with no priority or estimate. For an existing
issue, add only new evidence as a dated comment. Every new description includes a visible
`## Why this matters` section, `Triage disposition: intake`, plus Source and Review baselines. When
a short code, configuration, diagnostic, or API example materially clarifies the lead, also include
the exact current-baseline snippet and a concrete provisional desired-behavior snippet under the
shape and safeguards in `WORKFLOW.md`.
Read every write back and confirm that the sections and fenced code survived rendering. Discovery
evidence added to an existing issue does not advance its Review
baseline because discovery does not perform the issue's technical triage. A touched legacy issue
may receive the mechanical Source-to-Review migration from `REVIEW_BASELINE.md` without claiming a
new review.

The final report includes:

- issues created and existing issues enriched;
- leads not filed because they were exact duplicates, clearly owned, or too vague to investigate;
- the coverage ledger, including every uninspected area;
- scout count and whether every assignment completed;
- focused probes run and exact results;
- source baseline and treatment of dirty paths.
