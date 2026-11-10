# Finite admission cleanup audit

Read-only snapshot of `.scratch/parallel-check-experiment`, 2026-11-08. Names are authoritative; line numbers may move during sibling edits. No source changes made.

## Delete the superseded frontier protocol together

`Semantic.silk`: `frontierDescent`, `frontierAdmissions`, and the command-1 ancestry-pair request/reply branch in `serveFrontier`. Retain command-2 `frontierExtend`, `frontierComplete`, worker shutdown, retained frontier keys, and graph merge/validation. Remove `frontierBoundary` and the `boundaries` list construction in `joinFrontier` once the removed reviewer has no consumer. This is **WalkFragments.Boundary**, not the live `WalkBoundary` used to partition actual module work.

Remove command-1's `Types.canonicalKeys()` expansion from `serveFrontier`; first verify every LEFT key needed by command-2 is retained by `rememberFrontier` (parallel_semantics reports this invariant). The expansion currently runs even for command-2 and adds unrelated canonical keys.

`WalkFragments.silk`: remove `Boundary` and its classifier (`toolchainModule`, `walkedElsewhere`) once only the obsolete reviewer uses them; `AdmissionPair`, `AdmissionCertificate`, `pairHash`, `containsPair`, `certificateDecision`, `AdmissionVisit`, `AdmissionFrame`; `admissionFree`, `reviewAdmission`, `reviewAdmissionBounded`, `reviewAdmissionBoundedClosure`, `matchingFamily`, `sameRoots`, `admissionRoots`, `witnessEdge`, `runtimeApplicationEqual`, `absentApplication`, and the old reviewer's `belowCallbacks`. Remove tests dedicated to these policies, including family/certificate/reused-frame/boundary/contextual-witness tests. Preserve finite graph tests and callback escape tests; mixed tests need splitting rather than wholesale removal.

Retain `structuralFailure`, merge/mergeOpen, missingBodies, includeBudget, finiteClosed, escapeFree, actual-callee references, summaries and callback closure. They establish the replacement proof and real escape validity.

## Stop producing obsolete per-node facts

`Semantic.keyFacts` still executes `Admission.familySignature` (full type traversal), `Admission.applicationIdentity`, and records PLAIN/STATICS/FUNCTION/BOUNDARY_KNOWN metadata solely for the ancestry reviewer. `BuildCapture.references` still walks edges to populate witness ordinals. Remove those producers and their matching `BuildRecord.Facts` fields/flags/codecs/copy routines (`family`, `application`, `witnesses`, FACT_FAMILY, FACT_FAMILY_COMPLETE, FACT_RUNTIME_APPLICATION, FACT_WITNESSES). Preserve definition/bare identity, body/budget accounting, FACT_APPLICATION/CLOSED, keyBytes, summarized escape/parking/callback/obligation facts. `BuildRecord.Entry.family` is a different emission-plan family index and stays.

## Remove the old admission heuristic itself

`Specialization.silk`:

- `Step.family` and its empty Frozen allocation in every `Admission.enterChain` are now dead bookkeeping. Copying frames clones this unused allocation too.
- Remove FamilySignature, FamilyProfile, FamilySlot, FamilyArgumentKind/Completeness, FamilyTargets/Producer and projection helpers `sameFamily*`, `portableFamily`, `familyProfile`, `familyTargets`, `familyProducer`, `familyChildCount/At`, `familyApplicationChild`, etc. Their remaining producers/consumers are the obsolete RPC and tests.
- Remove `Admission.ordinaryDescent`, `witnessNonGrowing`, `descentRelation`, `familySignature`, `edgeWitnesses` plus `witnesses`, `provesField`, `fieldOnPath`, `witnessDescent`, `sameClosedFamily`, `nonGrowing`, `descends/descendsUnder`, `producedWithin` after the corresponding callers are removed.
- `FieldDescent.fromMember` has no external callers; FieldWitness is only copied/encoded and interpreted by the old heuristic. This isolated dead variant can go with its record handling. Do not confuse it with real member-shape checking.
- Retain `closed` / `closedArgument`, Application bindings/identity/equality/substitution/numberRegions, bounded Numbering collection, and any path retained for resource diagnostics.
- OperandPass is LIVE witness operand adaptation, including actual borrow access and lifetime substitution. Preserve it. CallableWitness/SectionSchema likewise remain live semantic structures elsewhere; remove only imports made unused in this file.

## Simplify remaining serial/replay callers, not just the RPC

`Decision.Rejected`, `ChangingStatic`, and `Reused` are no longer returned by common finite Admission, yet Semantic's escape/build/static-closure paths retain their old branches. Those branches are the only justification for cleanupAdmits/ownedDescentAdmits/admitOwnedDescent and Admission.ownedSteps/activeUpToStatics/isActive. Remove the dead branches and dependent search machinery as a unit after confirming the finite resource tests. Do not blindly delete `copyCleanupRoot`, Edge.Cleanup or the worklist cleanup state: those still appear in live traversal and need a separate use audit.

`rewalkAdmits` still actively applies the same-body/argument-free ancestry heuristic before `rewalkBuildDecide`/`rewalkEscapesDecide` fallback. Replace this stale rule with finite-policy closedness and visited-node handling; otherwise the old rule still forces replay refusal/reconstruction. Preserve key reconstruction and fresh semantic checks required when cached evidence is absent, graph resource accounting, all source dependency checks, and actual escape/nonparking/cleanup validity.

## Deep raw identity test failure

Numbering canonicalizationUnits=32768; enter charges `2 + activeCount`. A chain of references can enter approximately254 nested rewriteType calls before the structural resource refusal. Each call enters the giant rewriteTypeInside effect dispatcher; that structural-work limit does not imply host-stack safety in unoptimized code. The Reference branch recurses before rewriting its lifetime. Walks owns backtrace diagnosis; no change suggested until the failing frame is identified. A stack-safe iterative collector or explicit structural nesting budget is conceptually separate from the finite specialization graph budget.
