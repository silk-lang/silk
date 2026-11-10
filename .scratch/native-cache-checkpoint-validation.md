# Early native cache checkpoint validation

Implementation: `9948dbef9` on exact V17 `060ec3a13`. Combined diagnostic source: `2d2d0e5ed449448a8b48248eaa39ac75e1c7b9ab` (V18), including independently validated green-root reuse.

The driver saves only the accepted final semantic/IR result, after import, syntax and missed-source checks, before waiting for the private native coordinator. One checkpoint flag suppresses the late writer. The detached writer now writes fresh packs, then their semantic image, then best-effort prunes, under the existing lock. Its directories are prepared before fork; a detached child cannot recreate directories removed by clean. Native failures still require ordinary authoritative compilation, and final artifacts remain unpublished until compile/link succeeds.

## Completed correctness gates

- Full isolated and combined compiler source checks passed.
- Detached pack body/reuse/clean fixture: 1/1 passed.
- Native private publication/failure/reaping fixture: 1/1 passed.
- Small native lifecycle: 13/13 compiler invocations passed, including actual cold debug overlap, exactly one early checkpoint, injected coordinator failure and ordinary fallback, unchanged/direct-edit no-fork behavior, invalid-edit output preservation, and cold CPU0 automatic refusal with exact serial artifact/runtime.
- Harf optimized release: 2/2 compiler invocations passed with actual coordinator engagement and unchanged ordinary partition threshold. Checkpoint occurs before native publication. All four object hashes, executable bytes, ordered warnings and Latin/Arabic shaping outputs match off/on.

Binary: `.scratch/frontier-native-checkpoint-diagnostic`, SHA256 `b0c3ae6b19a3745ffd42185e0fd69ce35ab6d44c993b7591433c0b0546d7e9ba`.

Evidence:
- `.scratch/native-cache-checkpoint-validation-receipt.json`
- `.scratch/frontier-native-checkpoint-diagnostic-build.json`
- `.scratch/benchmarks/native-pipeline-eri4bb06/results.json`
- `.scratch/benchmarks/native-pipeline-harf-release-r16mn4m1/results.json`

All gate processes and detached writers were reaped. Generated package/object caches were removed with receipts; binaries, sources and logs remain. The diagnostic compiler uses four native units without PGO; these shared correctness runs do not establish a performance gain against mono-PGO V17. Same-binary exclusive immediate off/on controls remain required before policy promotion.

## Exact completion barrier (V19)

Commit `3fa44d65ae63ee10dfb09e8bcfaf82ce0af21fca` gives an accepted early checkpoint an owned exact-child completion token. Normal detached saves explicitly disarm it. The pipeline token remains alive through native publication and final linking; scope cleanup joins its writer on success, fallback, and error. A cache write failure remains best effort. It never waits for an unrelated writer or relies on a removable lock pathname. The writer child exits directly, so it does not run inherited parent cleanup.

Combined source `b0f222d1cddb807bc0aa2bd66965ee7b68e518be` passed sourcecheck and four-unit non-PGO construction. Archived binary `.scratch/frontier-native-checkpoint-completed-v19` has SHA256 `d28229b60666ebe8acb8ff107ef048f72a72607d6475768fe6d1f4e53de622f3`.

- Focused completion ownership/error-unwind, pack reuse/clean, and native publication/reaping gates passed. Receipt: `.scratch/native-cache-completion-validation-receipt.json`.
- Completion-aware small lifecycle passed13/13. Successful coordinator and injected native failure each have exactly one checkpoint, then publication/refusal, then completion. Both leave no writer for the subreaper to adopt. Cold CPU0 declines parallel work and matches serial bytes/runtime. Evidence: `.scratch/benchmarks/native-pipeline-jmk4a_f0/results.json`.
- Optimized Harf off/on passed2/2 with actual pool/coordinator engagement, all four object hashes, executable bytes, ordered warnings, help and Latin/Arabic shaping identical. ON has no detached children; OFF retains the ordinary detached writer policy. Evidence: `.scratch/benchmarks/native-pipeline-harf-release-p05z2i4i/results.json`.

All validation processes and writers settled. Generated package output was removed only after executable/hash archival; completed duplicate source snapshots and the pack-test executable were losslessly compressed with receipts `.scratch/frontier-native-checkpoint-completed-v19-cleanup.json` and `.scratch/native-v19-settled-cleanup.json`. These shared correctness gates do not establish a speedup. A same-binary exclusive immediate-edit control remains required.
