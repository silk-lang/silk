# Completed-body sharing prototype status

The prototype is isolated from product integration, based on V22 `85ba82e`. It reuses completed ordinary typed Body answers across the existing process workers through an epoch-bound READY arena, portable typed-body/type dictionaries and complete source/query guard DAGs. No in-flight waiting, no raw post-fork pointers, no persistent capsule cache, no source/schema admission broadening. Body publication follows completed graph/location observations; source/application/profile context and payload/guard seals are validated before installing an answer. Unsupported and exhausted entries compute locally.

## Frozen controls

| Source | Binary | SHA256 | Arena |
|---|---|---|---|
| `c894d78d53b17efca6c22d76f078b7050ebeda71` | `.scratch/frontier-shared-typed-body` | `7cc612a86aef4d1cbdf99ecc4a6fe4a7e39c34cfd324b62bcbe296d174ae4450` |128MiB|
| `11ee61dec0821425122954bee2cb98219aece05d` | `.scratch/frontier-shared-body-guard-reuse` | `beda77845e286af49a7aa06fb1364268ac4514482ae2294a6de9d9e95931f44d` |128MiB|
| `5a17dbb17d54aedfb8c0625e90c0ff4eedfde57e` | `.scratch/frontier-shared-body-capacity` | `4ff30cdeab6162b5de8d4504cf1f448420b79cd41d2a2c40612ab1f904636dd7` |512MiB|

All three were built with the same pinned N1/Clang22 four-unit O2/no-PGO recipe, feature/trace flags off during construction. Each source/build receipt is `.scratch/frontier-<corresponding-name>-{sourcecheck,build}.json`. Completed construction outputs were removed only after verifying immutable copied executables; cleanup receipts remain. Focused runners were gzip archived with decompression SHA validation.

## Correctness gates

- Full compiler sourcechecks and bootstraps pass.
- Portable payload/type dictionaries preserve Stage, nested owned bodies, metadata, lifetime bindings and NaN payload; malformed/context/reference/resource refusals tested.
- Arena test covers release/acquire publication, actual fork, child exit before read, corruption, epoch replacement, reserved producer nonblocking miss, precise exhaustion.
- Real forked producer computes an ordinary body, exits and is reaped; a fresh receiver/type store avoids exactly one Body provider and retains correct cache guards after save/new invocation/body edit.
- Unchanged caller source with changed callee signature or name roster reports exactly the fresh serial ordered diagnostics after imported-body cache save/adoption.
- Cycle, Condition-ledger and opaque adopted ModuleCheck dependencies refuse export; imported synthetic conjunctions are the only admitted ModuleCheck guard kind.
- Imported guard reuse records original authenticated offsets only after finishRun. Test checks exact identity for actual imported Body and synthetic guard units, and a dependent completed body references the original DAG. This path is correct but has **zero engagement** in the compiler workload.
- Guard exporter caches failure causes, separating first-discovered semantic/resource/exhaustion/contention/unavailable/import refusal. First failure is not a claim that no later failure would occur.

## Measurements and disposition

Initial full compiler engagement `shared-bodies-engagement-16y3crgb`: avoided2250, published3240, arena128MiB full before module finish. Matched same-binary OFF/ON16-call screen `shared-bodies-sequence-dya5wcmp` was near-flat CPU: cold check34.620→34.815CPU seconds, build63.047→63.093; all stage native artifacts identical. No promotion.

Guard-reuse engagement `shared-bodies-engagement-fyeiagmt`: avoided2271, imported-offset-reuse0. Arena exactly128MiB. Physical allocation closure: input47,542,960 + DAG21,325,560 + body64,824,384 + file528 + directory524,296 =134,217,728. Refusals15,485: first exhaustion15,157; semantic321; resource6; invalid-import1. No timing pair justified for the unengaged narrow reuse path.

512MiB capacity-only engagement `shared-bodies-engagement-6iuqyu03`: avoided6876 (4824initial,2052artifact-service), published12874, payload172,139,693. Arena333,008,896bytes; exhaustion0. Exact physical closure: input104,374,256 + DAG55,511,224 + body172,596,376 + file2744 + directory524,296. Semantic572/resource8/import-invalid1; codec unsupported1746(schema1740,witness6). Imported-offset-reuse remains0. Diagnostic CPU64.399seconds versus prior128MiB diagnostic64.350 is not a matched performance claim. Max individual process RSS1,990,808KiB is not aggregate PSS. Root/profiling own the next matched comparison and memory interpretation.

Stop further fork-codec format/coverage optimization if higher coverage remains CPU-flat; root has authorized a separate direct-thread immutable payload/shared-interner exploration. No blanket claim of 3x, CPU savings from avoided counts, or current production promotion.

## Final disposition: serialized body sharing rejected

The 512 MiB same-binary OFF/ON formal screen (`.scratch/benchmarks/shared-bodies-sequence-jzvt1quh`, 16/16 calls, all writers reaped) showed cold check 10.789→11.227 s and CPU35.178→35.771 s; cold build19.425→20.218 s and CPU61.755→63.756 s. Actual reuse was6,001 check /6,629 build with330.94/333.03 MB arena use and zero exhaustion. All hashes/runtime outputs matched. Higher reuse therefore did not offset capsule/provenance transport: no promotion, no repeated tuning. Direct native-thread immutable payload sharing is a separate architecture experiment; these binaries and evidence remain preserved controls.
