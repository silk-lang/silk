# Gates: Step 7d generic-instance corpus sweep

OWNS: GATES.md, compiler/**, .github/workflows/selfhost.yml, COMPILER_COMPATIBILITY.md, PAPERCUTS.md

Scope: pin every corpus program newly enabled by Step 7, replace generic first-blocker labels with precise later gaps and owners, re-audit Option and Result compiler privilege, and close the Step 7 roadmap only after exact-head CI has zero failures

- [ ] G0: this ledger states outcomes that can fail
      CHECK: node /Users/juliaortiz/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
      EXPECT: LINT OK
      EVIDENCE: pending revalidation after combined review

- [ ] G1: the stack contains current selfhost, the main-first corpus sync and the Step 6 cleanup foundation
      CHECK: git merge-base --is-ancestor 47aa3c636ef2d40016d5ef723b49f56c0d9486bc HEAD && git merge-base --is-ancestor 23eb6fc956af3154df2391cfaade34a1da4e8738 HEAD && rg -q 'DropGlue' compiler/src/backend/InstanceKey.silk && rg -q 'cleanupStack|CleanupStack|cleanup stack' compiler/src && echo 'prerequisite verification passed'
      EXPECT: prerequisite verification passed
      EVIDENCE: integrated stack27f256769 contains selfhost47aa3c636 (#752/#753/#754) plus main23eb6fc95 through sync0e9850460; final prerequisite verification remains required

- [ ] G2: the full corpus has zero failures and reports the final PASS, unsupported, and track counts
      CHECK: SILKC="$PWD/compiler/build/llvm/aarch64-apple-darwin/release-with-debug/silk-compiler" pnpm --filter @silklang/compiler exec tsx ../../compiler/scripts/runSelfhostCorpus.ts
      EXPECT: /Selfhost corpus: pass=[0-9]+ fail=0 unsupported=[0-9]+ track=[0-9]+/
      EVIDENCE: intermediate exact5616 release sweep measured68 PASS/0 FAIL/322 Unsupported/track49 and independently preserved baseline60. Unpublished final-round corrections require a rebuilt-head sweep; historical65/1/323 is not acceptance.

- [ ] G3: every corpus program newly passing because of Step 7 is pinned in both hard-coded acceptance lists after an exact native PASS
      CHECK: SILKC="$PWD/compiler/build/llvm/aarch64-apple-darwin/release-with-debug/silk-compiler" SILK_SELFHOST_CORPUS_CASES=retained-if-let-match-binding,scalar-enum-equality-from-borrowed-variant,while-entry-backedge,generic-record-instances,generic-union-instances pnpm --filter @silklang/compiler exec tsx ../../compiler/scripts/runSelfhostCorpus.ts
      EXPECT: Selfhost corpus: pass=5 fail=0 unsupported=0 track=5
      EVIDENCE: all five Step 7 programs passed at exact compiler head 5616b5cd5 in the full 68/0/322 sweep; both new main-first fixtures are now pinned in both lists. Final-round semantic corrections still require a rebuilt-head sweep.

- [ ] G4: every remaining program whose earlier first blocker was a generic instance has a precise next blocker owned by Step 8, Step 9, or a named follow-up
      EVIDENCE: intermediate27-target native span inventory and independent feature-guard audit establish the ownership map below. Named codes are being integrated; final exact-head emitted-code verification remains pending. This is not a completion claim.

  | Owner                                     | Programs and exact current blocker                                                                                                                                                                                                                        |
  | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Step 8 callable values                    | nominal-union-represented-copy-drop (named function increment), option-result-combinators (named function double), staged-callable-section (missing nested call-target fact); method-call-matrix needs remeasurement after #753 removed pipeline-callable |
  | Step 9 effects                            | borrowed-outcome-stream, borrowed-outcome-affine-stream, generic-inline-effect-conformance (effect-form); x25519 also reaches effect-form alongside intrinsic gaps                                                                                        |
  | Intrinsic surface/witness follow-up       | integer-operation-matrix, closed-operator-surface, arith-convergence-checked-remainder-min-none, x25519 and rsa-verification (intrinsic-member); generic-interface-runtime-contracts (Intrinsic.i32Add witness mapping, not a callable-value gap)         |
  | Runtime constant follow-up                | checked-conversion-f32/f64 (INFINITY), checked-conversion-pointer-width (pointerBits); chacha20-poly1305/rsa-verification (resolved numeric namespace constants)                                                                                          |
  | Generic interface inference follow-up     | generic-service-stabilization-contracts (Encodable.encode needs application argument inference); later effects belong to Step 9                                                                                                                           |
  | Ordinary pattern/representation follow-up | nominal-result-compound-error (nominal enum arm nested in structural union); ordinary-union-droppable-array (union-form for array member representation)                                                                                                  |
  | Lifetime/string follow-up                 | ecdsa-p256-verification (body-local lifetime elision at &[u8], not payload coercion); http-values (runtime text literal)                                                                                                                                  |
  | Ordinary body/ABI follow-ups              | chacha20-poly1305 additionally needs array-contained call discovery, mutable by-value parameter binding and scalar-enum moving match; chacha20-poly1305/rsa-verification also report unit-parameter                                                       |

- [ ] G5: Option and Result receive no direct or indirect compiler privilege, and a user-defined Option-shaped generic union has identical layout and behavior
      EVIDENCE: round-1 and round-2 independent source audits found no direct or indirect recognition; #738 supplies the runtime comparison and genericOptionLibraryAndUserUnionHaveIdenticalLayout compares actual stdlib Option and authored user-union layout. Native execution and final privilege audit remain pending.

- [ ] G6: the generic-record and user-defined generic-union native corpus acceptances land on main, sync to selfhost, pass exactly, and are pinned
      EVIDENCE: #738 merged on main at 23eb6fc95; reviewed sync #750 is the bottom of native stack #751; exact final native PASS and pins remain pending

- [ ] G7: the task diff is structurally clean and changes every hard-coded corpus-name list together
      CHECK: git diff --check && node -e "const fs = require('node:fs'); const names = ['retained-if-let-match-binding','scalar-enum-equality-from-borrowed-variant','while-entry-backedge','generic-record-instances','generic-union-instances']; for (const path of ['compiler/scripts/selfhostTrack.ts','.github/workflows/selfhost.yml']) { const text = fs.readFileSync(path, 'utf8'); for (const name of names) if (!text.includes(String.fromCharCode(39) + name + String.fromCharCode(39))) throw new Error(path + ' missing ' + name); } console.log('diff hygiene and pin lists verified')"
      EXPECT: diff hygiene and pin lists verified
      EVIDENCE: pending final diff and pin-list audit; earlier source/test receipts do not certify the review corrections

- [ ] G8: independent review and required PR CI accept the exact final head, and #567 records the Step 7 link plus final PASS and pin counts
      EVIDENCE: pending

- [ ] G9: the final full corpus PASS set contains every exact baseline PASS and all newly pinned Step 7 programs
      EVIDENCE: pending independent set difference between /private/tmp/step7-baseline-22196f43d.log and the final current-head full corpus receipt; runner track membership alone does not prove the entire historical baseline is retained
