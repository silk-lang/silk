# Isolated coarse CLI persistence experiment

Source snapshot: `git archive HEAD` into `.scratch/coarse-cache-experiment`.
Build package: `.scratch/coarse-candidate-package` (source symlink, speed-four profile).

Flags (presence enables):
- `SILK_EXPERIMENT_COARSE_BUILD`: CLI build semantic store becomes Transient; suppress semantic image prefetch/open/save. Existing import summaries and outer BuildInputs whole-artifact `.inputs` lookup/record remain.
- `SILK_EXPERIMENT_COARSE_CHECK`: check store becomes Transient and stores a whole result after ordinary prepare. `--roots` keeps ordinary behavior.
- `SILK_EXPERIMENT_COARSE_TRACE`: print `whole-check hit` / `whole-check record` for acceptance evidence.

Whole-check key: compiler stamp; final profile/target identity; entry/manifest/display paths; JSON mode; SILK_VERIFY_MIR; every immutable loaded revision mapping including presence and source digest; ordered root/checked/runtime IDs; current loading READ/STAT/LISTING observation envelope. No supplied profile bindings are persisted. Immutable revision includes source bytes served from shared SourceSnapshot and generated module bytes even when Recorder excludes newly produced files. Normal prepare still evaluates build.silk, validates tool inputs/outputs, and emits load/tool warnings on every invocation. Cached diagnostics contain only the semantic suffix after prepare, so loading diagnostics cannot be doubled.

Recorder refuses publication after conflicting observations of the same operation/path within a load. Its existing whole-artifact behavior is otherwise preserved. Full semantic work uses the existing path; whole result only skips it when an identical loaded world matches.

Tradeoffs: warm checks still pay normal load; any observed source edit causes full semantic recomputation; current whole-artifact warm builds still avoid load. LSP keeps existing fine-grained store. This experiment is not a production default choice. Root proposed a later adaptive policy: cold uses Transient, first edited invocation begins populating fine-grained cache, later edits retain fine-grained reuse.

Required acceptance before benchmark: compile scratch; compare baseline/coarse check status+JSON diagnostics for valid, warning, rejection, missing/new module, generated/tool outputs, shared-source workspace cases; demonstrate trace hit on unchanged check and miss after relevant edit; compare generated artifact SHA256 off/on at same source path/profile; verify unchanged artifact reuse and changed source invalidation.

## Measured first prototype (one paired trial; no promotion)

Fresh source/build directories, same executable off/on; process-tree CPU includes detached writers. Source fixtures: Silk a63f612150a0b91a118c8111b910b12c3e124b50; nonstd ccb168b773bb56d7bd60a3495141d427149766d0.

| Workload | off cold wall / CPU | coarse cold wall / CPU |
|---|---:|---:|
| compiler check | 21.340 / 23.450 s | 18.282 / 18.689 s |
| Harf check | 6.889 / 7.966 s | 5.766 / 5.899 s |
| compiler build | 37.232 / 58.137 s | 31.482 / 50.884 s |
| Harf build | 10.864 / 16.403 s | 9.010 / 13.744 s |

Compiler build artifact byte-identical (ede6e62cc756865d0109250b62ae50c9c2d976ad3c9ada4ed1c3d2a4aba534b1). Three small scalar/generic/control fixtures likewise byte-identical from separate clean builds and reused artifacts without changing mtime. Harf artifact differs reproducibly: off a816668a15f10ccfe777c4d0db55c8e41db21ad71375adfab97393108e287abe; on 598acfa7d4871e3bfca6b70e74465e889379b1420415251fd240c3b71a82b471. Root owns investigation. Saved builds below benchmarks/coarse-xa9ikfet/{nonstd/build,harfrust-on-build}.

Always-coarse edited checks are unacceptable: compiler fine-cache body edit 0.266 s vs coarse 18.612 s, Harf fine-cache 0.309 s vs coarse 5.757 s. Root proposed adaptive cold-first then retain fine tier; not implemented yet.

Large first warm checks missed initially. Exact raw key diff established that revision/root bytes were identical; only seven ancestor STAT observations from saving import summaries differed. Changed loads saved cache and thus probed ancestors; unchanged loads did not. Fix now defers import summary save until outside the load recorder in coarse check. No broad directory exclusion or key ordering change. Debug key dumps available under coarse-key-{0,1}.bin and coarse-observations-{0,1}.bin. Rebuild/first-warm acceptance pending.

Diagnostics after prepare reread filesystem source text and typo-suggestion directory lists. Their observations now live in a separate BuildInputs envelope around the result payload, validated on every hit; cache reads/writes lie outside both recorders. Load/tool warning bytes remain outside the cached suffix.

## Fixed warm guard verified

