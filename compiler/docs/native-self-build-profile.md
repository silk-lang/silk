# Native self-build profile and an identity interning plan

**Status:** measurement only, for workstream 4. No compiler code changed. Measured on `selfhost`
`15ea670`.

## Setup

- Host: Linux x86_64 container, 4 vCPU, 15 GiB RAM. `perf` 6.8, `cpu-clock` sampling at 499 Hz.
- Workload: the compiler emitting its own LLVM IR,
  `silk-compiler build compiler/src/main.silk -o out.ll --emit llvm-ir --stdlib …`. That is the
  frontend, MIR and IR generation of a self-build, without the clang step.
- Readable profile: N0 is built by the TypeScript bootstrap (`NativeSeed.mjs build`) and keeps
  readable symbol names. The natively built compiler names every function by a content hash
  (`InstanceKey.contentName`), so its symbols cannot be mapped back.
- Call chains: neither compiler emits frame pointers or unwind tables, so `perf -g` and
  `--call-graph dwarf` both produce flat profiles. For the inclusive numbers I captured the
  bootstrap's IR for N0, added `"frame-pointer"="all"` to every definition, and compiled it with
  the bootstrap's own flags (`-O2 -g`). This binary is called N0fp below.
- Validity check: N0, N0fp and a native N1 emitted byte-identical 77 MB IR.

## Time and memory

| Binary                | IR emission wall | Peak RSS |
| --------------------- | ---------------- | -------- |
| N0 (bootstrap-built)  | 272 s            | 5.12 GB  |
| N0fp (frame pointers) | 278 s            | 5.12 GB  |
| N1 (natively built)   | 273 s            | 4.71 GB  |

`clang -O2` on the 77 MB compiler IR takes 88 s on the same host. The frontend is therefore about
three quarters of a native compiler build. In CI, the N1 build step takes 4m48s.

## Hotspots

Self time is for N0, summed over all instantiations of each function. 5.3% of the samples have
no symbol.

| Self                      | Function                                        |
| ------------------------- | ----------------------------------------------- |
| 9.6%                      | `Type.nodeProjection`                           |
| 7.4%                      | `ModuleId.equals`                               |
| 4.2%                      | `Type.runtimeEqualsShared`                      |
| 3.5%                      | `InternIndex.first`                             |
| 3.1%                      | `Bytes.zeroed`                                  |
| 2.9% / 2.0% / 1.7% / 0.9% | `malloc` / `_int_free` / `free` / `_int_malloc` |
| 2.5%                      | `DeclarationId.project`                         |
| 2.4%                      | `Type.sameUnder`                                |
| 2.3%                      | `Semantic.phaseOnlyWithin`                      |
| 2.3%                      | `sha2.compress32`                               |
| 1.9%                      | `Type.projectedBytes`                           |
| 1.6%                      | `ModuleId.fromParts`                            |
| 1.5%                      | `Specialization.copyApplicationDeclaration`     |
| 1.3%                      | `InstanceKey.runtimeHash`                       |
| 1.2%                      | `Type.sameHead`                                 |

Inclusive time is for N0fp; percentages overlap.

| Inclusive | Function                            | Main callers / notes                                                                                                 |
| --------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 82%       | `Semantic.demandRaw` (query engine) |                                                                                                                      |
| 50%       | `Semantic.lowerMir`                 |                                                                                                                      |
| 27%       | `Semantic.resolveBody`              | type checking of bodies                                                                                              |
| 21.8%     | `Type.nodeCopy`                     |                                                                                                                      |
| 20.5%     | `Type.copyNodeDeclaration`          | almost all of `nodeCopy`                                                                                             |
| 18.0%     | `Type.encoding`                     | content keys; `InstanceKey.encodingAt` 12.7%, `Application.encoding` 6.8%                                            |
| 14.9%     | `Type.projectedBytes`               |                                                                                                                      |
| 12.2%     | `Type.runtimeEqualsShared`          | 4.5% from `resolveEmissionInputs`                                                                                    |
| 7.3%      | `Type.sameUnder`                    |                                                                                                                      |
| 7.4%      | `ModuleId.equals`                   | `Observation.matches` 2.9%, `SourceIndex.presentNameSelection` 1.1%, `Type.sameHead` 0.9%, `SourceIndex.keyFor` 0.7% |
| 3.5%      | `InternIndex.first`                 | `internKey` 0.7%, `footprintIn` 0.7%, `Observation.matches` 0.6%                                                     |

