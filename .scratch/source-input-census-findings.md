# Source-input export census, V14

Evidence: `benchmarks/cache-work-v14-h12ixxhj/source-input-census-summary.json` and its seven immutable `.input-census` dumps, one source/profile stamp. Diagnostic run only: instrumentation allocates exact keys and writes ~181 MB, so its wall time is not a speed measurement.

| Population | Captures | Distinct exact key + value | Repeated captures |
| --- | ---: | ---: | ---: |
| All pending authored inputs | 717,861 | 276,363 | 441,498 (61.5%) |
| Declaration facets | 475,591 | 194,812 | 280,779 (59.0%) |
| Pending inputs reachable from exported roots | 632,813 | 276,363 | 356,450 (56.3%) |

There were no differing captured values for the same exact stable input key.

85,048 pending inputs (11.85%) were absent from the final retained transport-root closure. All occurred in private descendants: worker4 37,056; worker6 27,171; worker7 20,821. Root workers0–3 exported every pending observation. Since exported and total unions have exactly the same276,363 identities, all unexported computations duplicate an observation exported elsewhere.

`cacheImageWithWalkRecords` currently settles the entire pending list before selecting roots; `artifactCachePacket` filters the resulting root list afterward. The first structurally justified avoidance is to settle only inputs reachable from intended exported roots. It preserves every selected query/source guard. A fork-scoped demand-computed immutable authored facet memo could additionally share repeated exact observations; Request and Resolution selectors must remain contextual. No eager parent prehash is recommended.

These are count bounds, not time-weighted bounds. The existing low-rate V11 CPU sample attributes ~1.05 CPU seconds to the fingerprint family, so duplicate counts alone do not justify a broad shared-memory redesign or promise a large end-to-end gain. Memo implementation was deliberately deferred in favor of native build overlap.