The import-summary publication fix passed 43 small check invocations, including explicit first-warm hit for a fresh project whose source root excludes its build output. Large compiler/Harf first warm checks now both hit with exactly identical diagnostics. Exclusive one-run warm evidence: compiler 0.095 s, Harf 0.172 s; `.scratch/coarse-warm-proof.log`. A package with source="." can legitimately need another warm pass when its first cache creation changes that observed source directory's listing; this input is not hidden.

Own experimental patch: `.scratch/coarse-cli-cache.patch` (main.silk, SourceRevision.silk, BuildInputs.silk). Agent interning subsequently staged an independent scratch-only DWARF fix in TypeText.silk/LlvmCode.silk; `.scratch/dwarf-runtime-names.patch`. Current v4 compiler binary verifies the cache changes but predates the DWARF patch. Root schedules its focused test/rebuild and decides adaptive policy. No production files were changed by this coarse-cache experiment.

## Adaptive tier implemented in scratch

`SILK_EXPERIMENT_ADAPTIVE_CACHE` enables both whole-check reuse and cold-first semantic recording policy. A small marker, named by compiler bytes + INITIAL profile + entry/manifest/stdlib identities, determines mode before prepare: new identity selects Transient; completed prior semantic work selects Cached. The marker is only history, never reuse evidence. Payload final profile/source/root/load/diagnostic guards are unchanged. Unchanged checks return whole result before opening the fine image. A first changed result populates the fine image; later edits reuse it. Builds retain their existing whole-artifact fast path and use the same history policy when semantic work is necessary.

Tradeoff: the first edit after a genuinely cold invocation can still pay full semantic work plus graph recording. Subsequent edits regain fine-grained reuse. Different compiler bytes, initial profile or root start cold again. Supplied profile bindings remain ineligible for disk history/results.

Validation: adaptive lifecycle harness passed 14 invocations. For both check and build, cold mode was Transient with no semantic image; first edit selected Cached and adopted 0 roots while producing an image; second distinct edit selected Cached and adopted 52 roots. Next unchanged check hit the whole result and next unchanged build hit the artifact. New profile/compiler-byte/root cases selected Transient. Full source/tool/generated-output/diagnostic/workspace guard harness passed all 43 invocations under adaptive policy. Structured TypeText lifetime-erasure test passed 1/1. Combined optimized compiler builds successfully. `.scratch/adaptive-acceptance.log`, `.scratch/adaptive-full-guards.log`.

Harf off/adaptive cold byte-equality verification with the DWARF fix is in progress; no performance claim is made for shared-lock correctness runs. Root's CPU gate: benchmark harnesses use exclusive `.scratch/performance.lock`; build/test/correctness runners use shared lock, at most two heavy jobs.

## Adaptive + DWARF validation complete

Full Harf executable now matches byte-for-byte from separate clean off/adaptive builds, including debug metadata: `5695d1fcc79a0364d276a8a45d5a0bd16a9c0b1325196a5f07164fdc582607f2`. Saved trees: `benchmarks/coarse-xa9ikfet/harfrust-fixed-off-build` and `harfrust-fixed-adaptive-build`; log `.scratch/verify-harf-dwarf.log`. This was a shared-lock correctness run, not a performance sample. No active compiler/writer remains from this work.

## Authored inputs below cache directories: independent review correction

Independent review reproduced stale whole-check success when a path dependency lived at `build/cache/vendor`: changing only its manifest exports A→B left loaded module bytes unchanged while the old broad cache-parent exclusion hid the manifest read. The corrected CLI `prepare` now performs no semantic-cache I/O: summaries are opened before and published after it. The whole-check load recorder has no directory exclusions. Rebuilt corrected compiler rejects the changed export with the same MOD0003 span7..15 as serial, while unchanged warm hits still work. Lifecycle14 and source guard43 are being repeated.

The same review reproduced a pre-existing whole-artifact stale reuse bug on stock N1-one. Its recorder also excluded complete cache subtrees. The scratch correction removes cache-directory exclusions from build/test/hash and puts strictly disposable SemanticCache/CodegenCache CLI operations under an explicit MachineFileSystem provider. Their library APIs retain injectable filesystem behavior. NativeCompile mixes cache metadata and actual C/header reads; only the former bypass recording. Authored dependencies remain inputs wherever their paths lie. The permanent native-build fixture checks export-only manifest changes for both check and build. No promotion/performance conclusion precedes rebuilding and proving these guards.

Execution inputs are frozen: experimental stdlib/tomledit/schema all come from `.scratch/coarse-cache-experiment`; production main/stdlib changed externally and must not be mixed into these comparisons. Matched benchmark workloads separately archive `/workspace/silk-baseline` and `/workspace/nonstd`, record revisions/binary hashes, and share the archived baseline stdlib for both policies.

