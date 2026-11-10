# Shipping the finite worker architecture

Prepared read-only against integration after 5067882de. Source remains frozen for measurement.

## Acceptance gate before deleting experiments

Use one selected implementation for default CLI check/build only after the same frozen binary passes cold, first unchanged, first body edit and later edit measurements for compiler and Harfrust against baseline. Include cache write settlement, final artifact equivalence and diagnostic code/span parity. Keep finite graph semantics and budgets identical in serial and parallel paths. A slow warm/edit path is a cache design issue to resolve before choosing persistence behavior, not a reason to ignore those measurements.

## Concrete deletion map

- `Semantic.frontierDump` and all callers: delete hardcoded `/workspace/silk/.scratch/frontier-failure-*` output, including artifact-lowering and failed record/key dumps. If no other caller remains, delete `FrontierHost.openFile`/nativeFopen. No production writes to an agent workspace.
- `frontierTrace`, `frontierNow`, direct stderr `frontier accepted/missing record/escape proof refused`, and `WalkFragments.refused/refuseProof`: ordinary commands should be quiet. Return refusal through the existing serial fallback. Send selected worker phase counters through existing `--timings`/Profiler only when requested; avoid formatting/allocation or clock reads when disabled. Remove SILK_ARTIFACT_TRACE and its source dump path.
- After balanced dynamic scheduling is selected: remove sharedFrontier and SILK_FRONTIER_SHARED, dynamicFrontier and SILK_FRONTIER_STATIC, static modulo-four selectFrontier, and the worker module-stride branch. Shared exact claims, inherited runtime queue and module/chunk queue become the one parallel implementation.
- After measured declaration chunk/private descendant policy is selected: remove SILK_FRONTIER_CHUNKS and SILK_FRONTIER_FORK_PRIVATE. Make profitability decisions from actual pending body/declaration work, preserving lease limits, inheritedRemaining origins and complete roster checks. Keep a single planner; do not keep old static behavior as another hidden mode.
- After incremental evidence selects worker persistence: remove SILK_FRONTIER_EPHEMERAL and the losing cached-worker/direct-payload branch. Ordinary coordinator persistence remains necessary for later commands; deleting worker query evidence must not delete coordinator incremental value.
- Remove SILK_EXPERIMENT_FRONTIER and SILK_FRONTIER_WARM. Enable the chosen worker path through explicit CLI permission plus host/workload eligibility. Prefix work becomes a named policy value; workload gate should account for large declaration chunks rather than only module count.
- After build measurements choose retained emission: remove SILK_RETAINED_BUILD opt-in, SILK_POSTCHECK_BUILD, forkArtifactWorkers control-only path and special postcheck ownership hashing. Retain commands 2 (graph extension) and 3–6 only if used by the selected retained-emission protocol. Remove SILK_EXPERIMENT_DEV_PACKS and its losing backend packing branch once the packaging winner is known.

## Required default gate and resource policy

Preserve `processWorkersAllowed=false` on ordinary Semantic construction; only `main.silk` synchronous CLI check/build call `allowProcessWorkers`. Preserve `!resolver.revisable`. LSP, embedding, revision tests and arbitrary worker-thread hosts must stay serial unless a future API explicitly establishes fork safety. Keep GNU Linux x86_64/aarch64 host isolation and compile-safe serial behavior on macOS/Windows.

Current implementation hardcodes four originals, owner modulo4, child IDs original+4, four compute leases and one descendant per original. Do not simply replace one spawn-loop bound: these are one protocol invariant. The immediate measured deployment can keep width4 only when at least four effective CPUs and sufficient memory are available; otherwise use the serial algorithm. General width2–4 requires a single WorkerPlan carrying original count/lease count/descendant offset through spawn, ownership, chunk scheduling, proxy routing and tests.

Host eligibility must use actual affinity and container limits, not machine CPU count alone: sched_getaffinity plus cgroup CPU quota/cpuset; memory must consider cgroup remaining budget and host available memory. Select a conservative reserve from measured aggregate PSS including retained descendants, coordinator and backend tool overlap; no unmeasured fixed memory claim. Failed/unknown host probes should choose serial. Keep existing graceful mmap/tmpfile/socketpair/fork setup failure and complete partial-pool teardown. Failed transport/proof falls back after reaping children; never publish partial coverage.

## Validation after removal/default activation

- No special environment variables: CLI check/build choose the worker plan on an eligible large fixture and return identical diagnostics/artifacts; small projects remain serial without setup cost.
- Same tests with restricted affinity/quota and inadequate memory policy; supported-host allocation/fork failure matrix remains10/10. Other-host sourcechecks still pass.
- Warm/edit sequence tests verify current exact graph costs and cache associations, including tighter→relaxed budgets, stale replay rollback and failed adoption cleanup.
- Partition tests retain exact one-owner pending Enter coverage and source origins; declaration chunks require full ordered declaration/name coverage; parent union includes every descendant/extension before global budget import.
- Preserve the final chosen default-mode cold and incremental benchmark artifacts with binary/source hashes. Remove only experiment code; retain reproducible test and measurement evidence outside the product.

## Review fixes already delivered

487bbc188 clears frontier proof reuse when limits change; faf4090dd makes allocation publication atomic and rollback nonallocating (fault-injection tests2/2 pass); b59a5b6a3 discards image-specific budget associations after failed adoption. Parent union accounting covers all chunk/descendant fragments before coverage publication. No additional global budget charging hole was found in this review.
