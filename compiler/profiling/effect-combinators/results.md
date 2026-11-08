# Effect combinator measurements, 2026-11-07

The baseline compiler is built from `bcef1ff39`. Both compilers build the same benchmark and
stdlib at `37ba70d15`, which includes both subsequent HTTP batch-worker changes. The candidate
includes frame inlining, small value-forwarder inlining, and variant-payload destination forwarding.
Binary SHA-256 hashes and both rounds' raw totals are in [measurements.json](measurements.json).

Programs are built for `aarch64-unknown-linux-gnu`, with speed optimization (LLVM 22.1.8, `-O2`)
and default diagnostic observation. They run in a six-vCPU Ubuntu 26.04.1 Lima VM on an Apple M1
Max. Valgrind is 3.26.0. Hyper is 1.11.1 with hyper-util 0.1.20, built by Rust 1.93.1 from the
committed Cargo.lock. Cachegrind uses explicit 32 KiB, eight-way, 64-byte-line L1 caches and an
8 MiB, sixteen-way last-level cache. These are simulated misses, not the host's hardware counters.

Two sequential rounds reverse the before/after order. Every executable exits zero. Tables show
the mean whole-process totals divided by the operation count; server execution is excluded.

## Suspended microbenchmark

One million calls, 256-byte success payload, every eighth call failing:

| Metric per call | Baseline | Candidate |
| --- | ---: | ---: |
| Instructions | 653.736 | 348.861 |
| Simulated L1 data misses | 0.001715 | 0.001681 |
| Simulated L1 instruction misses | 0.001242 | 0.001214 |

Instruction counts fall by 46.6%. Both rounds give identical totals. The working set fits in the
simulated L1 caches, so their tiny miss counts mostly describe startup.

The executed loop bypasses four combinator frames and enters `step` directly. Retained MIR shows
the producer writing the final variant payload, with the continuation committing the success tag.
After LLVM `-O2`, that loop's success continuation has no `memcpy` or `memmove`. The producer's
own work and an arbitrary transforming callback still execute.

## Current HTTP client, concurrency 16

4096 HTTP/1 requests, one batch, 32-byte responses, keep-alive, all responses retained until their
bodies are validated. The server is the same local Hyper process for every client.

| Metric per request | Silk baseline | Silk candidate | Hyper comparator |
| --- | ---: | ---: | ---: |
| Instructions | 26,326 | 25,283 | 30,797 |
| Simulated L1 data misses | 686.35 | 605.82 | 267.58 |
| Simulated L1 instruction misses | 1,088.14 | 934.12 | 737.70 |
| Out-of-line libc copy bytes | 6,049.37 | 6,049.96 | 6,235.39 |

Against the same current library, the candidate uses 4.0% fewer instructions, with 11.7% fewer
simulated L1 data misses and 14.2% fewer simulated L1 instruction misses. Out-of-line copied bytes
are effectively unchanged. The separate preload shim counts libc `memcpy` and `memmove`; it
does not count moves LLVM expands into loads/stores. The HTTP result therefore establishes a CPU
and cache improvement for this workload, not copy elimination throughout the HTTP implementation.

This newly committed harness is a plain-HTTP comparison on ARM Linux. Its numbers do not update
the old handoff's absolute Silk/hyper numbers, and do not establish an HTTPS or throughput result.
See [http/README.md](http/README.md) for reproduction and instrumentation commands.

## Compiler self-check

Both macOS compiler executables checked the same updated compiler source twice, with the order
reversed in round two. Baseline wall times were 14.24 and 14.48 seconds; candidate times were
14.46 and 14.05 seconds. All checks passed. These overlapping ranges show no meaningful self-check
speed change; the benchmark does not claim one.

## Correctness evidence

- Both observed forwarding regressions pass locally (164 ms and 129 ms). The payload regression
  fails on the original PR implementation at its intended destination/callback assertion.
- The existing fresh-call-destination regression passes (38 ms).
- Sixteen existing native corpus cases pass with MIR verification, including success/failure
  ownership, parked recovery and cancellation, diagnostic cleanup, borrowed results, and nested
  owned-result cleanup. Each reports zero borrow gaps.

The optimization keeps explicit no-inline directives, recursive frame boundaries, source line
tables, and bodies that originate observed trap/failure sites. Payload forwarding also requires
that neither borrowing nor destruction nor any failure/cancellation path can observe the partially
initialized variant. Shapes without that proof retain their existing storage.
