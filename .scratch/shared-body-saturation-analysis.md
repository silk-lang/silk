# Shared typed-body initial engagement: capacity and guard transport

Frozen prototype `c894d78d5`, binary SHA `7cc612a86aef4d1cbdf99ecc4a6fe4a7e39c34cfd324b62bcbe296d174ae4450`.
Evidence: `benchmarks/shared-bodies-engagement-16y3crgb/build.log`; actual original compiler cold build accepted all frontier/artifact/native proofs and runtime smoke. Six semantic processes, final cumulative snapshots only.

- 2,250 ordinary Body providers avoided from 21,550 eligible misses/hits; 3,240 capsules encoded and published, 64,793,926 payload bytes.
- Arena used 134,217,688 of 134,217,728 bytes; full by the earliest recorded child snapshot at 3.498 seconds, before module completion around 6.56 seconds.
- Exactly equal encoded/published counts across all workers exclude abandoned *encoded body records* in this run. They do not exclude completed guard subgraphs left by refused/unsupported bodies.
- Subtracting the 524,296-byte directory/cursor and successful body records (32-byte header plus 0–7 alignment bytes each) leaves **68,773,106–68,795,786 bytes** for guard records. This is an allocation accounting bound, not a measurement of which guards are duplicated or reachable.
- Guard refusals 15,696 cannot be called semantic incompatibility: the old counter merges capacity exhaustion, propagation of cached failed guards, resource caps, and actual context refusal. Only 44 newly inspected context nodes, zero cycle nodes and two limit nodes were counted, and a single rejected dependency can affect many roots. Codec unsupported364 was schema359/witness5; no byte/depth/resource codec refusals.
- Initial avoided2,200; retained service adds only50. All3,240 publications happened before initial transport. Saturation prevented further successful publication throughout artifact service, including both private workers.

Source mechanism: each process memoizes exported guard offsets by local query index, but `importSharedGuard` reconstructed receiver-local synthetic units without recording the original authenticated offset in that memo. A later locally computed body depending on an imported body therefore walked and re-encoded the imported DAG. That can create additional wrapper nodes and duplicate stable leaf bytes even though the exact immutable guard already remains in this same arena.

Candidate `ca8ee5c33` seeds both completed synthetic guard units and completed imported ordinary Body units with the original offset. It preserves exact conjunction/source/application evidence and arena epoch ownership. Added per-kind append attempts/physical allocated bytes plus cached refusal causes make the next experiment interpretable. Capacity stays128MiB. Focused tests assert original guard identity, not speed or byte counts.

Next options depend on that accounting. A bounded256MiB arena comparison can isolate capacity censoring but increases memory and does not itself remove duplicate work. Global exact leaf/conjunction interning could remove independent worker duplicates, but requires a second ready-only directory and canonical operand identities; no such expansion is justified before the narrower reuse and per-kind data. Zero/single-edge conjunction elision is semantically valid for guards, but its payoff requires node-shape counts and must retain every nonempty source snapshot.

First same-binary OFF/ON causal screen (`shared-bodies-sequence-dya5wcmp`) is approximately flat CPU: check34.620→34.815s, build63.047→63.093s. Wall10.832→10.676s/check and20.006→19.698s/build are small differences, not a promotion result. All stage native artifacts matched exactly. Do not translate providers avoided into CPU saved.
