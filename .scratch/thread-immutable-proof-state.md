# Thread immutable ownership proof

Validated source: `a5529b4c5360414e556829688652811b07fb84e4`, isolated worktree `.scratch/thread-immutable-prototype`, exact V22 base `85ba82efe750a4682cc21192ad5dcb37d7bbd981`. No scheduler, completed-body registry or guarded receiver-query adoption has been implemented. No performance claim.

Full compiler sourcecheck passed: 255 modules, matching prototype stdlib, pinned CI N1 SHA `d0c04d1a9b672e34fd6302ccaa9fc49b23a2ba1954c8d826dc73be626bc611db`. Receipt/log: `thread-immutable-sourcecheck-a5529b4c5.{json,log}`.

One fresh unoptimized native runner passed four selected, executed tests with zero cached tests:

- `nativeThreadsShareCompletedBodiesAndCanonicalTypes`: 11 ms. Two real threads use private Semantic stores, a retained immutable source epoch, and a shared structural interner. They return actual checked nested-callable bodies after dropping their local stores. Stage and common boolean type identity remain intact.
- `runtimeSnapshotsSurvivePublicationAndAllowNestedReads`: 49 us. Retired empty snapshots remain valid, equal publication preserves the first cell, and read callbacks may re-enter after the lock is released.
- `concurrentInternPublicationRejectsRacesAndHashCollisions`: 520 us. Stale publication retries, uniquely unpublished losing allocations are destroyed once outside locks, and 32 forced hash collisions retain exact lifetime identity through table growth.
- `concurrentInterningKeepsCanonicalMemosWorkerLocal`: 303 us. Common Type/Application values share handles; invocation binders remain distinct and mutable InstanceKey memo state stays local.

Receipt: `thread-immutable-a5529b4c5-focused.json`. Logs: `thread-immutable-a5529b4c5-{1,2,3}.log`. All compiler descendants and writers reaped; shared slot explicitly released. Native runner: `thread-immutable-a5529b4c5-tests`.

Ownership uses Published<T> over existing Arc<T>, not an unchecked transfer assertion on Shared/Frozen. Interned<T> thread traits require T: Transferable + Concurrent. Runtime encoding computes/allocates outside publication locks, retains both snapshots during identity comparison, and retires replaced values after unlocking. Concurrent interning separates five categories, compares effectful Type/Application predicates outside locks, and installs preallocated storage transactionally. Existing bounded collision fallback may lose sharing; pointer uniqueness is not a universal semantic guarantee.

Read-only independent audits found no concrete blocker in that boundary. Compatibility: all five released native hosts support the existing atomics/Mutex implementation. Serial direct Wasm lowers atomic operations to ordinary loads/stores/RMW/CAS and removes fences (WasmBody 2331–2440). InitialProfile 541 rejects multi-thread WASI/wasm64; NativeThread.createThread 355 returns SpawnError58 for single-thread Wasm. A future scheduler must statically preserve the serial route, as LSP Command 54 does. Native-host compilation targeting Wasm is separate from executing the compiler as Wasm. Other native host OS/architectures and Linux musl/freestanding are outside current release support and hit the existing Atomic.wait/notify compile guard.

Next stage must retain exact source/context authority and full dependency evidence when installing a shared answer. Shared structured guard DAG identity should avoid recreating query-guard nodes for every imported body while preserving fine selectors and cache export. No pending-provider waiting or shared Resolver/Query/Graph is authorized by this proof. Measure publication/import/cache cost and cold/direct/immediate edits on four CPUs and CPU0; unconditional Arc clone/drop costs can regress serial performance even though serial TypeTable takes no new pool mutexes.
