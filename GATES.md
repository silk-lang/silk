# Gates: Step 7c generic inherent members

OWNS: GATES.md, compiler/**, COMPILER_COMPATIBILITY.md, PAPERCUTS.md

Scope: select inherent methods and associated functions on complete generic nominal instances, preserving declaration-owned and member-owned arguments in one canonical application without privileged Option or Result handling

- [x] G0: this ledger states outcomes that can fail
  CHECK: node /Users/juliaortiz/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: 2026-10-03 LINT OK with only the three declared manual-gate warnings

- [x] G1: Step 7c starts from the published Step 7b implementation and retains the Step 6 cleanup foundation
  CHECK: git merge-base --is-ancestor 7fb329743 HEAD && rg -q 'DropGlue' compiler/src && rg -q 'cleanupStack|CleanupStack|cleanup stack' compiler/src && echo 'prerequisite verification passed'
  EXPECT: prerequisite verification passed
  EVIDENCE: exact branch ancestry and source search passed after rebasing onto origin/selfhost 9e74bdf25 on 2026-10-03

- [x] G2: prefix and applied-owner associated calls select the same complete application, with owner and member-owned arguments in their declared scopes
  CHECK: SILK_AGENT=step7 /private/tmp/silk-local-test.sh /Users/juliaortiz/.t3/worktrees/silk/julia-step7a-generic-records genericInherent src/semantic/SemanticCases.silk
  EXPECT: Tests  1 passed, 0 failed
  EVIDENCE: exact rebased-source PASS in 570 ms; inferred Box.choose(42, true) and Box<i32>.choose<bool> publish equal applications with owner i32 in the impl scope and member-owned bool in own arguments

- [x] G3: equal complete inherent-member instances share a key and symbol while distinct owner instances do not alias
  CHECK: SILK_AGENT=step7 /private/tmp/silk-local-test.sh /Users/juliaortiz/.t3/worktrees/silk/julia-step7a-generic-records genericInherent src/semantic/SemanticCases.silk
  EXPECT: Tests  1 passed, 0 failed
  EVIDENCE: exact rebased-source PASS in 570 ms; equal inferred-prefix/applied instances have equal InstanceKey.function values and symbols, while inferred Box<bool>.choose<i32> is distinct

- [x] G4: direct receiver calls on a generic nominal instance retain the complete owner scope; bound method values remain the named Step 8 gap
  CHECK: SILK_AGENT=step7 /private/tmp/silk-local-test.sh /Users/juliaortiz/.t3/worktrees/silk/julia-step7a-generic-records genericInherent src/semantic/SemanticCases.silk
  EXPECT: Tests  1 passed, 0 failed
  EVIDENCE: exact rebased-source PASS in 570 ms plus direct receiver runtime exit 42; the take call has no own arguments and one complete i32 impl scope

- [x] G5: stdlib Option and Result constructors use the ordinary generic inherent-member path without name-based compiler privilege
  EVIDENCE: exact rebased release probe using Box.make<i32>, Option.some<i32>, and Result.succeed<i32, i32> builds and exits 42; compiler-source audit finds no Option, Result, module-path, variant-shape, layout or effect identity recognition beyond ordinary implementation imports and unrelated generic labels

- [x] G6: the full corpus has zero new failures, loses no baseline PASS, and every remaining generic-member blocker has a precise later gap
  EVIDENCE: exact rebased release sweep pass=63 fail=1 unsupported=325 track=46 with no lost baseline PASS; the three gains over the 60-PASS baseline are retained-if-let-match-binding, scalar-enum-equality-from-borrowed-variant, and while-entry-backedge; the sole FAIL is the unchanged stale generic-service-stabilization-contracts fixture fixed in prerequisite PR #738; http-values and borrowed-outcome-affine-stream advance to typed-form, method-call-matrix advances to Step 8 pipeline-callable

- [x] G7: the task diff is structurally clean
  CHECK: git diff --check && echo 'diff hygiene verified'
  EXPECT: diff hygiene verified
  EVIDENCE: recovered the formatter's unrelated whole-file rewrite, reconciled Step 8's extracted call and field actors, then git diff --check and the whole-compiler source check passed on the scoped rebased 7c diff

- [ ] G8: independent review and required PR CI accept the exact final head
  EVIDENCE: pending
