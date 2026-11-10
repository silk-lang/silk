# Cold compiler performance evidence

Measured 2026-11-08. These changes improve the measured workloads by 1.07–1.17×; the 3× goal is not reached.

## Comparison

- Baseline A: `a63f612150a0b91a118c8111b910b12c3e124b50`, `/workspace/silk/.scratch/N0-one`.
- Candidate B: `cd516eb5d5c85be23aee4cb58c8be7c07308c566`, `/workspace/silk/.scratch/N1-one`.
- Both compiler executables use the same single-unit Clang O2 configuration, debug information disabled, without PGO.
- Compiler workload and stdlib: baseline commit `a63f612150a0b91a118c8111b910b12c3e124b50`.
- Harfrust CLI workload: nonstd commit `ccb168b773bb56d7bd60a3495141d427149766d0`, package `fonts/shape/tools/cli`.
- Linux x86-64, CPU affinity `0-3`, cgroup budget `400000/100000` (four CPUs). No competing compiler or benchmark processes.

Each workload ran A B A B sequentially, from one private committed-source snapshot. Its workspace-root `build/` directory was removed before every trial. OS page caches were not flushed. All 16 compiler invocations and every detached writer exited successfully.

## Results

Times are arithmetic means of two trials per executable. Speedup is A/B. RSS is the maximum observed process peak across the two trials, not simultaneous aggregate memory.

| Workload | Operation | Foreground A → B | Speedup | Settled A → B | Settled speedup | Foreground peak RSS A → B |
|---|---|---:|---:|---:|---:|---:|
| compiler | Check | 21.918 → 20.063 s | 1.092× | 22.493 → 21.407 s | 1.051× | 2852 → 2828 MiB |
| compiler | Default dev build | 38.237 → 35.743 s | 1.070× | 38.237 → 35.744 s | 1.070× | 4061 → 4001 MiB |
| harfrust | Check | 7.634 → 6.525 s | 1.170× | 8.053 → 7.372 s | 1.092× | 1027 → 995 MiB |
| harfrust | Default dev build | 11.286 → 10.472 s | 1.078× | 11.286 → 10.472 s | 1.078× | 1321 → 1284 MiB |

The measured build command uses the default development profile: optimization `none`, debug information enabled. These are not optimized/release-build timings. The compiler executables performing the builds are optimized as described above. No release-build or runtime-quality result is inferred from this table.

Silk forks a detached process to finish its semantic cache. Foreground time ends when the compiler command returns; settled time also waits for its detached writers. The harness becomes a Linux child subreaper, waits for those writers before starting the next trial, and records their CPU and peak RSS separately. Lazy source fingerprints move some work into those writers, so foreground gains are larger than settled gains for `check`. For the measured builds, writers finish before linking ends.

| Workload | Operation | Foreground user CPU A → B | Whole process-tree CPU A → B | Largest process RSS, including writer, A → B |
|---|---|---:|---:|---:|
| compiler | check | 20.934 → 19.181 s | 23.179 → 22.118 s | 3141 → 3120 MiB |
| compiler | build | 49.557 → 47.266 s | 58.216 → 56.941 s | 4143 → 4086 MiB |
| harfrust | check | 7.313 → 6.203 s | 8.284 → 7.558 s | 1211 → 1182 MiB |
| harfrust | build | 13.154 → 12.125 s | 16.363 → 15.893 s | 1450 → 1416 MiB |

Whole process-tree CPU is user plus system time for the compiler, its waited children, and detached writers. It can exceed wall time because builds run work concurrently.

## Reproduction

The local investigation harness is [cold_bench.py](/workspace/silk/.scratch/benchmarks/cold_bench.py). It uses Python 3.11+, Git, tar, taskset, and Linux `prctl`/`wait4`; it is not proposed as a new repository tool. Preserve the compiler binaries and the two source checkouts at the revisions above.

From `/workspace/silk`, run:

```sh
python3 -I .scratch/benchmarks/cold_bench.py \
  --compiler A=/workspace/silk/.scratch/N0-one \
  --compiler B=/workspace/silk/.scratch/N1-one \
  --silk-source /workspace/silk-baseline \
  --nonstd-source /workspace/nonstd \
  --clang /workspace/silk/.scratch/llvm-22.1.8/bin/clang \
  --workload compiler --operation check --rounds 2 --cpus 0-3
```

Repeat with `--workload harfrust`, and with `--operation build` for each workload. Do not add `--release`, `--profile`, or `--timings` when reproducing this table. Each invocation creates a new private directory under `.scratch/benchmarks/cold-*`, writes metadata/results/logs there, and prints JSON lines. Source snapshots use `git archive HEAD`, so uncommitted source edits are excluded.

## Evidence files

