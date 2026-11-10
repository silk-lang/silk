# Finite frontier structured diagnostic parity

Binary: `/workspace/silk/.scratch/frontier-finite-final` (reported snapshot `59e447`). Corpus and stdlib: `/workspace/silk/.scratch/parallel-check-experiment`. Runner: `.scratch/frontier-corpus-parity.mjs`; repeat count 2. Runs held the shared performance lock. No performance conclusions follow from these tiny fixtures.

18 representative fixtures exercise generic specialization, recursive ownership/cleanup, provider identity/roles, lifetime-selected cleanup, callbacks, borrowing, environment escape, returned payload escape, and growing generic specialization. Each source is retained verbatim in `fixture.silk`; a wrapper plus 40 imported/called padding modules forces frontier eligibility.

- All 36 enabled runs reached a frontier split.
- All 20 valid runs accepted the merged frontier proof.
- All 16 invalid runs recorded explicit worker failure/missing-record fallback.
- All 36 enabled runs exactly matched the same binary with parallel checking disabled: full parsed JSON diagnostics (including code, severity, path, byte spans, line/column, message, notes, related locations, and order), exit status/signal/error, stdout, and non-trace stderr.
- The finite two-specialization cycle `generic-recursion-unowned-type` is explicitly expected to pass under the new policy. Growing polymorphic recursion still refuses with SEM0053 at 1:40–1:68.

The runner intentionally exits 1 because one independent legacy corpus assertion does not match the CLI: `call-result-wrapper-payload-escape` expects SEM0212 plus two later OWN0019 errors, but the CLI emits only SEM0212 at 8:19–8:25. This is pre-existing: stock `.scratch/N1-one` emits byte-identical diagnostics for the exact generated wrapper (`.scratch/frontier-payload-stock-wrapper.stderr`), and both stock and finite binaries emit the same single diagnostic for the unwrapped original root (`.scratch/frontier-payload-{stock,root}.stderr`). The corpus assertion was preserved, not weakened. All other fixture code/span/order expectations match.

Structured per-case evidence is `results.json`; each fixture directory retains `off.json`, `on-1.json`, `on-2.json`, and raw stdout/stderr.
