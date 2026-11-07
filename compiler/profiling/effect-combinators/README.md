# Effect combinator frames

This opt-in benchmark runs one million suspended calls through `map`, `provideMut`, and `result`.
The success payload is 256 bytes; every eighth call fails. All words contribute to the checksum.
The default native runtime keeps diagnostic observation active. The explicit suspension boundary
in `step`, together with `@inlineNever`, keeps this on the coroutine path.

From the repository root, build with the baseline and candidate compilers against the same sources
and stdlib:

```sh
BASELINE build compiler/profiling/effect-combinators/src/main.silk -o /tmp/effect-before --stdlib stdlib --optimization speed
CANDIDATE build compiler/profiling/effect-combinators/src/main.silk -o /tmp/effect-after --stdlib stdlib --optimization speed
/tmp/effect-before
/tmp/effect-after
```

Both executables must exit 0. On Linux, interleave before/after runs with:

```sh
valgrind --tool=callgrind --callgrind-out-file=/tmp/effect-before.callgrind /tmp/effect-before
valgrind --tool=callgrind --callgrind-out-file=/tmp/effect-after.callgrind /tmp/effect-after
valgrind --tool=cachegrind --cache-sim=yes --cachegrind-out-file=/tmp/effect-before.cachegrind /tmp/effect-before
valgrind --tool=cachegrind --cache-sim=yes --cachegrind-out-file=/tmp/effect-after.cachegrind /tmp/effect-after
```

Divide the instruction and cache-miss totals by one million. This is a compiler microbenchmark;
it does not establish the improvement to an HTTP workload.

For structural inspection, add `--emit llvm-ir` to each build and use a `.ll` output. Follow the
`$step` calls from the benchmark loop to `step`: the optimized caller should reach `step$enter`
without entering the intervening combinators. Counting all emitted `$enter` definitions is not
a frame-count measurement: definitions retained by the compilation worklist may be unused by the
executed path. The generated IR also shows whether payload moves survive as `llvm.memcpy` calls.

The first local comparison used the compiler at `bcef1ff39` as the baseline, the same stdlib,
speed optimization, and the default observed runtime on aarch64 macOS. Both executables completed
the checksum. The benchmark loop's call chain bypassed four combinator frames and reached
`step$enter` directly. Aggregate copy elimination is still incomplete: LLVM 22.1.8 at `-O3`
retained two 256-byte copies on the inlined success path. This change establishes frame removal;
it does not establish zero-copy Result construction or an HTTP instruction/cache improvement.
