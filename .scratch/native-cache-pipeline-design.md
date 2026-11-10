# Native compilation / retained cache overlap

Source audit: integration 3626df713; evidence `.scratch/benchmarks/v13-cpu-build-cw3f9tud`. This is a shared-slot profiling run, not a matched wall-time benchmark.

## Proven readiness and current barriers

`retainedArtifact` finishes exact artifact graph discovery/closure, command-budget and escape proof, then obtains every selected `DefinitionFragments.Entry`. `DefinitionFragments.valid` checks the assembled set before cache import. `assembleEmissionChecked` reads these transported identities/fragments plus parent export declarations, builds the canonical symbol plan, validates foreign/export bindings, builds the common header, and applies the existing module/package packing algorithm. None of these steps reads imported worker query-cache roots. `CapturedEntry.carried` indexes are needed for later persistence, not native code assembly.

Therefore exact unit assembly can precede `captureArtifactReplay`/`importArtifactCache`, without estimating sizes or changing unit membership. In this retained path every CollectedText has pack/member=MAX, so all assembled units are fresh, never stored-pack references. Deferred admission additionally checks this invariant.

The graph alone cannot predict current exact unit membership: ModulePacks and large-module shards use emitted fragment lengths. Canonical code identity and the complete foreign declaration header are also only supplied by emission. A MIR-weight planner would change the packing policy and needs separate evidence; it is not part of this change.

## Phase API

Semantic owns ArtifactPreparation (private build + pending replay), with borrowed preview and deferred accessors. `prepareBuildArtifact` returns it after exact assembly. Ordinary/warm/one-core or unsupported paths complete synchronously and are not deferred. The existing synchronous `buildArtifact` remains a useful complete entry and shares the same implementation.

Driver may privately compile deferred units in a separate coordinator process. The compiler parent remains single-threaded, including when SemanticCache.saveDetached forks. The coordinator closes inherited worker/proxy descriptors without stop requests, waits or signals. It must not publish objects, link, write symbols/output, prune caches, or claim success.

`finishBuildArtifact` imports all exact retained cache evidence, assembles per-entry carried roots, flushes deferred check evidence and stops workers. It returns ArtifactCompletion {build,accepted}. Cache transport rejection triggers existing serial build with process workers temporarily disabled and accepted=false; driver discards every staged native product. Source/import/syntax/unchecked diagnostics still gate publication in the normal driver path. Exceptions and abandonment close workers; native coordinator cleanup must likewise join/abort and delete private staging.

Driver starts no coordinator on nondeferred paths or one CPU. Native options, tool identity, debug records and object names must use the existing compilation machinery, not a duplicate reconstruction. After completion and all ordinary diagnostics succeed, validated private objects can be published and normal link continues.

## Measured overlap bounds

Trace arrival intervals and 99-Hz sampled user CPU:

| Interval | Wall s | Parent user CPU | Worker user CPU |
|---|---:|---:|---:|
| Check proof → artifact graph discovered | 1.459 | .101 | 2.091 |
| Discovery → artifact proof | .276 | .192 | 0 |
| Artifact proof → all fragments received | 1.753 | .091 | 4.768 |
| Fragments → cache import complete | 1.726 | .909 | 2.707 |
| Cache import → artifact accepted | .272 | .242 | 0 |
| Artifact accepted → first sampled native job | .943 | .667 | 0 |

The last interval also contains .495 sampled cache-writer user CPU. Native jobs then consume15.313 sampled user CPU over6.346 seconds. Separate scheduler analysis found222 compilation jobs on four static worker batches and only~.6s final tail imbalance.

The immediate design can overlap at most the cache-export/import interval (~1.7s in this run), plus any driver setup moved into the child. It cannot recover all1.75s of emission or earlier graph discovery because no exact units are available yet. During cache import,4×1.726−(.909+2.707)=3.29 CPU-seconds were not sampled as compiler user work; kernel work and sampling error mean that is not guaranteed free capacity. Native and cache work contend for the same four CPUs, so1.7s is a scheduling ceiling, not a predicted speedup.

The run records50.805 root-inclusive user +5.707 system CPU seconds; another~.859 user CPU belongs to the detached cache writer. Even perfect four-core overlap therefore has a CPU-work floor above14 seconds for this version. Reaching~12.9 seconds also requires reducing work (unused slots/zero-storage ABI/other optimizations), not overlap alone.

## Validation

Structured Semantic tests cover nondeferred completion, a lost cache transport replacing the preview with actual serial source build (accepted=false), and abandonment clearing build evidence. Driver tests must cover coordinator failure, rejected semantic finish, native failure, exact object identity, no premature publication and descriptor cleanup. Native acceptance must compare output/debug artifacts and cold→edit→unchanged cache behavior. Matched one/four CPU measurements must use the same final source/binary with only the pipeline policy toggled.
