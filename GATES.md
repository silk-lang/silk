# Gates: Step 7d generic-instance corpus sweep

OWNS: GATES.md, compiler/**, .github/workflows/selfhost.yml, COMPILER_COMPATIBILITY.md, PAPERCUTS.md

Scope: pin every corpus program newly enabled by Step 7, replace generic first-blocker labels with precise later gaps and owners, re-audit Option and Result compiler privilege, and close the Step 7 roadmap only after exact-head CI has zero failures

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node /Users/juliaortiz/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: pending revalidation after combined review

- [ ] G1: the stack contains current selfhost, the main-first corpus sync and the Step 6 cleanup foundation
  CHECK: git merge-base --is-ancestor 8964ce9905a44841f60cd0d5387df3f8f5f85af7 HEAD && git merge-base --is-ancestor 23eb6fc956af3154df2391cfaade34a1da4e8738 HEAD && rg -q 'DropGlue' compiler/src/backend/InstanceKey.silk && rg -q 'cleanupStack|CleanupStack|cleanup stack' compiler/src && echo 'prerequisite verification passed'
  EXPECT: prerequisite verification passed
  EVIDENCE: pending final ancestry and source verification; current integration base is selfhost 8964ce990 plus main sync 0bf6fa25a

- [ ] G2: the full corpus has zero failures, loses no baseline PASS, and reports the final PASS, unsupported, and track counts
  CHECK: SILKC="$PWD/compiler/build/llvm/aarch64-apple-darwin/release-with-debug/silk-compiler" pnpm --filter @silklang/compiler exec tsx ../../compiler/scripts/runSelfhostCorpus.ts
  EXPECT: /Selfhost corpus: pass=[0-9]+ fail=0 unsupported=[0-9]+ track=[0-9]+/
  EVIDENCE: pending current-head release build and full sweep; earlier 65/1/323 receipt predates Step 8d and the merged #738 fixture correction

- [ ] G3: every corpus program newly passing because of Step 7 is pinned in both hard-coded acceptance lists after an exact native PASS
  CHECK: SILKC="$PWD/compiler/build/llvm/aarch64-apple-darwin/release-with-debug/silk-compiler" SILK_SELFHOST_CORPUS_CASES=retained-if-let-match-binding,scalar-enum-equality-from-borrowed-variant,while-entry-backedge pnpm --filter @silklang/compiler exec tsx ../../compiler/scripts/runSelfhostCorpus.ts
  EXPECT: Selfhost corpus: pass=3 fail=0 unsupported=0 track=3
  EVIDENCE: historical existing-program pins agree in both lists; pending final sweep and pins for main-first generic-record-instances and generic-union-instances

- [ ] G4: every remaining program whose earlier first blocker was a generic instance has a precise next blocker owned by Step 8, Step 9, or a named follow-up
  EVIDENCE: pending final exact-span inventory and feature-specific gap verification; the historical ownership table below is not a current completion claim

  | Owner | Programs and exact current blocker |
  | --- | --- |
  | Step 8 callable values | generic-interface-runtime-contracts (typed-form in function-value calls), closed-operator-surface (typed-form at a checked-operation section), staged-callable-section (typed-form), option-result-combinators (typed-form at callable argument), method-call-matrix (pipeline-callable) |
  | Step 9 effects and services | borrowed-outcome-stream, borrowed-outcome-affine-stream, generic-inline-effect-conformance, generic-service-stabilization-contracts after its main fixture sync; x25519 also reaches its provider run after intrinsic gaps |
  | intrinsic/static-value follow-up | integer-operation-matrix and arith-convergence-checked-remainder-min-none (intrinsic-member); checked-conversion-f32/f64 (typed-form at primitive static INFINITY); checked-conversion-pointer-width (typed-form at pointerBits); chacha20-poly1305 and rsa-verification (intrinsic-member/unit-parameter plus typed-form) |
  | ordinary union/pattern follow-up | nominal-union-represented-copy-drop and ordinary-union-droppable-array (union-form); nominal-result-compound-error (typed-form at the nominal arm inside a structural union) |
  | borrowed aggregate/string follow-up | ecdsa-p256-verification (typed-form at the borrowed array-to-slice Option payload); http-values (typed-form at a string header-name operand) |

- [ ] G5: Option and Result receive no direct or indirect compiler privilege, and a user-defined Option-shaped generic union has identical layout and behavior
  EVIDENCE: round-1 independent source audit found no direct or indirect recognition; #738 supplies the runtime comparison, but an explicit identical-layout structured assertion is still required

- [ ] G6: the generic-record and user-defined generic-union native corpus acceptances land on main, sync to selfhost, pass exactly, and are pinned
  EVIDENCE: #738 merged on main at 23eb6fc95; reviewed sync #750 is the bottom of native stack #751; exact final native PASS and pins remain pending

- [ ] G7: the task diff is structurally clean and changes every hard-coded corpus-name list together
  CHECK: git diff --check && node -e "const fs = require('node:fs'); const names = ['retained-if-let-match-binding','scalar-enum-equality-from-borrowed-variant','while-entry-backedge']; for (const path of ['compiler/scripts/selfhostTrack.ts','.github/workflows/selfhost.yml']) { const text = fs.readFileSync(path, 'utf8'); for (const name of names) if (!text.includes(String.fromCharCode(39) + name + String.fromCharCode(39))) throw new Error(path + ' missing ' + name); } console.log('diff hygiene and pin lists verified')"
  EXPECT: diff hygiene and pin lists verified
  EVIDENCE: pending final diff and pin-list audit; earlier source/test receipts do not certify the review corrections

- [ ] G8: independent review and required PR CI accept the exact final head, and #567 records the Step 7 link plus final PASS and pin counts
  EVIDENCE: pending
