# Selfhost test-audit campaign

Use this mode only for an explicitly requested whole selfhost subsystem audit.
[SKILL.md](SKILL.md)'s value bar, proof tiers, Linux timing budget, and LOUD GAPS
rules apply throughout. Cover the requested surface without expanding into
bootstrap tests or a repository-wide cleanup.

## 1. Scope and baseline

Record the base SHA, working-tree changes, source-written test roots, fixtures,
shared corpus cases and selfhost track, plus their CI routing and filters. Use
exact-baseline CI results where available. Separate per-test execution timings
from compile-and-run step durations. Run focused controls only where needed and
permitted; mark unavailable baselines as not checked. Failures are not deletion
candidates merely because they fail.

Done when the scope, baseline evidence, and structured gaps are recorded.

## 2. Inventory and read-only ledger

Partition by selfhost owner: lexer/parser, HIR, query/source indexing,
resolution/types/contracts, static evaluation, target selection, MIR/backend, or
corpus runner. Include imported case modules and filtered tests, not just the root
files. Include relevant corpus and C/ABI fixtures even when currently unsupported.
Inspect tests, owners, callers, history, and overlap before editing.

Give each test or case one evidenced decision:

- `R`: retain its contract and distinct failure mode.
- `F`: repair inadequate proof while retaining the contract.
- `C`: consolidate into a named existing root or corpus case.
- `D`: delete with remaining proof or an evidence-backed obsolete contract.

Rows with different claims need separate decisions. Keep unsupported assertions
visible and retain unresolved candidates pending evidence. No deletion quota.

Done when each in-scope case has a decision or an explicit not-checked entry.

## 3. Preservation plan

Name the retained owner and assertions for every contract being consolidated.
Choose structured analysis for semantics, selfhost static evaluation for
compile-time execution, shared native corpus for runtime behavior, and structural
or C-fixture evidence for lowering/ABI. Successful analysis does not subsume
execution, and end-to-end success does not subsume a structural invariant.

For slow cases, plan smaller fixtures and shared analysis snapshots before
splitting independent claims. Preserve query revision/lifecycle boundaries that
need distinct sessions. Assess callers before removing a production seam.
Main-owned corpus edits must go through main; record that dependency explicitly.

Done when each removal has a proof owner or obsolete contract, and each deferral
has a structured unsupported/not-checked result.

## 4. Coherent batches

Edit one owner at a time and serialize shared harness changes. Move retained
assertions before deleting old locations; remove obsolete paths/support together.
Recheck root imports, filters, corpus selection, and CI routing. Run the affected
focused checks through the existing runner, honoring local-build restrictions.
Use Linux CI timings: every source-written test under 1 s, target under 500 ms.
Do not add verifiers or exhaustive sweeps to the hot path.

Done when accepted edits are applied and checked, with unverified scope explicit.

## 5. Preservation review and defects

Compare deleted assertions with retained proof: no contract may lose its only
witness. Check negative controls reach the intended phase and fixtures do not
supply the result being tested. Use isolated pre-fix or mutation controls when
feasible; report controls not obtained. Inspect LOUD GAPS: no unsupported demand
or corpus result may have become silent success, and track requirements remain.

Investigate retained baseline failures as possible product defects. Fix only
in-scope defects at their owner; record unrelated work as follow-ups. Do not
weaken valid assertions to accommodate a broken baseline.

Done when preservation gaps are resolved with evidence or explicitly retained,
and failures have a clear disposition.

## 6. Reconcile and hand off

If the base moves, reinspect upstream tests and port new valid assertions to the
retained owner before deleting their former root. Rerun affected focused checks
only as needed. Finish edits before the final push and report exact-head CI.

Add inventory coverage, retained proof owners, reduced demand/compilation cost,
Linux timing evidence, baseline failures, controls, and structured gaps/not-checked
scope to the `SKILL.md` handoff. Do not claim complete coverage for unexamined
cases or unsupported behavior. Continue only within authorized scope.