- [Machine-readable summary and complete invocation metadata](/workspace/silk/.scratch/benchmarks/final-summary.json)
- [Summary generator](/workspace/silk/.scratch/benchmarks/summarize-final.py)
- [compiler check raw measurements](/workspace/silk/.scratch/benchmarks/final-compiler-check.jsonl); per-trial logs: `/workspace/silk/.scratch/benchmarks/cold-sdof6r9x`.
- [compiler build raw measurements](/workspace/silk/.scratch/benchmarks/final-compiler-build.jsonl); per-trial logs: `/workspace/silk/.scratch/benchmarks/cold-4yefdjrc`.
- [harfrust check raw measurements](/workspace/silk/.scratch/benchmarks/final-harfrust-check.jsonl); per-trial logs: `/workspace/silk/.scratch/benchmarks/cold-nydxxek0`.
- [harfrust build raw measurements](/workspace/silk/.scratch/benchmarks/final-harfrust-build.jsonl); per-trial logs: `/workspace/silk/.scratch/benchmarks/cold-d4p8278c`.

Executable SHA-256:

- A: `cddf7a53933f4c8e3a28372aac55ff8300808a0ee4f3a9c6ce2f1041368a839d`
- B: `01c4ad198c7dd35dcea027ca530b92d3503ec517e32ebd90f6649591c9f262a0`

## Separate release compiler code-quality experiment

This comparison changes how the baseline compiler executable is generated, not compiler source. All three executables use baseline source `a63f612150a0b91a118c8111b910b12c3e124b50`, debug information disabled, and final optimization level O2:

- `mono`: one LLVM unit, direct Clang O2; `.scratch/N0-one`.
- `thin4`: four LLVM units, standard ThinLTO O2; `.scratch/N0-four`.
- `full4`: four partitions, Clang prelink `-O0 -flto=full`, then lld `--lto-O2 --lto-partitions=4`; `.scratch/codegen-experiments/compiler-full4`. Backend options `-enable-tail-merge=false`, `-unroll-runtime=false`, `-x86-cmov-converter=false`, and `-mattr=+sse2` were forwarded to lld. This is a different optimization pipeline, so final O2 does not imply identical pass ordering.

Each workload ran mono/full4/thin4 twice in that order, with the same cold directory, pinned source, CPU affinity, and detached-writer settlement protocol as above. All 12 checks and writers succeeded. These are runtime-quality measurements of the resulting compiler executables, not their own build times.

| Workload | Compiler configuration | Foreground | Relative time vs mono | Settled | Foreground user CPU | Whole-tree CPU | Largest process RSS incl. writer |
|---|---|---:|---:|---:|---:|---:|---:|
| compiler | mono | 21.843 s | 1.000× | 22.420 s | 20.876 s | 23.078 s | 3144 MiB |
| compiler | full4 | 24.595 s | 1.126× | 25.271 s | 23.764 s | 26.075 s | 3139 MiB |
| compiler | thin4 | 22.553 s | 1.033× | 23.141 s | 21.691 s | 23.858 s | 3152 MiB |
| harfrust | mono | 7.783 s | 1.000× | 8.201 s | 7.412 s | 8.411 s | 1211 MiB |
| harfrust | full4 | 8.518 s | 1.094× | 9.002 s | 8.258 s | 9.253 s | 1208 MiB |
| harfrust | thin4 | 8.488 s | 1.091× | 8.916 s | 8.001 s | 9.159 s | 1212 MiB |

Higher relative time is worse. Full LTO does not recover monolithic runtime performance in these workloads. ThinLTO costs approximately 3–9% runtime while allowing faster compiler construction; that tradeoff should be explicit in any default-profile decision. This experiment does not establish a universal result across programs.

Reproduction (repeat with `--workload harfrust`):

```sh
python3 -I .scratch/benchmarks/cold_bench.py \
  --compiler mono=/workspace/silk/.scratch/N0-one \
  --compiler full4=/workspace/silk/.scratch/codegen-experiments/compiler-full4 \
  --compiler thin4=/workspace/silk/.scratch/N0-four \
  --workload compiler --operation check --rounds 2 --cpus 0-3
```

Raw files: [compiler](/workspace/silk/.scratch/benchmarks/quality-compiler-check.jsonl), [harfrust](/workspace/silk/.scratch/benchmarks/quality-harfrust-check.jsonl), [summary and exact invocation metadata](/workspace/silk/.scratch/benchmarks/quality-summary.json).

Additional executable SHA-256:

- full4: `369468b0ab3623a9be0322950695cb80cec8891e24af5378f5215f8b8a46b3fb`
- thin4: `4fe867ff70f0d59d9bb37ab29b9bd1638dea7dc00850980404374dec7b9a08b8`

## Separate allocator experiment

The same candidate `.scratch/N1-one` executable was checked with default libc allocation and with `LD_PRELOAD=/lib/x86_64-linux-gnu/libjemalloc.so.2`. A separate untimed loader-binding check confirms `malloc`, `calloc`, `realloc`, and `free` bind to jemalloc. No allocator tuning was configured. Each workload ran libc/jemalloc/libc/jemalloc, with cold caches, CPUs 0–3, and complete detached-writer settlement. All eight checks and writers succeeded.

