> Research input for `compiler/docs/incremental-architecture-v2.md`: a source audit of Zig `master` at `9276a56e` (2026-10-10). It verifies an earlier deep-research report, "How Zig Makes Incremental Compilation Cheap Without Taxing Cold Builds", which is not committed here; "the report" below refers to it.

**Commit audited:** `9276a56e3cee12a067f93d719a5e7f2762dd4603`  
**Committer date:** `2026-10-10T20:00:54+02:00` (October 10, 2026, 18:00:54 UTC).  
**Repository:** `https://codeberg.org/ziglang/zig.git`, branch `master`.

# Verification of “How Zig Makes Incremental Compilation Cheap Without Taxing Cold Builds”

On October 11, 2026, `git rev-parse HEAD` and `git ls-remote origin refs/heads/master` both returned the commit above. The checkout was clean before this audit; no tracked compiler files were changed. This source is in the 0.18 development cycle: `build.zig:12` declares `.minor = 18`.

All unqualified `path:line` citations below refer to **that exact commit**. Historical citations explicitly name snapshot `738d2be9d6b6ef3ff3559130c05159ef53336224`, whose objects were fetched separately and read with `git show`, without changing the checkout. Its committer date is `2025-11-26T17:42:52-08:00`. “The report” means the attached 724-line Markdown report, read in full.

The verdicts concern mechanisms established by source, not the report's published timings or its predictions for Silk. Three parallel source audits covered recording, hashes/identities, and invalidation. The required graph-first discovery was attempted, but indexing failed because a conflicting codebase-memory generation was active; exhaustive `rg` searches and numbered source reads were used instead. The executable probe below imports the actual current `InternPool.zig` to measure layout. It is not a performance test or a run of a compiler built from this HEAD.

**Most consequential correction:** non-incremental Zig skips the usual semantic dependency recorder, but it can still allocate a small reverse graph for inferred declaration types. Also, unchanged type layouts/defaults do not receive post-reanalysis equality cutoff.

## 1. Dependency recording when incremental compilation is off

**Verdict: contradicted** as a universal claim that a one-shot build constructs no reverse-dependency graph.

**Current code.** There are three edge-recording functions for the `AnalUnit`/`Dependee` invalidation graph:

| Recorder | Incremental gate | Evidence |
|---|---|---|
| `Sema.declareDependency` | Inside the recorder, before deduplication or allocation. | `src/Sema.zig:34550`: `if (!pt.zcu.comp.config.incremental) return;` |
| `Zcu.PerThread.addDependency` | None inside it. One caller supplies a gate; the other does not. | `src/Zcu/PerThread.zig:4433`: `try zcu.intern_pool.addDependency(gpa, unit, dependee);` |
| `InternPool.addDependency` | None. Its only caller is the preceding wrapper. | `src/InternPool.zig:834`: `try ip.first_dependency.ensureUnusedCapacity(gpa, 1);` |

The Sema recorder maintains a temporary per-analysis deduplication map: `src/Sema.zig:125` calls it a “temporary duplicate”; `src/Sema.zig:34552` uses `sema.dependencies.getOrPut`, then returns if already present. It is deinitialized at `src/Sema.zig:1002`. The incremental check precedes that lookup, so this map stays empty through the recorder in non-incremental mode. The lower-level insertion does not itself deduplicate edges (`src/InternPool.zig:828`, `src/InternPool.zig:910`).

There are exactly three low-level call expressions in the compiler source:

| Call site | Gate on the path |
|---|---|
| `src/Sema.zig:34555`: `try pt.addDependency(sema.owner, dependee);` | Protected by the recorder's early return at `src/Sema.zig:34550`. |
| `src/Zcu/PerThread.zig:1891`: `try pt.addDependency(type_unit, .{ .nav_val = nav_id });` | **No incremental-mode gate.** Its condition at `src/Zcu/PerThread.zig:1885` is `zcu.clearOutdatedState` for the Nav's type unit. |
| `src/Zcu/PerThread.zig:4433`: `try zcu.intern_pool.addDependency(gpa, unit, dependee);` | Ungated wrapper call; inherits whichever of the two paths above reached it. |

