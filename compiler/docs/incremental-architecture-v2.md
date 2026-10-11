# Incremental architecture v2

**Status:** design note for Julia's review. Nothing here is implemented. It replaces the
per-declaration invalidation of #1359, which was closed as superseded after it failed the
cold-build gate.

**Inputs:** the Zig source audit in
[research/zig-incremental-verification.md](research/zig-incremental-verification.md) (cited as
"audit §n"), the #1359 gate comment, the native self-build profile (#1427), identity interning
(#1431), the borrow-checking note (#1421), [mir-core-shape.md](mir-core-shape.md),
[region-sensitive-identity.md](region-sensitive-identity.md) and #567.

**Evidence tags.** Every claim carries one of:

- **[measured]**: measured in this session on the machine described in §1.3;
- **[source]**: read from code, with a `path:line` on `selfhost` at `74637a1`, or a Zig citation
  through the audit;
- **[assumption]**: a design premise or estimate not yet measured.

## Summary

- **A third of today's cold self-build is revision machinery that a one-shot build never uses.**
  **[measured]** With identical emitted IR, removing the driver's revise-based module discovery
  cuts 22% of user time, and removing per-answer revision evidence cuts another 16% of what
  remains: 285 s becomes 187 s. Peak RSS drops only 2.4% (§1).
- v2 replaces that machinery with Zig's shape, verified in the audit: a small set of semantic
  dependee kinds over interned handles, fingerprints computed once while indexing, one central
  edge array, push marking plus pull verification, and cutoff on interned results (§2 to §6).
- A one-shot build records nothing: one early return in one recorder, and no fingerprints (§5).
  Modules load on demand, so a build runs once instead of 81 rounds.
- The first build of an incremental session is estimated at under 1% time and about 1.1% RSS over
  one-shot, against a proposed budget of 3% and 5% (§9).
- Nine language proposals and three safety-model options are ranked for Julia (§8). The largest
  precision gains come from scoping results by the profile entries they read, and from removing the
  three build-wide fixed points: failure observation, region sensitivity and suspension.
- The work starts with two deletions that need no new design, worth the measured 34%, then builds
  the graph in five slices (§10).

## 1. Current state

### 1.1 What a cold build records and validates

All **[source]**, `selfhost` at `74637a1`.

**Every completed answer** (`Answer`, `Semantic.silk:883-895`) retains:

- its direct dependencies, deduplicated (`distinctDependencies`, `:5116`);
- every _transitive_ source observation, as shared handles (`sources`);
- every _transitive_ demand footprint, one per family and module (`footprint`). Only
  `Request.hasDemand` and `Request.hasDiscovered` (`:3561`, `:3578`) read footprints and
  `discoveredBy`-style observation scans, and only `*Cases.silk` files call those;
- a copy of its value for later body reuse (`identityOfFact`, `:3205`);
- for a body, its direct-dependency evidence (`BodyEvidence`).

**Every child demand** (`demandChild`, `:5512`):

- appends a dependency;
- for a declaration family, demands the declaring module's source again so the parent observes it
  (`:5524-5528`);
- under a body parent, builds a `BodyDependency` with a shared identity and the child's answer
  identity (`:5581-5600`);
- appends a footprint, then merges every transitive observation and footprint of the child into the
  parent's frame, deduplicated through an `InternIndex` and `ModuleId.equals`
  (`mergeEvidence`, `:4143`; `appendObservation`, `:4084`).

**Every demand** (`demandRaw`, `:5304`) interns its key, scans the active stack linearly for a
cycle (`:5311-5317`), and on a memo hit runs `validAnswer` (`:1627`), which checks every transitive
observation against the held revision. Each check is a hash lookup, a `ModuleId.equals` and a
content address comparison (`Observation.matches`, `SourceRevision.silk:280`).

**Every checked body** builds a `BodyInput` that copies the declaration's source text byte by byte
and encodes canonical header and body bytes (`BodyInput.silk:53-79`), retained by the `TypedBody`
(`TypedBody.silk:605`) for reuse checks.

**The driver discovers modules by revising itself.** `build` runs the whole semantic build, reads
every module the build observed as absent, publishes a new `Revision`, calls `Semantic.revise` and
runs the build again, until no new file arrives (`main.silk:470-497`;
`ModuleSources.publishObserved`, `driver/ModuleSources.silk:613`). Every round revalidates cached
answers on their next demand and recomputes those that observed a now-present module.

### 1.2 Counters

**[measured]** A local experimental N1 with counters (not committed) built the compiler's own LLVM
IR. "Discovery" is today's driver; "one round" preloads the 184 modules the discovery run read, so
the driver never revises.

| Counter                                       | Discovery (81 rounds) | One round   |
| --------------------------------------------- | --------------------- | ----------- |
| modules read                                  | 184                   | 184         |
| driver revise rounds                          | 81                    | 0           |
| demands (`demandRaw`)                         | 17,825,783            | 15,632,656  |
| memo hits validated                           | 17,712,751            | 15,521,854  |
| answers invalidated by a revision             | 2,230                 | 0           |
| provider runs (answers computed)              | 113,032               | 110,802     |
| observations checked during validation        | 112,271,721           | 94,691,105  |
| child demands (dependency edges before dedup) | 17,198,853            | 15,571,791  |
| observations merged into frames               | 108,418,674           | 95,245,354  |
| footprints merged into frames                 | 253,325,954           | 224,003,466 |
| `source()` calls                              | 44,901,051            | 40,669,165  |
| active-stack steps scanned for cycles         | 27,497,747            | 26,174,414  |
| observations retained in answers              | 1,458,053             | 1,367,195   |
| footprints retained in answers                | 5,255,328             | 4,917,333   |
| direct dependencies retained (after dedup)    | 2,971,642             | 2,794,903   |
| body-dependency records built                 | 9,225,391             | 8,673,327   |
| answers with an identity copy                 | 37,665                | 37,637      |

Per computed answer, in the one-round build: 141 demands reach it, of which 140 are memo hits; it
retains 12.3 observations, 44.4 footprints and 25.2 direct dependencies. Each memo hit checks 6.1
observations. The query graph is small (110,802 answers, 2.8 million direct edges); the cost is
that each answer is demanded and revalidated 141 times, and each demand merges its child's
transitive evidence.

### 1.3 Time and memory

**[measured]** One container, 4 vCPU, 15 GiB, no other work running. Every compiler was built by the
pinned seed `native-seed-6262fb95` from `selfhost` `74637a1` (the instrumented one from the same
tree plus the counters). Each run is
`build src/main.silk -o out.ll --emit llvm-ir --stdlib ../packages/compiler/stdlib --optimization speed --debug false`
in `compiler/`, under `/usr/bin/time -v`. All four emitted byte-identical IR (sha256 prefix
`f51d503a2b99988b`).

| Run                                                | User    | Wall | Peak RSS |
| -------------------------------------------------- | ------- | ---- | -------- |
| base N1                                            | 295.7 s | 5:09 | 4.74 GB  |
| instrumented N1, today's driver                    | 285.0 s | 4:58 | 4.74 GB  |
| instrumented N1, all modules preloaded (one round) | 222.6 s | 3:55 | 4.73 GB  |
| instrumented N1, preloaded, recording stubbed      | 187.2 s | 3:19 | 4.62 GB  |

"Recording stubbed" skips observation capture, evidence merging, footprints, body-dependency
records and answer identity copies, and treats every memo hit as valid. That is correct only
because a preloaded build never revises; it was run once for the number and is not a proposal.
It does not remove `BodyInput` construction or the active-stack scan, so it understates the
bookkeeping a one-shot build pays.

Reading the table:

- **Module discovery by revision costs 62 s, 22% of user time.** The rounds add only 2,230
  recomputed answers and 2.2 million demands, so most of the cost is outside the counted demand
  path. §1.4 attributes it.
- **Per-answer evidence costs 35 s, another 16%.**
- **Together, 98 s or 34%.** Peak RSS falls by 113 MiB, 2.4%. Retained evidence is not what makes
  the build use 4.7 GB.
- **Noise.** The base and instrumented runs differ by 3.6% in the direction opposite to the added
  counters, so single runs carry a few percent of noise. The 22% and 16% steps are well outside it.
  This VM exposes no hardware counters (`perf stat` reports cycles and instructions as not
  supported), so gates need repeated runs (§9).

For scale: #1359's gate measured 612 s user for a full self-build including clang on the same kind
of machine; the IR emission measured here is the front end and MIR part of it.

### 1.4 Where the round cost goes

Pending: a frame-pointer profile of a bootstrap-built N0 attributes the 62 s of the discovery
rounds and the 35 s of evidence. It is added here when measured.

## 2. Units and dependees

The #1359 design made every semantic read a tracked dependency. v2 separates two things, as Zig
does (audit §3): **analysis units**, which are the work that gets redone, and **dependees**, which
are the small set of properties a unit can consume. A unit records an edge only when it consumes a
dependee. Reads inside one unit are never recorded.

### 2.1 Analysis units

A unit is `(kind, subject)`, where the subject is an interned handle (§3.4). Today's query
families (`Semantic.silk:304`) map onto eight unit kinds. Families that only project one
declaration's own syntax stop being separately tracked; they run inside the unit that needs them.

| Unit            | Subject                       | Today's families folded in                                                                                                                                                                                                                                 | Result others consume                   |
| --------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `Header(D)`     | declaration                   | `Signature`, `Alias`, `Identity`, `Contract`, `Members`, `MemberShape`, `Operations`, `FieldLifetimes`, `Constant`, `ImplementationHead`, `ImplementationMembers`, `Witnesses`, `ParameterSchema`, `OperationUnder`, `AppliedOperation`, `AppliedInherent` | the interned header record              |
| `Value(D)`      | declaration                   | `Initializer`, `Condition`, `ParameterDefault`                                                                                                                                                                                                             | the interned static value               |
| `Body(D, s)`    | declaration, static selection | `Body`; anonymous functions and `effect {}` blocks inside it                                                                                                                                                                                               | its realization (§2.2), and its own MIR |
| `Borrow(D, s)`  | same key as `Body`            | the `BorrowCheck` family of #1421                                                                                                                                                                                                                          | `Checked` or the rejections             |
| `Coherence(I)`  | `impl` declaration            | `Coherence`, `ProofBounds`                                                                                                                                                                                                                                 | accepted or rejected                    |
| `Layout(T)`     | interned type application     | `Layout`                                                                                                                                                                                                                                                   | size, alignment, offsets, ABI class     |
| `Instance(k)`   | interned instance key         | `Mir`, `EmissionInputs`, `LlvmText`                                                                                                                                                                                                                        | the content subject of its LLVM text    |
| `Catalog(root)` | discovery root                | `Tests`                                                                                                                                                                                                                                                    | the test catalog                        |

**[source]** for the family list; the grouping is the proposal. Two choices need justification.

- **Anonymous declarations are not units.** Their identity is an occurrence among unnamed siblings
  (`DeclarationId.silk:7-9`), so an edit above them in the same body renumbers them. Analyzing
  them inside their enclosing `Body` unit costs nothing extra on a cold build and makes their
  instability harmless: the enclosing body reruns anyway when its text changes.
- **`Header` merges sixteen families.** Each family today is a cached answer that carries its own
  evidence (§1.2). They all read only the declaration's prototype plus other declarations' headers,
  so they consume the same dependees. One unit records each consumed dependee once. The price is
  coarser cutoff inside one declaration: a caller that reads only a struct's member names reruns
  when a field type changes. That is the same precision Zig accepts for `nav_ty` (audit §3).

Generic selections stay as today: an ordinary generic body is one `Body(D, none)`, a static
selection is `Body(D, s)` with `s` the interned selection (the settled decision in #567). The
borrow unit uses the same key, which answers #1421's requirement that a checking unit be an
incremental unit with its own cutoff (§8.3).

### 2.2 Dependee kinds

Twelve kinds. Each one exists because it stops a specific fan-out. A kind that cannot be justified
this way is dropped and its readers consume a coarser kind.

| Dependee            | Key                              | Changes when                                                                                 | Fan-out it prevents                                                                                                                                      |
| ------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SourceFile(M)`     | module                           | the module path appears, disappears or loses its root identity                               | an import of an absent module reruns only when that file appears, not on every other file event                                                          |
| `DeclSource(D)`     | declaration                      | the whole-declaration fingerprint changes (§3)                                               | a body edit reruns only that body; it is the only kind `Body(D)` and `Value(D)` read for their own text                                                  |
| `DeclPrototype(D)`  | declaration                      | the prototype fingerprint changes                                                            | a body edit does not rerun `Header(D)`; body edits are the most common edit                                                                              |
| `Name(M, n)`        | module, interned name            | the candidate set for `n` in `M` changes, including absence and visibility                   | adding an unrelated declaration to `M` does not rerun every importer of `M`; only users of that spelling rerun. Absence is tracked, as in Zig (audit §3) |
| `Namespace(M)`      | module                           | the set of names in `M`, with visibility, changes                                            | only whole-module readers (operator discovery, test discovery) pay for additions; name lookups use `Name`                                                |
| `ImplSet(C, O)`     | contract, provider owner         | the set of conformance `impl` declarations for that bucket changes                           | adding an `impl` reruns only goals and coherence checks for its bucket, not every proof that read its module's `Implementations` list                    |
| `InherentSet(O)`    | nominal owner                    | the set of inherent `impl` members of `O` changes                                            | inherent member lookup on `O` stops depending on every inherent `impl` in the module                                                                     |
| `HeaderOf(D)`       | declaration                      | `Header(D)` produced an unequal result                                                       | callers depend on signatures, never bodies (G3 to G5, #567)                                                                                              |
| `ValueOf(D)`        | declaration                      | `Value(D)` produced an unequal result                                                        | an initializer edit that yields the same value stops at the value                                                                                        |
| `Realization(D, s)` | declaration, selection           | the body's externally visible inferred facts changed: opaque realization and callable origin | a body edit that keeps its opaque representation does not rerun its consumers' layout and MIR. This is the analogue of Zig's `func_ies` (audit §3)       |
| `LayoutOf(T)`       | type application                 | `Layout(T)` produced an unequal layout                                                       | a field edit that keeps size, alignment and offsets stops at the layout                                                                                  |
| `ProfileEntry(p)`   | profile parameter or target fact | that one value changes                                                                       | changing one package parameter reruns only its readers (§8, proposal P1)                                                                                 |

Two more are needed only in an incremental session that emits debug information or embeds files:
`DeclLocation(D)` (the declaration's line and column, read only by emission with `--debug true`,
the analogue of Zig's line-number update, audit §6) and `EmbeddedFile(F)`. They never appear in a
build without those features.

What is **not** a dependee: syntax projections (presence, selection, header, body, name, shape)
read by #1359, source positions, declaration ordinals, and observations of whole modules. Each
#1359 projection is either part of a unit's own prototype or source fingerprint, or is answered by
`Name`, `Namespace`, `ImplSet` or `InherentSet`.

### 2.3 What today's query layer keeps

The demand-driven `Query` store (`Query.silk:43`) stays the memo table and the scheduler for both
cold and incremental builds. Its keys become unit keys. Families folded into `Header` become
ordinary functions over the `Header` unit's working state, memoized inside the unit when they are
read more than once.

## 3. Source change detection

### 3.1 Fingerprints

Computed once per declaration while `ModuleIndex.build` walks the declarations of a freshly parsed
module (`SourceIndex.silk:127`), and only in an incremental session (§5).

| Fingerprint    | Covers                                                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whole(D)`     | the declaration's token stream, kind and text per token, excluding trivia and positions. A directly nested declaration with its own identity (an `impl` member, a static-conditional arm's declaration) contributes only its identity key, not its tokens.                   |
| `prototype(D)` | for a function, the tokens from its name through its contract and `where` clause; for a type, alias, constant, interface or service, the whole declaration, since its fields and operations are its prototype; for an `impl`, its head plus the identity keys of its members |
| file           | the file's byte length and a 128-bit hash of its bytes, used only to skip reparsing an unchanged file (the stat shortcut in Zig, audit §5, is a separate filter in front of it)                                                                                              |

Differences from Zig, each deliberate:

- **Tokens, not raw bytes.** Zig hashes raw source slices, so comment edits rerun analysis (audit
  §2). Silk's parser already holds tokens, so excluding trivia costs nothing extra and makes
  comment and whitespace edits free. Positions are excluded too; §3.3 says how locations stay
  current.
- **Nested declarations by identity.** Zig's outer declaration hash includes nested declaration
  text (audit §2). Silk's methods live inside `impl` blocks, so including them would make every
  method body edit change the `impl`'s fingerprint. Replacing them with their identity key keeps
  membership changes visible and body edits local.
- **No separate container field hash.** A Silk struct's fields are its prototype, and its methods
  are separate declarations. Zig needs a field hash because a Zig container also holds its
  declarations (audit §2).

**Hash.** 128 bits, non-cryptographic, word at a time, streaming over tokens. The backend already
names symbols by two seeded 64-bit hashes (`backend/InstanceKey.silk:676-678`, byte at a time
through `InternIndex.hashBytes`, `semantic/InternIndex.silk:100`). The fingerprint hash should be
a new stdlib function that processes eight bytes per step. **[assumption]** At 128 bits, the
chance of any collision among 10^7 fingerprints is about 10^14 / 2^129, below 10^-24. The threat
model is accidental collision; a deliberately colliding source file is out of scope, as it is for
Zig's truncated BLAKE3 (audit §2). If Julia wants adversarial resistance, BLAKE3 truncated to 128
bits is the alternative, at several times the cost per byte.

**Cost.** **[measured]** The self-build reads 184 modules totalling 7.3 MB (the compiler's
non-test sources plus the stdlib modules it imports). A grep approximation counts about 7,700 named
declarations in them. Each byte is hashed at most twice, since whole and prototype regions overlap
for functions, as in Zig. **[assumption]** At 1 GB/s that is about 15 ms for a first build, paid
only in an incremental session.

### 3.2 What replaces BodyInput

Today every checked body builds a `BodyInput` (`BodyInput.silk:53-79`) that copies the
declaration's source bytes one at a time and encodes its canonical header and body
(`hir/Fingerprint.silk:1067`, `:1107`), and every `TypedBody` retains it
(`TypedBody.silk:605`). That is the per-reader projection pattern of #1359 in a cheaper form, and
it runs on cold builds. v2 deletes it: a body unit consumes `DeclSource(D)`, whose fingerprint was
computed once in the index. The canonical encoding in `hir/Fingerprint.silk` stays only if another
consumer needs it (test fingerprints, TEST-005); body reuse no longer does.

### 3.3 Stable declaration identity

The identity already exists: a `DeclarationId` is the module plus an owner chain of
`(kind, name, occurrence)` steps, where occurrence counts siblings with the same kind and name
(`DeclarationId.silk:1-15`). It contains no position. **[source]** What is positional today is the
query key: `Key.declaration` (`Semantic.silk:965`) is the declaration's ordinal in
`ModuleIndex.listDeclarations`, so inserting a declaration above another changes the other's key.
v2 keys every unit by an interned declaration handle (§3.4).

The identity contract, stated per edit:

| Edit                                                                                     | Identity                                                                         | Consequence                                                                                                                                |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Reorder named declarations in one scope                                                  | kept                                                                             | no reanalysis; only locations change (§3.5)                                                                                                |
| Insert or delete another declaration                                                     | kept for every other declaration                                                 | only the changed name buckets and namespace propagate                                                                                      |
| Edit a declaration's body                                                                | kept                                                                             | `DeclSource(D)` changes; `DeclPrototype(D)` does not                                                                                       |
| Rename                                                                                   | old identity lost, new one created                                               | `Name(M, old)` and `Name(M, new)` change; dependers of the old handle are outdated                                                         |
| Move to another scope, module or file                                                    | lost and created                                                                 | as rename. No relocation matching, as in Zig (audit §6)                                                                                    |
| Insert, delete or reorder unnamed siblings of one kind (`impl` blocks, conditional arms) | identities shift by occurrence                                                   | the shifted declarations compare unequal fingerprints and rerun; correct, but imprecise. §8 P6 proposes naming `impl` blocks by their head |
| Same-key named siblings (`IndexedDeclaration.ambiguous`, `ModuleIndex.silk:65`)          | kept by occurrence while the count is unchanged; all lost when the count changes | conservative; such siblings are already diagnostics in most positions                                                                      |
| Move a file to another module or package                                                 | every declaration in it is lost                                                  | as Zig's module reassignment (audit §6)                                                                                                    |

**When identity is lost**, its record is marked lost and is never revived (as Zig, audit §6). Its
units are deleted: their edges are removed (§4.3) and their results dropped. Every depender of a
dependee keyed by the lost handle is marked outdated. Name buckets carry the rest: a caller that
named the old spelling reran through `Name`. The lost handle's table slot is reclaimed at the next
compaction (§4.4).

### 3.4 Interned handles

v2 needs dense integer handles, not only shared records:

- `ModuleIndex: u32`, one per module identity in the session. #1431 makes `ModuleId` a shared
  record compared by address (`ModuleId.silk` on #1431); the next step is the ordinal table
  #1427 proposes, held by the session.
- `DeclIndex: u32`, one per `DeclarationId`, keyed by module ordinal plus owner-chain bytes,
  with the canonical bytes cached once (#1427 step 2).
- `NameIndex: u32` for interned spellings, which `Resolver.names` already is
  (`Semantic.silk:1414`).
- `TypeIndex: u32` for hash-consed types, needed before header and layout cutoff can compare
  handles instead of walking trees (#1427 step 3). Until then those comparisons are structural and
  run only on the incremental path.
- `UnitIndex: u32`, the existing `ScopedKey` interning (`Semantic.silk:3887`) with the key's
  declaration field changed from an ordinal to a `DeclIndex`.

Output never depends on handle values: emitted names keep using canonical bytes, so the N1/N2
fixpoint stays meaningful (#1427).

### 3.5 Locations

Fingerprints exclude positions, so a body that moves keeps its unit result. Locations stay current
by construction instead of by invalidation:

- typed bodies, MIR origins and retained diagnostics store spans relative to their declaration's
  start;
- each indexed module keeps a per-declaration table of absolute start offset, line and column,
  rebuilt on every parse;
- a diagnostic is rendered against the current table when it is reported.

This covers #1359's `unchangedByteOffsetsStillObserveChangedLineCoordinates` scenario without
rerunning the body. Only emission with debug information reads absolute lines, through
`DeclLocation(D)`.

## 4. The graph

### 4.1 Layout

One graph per session, owned by the semantic store, in the shape the audit measured for Zig (audit
§4), with two changes noted below.

- **Units.** The interned unit table gains, per unit, `firstEdge: u32`, `state: u8` and two
  revision stamps (§6.2). 12 bytes per unit beyond today's `ScopedKey`.
- **Dependees.** One hash map per dependee kind from the kind's key (a `u32`, or a `u64` for the
  pair keys of `Name`, `ImplSet`, `Realization`) to a dense `DependeeIndex: u32`. A dense
  dependee record holds the head edge. Zig maps keys directly to head edges and must leave a dummy
  head when a head edge is removed (audit §4); an indirection through a dependee record lets the
  head be cleared.
- **Edges.** One array of 16-byte entries: `depender: UnitIndex`, `next` and `prev` in the
  dependee's doubly linked list, and `nextOfDepender` in the unit's singly linked list. A head
  edge's `prev` holds its `DependeeIndex` with the top bit set, so unlinking a head needs no
  search. Zig's entry is 24 bytes because its unit is 8 bytes (audit §4); a `u32` unit index makes
  it 16.
- **Free list.** Removed edges go on a free list and are reused before the array grows.

### 4.2 Recording

`Recorder.record(unit, dependee)` is the only insertion path (§5). Within one unit run, a small
open-addressed set of `DependeeIndex` values deduplicates, as Zig's per-analysis map does (audit
§1, §7). It is cleared, not freed, between runs.

### 4.3 Removal on reanalysis

Before a unit reruns, its edges are removed: walk `nextOfDepender` from `firstEdge`, unlink each
entry from its dependee list, push it on the free list. The run then records a fresh set. Edges
are never diffed against the previous set.

### 4.4 Reclamation

Zig's pool garbage collection is unimplemented (audit §4, §7). v2 bounds memory in a long session
with compaction at idle: when free edges exceed a quarter of the array, rebuild the edge array by
walking live units, and drop dependee records with no edges and lost declaration handles. Units no
longer reachable from any root of the session's last requests are deleted the same way.
**[assumption]** Compaction is linear in live edges and runs between requests, so it never sits
on the latency of an edit.

### 4.5 Memory arithmetic

Retained bytes for a session that has built the compiler once:

```
graph = 16 E                        edges
      + ~24 D                       dependee map entry, record, load factor
      + 12 U                        per-unit graph fields
```

E, D and U are measured in §1.4 for today's queries and projected in §9.2 for v2 units.

## 5. Recording policy

### 5.1 One recorder, one early return

```
Recorder.record(unit, dependee):
  if !session.incremental { return }
  ...
```

Every edge goes through this function, including edges a provider records on behalf of another
unit. Zig's one exception, an ungated `nav_ty → nav_val` insertion during value analysis (audit
§1), is the warning: a provider that publishes a result for a key other than its own must still
call the recorder. Silk has such providers today: cycle members publish their own rejection
(`memberCycleAnswer`, `Semantic.silk:5424`), and origin transactions publish draft and replay
answers (`OriginContext`). They record nothing in a one-shot build because the recorder returns.

The same flag gates fingerprinting (§3.1), the dedup set, unit revision stamps and the dependee
maps. A one-shot build allocates none of them.

### 5.2 What a one-shot build still pays

The audit's lesson is to account these separately (audit §1):

| Work                                                                               | One-shot              | Why it stays                                                       |
| ---------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------ |
| Identity interning                                                                 | yes                   | it replaces byte comparison and copying, a net gain (#1427, #1431) |
| Unit table and memo answers                                                        | yes                   | memoization is the scheduler; every unit runs at most once         |
| Instance walk and reachability                                                     | yes                   | emission needs it (`buildRuntime`, `Semantic.silk:64948`)          |
| Diagnostics and reference context                                                  | yes                   | output                                                             |
| Fingerprints                                                                       | no                    | nothing compares them                                              |
| Edges, dependee maps, stamps                                                       | no                    | nothing invalidates                                                |
| Source observations, footprints, body evidence, answer identity copies, validation | deleted in both modes | replaced by the graph (§10)                                        |

### 5.3 One scheduler

Cold and incremental builds use the same demand function. A unit has a state byte:
`absent`, `upToDate`, `potentiallyOutdated` or `outdated`. In a one-shot build every unit goes
from `absent` to `upToDate` once and the other two states never occur. §6 adds what an update
does. Nothing in the cold path branches on the mode except the recorder's early return and the
fingerprint gate.

### 5.4 Source loading without revisions

Today a one-shot build discovers its modules by revising itself: the driver runs the whole build,
reads every module the build observed as absent, publishes a new `Revision`, calls
`Semantic.revise` and runs the build again until no new file arrives (`main.silk:470-497`,
`ModuleSources.publishObserved`, `driver/ModuleSources.silk:613`). Each round revalidates every
cached answer against the new revision (`validAnswer`, `Semantic.silk:1627`) and recomputes every
answer that observed a newly present module. §1.4 measures what this costs.

v2 loads sources on demand. The source provider becomes a `service` that the driver supplies: a
`SourceIndex` miss asks it for the module's bytes or absence, and the answer is final for the
session's current revision. A one-shot build then runs exactly once, and `Semantic.revise` is
called only by an incremental session when files change. The semantic store still never touches
the filesystem itself; it reads through the provider, which tests replace with an in-memory map.

## 6. Invalidation and cutoff

### 6.1 One update

1. **Detect.** The session learns which files changed (watcher events or a stat pass). For each,
   it compares the file fingerprint; equal bytes stop here.
2. **Reindex.** Parse and index the file. Match old and new declarations by `DeclarationId`
   (§3.3). Compare `whole` and `prototype` fingerprints, rebuild name buckets, the namespace, impl
   sets and inherent sets, and diff them against the old ones.
3. **Mark.** For every changed input dependee, mark each depender `outdated`. Then, from each newly
   outdated unit, mark the dependers of its output dependees `potentiallyOutdated`, transitively.
   A unit already `outdated` is not walked again. Lost handles mark their dependers `outdated`.
4. **Demand.** The session demands its roots (the build's runtime root, or an LSP request's units).
   `demand(u)`:
   - `upToDate`: return the cached result. There is no per-hit validation walk.
   - `outdated`: rerun `u`.
   - `potentiallyOutdated`: for each dependee on `u`'s edge chain, in recording order, bring its
     producing unit up to date with `demand`. If its `changedAt` is newer than `u.verifiedAt`,
     rerun `u` and stop. If none changed, `u` becomes `upToDate` without running.
   - `absent`: run `u`.
5. **Rerun.** Remove `u`'s edges, run its provider, record fresh edges, compare the new result with
   the old one (§6.3). Equal: keep the old `changedAt` (backdating, as salsa does). Unequal: set
   `changedAt` to the current revision. Either way `verifiedAt` is the current revision.

This combines Zig's push marking (audit §5) with salsa's pull verification. Push marking bounds
the region that can change, so units outside it are `upToDate` by a state byte and are never
walked; salsa needs durability levels to get the same skip. Pull verification keeps Silk's
demand-driven order and avoids Zig's pessimistic reanalysis when a potentially outdated unit is
demanded before its dependencies settle (audit §5). Cycles keep today's rule: an active key
demanded again reports `Cycle` (`Query.silk:107`).

### 6.2 Revision stamps

A session revision is a `u32` counter, advanced once per update. Each unit stores `changedAt` and
`verifiedAt` (8 bytes, in the 12 of §4.1). Input dependees store the revision of their last change.

### 6.3 Every cutoff point

| Point                         | Compared                                                               | Enough because                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| File                          | length and 128-bit hash                                                | covers the whole input                                                                                                             |
| `DeclSource`, `DeclPrototype` | 128-bit fingerprints                                                   | the fingerprint covers every token the unit reads (§3.1)                                                                           |
| `Name(M, n)`                  | set of `(DeclIndex, candidate kind, import ordinal, public)`           | it is the complete bucket `NameObservation` already models (`ModuleIndex.silk:156-172`), absence included                          |
| `Namespace(M)`                | set of `(NameIndex, public)`                                           | whole-module readers consume only names and visibility; they read members through `Name` or `HeaderOf`                             |
| `ImplSet`, `InherentSet`      | set of `DeclIndex`                                                     | the heads themselves are read through `HeaderOf(impl)`                                                                             |
| `SourceFile(M)`               | presence                                                               | content is covered per declaration                                                                                                 |
| `ProfileEntry(p)`             | the interned static value                                              | one entry is the whole consumed input                                                                                              |
| `HeaderOf(D)`                 | interned header record, including success or rejection                 | only if the record holds everything a reader consumes; see the conditions below                                                    |
| `ValueOf(D)`                  | interned static value, including success or rejection                  | same                                                                                                                               |
| `Realization(D, s)`           | interned realization: opaque representation, callable origin           | same                                                                                                                               |
| `LayoutOf(T)`                 | size, alignment, field offsets, enum encoding, ABI class               | that is the whole `BackendLayout`; Zig skips this comparison (audit §5) and Silk should not, because layout records are small      |
| `Body(D, s)`                  | none: a rerun body always reruns its own `Instance` and `Borrow` units | comparing typed bodies costs more than it saves; trivia-only edits never reach a body (§3.1)                                       |
| `Borrow(D, s)`                | `Checked`, or rejection codes with relative spans                      | nothing downstream reads more                                                                                                      |
| `Coherence(I)`                | accepted, or rejection code with relative span                         | same                                                                                                                               |
| `Instance(k)`                 | the interned content subject of the LLVM definition                    | it is already the `LlvmText` key (`mir-core-shape.md` §2): equal content is the same answer, and object code keyed by it is reused |
| `Catalog(root)`               | the ordered catalog                                                    | §8 P5 narrows what it contains                                                                                                     |

**Where interned equality is not enough.** Interned equality is sound only when the interned value
is the entire consumed result (audit §5). Four conditions follow:

1. **Positions.** A result that carries absolute spans compares unequal after an unrelated line is
   inserted above it, and one that omits them reports stale locations. Results store relative
   spans and diagnostics render against the location table (§3.5).
2. **Rejections.** Success to rejection and back always propagates, as in Zig, which compares a
   failure Boolean (audit §5). A repeated rejection compares by code and relative anchors, never by
   message text.
3. **Ordinals.** A result holding a module or declaration ordinal (today `Value.Selected` holds
   `module` and `ordinal`, `Semantic.silk:692`) must hold handles instead; ordinals shift with
   unrelated edits.
4. **Shared types.** Until types are hash-consed, `HeaderOf` and `Realization` comparisons walk
   types structurally. That is correct but costs the incremental path only.

### 6.4 Memoization that hides dependencies

Zig disables comptime-call memoization in incremental mode because a memoized call's dependencies
are not given to the caller (audit §7). Silk's static machine keeps a completed-call memo per
machine (`StaticExecution.silk:236`, checked near `:2843`), and a machine lives for one demand
(**[source]**, survey of `StaticExecution.make` call sites). Across units, static results are
shared only through `Value` units. So Silk needs no mode switch, provided two rules hold:

- a static machine never outlives the unit that created it;
- a static call reads the callee's `DeclSource`, not its `HeaderOf`, because it executes the body
  (MODULE-STATIC-001, `module-static-selection.md`: "A changed condition helper body invalidates
  its consumers even if its public signature is unchanged").

If a cross-unit static-call cache is ever added, each cached call must be a unit.

## 7. Lifecycle

### 7.1 In memory first

A **session** owns the source provider, the interned tables, the semantic store with its units and
graph, and the backend artifacts. A one-shot build is a session that never updates. Watch mode and
the LSP keep one session alive and call `update` with changed files.

What a long-running session retains between updates:

- the parsed and indexed sources of every module in the build, with fingerprints and location
  tables;
- unit results that others consume: headers, values, realizations, layouts, catalogs (small);
- typed bodies, because an `Instance` or `Borrow` unit reruns when a callee signature changes even
  though its body did not. **[assumption]** Evicting typed bodies and rechecking on demand is a
  later memory option, measured before it is built;
- per instance, the content subject and its LLVM text or object code (§7.2);
- the graph.

What it drops: static machines, MIR after its LLVM text is produced, request-local state.

### 7.2 The backend is part of the design

**[measured, #1427]** `clang -O2` on the 77 MB compiler IR takes 88 s, against about 272 s of front
end. An incremental front end that reruns one body in milliseconds still pays 88 s if the backend
recompiles one LLVM module. The backend therefore needs its own cutoff:

- partition definitions into codegen units by a stable key (for example the defining module, or a
  hash of the symbol into a fixed number of buckets);
- a codegen unit's identity is the sorted set of content subjects of its definitions;
- an unchanged set reuses the previous object file; a changed set recompiles only that unit;
- link the objects.

This changes output only in partitioning, which LLVM's semantics do not observe; the fixpoint gate
compares IR text per unit instead of one file. The partitioning scheme is an open question (§11).

### 7.3 On disk

Nothing semantic in v2. Zig itself writes only a partial state file and has no complete reader
(audit §7), and rustc's serialized graph is a large separate subsystem. Two disk caches are worth
considering later, each only after a measurement shows it pays:

- **object code per codegen unit**, keyed by its content set and the compiler identity. This is
  the cache a repeated one-shot build would use most;
- **parsed and indexed files** keyed by file hash and compiler identity, as Zig's ZIR cache does
  (audit §7), if parsing turns out to be a large share of a first build.

## 8. Language and safety-model proposals

Every item here is a proposal for Julia to decide. None is assumed by §2 to §7: the design works
on today's language, and each proposal makes it cheaper or more precise. Each states the reference
change, what it buys, and why memory safety still holds. They are ranked by benefit, highest first.
The survey behind them read the reference and the native implementation; its citations were
spot-checked.

### 8.1 Features that make tracking global

| Feature                                                                         | What a use reads                                                             | Reach today              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------ |
| Profile, application and condition scoping of every query key                   | the whole profile identity                                                   | whole program            |
| Failure observation switch (`failure-observer-and-trace.md` N1)                 | whether any reached function observes                                        | whole program            |
| Suspension closure (`closeSuspendable`, `Semantic.silk:66095`)                  | the reverse call graph                                                       | whole program            |
| Region-sensitive identity (`markRegionSensitive`, `Semantic.silk:65520`)        | which lifetime-selective heads lowering consulted, closed over lending edges | whole program, per build |
| Polymorphic-recursion admission (GEN-006)                                       | the path from the roots                                                      | whole program            |
| Module `static if` (MODULE-STATIC-001 to 005)                                   | static helper bodies, constants, profile                                     | import closure           |
| Test discovery (TEST-003, TEST-004)                                             | every test in the root's import closure, with line and column                | package                  |
| Generated field lifetimes, variance, `Drop` and `Copy` classification           | the owned structure of every field type, transitively                        | type graph               |
| Opaque realization and callable origin (REP-004, REP-005, EFF-013)              | producer bodies, transitively, as a fixed point                              | producer graph           |
| Operator discovery (OP-009, `collectOperatorInterfaces`, `Semantic.silk:60658`) | every operator interface of every namespace-imported module                  | module and its imports   |
| Conformance and coherence (IMPL-004 to IMPL-009)                                | the `impl` lists of at most two modules (orphan rule)                        | module pair              |
| Effect contracts, captures, name lookup                                         | own body and callee signatures; one name bucket                              | local                    |

The last two rows need no language change: the orphan rule already bounds coherence to two modules
(IMPL-004, `generics-interfaces-and-specialization.md:1317`), and `ImplSet` makes it per bucket.
Effect contracts are already local, because the reference removed body inference of channels
(EFF-011, "Superseded direction", `effect-contracts.md:214`). That earlier decision is the single
largest reason this design can be precise.

### 8.2 Proposals, ranked

**P1. Results depend on the profile entries they read, not on the whole profile.**

- _Today._ Every query key includes the request's profile slot, application and condition context
  (`ScopedKey`, `Semantic.silk:976`; `internKey`, `:3887`). Any change to one package parameter or
  target fact opens a new cache partition; no answer is shared, even one that never reads the
  parameter. A different application re-keys every answer except layout.
- _Reference change._ MODULE-STATIC-005 (`module-static-selection.md:68`) and PROFILE-005
  (`compilation-profiles.md:147`) say a result belongs to a profile. Restate: a result is a
  function of the profile entries and target facts it reads, and equal entries give equal results.
  Profile identity stays the cache key of a whole build, not of each semantic result.
- _Buys._ Incremental: changing one parameter reruns only its readers, through
  `ProfileEntry(p)`. An LSP session can share every unrelated result between two profiles or two
  applications. Cold: none.
- _Safety._ Unchanged. This is dependency granularity, not semantics.

**P2. Make failure observation local instead of a whole-program switch.**

- _Today._ If any reached function runs `observeDiagnostics`, every function is lowered again in
  observing mode with hidden parameters, and the instance graph is walked twice
  (`failure-observer-and-trace.md` N1, settled in #822). The mode is an input of MIR but not of the
  instance key. One added observer call anywhere invalidates all MIR and LLVM text.
- _Options._ (a) Make observation a requirement in the Effect row, so a function that can reach an
  observer says so in its contract and only those functions take the hidden parameters. (b) Always
  thread the observer, paying one parameter per effectful call in every program. (c) Keep the
  switch, but key instances by mode so a switch adds instances instead of relowering.
- _Reference change._ (a) changes `typed-failures.md` and `effect-contracts.md`: observation
  becomes a declared capability. (b) and (c) change no reference text.
- _Buys._ Incremental: removes the largest single invalidation. Cold: (a) removes the second walk
  for observing programs; (b) costs every program a little; (c) costs nothing.
- _Safety._ Unchanged; observation reports failures and owns no memory.
- _Recommendation._ (c) now, because it is free and keeps #822's decision. (a) if Julia wants
  observation to be explicit.

**P3. Region-erased identity without a build-wide fixed point.**

- _Today._ An application is region-sensitive if lowering consulted a lifetime-selective head, or
  if it lends its regions to one that did (`region-sensitive-identity.md`). Rule 2 is a fixed point
  over the reached graph, and `buildFrom` walks the graph again when marks grow
  (`Semantic.silk:65386`). Adding one lifetime-selective head can make distant callers exact.
- _Options._ (a) Forbid lifetime-selective `impl` heads: a head may not name `'static`, repeat one
  region, or bound a region. Then no application is region-sensitive and the rule, the walk and
  `exactApplications` are deleted. (b) Make sensitivity a property of the head's signature, read
  through `HeaderOf`, so a caller learns it locally.
- _Reference change._ (a) adds a rule to IMPL-004 to IMPL-007 in
  `generics-interfaces-and-specialization.md`: coherence already erases lifetimes, so heads that
  differ only in regions are already rejected; (a) rejects heads that select by region at all.
- _Buys._ Cold: removes the repeated walk for programs that reach such heads, and the per-body
  `regionSelections` bookkeeping. Incremental: instance identity stops depending on the whole walk.
- _Safety._ (a) only rejects programs. The region-sensitive identity note proves erasure sound
  exactly when no consulted head is lifetime-selective, which (a) makes always true. Borrow checking
  is unaffected because instances are never checked (#1421 §2), and #1421's question 8 disappears.
- _Cost to users._ Any stdlib or corpus `impl` whose head names `'static` must change. The survey
  did not count them; slice 0 of §10 counts before Julia decides.

**P4. Suspension declared in contracts.**

- _Today._ Whether an instance suspends is a transitive fixed point over the reverse call graph
  (`closeSuspendable`), so that non-suspending code pays nothing (SUSP-018,
  `effect-suspension.md:463`). Adding `Effect.suspend` in a leaf changes the lowering of every
  transitive caller, found only by a whole-program pass.
- _Option._ A function whose execution can park says so in its contract, for example through the
  existing execution modes (`Intrinsic.NonParking` and its counterpart). A call to a parking
  callee from a non-parking contract is rejected. Lowering reads only callee headers.
- _Reference change._ `effect-suspension.md` SUSP-003 and the execution modes; EFF rules for the
  contract syntax.
- _Buys._ Incremental: a new suspension point changes one signature and propagates through
  `HeaderOf`, with cutoff. Cold: removes the closure pass and the extra walk with suspendable roots
  (`Semantic.silk:65470`). It also makes `NonParking` checkable, which the native compiler accepts
  unchecked today (survey, `Semantic.silk:62607`).
- _Safety._ Unchanged; parking is about scheduling, and frames keep the same ownership rules.

**P5. Type summaries instead of transitive walks, and optionally explicit lifetimes on types.**

- _Today._ Generated field lifetimes are transitive: a nested nominal used without written
  lifetimes contributes its own generated lifetimes (LIFE-003, `lifetimes.md:73-90`;
  `FieldLifetimes`, `Semantic.silk:16191`). Variance is recomputed per use (`Semantic.silk:30130`
  says so). `cleanupFree` walks the whole owned structure (`Semantic.silk:44020`).
- _Options._ (a) No language change: add a `TypeTraits(D)` result to `Header(D)` holding the
  generated lifetime count, variance per parameter, and whether the type needs cleanup or may be
  `Copy`, each computed once from field headers and compared at cutoff. (b) Require every borrowed
  field to name a lifetime parameter of its type, so a type's lifetime arity is written in its
  declaration.
- _Reference change._ (a) none. (b) LIFE-003: an omitted field lifetime becomes an error, with a
  fix-it.
- _Buys._ (a) Cold: one computation per type instead of per use. Incremental: adding a field
  reruns direct users only when a summary changes. (b) Additionally makes a type's arity local, so
  adding a borrowed field to `Inner` no longer changes the arity of every type that embeds it.
- _Safety._ (a) unchanged. (b) only adds written information; the checker proves the same
  relations.
- _Recommendation._ (a) in any case. (b) is Julia's call on ergonomics.

**P6. Operators selected through their operands' conformance buckets.**

- _Today._ Operator discovery collects every operator-eligible interface of every namespace-imported
  module (`collectOperatorInterfaces`, `Semantic.silk:60658`), and each operator use reads all of
  their buckets. Adding an operator interface to an imported module can make unrelated operator
  uses ambiguous.
- _Option._ Resolve an operator only through the conformance buckets of its operand types' owners.
  This is close to the open OP-009 question in #567 ("reject operator declarations without a `Self`
  or provider-owned operand?"): answering it yes makes this possible.
- _Reference change._ OP-009 in `expressions-and-operators.md:689-733`.
- _Buys._ Incremental: operator uses read `ImplSet`, not `Namespace`, of imported modules. Cold:
  removes the per-module interface collection.
- _Safety._ Unchanged.

**P7. Test descriptors without static positions.**

- _Today._ Each test descriptor carries its line and column (TEST-004, `testing.md:100`), so any
  edit that shifts a test changes the catalog and re-specializes the runner's `static for`.
- _Option._ The descriptor carries an opaque location handle that the runner renders at report
  time, or the catalog carries positions in a runtime table outside static values.
- _Reference change._ TEST-004.
- _Buys._ Incremental only: editing a test body reruns that test, not the runner.
- _Safety._ Unchanged.

**P8. Local polymorphic-recursion admission.**

- _Today._ Whether a recursive specialization is admitted depends on the path from the roots
  (GEN-006, `generics-interfaces-and-specialization.md:327`; `Specialization.silk:1320-1360`).
- _Option._ Decide admission per strongly connected component of one declaration's own static call
  graph, from its bodies and headers.
- _Reference change._ GEN-006.
- _Buys._ Instance admission stops depending on how a build reached it. Small in practice.
- _Safety._ Unchanged; this concerns termination of specialization.

**P9. Name `impl` blocks by their head.**

- An unnamed `impl` block's identity is its occurrence among unnamed siblings, so inserting one
  shifts the others (§3.3). Coherent conformance heads are distinct by definition, so the written
  head is a unique, stable name for a conformance `impl`. Inherent `impl` blocks of one owner keep
  an occurrence among same-owner blocks.
- _Reference change._ None; identity is internal.
- _Buys._ Inserting an `impl` stops rerunning the `impl` blocks after it. _Safety._ Unchanged.

Not proposed: restricting module-level `static if` to profile entries. The design already cuts off
a condition at `ValueOf`: a helper body edit reruns the condition, and an unchanged Boolean stops
there. The remaining cost is the duplicated condition-context keys of P1.

### 8.3 The safety model

The hard rule is that compiled programs are memory safe. What matters for incremental compilation
is which inputs a safety proof reads.

**What the reference already gets right.** Public lifetime relationships never depend on bodies
(LIFE-003, `lifetimes.md:107`; VIEW-001, `ownership-and-borrowing.md:1828`), and an `effect fn`'s
environment comes from its header (LIFE-004). A body's proof reads its own body, its callees'
signatures and type properties. That makes the checking unit local, as #1421 assumes.

**What makes checking non-local or expensive today:**

1. _Type properties read transitively:_ `Copy`, `Drop`, variance, generated field lifetimes. P5
   turns them into summaries with cutoff.
2. _Region-sensitive identity:_ a whole-build fact feeding instance identity. P3 removes it.
3. _A second lowering for checking:_ #1421 adds `Mir(Abstract)` for every generic body, with
   symbolic types, bound calls and abstract drops. That is a second MIR per generic body, built on
   every cold build.
4. _Point sets over every MIR location:_ location-sensitive regions solved as bitsets over the
   body's locations. Cost grows with body size times region count, per body. This is local but is
   the main cold cost of checking.

**Simpler sound alternatives for Julia:**

- _S1. Check on the typed body, inside the `Body` unit._ The bootstrap checks typed TIR, not MIR
  (#1421 §1.2). Checking the `TypedBody` inside its own unit adds no unit, no edges and no second
  lowering; the `Body` unit's result becomes "typed and checked". The incremental behavior is the
  same as a separate unit, because nothing downstream reads a borrow answer except the build's
  verdict. The price is that emission MIR and checking read different representations, which #1421
  rejected to keep "one shape". Sound as long as the typed body records every loan, which typing
  already does (`SafetyObligation`, #1421 §1.3).
- _S2. A separate `Borrow(D, s)` unit over MIR, as #1421 proposes,_ keyed by `DeclIndex` and
  selection. Same incremental behavior, more units and one more lowering per generic body.
- _S3. Lexical regions._ Regions end at scope exits instead of last use. Cheaper solving, and
  sound, but it rejects programs the reference accepts today. Not recommended unless S1 or S2
  measure too slow.

**Where #1421 must change under v2:**

- Its `BorrowCheck` key uses today's `{module, declaration, member}` ordinals. It becomes
  `(DeclIndex, selection)`.
- It must read type properties through summaries (P5a), never by walking field types itself.
- Its §9 budget (10% of front end, 0.5 GiB) should be measured with the recorder off, so the
  borrow stage is not charged for bookkeeping that v2 removes.

**Which #1421 questions this answers or reframes:**

- _Q1 (MIR or typed body)._ Reframed. Incremental compilation does not need MIR: both S1 and S2 are
  units keyed by `(DeclIndex, selection)` that read only the body, callee headers and type
  summaries. The choice is about cold cost and one representation, and S1 is cheaper cold.
- _Q8 (re-check region-sensitive instances)._ Answered by P3(a): there are none.
- _§5 "an unchanged answer cuts off downstream re-execution"._ Confirmed, with v2's cutoff table
  (§6.3). Nothing reads a borrow answer except the build verdict and the emitted body's
  `safetyChecked` flag.
- _Q3 (no two-phase borrows) and Q4 (one owner for move rules)._ Unaffected by incremental
  compilation, except that under S1 one stage owns both naturally.

## 9. Budgets and evidence

### 9.1 One-shot builds

**Target: no measurable overhead** against the same compiler with the recorder compiled out.

- **Gate.** For each slice from §10 slice 3 on: one-shot user time within 1% and peak RSS within 1%
  of a build of the same tree whose `Recorder.record` and fingerprint gate are deleted, median of
  three runs each, same machine, same session, identical IR. The 1% threshold sits below the
  single-run noise of §1.3, so three runs are needed; the VM has no hardware counters to replace
  them.
- **Why it can hold.** In a one-shot build the recorder is one predictable branch per child demand
  (15.6 million in §1.2) and no fingerprints are computed. **[assumption]** At under a nanosecond
  per taken branch, that is below 20 ms.
- **Slices 1 and 2 are not gated this way.** They delete work; they report before and after, and
  must show the measured gains of §1.3 or explain the difference.

### 9.2 The first build of an incremental session

**Budget: at most 3% user time and 5% peak RSS over one-shot,** the thresholds #1359's gate used.

The estimate, from the one-round counters of §1.2, takes today's query structure as an upper bound,
since v2 folds sixteen syntactic families into `Header` and records fewer edges than today's direct
dependency list:

| Item                                                       | Count (upper bound)                                               | Cost                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------- |
| edges, 16 bytes each                                       | 2.8 million                                                       | 45 MB                            |
| dependee records and map entries, about 24 bytes each      | at most 0.3 million **[assumption]**                              | 7 MB                             |
| unit graph fields, 12 bytes each                           | 0.11 million                                                      | 1.3 MB                           |
| fingerprints, 32 bytes per declaration plus file hashes    | about 7,700 named declarations **[measured, grep approximation]** | 0.3 MB                           |
| **retained total**                                         |                                                                   | **about 54 MB, 1.1% of 4.73 GB** |
| dedup probe per child demand, about 10 ns **[assumption]** | 15.6 million                                                      | 0.16 s                           |
| edge insertion, about 30 ns **[assumption]**               | 2.8 million                                                       | 0.08 s                           |
| fingerprint hashing at 1 GB/s **[assumption]**             | 7.3 MB of source, at most twice                                   | 0.015 s                          |
| **time total**                                             |                                                                   | **about 0.26 s, 0.14% of 187 s** |

The budget leaves an order of magnitude of headroom over the estimate. The estimate is replaced by
measurement in slice 3.

### 9.3 Updates

**[assumption]** Targets for watch mode on the compiler itself, to be confirmed by slice 7:

- a body edit with an unchanged signature: one `Body`, `Borrow` and `Instance` unit rerun, one
  codegen unit recompiled, front end under 100 ms;
- a signature edit: its callers' `Body` units at most; front end proportional to the callers;
- an edit that changes nothing but trivia: no unit reruns.

### 9.4 Counters

Counted always (integer increments on paths that already run):

| Counter                       | Where    |
| ----------------------------- | -------- |
| demands, memo hits, units run | `demand` |

Counted only in an incremental session:

| Counter                                                    | Where                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| edges recorded, edges deduplicated                         | `Recorder.record`                                                                                 |
| unique dependees, per kind                                 | dependee maps                                                                                     |
| graph bytes: edge array, maps and unit fields, by capacity | computed at report time from capacities                                                           |
| fingerprint bytes hashed                                   | the indexer                                                                                       |
| units marked outdated, marked potentially outdated         | update, step 3                                                                                    |
| units reanalyzed, per kind                                 | update, step 5                                                                                    |
| propagations stopped by equal results, per cutoff point    | update, step 5 (backdated reruns) and step 4 (potentially outdated units cleared without running) |
| codegen units recompiled and reused                        | backend                                                                                           |

`silkc build --stats` prints them on standard error after the build, in a fixed text form a script
can parse. The cold-build gate (§9.1), the first-build budget (§9.2) and the update targets (§9.3)
are each measured with it on the self-build, and every slice PR reports them beside time and RSS,
as #1359 and #1427 did.

## 10. Migration and slices

Each slice is one reviewable PR on `selfhost`, keeps the N1/N2 fixpoint and the corpus green, and
reports user time and peak RSS against its base on one machine. Green-field: each slice deletes
what it supersedes.

**Slice 0, prerequisites.** `ModuleId` ordinals (#1431, then the ordinal table of #1427 step 1),
then `DeclIndex` interning (#1427 step 2). Unit keys hold `DeclIndex` instead of the declaration
ordinal (`Key.declaration`, `Semantic.silk:965`), and answers hold handles instead of ordinals
(`Value.Selected`, `:692`). Also count the stdlib and corpus `impl` heads that P3(a) would reject,
for Julia's decision.

**Slice 1, sources on demand.** A source-provider service answers `SourceIndex` misses. Delete the
discovery loop in `main.silk:470-497`, `ModuleSources.publishObserved` and the attempted-module
list, and the source event log the driver reads. A one-shot build calls `Semantic.revise` never.
**Expected [measured upper bound]:** about 22% of user time (§1.3).

**Slice 2, delete per-answer revision evidence.** Delete `Answer.sources`, `Answer.footprint`,
`Answer.identity`, `Answer.answerId`, `Answer.bodyEvidence`, `SourceFrame`, `mergeEvidence`,
`appendObservation`, `validAnswer`, `BodyDependency`, `BodyCandidate`, `reuseBody`,
`priorCandidate`, `BodyInput`'s text and canonical encodings, `Request.hasDemand` and
`Request.hasDiscovered`, and `SourceRevision.Observation`. Until slice 3, `Semantic.revise`
discards every answer: correct, with no reuse. Body reuse is used today only by tests and by the
discovery loop that slice 1 deletes. Tests that assert reuse counts are deleted here and return as
acceptance cases in slices 4 and 5. **Expected [measured upper bound]:** about 16% of the remaining
user time, 2.4% of RSS (§1.3). This needs Julia's agreement, because it removes incremental reuse
for a few slices (§11, Q1).

**Slice 3, the session and the graph at module granularity.** The `Recorder` with its early return,
unit states and revision stamps, the edge array, dependee maps and free list, and update steps 1 to
5 with one input kind, `SourceFile(M)` by file fingerprint. Measure §9.1 and §9.2. Acceptance: for
every #1359 scenario, a revised store's results equal a fresh store's.

**Slice 4, declaration precision.** `whole` and `prototype` fingerprints, `DeclSource`,
`DeclPrototype`, `Name`, `Namespace`; relative spans and the location table. Acceptance, from
#1359's `InvalidationCases.silk` (on branch `selfhost-per-declaration-invalidation-note`):

- `siblingBodyEditProbe`: a same-width edit of `leaf` starts exactly one `Body` and one MIR
  provider;
- trailing trivia starts no `Body` or MIR provider;
- inserting a distinct declaration keeps the edited declaration's unit key;
- moved declarations (a comment line above them) reuse their bodies, and their locations are
  current;
- `negativeNameClaims`: adding the missing binding invalidates the empty name bucket; a callee
  signature change rejects the caller in warm and fresh stores alike;
- `unchangedByteOffsetsStillObserveChangedLineCoordinates`: line and column changes are visible
  even when byte offsets stay equal, without rerunning the body.

**Slice 5, semantic cutoff.** `HeaderOf`, `ValueOf`, `Realization` and `LayoutOf` comparisons,
backdating, potentially-outdated verification. Acceptance:

- `memberRevisionClaims` (`SemanticSignatureCases.silk` on #1359's branch): exactly 5 `Body` starts;
- `sealedProfileQueriesSelectStaticIf`: an appended unrelated `fn` does not restart a `static if`
  function's `Header` or `Body`;
- a callee body edit that keeps its signature reruns no caller;
- `completeMirEqualityIncludesSafetyRegionsAndReportingOrigins`: MIR equality covers safety regions
  and reporting origins, so cutoff never hides a change in either.

**Slice 6, bucket and profile dependees.** `ImplSet`, `InherentSet`, `ProfileEntry`, plus whichever
of P1, P5(a), P6 and P9 Julia accepts.

**Slice 7, backend reuse.** Codegen units keyed by content subjects, object reuse, linking.

**Slice 8, the session driver.** `silkc build --watch` first, then the LSP entry points.

The `SourceIndexCases.silk` scenarios of #1359 carry over unchanged in meaning: an unchanged file
keeps its parse and index, a changed file drops them, a newly present file replaces its absent
answer. They become cases of slice 3.

Each slice's tests follow the cost rules in `AGENTS.md`: structural assertions on unit start
counts and results in existing case files, no timing assertions, no per-feature native builds.

## 11. Open questions for Julia

1. **Temporary loss of reuse.** May slice 2 delete body reuse and revision validation before the
   graph exists (slices 3 to 5), given that only tests and the discovery loop use them and the
   deletion is worth about 16% of a cold build?
2. **Fingerprint hash.** A 128-bit non-cryptographic word-at-a-time hash (proposed), or BLAKE3
   truncated to 128 bits as Zig uses, for resistance to deliberate collisions at several times the
   cost per byte?
3. **Trivia.** Fingerprints over tokens without comments and whitespace (proposed), so comment
   edits rerun nothing. Do doc comments carry meaning the compiler must track (for example in test
   descriptors)?
4. **Unit granularity.** One `Header` unit per declaration (proposed), accepting that a caller
   reading only member names reruns when a field type changes?
5. **Language proposals.** For each of P1 to P9 in §8.2: accept, reject, or defer. The ranking is
   P1 (profile entries), P2 (failure observation), P3 (lifetime-selective heads), P4 (suspension in
   contracts), P5 (type summaries; explicit field lifetimes), P6 (operators through operand
   buckets, tied to the open OP-009 question), P7 (test positions), P8 (local recursion admission),
   P9 (`impl` identity by head).
6. **Safety model.** Borrow checking on the typed body inside the `Body` unit (S1), or a separate
   unit over checking MIR as #1421 proposes (S2)? Both are incremental units with their own cutoff.
7. **Backend partitioning.** Codegen units by defining module, or by a fixed number of symbol-hash
   buckets? And should the fixpoint gate compare IR per codegen unit?
8. **Session order.** Watch mode before the LSP (proposed)?
9. **Disk caches.** None in v2 (proposed), with object code per codegen unit as the first candidate
   after measurement?
10. **Budgets.** One-shot within 1% of a recorder-free build, first incremental build within 3%
    time and 5% RSS (proposed)?
