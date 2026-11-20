# Native tracing handoff

**Start from the complete integration branch, `codex/tracing-reference` at `c9d087d47add5b2461f6eff13603e3d696907aa7`.** It contains stages A through G, including the latest diagnostic work, the scoped metrics allocation, the corpus and CI fixtures, and the language reference. Work paused at the owner's request. The Silk stack still needs fixes and exact-head CI. The companion docs PR is green and open.

## Where the work lives

| Stage | Pull request | Branch or merged commit | State at handoff |
| --- | --- | --- | --- |
| Prerequisite | [Ambient runtime #3238](https://github.com/silk-lang/silk/pull/3238) | `404e8d1c6` | Merged |
| A | [Spike #3259](https://github.com/silk-lang/silk/pull/3259), [context region #3261](https://github.com/silk-lang/silk/pull/3261) | `43166993a`, `481001cc1` | Merged |
| B | [Recorder #3262](https://github.com/silk-lang/silk/pull/3262) | `codex/tracing-recorder` · `87c07f777` | Draft. Seed builds it. Incremental replay check failed |
| C | [Directive #3263](https://github.com/silk-lang/silk/pull/3263) | `codex/tracing-directive` · `03704bc9a` | Draft. Final diagnostic cases need verification |
| D | [Export and propagation #3264](https://github.com/silk-lang/silk/pull/3264) | `codex/tracing-export` · `f38c42a58` | Draft. Includes cross-language collector evidence |
| E | [Logs #3265](https://github.com/silk-lang/silk/pull/3265) | `codex/tracing-logs` · `820220742` | Draft |
| F | [Metrics #3266](https://github.com/silk-lang/silk/pull/3266) | `codex/tracing-metrics` · `81a29d869` | Draft |
| G | [Reference #3267](https://github.com/silk-lang/silk/pull/3267) | `codex/tracing-reference` · `c9d087d47` | Draft. Full cumulative source |
| Guide | [silk-lang/docs #133](https://github.com/silk-lang/docs/pull/133) | `codex/native-tracing-guide` · `7e7503374` | Ready and mergeable. Both CI jobs passed. Deployment pending |

A separate [work-in-progress checkpoint](https://github.com/silk-lang/silk/tree/3be8e1d19a5337a00191dad00d69e61e6d4e1d57) preserves the experimental explicit early-drop optimization. It fails the pinned compiler's ownership check. The integration branch uses the verified implicit-scope erasure implementation.

## Verified behavior

- **Off mode.** A program containing `@trace`, manual spans, attributes and metrics matched its stripped control byte for byte. Native objects were 403,240 bytes in debug and 68,784 in release. Direct Wasm modules were 146,380 and 37,101 bytes respectively. No tracing symbols or ambient-slot reads survived. The separate Meter test kept a real Tracer active, checked that it emitted a span and reserved zero metric slots, and matched all four controls. [Combined matrix](handoff-evidence/combined-matrix-final.log) · [Meter matrix](handoff-evidence/t20-matrix.log)
- **Recorder.** All seven native recorder cases, acceptance tests 3–9, passed. Migration also passed on threaded Wasm with direct and LLVM backends. Tests cover parent closure before fork completion, nested recorders, reentrant formatting, sampling and buffer exhaustion. A guard saves its parent so an unsampled span or a full pool can still restore it. The driver already reinstalls the execution's own table, so the region needs no extra per-slice copy.
- **Directive.** Success, mutable and nested borrowed arguments, methods, generics, recovered and escaping failures, cancellation, custom manifest bindings and invalid directive positions passed across successive compiler builds. Omitting the capability produced `SEM0270` at the directive. Build 8 compiled, but the final parking-formatter diagnostics did not receive a confirming run before the freeze.
- **Export and propagation.** The OTLP JSON and retry tests passed on native and Wasm. The collector accepted all three signal types. A Python OpenTelemetry SDK client called a native Silk HTTP service. In the repeat run, the collector placed the Python CLIENT span `128abcd31b1c8641` and Silk SERVER span `a304b737b25308dd` in trace `b3e07da3225e8743e075cde74615e3cb`, with the Python span as the server's parent. [Collector configuration](handoff-evidence/collector.yaml) · [Python client](handoff-evidence/client.py) · [Silk service](handoff-evidence/service.silk)
- **Logs, metrics and docs.** Tests passed for correlated and uncorrelated logs, forwarding, all four metric kinds, cumulative snapshots, numeric limits and overflow series. The active-Meter Wasm corpus passed after metric allocation became conditional. Both guide examples ran, including the collector example. Docs CI passed 74 site tests and 288 runnable examples. Tree-sitter's existing directive highlighting passed.
- Silk reserves `fail` and `export`. The shipped spellings in the branches are `Trace.setError` and `Recorder.exportBatches`. Manual spans omit source place. Decorated spans carry function, file and package information. The line number uses the specified unavailable fallback of zero.

## Resume in this order

1. **Fix Stage B incremental replay.** Editing the directive in `silk/collections/bytes.silk` reran 11 units against a budget of 6. Inspect the extra dependencies from inline-proof and ambient-reader invalidation. The workflow step “Replay the standard library against its budgets” contains the reproduction command and inputs. Preserve the existing budget. [Failing job](https://github.com/silk-lang/silk/actions/runs/44669109158/job/136068928177)
2. **Finish Stage C diagnostics.** Run `corpus/invalid/trace-display-parks` and `trace-manual-display-parks` with the final compiler. The directive expects only `SEM0272` at 17:1–17:24. The manual call expects `SEM0269` at 17:32–17:56, naming `Parking`. Previous builds also reported at the provider and entry point. If manual attribution still fails, inspect `ambientArgumentWitness`, `mappedWitnessApplication` and `Edge.Witness` in `compiler/src/semantic/Semantic.silk`. A concrete formatter can be represented by a named specialization. Preserve independent diagnostics.
3. **Check explicit guard drops.** The four-profile identity fixture proves implicit scope exit. A guard explicitly closed with `drop guard` can retain symbols in debug. The WIP branch adds a matching removal pass and fixture. Its first self-build failed `OWN0010` in `MirObservation.elideDrops` at line 384, with the conflicting loan at line 383. Resolve the borrow and run both forms through the four-profile comparison before carrying that patch to B. Preserve side effects and cleanup of observation arguments.
4. **Measure performance.** Stage A's one-million-yield medians were 193.82 and 194.38 ms. Stage B's busy-machine run measured 195.81 and 202.07 ms CPU, or 200.03 and 213.22 ms wall. The quiet paired scheduler rerun and the comparable full compiler self-build measurements against main are outstanding. Use matched compiler profiles, fresh output and unit-cache directories, and alternating runs on an idle machine. [Stage B samples](handoff-evidence/scheduler-results.txt)
5. **Validate and land the stack.** Recheck the updated D retry fixture and F metrics fixture on their isolated branch heads after the final allocation change. Regenerate the std reference on each changed stage with `doc-reference --stdlib-root stdlib --output reference/stdlib`. Run the identity scripts below. Use the unchanged pinned seed. Rebase each next branch onto main after its predecessor lands. Mark each ready and merge when its exact head passes `Focused Linux Silk`. Publish the guide through the docs repository's normal deployment and verify the live page.

The checked-in corpus, branch snapshots and evidence above are sufficient to resume in a fresh clone. In the original workspace, `/workspace/silk/.scratch/trace-directive/compiler` is the integrated build 8 and `/workspace/silk/.scratch/tracing/erase/n1-proof1` is the standalone Stage B compiler.

```sh
git fetch origin
git switch --detach c9d087d47add5b2461f6eff13603e3d696907aa7
# N1 is the compiler built from this checkout. SILK_TEST_CLANG is the repository's pinned clang.
bash .github/scripts/check-ambient-default.sh "$N1" "$SILK_TEST_CLANG"
bash .github/scripts/measure-trace-off.sh "$N1" "$SILK_TEST_CLANG" trace
bash .github/scripts/measure-trace-off.sh "$N1" "$SILK_TEST_CLANG" metric
```
