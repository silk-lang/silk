# V18 diagnostic: early cache checkpoint and green-root reuse

Frozen source: `2d2d0e5ed449448a8b48248eaa39ac75e1c7b9ab` in `.scratch/performance-v18-source`.
Binary: `.scratch/frontier-native-checkpoint-diagnostic`, SHA256 `b0c3ae6b19a3745ffd42185e0fd69ce35ab6d44c993b7591433c0b0546d7e9ba`.
Construction: four LLVM units, O2, no PGO. This differs from V17 mono O2/PGO: do not attribute a V17/V18 time difference solely to source changes.

Sourcecheck and bootstrap passed. Native early-checkpoint gates passed 15/15, including real four-unit Harf engagement, exact object/executable/runtime parity, failed-child fallback, and CPU0 automatic refusal. Warm lifecycle passed 32/32 with exact ordered 41-error diagnostics and no warm reforks; 88 replay events included 8 stale-root checks and no green-root rechecks. These were shared correctness runs, not performance measurements. All descendants reaped.

First measurement: identical binary and normal cache/frontier flags, registry OFF, pipeline OFF/ON, two reversed rounds of compiler/Harf builds. Each cohort is cold then immediate first and second edits; do not wait for cache writers between commands. Keep source mutation, foreground launch gap, per-tree foreground/settled/CPU, previous-writer liveness, complete cohort duration, exact artifacts and diagnostics. ON cold must show exactly one early checkpoint before publication. OFF and warm calls must not show one. A failure or fallback is not a timing result.

Then evaluate CPU0 baseline-relative immediate check/build edits, preserving the automatic pool refusal assertion. Report construction differences prominently. These controls diagnose regressions; the final original-baseline matrix must use the final candidate with documented construction and include both one-core and four-core cold, first edit, subsequent edits, and unchanged sequences.

Acceptance remains unchanged: faster cold work does not cancel slower editing. V17 failed that gate; the 3x goal has not been reached. Do not promote experimental controls based only on correctness or total cohort speed.

While measurements own the exclusive performance lock, other agents work on source only. CacheBundle remains a separate unmeasured prototype; its full sourcecheck passed, but focused/lifecycle validation, bounded repeated-edit storage, and timings are still required. Shared storage helpers are also unvalidated source at this point.
