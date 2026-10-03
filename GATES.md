# Gates: Step 7b generic nominal unions

OWNS: GATES.md, compiler/**, COMPILER_COMPATIBILITY.md, PAPERCUTS.md

Scope: complete generic nominal-union instances in the native self-hosted compiler, including typing, construction, match and patterns, per-instance layout, symbols, interning, Copy or affine classification, and drop glue

- [x] G0: this ledger states outcomes that can fail
  CHECK: node /Users/juliaortiz/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: 2026-10-03 LINT OK with only the three declared manual-gate warnings

- [x] G1: Step 7b starts from the published Step 7a implementation and retains the Step 6 cleanup foundation
  CHECK: git merge-base --is-ancestor 5aaa08aa6 HEAD && rg -q 'DropGlue' compiler/src && rg -q 'cleanupStack|CleanupStack|cleanup stack' compiler/src && echo 'prerequisite verification passed'
  EXPECT: prerequisite verification passed
  EVIDENCE: exact branch ancestry and source search passed after rebasing onto origin/selfhost 9e74bdf25 on 2026-10-03

- [x] G2: complete generic union instances construct every variant and match payload and payload-free patterns with coverage checked over the instantiated union
  CHECK: SILK_AGENT=step7 /private/tmp/silk-local-test.sh /Users/juliaortiz/.t3/worktrees/silk/julia-step7a-generic-records genericNominalUnion src/semantic/SemanticCases.silk
  EXPECT: Tests  2 passed, 0 failed
  EVIDENCE: exact rebased-source PASS; construct/match/layout test 362 ms and combined exact filter PASS

- [x] G3: distinct complete generic union instances have independently verified layout facts, canonical instance keys, interning, and symbols
  CHECK: SILK_AGENT=step7 /private/tmp/silk-local-test.sh /Users/juliaortiz/.t3/worktrees/silk/julia-step7a-generic-records genericNominalUnion src/semantic/SemanticCases.silk
  EXPECT: Tests  2 passed, 0 failed
  EVIDENCE: exact-source structural assertions cover Choice<u8> versus Choice<i64>, repeated layout interning, and Slot instance keys/symbols

- [x] G4: generic union instances classify Copy versus affine per payload and run exactly one payload drop through per-instance DropGlue
  CHECK: SILK_AGENT=step7 /private/tmp/silk-local-test.sh /Users/juliaortiz/.t3/worktrees/silk/julia-step7a-generic-records genericNominalUnion src/semantic/SemanticCases.silk
  EXPECT: Tests  2 passed, 0 failed
  EVIDENCE: exact rebased-source PASS 665 ms; native Maybe<Token> double-drop trap probe built and exited 85 with exactly one hook call

- [ ] G5: the full corpus has zero failures, loses no baseline PASS, and every remaining generic-union blocker has a precise later gap
  EVIDENCE: staged sweep pass=62 fail=1 unsupported=326 track=46; no lost baseline PASS and two new PASS; sole failure is the stale fixture fixed in prerequisite PR #738; remaining union-form cases are nominal-union-represented-copy-drop and ordinary-union-droppable-array

- [x] G6: a user-defined generic Option-shaped union has the same layout and runtime behavior as the ordinary stdlib mechanism without name-based compiler privilege
  EVIDENCE: exact native probe constructed and matched user-defined Maybe<T> and stdlib Option<T> through the same path and exited 85

- [x] G7: the task diff is structurally clean
  CHECK: git diff --check && echo 'diff hygiene verified'
  EXPECT: diff hygiene verified
  EVIDENCE: git diff --check passed on 2026-10-03

- [ ] G8: independent review and required PR CI accept the exact final head
  EVIDENCE: pending
