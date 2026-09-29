# Test-audit campaign

Use campaign mode for an explicitly requested audit of a whole Silk package or
subsystem. The value bar, proof tiers, evidence requirements, and validation in
[SKILL.md](SKILL.md) apply throughout. Cover the complete requested surface without
turning every audit into a repository-wide cleanup.

## 1. Scope and baseline

Record the base SHA, relevant working-tree changes, owned test files, shared corpus
cases, fixtures, and conformance harnesses. Optionally record production and
support/test line counts to describe the result; they are not deletion targets.

Use existing CI results for the exact baseline SHA where available. Run focused
local baselines for candidates when needed to distinguish existing failures from
audit regressions. Mark unverified areas explicitly; do not run the whole suite
just to fill a baseline table. Keep failures separate from deletion candidates.

Done when the scope and available baseline evidence are recorded, including gaps.

## 2. Inventory by owner

Partition the surface by production responsibility. For a compiler campaign,
possible boundaries are parsing, resolution/typing, ownership/effects, evaluation,
lowering, driver/runtime acceptance, and platform conformance. For LLVM, group by
the actor and the binary or resource contract it owns. Use only relevant groups.
Include proof outside the obvious test directory, especially shared native corpus
cases and separately compiled C or Wasm fixtures.

Done when every in-scope declaration or corpus case has one discovery owner, with
cross-boundary dependencies recorded.

## 3. Read-only ledger

Read every assigned test, including parameter rows, plus the production owner,
callers, history, and CI routing. For large campaigns, use read-only subagents for
independent owner groups when available; otherwise inspect groups sequentially.
Keep edits with one coordinating owner to avoid conflicting support-file changes.

Give each declaration a mark and the evidence required by `SKILL.md`:

- `R`: retain, naming its contract and distinct failure mode;
- `F`: retain the contract but repair an inadequate or vacuous assertion;
- `C`: consolidate, naming the existing suite or corpus case that absorbs it;
- `D`: delete, naming remaining proof or explaining why the contract is obsolete.

A parameterized declaration is one entry unless rows need different decisions.
Judge assertions, not names: an analysis-only test cannot prove native execution.

Done when each declaration has a supported decision, or is explicitly unresolved
and retained pending evidence.

## 4. Coverage plan

Review the ledger for redundant layers, not just individual assertions. Name the
retained owner for each contract and the assertions it must absorb. Choose Silk's
cheapest adequate tier: analysis for semantic claims, `Evaluation` for compile-time
execution, native corpus for target-neutral runtime behavior, and structural or C
fixture proof for lowering/ABI claims. An end-to-end test does not automatically
subsume a structural invariant or a distinct target-specific failure.

Done when every proposed removal has a retained proof owner or an evidence-backed
obsolete contract, and each production seam removal has a caller assessment.

## 5. Apply coherent batches

Edit one boundary at a time. Consolidate retained assertions before removing their
old locations. Remove dead production paths and obsolete support in the same
batch. Serialize shared harness changes and preserve unrelated working-tree edits.

Check existing Vitest configuration, package scripts, shard selection, and CI
routing when moving or deleting suites. Update explicit references where needed;
do not invent test inventories or line-cap gates. Add durable ownership guidance
to a scoped `AGENTS.md` only when findings justify it. Run focused retained tests.

Done when every accepted plan is applied and its focused checks pass, with
unresolved candidates left intact and explained.

## 6. Preservation review

Compare deleted assertions against retained proof to find contracts that lost their
only witness. Use an independent read-only reviewer for substantial batches when
available. Check that negative controls reach the intended compiler phase and that
fixtures do not supply the behavior they purport to test.

For repaired regressions, demonstrate failure on the pre-fix code when feasible.
For subtle or vacuous assertions, a deliberate mutation of the owning behavior can
verify that the retained test detects it. Use isolated scratch work for mutations;
never overwrite unrelated edits or leave deliberate faults in the candidate.
Report any missing control evidence.

Done when each review gap is repaired or rejected with evidence, and remaining
uncertainties are explicit.

## 7. Product defects

Treat retained baseline failures as possible defects. Diagnose them separately from
coverage pruning. Fix an in-scope defect at its owner and prove the repair at the
cheapest adequate tier; use a separate commit when it clarifies review. Record
unrelated defects as follow-ups rather than expanding the campaign. Do not rewrite
valid assertions merely to accommodate a broken baseline.

Done when repaired defects have recorded control/candidate evidence and unrelated
or unresolved failures are clearly identified.

## 8. Reconcile and hand off

If the base moved, reconcile using the repository's current workflow. Reinspect
contracts introduced by upstream changes, including changes to files being deleted.
Port valid new assertions to the retained owner; reconsider a deletion if the new
contract needs that boundary. Preserve no obsolete path solely for compatibility.

Run affected focused checks after reconciliation and finish all repository edits
before the final push. Required PR CI must pass on that head; do not repeat the
complete CI suite locally or edit files just to record a passing gate.

Use the `SKILL.md` handoff, adding:

- inventory coverage and unresolved entries;
- retired layers and retained owners;
- preservation gaps found and evidence for their repairs;
- product defects, baseline failures, and control/candidate results;
- production versus test/support size changes, if measured.

Do not claim complete coverage when files, parameter rows, or required proof remain
unexamined. Further batches require scope already authorized by the user.
