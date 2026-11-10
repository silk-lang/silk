# V21 Bundle phase attribution: repeated liveness dominates

Diagnostic source `aa08d24f4`, binary `0e586815bbbc555a8f5ed27b7aac9ca002319bd070fc201ca796190d80c70911`, compared with exact uninstrumented V21. Both were four-unit O2/noPGO builds; no optimization patch included. CPUs0–3, shared correctness slot. Every writer settled before the next source action. These are phase/process-resource diagnostics, not authoritative speed comparisons or per-phase CPU samples.

Native boundary/application lifecycle passed20/20 with full ordered JSON/related-site parity, runtime42/43 and identical native artifact hashes. Harf6/6 calls passed exact ordered JSON parity with uninstrumented V21; cold frontier accepted and no warm refork. All processes/writers reaped.

| Binary / stage | Foreground wall | Settled wall | Primary CPU | Detached writer CPU |
|---|---:|---:|---:|---:|
| reference cold | 5.082s | 9.347s | 13.893s | 4.270s |
| reference first-edit | 2.420s | 6.703s | 2.442s | 4.287s |
| reference unchanged | 1.913s | 1.913s | 1.992s | 0.000s |
| diagnostic cold | 5.333s | 9.724s | 13.715s | 4.362s |
| diagnostic first-edit | 2.425s | 6.752s | 2.447s | 4.332s |
| diagnostic unchanged | 1.922s | 1.922s | 1.999s | 0.000s |

The settled direct edit still spends ~2.42s in its own foreground work, then ~4.3s writer CPU. Prior-writer lock waiting explains much of the earlier immediate-edit6s foreground, but does not explain this residual foreground or the writer itself. Unchanged still costs~1.92s with no writer.

## Measured phase wall times (instrumented first edit)

| Phase | Wall |
|---|---:|
| load manifest | 5ms |
| load blob reads | 21ms |
| load assemble | 446ms |
| adopt validation | 157ms |
| adopt liveness | 1008ms |
| adopt anchors | 0ms |
| adopt leaves | 366ms |
| adopt attach | 108ms |
| encode validate input | 152ms |
| normalize prelive | 1023ms |
| normalize cone | 0ms |
| normalize canonical | 39ms |
| normalize shapes | 0ms |
| encode final live | 1018ms |
| encode layout | 0ms |
| encode rebuild | 6ms |
| encode answers | 20ms |
| encode validate result | 151ms |
| encode validate repeated | 152ms |
| encode serialize excluding hash | 47ms |
| encode blob hash | 14ms |
| encode manifest | 2ms |
| writer encode total | 2636ms |
| writer verify existing | 19ms |
| writer write new | 1ms |
| writer publish manifest | 0ms |
| writer prune | 0ms |

Totals are inclusive where named: writer encode total includes its listed encode subphases; normalization prelive is one liveness walk. Do not sum inclusive totals with their children. Millisecond trace values are wall intervals; wait4 CPU above belongs to whole processes.

The dominant measured operations are adoption liveness1,008ms and writer normalization-prelive1,023ms plus post-normalization liveness1,018ms. They each walk~473k virtual nodes/~520k leaves. Actual guard cone is only1,427nodes/27,768edges; canonical materialized operands27,769 with maximum join width3. Canonicalization takes39ms: **no observed growing-set quadratic explosion**. Three encoder validations cost152+151+152ms. Manifest2ms, blob hash14ms, existing-file verification19ms and new writes1ms are far too small to explain the regression.

Writer encode totals2,636ms, versus4,332ms process CPU. The~1.7s remainder is not timed by the encode entry: `SemanticCache.prepare` calls `Semantic.completeCacheImage` before CacheBundles.write, and that producer runs another `CacheBundleLive.compute` in imageCarriedFiles plus source-refresh/export work. This is a source-backed likely location, not a measured phase attribution. A future diagnostic must time that preparation if needed.

Unchanged adoption: load assembly455ms, validation153ms, liveness1,016ms, anchors57ms and attachment33ms. Thus liveness alone is over half of the observed unchanged foreground, even without graph rebuilding or writing.

## Structural follow-up, not yet implemented

Live.computeView decodes/checks the complete leaf and its recorded-file kind for **every leaf edge**, including targets already live. It has per-node reachability but no separate per-leaf examined mask. High edge fan-in may therefore repeat expensive raw varint leaf decoding. A direct-edge examined mask must remain distinct from the live mask because file references mark a file live without examining it as an explicit edge. Skipping already-examined leaf edges can preserve exact output/failure behavior; measure leaf-edge count versus unique examined targets first. This is a narrower candidate than persistent reachability certificates or format redesign.

Repeated live computations are also structural duplication: producer carry refresh, normalizer prelive, post-normalization GC, and next-process adoption. Any reuse must account for changed root authority, guard edge substitutions and forward recorded-file overlays. Do not skip final closure checks or retain unbounded old guard chains.

## Directory bytes

The retained final Harf manifest has39,798root entries,3,321,135raw key bytes (avg83.45,max176),4,594,671directory bytes and4,635,262total manifest bytes. It references13blobs totaling73,631,138bytes. Manifest scalar fields are fixed LE64; raw keys are duplicated from compressed shard root keys. This is real overhead but measured manifest encoding2ms makes it a secondary target. Keep explicit proof-node identity even if future key references remove redundant key copies.

Evidence: results.json, per-stage `.trace` and `.log`, metadata.json and manifest-key-census.json in this directory. Candidate edited source/cache are retained at revision-one state after unchanged validation. Native gate evidence: `.scratch/benchmarks/boundary-cache-t5k0mwlq`. V21 remains rejected; neither these diagnostics nor tiny follow-ups establish a performance fix.
