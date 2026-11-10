# Shared immutable bodies without serialization

Feasibility review and source-only prototype based on exact V22. The first ownership/interner prototype passed full sourcecheck and four focused native proofs at a5529b4c5; no performance result is claimed. See thread-immutable-proof-state.md for exact scope and receipts.

## Recommendation

Use native threads with private Semantic/Query/Graph state and a shared, immutable semantic value universe. This is a substantial but feasible compiler architecture change. Do not share the current TypedBody pointer graph unchanged, and do not replace all Shared with atomic reference counts globally.

A completed-only body registry can return a retained immutable body and a structured immutable dependency DAG directly. This removes the capsule counting/planning pass, atom-array allocation, byte encoding, checksum/copy, decoding, reconstruction allocations, and receiver-local type re-interning. It retains the existing semantic checking, exact context and fine dependency evidence. The observed 2,250 avoided providers establish available reuse; they do not establish the gain of this design. Interner contention and atomic retain/drop work are new costs.

## Existing building blocks and actual blockers

- NativeThread.spawn/join, Arc, Mutex, Atomic and work_queue already exist. NativeThread requires detached Transferable jobs; Arc requires Transferable + Concurrent contents.
- Shared is explicitly thread-local; even Shared.with uses exclusive mutable access bookkeeping. Frozen clones/drops mutate a non-atomic count. Wrapping either in Arc does not fix their descendants.
- Interned is an immortal immutable pointer with pointer-only clone and no mutable get. It currently exposes no conditional Transferable/Concurrent implementation. A sound compiler wrapper may assert these only after proving T's complete reachable representation Concurrent; never an unconditional assertion for Type.
- Type.internHash mixes direct child allocation addresses, and Type.internEquals compares canonical child handles. Duplicate equal allocations only lose sharing, not correctness, but a common interner improves sharing. Resolver module/key/source/graph ordinals remain local and must never be imported as global IDs.
- TypeTable includes both structural interning and mutable InstanceKey canonicalization memo. These should be separated. Do not put the current entire TypeTable behind one mutex and share its returned mutable InstanceKeys.

## Minimal migration map

| Component | Current ownership | Required first-stage change |
| --- | --- | --- |
| ModuleId components / DeclarationId Chain | immutable Shared, pointer/hash identity | Arc-backed immutable identity records; preserve exact byte equality and stable content encoding |
| Lifetime intersections, anonymous occurrence, callable schemas/witness recipes | Frozen plus nested Shared lists | Arc/Published immutable payloads; no cross-thread plain refcounts |
| Type / Row / Application / StaticValue | Interned DAG, containing the above and Shared runtime/label bytes | make all reachable children thread-safe; retain structural handles; immutable labels become Arc bytes |
| TypedBody | Shared body, nested Shared bodies/bindings/kept-region lists/foreign bytes | BodyHandle over Arc<immutable TypedBody>; freeze after make/materializeEnvironment/withResolutions; nested payloads use the same immutable policy |
| SourceRevision / parsed source | Shared source bytes and identities | common immutable source epoch with Arc bytes and stable parsed-source identities; workers share parsing instead of each rebuilding a full cold source universe |
| Types service | single mutable table and canonical memo | worker-local service wrapper with concurrent shared structural intern pool + local canonical memo |
| Semantic / Query / Graph | mutable dense ordinals, active stacks, local Shared answers | stay private per worker; local Value.Body owns BodyHandle, not globally shared Query/Answer |
| completed body registry | mmap capsules and encoded guards | exact context -> immutable body+immutable guard DAG; acquire/release or short mutex publication, no waiting for unfinished providers |

Breadth measured from source: Shared<TypedBody> appears 1,116 times across 23 compiler files; Frozen<Intersection> appears 257 times across 16 files. This is not a two-file lock patch. A compiler Published<T> wrapper with make/clone/with/get can preserve most read-call shapes while changing the owning types deliberately. Ordinary Query answer Shared remains local. Public stdlib Shared semantics should remain unchanged.

## Real mutation paths

- Type.callableRuntimeKey (Type.silk 10250–10258) lazily populates Shared<Bytes>. callableValue deliberately avoids eager encoding because most temporary substituted values are never encoded. Preserve that property: use a per-worker cache keyed shared Type handle, or a synchronized immutable once-cache whose expensive computation happens outside the lock, followed by collision/consistency-checked install. Never hold its lock while encoding recursive types.
- InstanceKey.KeyEncodings exact/code/bare is mutated at InstanceKey.silk 323, 947 and 966. Keep canonical/keepCanonical keys and these caches worker-local in phase one. Application/type handles can be shared without sharing InstanceKey caches.
- Inspected ModuleId, DeclarationId, TypedBody, Lifetime, StaticValue and CallableSchema have no withMut payload updates. Their asMutSlice operations build fresh owned values/copies before publication. materializeEnvironment and withResolutions consume a body; keep them before publication or return a new immutable body.
- SourceRevision publishes a fresh immutable mapping; it does not mutate the held revision or reread host files. Different revisions must have different epoch identity in the registry.

## Concurrent interner boundary

