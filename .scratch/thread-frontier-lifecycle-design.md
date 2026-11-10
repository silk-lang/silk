# Direct thread stage: lifecycle and fork boundaries

Source-only worktree `.scratch/thread-frontier-prototype`, based on validated ownership/interner checkpoint `a5529b4c5360414e556829688652811b07fb84e4`. The initial lifecycle/source-epoch/guarded-body stage passed a full source check and ten executed native tests at e9935553c. Scheduler activation passed full source checking at 1d9d68e90 and all thirteen executed native tests at f595e23f1. No end-to-end performance claim exists. Parent proof worktree remains unchanged.

Ownership: parallel_semantics owns `ThreadFrontier.silk`, its lifecycle cases and driver hooks. worker_forks owns Semantic hooks, immutable completed-body registry and structured guard import/export. interning owns SourceEpoch/SourceIndex and immutable parsed-source publication.

## Transport contract

`ThreadFrontier.start<C,R,F>(entry)` transfers only an owned detached callable and endpoint. The entry constructs Semantic, Query, Graph, Resolver and local Types canonical memo on its own native thread. `Worker.submit` queues at most one command; `receive` takes the corresponding response. Parent submits a batch across workers before receiving results. Endpoint `next` and `reply` retain private store state across commands. Initial retained protocol may use Bytes/Bytes to keep existing exact graph and cache validation; this is not a claim that all transport serialization has been removed.

Controller Drop and explicit close set cancellation, drain pending transport, release the lock, wake the endpoint, and join. Executing semantic operations finish normally; threads are never killed while holding locks. The worker completion guard signals early ordinary exit so the parent refuses a missing reply. Completed replies remain consumable after entry return. All command/reply destructors and allocator callbacks run outside transport locks. No new unchecked thread-property assertion or Shared/Query/store transfer is used.

The channel uses existing Arc, Mutex and Condition rather than the fiber Channel implementation, whose Shared-backed endpoints are intentionally not native-thread transferable. It is bounded without per-command allocation. Single-thread Wasm statically refuses start and must retain the serial driver route.

## Existing fork sites and required ordering

| Site | Actual order / rule |
| --- | --- |
| `main.finishPreparedNative` → `NativeCoordinator.start` | Existing process lane forks before `finishBuildArtifact` captures/validates retained worker cache. Unsafe with native semantic threads. Initial thread lane bypasses this overlap: complete artifact capture/validation/export/join first, then ordinary native compilation. Process lane unchanged. |
| `SemanticCache.saveTracked` → `DetachedWriter.handOff` | Defensive `Semantic.stopThreadFrontier` now precedes all cache save branches and the writer fork. Normal success must have exported accepted evidence already; failed/unpublished worker work is discarded, while imported immutable answers remain valid. |
| CLI check/build `abandonValue(move store)` | Deliberately bypasses field destruction. Both paths now explicitly join native workers first; relying only on Worker.Drop would leak active threads. |
| `MemberChecks.start` | Workspace member processes fork outside each member's Semantic-store lifetime. A failed fork may run one member inline; its workers must finish/drop before the parent attempts later member forks. No active semantic pool may escape the new explicit abandon barriers. |
| Semantic initial frontier and private donation forks | Must be unreachable for the native-thread lane and for stores created inside workers. Partial thread launch failure must close/join all started workers before any process fallback. Worker owner maintains this separation. |
| `ChildProcess` launchForked → startForked → execve | Existing subprocess child performs prepared descriptor/signal/cwd setup and immediate exec, without using semantic objects, allocating compiler values or taking shared interner locks. This differs from compiler-owned fork children that continue running Silk semantic/cache code. |
| Source preload/native-code compilation threads | ModuleSources parse workers join before final Analysis store construction. NativeCompile workers belong to native compilation and join before it returns. Cache prefetch has its own join-owning handle. These lifetimes must remain distinct from persistent semantic workers. |

`captureArtifactReplay` calls `importArtifactCache`/`fetchFrontierCache` and requires the exact returned imported-root mapping. Simply flushing the worker cache, stopping workers, and rerunning capture later is not an equivalent ordering. The first safe lane finishes the whole artifact phase before native fork. This loses native compilation versus parent proof/cache-validation overlap; no wall-time estimate is inferred from the earlier 2.939s sampled cache-assembly CPU observation. An exec-only coordinator or split immutable imported-proof object can be investigated only after the safe lane is measured.

## Initial gates

1. Actual completed Body imported across private Semantic stores avoids provider work and preserves full source/query guard evidence, including unchanged caller with changed crossmodule signature and cache export/adoption.
2. Persistent command lifecycle: private state survives batches; second outstanding submission is refused; idle cancellation and controller Drop join; early worker exit refuses missing response.
3. Complete native/check/build graph proofs, failures, cache writers, native pipeline and subprocess lifecycle before any performance claim.
4. Cold and direct/immediate edits, unchanged command and settled-writer costs against baseline on four CPUs and CPU0. Unconditional Arc retention and native/proof overlap loss are explicit costs.

## Activation work after e9935553c

First scheduler: four persistent native workers, one real runtime task and uniquely claimed complete module tasks. There is no cloned runtime prefix or invented duplicate runtime coverage. The parent must prove all assigned modules and one exact runtime record, then apply the common finite-closure/callback/escape/budget checks. Retained commands keep private worker stores alive through emission/cache capture. Partial launch or worker failure cancels the queue, joins all native workers, and only then falls back.

Explicit opt-in is `SILK_EXPERIMENT_THREADS`. Early admission uses the existing conservative CPU/memory policy and concrete native-host support, refreshed before spawn. CPU0 keeps TypeTable and no SourceEpoch/registry/pool allocation. Off-mode also keeps the original provider. The previously validated transitive Published/Arc ownership migration is unconditional: same-binary OFF/ON does not measure that cost. Final CPU0 evaluation needs matching-construction V22 source versus full thread source.

Four-core warmed commands currently choose SharedTypePool before cache eligibility is known. Even when replay later prevents native worker startup, they pay category mutex/interner and SourceEpoch setup costs. This is a measured-risk item, not a claimed warm optimization. Direct first/second edits and unchanged commands must be compared against both original baseline and same-source OFF. If material overhead remains, provider selection must move after read-only cache eligibility or use a sound private-to-common promotion scheme; no hidden refill or priming may mask it.

InstanceSeed is a separate bounded immutable canonical-task representation for later runtime donation. Existing InstanceKey is not transferable: providers, digest memo, helper creator and storage wrappers are Shared. Seeds copy only canonical immutable fields and reconstruct those containers privately. First coarse scheduler does not use seed donation; no performance benefit attributed to it.
