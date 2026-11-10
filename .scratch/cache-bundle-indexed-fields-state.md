# Immutable Bundle scalar access repair

Separate branch `codex/cache-bundle-indexed-fields`, exact V21 base `a0fb61fcc`.

- `eafd8315d`: authenticated leaf scalar offsets plus reachability examination memos.
- `5a5be2109`: only after the structural source/focused gates passed, incorporated the narrow private-validation/authenticated-digest follow-up (same patch as ae6918d49).

IndexedShard retains a private u32 scalar-field offset for each leaf, populated during the existing complete packed-key/field validation. Each offset remains bound to the same immutable Arc bytes. Later scalar reads start at that validated offset while preserving the original packed-key position for key cursors. No cache wire format or validation condition changed. INDEX_BYTES is512MiB, so every stored offset fits u32. The additional retained cost is4bytes/leaf, at most32MiB at the8,388,608-leaf cap (~1.98MiB for the measured519,601-leaf Harf cache). It does not create a dense global graph or copy keys/answers.

Liveness now tracks direct-leaf examination separately from liveness and memoizes successful recorded-file kind checks. A file may have been marked live without being directly examined; that distinction is preserved, including fresh file→file links and a later invalid input masquerading as a file. Two temporary bool arrays cost2bytes/leaf (~0.99MiB Harf; maximum16MiB); they belong to one immutable compute invocation and cannot outlive an overlay/directory mutation.

Structural full sourcecheck passed. Focused driver/codec/Live/scalar tests9/9 passed20ms before combining the tiny follow-up. Combined focused tests9/9 passed20ms as well, including atomic corrupt/missing-shard publication, malformed bundle rejection, eight normalized/pruned generations, reverse scalar/key reads across packed-key restart groups, damaged constructor refusal and unusual direct/file reachability semantics. Combined whole-source recheck passed14.71s, all compiler/writer processes reaped. Coherent source:5a5be2109e8f65472869ef147ae6364df91cb62d.

No optimized repair binary or runtime performance claim yet. Required next: matching four-unitO2/noPGO construction, native/pipeline/corruption gates, real Harf cold→direct first edit→unchanged with settled writer CPU/phase evidence, then both CPU lanes against the appropriate frozen controls before any promotion. V21 remains rejected until those gates pass.
