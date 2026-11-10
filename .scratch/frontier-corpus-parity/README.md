# Frontier parity probe

Scratch-only coverage for the experimental process frontier. `selection.json` records nine accepted and nine rejected corpus cases, their intended stress area, expected status, and diagnostic code/span sequence. Original expanded corpus bytes are preserved in each `fixture.silk`; the wrapper calls its public entry after forty padding calls, with forty imported modules ensuring the module-count gate can engage. No native executable is run; corpus programs whose runtime contract traps still must pass compiler check.

Prepare without starting a compiler:

```
node .scratch/frontier-corpus-parity.mjs
```

After the experiment owner releases CPU and supplies the current binary:

```
node .scratch/frontier-corpus-parity.mjs --run --compiler /absolute/path/to/silk-compiler
```

Optional `--case substring`, `--repeat N` (default two enabled runs), `--timeout seconds` (default 120), and `--output directory`.

Each invocation removes its own project's `build` directory for a cold comparison. Serial and enabled checks use the same binary and project path. Enabled runs set `SILK_EXPERIMENT_FRONTIER=1`, `SILK_FRONTIER_SHARED=1`, and `SILK_FRONTIER_WARM=0`. Old fork-experiment flags are cleared.

Assertions:

- Baseline matches the corpus acceptance/rejection and exact diagnostic error code/span/order contract.
- Each enabled result equals the baseline's complete parsed diagnostic objects, preserving diagnostic/related/note order, spans, severity, and path, plus status/stdout/non-JSON output.
- Every enabled run logs a frontier split. Valid cases must also log `frontier accepted`; invalid cases must accept with the same rejection or log an explicit fallback reason. Inactive experiments fail coverage rather than passing vacuously.

`off.json`, `on-1.json`, `on-2.json` retain structured diagnostics and all frontier traces; raw stdout/stderr are beside them. `results.json` is updated after each case so partial runs are reviewable. Runtime timing is recorded only for investigation, never used as a pass/fail assertion.
