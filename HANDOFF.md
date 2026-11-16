# Handoff: wasm benchmark Phase 0 (issue #3082)

Written 2026-11-16. Self-contained: a new session needs only this file and the pushed branch.
This file is committed at the root of the branch so that it travels with it; delete it before the
branch goes up for review.

## Goal

Issue [#3082](https://github.com/silk-lang/silk/issues/3082) plans to bring the direct wasm
backend's run time to LLVM's. Phase 0 is measurement only, all in `compiler/scripts`, with no
compiler changes:

1. Four engine configurations: V8 optimizing tier only, V8 baseline tier only, V8 default tiering,
   Wasmtime.
2. Each program repeats in one process for at least 200 ms; first run and steady-state median are
   reported separately.
3. A deterministic count of executed wasm instructions, computed in TypeScript.
4. A `profile` mode: per-function self time for both backends, plus counts of the instruction
   classes the issue tracks.
5. A measured noise floor.

## State

- Branch `wasm-bench-metrics`, pushed: the work is commit `38a4ae583` on top of main `0c722c828`,
  followed by the commit that adds this file. No pull request is open yet.
- The code for all five items is written and was exercised by hand. It is **not finished**: the
  tests and the README still describe the old tool (see "Left to do").
- `pnpm test:scripts` was not run on this commit and will fail: `WasmCorpus.test.mjs` still calls
  `wasmFunctionCount` and the old `timeRatio`/`meanRatio`/report shapes, which no longer exist.
- The full 25-program benchmark was never completed. It was stopped two programs into pass 1.

## What the commit contains

- `compiler/scripts/WasmModule.ts` (new): decodes a core wasm module (sections, function bodies,
  `name` section), counts instruction classes per function, and rewrites a module into a
  "counting" copy. The copy exports one `i64` global per straight-line run of instructions, each
  incremented once per entry, so executed instructions come out exact per class and per function.
  Unknown opcodes (SIMD, threads, GC, exceptions) are rejected, not skipped.
- `compiler/scripts/WasmEngine.ts` (new): runs a module under `v8-optimizing`
  (`--no-liftoff --no-wasm-lazy-compilation`), `v8-baseline`
  (`--liftoff-only --no-wasm-lazy-compilation`), `v8-tiering` (no flags) or Wasmtime. It is also
  the runner process V8 runs are spawned into.
  - V8: one process compiles the module once, makes a new instance per run, and times `_start`
    alone. Each run's stdout and stderr go to files and must equal the first run's.
  - Wasmtime: `wasmtime compile` once, then one `wasmtime run --allow-precompiled` process per
    run. The time is the process's wall time less the median wall time of an empty precompiled
    command, which is run before each real run.
  - Optional sampling through `node:inspector`'s CPU profiler, keyed by the function's byte offset.
- `compiler/scripts/WasmCorpus.ts` (rewritten around the two above):
  - `corpus`: unchanged in behaviour.
  - `bench`: `--engines a,b`, `--wasmtime <path>`, `--passes N` (default 2). `--runs` is gone.
    Report is `schemaVersion: 2`: per build `bytes`, `functions`, `executed` (instruction counts
    by class) and `timings[engine][pass] = { firstMs, steadyMs, runs }`.
  - `profile`: `--only a,b`, `--optimization speed|size`, `--engine` (a V8 one, default
    `v8-baseline`), `--top N`, `--json`.
  - `--baseline <earlier bench json>` prints the change in each program's direct/LLVM ratio per
    engine, then exact changes in executed instructions and module bytes.

## Decisions made, and why

- **Ratios are taken inside a pass.** A pass times the LLVM and direct build of one optimization
  back to back in each engine; a program's ratio is the geometric mean of its per-pass ratios.
  Absolute times from different passes or runs are not comparable on a noisy machine.
- **Noise floor = spread between passes**, reported per engine for ratios and for times
  (`ratioNoise`, `timeNoise`). The change table marks a ratio change `~` when the two reports'
  pass ranges overlap.
- **Repeat rule**: first run, then at least 2 more runs and at least 200 ms of them
  (`benchmarkRepeat`). The issue's "runs 2 to 6" would make `crypto-x448` (7.6 s direct) take
  several minutes per engine.
- **Per-run counters, not per-function**: gives executed counts per instruction class and call
  counts per function from one run. `block`, `loop`, `else`, `end` and `nop` are not counted.
- **Profile defaults to the baseline tier** because the optimizing tier inlines, and V8 then
  charges a callee's time to its caller.
- **Wasmtime has no "first run" row**: every run is a new process of precompiled code.

## Findings

- **Function names**: neither backend writes a `name` section in a non-debug build, and
  `--debug true` changes the generated code (direct `regex`: 1115 functions against 667). So the
  profile shows `#<function index>`, and direct and LLVM functions cannot be matched by name.
  Emitting names without changing code is a compiler follow-up.
- **The counter is deterministic**: `regex` gave 521,851,576 (LLVM speed) and 4,319,751,126
  (direct speed) executed instructions in three separate benchmark runs.
- **Static counts match `wasm-tools`** for `regex` (for example direct `local.get` 74,609,
  `unreachable` 11,466); rewritten modules pass `wasm-tools validate`.
- **This VM cannot time anything**: the same module run 40 times in one process took 12 to 24 ms
  per run (one run took 210 ms), with CPU time equal to wall time; steal was 8% and I/O wait 32%.
  Between passes, times of one build differed 19–27% typically and ratios 16–25%. Use the
  instruction counts here and time on a quiet machine.

Numbers from three programs on this VM, three passes (treat the times as rough):

| Measure | Speed builds, direct/LLVM | Size builds, direct/LLVM |
| --- | --- | --- |
| V8 optimizing, steady state | 7.26x (2 programs) | 2.20x |
| V8 baseline, steady state | 10.69x | 4.37x |
| V8 default tiering, steady state | 5.85x (2 programs) | 2.99x |
| Wasmtime | 9.05x (2 programs) | 3.08x |
| Executed instructions (exact) | 5.89x | 3.32x |

Programs: `regex`, `streaming-inflate`, `json-value`; "2 programs" is where
`streaming-inflate`'s LLVM time fell under the 2 ms floor.

`regex` speed build, executed per run, direct against LLVM: all instructions 8.3x, `call` 194x
(109 million against 0.56 million), `local.set` 11.4x, `local.get` 10.1x, stores 7.1x, loads
5.6x, `br_table` 0 against 4.9 million.

## Left to do

1. Rewrite `compiler/scripts/WasmCorpus.test.mjs` for the new API (`ratio`, `timeRatio`,
   `meanRatio`, `timeNoise`, `ratioNoise`, `summaryTable`, `benchmarkTable`, `changeTable`,
   `hottest`, `profileTable`). Move the function-count test to a new `WasmModule.test.mjs`.
2. Add `WasmModule.test.mjs`: decode a hand-assembled module, reject a truncated one and an
   unsupported opcode, and run a counting module in-process to check counts against a hand count
   (loop, `if`/`else`, `br_if`, call, dead code after `br`).
3. Add `WasmEngine.test.mjs`: `median`, `timing`, `wasmtimeOutcome` (trap is status 134 with
   `Error: failed to run main module` on stderr), and one spawned run per V8 engine on a tiny WASI
   module. Tests have a 3 s timeout and CI has no Wasmtime.
4. Update the "Wasm corpus and benchmark" section of `compiler/README.md`.
5. Known flaw: in `summaryTable` the per-pass range can exclude the headline (seen:
   `9.05x (6.06x to 8.93x)`), because a pass's mean drops programs under the 2 ms floor that the
   headline keeps. Make both use the same set of programs.
6. Read the whole of `WasmCorpus.ts` once more for leftovers; it was rewritten in pieces and not
   reviewed end to end.
7. Run the full benchmark on a quiet machine and record the baseline in #3082. Expect roughly
   25 minutes for two passes in four engines; `crypto-x448` dominates. A quick loop is
   `--engines v8-optimizing --passes 1`.
8. Open the PR for review. No changeset is needed: this is a developer tool.

## Setting up on another machine

```sh
git fetch origin && git switch wasm-bench-metrics
pnpm install --frozen-lockfile

# Build a current compiler: download the seed pinned in compiler/native-seed.json for the host,
# check its sha256 against that file, then build (about 5 minutes, about 5 GB of memory).
gh release download 'v0.1.0-dev.82+26eee9dbea76' --repo silk-lang/silk \
  --pattern silk-compiler-x86_64-unknown-linux-gnu
chmod +x silk-compiler-x86_64-unknown-linux-gnu
(cd compiler && ../silk-compiler-x86_64-unknown-linux-gnu build src/main.silk -o /tmp/silkc \
  --stdlib ../stdlib --optimization speed --debug false)

node compiler/scripts/WasmCorpus.ts bench --compiler /tmp/silkc --only regex,json-value \
  --wasmtime "$(command -v wasmtime)" --json /tmp/bench.json
node compiler/scripts/WasmCorpus.ts profile --compiler /tmp/silkc --only regex --top 8
```

Needs Node 24.15 or later and, for the Wasmtime engine, a `wasmtime` binary (50.0.0 was used). On
the Linux VM the build also needed `--clang /opt/llvm22/bin/clang`.

## Only on the old VM (not needed to continue)

- Compiler built from `0c722c828`: `~/.silk-dev/scratch/bench-phase0/n1/silkc`.
- Wasmtime and wasm-tools: `~/.silk-dev/wasi-tools/`.
- Partial results: `~/.silk-dev/scratch/bench-phase0/probe/b3.json` (three programs, three
  passes), `p1.json` (`regex` profile).
- The earlier worktree `t3-ce364208` (branch `t3/wasm-bench-phase0-metrics`) is still empty; all
  work is on `wasm-bench-metrics` in `/home/user/silk`.
- Commits are authored as the repository owner with no `Co-Authored-By` line.
