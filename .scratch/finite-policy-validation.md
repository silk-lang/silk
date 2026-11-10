# Finite specialization validation checkpoint

Experimental source: `.scratch/parallel-check-experiment`.
Production carries only the independent Type stack fix; finite policy and parallel graph checking remain experimental.

## Passed

- Focused helper suite: 9/9 (exact budget accounting, graph fragment union/remap, finite closure/escape obligations, deep identity bound, retained reference proof tests).
- Final source policy matrix: 9/9 on the same latest runner, all exit0. Log `.scratch/finite-policy-final-selected.log`.
  - growingSpecializationBuildReportsItsResourceLimit
  - cleanupReentryStaysWithinItsOwnedRoot
  - refusedStaticChainsRefuseTheBuild
  - specializationBudgetKeepsCrossModuleRequestSites
  - unclosedStaticChainsStayUnadmitted
  - localClosureReentryIsDeclarationRecursion
  - witnessEffectRecursionStillExpands
  - genericRecursionWithFiniteChangingTypesBuilds
  - finiteDefaultArrayGrowthReportsResource
- The combined local-closure test includes finite polymorphic recursion, scoped continuation adapters, opaque producers, nested opaque executors, and witness-selected producers. Growing closure and named-section representations hit the existing per-key canonicalization Resource bound before the 16-node static-closure bound; assertions now require NotProven + SpecializationBudget and the exact authored recursive call.
- Growing cleanup is anchored at the authored `return ()` that requests its generated Drop, rather than the earlier expression constructing the local.
- Parallel_semantics reports native finite cycle check/build/runtime42 and type/static/cleanup growth check/build all passing, with proper resource diagnostics and no crash/timeout.

## Bugs fixed during validation

- Type rewrite dispatcher reserved47,400 bytes per recursive visit at O0; split22 branches preserves semantics and lets the existing structural budget refuse deep inputs safely.
- preparationAnswer and a remainder path discarded CanonicalizationFailure.reason. They now preserve Resource diagnostics.
- StaticClosure converts propagated resource diagnostics into NotProven, preserving diagnostic source details.
- Captured escape traversal now carries authored requester locations through generated cleanup and stops after resource exhaustion, avoiding synthetic-identity source lookup.

## Reproduction

The compiled runner is `.scratch/finite-policy-probe`; `.scratch/run-finite-policy-probe.py` reconstructs its validated uncached catalog plan from the `.inputs` file and accepts test names. Run it under shared `.scratch/performance.lock`. The runner discovers354 tests, but only the selected9 were executed for this checkpoint.

No performance claim follows from these correctness checks. Parallel graph completion passed compiler and Harfrust with the retained canonical-key snapshot. Removing that snapshot caused an unresolved placeholder and a correct fallback; the optimization was reverted. The final rebuilt candidate and matched measurements are owned by parallel_semantics.

## Matched check result reported by parallel_semantics

Final candidate59e447ccd541732c41efb1cebf27e5e28d1d8f690d82261f40aee81eff8e4945 accepted all four enabled runs. Matched two-round medians: compiler23.403→16.389s (1.428×), Harfrust7.971→4.158s (1.917×). CPU work increased about46%. These results do not reach the user's3× cold check/build goal. Worker backend integration and scheduling/transport work remain.

The temporary `compiler/src/semantic/FinitePolicyProbe.silk` runner module was removed after validation; the compiled runner, plan generator, logs, and permanent case assertions remain available.
