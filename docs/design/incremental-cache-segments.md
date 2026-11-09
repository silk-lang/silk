# Incremental cache publication prototype

Baseline: `85ba82efe750a4682cc21192ad5dcb37d7bbd981` (V22). This isolated prototype is not accepted as faster. The initial primitive boundary passed five focused native tests (three segment tests and two generation tests). No integrated compiler or performance run has validated this architecture.

## Measured problem

The diagnostic CPU0 first edit captured one Body (1,377 canonical bytes, 66 microseconds capture). Its detached writer used 0.719 CPU seconds. Carrying the reused image took 246 ms, refreshing carried checks/files 121 ms, and encoding the complete image 257 ms; file publication was 17 ms. Phase elapsed times are diagnostic, not additive CPU measurements. The source still calls completeCacheImage, unpacks the old graph, remaps/copies selected graph and answer bytes, refreshes all carried leaves, and encodes everything again.

Source evidence: `.scratch/benchmarks/v24-cpu0-cache-sequence-c8g97kw5/cache-attribution.json` in the main workspace. This architecture targets that work; it does not claim a threefold overall improvement.

## Ownership and coherent boundaries

1. **CacheSegments / CacheSegmentsCases (edit_overlap):** bounded immutable source observations, dependency references, answers and pack claims; exact packet codec; local graph topology; authenticated import metadata; whole-file identity for remote position snapshots. No filesystem or Semantic dependency. The first coherent gate is codec/admission roundtrip and refusal testing.
2. **CacheGeneration / tests (root):** explicit whole-generation catalog and exact selected-root bitmaps. No implicit previous-generation inheritance. Structural packet bounds plus full cross-segment admission, unique exact selected keys, transitive import coverage and selected pack union. Gate with synthetic segments, including stale and withdrawn roots.
3. **Semantic exporter and segmented reader (unassigned):** replace full carry/remap with immutable handles, fresh graph export and explicit selected root authority. Keep old source observation bytes unchanged; create a new observation when file/position proof changes. Demand-time source checks remain authoritative. A new graph depending on a carried check points to its admitted old node; a missing guard refuses reuse. Do not implement adoption by flattening segments into CacheImage.
4. **Driver transaction and ownership (unassigned):** serialize writers, write segments/packs before atomically publishing the complete generation descriptor, verify expected prior generation before commit, and pin all resources used by readers/writers. Initial prototype retains existing reader waits and native completion barriers. Missing or invalid publication means a cache miss; never a partial semantic answer.
5. **Maintenance (separate coherent gate, required before long-edit acceptance):** bounded catalog and physical-space policy, cooperative compaction, generation-aware reclamation and observable maintenance counters. This is part of the architecture, not optional cleanup after performance promotion.

The driver and Semantic boundaries must be assigned before edits; only boundaries 1 and 2 are currently owned. A temporary experimental flag may select the isolated implementation for controls; no historical format migration is required.

## Wire and authority contract

A segment is immutable and addressed by the digest of its exact encoded bytes. A descriptor binds that digest, its monotonically increasing serial, and exact leaf/node/root counts. References use local entry indexes or explicit imported descriptor slots. Local node references point backwards; imported serials must be strictly smaller. This admits an acyclic graph without recursive trust of self-reported counts. Every imported descriptor must match an actually admitted segment; missing parents refuse the generation.

Source leaves retain exact stable keys, expected input and token digests, original declaration positions, selector tags and the source-file observation those positions describe. Local and remote position snapshots must name whole-file leaves. A new file digest never overwrites an old segment's observation. Source changes may cause a new observation and new dependent guard; they do not globally rebind an old guard.

The generation catalog contains all transitively referenced segments, with unique descriptors. Its selected roots are bitmaps keyed by exact segment digest. The bitmaps are exact authority, not an optimization hint: unselected old answers cannot be returned. Root lookup uses the stored exact key bytes. During construction, a fresh root overrides a carried root with the same exact key; the published generation rejects duplicate selected keys rather than relying on lookup order. Header changes, deleted declarations, module roster changes and app switches must withdraw precisely the roots current Semantic would omit.

Packs belong to answers, not dependency-node reachability. Each root lists the pack digests its encoded answer requires. The exporter must derive these from the same BuildRecord data that writes the answer, not guess from this invocation's lowered units. The current generation retains selected roots' packs; older pinned generations retain their own selected roots' packs. A check following a build must not accidentally delete valid build packs. Missing packs preserve existing safe re-lowering behavior.

## Bounds and maintenance policy