The second call creates `nav_ty(N) → nav_val(N)`. Its comment is literal: “inferred type depends on the value (that's us!)”. It is reachable during first analysis, not only a later revision:

1. `ensureNavValUpToDate` unconditionally calls `ensureNavValAnalysisQueued` at `src/Zcu/PerThread.zig:1591`.
2. On first demand, `src/Zcu.zig:3739` and `src/Zcu.zig:3740` queue **both** `.nav_val` and `.nav_ty` in `outdated`, with zero pending dependencies. Both also enter the ready set at `src/Zcu.zig:3741`.
3. Value analysis removes its own stale state at `src/Zcu/PerThread.zig:1598`. With no explicit type annotation, `src/Zcu/PerThread.zig:1750` takes the `else null` path, and `src/Zcu/PerThread.zig:1773` obtains the type from the computed value.
4. If the type unit is still queued, `src/Zcu/PerThread.zig:1885` clears it and reaches the ungated insertion at `src/Zcu/PerThread.zig:1891`.

This proves a non-incremental allocation path. It does **not** mean every inferred declaration takes it: separately analyzing the type first can clear that state before value analysis reaches this block.

All 24 calls to `Sema.declareDependency` are listed below. They have no local incremental condition and rely on its internal gate. These are ungated **API calls**, not additional ungated **edge insertions**.

| Current call site | Operation | Quoted dependee expression |
|---|---|---|
| `src/Sema.zig:6022` | Namespace lookup | `.namespace_name = .{` |
| `src/Sema.zig:6784` | Generic function signature | `.{ .src_hash = fn_tracked_inst }` |
| `src/Sema.zig:7203` | Inline/comptime function definition | `.{ .src_hash = fn_nav.analysis.?.zir_index }` |
| `src/Sema.zig:12924` | `@import` | `.{ .source_file = file_index }` |
| `src/Sema.zig:12974` | `@embedFile` | `.{ .embed_file = ef_idx }` |
| `src/Sema.zig:16116` | `@typeInfo` namespace enumeration | `.{ .namespace = type_decl_inst }` |
| `src/Sema.zig:30859` | Resolve memoized compiler state | `.{ .memoized_state = stage }` |
| `src/Sema.zig:30890` | Resolve a Nav | `switch (kind)` selects `.nav_ty` or `.nav_val`. |
| `src/Sema.zig:33987` | Resolve inferred errors | `.{ .func_ies = func_index }` |
| `src/Sema.zig:35030` | Import std for memoized state | `.{ .source_file = std_file_index }` |
| `src/Sema/type_resolution.zig:114` | Require a container layout | `.{ .type_layout = ty.toIntern() }` |
| `src/Sema/type_resolution.zig:163` | Require struct defaults | `.{ .struct_defaults = ty.toIntern() }` |
| `src/Sema/type_resolution.zig:241` | Analyze struct layout | `.{ .src_hash = struct_obj.zir_index }` |
| `src/Sema/type_resolution.zig:635` | Defaults require layout | `.{ .type_layout = struct_ty.toIntern() }` |
| `src/Sema/type_resolution.zig:651` | Analyze struct defaults | `.{ .src_hash = struct_obj.zir_index }` |
| `src/Sema/type_resolution.zig:874` | Analyze union layout | `.{ .src_hash = union_obj.zir_index }` |
| `src/Sema/type_resolution.zig:1326` | Analyze generated union tag enum | `.{ .src_hash = union_obj.zir_index }` |
| `src/Sema/type_resolution.zig:1351` | Analyze source enum layout | `.{ .src_hash = enum_obj.zir_index.unwrap().? }` |
| `src/Zcu/PerThread.zig:1310` | Analyze comptime declaration | `.{ .src_hash = comptime_unit.zir_index }` |
| `src/Zcu/PerThread.zig:1717` | Analyze Nav value | `.{ .src_hash = old_nav.analysis.?.zir_index }` |
| `src/Zcu/PerThread.zig:2090` | Analyze Nav type | `.{ .src_hash = old_nav.analysis.?.zir_index }` |
| `src/Zcu/PerThread.zig:3334` | Analyze runtime function body | `.{ .src_hash = decl_analysis.zir_index }` |
| `src/Zcu/PerThread.zig:3345` | Nongeneric function owner | `.{ .nav_val = func.owner_nav }` |
| `src/Zcu/PerThread.zig:3355` | Generic function owner | `.{ .nav_val = go_nav }` |

No other insertion path into this invalidation graph was found. Filesystem/build dependency manifests and C dependency-file recording are separate mechanisms and do not insert `AnalUnit` edges.

**Allocation answer.** The graph's headers exist in every `InternPool`; `src/InternPool.zig:114` initializes the maps to `.empty`, and `src/InternPool.zig:128` initializes `first_dependency`, `dep_entries`, and `free_dep_entries` likewise. Empty initialization is not backing-storage allocation. The exceptional path can allocate **`nav_val_deps`, `first_dependency`, and `dep_entries`**: `src/InternPool.zig:879` selects the Nav-value map, `src/InternPool.zig:888` calls `getOrPut`, and `src/InternPool.zig:913` installs the unit's edge head. All other reverse maps and the four memoized-state heads stay empty in a fresh non-incremental compilation because their producers go through the Sema gate. The free list receives reusable non-head entries on deletion, not preallocated at initialization (`src/InternPool.zig:780`).

Other bookkeeping has different gates:

| Work/state | What a non-incremental build does | Evidence |
|---|---|---|
| Tracked instruction identities | Creates and interns them. `trackZir` has no mode guard; it hashes the `(file, instruction)` key and allocates as necessary. | `src/InternPool.zig:238`: `Hash.hash(0, std.mem.asBytes(&maybe_lost_key))`; `src/InternPool.zig:269`: `ensureUnusedCapacity(1)`. Root creation at `src/Zcu/PerThread.zig:1047` and declaration scanning at `src/Zcu/PerThread.zig:3200` call it unconditionally. |
| ZIR remapping/diffing | Skips the update pass. | `src/Zcu/PerThread.zig:273`: `if (comp.config.incremental)` encloses `updateZirRefs` at line 276. |
| `outdated` and `outdated_ready` | Allocates/populates them for initial semantic scheduling. | `src/Zcu.zig:3722`: first `.func` insertion; `src/Zcu.zig:3739`: first Nav insertion; `src/Zcu.zig:3747`: “first created” comptime unit. |
| `potentially_outdated` | Starts and remains empty in an ordinary fresh one-shot build, although its helpers have no internal mode guard. | `src/Zcu.zig:276`: `.empty`; only insertion at `src/Zcu.zig:3370`. Initial queueing inserts only outdated/ready units. See the reasoning below. |
| Unit/type reference tracking | Retains separate deduplication maps and persistent reference lists, regardless of incremental mode. | `src/Sema.zig:30833`: `sema.references.getOrPut`; `src/Sema.zig:30849`: `sema.type_references.getOrPut`; allocation in `src/Zcu.zig:3955` and `src/Zcu.zig:3981`. |
| Inline reference frames | Allocates when needed, independently of the incremental flag. | `src/Zcu.zig:3937`: `zcu.inline_reference_frames.addOne(zcu.gpa)`. |
| Unit reset/dependency removal | Runs in the normal full compiler even on first analysis; often removes nothing then. | `src/Zcu.zig:3831`: gate is `dev.env.supports(.incremental)`, a **compiler-build capability**, not `config.incremental`; `src/Zcu.zig:3887` removes old edges. |
| Incremental debugger records | Only with the debug option, not required for the graph. | `src/Zcu/PerThread.zig:4434`: `debugIncremental()`; `src/main.zig:3619`: `--debug-incremental requires -fincremental`. |
| Source fingerprints | Produced whenever AstGen runs; see section 2. | `lib/std/zig/AstGen.zig:4120`: `src_hasher.update(tree.getNodeSource(decl_node))`. |
| Comptime-call memoization | Can run in one-shot mode, but is disabled in incremental mode. | `src/Sema.zig:7211`: `if (zcu.comp.config.incremental) break :m false;`. |

The PO distinction matters: after the exceptional edge is added, value invalidation can iterate it, but the type unit was already cleared. `src/Zcu.zig:3246` handles a `.marked_po` depender absent from the PO map with `continue`, rather than seeding PO. PO creation comes from transitive traversal after direct-input invalidation or retryable-failure flushing (`src/Zcu.zig:3269`, `src/Zcu.zig:3449`). The relevant input maps are empty without incremental recording; retryable failures start empty and are flushed before initial analysis (`src/Zcu.zig:294`, `src/Zcu/PerThread.zig:279`). This is an initial-build result, not a claim about artificially reusing arbitrary failed state.

References are a separate cost with other uses: `src/Zcu.zig:812` retains a source location, and `src/Zcu.zig:5216` resolves them for diagnostic reference traces. Some reference relationships are implicit “to save memory” (`src/Zcu.zig:4421`); those must not be confused with explicit invalidation edges.

**Differences from the report.** Its example guard proves only that example. The blanket conclusion was already false at the archived snapshot: **snapshot** `738d2be…:src/Zcu/PerThread.zig:1080` directly calls `pt.addDependency(ty_unit, .{ .nav_val = nav_id })` without an incremental guard. The current exception therefore cannot simply be attributed to the 0.16 redesign. The report also omits the temporary Sema deduplication map and the opposite-direction comptime memoization switch.

**Relevance for Silk.** To promise zero one-shot edge retention, gate every path, including code synthesizing dependencies for another unit. Account separately for identities, scheduling, diagnostic/reachability references, and invalidation edges; Zig does not eliminate all four in one-shot mode.

**Conclusion: partly — non-incremental Zig skips ordinary Sema dependency recording, but still records inferred `nav_ty → nav_val` edges when value analysis resolves a still-queued type, including during a cold build.**

## 2. Source hashes during AstGen

**Verdict: confirmed with changes.** The hashing mechanism survives. “Once” means per stored region per lowering run, not that every source byte is processed only once.

**Current code.** `lib/std/zig.zig:60` defines `SrcHasher = std.crypto.hash.Blake3`; `lib/std/zig.zig:61` defines `SrcHash = [16]u8`. AstGen owns `src_hasher` (`lib/std/zig/AstGen.zig:72`) and finalizes into that 16-byte buffer, for example at `lib/std/zig/AstGen.zig:4123`. These are 128-bit stored BLAKE3 outputs, with the sentinel exceptions below.

The exhaustive accessor is `getAssociatedSrcHash` at `lib/std/zig/Zir.zig:4887`. It recognizes `.declaration`; `.func`, `.func_inferred`, and `.func_fancy` with bodies; and extended `.struct_decl`, `.union_decl`, and `.enum_decl`. Other instructions return `null` (`lib/std/zig/Zir.zig:4947`, `lib/std/zig/Zir.zig:4978`). In particular, the accessor says “Function type or extern fn - no associated hash” at `lib/std/zig/Zir.zig:4905`. An extern function's enclosing declaration still has its declaration hash.

| ZIR region | What AstGen feeds/stores | Evidence and short quote |
|---|---|---|
| Ordinary function declaration | Whole declaration, including its body, plus lowering context. | `lib/std/zig/AstGen.zig:4001` feeds `source_column`; `lib/std/zig/AstGen.zig:4120`: `src_hasher.update(tree.getNodeSource(decl_node))`. |
| Namespace `const`/`var` declaration | Whole declaration node source, source column, and context accumulated during lowering. | `lib/std/zig/AstGen.zig:4423`: `src_hasher.update(tree.getNodeSource(node))`; final/store at `lib/std/zig/AstGen.zig:4538`. |
| Namespace `comptime` declaration | Its declaration node source and context. | `lib/std/zig/AstGen.zig:4570`: `tree.getNodeSource(node)`; store at `lib/std/zig/AstGen.zig:4604`. |
| Test/decltest/unnamed-test declaration | Whole declaration node source and context. | `lib/std/zig/AstGen.zig:4633`: `tree.getNodeSource(node)`; store at `lib/std/zig/AstGen.zig:4812`. |
| Defined function prototype | Copy of the enclosing hash state, then prototype node source; finalized before lowering the body. | `lib/std/zig/AstGen.zig:4348`: `var proto_hasher = astgen.src_hasher;`; `lib/std/zig/AstGen.zig:4350`: `proto_hasher.update(tree.getNodeSource(proto_node))`. |
| Non-tuple struct, including file root | Fresh hasher; optional backing-integer expression; direct field node source; direct namespace declarations skipped. | `lib/std/zig/AstGen.zig:4942`: backing node; `lib/std/zig/AstGen.zig:4956`: `.decl => continue`; `lib/std/zig/AstGen.zig:4969`: field source; final at `lib/std/zig/AstGen.zig:5033`. |
| Union | Fresh hasher; optional tag/backing argument and direct field source; direct declarations skipped. | `lib/std/zig/AstGen.zig:5234`: argument source; `lib/std/zig/AstGen.zig:5248`: `.decl => continue`; `lib/std/zig/AstGen.zig:5261`: field source. |
| Enum | Fresh hasher; optional tag-type expression and ordinary field source; direct declarations skipped. | `lib/std/zig/AstGen.zig:5456`: tag type; `lib/std/zig/AstGen.zig:5471`: `.decl => continue`; `lib/std/zig/AstGen.zig:5517`: field source. |

The function payload stores the prototype hash as four `u32` words only when a body exists (`lib/std/zig/AstGen.zig:11610`, `lib/std/zig/AstGen.zig:11625`). Prototype text is hashed here and again as part of the whole declaration. Likewise, the whole declaration `const S = struct { ... };` includes its initializer's nested declarations even though the **struct instruction's field hash** excludes direct namespace declarations. A field's raw source slice can itself contain nested type/declaration text. The exclusion is by the lowering region, not a recursive removal of all nested declaration text (`lib/std/zig/AstGen.zig:4423`, `lib/std/zig/AstGen.zig:4956`, `lib/std/zig/AstGen.zig:4969`).

There are deliberate non-digest cases:

- Empty structs with no backing integer use `.fields_hash = @splat(0)` (`lib/std/zig/AstGen.zig:4866`, `lib/std/zig/AstGen.zig:4881`).
- Test functions use `.proto_hash = @splat(0)`: “Tests don't have a prototype that needs hashing” (`lib/std/zig/AstGen.zig:4803`).
- Failed declarations use `.src_hash = @splat(0)`: “use a fixed hash to represent an AstGen failure” (`lib/std/zig/AstGen.zig:13487`).
- Tuple and opaque instructions have no separate associated source hash in this accessor; tuple lowering emits `.tuple_decl` (`lib/std/zig/AstGen.zig:5149`), which reaches the `null` case at `lib/std/zig/Zir.zig:4978`.

These are **raw source/context fingerprints**, not whitespace-normalized semantic hashes. `getNodeSource` returns `tree.source[start..end]` (`lib/std/zig/Ast.zig:1309`), from the first through last token. Interior comments/whitespace therefore participate. AstGen also feeds capture indices (`lib/std/zig/AstGen.zig:8467`: `std.mem.asBytes(&cur_capture_index)`) and line/column state for `@src()` (`lib/std/zig/AstGen.zig:9213`), in addition to declaration source columns.

A comment/code discrepancy matters here. `lib/std/zig/Zir.zig:3512` says struct field hashes include attributes such as “`extern`, backing type”; the analogous union comment is at `lib/std/zig/Zir.zig:3706`. The implementation feeds the backing/tag expression and field slices, **not** the `extern`/`packed` keyword. Layout/kind is separately represented, and matching rejects structural changes: `src/Zcu.zig:3496` says `if (old.layout != new.layout) continue;`, with a union-kind check at `src/Zcu.zig:3515`. Similarly, the enum `_` marker skips the ordinary field-hash update (`lib/std/zig/AstGen.zig:5503`); nonexhaustiveness is checked structurally at `src/Zcu.zig:3525`. Those invalidations must not be attributed solely to field-hash inequality.

**Mode and Sema.** Hashing has no incremental gate. `AstGen.generate(gpa, tree)` has no mode argument (`lib/std/zig/AstGen.zig:143`); `src/Zcu/PerThread.zig:656` calls it on the required Zig lowering path. A successful ZIR-cache load can avoid lowering altogether (`src/Zcu/PerThread.zig:609`), so “unconditional” means when AstGen runs, not on every compiler invocation.

Sema does **not** recompute or compare these source hashes: it records `.src_hash` dependencies, e.g. the generic prototype at `src/Sema.zig:6784` and inline/comptime definition at `src/Sema.zig:7203`. The update phase retrieves old/new stored hashes at `src/Zcu/PerThread.zig:926` and tests `std.zig.srcHashEql(old_hash, new_hash)` at `src/Zcu/PerThread.zig:928`. That helper is a `u128` bitcast equality (`lib/std/zig.zig:103`). A complete search of `src/Sema.zig` and `src/Sema/` found no source-hasher/accessor/comparison calls. Sema does hash **semantic** data for interning, for example a `Wyhash` of reified struct properties (`src/Sema.zig:20305`); “Sema never hashes anything” would be wrong.

**Differences from the report.** Its core source-fingerprint story holds, with overlapping byte processing, zero sentinels, contextual inputs, and structural matching qualifications. More precisely, Sema records identities and the ZIR update pass compares stored hashes.

**Relevance for Silk.** Fixed lowering-time fingerprints can remove per-reader source hashing while still costing CPU on cold lowering. Define their context and structural-matching contract explicitly; raw-source equality and semantic-result equality are separate filters.

## 3. Current analysis units and dependee kinds

**Verdict: confirmed with changes.** The report correctly labels its old lists historical; they are not the current definitions.

**Current code.** `AnalUnit` remains `packed struct(u64)` with `kind: Kind` and `id: u32` (`src/InternPool.zig:422`). Its current enum at `src/InternPool.zig:426` is:

```zig
pub const Kind = enum(u32) {
    @"comptime",
    nav_val,
    nav_ty,
    type_layout,
    struct_defaults,
    func,
    memoized_state,
};
```

The second requested “enum” is actually a tagged union. Current `src/InternPool.zig:746`:

```zig
pub const Dependee = union(enum) {
    src_hash: TrackedInst.Index,
    nav_val: Nav.Index,
    nav_ty: Nav.Index,
    /// Index is the function, not its IES.
    func_ies: Index,
    type_layout: Index,
    struct_defaults: Index,
    source_file: FileIndex,
    embed_file: Zcu.EmbedFile.Index,
    namespace: TrackedInst.Index,
    namespace_name: NamespaceNameKey,
    memoized_state: MemoizedStateStage,
};
```

| Analysis-unit kind | Meaning from current comments, qualified by implementation |
|---|---|
| `comptime` | “analyzes the body” of a comptime declaration (`src/InternPool.zig:437`). Its useful result is side effects, not a dependee value (`src/Zcu/PerThread.zig:1350`). |
| `nav_val` | “resolves the value” of a Nav (`src/InternPool.zig:439`). For a global variable, this refers to its initializer, not changing runtime memory (`src/InternPool.zig:580`). |
| `nav_ty` | “resolves the type” of a Nav (`src/InternPool.zig:441`). The practical result also includes modifiers compared with the type, such as alignment and address space (`src/Zcu/PerThread.zig:2166`). |
| `type_layout` | “resolves the layout” of a struct, union, or enum (`src/InternPool.zig:443`). This includes size/alignment/field offsets and comptime-field information (`src/Sema/type_resolution.zig:72`, `src/Sema/type_resolution.zig:151`). |
| `struct_defaults` | “resolves the default field values” of a struct (`src/InternPool.zig:445`). Layout must already be resolved; comptime-field values do not require this additional step (`src/Sema/type_resolution.zig:148`). |
| `func` | “analyzes the body” of a runtime function (`src/InternPool.zig:447`). Its propagated semantic output is `func_ies`, the inferred error set (`src/Zcu.zig:3346`). |
| `memoized_state` | Resolves state “memoized in fields on `Zcu`” (`src/InternPool.zig:449`), currently selected `std.lang` declaration values compared by interned index (`src/Sema.zig:35106`). |

| Dependee kind | Meaning from current comments, qualified by implementation |
|---|---|
| `src_hash` | A tracked instruction's “source code hash”; “also invalidated if tracking fails” (`src/InternPool.zig:38`, `src/InternPool.zig:42`). Its regions are enumerated in section 2. |
| `nav_val` | “value of a Nav” (`src/InternPool.zig:45`), compared by interned result index. |
| `nav_ty` | “type of a Nav” (`src/InternPool.zig:48`), with the modifier qualifications in section 5. |
| `func_ies` | A function's inferred error set; “Key is the function body, not the IES” (`src/InternPool.zig:51`). |
| `type_layout` | “resolved layout” of a struct/union/enum (`src/InternPool.zig:54`). A stable nominal type index does not imply unchanged layout. |
| `struct_defaults` | “resolved default field values” of a struct (`src/InternPool.zig:57`). These are separately consumable from layout. |
| `source_file` | “a Zig or ZON source file” (`src/InternPool.zig:60`). ZON reloads invalidate imported data; Zig imports invalidate when the file's root type identity is lost (`src/InternPool.zig:61`, `src/InternPool.zig:63`). |
| `embed_file` | An embedded input introduced by `@embedFile` (`src/InternPool.zig:68`). Unlike a literal reading of “when the file changes”, identical loaded values or repeated identical errors are cut off (`src/Zcu/PerThread.zig:448`). |
| `namespace` | “full set of names” in a ZIR namespace (`src/InternPool.zig:72`). The actual diff includes public/private visibility changes (`src/Zcu/PerThread.zig:975`). |
| `namespace_name` | “(non-)existence” of one name (`src/InternPool.zig:76`), again including visibility in the implementation (`src/Zcu/PerThread.zig:978`). The dependency is registered before lookup, so absent names are tracked too (`src/Sema.zig:6021`). |
| `memoized_state` | One compiler-memoization stage (`src/InternPool.zig:79`, `src/InternPool.zig:758`). Current stages are `main`, `panic`, `va_list`, `assembly` (`src/InternPool.zig:486`). |

Two stale comments deserve literal qualification. The memoized-state map comment still mentions `panic_messages` (`src/InternPool.zig:79`), whereas analysis updates `std_lang_decl_values` (`src/Sema.zig:35106`). The `main` stage comment excludes only panics and VaList (`src/InternPool.zig:487`), but the implemented stage selector also assigns assembly declarations to their own stage (`src/Zcu.zig:637`).

**Differences from the report.** Direct comparison with **snapshot** `738d2be…:src/InternPool.zig:411` and `738d2be…:src/InternPool.zig:836` establishes:

- Analysis unit `type` was removed; `type_layout` and `struct_defaults` were added. This separates responsibilities rather than merely renaming a tag.
- Dependee `interned` was removed; `func_ies`, `type_layout`, and `struct_defaults` now express separate semantic properties.
- `zon_file` was replaced by broader `source_file`, covering Zig root-type identity as well as ZON data.
- The other listed kind names remain. The new vocabulary is directly visible in the current definitions quoted above.

**Relevance for Silk.** Give analysis work and consumed semantic properties distinct identities. A function/type handle can stay stable while inferred errors, layout, or default values change; a single generic “interned entity changed” edge obscures those boundaries.

## 4. Dependency graph layout and cost

**Verdict: confirmed with changes.** The two linked views and freelist remain. The raw entry is measured at 24 bytes here; “one map per kind” has an exception.

**Current code.** Ten top-level reverse maps in `InternPool` map dependee keys to `DepEntry.Index`: `src_hash_deps`, `nav_val_deps`, `nav_ty_deps`, `func_ies_deps`, `type_layout_deps`, `struct_defaults_deps`, `source_file_deps`, `embed_file_deps`, `namespace_deps`, `namespace_name_deps` (`src/InternPool.zig:44`, continuing through `src/InternPool.zig:78`). Their current type is `std.array_hash_map.Auto`, replacing the report's older type spelling.

The exception is `memoized_state`: four **scalar optional head indices**, not a hash map, at `src/InternPool.zig:81`: `memoized_state_main_deps: DepEntry.Index.Optional`, followed by panic/VaList/assembly heads. `first_dependency` maps an `AnalUnit` to an edge (`src/InternPool.zig:89`); `dep_entries` and `free_dep_entries` are global pool arrays (`src/InternPool.zig:95`, `src/InternPool.zig:98`).

The exact data fields of `DepEntry` are at `src/InternPool.zig:925`:

```zig
pub const DepEntry = extern struct {
    depender: AnalUnit.Optional,
    next: DepEntry.Index.Optional,
    prev: DepEntry.Index.Optional,
    next_dependee: DepEntry.Index.Optional,
    // Nested Index declarations omitted here.
};
```

`next`/`prev` link dependers of one dependee; `next_dependee` links dependencies emitted by one unit. The comments explicitly describe the former as “a doubly linked list” (`src/InternPool.zig:930`) and the latter as “a singly linked list” (`src/InternPool.zig:937`). These optionals are sentinel enums, **not Zig `?T` fields**: `AnalUnit.Optional` is `enum(u64)` (`src/InternPool.zig:474`); edge-index `Optional` is `enum(u32)` (`src/InternPool.zig:947`).

The accompanying [zig-incremental-sizes.zig](zig-incremental-sizes.zig) imports this checkout's real `InternPool.zig`; a one-line `build_options.zig` supplies the required minimal build option. From the repository root, the exact successful command was:

```sh
zig test --dep ip -Mroot=incremental-verification/sizes.zig --dep build_options -Mip=src/InternPool.zig -Mbuild_options=incremental-verification/build_options.zig --cache-dir /tmp/zig-audit-probes/cache
```

Compiler: a local `zig` build, version `0.17.0-dev.1503+1f1bee62e`; native target reported by `zig env`: `aarch64-macos.27.0.1...27.0.1-none`. This older executable successfully analyzes the current source's relevant type declarations using its bundled standard library. It does not establish that it can build the whole current compiler. Full output, reproduced below:

```text
1/1 sizes.test.current compiler dependency layout...DepEntry size=24 align=8
AnalUnit size=8 optional=8
EdgeIndex size=4 optional=4
TrackedInst.Index size=4
OK
All 1 tests passed.
```

Thus **24 bytes is confirmed for the measured ABI**, not an assumed universal ABI or total retained bytes per useful edge. It excludes reverse maps, `first_dependency`, array spare capacity, the freelist, temporary Sema deduplication, and dummy heads. Zig's own dependency-stat routine multiplies entry count by `@sizeOf(DepEntry)` (`src/InternPool.zig:10613`) but sums selected map payload estimates (`src/InternPool.zig:10640`); it does not include all those costs, so it is not a total heap/RSS measurement.

On reanalysis, `resetUnit` calls `removeDependenciesForDepender` (`src/Zcu.zig:3887`). The latter removes the unit's `first_dependency` mapping, walks `next_dependee`, and unlinks ordinary entries from their dependee lists (`src/InternPool.zig:762`, `src/InternPool.zig:775`). Those indices are appended to `free_dep_entries` (`src/InternPool.zig:780`). A head entry stays in place as a **dummy** with `.depender = .none`: “We cannot easily remove this mapping” (`src/InternPool.zig:768`). It remains referenced by the reverse map and does not enter the freelist. New insertion reuses such a dummy or pops a free slot before growing the array (`src/InternPool.zig:890`, `src/InternPool.zig:896`). Reanalysis records a fresh dependency set.

The freelist append can fail; that error is deliberately ignored with a comment promising future GC (`src/InternPool.zig:780`). Current pool GC is still unimplemented (`src/Zcu.zig:175`; `src/InternPool.zig:974` says “currently vaporware”). Do not interpret this comment as an existing reclamation guarantee.

These graph structures are **shared per ZCU**, not replicated per thread: `src/Zcu.zig:177` owns one `intern_pool`; `PerThread` stores `zcu: *Zcu` and a thread ID (`src/Zcu/PerThread.zig:39`), and writes that shared pool at `src/Zcu/PerThread.zig:4433`. `InternPool.locals` and `shards` (`src/InternPool.zig:23`) serve other interning storage. The graph fields are outside them. This layout does not establish that arbitrary concurrent graph mutation is safe: insertion itself has no lock, and semantic units are processed by the main analysis loop (`src/Zcu/PerThread.zig:320`).

**Differences from the report.** The layout and its approximate raw-edge estimate hold. The memoized-state exception already existed in the snapshot, and deletion does not put every removed edge into the freelist. Aggregate graph memory exceeds `24 × live semantic dependencies`.

**Relevance for Silk.** Separate a measured edge-slot cost from the full graph's retained memory. A shared array with per-unit deletion chains supports reanalysis, but dummy heads, capacity, deduplication and reclamation policy must be included in a cold-memory budget.

## 5. Invalidation flow and early cutoff

**Verdict: confirmed with changes.** The PO/outdated flow and interned Nav-value comparison survive. Equality cutoff is not implemented for every reanalyzed result.

**Current code.** `potentially_outdated` and `outdated` map units to `u32` counts of pending PO dependencies (`src/Zcu.zig:273`, `src/Zcu.zig:277`). `outdated_ready` has **no counts**: it is split into `funcs` and `other` membership maps with `void` values (`src/Zcu.zig:283`). Ready functions receive scheduling priority so codegen can start sooner (`src/Zcu.zig:3382`). These structures also schedule initial work, as section 1 establishes.

The two `markDependeeOutdated` modes remain explicit at `src/Zcu.zig:3214`: “When we are diffing ZIR” versus “during analysis”.

- **`.not_marked_po`** handles direct input changes. Existing outdated counts are not decremented (`src/Zcu.zig:3228`). A newly outdated depender retains its existing PO count or starts at zero (`src/Zcu.zig:3245`); if it was not already PO, the compiler recursively marks consumers of its semantic output PO (`src/Zcu.zig:3269`).
- **`.marked_po`** handles a semantic result found changed after dependers were marked PO. It decrements the pending count (`src/Zcu.zig:3230`), promotes a PO depender to outdated (`src/Zcu.zig:3246`), and queues it when ready. A newly recorded depender already using current information is skipped if it is no longer PO (`src/Zcu.zig:3247`: “already has sufficiently up-to-date information”).

When a result is unchanged, `markPoDependeeUpToDate` decrements counts. An already-outdated consumer remains outdated; a merely PO consumer whose last uncertainty clears is removed from PO and recursively clears its output **without being reanalyzed** (`src/Zcu.zig:3288`, `src/Zcu.zig:3317`). The recursive switch includes layout and defaults (`src/Zcu.zig:3325`), so those units can avoid reanalysis even though they have no post-reanalysis equality test.

The complete direct semantic cutoff inventory is below. All five direct calls to `markPoDependeeUpToDate` occur in `src/Zcu/PerThread.zig` at **1146, 1653, 1905, 2025, 2264**; the remaining up-to-date propagation is the recursive switch at `src/Zcu.zig:3323`.

| Result/path | Unchanged check and comparison class | Consequence |
|---|---|---|
| **Nav value** | **Interned index.** `src/Zcu/PerThread.zig:1942`: `old_resolved.value != nav_val.toIntern()`. No old resolved result means changed. | Changed at `src/Zcu/PerThread.zig:1649`; otherwise up-to-date at `src/Zcu/PerThread.zig:1653`. |
| **Nav type: explicit annotation** | **Interned type/linksection indices plus scalar metadata.** `src/Zcu/PerThread.zig:2167` checks `old.type != resolved_ty.toIntern()`, followed by alignment, linksection, address space, constness, threadlocal and extern status. | `src/Zcu/PerThread.zig:2176`: `if (!changed) return .{ .type_changed = false };`; up-to-date at `src/Zcu/PerThread.zig:2025`. It preserves the old value for the later value comparison. |
| **Nav type: inferred, type analysis starts first** | **Type index plus the same modifiers.** `src/Zcu/PerThread.zig:2124` compares old/new type after resolving the value, then compares the ancillary fields. | Same notification at `src/Zcu/PerThread.zig:2025`. |
| **Nav type: inferred, value analysis finishes the queued type** | **Type index only**, with previous failure/missing-result checks. `src/Zcu/PerThread.zig:1900`: `r.type != nav_ty.toIntern()`. | Changed at `src/Zcu/PerThread.zig:1903`; up-to-date at `src/Zcu/PerThread.zig:1905`. This narrower comparison is what the code says; no tested correctness defect is asserted here. |
| **Runtime function body / inferred error set** | **Resolved inferred-error-set index**, not body/AIR equality. `src/Zcu/PerThread.zig:2301` computes `!func.analysisUnordered(ip).inferred_error_set or` an old/new resolved-set inequality. Without an inferred set the expression literally reports changed. | Equal inferred sets clear only `func_ies` dependers (`src/Zcu/PerThread.zig:2264`). New AIR is still generated at `src/Zcu/PerThread.zig:2297` and sent to codegen when applicable (`src/Zcu/PerThread.zig:2309`). There is no general equal-function-body or equal-machine-code cutoff here. |
| **Memoized-state stage** | **Per-field interned indices.** `src/Sema.zig:35106`: `zcu.std_lang_decl_values.get(std_lang_decl) != val.toIntern()`. The loop aggregates whether any selected declaration changed. | Unchanged stage clears its dependers at `src/Zcu/PerThread.zig:1146`. |
| **Type layout** | **No equal-result check after reanalysis.** `src/Zcu/PerThread.zig:1395`: `TODO: we actually *could* detect whether everything was the same`. | `src/Zcu/PerThread.zig:1396` marks the layout changed **before** resolving it. All its waiting consumers are invalidated even if the resulting layout happens to be identical. |
| **Struct defaults** | **No equal-result check after reanalysis.** The corresponding TODO and early invalidation occur at `src/Zcu/PerThread.zig:1507` and `src/Zcu/PerThread.zig:1508`. | Default-value dependers are invalidated whenever this analysis is required, without comparing the new defaults. |
| **Comptime declaration** | No result dependee to compare. `src/Zcu.zig:3341`: “analysis of a comptime decl can't outdate any dependencies”. | Reanalysis regenerates its side effects; no generic equal-result notification. |

For Nav values/types, function bodies and memoized stages, previous **failure state** also affects cutoff. Success→failure and failure→success propagate; repeated failure does not create another wave. The decision compares a Boolean previous-failure condition, **not diagnostic contents**: `src/Zcu/PerThread.zig:1624` / `src/Zcu/PerThread.zig:1628`, type equivalents at `src/Zcu/PerThread.zig:1996` / `src/Zcu/PerThread.zig:2000`, function at `src/Zcu/PerThread.zig:2242` / `src/Zcu/PerThread.zig:2247`, memoized state at `src/Zcu/PerThread.zig:1129` / `src/Zcu/PerThread.zig:1131`.

The complete direct-input comparison inventory is separate from semantic-result cutoff:

| Input | Check before invalidation | Notification |
|---|---|---|
| Embedded file | **Interned loaded value or error enum.** `src/Zcu/PerThread.zig:448`: `if (ef.val != .none and ef.val == old_val) return;`; line 449 also skips the same failed-load error. | `src/Zcu/PerThread.zig:454` |
| ZON file | **Reload flag**, no semantic-value comparison here. `src/Zcu/PerThread.zig:544`: `file.zoir_invalidated = true` when replacing existing ZOIR. | `src/Zcu/PerThread.zig:828` |
| Lost tracked instruction | **No equality test.** `src/Zcu/PerThread.zig:865`: `tracked_inst.inst = .lost`. | `src/Zcu/PerThread.zig:866`, source-hash dependers. |
| Matched source region | **Stored 128-bit fingerprint equality.** `src/Zcu/PerThread.zig:928`: `std.zig.srcHashEql(old_hash, new_hash)` skips invalidation. A missing corresponding new hash also fails this cutoff. | `src/Zcu/PerThread.zig:936` |
| Added namespace name / visibility change | **Set membership keyed by interned name plus `is_pub`.** `src/Zcu/PerThread.zig:975` consumes an old name and line 976 skips equal visibility. | `src/Zcu/PerThread.zig:980` |
| Removed namespace name | Old entries left after consuming new names represent removals. | `src/Zcu/PerThread.zig:988` |
| Whole namespace | **Aggregate membership/visibility comparison.** `src/Zcu/PerThread.zig:994`: `if (any_change)`. Pure declaration reordering does not change this set. | `src/Zcu/PerThread.zig:995` |
| Zig file root | **Identity tracking success**, not a file-content hash. A lost root type is cleared and invalidates imports; otherwise its namespace is rescanned (`src/Zcu/PerThread.zig:2356`). | `src/Zcu/PerThread.zig:2361` |

Together with the seven semantic changed-result sites above, these are all **15** direct `markDependeeOutdated` calls in the compiler. A preceding file-stat filter compares size, mtime and inode and can return before parsing (`src/Zcu/PerThread.zig:512`: `unchanged_metadata`; return at `src/Zcu/PerThread.zig:519`). This is a metadata shortcut, not proof of semantic equality. Invalid/error ZIR sentinel and structural-remapping behavior are described in sections 2 and 6.

Scheduling is conservative, not an exact minimal-work guarantee. If a PO unit is demanded before its dependencies settle, it is pessimistically reanalyzed (`src/Zcu/PerThread.zig:1593`). When only PO cycles remain, the scheduler clears them (`src/Zcu.zig:3414`); otherwise it can pick an outdated unit even though no zero-count unit is ready (`src/Zcu.zig:3423`). The comment says “usually acyclic” (`src/Zcu.zig:3404`), not cycle-free under all inputs.

**Differences from the report.** `old.val` is now `old_resolved.value`; the essential index comparison remains. Its broad equal-result narrative needs the layout/defaults exceptions, type-modifier comparisons, failure handling, and the distinction between a function's body and inferred errors. `outdated_ready` stores membership, not counts.

**Relevance for Silk.** Interned equality is sufficient only when the index represents the entire consumed result. Preserve old values until every related cutoff decision is made, and explicitly choose which mutable semantic properties need comparisons rather than assuming all nominal handles provide one.

## 6. Stable identities across edits

**Verdict: confirmed with changes.** The handle/remapping mechanism remains, with substantial limits on what edits preserve identity.

**Current code.** `TrackedInst.Index` is `enum(u32)` (`src/InternPool.zig:168`), separate from a raw ZIR index. The stored record contains a file and current instruction (`src/InternPool.zig:137`); its `MaybeLost` form uses `lost = std.math.maxInt(u32)` (`src/InternPool.zig:150`). Resolution returns `null` for a lost instruction (`src/InternPool.zig:176`). The handle encodes a local-list position and thread ID (`src/InternPool.zig:212`, `src/InternPool.zig:218`), while `trackZir` interns the current `(file, instruction)` key (`src/InternPool.zig:234`).

The incremental update calls `Zcu.mapOldZirToNew` separately for changed files (`src/Zcu/PerThread.zig:842`). It walks all thread-local tracked lists, filters to changed files, then writes the new raw index into the existing record: `tracked_inst.inst = .wrap(new_inst)` (`src/Zcu/PerThread.zig:870`). The public handle stays the same. If no mapping exists, it assigns `.lost`, invalidates the handle's source-hash dependers and queues linker lost-tracking work (`src/Zcu/PerThread.zig:865`, `src/Zcu/PerThread.zig:866`). Already-lost records are skipped: “we can't continue tracking lost insts” (`src/Zcu/PerThread.zig:856`). Later edits do not revive those handles.

Finally `rehashTrackedInsts` rebuilds the lookup metadata (`src/Zcu/PerThread.zig:1000`) using the existing local index/thread-ID handles (`src/InternPool.zig:410`). This is a global pass over tracked storage, distinct from allocating new handles for all edited instructions.

The actual matching contract is:

| Level | Matching rule | Evidence |
|---|---|---|
| File root | Seed the old/new `.main_struct_inst` pair. There is no cross-file move search. | `src/Zcu.zig:3476`; caller constructs a per-file map at `src/Zcu/PerThread.zig:836`. |
| Container pair | Require the same extended opcode and compatible immutable structure **before** accepting the pair or visiting its namespace. | `src/Zcu.zig:3489`: opcode inequality rejects; `src/Zcu.zig:3494` starts struct checks. |
| Ordinary named declarations | Match names within the accepted parent namespace. | `src/Zcu.zig:3646`: `named_decls.get(name) orelse continue`. |
| Named tests / decltests | Match by name in their own separate categories. | `src/Zcu.zig:3636`, `src/Zcu.zig:3640`. |
| Comptime declarations / unnamed tests | Match by ordinal within each category. | `src/Zcu.zig:3626`, `src/Zcu.zig:3631`: counters index the old lists. |
| Nested types / other tracked instructions in a matched declaration | Discover trackables, partition categories and zip by source order up to the shorter count; ordinary instructions must retain tag/opcode. | `src/Zcu.zig:3657`: “we correlate them based on source order”; checks at `src/Zcu.zig:3681`. |
| The declaration's function instruction | A special single optional function slot is paired directly when both versions have one. | `src/Zcu.zig:3693`: `if (old_contents.func_decl)` followed by the new slot check. |
| Trackables inside container fields | Discover and pair positionally too; this is not field-name matching. | `src/Zcu.zig:3542`, `src/Zcu.zig:3562`; field type/align/default traversal at `lib/std/zig/Zir.zig:4099`. |

Structural rejection is stronger than matching a container's spelling. Structs check capture count, field count, layout, whether fields have alignment/default/comptime information, and the presence of an explicit backing integer (`src/Zcu.zig:3494`). Unions check capture/field counts, kind and field-alignment presence (`src/Zcu.zig:3513`); enums check capture/field counts, nonexhaustiveness and explicit-tag-type presence (`src/Zcu.zig:3523`); opaques check capture count (`src/Zcu.zig:3533`). Rejection skips the container and its nested namespace traversal. `InternPool` documents the consequence: “will be interned at a fresh index” (`src/InternPool.zig:8035`); the declared struct key includes the tracked index and captures (`src/InternPool.zig:8050`).

Consequences for the requested edits:

- **Reorder a named declaration in the same accepted namespace:** declaration matching survives because it is keyed by name (`src/Zcu.zig:3646`), and the handle receives its new instruction index. This does not guarantee zero reanalysis: source/context hashes and positional matches inside it may change.
- **Rename it to a previously absent name:** there is no old-name match, hence no mapping for the old declaration or its nested tracked contents. The comment explicitly says unmatched declarations prevent matching inside them (`src/Zcu.zig:3624`). Old handles become lost; demand for the new declaration can create new handles. If a new declaration reuses another old name, the literal name matcher follows that name; it is not semantic rename detection.
- **Move it to another namespace or file:** there is no global relocation matcher. Old maps are built per matched namespace (`src/Zcu.zig:3587`) and per file (`src/Zcu/PerThread.zig:836`). Continuity cannot be assumed; identity is lost/new unless the destination's local matching happens to find an old counterpart.
- **Insert/reorder anonymous entities:** ordinal correspondence can shift (`src/Zcu.zig:3626`, `src/Zcu.zig:3657`). Stable handles are conditional on this best-effort mapping, not arbitrary move-stable declaration IDs.
- **Reassign a file to another module:** the update deliberately uses an empty mapping; its comment says “the whole file is outdated!” (`src/Zcu/PerThread.zig:819`).

Debug line movement is handled separately: a changed function start line queues `.debug_update_line_number` (`src/Zcu/PerThread.zig:920`). It is possible to update locations without making a semantic source-hash dependency stale, although source columns and `@src()` context can themselves affect hashes as section 2 explains.

**Differences from the report.** Its basic stable-handle description is accurate. It omits structural rejection, the mixture of name and positional matching, separate test categories, lost-handle non-revival, and module reassignment. A rename or arbitrary move is not guaranteed to preserve identity.

**Relevance for Silk.** Separate handles from source positions, but specify the exact edits that preserve a handle. Name-based namespace matching makes ordinary reorder cheap; positional anonymous matching and structural type replacement are precision tradeoffs, not properties required by interning itself.

## 7. Other corrections and current mechanisms omitted by the report

**Verdict: confirmed with changes.** Beyond the explicit contradiction in section 1, the prose needs the qualifications and additions below. The report often labels historical findings and design recommendations appropriately; those are not recast here as false claims about current implementation.

**Current code and differences from the report.**

| Report passage or topic | Current finding and required qualification |
|---|---|
| The paragraph referring to “older serialization machinery” and distinguishing process-lifetime reuse from full cross-process persistence. | **There is an active partial state writer.** The direct incremental compilation path calls `saveState` after compilation (`src/main.zig:3874`), guarded by `if (incremental)` at `src/main.zig:4386`. It writes dependency maps, `first_dependency`, edges and interned storage (`src/Compilation.zig:3648`: `addBuf(&bufs, @ptrCast(ip.dep_entries.items))`) to `.zcs`, with actual `writeVecAll` and atomic replacement (`src/Compilation.zig:3803`, `src/Compilation.zig:3817`). It requires `comp.bin_file` (`src/Compilation.zig:3576`). This is not proof of a complete restorable cache: errors/namespaces/decls remain TODOs (`src/Compilation.zig:3677`), no complete semantic-state reader was found, and Wasm `open` still says “TODO: restore saved linker state” and calls `createEmpty` (`src/link/Wasm.zig:3331`). Do not infer a write after every watch update; server paths return earlier (`src/main.zig:3850`). |
| The description of disposable AIR/MIR and retained semantic state. | **Backend-specific.** Owned AIR is freed after codegen (`src/Zcu.zig:5518`: `defer air.deinit`), and the link task frees its transient MIR (`src/link.zig:1833`). But Wasm owns “All MIR instructions for all Zcu functions” (`src/link/Wasm.zig:278`) and copies MIR into linker arrays (`src/link/Wasm.zig:3595`, `src/link/Wasm.zig:3601`). Its flush reconstructs and lowers that retained representation (`src/link/Wasm/Flush.zig:1230`, `src/link/Wasm/Flush.zig:1244`). Freeing a transient wrapper is not proof that no MIR data survives. |
| The historical attribution of a full reference traversal to linker flushing. | **Placement varies; the global cost remains.** `resolveReferences` caches a traversal from analysis roots (`src/Zcu.zig:4284`, `src/Zcu.zig:4308`). Export processing calls it (`src/Zcu/PerThread.zig:3642`) before the compilation flush (`src/Compilation.zig:2990`, `src/Compilation.zig:3024`). Some backend flushes also request the cached result, e.g. `src/link/Wasm/Flush.zig:252`. The report's historical timing cannot establish which current stage pays for it. |
| The interning and equal-result-cutoff model. | **Only for the appropriate result.** Nav values do use an index comparison (`src/Zcu/PerThread.zig:1942`); type results include modifiers, and type-layout/default reanalysis has no equality cutoff (`src/Zcu/PerThread.zig:2167`, `src/Zcu/PerThread.zig:1396`, `src/Zcu/PerThread.zig:1508`). Function-body cutoff is specifically inferred-error-set equality (`src/Zcu/PerThread.zig:2301`). |
| Fingerprints are “canonical” and computed once; containers exclude nested declarations. | **Region/context qualification required.** Raw slices are hashed (`lib/std/zig/Ast.zig:1309`), prototype/whole regions overlap (`lib/std/zig/AstGen.zig:4350`, `lib/std/zig/AstGen.zig:4120`), and the outer declaration includes its entire container initializer (`lib/std/zig/AstGen.zig:4423`). Only direct declarations are skipped in the container field digest (`lib/std/zig/AstGen.zig:4956`). |
| Every dependee category has a map; all removed entries become free slots. | **Two concrete exceptions.** Memoized stages have scalar heads (`src/InternPool.zig:81`), and removed head edges remain dummy entries (`src/InternPool.zig:771`). Both qualifications matter to memory accounting. |

Other important mechanisms, some already surfaced above, should be carried into any Silk note:

1. **Incremental mode changes more than recording.** Comptime-call memoization is disabled because callers do not receive the cached call's dependencies; the comment says each memoized call would need an `AnalUnit` (`src/Sema.zig:7208`), and the actual disabling branch is at `src/Sema.zig:7211`. Depending on target/options, incremental mode can also affect linker selection (`src/Compilation/Config.zig:467`: `break :b options.incremental`). An A/B cold-build benchmark must account for these differences.
2. **Temporary deduplication is real work.** Sema keeps transient copies of dependencies and references to avoid repeated insertion (`src/Sema.zig:119`, `src/Sema.zig:125`). This is not a persistent per-memo validation ledger, but the report does not mention this temporary map cost. References and initial scheduling remain even when ordinary invalidation edges are disabled.
3. **Precise negative lookup includes visibility.** Namespace dependencies track absent names and `pub` changes, not just existing successful lookups (`src/Sema.zig:6021`, `src/Zcu/PerThread.zig:975`). Namespace changes are compared as name/visibility sets, not by a persisted namespace-name-set digest.
4. **The prototype/body source distinction has real consumers.** Generic signature analysis records the function instruction's prototype hash (`src/Sema.zig:6784`); inline/comptime calls and runtime-body analysis depend on whole-declaration source (`src/Sema.zig:7203`, `src/Zcu/PerThread.zig:3334`). The report's suggestion that Silk may not need both remains design advice, not evidence that Zig avoids this distinction.
5. **Some reference pairs are implicit to save memory.** `nav_val`/`nav_ty` and layout/defaults have paired reachability relationships synthesized during traversal (`src/Zcu.zig:4421`). This optimization is in the reference graph and does not remove the actual invalidation dependency discussed in section 1.
6. **GC remains unimplemented.** The present code says so at `src/Zcu.zig:175`; compilation-lifetime interning arenas call it “currently vaporware” at `src/InternPool.zig:974`. Removal of non-tail interned entries currently marks their tag `.removed` rather than reclaiming their storage (`src/InternPool.zig:9885`). The report left this unresolved for current Zig. Edge-slot reuse and backend garbage collection are not whole-InternPool reclamation.
7. **Transient pipeline memory is bounded separately.** `CodegenTaskPool.start` accounts AIR bytes in flight and waits for capacity (`src/Zcu.zig:5435`, `src/Zcu.zig:5447`). Its comment explicitly aims to avoid “an excessive amount of memory”. Retained graph bytes are only one component of peak memory.
8. **Error edits have preservation paths.** Fatal file errors can set `skip_analysis_this_update` and return before remapping/analysis, deliberately avoiding widespread invalidation (`src/Zcu/PerThread.zig:259`). Failed declarations use zero hash sentinels (`lib/std/zig/AstGen.zig:13487`), and repeated semantic failure can stop a new propagation wave (section 5). OOM recovery is not established as transactional: current handling still says “it's unclear how to gracefully handle this” (`src/Zcu/PerThread.zig:1630`).
9. **Disk ZIR caching and incremental native linking remain real, separate mechanisms.** File-cache selection incorporates compiler version (`src/Zcu/PerThread.zig:493`), uses stat checks (`src/Zcu/PerThread.zig:761`), and loads ZIR on a hit (`src/Zcu/PerThread.zig:771`). Native mapped output owns a memory map and update list (`src/link/MappedFile.zig:21`, `src/link/MappedFile.zig:25`) and can grow/move nodes (`src/link/MappedFile.zig:691`). These code facts support the report's qualitative descriptions, without establishing its timings or platform-maturity claims.

**Could not determine from this checkout:** the report's 920 ms parse/AstGen measurement; its Fizzy, Zig-self-build and Tetris timings; nanoseconds per insertion; percentages of cold-build overhead; whether the quoted measurements isolate recording from other mode differences; rustc/Salsa implementation claims; release-support promises; and the causal predictions or achievable budgets for Silk. These are not falsified by the present audit, but none is a source-verified premise for the proposed Silk design. A benchmark would be required for quantitative cost or predicted speedup. No such measurement was inferred from the data structures.

The optional attempt to run an AstGen hash experiment with the installed compiler and this checkout's full standard library failed before execution because their calling-convention definitions were incompatible. No hash experiment output is claimed. The hashing findings above are established by source; the separate actual-`InternPool` layout test succeeded. No full current compiler was built.

**Relevance for Silk.** Reuse the source-established distinctions—stable handles, result-specific edges, lowering-time fingerprints and selective propagation—without treating Zig as evidence of zero one-shot graph allocation or a proven cold-overhead budget. Measure graph storage, identity/reference costs, disabled optimizations and backend retention separately.

## Summary table

| Claim | Verdict | One citation that best settles it |
|---|---|---|
| 1. Non-incremental builds never record reverse dependencies | **Contradicted: partly paid** | `src/Zcu/PerThread.zig:1891` — ungated inferred-type edge. |
| 2. AstGen owns BLAKE3/16-byte source fingerprints, reused by update logic | **Confirmed with changes** | `lib/std/zig.zig:60` — algorithm and adjacent stored-size definition. |
| 3. Current analysis-unit/dependee vocabulary compared with the snapshot | **Confirmed with changes** | `src/InternPool.zig:746` — current result-specific dependee union. |
| 4. Shared linked edge array, per-unit chain, freelist, roughly 24-byte entries | **Confirmed with changes** | `src/InternPool.zig:925` — actual layout; 24 bytes measured above. |
| 5. PO/readiness invalidation and Nav-value early cutoff remain | **Confirmed with changes** | `src/Zcu/PerThread.zig:1942` — interned Nav-value comparison. |
| 5a. Scope of semantic equality cutoff | **Confirmed with changes** | `src/Zcu/PerThread.zig:1396` — layout invalidated without comparison. |
| 6. Stable 32-bit tracked handles are remapped or become lost | **Confirmed with changes** | `src/Zcu/PerThread.zig:865` — loss; adjacent remap and invalidation. |
| 7. Persistence and partial state serialization | **Confirmed with changes** | `src/Compilation.zig:3817` — active partial-state write. |
| 7a. Backend-specific AIR/MIR retention | **Confirmed with changes** | `src/link/Wasm.zig:3595` — retained copied MIR. |
| 7b. Quantitative cold overhead and Silk time/RSS targets | **Could not determine** | No code citation can establish an unmeasured performance claim. |