Begin with one lock per structural category for a correctness prototype, then hash shards if measured contention requires them. Compute candidate hash and recursively construct all children before acquiring the selected shard. Hold the lock only for lookup/equality/installation and resize; never call Semantic providers or wait on another body while holding it. Existing equality uses PlainTypes scratch to avoid recursive global interning: preserve that invariant. Expensive callable encoding should be outside every table lock. OOM must release locks and leave no visible partial slot. A race may discard an unpublished duplicate candidate only while it is uniquely owned; published Interned handles are never discarded.

The wrapper's Types.canonical/keepCanonical remain local, with global application/type pointers as memo keys. This avoids needing to make the backend InstanceKey/cache family concurrent before proving shared bodies.

## Staged proof before a whole-compiler scheduler rewrite

1. Migrate immutable identity/type/body ownership and prove cross-thread access to scalar, nested anonymous, generic callable-schema/witness, static and foreign payloads. Compile-time Transferable/Concurrent constraints should verify the complete graph; add mutation-after-publication exclusions and thread-drop tests.
2. Concurrent structural interner harness: equal inputs in several threads yield shared handles; unequal binder/source identities remain distinct; collision, OOM and duplicate-publication paths preserve correctness. Include singleton CPU cost to expose retain/lock overhead.
3. Two independently initialized local Semantic stores use one immutable source epoch and type pool. One publishes an actual ordinary body, another imports the BodyHandle with its immutable guard DAG. Repeat existing Stage, dependency-edit, application/profile, corruption/refusal and diagnostic parity gates without any capsule codec.
4. Add bounded thread module/declaration workers using the existing roster proof. Reuse parsed immutable sources; do not transfer a prewarmed Resolver across threads. Keep current fork/backend path separate until InstanceKey mutable caches and all job payloads have an explicit thread-safe boundary.
5. Compare direct cold/edit/edit and immediate-edit overlap in both CPU lanes. Only then replace the existing fork scheduling path. Completed-only publication preserves the existing no-wait rule; any future in-flight dedup needs a real cross-worker query cycle/cancellation protocol, not condition-variable waiting while a provider is active.

## Lifetime and shutdown

Use Arc retention initially for auditability. Join workers before retiring source epochs/registries; imported bodies/guards keep their epoch alive through any cache export. Per-thread allocators stay local; cross-thread released allocations must use the normal allocation's thread-safe release capability. Request-local bulk arenas would need explicit retained epoch ownership and cannot be introduced by freeing today's immortal Interned storage while handles survive. LSP/revisable stores should remain outside this first immutable CLI prototype.

## Why a fork object arena is not the smaller solution

Fresh child allocations are private COW address-space state. Sharing just the outer TypedBody pointer, or reserving a shared mapping, leaves nested allocations, refcounts, allocator release recipes and lazy caches private. A correct arena would require every reachable allocation to use bounded shared storage with common addressing/offsets, process-safe lifetime/refcount and allocator semantics, plus typed consumer accessors. That recreates a second semantic representation much like the capsule codec. Threads naturally share addresses and existing Arc synchronization; they are the better route for removing serialization.


## First ownership prototype (unvalidated source)

Worktree: `/workspace/silk/.scratch/thread-immutable-prototype`, base `85ba82efe750a4682cc21192ad5dcb37d7bbd981`.

`Published<T>` owns an immutable `Arc<T>` and exposes only shared reads and retention. The migration covers the reachable identity, lifetime, schema, witness, static, source and body payloads, while ordinary Query answers and mutable InstanceKey caches remain local. `Interned<T>` gains conditional thread properties requiring both `Transferable` and `Concurrent`; there is no unconditional assertion for Type or TypedBody. The ordinary recursive thread-property checker remains responsible for proving the complete graph.

The callable runtime-byte cache uses `Arc<Mutex<Published<Bytes>>>`. Encoding and allocations occur before its publication lock; readers retain a snapshot then release the lock before calling any callback. Both snapshots remain alive through address/content comparison, preventing an empty snapshot's retired address from being mistaken for a new value. Equal duplicate results retain the first value; unequal duplicate results trap rather than silently replacing semantic evidence. The first prototype intentionally pays atomic retention and three cell allocations per new runtime cache; this is a measurable risk for single-core construction and will not be called a speedup without a control.

The concurrent structural pool has one mutex per Type, Application, Declaration, Lifetime and Row category. Type/Application effectful equality and static encoding run outside locks over retained candidates; publication rechecks candidate identities. Prepared table storage is installed without allocator callbacks, and unpublished race losers are uniquely owned until discarded after unlocking. Existing bounded collision fallback can lose sharing, so a common pool does not promise universal pointer identity for every structurally equal value. Each worker's canonical InstanceKey memo remains separate.

Two initial proofs are drafted: two real native threads build checked nested-callable bodies in separate Semantic stores against one retained source epoch and common type pool, then return immutable bodies for Stage/type-identity checks; a focused cache test retains the empty snapshot across installation, repeats an equal publication, and re-enters a read callback. These do not yet install imported bodies into receiver queries or introduce a scheduler. A completed-body registry still needs exact epoch/context and its full immutable dependency guard before query reuse is authorized.
