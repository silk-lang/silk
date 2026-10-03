# Gates: Step 7d generic-instance corpus sweep

OWNS: GATES.md, compiler/**, .github/workflows/selfhost.yml, COMPILER_COMPATIBILITY.md, PAPERCUTS.md

Scope: pin every corpus program newly enabled by Step 7, replace generic first-blocker labels with precise later gaps and owners, re-audit Option and Result compiler privilege, and close the Step 7 roadmap only after exact-head CI has zero failures

- [x] G0: this ledger states outcomes that can fail
  CHECK: node /Users/juliaortiz/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: 2026-10-03 LINT OK with only the six declared manual or unmeasured gate warnings

- [x] G1: Step 7d starts from the published Step 7c implementation and retains the Step 6 cleanup foundation
  CHECK: git merge-base --is-ancestor 6584c2b09 HEAD && rg -q 'DropGlue' compiler/src && rg -q 'cleanupStack|CleanupStack|cleanup stack' compiler/src && echo 'prerequisite verification passed'
  EXPECT: prerequisite verification passed
  EVIDENCE: exact branch ancestry and source search passed after rebasing onto origin/selfhost 9e74bdf25 on 2026-10-03

- [ ] G2: the full corpus has zero failures, loses no baseline PASS, and reports the final PASS, unsupported, and track counts
  CHECK: SILKC=compiler/build/llvm/aarch64-apple-darwin/release-with-debug/silk-compiler pnpm --filter @silklang/compiler exec tsx ../../compiler/scripts/runSelfhostCorpus.ts
  EXPECT: Selfhost corpus reports fail=0 and no selfhost track failure
  EVIDENCE: exact selfhost 9e74bdf25 sweep pass=65 fail=1 unsupported=323 track=49 with no lost baseline PASS; two additional PASS belong to upstream Step 8c, and the only failure is the stale generic-service-stabilization-contracts fixture fixed on main in prerequisite PR #738

- [x] G3: every existing corpus program newly passing because of Step 7 is pinned in both hard-coded acceptance lists after an exact native PASS
  CHECK: SILKC=compiler/build/llvm/aarch64-apple-darwin/release-with-debug/silk-compiler SILK_SELFHOST_CORPUS_CASES=retained-if-let-match-binding,scalar-enum-equality-from-borrowed-variant,while-entry-backedge pnpm --filter @silklang/compiler exec tsx ../../compiler/scripts/runSelfhostCorpus.ts
  EXPECT: Selfhost corpus: pass=3 fail=0 unsupported=0 track=3
  EVIDENCE: after rebasing onto selfhost 9e74bdf25, the exact release compiler reports pass=3 fail=0 unsupported=0 track=3 in 336 ms, 326 ms, and 302 ms; both hard-coded lists pin the same names

- [x] G4: every remaining program whose earlier first blocker was a generic instance has a precise next blocker owned by Step 8, Step 9, or a named follow-up
  EVIDENCE: the normalized before/after audit records the following ownership; the exact 65/1/323 sweep has no generic-record gap, 290 typed-form reports, and only two union-form reports, both in the ordinary-union follow-up

  | Owner | Programs and exact current blocker |
  | --- | --- |
  | Step 8 callable values | generic-interface-runtime-contracts (typed-form in function-value calls), closed-operator-surface (typed-form at a checked-operation section), staged-callable-section (typed-form), option-result-combinators (typed-form at callable argument), method-call-matrix (pipeline-callable) |
  | Step 9 effects and services | borrowed-outcome-stream, borrowed-outcome-affine-stream, generic-inline-effect-conformance, generic-service-stabilization-contracts after its main fixture sync; x25519 also reaches its provider run after intrinsic gaps |
  | intrinsic/static-value follow-up | integer-operation-matrix and arith-convergence-checked-remainder-min-none (intrinsic-member); checked-conversion-f32/f64 (typed-form at primitive static INFINITY); checked-conversion-pointer-width (typed-form at pointerBits); chacha20-poly1305 and rsa-verification (intrinsic-member/unit-parameter plus typed-form) |
  | ordinary union/pattern follow-up | nominal-union-represented-copy-drop and ordinary-union-droppable-array (union-form); nominal-result-compound-error (typed-form at the nominal arm inside a structural union) |
  | borrowed aggregate/string follow-up | ecdsa-p256-verification (typed-form at the borrowed array-to-slice Option payload); http-values (typed-form at a string header-name operand) |

- [x] G5: Option and Result receive no direct or indirect compiler privilege, and a user-defined Option-shaped generic union has identical layout and behavior
  EVIDENCE: source audit found no Option, Result, module-path, success/failure-shape, effect, try-sugar, layout, or niche recognition; the user-defined Maybe<T> structural/runtime claim is staged in prerequisite PR #738 and the exact ordinary-path probes exit 42

- [ ] G6: the generic-record and user-defined generic-union native corpus acceptances land on main, sync to selfhost, pass exactly, and are pinned
  EVIDENCE: prerequisite draft main PR #738 is green and awaiting review/merge before the required selfhost sync

- [x] G7: the task diff is structurally clean and changes every hard-coded corpus-name list together
  CHECK: git diff --check && rg -q "'retained-if-let-match-binding'" compiler/scripts/selfhostTrack.ts .github/workflows/selfhost.yml && rg -q "'scalar-enum-equality-from-borrowed-variant'" compiler/scripts/selfhostTrack.ts .github/workflows/selfhost.yml && rg -q "'while-entry-backedge'" compiler/scripts/selfhostTrack.ts .github/workflows/selfhost.yml && echo 'diff hygiene and pin lists verified'
  EXPECT: diff hygiene and pin lists verified
  EVIDENCE: the whole compiler source check and exact release build pass on selfhost 9e74bdf25; record filters pass in 393 ms and 674 ms, union filters in 666 ms and 363 ms, and inherent selection in 664 ms; diff hygiene and both pin-list membership checks pass

- [ ] G8: independent review and required PR CI accept the exact final head, and #567 records the Step 7 link plus final PASS and pin counts
  EVIDENCE: pending