## Cache boundary correction validated

Final corrected experiment compiler SHA256: `eef49149dc28141096c2fbd28a3b855b72b7825f2cd4ed318ee642d462decf45`. Frozen full source check and optimized bootstrap pass. Final verification: 43 check guard invocations, 14 adaptive lifecycle invocations, 12 small artifact off/on/warm invocations, both-policy manifest-export invalidation under `build/cache/vendor`, and four native builds whose authored C/header live inside the actual `.native` cache. The header survives pruning and its 17→23 edit changes the executable exit code. Stock old compiler reproduced stale artifact success; corrected off and adaptive both reject MOD0003. Logs: `adaptive-final-guards.log`, `adaptive-final-acceptance.log`, `adaptive-final-artifact-guards.log`, `artifact-cache-inputs-fixed.log`, `native-cache-inputs-fixed.log`.

Review conclusion for the isolated experiment: no known stale-result issue remains in these authored-source, manifest, tool/generated-output, diagnostic, or shared-snapshot paths. Production integration still needs adaptation to new upstream CLI plus ordinary integration validation. SemanticCache and CodegenCache library APIs retain injectable filesystems; their CLI calls explicitly bypass input recording. NativeCompile keeps authored input effects ambient and gives only cache metadata its own host provider. Native cache pruning now recognizes its own digest/suffix filenames and preserves unrelated authored files. This correction is required independently of adaptive policy.

History is shared across check/build for the same initial root/profile identity, so check followed by first build may choose Cached. The measured cold definition deletes the complete private workload build directory before each invocation. First edit after cold intentionally populates fine cache; second edit reuses it. Final two-round measurements pending coordinated exclusive CPU slot.

## Final matched measurements

Two AB/BA cold rounds on CPUs 0–3, exclusive performance lock. Each cold trial removed the entire private workload build directory; OS page cache retained. Same executable, source/output paths, default profile, pinned baseline stdlib, LLVM 22.1.8, and `--progress plain --timings`. Detached writers reaped before every following trial. Exact commands, source-file digests, compiler/LLVM hashes, and resource measurements live in metadata.json/results.json.

| Workload | Cold wall off→adaptive | Speedup | Tree CPU off→adaptive | Max individual RSS MiB off→adaptive |
|---|---:|---:|---:|---:|
| compiler check | 20.723→18.396s | 1.127× | 22.816→18.771s | 3117→2750 |
| harfrust check | 7.204→5.920s | 1.217× | 8.246→6.061s | 1178→876 |
| compiler build | 36.970→31.968s | 1.156× | 57.996→51.177s | 4084→3616 |
| harfrust build | 10.700→9.071s | 1.180× | 16.138→13.674s | 1414→1119 |

Off check settled-wall medians including detached writers: compiler 22.139s, Harf 8.060s. Adaptive settled-wall matches foreground 18.396/5.920s. Build writers finish before foreground returns in these trials. RSS is maximum individual-process RSS, not simultaneous aggregate memory.

| Workload | First edit off→adaptive | Second distinct edit off→adaptive |
|---|---:|---:|
| compiler check | 0.278→20.674s | 0.270→0.379s |
| harfrust check | 0.304→7.282s | 0.297→0.355s |
| compiler build | 0.887→29.055s | 0.872→0.882s |
| harfrust build | 0.406→8.563s | 0.393→0.405s |

The cold policy has a material one-time first-edit penalty: it starts recording the fine graph on that invocation. Second edits recover fine-cache behavior; warm unchanged checks reuse whole results, and warm builds retain the whole-artifact path. These results do **not** justify automatic adaptive-default promotion and do **not** meet 3× alone. Parent plans to evaluate combination with parallel semantics before selecting policy. Cache-I/O correctness fixes and whole-check reuse can be considered independently.

All 48 invocations passed. Compiler and Harf artifacts match byte-for-byte off/on in both rounds, with identical per-workload hashes across rounds:

- Compiler: `e993e0f8b6a0c9f3bdf489ea2364f92da9f17c8ae76192ff228af9d9a5218dd7`
- Harf: `bf3fd21b9421959dd29f3cdf63fe4eabd034e7390a4183b2eca8ace617dee5e3`

Correctness gates before measurement: 43 source/tool/generated/diagnostic/shared-snapshot check invocations; 14 lifecycle invocations proving cold Transient, first-edit Cached, second-edit reuse, and new compiler/profile/root reset; 12 small build/reuse byte checks; manifest-only edits under build/cache/vendor correctly rejected by both off/on; authored C/header under actual native cache preserved and 17→23 header edit reflected in executable. Permanent fixtures are in scratch compiler/scripts/test-native-build.ts.

