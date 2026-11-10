# V22 hidden incoming runtime gates — PASS

Baseline: repaired V20 .scratch/frontier-native-work-v20-repaired, SHA2281f561ff1ecefa62258166f7c960bc7da7560f93735a9139fd53ea5366fdc8. Candidate V22 must include family4 artifact validation repair plus e5812895c hidden incoming forwarding. Use the same candidate source fixtures/stdlib on both binaries.

Shared slot runner: `flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/hidden-incoming-native.py --candidate V22 --tree V22_TREE`.

Six authored corpus fixtures:
- diagnostic-observer-capturing-callback: captured observer state and repeated install/recovery, two distinct failures, callback weight and event totals.
- diagnostic-observer-release-balance: deep failure propagation, selected cause across rethrow, loop failure handling and balanced produced/released diagnostic handles.
- diagnostic-observer-cancelled-handler-release: handler suspension while failure remains live, cancellation, failure destructor and observer closure order. Exercises unchanged coroutine resume/cancel storage.
- owned-provider-shared-dispatch: repeated mutable provider updates followed by shared read, ensuring pointer-value reuse never caches provider pointees.
- mixed-service-provider-suspension: immediate and suspended providers selected independently through requirement binding.
- owned-provider-suspended-failure: provider survives suspension/failure then drops once with owned allocation cleanup.

All six run baseline/candidate O0 full-debug. Observer-balance and mutable-provider cases additionally run O2 full-debug as unchanged optimized-lane controls (16 builds total). Every child writer is reaped. Source hashes, full stdout/stderr, runtime exit and DWARF verifier receipts are saved. Three observer fixtures use the previously validated noCapture C logger to print exact ordered operation|identity|origin; no nondeterministic pointer address is printed. Their original internal event handle/lifetime assertions remain intact. Exact output/event comparison is mandatory, not merely exit42.

All O0 pairs additionally compare authored fixture variable/parameter names, type text, source positions, enclosing scope identities, and DW_OP location kinds through fixture-dwarf-parity.py. PC/stack offsets are excluded. Existing missing locations are recorded and must not change; no claim that baseline debug coverage is universally perfect. Manual debugger writes remain outside the tested contract.

Then run retained-cache-smokes.py with `--cases lifetimes_local_first,lifetimes_static_first,observer,suspension` for40 cold/direct-first-edit/second-edit/unchanged/invalid calls, comparing fresh serial output artifacts and diagnostics. It requires real retained artifact engagement in ordinary observer/lifetime cases and explicit checked fallback for suspension; no admission override. Standard-policy full compiler artifact engagement is an additional prerequisite owned by root/profiling after family4 repair, not inferred from these small fixtures.

Optional ordinary parameter regression remains parameter-native-v20.py (4 builds) plus parameter-cache-lifecycle.py (14 calls), both accepting --candidate and --tree. These already passed repaired V20 and can cover the incoming-plan field rename in V22.

No standalone hidden compiler bootstrap is requested. All runners await a released slot and frozen combined V22.

## Completed validation

Candidate SHA256 `accdfe2f81e1b109d83b1fcaed9c29837b2bdfebed3694e17a71511772fec2a6`, frozen source `85ba82efe`. Mandatory full original compiler retained artifact gate passed before these tests (profiling lane).

- Native16/16 passed; exact observer operation/identity/origin event streams, exit/stdout/stderr parity, all DWARF verification and six authored variable/type/source/scope/location-kind comparisons. Evidence: `.scratch/benchmarks/hidden-incoming-native-qnoja58d`.
- Cache40/40 passed; both lifetime-order fixtures and observer engaged retained artifact/persistence cold; suspension preserved explicit checked fallback. No first/second/unchanged warm frontier restart, successful output binaries exactly match fresh serial, invalid diagnostic codes/locations match. Evidence: `.scratch/benchmarks/retained-cache-smokes-ihdx8i1x`.
- Every detached writer reaped successfully; both runners exited0. Shared correctness slot released. These elapsed times are not performance measurements.