### What the clusters are

1. **Copying a `DeclarationId` out of a `Shared<Type>`: about 22%.** `copyNodeDeclaration` cannot
   allocate while it borrows the shared type, so `projectedBytes` reads one byte per call. Each
   call enters `Shared.with`, then `nodeProjection`, then `DeclarationId.project`, and for an
   owner name `stepAt` decodes the LEB128 owner chain from its start. One copy therefore costs
   O(bytes × owner steps). The module's origin, package and path are three of the four copied
   sections. 5.5 points of this sits under `Type.encoding`, which copies a declaration only to
   serialize it. `copyApplicationDeclaration` (1.5%) and `ModuleId.fromParts` (1.6%) follow the
   same pattern.
2. **Content encoding: about 18%.** Instance keys and type identities are re-serialized into byte
   strings and hashed (`sha2` 2.3%, `runtimeHash` 1.3%) each time a key is built.
3. **Structural type equality: about 12% to 15%.** `runtimeEqualsShared`, `sameUnder` and
   `sameHead` walk both trees and compare declarations by bytes.
4. **Module identity comparison: 7.4%.** `ModuleId.equals` checks the cached hash first. In the
   common equal case it then compares origin, package and path byte by byte, mostly to confirm a
   hash hit in source observation and name lookup.
5. **Allocation: about 8% self**, plus `Vector.grow` (1.6%) and `Bytes.copy` (1.6%). Most of it
   is the identity and encoding copies above.

## Ranked interning plan

Each step is measured on its own with this method before the next one starts. The savings are
upper bounds from the inclusive numbers above, not predictions.

1. **`ModuleId` to a module ordinal.** The resolver already holds the table (`resolver.modules`,
   `moduleLookup`, `knownModuleOrdinal`). Make that table the session-wide interner. `DeclarationId`,
   `Observation`, `SourceIndex` keys and `Resolver` keys store a `u32` ordinal, and equality becomes
   an integer compare. This step addresses cluster 4 (7.4%), the `InternIndex` probes that confirm
   module hits, and the three module sections of every declaration copy in cluster 1. It is the
   smallest change, touches no type representation, and is a prerequisite for step 2. Call sites:
   102 `ModuleId.equals` and 205 `ModuleId.copy`.
2. **`DeclarationId` to a declaration ordinal, with cached canonical bytes.** Use a hash-consed
   table keyed by module ordinal plus owner-chain bytes. For authored declarations, the key can be
   the module ordinal plus the `ModuleIndex.ordinalOf` position. Each table entry keeps the
   canonical encoded bytes once. `Type.Nominal`, `Type.Parameter`, `Application.bodyDeclaration`
   and the `InstanceKey` owners carry the ordinal. Copying becomes a `u32` copy, which removes
   cluster 1 (about 22%). `Type.encoding` appends the cached bytes, which removes the identity part
   of cluster 2. Emitted names and encodings keep using the canonical bytes, never the ordinal, so
   output stays independent of interning order and the fixpoint stays meaningful. Synthetic
   identities from `DeclarationId.inference` are never published, interned or cached, so they stay
   local values. This is the largest step: 777 `Shared<DeclarationId>` uses, 460
   `DeclarationId.copy`, and 190 `DeclarationId.equals`. It also overlaps #1359, so it should
   start after #1359 lands.
3. **Type heads.** Once steps 1 and 2 are in, give each type node a precomputed head made of kind,
   declaration ordinal, arity and a structural hash. `runtimeEqualsShared`, `sameUnder` and
   `sameHead` then reject on the head and walk only on equal heads. This addresses cluster 3
   (12% to 15%). Hash-consing whole `Type` nodes would make equality a pointer compare. Whether
   that is worth it should be decided from the profile after step 2.
4. **Memoized encodings.** Whatever remains of cluster 2 after step 2 can cache `Type.encoding` per
   shared node, keyed by node identity.

A smaller change could precede step 1: let `copyNodeDeclaration` copy each section in one bulk
fill, as `fillNodeText` does for text, instead of byte by byte. It would recover much of cluster 1
without new identity types. It is listed here for comparison only and is not part of this
measurement task.
