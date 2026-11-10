# Streaming authored Body identity prototype

Source: `/workspace/silk-streamed-hir-facets`, based on exact V22 85ba82efe750a4682cc21192ad5dcb37d7bbd981. This is an isolated source prototype, not a measured optimization.

## Bounded opportunity

V24 original compiler, CPU0, events/perf enabled: the cold detached writer spent approximately 0.788 sampled user-CPU seconds settling authored inputs. Body capture alone emitted 110,056,685 canonical bytes across 15,214 captures and took 0.573 elapsed seconds. Those numbers overlap and cannot be added. The entire 0.788 CPU seconds is an upper bound, not the expected saving: parsing, ordinal collection, traversal, numeric formatting, other facets, source text hashes and hash arithmetic remain. The first edit captured just one Body (1,377 bytes / 66 microseconds); this prototype cannot explain or fix whole-image first-edit publication or unchanged budget overhead.

## One traversal, bounded output state

The existing HIR `encodeNode` / `encodeFields` projection is unchanged. Its output state gains a streaming sink. The normal fingerprint APIs continue to emit precisely their existing framed bytes; `headerDigest`, `bodyDigest`, and `moduleDigest` remain SHA-256 contracts. The authored Body source selector can instead use the new streaming identity with `SILK_STREAMED_BODY_HASH=1`.

The new sink starts with `silk.hir.events.v1\0` and emits the existing semantic domain and VERSION via these events:

* LEAF: byte 1, tag byte, unsigned 64-bit little-endian byte length, exact payload bytes.
* OPEN: byte 2, tag byte.
* CLOSE: byte 3.

There is one existing ContentHash stream for the entire body, not a digest per HIR node. There is no size prepass and no expanded canonical output allocation. The existing ordinal prepass is retained, so body references still carry the same binder ordinal context. Small decimal-number scratch allocations remain; no claim that all fingerprint allocations are gone.

## Injectivity before hashing

A parser at an event boundary uniquely distinguishes OPEN, LEAF and CLOSE. A LEAF's fixed-width length uniquely determines its extent, so embedded bytes 1/2/3 cannot become structure. OPEN/CLOSE delimit exactly one composite and balanced nesting fixes its ordered children. Distinct tags distinguish Absent, Text, Number, Boolean, etc. In current traversal, only Record/Sequence/Causes use composite frames; all remaining tags are leaves. Therefore the event stream can reconstruct the old framed tree and its lengths, and conversely the old framed tree determines this event stream. This establishes the same pre-hash equivalence relation; ordinary ContentHash collision assumptions remain unchanged from other source inputs.

Optional absence versus empty text has different tags; absent versus an empty sequence also differs in event kind/tag. Empty sequences retain their explicit numeric element count. Field order, exact literal spelling after HIR lowering, recovery causes, and binder ordinals are unchanged. Outer declaration documentation/directives and unrelated declarations stay outside Body; nested content selected by the existing traversal stays included. This is not a token-slice approximation.

## Cache separation and layering

The streamed Body payload is explicitly domain-tagged and contains high/low digest words. `CacheStamp.compiler` includes the active Body policy (`silk.source.body.frames.v1` or `silk.source.body.events.v1`), so a same-binary experiment switch cannot reuse incompatible selectors. No cache migration path is introduced.

Fingerprint imports the existing `semantic.ContentHash` utility. That module imports only standard-library numeric/ownership/pointer primitives and has no HIR or Semantic dependency, so this introduces no module cycle. Its current directory placement is imperfect, but moving the utility and all callers would broaden this experiment without changing dependency correctness.

## Source fixtures / validation

* Every existing LoweringCases `sameBody` comparison now also asserts equivalence of the streaming identity, covering reordering, trivia, integer/radix/float spelling, arrays, changed bodies, retyped headers, recovery and binder ordinals.
* Additional Body projection fixture covers outer docs, nested anonymous callable body edits and unrelated sibling bodies.
* Public SHA helpers are explicitly compared to SHA-256 of their old byte API outputs.
* Independent event-sink fixture distinguishes absent, empty text, empty sequence, one absent element, marker-bearing payload, and split payloads.

Full sourcecheck passed and the two focused tests passed (6 ms runtime) on source `782145efe3250492a9dd0bc8b85e9d89b87e4552`. The projection test invokes eight existing semantic claim helpers. Frozen V22 HIR output supplies independent old header/body SHA literals; both passed. Logs, producer pins and golden fixture are in `.scratch/streamed-hir-validation/`.

Pinned four-unit O2/noPGO native bootstrap also passed and reaped all writers: `.scratch/frontier-streamed-hir-facets`, SHA-256 `4559dfffc25de47e00b935188fa34204576e4f84c9417ff965ef2daf5e9bb2aa`. Native policy-switch adoption/runtime parity and performance remain untested; construction duration under shared load is not a performance result.
