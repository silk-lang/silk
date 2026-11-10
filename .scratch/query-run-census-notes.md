# Exact expensive-query diagnostic

Source commit ab714161df5704b44e014228c79367dd6bb1ce9d depends on CacheWorkTrace (9526b6949). Root integrates and validates it; no standalone compiler was run.

Enable SILK_QUERY_RUN_CENSUS=1 for counters. SILK_CPU0_CACHE_TRACE=1 independently enables phase timing; both together bracket all identity serialization/file output with query-census-dump-begin/end, including monotonic timestamp and PID/TID. Perf-only omits counters/dumps; counts-only omits timing events. Diagnostic allocations, bookkeeping and serialization invalidate benchmark timing claims. Excluding dump samples alone does not remove per-event overhead or scheduling perturbation.

Files: /workspace/silk/.scratch/frontier-failure-PID-PHASE.query-runs. Despite the reused failure-dump filename prefix, these are successful diagnostic snapshots. Phase 0 precedes initial worker transport; phase 1 follows retained service and supersedes phase 0 for totals; phase 2 is coordinator pre-save, before detached writer fork. Save/saveTracked only, not the detached child's save. Failure paths may omit final dumps. Treat a missing worker/final phase as incomplete coverage. Check file sizes/magic/full parsing, since existing diagnostic file writes may fail without failing compilation.

Use a fresh output collection per invocation and drain all workers/writers before collecting. The narrow diagnostic supports the benchmark's single immutable semantic store per PID; a second store in that PID could overwrite the same phase filename. Never combine invocations/source edits: source snapshot equality is a harness precondition, not inferred from target stamp. Parent and worker copies are the same immutable snapshot. The stamp includes target/profile; each row additionally includes stored scoped application/profile and stable module/declaration identity. Origin transactions, condition contexts, coroutine variants, unknown profile slots and excessive encodings are explicitly excluded. No excluded row is counted as a duplicate exact key.

Units and supported context tables are append-only throughout an immutable store. Query forget/rollback clears answers, not unit identity. Fork children reset local accounting; their boundary labels preexisting keys, not inherited memo answers. preexisting_unit_hits/new_unit_hits count hits before any local provider start. unmatched_finishes describe a finish without a locally recorded start (including a provider active at fork), not inherited completion ownership.

Provider Start is actual execution; Hit and provenance_mentions are separate. Provenance mentions count source-local evidence requests at each artifact cache packet construction, including entries that may subsequently be filtered; they are NOT wire bytes, final root counts, or executions. Carried evidence without a local unit is excluded. Repeated packet constructions can repeat mentions.

Limits: 131072 tracked units/process; dropped is untracked events, not distinct keys. Exact row keys capped at 1MiB (individual runtime/application encodings 256KiB), identity work stops after output reaches 64MiB; remaining rows retain counts with exclusion reason. At most one additional key and bounded row metadata exceed the 64MiB threshold. No providers are invoked by dump encoding: it reads existing immutable Application/InstanceKey/profile/module/declaration data using &Resolver and cannot mutate counters.

Decode a single invocation:

    python3 .scratch/query-run-census.py --invocation compiler-cold /path/to/collected/*.query-runs

The parser chooses each PID's latest phase and fails duplicate PID/phase or truncated payloads. It compares full identity bytes, not digest equality. supported_exact_by_family separates starts, unique started keys, cross-process repeats and same-process repeats. These counts do not imply the CPU cost or profitability of sharing answers. Matched perf-only samples and scoped architectural analysis remain necessary.

Validation update: root merged into V24 fe11b2fee39ec0c1aad9246970bd160156b399c6, fixing the runtimeLength comparison's effect-expression precedence and removing one unused import. Full sourcecheck passed. The copied exact modules' focused counter/reset test passed 1/1 (0 cached), receipt .scratch/query-census-focused/receipt.json, all children reaped. The diagnostic compiler bootstrap is root-owned.

For profiled invocations with both flags, require exact process coverage:

    python3 .scratch/query-run-coverage.py --tasks tasks-and-samples.txt --events trace.log --root-pid PID --lane parallel collected/*.query-runs

Use lane serial for the pinned single-CPU invocation. The invocation harness separately asserts CPU affinity and host-capacity refusal on eligible cold workloads. Coverage consumes perf fork/exec/exit sideband (not polling), requires worker phases 0+1 and coordinator phase2, validates each one-shot begin/end row+byte receipt, and refuses unknown descendant roles, duplicate phases, missing process exits, lost records, or truncated output. This catches successful fopen/write failures and multiple-store phase overwrites. Different native compiler subcommands retain their source-backed role via native-coordinator-work-begin; cache writers use write-files evidence. A new unclassified process must be investigated, never excluded to make coverage pass. Unsupported semantic contexts remain explicit exclusions in the count report; encoding capacity exclusions refuse a complete census claim. Counts-only unprofiled controls have no independent exact process-tree guarantee and must be labeled accordingly.
