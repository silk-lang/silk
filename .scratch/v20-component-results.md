# V20 repaired native work: artifact-proof gate failed

Controlled four-core V19→repaired V20 screen stopped after18 compiler invocations. Twelve check calls passed; reference compiler build passed; candidate compiler cold build refused its artifact proof after accepting the semantic frontier. The harness rejected the cohort after fully settling all three calls. Harf builds and CPU0 were not run. No performance acceptance or promotion is supported.

Pins: [V19/V20 frozen revisions and hashes](v20-component-pins.json). Both have identical producer/Clang/four-unit O2/noPGO construction and runtime policy: retained/frontier/shared/private/chunk/build packing, build pipeline ON, registry OFF. Candidate is repaired frozen V20 `2281f561ff1ecefa62258166f7c960bc7da7560f93735a9139fd53ea5366fdc8`, source `0b984e03229d055fceb9d9eac71fce27a236e24e`.

[Validated check report](benchmarks/component-edits-pdsji6wg/component-report.md), [all invocation records](benchmarks/component-edits-pdsji6wg/results.json), [candidate cold build log](benchmarks/component-edits-pdsji6wg/build-compiler-0-candidate-cold.log), [gate failure](benchmarks/component-edits-pdsji6wg/aborted.json).

Single-pair check timings V19→V20: compiler cold10.923→10.467s, first2.602→2.547s, second1.809→1.773s. Harf cold4.061→4.084s, first.870→.882s, second.692→.711s. No check editing regression exceeded5%; these small changes require repetition before a benefit claim.

Candidate compiler cold build emitted `frontier accepted`, then `frontier artifact discovered ms=1657 a=81 b=43274` and `frontier artifact refused ms=9620 a=0 b=0`. It never started the native coordinator or emitted checkpoint/completion. Foreground took43.540s with fallback, settled43.552s. First/second edited calls were2.848/2.829s foreground,3.411/3.367s settled. These are recorded fallback behavior, not valid measurements of the selected pipeline policy.

All18 invocations and observed writers exited successfully and were reaped. Post-settlement diagnosis confirmed candidate compiler artifacts preserve the expected cold/first/second help output and revision markers, plus exact ordered diagnostic parity. [Runtime receipts](benchmarks/component-edits-pdsji6wg/failed-proof-runtime-validation.json) and [diagnostic receipts](benchmarks/component-edits-pdsji6wg/failed-proof-diagnostic-parity.json) are separate from acceptance; they do not waive the proof failure. All failed-cohort artifacts, edited source and cache remain intact for diagnosis. Harness resumption is forbidden for semantic/proof failure; only clean environmental disk refusal may resume.

Exclusive ownership was released. CPU0 remains required before a repaired candidate can be accepted; known V17 single-core regressions are still unresolved. V21's rejected Bundle performance is separate from this native-only failure.