There is **no generation-chain replay**. Each generation directly names its catalog and selected-root bitmaps. A segment is capped at 8 MiB, 256 imports, 131,072 entries of each kind and 524,288 cumulative decoded structural entries. The generation catalog is capped at 256 segments. These caps are refusal bounds, not a claim that writing a maximum-size generation is cheap.

Proposed initial maintenance scheduling, to implement and tune against repeated-edit evidence:

- Start a private compaction generation at 32 segments, or when known obsolete root/answer storage exceeds 25% of the retained data. Compact selected reachability; retaining every physical root would recreate unbounded obsolete-answer growth.
- Keep the currently published generation usable while compaction proceeds. Its snapshot is pinned. Each writer performs a bounded resumable slice: at most 1 MiB of copied payload and 65,536 inspected edges, including catch-up work. Charge new work separately from maintenance; no unbounded final merge or validation pass is permitted.
- Record edits arriving during compaction as a bounded catch-up queue. Compaction remaps the snapshot into new segments and then remaps fresh dependency records/selection changes using its old-to-new table. New immutable source observations remain distinct. A final publication is legal only once the catch-up cursor equals the expected generation and all new descriptors are validated incrementally.
- Trigger early enough to have substantial headroom (32 versus 256 segments). Fixed work budgets do **not** mathematically guarantee catch-up for every edit stream. Therefore a hard limit is mandatory: do not commit a new generation exceeding 256 segments or the configured cache-space ceiling. Preserve the last complete valid cache and report publication refusal/maintenance debt; never impose an unexplained whole-cache edit stall. This pressure behavior is a measured failure if ordinary workloads reach it, not a performance success hidden as cache fallback.
- Physical space includes the current generation, the private compacting generation, obsolete still-pinned generations and newly written unpublished objects. Reservation precedes object creation. A long-lived reader may prevent reclamation; respect its pin and refuse additional publication when the physical ceiling is reached. Never expire a live reader's pin merely to meet a cache budget.
- Reclamation runs in bounded batches after generation retirement. Delete a segment or pack only after no current descriptor, in-progress writer/compactor, or pinned reader can reach it. Interrupted compaction leaves reclaimable unpublished objects; interrupted publication never changes selected root authority.

The initial budget is a concrete starting policy, not a proven throughput result. Before performance acceptance, measure at least a full compaction cycle and repeated edits beyond the 32-segment trigger. Adjust budgets or storage organization if maintenance cannot keep up. Do not promote a version that merely defers full-copy work to the 33rd edit.

## Required semantic preservation cases

- Exact observation roundtrip, including source digest, token digest, position, selector and old-file snapshot; checksum/truncation/wrong-stamp refusal.
- Local self/forward node references, imported serial cycles, missing imports, forged descriptor counts, remote input leaves masquerading as file snapshots, and resource-limit refusals.
- Fresh-versus-carried exact-key conflict; selected duplicate keys reject; unselected old answer is never returned even while its segment remains reachable for a dependency.
- Body edit, header edit, deletion, source-file removal, changed module roster, application switch, and declaration movement below an edit. Compare exact structured diagnostic codes/spans/order and artifact/runtime behavior to V22.
- A fresh root depending on a carried guard preserves the complete old guard. Dropping or substituting that guard refuses the answer.
- Build→check→build preserves required packs; changing one pack, missing pack repair, and compaction preserve all selected answer pack claims.
- Reader pinned to generation G while writer commits G+1; stale competing writer cannot overwrite G+1; interrupted object write or generation publication; clean racing detached writer; compaction racing new edits.
- Compaction halfway through a source edit and immediately after a deletion produces the same selected keys, answers, guards and pack closure as uncompacted execution; old snapshots remain valid until their readers release them.
- Hard catalog/space limit and a long-lived reader cause explicit publication refusal without deleting reachable objects or forcing synchronous full compaction.

## Performance acceptance

Pin identical construction and flags for V22 and this component. Keep CPU0 and four-core results separate. For check and build, compiler and Harf, measure immediate cold→first edit→second edit→unchanged with foreground, fully settled, writer CPU and exact launch gaps. A separately labeled settled-launch diagnostic can isolate lock interference.

Also run a repeated-edit workload long enough to exercise maintenance. Report each edit and cumulative CPU, foreground/settled p50/p95/max, serialized/copied bytes, maintenance bytes/edges/time, debt, publication refusals, retained generation/segment counts and actual cache space. Cold performance must be reported: the initial fixed-word codec is a correctness boundary and may need compact encoding before it can compete with V22's compressed image. No improvement is claimed until those controls pass.
