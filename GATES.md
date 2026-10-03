# Gates: Step 7a generic records

OWNS: GATES.md, compiler/**, COMPILER_COMPATIBILITY.md, PAPERCUTS.md

Scope: complete generic record instances in the native self-hosted compiler, including typing, per-instance layout, construction, projection, patterns, symbols, Copy or affine classification, and drop glue

- [x] G0: this ledger states outcomes that can fail
  CHECK: node /Users/juliaortiz/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=e97e98aff7aaee51752dd5ef3f4e7fa147597fddd0198b6448ec0640be12a199; exit=0; EXPECT=matched; output-sha256=b96c4ecb07bf998298c90e78caa44c7211447dca4e8e15be1268ad9605608589; output-bytes=930; shell=/bin/sh; cwd=/Users/juliaortiz/.t3/worktrees/silk/julia-step7a-generic-records; path=e250d9739ff8/70 entries

- [x] G1: the implementation retains the complete Step 6 cleanup foundation
  CHECK: git merge-base --is-ancestor 22196f43d HEAD && rg -q 'DropGlue' compiler/src && rg -q 'cleanupStack|CleanupStack|cleanup stack' compiler/src && echo 'prerequisite verification passed'
  EXPECT: prerequisite verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=56e2e1f9667c2d6be3cd64df8855c9f9f08c7ba3a40b4f4e0e9ec38bb4457db8; exit=0; EXPECT=matched; output-sha256=b4631f004dd0d4a8340502a8c59de610b335263ef98fb7cb18fe53221ccf6875; output-bytes=33; shell=/bin/sh; cwd=/Users/juliaortiz/.t3/worktrees/silk/julia-step7a-generic-records; path=e250d9739ff8/70 entries

- [x] G2: distinct complete generic record instances have independently verified layout, construction, projection, patterns, symbols, interning, Copy or affine classification, and drop glue
  CHECK: SILK_AGENT=step7 /private/tmp/silk-local-test.sh /Users/juliaortiz/.t3/worktrees/silk/julia-step7a-generic-records genericRecordInstances src/semantic/SemanticCases.silk
  EXPECT: Tests  2 passed, 0 failed
  EVIDENCE: 2026-10-03 exact source PASS; genericRecordInstancesClassifyCopyAndShareDropGlue 386 ms; genericRecordInstancesInferAndLayoutSeparately 502 ms; native explicit-pattern probe built and exited 42

- [ ] G3: inferred generic record construction and projection execute with exactly-once payload cleanup in the native corpus
  CHECK: SILKC=compiler/build/llvm/aarch64-apple-darwin/release-with-debug/silk-compiler SILK_SELFHOST_CORPUS_CASES=generic-record-instances pnpm --filter @silklang/compiler exec tsx ../../compiler/scripts/runSelfhostCorpus.ts
  EXPECT: Selfhost corpus: pass=1 fail=0 unsupported=0 track=1
  EVIDENCE: pending

- [ ] G4: the full corpus has zero failures, loses no baseline PASS, and every still-blocked generic-record program has a precise non-7a gap
  EVIDENCE: staged exact-source sweep pass=60 fail=1 unsupported=328 track=46 with no lost PASS; the sole failure is the stale generic-service fixture corrected in prerequisite PR #738, while the other four former generic-record cases report typed-form

- [x] G5: the task diff is structurally clean
  CHECK: git diff --check && echo 'diff hygiene verified'
  EXPECT: diff hygiene verified
  EVIDENCE: automatic-evidence=v1; definition-sha256=4e76a74b37d3ffa61be47f5f019f748a3b3bd3149a8f59b91967696fcea9cb34; exit=0; EXPECT=matched; output-sha256=f75ed0216b2ff9635ca2c2cbf8640d29f934c6a2a73bacda84c208d88669dcc4; output-bytes=22; shell=/bin/sh; cwd=/Users/juliaortiz/.t3/worktrees/silk/julia-step7a-generic-records; path=e250d9739ff8/70 entries

- [ ] G6: independent review and required PR CI accept the exact final head
  EVIDENCE: pending
