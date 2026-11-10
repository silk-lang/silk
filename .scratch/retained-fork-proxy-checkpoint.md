# Descendant retained-backend routing

Worktree `/workspace/silk-retained-fork-proxy`, branch `codex/retained-fork-proxy`, based retained current-main backend `e237c2d27` plus fork prototype adapted to retain shared mappings (`c3b8d0249`) and initial-runtime-frame donation guard (`2ebf367cb`). Proxy source commit `e2f0923fa`; current HEAD `96b675f58` also includes profiling code-validity identity correction (`ebdcb537e`). First sourcecheck found two writable-place assignment syntax errors and a missing manifest.schema.toml in the generated package. Both source assignments and package setup corrected; rerun queued after balanced exclusive cold measurement.

Ownership: worker_forks owns routing helpers/fields and worker lifecycle adaptation. build_pipeline/profiling own representative selection and code-identity determinism. `artifactRepresentative`, `artifactGraphBatch`, `artifactEmitBatch` remain unchanged by routing.

Commands 3 and 6 broadcast to descendants and run locally; all acknowledgements must succeed. Observation restart clears remembered routes. Commands 4 and 5 partition each incoming batch into local and descendant sub-batches, send descendant work before local computation, and reconstruct replies in original request order. Graph requests prefer the shared claim table's logical owner (root IDs 0–3; child root+4), retry the other retained store only for unknown status, and pin each successful chosen exact key plus definition to its actual store. Emission rejects missing/mismatched routes and runs only in that pinned store. A child-emission trace exposes actual downstream reuse.

Every local backend command takes/releases a shared compute lease, including descendant commands; ancestors hold no lease while waiting for descendants. Error paths release leases before propagating. At most one descendant per original worker is supported and unexpected topology refuses the experimental path. Parent mapping cleanup now occurs only when retained workers finish or fail; successful check-to-build retention keeps both claim and compute maps alive.

Next: shared sourcecheck and optimized bootstrap in next root-coordinated shared slot after retained backend exclusive window. Correctness requires a workload that actually creates descendants and emits their graph nodes, plus fallback on injected private-fork failure. Aggregate PSS tool: `.scratch/benchmarks/pss_run.py`; use its wall time only for memory audit, never speed evidence. Existing private fault injection `.scratch/refuse-private-fork.so` denies nested worker forks.

## Validated proxy snapshot

Source correction `be5a84d64` passed whole-compiler check; optimized four-unit bootstrap passed (shared-contended 1m52s, not performance evidence). Binary `.scratch/retained-fork-proxy-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler` corresponds to `be5a84d64`, before later Enter-only adaptation.

Full compiler retained build accepted both complete frontier proof and retained artifact graph. Two actual descendants (root1→child5, root3→child7) emitted 1,758 and715 definitions respectively. The generated compiler runs `--version`. Same-snapshot serial comparison produced byte-identical binary and every generated artifact. Evidence `.scratch/benchmarks/combined-build-dt0u7xfh/{results.json,proxy-parity.json,compiler-on.log,compiler-off.log}`; shared correctness run20.71s is not benchmark evidence. Both commands and detached writers reaped.

Integration sequence over current retained backend: `c3b8d0249`, `2ebf367cb`, `e2f0923fa`, `be5a84d64`; skip identity cherry-pick when already integrated. After walks runtime cleanup, narrow `41d30e9f0` adapts private selector/test to Enter-only visits with unchanged inheritedRemaining boundary. Root integrated these at `3a4aebf0b`.

Read-only combined lifecycle audit found explicit refusal exits bypassing child cleanup. Narrow `e9c3f13ed` in `/workspace/silk-worker-abort`, based scanner/root04c7d2619, replaces publish/chunk refusal exits with a shared abort helper: release compute lease if held, close/reap children, close ancestor control, exit3. All lease-state call sites reflect publication phase; no wait holds a compute token. This helper and Enter-only adaptation await combined sourcecheck/bootstrap, not separately rebuilt. Allocation/effect exceptions before publication and abrupt external process death remain distinct failure paths.

Remaining validation scheduled on root's next combined binary: nested-fork failure injection, descendant failure/rejection cleanup, aggregate PSS audit. No worker_forks heavy process currently active.

Fault injection readiness: `.scratch/frontier-failure-audit.py BINARY refuse|exit` snapshots the frozen compiler workload, requires actual nested-fork injections and final successful check; refusal must retain frontier acceptance, child exit must cause serial fallback. Both shims were tested against a native4-root/1-child-per-root process tree: initial roots survive, all4 nested forks receive EAGAIN or child exit77 as selected, all processes reaped, smoke exits0. Shim smoke source `.scratch/private-fault-shim-smoke.c`. This validates instrumentation only; combined compiler failure behavior remains pending.

## Combined integrated-v2 failure and memory validation

Frozen binary `.scratch/frontier-integrated-v2`, source5067882de, SHA256 `a05e7ba0a688d305832a85a54a29bd50f671f971341dfafadecda41ac90c99e0`.

- Nested-fork EAGAIN audit:3 actual injections, original-worker frontier still accepted, final check exits0, all workers/cache writer reaped. `.scratch/benchmarks/private-failure-refuse-4o769xu0/results.json`.
- Private-child exit77 audit:2 actual injected deaths, distributed proof refused, serial fallback check exits0, all workers/cache writer reaped. Failed children were reaped by ancestors (subreaper recorded only the normal detached cache writer). `.scratch/benchmarks/private-failure-exit-6fsv6fgv/results.json`.
- Separate same-snapshot serial/balanced aggregate memory audit at100ms intervals: peak PSS3,347,653KiB (3.19GiB) serial;4,564,614KiB (4.35GiB) balanced,1.36×. Balanced run donated2 children and accepted complete proof. Its peak included8 readable processes (timeout wrapper+coordinator+4 roots+2 descendants); summed RSS double-counts shared pages and is not the physical-memory metric. Brief peaks can be missed and process reads are not simultaneous. All exits0 and all descendants reaped. `.scratch/benchmarks/private-pss-wizc12ys/results.json`. Do not use memory-audit durations as performance claims.

All worker_forks heavy jobs released. Parallel_semantics is preparing a same-snapshot unused invalid declaration fixture that preserves runtime donation, to exercise the leased module/chunk refusal branch; child-death audit exercised unleased ancestor abort after EOF. Root owns exclusive cold comparison next, then profiling's incremental matrix.
