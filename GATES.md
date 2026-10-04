# Gates: Step 7 generic-instance acceptance contract

OWNS: GATES.md, compiler/**, .github/workflows/selfhost.yml, COMPILER_COMPATIBILITY.md, PAPERCUTS.md

Scope: pin every corpus program newly enabled by Step 7, replace generic first-blocker labels with precise later gaps and owners, re-audit Option and Result compiler privilege, and close the Step 7 roadmap only after exact-head CI has zero failures

The live final-head gate ledger and three-round review dispatch are maintained in
`.unlazy/step7-finish/`; publication and CI receipts are linked from #761. This tracked contract
retains the original independently required outcomes. Pending workflow gates are not completion
claims, and historical receipts below are explicitly distinguished from final-head evidence.

- [ ] G0: this ledger states outcomes that can fail
      CHECK: node /Users/juliaortiz/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
      EXPECT: LINT OK
      EVIDENCE: pending revalidation after combined review

- [ ] G1: the stack contains current selfhost, the main-first corpus sync and the Step 6 cleanup foundation
      CHECK: git merge-base --is-ancestor origin/selfhost HEAD && git merge-base --is-ancestor 22de957e59470573c2bdea932392278219df139d HEAD && rg -q 'DropGlue' compiler/src/backend/InstanceKey.silk && rg -q 'cleanupStack|CleanupStack|cleanup stack' compiler/src && echo 'prerequisite verification passed'
      EXPECT: prerequisite verification passed
      EVIDENCE: merged layers throughselfhostfeb466e include Step6 cleanup; feature84b325e integrates currentselfhost51272082 including #756/#757 and main22de957e (#759). Final-head ancestry is rechecked before merge.

- [ ] G2: the full corpus has zero failures and reports the final PASS, unsupported, and track counts
      CHECK: SILKC="$PWD/compiler/build/llvm/aarch64-apple-darwin/release-with-debug/silk-compiler" pnpm --filter @silklang/compiler exec tsx ../../compiler/scripts/runSelfhostCorpus.ts
      EXPECT: /Selfhost corpus: pass=[0-9]+ fail=0 unsupported=[0-9]+ track=[0-9]+/
      EVIDENCE: current main-synced sweep /private/tmp/step7e-corpus-main-sync.log measured70PASS/0FAIL/322Unsupported/track56 and preserved all69 earlier PASS. This precedes the cost-only exact-key/word optimizations and latest Step8 merge; exact final CI is still required.

- [ ] G3: every corpus program newly passing because of Step 7 is pinned in both hard-coded acceptance lists after an exact native PASS
      CHECK: SILKC="$PWD/compiler/build/llvm/aarch64-apple-darwin/release-with-debug/silk-compiler" SILK_SELFHOST_CORPUS_CASES=retained-if-let-match-binding,scalar-enum-equality-from-borrowed-variant,while-entry-backedge,generic-record-instances,generic-union-instances,generic-lifetime-selected-cleanup pnpm --filter @silklang/compiler exec tsx ../../compiler/scripts/runSelfhostCorpus.ts
      EXPECT: Selfhost corpus: pass=6 fail=0 unsupported=0 track=6
      EVIDENCE: five earlier Step7 pins retained; newmain#759 exact source built and returned42 with both compilers, then passed at committed native sourcebd94dd78d before both pin lists were updated. Final integrated-head CI re-executes every pin.

- [ ] G4: every remaining program whose earlier first blocker was a generic instance has a precise next blocker owned by Step 8, Step 9, or a named follow-up
      EVIDENCE: fresh27-target emitted-code/span audit in round1 independently compared current corpus logs and feature guards; five target programs pass,22 have separate remaining owners below. First-gap evidence is not a claim that later blockers are absent. Latest Step8 integration requires remeasurement.

  | Owner                                     | Programs and exact current blocker                                                                                                                                                                                                                        |
  | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Step 8 callable values                    | nominal-union-represented-copy-drop (function-value at increment), option-result-combinators (function-value at double), staged-callable-section and method-call-matrix (call-target-discovery at partial sections; remeasure after #756/#757) |
  | Step 9 effects                            | borrowed-outcome-stream, borrowed-outcome-affine-stream, generic-inline-effect-conformance (effect-form); x25519 also reaches effect-form alongside intrinsic gaps                                                                                        |
  | Intrinsic surface/witness follow-up       | integer-operation-matrix, closed-operator-surface, arith-convergence-checked-remainder-min-none, x25519 and rsa-verification (intrinsic-member); generic-interface-runtime-contracts (Intrinsic.i32Add witness mapping, not a callable-value gap)         |
  | Runtime constant follow-up                | checked-conversion-f32/f64 (INFINITY), checked-conversion-pointer-width (pointerBits); chacha20-poly1305/rsa-verification (resolved numeric namespace constants)                                                                                          |
  | Generic interface inference follow-up     | generic-service-stabilization-contracts (Encodable.encode needs application argument inference); later effects belong to Step 9                                                                                                                           |
  | Ordinary pattern/representation follow-up | nominal-result-compound-error (nominal enum arm nested in structural union); ordinary-union-droppable-array (union-form for array member representation)                                                                                                  |
  | Lifetime/string follow-up                 | ecdsa-p256-verification (body-local lifetime elision at &[u8], not payload coercion); http-values (runtime text literal)                                                                                                                                  |
  | Ordinary body follow-ups                  | chacha20-poly1305 additionally reports scalar-enum-moving-match and fully applied nongeneric scalar call-target-discovery at main:8005–8052; that label alone does not establish Step8 ownership. Current RSA has45 runtime-constant/intrinsic-member gaps; stale unit-parameter receipts are not current evidence. |

- [ ] G5: Option and Result receive no direct or indirect compiler privilege, and a user-defined Option-shaped generic union has identical layout and behavior
      EVIDENCE: earlier landed source audits plus fresh full-change round1 bounded source/shape audit found no direct or indirect recognition in either compiler; #738 runtime comparison and actual stdlib/user-union structured numeric layout comparison both pass. Final integrated-head review/CI remain required.

- [ ] G6: the generic-record and user-defined generic-union native corpus acceptances land on main, sync to selfhost, pass exactly, and are pinned
      EVIDENCE: #738 main23eb6fc95 reachedselfhost through merged #750/#751; both corpus programs pass and are pinned. New distinguishing #759 main22de957e reaches #761 by merge with both parents, passes natively and is pinned in both lists.

- [ ] G7: the task diff is structurally clean and changes every hard-coded corpus-name list together
      CHECK: git diff --check && node -e "const fs = require('node:fs'); const names = ['retained-if-let-match-binding','scalar-enum-equality-from-borrowed-variant','while-entry-backedge','generic-record-instances','generic-union-instances','generic-lifetime-selected-cleanup']; for (const path of ['compiler/scripts/selfhostTrack.ts','.github/workflows/selfhost.yml']) { const text = fs.readFileSync(path, 'utf8'); for (const name of names) if (!text.includes(String.fromCharCode(39) + name + String.fromCharCode(39))) throw new Error(path + ' missing ' + name); } console.log('diff hygiene and pin lists verified')"
      EXPECT: diff hygiene and pin lists verified
      EVIDENCE: pending final diff and pin-list audit; earlier source/test receipts do not certify the review corrections

- [ ] G8: independent review and required PR CI accept the exact final head, and #567 records the Step 7 link plus final PASS and pin counts
      EVIDENCE: pending

- [ ] G9: the final full corpus PASS set contains every exact baseline PASS and all newly pinned Step 7 programs
      EVIDENCE: independent set comparison /private/tmp/step7-corpus-980ce3a13.log to /private/tmp/step7e-corpus-main-sync.log measured69→70 with lost[] and gained[generic-lifetime-selected-cleanup]. Final current-head CI must also retain any newer Step8 PASS; track membership alone does not prove the whole historical baseline.