| Workload | Allocator | Foreground | Settled | Foreground user CPU | Whole-tree CPU | Foreground RSS | Largest process RSS incl. writer |
|---|---|---:|---:|---:|---:|---:|---:|
| compiler | libc | 20.296 s | 21.660 s | 19.268 s | 22.452 s | 2827 MiB | 3118 MiB |
| compiler | jemalloc | 19.911 s | 21.469 s | 18.882 s | 22.018 s | 3013 MiB | 3285 MiB |
| harfrust | libc | 6.571 s | 7.419 s | 6.259 s | 7.604 s | 993 MiB | 1180 MiB |
| harfrust | jemalloc | 6.646 s | 7.545 s | 6.334 s | 7.733 s | 1040 MiB | 1220 MiB |

The observed compiler gain is 1.019× foreground and 1.009× settled; harfrust slows slightly. Jemalloc increases peak memory on both workloads. These results do not justify switching the default allocator for this optimization effort.

Reproduction (repeat with `--workload harfrust`):

```sh
python3 -I .scratch/benchmarks/cold_bench.py \
  --compiler libc=/workspace/silk/.scratch/benchmarks/allocator/libc \
  --compiler jemalloc=/workspace/silk/.scratch/benchmarks/allocator/jemalloc \
  --workload compiler --operation check --rounds 2 --cpus 0-3
```

The two local shell wrappers execute the identical N1-one binary, with `LD_PRELOAD` explicitly unset for libc and set to the library above for jemalloc. Wrapper SHA-256 values in the harness metadata identify the wrappers; N1-one's hash remains the candidate hash recorded above. Jemalloc library SHA-256: `51952ffe97354b56197c9b765582023d435cfbe1930b0c03b778bdb5faa1fff5`.

Evidence: [compiler raw measurements](/workspace/silk/.scratch/benchmarks/allocator-compiler-check.jsonl), [harfrust raw measurements](/workspace/silk/.scratch/benchmarks/allocator-harfrust-check.jsonl), [summary](/workspace/silk/.scratch/benchmarks/allocator-summary.json), [loader bindings](/workspace/silk/.scratch/benchmarks/allocator/loader.log).

## Diagnostic ceiling from removing persistent-cache bookkeeping

`check` has no `--no-cache` option. To compare the existing `Cached` and `Transient` store modes without changing compiler source or executable, this diagnostic uses a small local `LD_PRELOAD` interposer that returns `ENOENT` only for `realpath("/proc/self/exe")`. The development compiler reports `v0.0.0`; without an executable identity, its existing `CacheStamp.compiler` path returns none and selects `Transient`. All other `realpath` calls delegate to libc.

Both variants execute the identical production-candidate `.scratch/N1-one`. Each workload ran Cached/Transient/Cached/Transient on CPUs 0–3. All eight checks succeeded. Each Transient log includes the interposer marker, no Transient invocation spawned a detached writer, and each final Transient cache root contains zero files. Cached invocations each had one successful detached writer.

| Workload | Mode | Foreground | Settled | Foreground user CPU | Whole-tree CPU | Foreground RSS | Largest process RSS incl. writer |
|---|---|---:|---:|---:|---:|---:|---:|
| compiler | Cached | 20.130 s | 21.495 s | 19.022 s | 22.318 s | 2828 MiB | 3119 MiB |
| compiler | Transient | 17.740 s | 17.740 s | 17.010 s | 18.126 s | 2752 MiB | 2752 MiB |
| harfrust | Cached | 6.522 s | 7.359 s | 6.230 s | 7.562 s | 993 MiB | 1180 MiB |
| harfrust | Transient | 5.493 s | 5.493 s | 5.273 s | 5.625 s | 866 MiB | 866 MiB |

Removing all persistence gives 1.135×/1.187× foreground and 1.212×/1.340× settled speedups for compiler/harfrust. This is a diagnostic ceiling, not a delivered speedup or recommendation to disable incremental caching. It includes skipped executable hashing and import cache handling as well as semantic graph/source-input recording and serialization; it does not isolate Graph overhead. A replacement cache design would retain some work and need to preserve warm/incremental behavior.

Reproduction (repeat with `--workload harfrust`):

```sh
cc -O2 -fPIC -shared .scratch/benchmarks/transient/no_identity.c \
  -ldl -o .scratch/benchmarks/transient/no_identity.so
python3 -I .scratch/benchmarks/cold_bench.py \
  --compiler cached=/workspace/silk/.scratch/benchmarks/cache-default \
  --compiler transient=/workspace/silk/.scratch/benchmarks/cache-disabled \
  --workload compiler --operation check --rounds 2 --cpus 0-3
```

The wrappers unset `LD_PRELOAD` for Cached and preload only the diagnostic interposer for Transient. No tracked source changed. Evidence: [compiler raw measurements](/workspace/silk/.scratch/benchmarks/transient-compiler-check.jsonl), [harfrust raw measurements](/workspace/silk/.scratch/benchmarks/transient-harfrust-check.jsonl), [summary](/workspace/silk/.scratch/benchmarks/transient-summary.json), [interposer source](/workspace/silk/.scratch/benchmarks/transient/no_identity.c).
