# Compiler findings

## Scalar enum equality native call target (fixed)

**Status:** fixed in the bootstrap by [#571](https://github.com/julia-script/silk/pull/571) and
synced into selfhost by [#572](https://github.com/julia-script/silk/pull/572). The failure below
was observed on 2026-09-28 before those fixes.

At selfhost method head `08d5ce8aa2fe12f7760d1ed87ee831d00333fc7c`, the single semantic test root of
that time, `SemanticCases.silk`, defines `bodyRetainsReceiverPass(body, mode)` and calls it from a
`Shared.with` callback. That helper now lives in `SemanticCaseSupport.silk`. The helper compares
`TypedBody.ReceiverPass` scalar-enum values with `value == mode` and `retained == mode`. The
TypeScript bootstrap accepts the source and reaches native emission, then fails with `RangeError:
Backend cannot resolve call target bodyRetainsReceiverPass` in `NativeCallOperation.js:193`. A
previous `Type.equals` scalar-enum comparison produced the same unresolved-target failure (see
`PAPERCUTS.md`, 2026-09-26).

Reproduce the observed failure on that exact head, where the root still exists, with Node 24 and
LLVM 22:

```sh
NODE_OPTIONS=--max-old-space-size=8192 node packages/cli/dist/bin.js test \
  --manifest-path compiler/silk.toml \
  --root src/semantic/SemanticCases.silk --no-cache
```

The [Focused Linux run](https://github.com/julia-script/silk/actions/runs/36417381326)
records the historical failure before any native test executes. A worktree whose generated
`packages/compiler/dist` predates #571 can reproduce it even after merging the fixed source;
rebuild the bootstrap dependencies before interpreting a local native-emission result.

## Instance discovery multiplies call-path contexts for the full parser

**Status:** repaired in bootstrap instance discovery; the full self-hosted parser now checks,
builds, and executes without a discovery workaround.

The full parser's frontend checks successfully when imported by a trivial entry point. Making
`Parser.parse` reachable from the real executable causes bootstrap instance discovery to accumulate
hundreds of thousands of ancestry-sensitive work items. A debugger snapshot recorded 417,124
scanned contexts and 485,588 pending items. CPU sampling located the work in `Instances.discover`,
with substantial time spent shifting the pending array. The check was stopped after several minutes.

The minimal reproduction is a four-function monomorphic diamond: `main` calls `left` and `right`,
and both call `leaf`. The bootstrap reports four instances but five residual-body requests.
An eight-function Fibonacci-shaped graph plus `main` reports nine instances and 42 requests.
The repeated traversal matters far more in the parser's densely connected recursive grammar.

The regression lives in `packages/compiler/test/Instances.test.ts`:

```sh
pnpm --filter @silklang/compiler exec vitest run test/Instances.test.ts
```

The diamond now produces exactly four residual-body requests. The guard no longer records ordinary
monomorphic ancestors that cannot change type arguments. Generic declarations, hidden callable and
Effect identities, and structural-provider evidence still retain their ancestry. Shared contexts
are deduplicated before entering a cursor-based FIFO queue. Tests also cover generic recursion
through a shared monomorphic helper, so body reuse cannot silently erase a required recursion check.

The parser corpus in `scripts/test-parser.mjs` passes all 102 inputs: grammar fixtures, self-hosted
sources, and standard-library sources. It checks native AST structure, flat-tree invariants,
significant-token ownership, and recovery. `compiler/src/main.silk` produces 452 nodes and no syntax
diagnostics. Successful frontend checking alone would not establish these runtime claims.

These findings were encountered while compiling the experiment against bootstrap revision
`03ec67f6` on 2026-09-06 and checked again after rebasing onto `dd4510fa` on 2026-09-07. Each entry
keeps the original evidence and records whether the latest compiler still needs a workaround.

## OWN0020 after several ownership-sensitive suspensions

**Status:** fixed on `main`; the workaround has been removed from `src/main.silk`.

**Tracking:** [JUL-152](https://linear.app/juliaortiz/issue/JUL-152)

Putting the complete CLI flow in one effectful function caused every suspension after the first
combined input operation to fail with:

```text
error[OWN0020] Cannot preserve ownership across suspension: suspendable MIR run has no exact provisional control
```

The rejected function performed these ordinary steps in order:

1. Collect the source argument, working directory, and portable root with `Effect.zip3`.
2. Borrow the working-directory bytes as UTF-8.
3. Create `OsFileSystem` and join the relative argument with `Effect.zip`.
4. Read the file, borrow its `Bytes` into `Lexer`, and print tokens.

The diagnostic appeared on the invalid-UTF-8 branch and then on `Effect.zip`, `FileSystem.readFile`,
and the final token-printing `run`. All owned values had lexical owners and were used or moved in
order, so the diagnostic did not identify an ownership rule the source could act on.

The original workaround split the flow into `workingFileSystem`, `sourcePath`, `readSource`, and
`lexOwned`, with each helper tail-running its final ownership-sensitive suspension. JUL-152 repaired
the lost per-run classification. After rebasing to `dd4510fa`, the experiment again keeps these
operations in one sequential `program` body, and `silk check --manifest-path compiler/silk.toml`
passes.

## Semantic diagnostic cascade after a missing nominal-union field comma

**Status:** reproducible diagnostic-recovery problem; source mistake fixed.

**Tracking:** [JUL-153](https://linear.app/juliaortiz/issue/JUL-153)

Omitting a comma between fields in a nominal-union variant correctly emitted a leading `PAR0001`
(`Expected ','`). The compiler then emitted a large cascade of `SEM0169` invalid-union-construction,
unknown-field, and unreachable-match errors in downstream files that used the union. Those semantic
diagnostics were consequences of the one malformed declaration and obscured the actionable parser
error.

**Workaround:** fix the first parser diagnostic before examining semantic diagnostics. Nominal-union
payload fields use commas even though struct declaration fields do not.

A compiler-side recovery improvement would suppress semantic analysis derived from the invalid
union shape, or retain an explicit error member so downstream construction and match sites do not
fan out into unrelated failures.

## LLVM emission dominates lexer builds and repeat runs miss the default cache

**Status:** the full-parser reload expansion is repaired; cold compilation still has a measurable
cost, and default cross-process cache reuse remains a separate issue.

**Tracking:** [JUL-154](https://linear.app/juliaortiz/issue/JUL-154) covers cold LLVM
construction cost; [JUL-158](https://linear.app/juliaortiz/issue/JUL-158) records the follow-up
cold-compilation research without caching. [JUL-155](https://linear.app/juliaortiz/issue/JUL-155) covers cross-process
cache reuse for project builds.

The full parser exposed a larger construction problem: `NativeStorage.reloadRoots` reloaded every
mutable local in a function at every control-flow join, including locals discarded in earlier
blocks. This multiplied the local count by the join count. Lowering now computes a conservative
reference set for each linear block and reloads only its mutable members. The set includes
selector indices, cleanup owners and initialization flags, and hidden suspension frame payloads;
it is not an assumption that explicit operation operands are the only inputs.

On 2026-09-08, the normal cold command `silk build --manifest-path compiler/silk.toml`, run from the
repository root with the default Node heap and no persistent native cache, improved from 147.83
seconds and 4.57 GB peak RSS to 43.77 seconds and 3.17 GB peak RSS. Both builds emitted 720 symbols.
The baseline included a short inspector CPU sample. The new executable passes the complete parser
corpus, rather than merely completing LLVM construction.

There was also a separate retention issue in the LLVM builder: local-handle weak registries kept a
back-reference to the entire mutable function draft. One escaped value therefore retained all its
sibling handles. Entries now retain only the function owner's identity and local index. A
one-million-instruction probe reduced retained heap from about 1.09 GB to 0.63 GB. This change alone
did **not** materially improve the full build; the block-local reload repair accounts for the main
speedup.

The next cold profile confirmed JUL-158's representation-field lookup lead. Planning, nested
forwarding, and provenance resolution repeatedly flattened every module's structs and unions to
find a single declaration. They now use `DeclarationFacts.byCanonical`, which looks within the
owning module's member index. No new cache or cross-build reuse was added. Existing recursion
guards, substitution, field order, and recovery facts remain in place.

On the same host on 2026-09-08, two fresh-process CPU profiles of `build-exe compiler/src/main.silk`
with `--source-root compiler/src --optimization debug --timings` recorded 51.52 seconds before this
lookup change and 46.57 seconds afterward. Sampled self-time in `RepresentationField` fell from
3.87 seconds to 0.29 seconds. These are single profiled runs with other work active on the host,
not controlled medians or directly comparable to the earlier unprofiled 43.77-second project build.
The two native executables are byte-for-byte identical, and the new one passes all 102 parser
corpus inputs. LLVM backend emission still accounts for about 21 seconds of the profiled build.

The local representation-field probe used 1,500 unrelated declarations and 2,000 planning
queries. Its query loop decreased from 967 ms to 95 ms with an identical result SHA-256; its first
query decreased from 1.59 ms to 0.87 ms. Those loop timings include JIT warmup, so they establish the
local scaling improvement rather than claiming a cold-build speedup by themselves.

Regression assertions live in `packages/compiler/test/Backend.test.ts` and
`packages/llvm/test/FunctionBody.test.ts`; `packages/compiler/test/RepresentationField.test.ts`
also rejects lookup attempts that enumerate unrelated aggregate collections. The performance
probes and their raw results are retained locally, outside this pull request.

The earlier lexer-only measurements below describe the smaller workload that first exposed
construction and cache costs; they are not timings for the full parser.

On the current host, running `silk run -- fixtures/empty.silk` from this directory took 15.9
seconds and reached about 1.6 GB peak resident memory. The compiler realized 314 symbols. Its
reported phases identified LLVM backend emission as the largest phase at 5.8 seconds, followed by
elaboration at 2.2 seconds. CPU sampling divided backend emission into approximately 4.8 seconds
constructing LLVM functions through the in-process builder, 0.2 seconds verifying the module, and
0.8 seconds encoding bitcode. Object emission, runtime compilation, and linking together took less
than 0.5 seconds.

A one-function Silk executable completed in 1.2 seconds and spent 16.8 milliseconds in the backend,
so the cost scales with the realized program rather than Clang startup or a fixed compiler cost.

The default backend-emission cache is process-local when `SILK_NATIVE_CACHE_DIR` is unset. Since
each `silk run` starts a new process, an unchanged project repeats backend emission. Pointing
`SILK_NATIVE_CACHE_DIR` at a persistent directory changed the next unchanged run to a
`backend-cache` hit and reduced wall time from 15.9 to 9.9 seconds. Running the already-built
executable avoids compilation entirely.

## Ancestor-history interning exceeds the V8 map limit for the HIR type lowering

**Status:** repaired in bootstrap instance discovery by projecting each successor history onto its
target's strongly connected component.

The self-hosted side, however, still carries the shape the blowup forced on it: `LowerType.constraints`
lowers both constraint forms inside one function rather than delegating to a per-form helper, and
that shape was never re-measured against the fixed compiler. Two things obscured this. The wave-3
`# Gotchas` block that explained the single-function shape was removed when the compiler fix landed,
and every self-hosted gate up to `b3298425` was run through `pnpm exec silk`, which is a globally
installed shim onto the _main checkout's_ older CLI rather than this worktree's build — so the
"no longer trips" evidence was produced by a compiler that does not contain the fix.

Making both `LowerType.callableContract` and `LowerType.constraints` reachable from the test entry
point aborted instance discovery with `RangeError: Map maximum size exceeded`, thrown from
`AncestorHistory.union` through `Realization.discoverInstances`. The interned `unions` map passed
2^24 entries. Neither function alone reproduced it: with `constraints` unreachable the suite ran
34 tests, and `constraints` reached from its own test entry point while `callableContract` stayed
unreachable also ran clean. The two together crossed the threshold.

The trigger was a size threshold, not one edge. Stubbing `returnType`, `failureRow`, `parameterList`,
or `requirementRow` out of the contract did not help; stubbing `constraints` did. Removing a single
effectful declaration elsewhere (folding `returnType` and `failureRow` into one `soleOperand`) was
enough to get back under the limit, which is what identified this as a scaling wall rather than a
structural cycle. The blowup was static: it did not depend on the source being lowered, only on
which declarations discovery could reach.

This is the same failure mode as the parser entry above, one layer down. There, discovery
accumulated ancestry-sensitive work items; here the ancestry itself interns past what a JavaScript
`Map` can hold. The repair notes that a guard below a call to `T` can only re-consult an ancestor
`V` when `T` also reaches `V`, so every ancestor outside `T`'s component is dead correlation, and
projects it away before it multiplies through generic wrappers such as a test runner's Effect
combinators around many recursive walkers.

Encountered on 2026-09-22 while porting the type, generic, contract, and constraint lowering.

**Re-measured on 2026-09-23** with this worktree's own build
(`node packages/cli/dist/bin.js`, after
`CI=true node scripts/turbo.mjs run build --filter=@silklang/cli --filter=@silklang/compiler`),
which does contain the fix. `LowerType.constraints` was split into the per-form helpers
`membershipConstraint` and `providerConstraint` that the shape naturally wants, with
`callableContract`, `constraints`, and the whole expression, pattern, and statement lowering all
reachable from the test entry point — a strictly larger reachable graph than the one that
originally blew up. The self-hosted code now carries no residue of the workaround, so no
`# Gotchas` block explaining the inlined shape is needed.

**Correction, 2026-09-23.** The sentence "discovery completes" that stood here was wrong.
Discovery does **not** complete from the test entry point at `ea3fbb1a`. Measured by checking out
`ea3fbb1a` into a detached worktree and running `silk test` against it with this worktree's own
build — so none of the later declaration lowering is present — the run aborts after roughly 175
seconds and 4 GB with `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed -
JavaScript heap out of memory`. `silk check` passes at that commit, which is what the original
re-measurement had actually confirmed. See the entry below.

## Ancestor-history interning exhausts the V8 heap for the whole `hir` lowering

**Status:** repaired in bootstrap instance discovery by admitting into the ancestry only a
declaration proved to have more than one instance key. `silk test` and `silk build` both complete
with the whole `compiler/src/hir` lowering reachable.

`silk test` aborts in instance discovery, in `AncestorHistory` interning reached through
`Realization.discoverInstances`. It is the same failure mode as the wave-3 entry above, further
out, and it survives the `2d4e1c6d` SCC-projection repair: that fix removes dead ancestor
correlation, but the surviving correlation still grows past what the process can hold once the
whole lowering is reachable from one root. Two surfaces of the same wall have been observed:

- **`Lower.lower` reachable from `main.program`** — the existing `silk-compiler <file>` path, which
  also reaches the lexer, the parser, and `SyntaxTree.write` — aborts with `RangeError: Map maximum
size exceeded` from `AncestorHistory.intern`. Raising `--max-old-space-size` to 12 GB does not
  help, because that surface is the `Map` entry cap rather than the heap.
- **`Lower.lower` reachable from the test entry point** — aborts with `FATAL ERROR: CALL_AND_RETRY_
LAST Allocation failed - JavaScript heap out of memory` through `Builtins_MapPrototypeSet` and
  `Runtime_MapGrow`, after roughly 125 seconds and 3.7 GB.

**The declaration lowering did not introduce this.** Checking `ea3fbb1a` out into a detached
worktree and running `silk test` against it with this worktree's own build reproduces the heap
exhaustion with none of the declaration lowering present: roughly 175 seconds, 4 GB, `Ineffective
mark-compacts near heap limit`. The wave-4 entry above has been corrected accordingly.

The practical consequence is that `compiler/src/hir` has outgrown what the bootstrap's instance
discovery can realize in one program, and that `silk check` is currently the only self-hosted gate
that runs to completion. The next step is a bootstrap-side repair in `packages/compiler`, not a
further reshaping of the self-hosted source: the wave-3 experience already showed that moving
declarations around only shifts the threshold.

Encountered on 2026-09-23 while porting the declaration lowering and assembling the module.

**Repaired on 2026-09-23.** The multiplier was the ancestry's exactness over declarations that
could never be told apart. Instrumenting the run recorded only 1,720 distinct ancestor values
spread over 459 declarations — fewer than four each — while the interned decision tree passed
7,000,000 nodes before the heap gave out. The nodes were not values but correlations between them.

`needsAncestor` already dropped a declaration whose arguments _cannot_ vary, which is a fact about
its signature. Whether they _do_ vary is a fact about the program, and the `hir` walkers are the
case that separates the two: every one of them is an `effect fn`, so each carries a hidden Effect
identity and is retained, yet almost all are monomorphic and realize at exactly one instance key.
An ancestor of such a declaration is equal to every target of it, so `sameArguments` admits every
guard below it and its correlation with the rest of the history decides nothing. The projection
added by `2d4e1c6d` could not remove it either, because the whole lowering is one strongly
connected component that projects onto itself.

Discovery now records a declaration in the ancestry only after a second instance key proves it
discriminating, and restarts — the mechanism the component-growth restart already used — so the
histories built without it are rebuilt with it. The round is abandoned the moment a declaration
becomes discriminating, so an unbounded specialization cannot expand past the guard that is about
to be reinstated. Restarts are bounded because the discriminating set only grows.

Measured on this worktree's own build (`node packages/cli/dist/bin.js`) against `01d10be3`:

| Gate                                       | Before                                  | After                         |
| ------------------------------------------ | --------------------------------------- | ----------------------------- |
| `test --manifest-path compiler/silk.toml`  | heap OOM, 4.5 GB, 121 s, no test run    | 60 discovered, 4.5 GB, 99 s   |
| `build --manifest-path compiler/silk.toml` | `RangeError: Map maximum size exceeded` | ok, 901 symbols, 3.1 GB, 32 s |

The regression is `packages/compiler/test/Instances.test.ts`, "bounds ancestry for one mutually
recursive lowering cycle across modules": twenty-four monomorphic `effect fn` walkers threading one
`&mut State` and requiring `&mut Allocator` over five modules, forming one component with a second
cycle reachable from it. It interned 567 decision nodes before the repair and interns none after,
while discovering the same instances and reporting no violation.

Four `hir/LoweringCases` cases fail on the repaired compiler — `aBroadModuleSatisfiesEveryFlat
Invariant`, `builtModuleRenders`, `moduleDocumentationIsInterned`, and
`unionVariantsRecordTheirFieldBlock`. They are self-hosted golden mismatches in the lowering port,
not discovery defects; they are simply the first cases that were ever able to run.

## Empty union variant field block rejected by the bootstrap parser

**Status:** repaired in the bootstrap parser; the self-hosted parser diverged first and the two are
aligned again as of this commit.

`pub union U { Empty {} }` emitted `PAR0001` and produced a `UnionVariant` carrying a synthesized
`UnionVariantField` over a `TypePath` that was never written. `Parser/Declaration.ts` inverted the
field-block branch: on seeing `RightBrace` immediately after the variant's `LeftBrace` it parsed a
field anyway, instead of closing the block with no fields. Only the empty-brace case differed;
every other variant shape parsed identically.

A variant that writes braces and declares nothing is well-formed and distinct from a unit variant.
`AuthoredHir.Variant.braces` already records that the braces were written, so an empty block lowers
as `braces: true` with zero fields and needs no diagnostic to stay distinguishable.

The self-hosted parser deleted the equivalent arm first, in `compiler/src/parser/Declaration.silk`
(`cb445b9f`), which left the bootstrap as the only parser still carrying the defect. This commit
deletes the branch in `Parser/Declaration.ts`; the surrounding field loop already terminates on
`RightBrace`, so the whole arm was redundant as well as wrong.

The regression lives in `packages/compiler/test/Parser.test.ts`, "parses an empty union variant
field block as a braced variant with no fields". The neighbouring damaged-union case previously
asserted the synthesized field as intended recovery and now asserts `Empty {}` parses clean.

## Cleanup-subterm search exceeds the V8 map limit through a borrowed `Semantic` (fixed)

**Status:** repaired in the bootstrap on `main` by
[#675](https://github.com/julia-script/silk/pull/675) (`cf53040d`). The fix reaches selfhost
through the next main→selfhost sync. No limit was raised.

At selfhost head `d4c8f98059e504acc8e54a6830158255352b22bf` (#671), building
`compiler/silk.toml` fails during `Realization.discoverInstances` with
`RangeError: Map maximum size exceeded` at `strictCleanupSubtermUnder`
(`packages/compiler/dist/Instances.js`), before any test runs
([Focused Linux run](https://github.com/julia-script/silk/actions/runs/36984616674)).
The source is valid; the previous head `cb31280d` builds.

The trigger was `struct ClosureDraft<'a> { semantic: &'a mut Semantic, ... }` used as an
`Effect.useReleaseNonParking` resource. `nominalsIn` collects nominals with `Type.visit`, which
descends through reference types, so a cleanup root holding `&mut Semantic` reaches the whole
`Semantic` graph together with the closure draft's own nominals. Its reaching set exceeds the
512-type budget, and the path-keyed unfolding memo of one question then grows past V8's map
size. Even on `cb31280d`, the `Query.Entry ⊂ Semantic` question already holds about 1.2 million
memo entries.

Selfhost `c871c5ea` removed the borrowed field from the draft: the draft owns only its vectors,
and `Semantic` reaches the walk separately.

The overflow itself was in the memo key. Stopping the search at reference types was rejected: the
cleanup subterm also feeds the hook-recursion measure (`cleanupTransition`,
`cleanupPermitsSpecialization`). That measure is a termination argument over finite type
structure, so reference descent is sound and cutting it would reject valid programs.

#675 instead keys the per-question memo by `whole` and only the unfolding entries for declarations
reachable below it. The reachable set is the closure of template field types over the nominals the
type contains. The search reads and extends the unfolding only at those declarations, so no answer
changes.

- **Regression:** `Instances.test.ts`, "shares cleanup subterm answers across unfoldings of
  unreachable declarations". Without the fix it overflows the same `Map.set` in
  `strictCleanupSubtermUnder` after 128 s
  ([run 37004791353](https://github.com/julia-script/silk/actions/runs/37004791353)). With it the
  test passes in 2.5 s ([run 37008205332](https://github.com/julia-script/silk/actions/runs/37008205332)).
- **Original tree:** `d4c8f980` with `cf53040d` merged builds past instance discovery with no
  RangeError ([run 37009575278](https://github.com/julia-script/silk/actions/runs/37009575278),
  throwaway #680).
