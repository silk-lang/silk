# Structural type hashing audit

Source audited: integration 3626df713. Read-only, no compiler jobs. Evidence: `benchmarks/v13-cpu-build-cw3f9tud/parsed.json` (flat sampled leaf symbols, not call stacks).

## What the sample actually supports

Sampled user CPU: TypeTable.intern 1.000s; Type.hashUnder .475s; TypeTable.internLifetime .424s; Type.rewriteType .293s; Type.encodeInto .263s; TypeTable.internDeclaration .222s; Type.nodeCopy .182s; TypeTable.internApplication .121s. The 2.81s Type module total is not all hashing. Inlining can charge hash/equality work to TypeTable.intern; this sample cannot subdivide it. Removing all visible hashUnder samples alone is less than half a CPU second, not a several-second wall gain.

## Safe, concrete redundant work

1. **Application intern hash structurally hashes children that must already have identical handles.** `Specialization.silk:1034` starts Application.internHash with Application.hash; Application.hash invokes Type.hash for every own type argument. internHash then mixes every own/scope argument handle and operation contract/provider handle. `Types.silk:177` requires sameArgumentHandles before full Application.equals and sameStaticInputs. Therefore the private interning hash can be based on the existing target/ordinal/static metadata plus argument kinds and exact handles, without recursively hashing argument type DAGs. Keep Application.hash unchanged: `Semantic.silk:84814` uses it for selectedApplications with structural equality across different handles. Keep operation target identities, own/scope static distinctions and full comparison unchanged. Pointer-only candidate hashing is a filter, never a persistent identity or equality replacement.

2. **Exact written-type dedup hashes repeats before discovering they repeat.** `runtimeProjections` (76715 onward) and `cleanupNeeds` (78330 onward) visit every local/expression type, then hashExact before exactTypeAt. Same immutable handles often recur across many locals and body instances. A pointer-to-existing-ordinal front table can bypass both hashing and equality for repeats, while misses still use the current semantic table. `internErasedType` (7293) already implements precisely this safe pattern. `internApplication` (7265) does not have the corresponding exact-handle front table. This is lower-risk and bounded per operation/resolver than changing every Type representation.

3. **TypeTable rehashes every retained node on resize.** `Types.silk:121` recomputes Type.internHash for all nodes. Storing the already computed full intern hash alongside each retained node removes that pass's traversal. Extra storage is one u64 per retained node. Amortized resize work is bounded; measure before prioritizing it. InternHash itself is already shallow direct-child identity hashing, so replacing it with another recursive canonical hash would regress the design.

## hashUnder is context-free, but has more than one memo key

`Type.silk:1691` reads only the immutable Interned<Type> node, `depth`, and `exact`. It receives no binder map, owner, provider, mutable Numbering, resolver or source revision. Binder invariance comes from deliberately excluding unsafe evidence from hashHead and stopping at callables, not from an external environment. `hashEnvironment` reads the environment stored in the immutable node; it is not a caller environment.

A mathematically valid recursive memo key is (node allocation, remaining depth, exact). Caching only (node,exact) inside recursion is wrong: non-container ancestors consume depth, changing the resulting hash. Public Type.hash/hashExact always enter at depth6. Nominal/reference/slice/pointer/array/vector/anonymous containers do not consume depth, so a shared deep container DAG is repeatedly traversed in full; a chain hashed at every suffix incurs quadratic traversal. Different allocations of equal nodes must still hash equally. Do not change public semantic hashes to addresses.

No memo exists today. Interned values never change or free after publication, and the table owns immutable handles. A resolver-owned cache avoids global mutable state, races, and cross-build retention; however pure Application.hash callers need either a separate safe service API or the private intern-hash elimination above. Eagerly storing all 14 depth/mode hashes per node would cost112bytes/node and compute unused modes; it is unjustified without reuse/cost measurements.

## Encodings are not a safe handle-only cache

`Type.encodeInto` (9530) takes owner, exact and mutable RuntimeEncoding.Coordinates. Coordinates include validity/code policy, bounded remainingBytes and exceeded. Nested application/static encodings and logical payload charging consume these budgets. An encoded-byte cache must preserve both output bytes and the original logical charge/failure behavior, including rollback; byte length alone is insufficient because recordPayload and nested field charges are additional. Numbering/rewrite operations also depend on binding/region state and must not share this memo.

A separate nonmemo alternative: most non-nominal encoding first calls nodeCopy even though its following matches borrow the copy. Immutable-node borrowed encoding could remove deep list/static/schema cloning without changing bytes or budget charging. It requires a complete branch audit and byte/budget boundary tests; the .182s nodeCopy sample also includes nonencoding callers, so it is only a candidate, not an estimated gain.

## Recommended bounded diagnostic and order

First obtain caller attribution for hashUnder using a bounded diagnostic call-stack profile on compiler and held-out Harf (not an authoritative timing run). Distinguish Application.internHash, selectedApplication structural hashing, exact application interning, runtime projection dedup, cleanup dedup, constraint hashing. The existing flat profile cannot do this.

A diagnostic-only counter build can then sample root calls (e.g.1/256) and count (handle,depth,exact) visits/repeats, maximum traversal size and per-root fanout in a bounded64k-entry table, reporting truncation. Count TypeTable attempts/hits, tag-matched probes, four-probe bailouts, retained/new node count, and resize-rehashed nodes separately; no clock read or log per node. This establishes whether repeated walks or equality/collision/allocations dominate. Keep counters process-local and merge summaries after children settle.

Implementation priority if parent authorizes: (1) remove the provably redundant private Application.internHash argument recursion; (2) pointer front tables at the measured repeated exact-type consumers; (3) bounded context-free memo only if measured repeated subtree work remains substantial. Preserve semantic equality checks and every persisted runtime/exact encoding. Test alpha-renamed callable inputs, region-distinct references, operation contract/provider distinctions, scope/static changes, equal types with separate allocations, and repeated handles. Validate cold and edited1/4CPU workloads, including memory, before any speed claim.

## Implemented narrow experiment

Source commits `83b32418b` + `73217dd17` in `.scratch/application-handle-hash` remove only recursive argument hashing from the private Application intern hash. Scope hash channels remain otherwise unchanged; semantic Application.hash has exactly the original computation after inlining an extracted common head helper (mechanically checked). No persistent encoding changes.

Full compiler sourcecheck passed with pinned N0-one on2026-11-09. Focused test `applicationInterningUsesExactHandlesAndChecksStaticCollisions` passed780microseconds,1selected/1executed/1passed,0failed. It covers distinct but structurally equal type/lifetime/row allocations in own and scope arguments, scope owner, operation contract/provider, own/scope ordinal differences, persistent encoding equivalence, and real static-array hash collisions both own and scoped. Logs: `.scratch/application-handle-hash-sourcecheck.log`, `.scratch/application-handle-hash-test.log`. No workload performance measurement yet.
