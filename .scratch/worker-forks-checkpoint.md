# Retained private runtime worker prototype

Worktree: `/workspace/silk/.scratch/worker-forks`, branch `codex/frontier-worker-forks`, commit `9baaefe65`.
Base: current-main finite integration `2c05a4b4a` (dynamic original frontier scheduling, ephemeral child transport, platform adapter and RPC cleanup).
Binary: `.scratch/worker-forks-package/build/llvm/x86_64-unknown-linux-gnu/speed-four/silk-compiler`, SHA256 `3df867f9bf819382a364e66e7477a81236c544f70e4abebb228216c179a78847`.

Enable with `SILK_EXPERIMENT_FRONTIER=1 SILK_FRONTIER_SHARED=1 SILK_FRONTIER_EPHEMERAL=1 SILK_FRONTIER_FORK_PRIVATE=1`.

At a completed-MIR worklist boundary, a worker may split its private pending suffix into one retained descendant. The original inherited cursor tasks remain with the root; every existing Leave marker and visit origin is preserved. Removed tasks become explicit EXTERNAL proof obligations. Each root spawns at most one child (four roots plus at most four descendants resident). A separate shared page admits at most four heavy worker computations; roots finishing their runtime work briefly prioritize queued private forks before starting module work. There is no global phase barrier.

Descendants only complete their runtime slice; they do not sweep modules or publish partial module evidence. The ancestor concatenates their completed runtime proof into its ephemeral root transport, counting runtime coverage once per original worker. The descendant retains its key/MIR store. GraphExtend command2 fans out to the child and merges exact records; the ancestor releases its compute lease before waiting. Shutdown closes descendant controls and reaps them before the ancestor exits. Backend commands3–6 still require integration with build_pipeline's current-main port (logical claim owners4–7 route via root owner modulo4).

Validation completed:
- Whole compiler sourcecheck passed.
- Focused structured partition/origin/compute-lease test passed1/1,399µs at O0.
- Optimized four-unit bootstrap passed.

Logs: `.scratch/worker-forks-sourcecheck.log`, `worker-forks-partition-test.log`, `worker-forks-build.log`.
Cold measurement harness prepared: `.scratch/frontier_private_compare.py` (same binary off/on, four CPUs, fresh caches, all descendants reaped;120s command timeout bounds first experimental probes).
Fault injection prepared: `.scratch/refuse-private-fork.so` denies nested worker forks, leaving initial coordinator forks intact.

First exclusive compiler pair accepted complete proof both off and on: cold 10.625963 → 9.627307s (1.104×); settled 10.810016 → 9.807881s; aggregate CPU 28.406779 → 27.565658s. Two descendants engaged at 2.324s and 2.432s; runtime tail fell below the 6.232s module-sweep tail. Maximum individual RSS 1,443,256 → 1,282,580 KiB is not aggregate memory. Raw evidence: `.scratch/frontier-private-comparison.json`, `.scratch/frontier-private-first-pair.log`, `.scratch/frontier-private-compiler-{off,on}.log`. Descendant trace counters inherit prefix counts; sum original runtime tasks only over root workers0–3. Runtime ancestry/Leave deletion by walks and module chunk scheduling by parallel_semantics are independent pending integrations.

Combined chunks/fork snapshot `83a87cadf` adds the declaration chunk scheduler and confines donation to the initial runtime walk frame (later module walks cannot publish proof under the runtime unit). Parallel_semantics owns combined validation. Backend descendant proxies are being developed separately in `/workspace/silk-retained-fork-proxy`, based retained backend `e237c2d27`; the measured fork-only binary remains unchanged. Aggregate PSS and injected nested-fork failure tests remain pending.
