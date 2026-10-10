# Self-hosted Silk frontend

This directory contains the self-hosted lexer, parser, HIR lowering, semantic queries, and the
first demanded ordinary-body checks.
The inspection modes read one Silk file and print its flat AST and syntax diagnostics, or its
lowered module and declaration fingerprints in `hir` mode. The `build` mode demands semantic facts,
MIR, scalar/address/aggregate Layout, and LLVM emission for a limited closed-body subset. Shared and mutable
scalar references, dereference reads and stores, and receiver auto-borrows are supported. A borrow,
auto-borrowed receiver or `match &` subject that names no existing storage (a call result, a
literal, or a field of one) addresses a compiler temporary holding the evaluated value; that hidden
owner follows the owned-rvalue temporary rules below, and a mutable loan of it needs no named
mutable owner (BORROW-006). A borrowing binding, including a destructuring `let P = &e`, keeps its
initializer's temporaries until its scope exits. A `match &mut`, `match place` or `let P = &mut e`
subject must name an existing place (`InvalidMatchScrutineePlace`, the bootstrap's `OWN0009`).
Raw-pointer dereference requires an explicit lexical `unsafe` boundary, including inside an
`unsafe fn`.
Record construction and field places retain written operand order and declaration-order byte offsets.
Internal aggregate calls copy parameters into callee storage and return through a caller-provided
destination. Named tuple construction and ordinal places share record storage. Fixed arrays retain
one element layout, stride and logical length; indexing checks the logical bound before access or
an indexed assignment's replacement expression, including for empty and zero-size storage.
Scalar enums take their representation's layout and keep nominal identity; members, `Enum.value`,
equality, and member or `_` match arms with guards lower to MIR switches.
`match move` of a scalar enum records its consuming place without introducing cleanup. Extracting
an enum field through a Drop-hooked ancestor remains rejected even though the enum is Copy.
Unions of records store an unsigned tag (canonical member order) before the largest member; a generic
body may inject into and match a union of generic record applications such as `Empty<T> | Full<T>`, and each closed
instance maps the authored member to its canonical tag. Nominal `union` declarations tag variants
in declaration order and lay each variant out like a record.
Record, structural-union and nominal-union matches bind fields as places and switch on the tag.
A tuple or `.{ ... }` literal constructs its immediately expected named tuple or struct; otherwise
it creates an occurrence-nominal anonymous aggregate laid out as an ordinary record of its members.
Generic records and nominal unions retain complete type applications through construction,
projection and patterns. Layout, Copy classification, drop glue and inherent call instances are
computed under those applications; standard-library Option and Result use the same ordinary path
as user declarations. Runtime text (`string<'static>`) and byte-string (`&'static [u8]`) literals
store their decoded bytes in a private constant and build the same address-and-byte-length
descriptor as a slice. Slice subranges and unions with string or f64 members remain follow-up work.
Runtime string `==` and `!=` compare byte lengths and then exact UTF-8 bytes with a bounded MIR
loop. Both operands are evaluated once, left to right; empty views and unequal lengths require no
backing-byte reads. Comparison does not allocate, normalize text, or compare descriptor identity.
Native source elaboration includes finite static-for expansion over genuine phase-only sealed
`Intrinsic.StaticSequence` values with homogeneous scalar elements. Each evaluated element owns
separate static-selection facts and ordinary local/node ranges; the emitted blocks follow element
order. Empty sequences skip body elaboration. Reflected collections, nested loops, generated
closures/Effects, control transfers and newly generated loans retain authored Unsupported refusals.
This source implementation is under focused validation; it does not claim SHA2 or N1 completion.
Semantic instances keep `'static` and region-sharing evidence but number caller-local regions by
first appearance, so call sites that lend different locals share one instance; each semantic
instance is validated separately. Complete selected MIR recipes
and their ordered call/drop graph determine emitted identities after finite reachability closes.
Equivalent recipes share code; different direct or transitive cleanup receives distinct symbols,
while physically equivalent types still share layouts. This is target-neutral and handles recursive
instances without encoding discovery ordinals or LLVM text. The build answer retains its emission
plan for structural inspection alongside the emitted module.
Finite-specialization certificates prove that the lowered reachable-key graph closes; they do not
certify LLVM executability. Callable continuation families distinguish the finite sets of original
executable declarations retained in each original binder slot, including selected sections and
their captures. An opaque representation retains its authenticated original executable producer
and its selected free type evidence in those families; this does not unfold its public contract
or enumerate every returned runner. Capture depth and generated region identities do not create new
families;
incomplete representation evidence retains the conservative same-body guard. Re-entering a
generic function within one family with different type arguments is
`ExpandingSpecialization` unless the arguments descend structurally or along a witness call, or
the re-entry runs inside a Drop hook's cleanup and every type argument stays within the owned
structure of the value whose cleanup selected the hook (GEN-006): `Vector<Bytes>` cleanup reaches
`Vector<u8>` through `Bytes`, while a hook that drops a larger value of its own type still grows.
MIR, layouts and foreign signatures are validated before closure planning, while backend-only
emission restrictions remain loud gaps on the completed build.
Typing records the owned place each consuming site transfers: `move`, `drop`, `match move` and a
by-value receiver of an affine place. The place is a local or match subject plus static field,
element and union steps; an owned rvalue records none. A runtime index, a reference boundary or a
projection out of an owned rvalue is rejected as the bootstrap's `OWN0002` (`ExtractionBoundary`),
moving a whole non-Copy referent or a slice element as `OWN0012` (`BorrowedExtraction`), and moving
a binding of `match &` or `match &mut` out of its arm as `OWN0006` (`MatchBorrowEscape`). `move` of
any `match place` binding, and `drop` of a non-Copy one, is `Unsupported`. Semantic analysis decides which locals and values need cleanup: those
whose owned structure carries `impl Drop`, found through the implementation query. `drop` of any
other value emits nothing; a drop that needs cleanup calls the drop glue of the value's type. Glue is
its own instance keyed by the type: it calls the `impl Drop` hook, then drops the children that
need cleanup, fields in declaration order, array elements in ascending order and only the active
union member or variant. Exact callable environments use the same capture-ordered record glue. Effect environments and
unions without a canonical member order still report the `cleanup` gap. MIR lowering keeps a cleanup
stack: bindings and by-value parameters that need cleanup are owners of their scope, consuming sites
mark them moved, and fallthrough, `return`, `break` and `continue` drop every scope they leave,
innermost first and in reverse acquisition order. Replacement drops the displaced value first.
Where paths reach a join with different ownership, canonical projected cleanup components get
independent `DropFlag` locals written on each actual incoming edge; elsewhere no flag exists. An owner that may be moved when a loop starts is
tracked by its flag across iterations, and once a flag exists every state change writes it. Owned
rvalues used only as places are dropped at the end of their full expression unless a borrowing
`let` keeps them; one created by a short-circuit operand, a match arm or a guard ends with that
path. Once a consuming match selects an arm, each by-value binding that needs cleanup owns its
part of the evaluated subject (MATCH-002); typing lists every arm's binding declarations, so an
unused binding is an owner too. `drop`, `move` or `match move` of a binding, a partial move out of
one and moves that differ per arm or per path then use the ordinary owner states and drop flags.
The bindings of a destructuring `let` belong to the enclosing block; those of a `match` or `if let`
arm end with the arm, innermost first. The subject drops only what no binding took, such as fields
omitted with `..`: a `match` arm drops it when the arm ends, while `if let` and `let` drop it, or
the whole unmatched `if let` subject, once a path is selected and before it runs (PATT-008). A
static partial move marks the authenticated component moved: cleanup visits the remaining children
in their canonical order. Joins normalize the incoming component partitions, including opposite
authored move orders, and retain each child's independent liveness. Replacing a component drops
its initialized old value before the store, then restores precisely that component; siblings keep
their state. A move beneath a type with a Drop hook is rejected as `OWN0002`. A write at a runtime
index beside a moved element, a guard that changes an owner's state or
consumes a binding of its arm (the bootstrap rejects such moves as OWN0008, which selfhost does not
report yet), a loop iteration that leaves an owner changed and a borrowing match result whose arm
created temporaries still report the `cleanup` gap.
Anonymous-environment availability preserves unchanged loop headers even when a pre-loop branch
may have moved a field. It compares active roots, may/must holes, indexed uncertainty and guard
state after each repeating edge; the missing field remains unavailable. Conditions are checked
against the pre-condition header, and only normal/continue arrivals repeat.
Runtime-index writes to fully initialized owned arrays preserve that availability. If the
assignment's target root has a may-hole, including one created by the RHS, its indexed uncertainty
remains explicit. The array-write/capture and exact RHS-transfer controls passed with the retained
loop/guard controls (four focused tests, 54 ms; maximum 30 ms). Integrated corpus and N1 advancement
remain unproved.
Effect fn bodies are typed against their declared success, failure and requirement channels.
Calling an `effect fn` builds an exact Effect whose representation is the call's application and
written arguments; `run f(a)` of such a construction is a direct call of `f`'s instance (Effect
calling convention D1). `run` must leave no failure outside the enclosing failure type
(`UnhandledFailure`, bootstrap SEM0066) and no requirement outside its row (`UnhandledRequirement`,
SEM0071), so an ordinary `fn` runs only closed Effects. `fail value` checks the value against the
enclosing failure type (`FailOutsideEffect` SEM0063, `UndeclaredFailure` SEM0064). A function whose
failure type is not `never` returns an `i1` status and writes success and failure to two
caller-owned out-addresses after its parameters (D3); MIR gives it a `Failure` local, a `Fail`
terminator and a `FailureEdge` on each fallible call, whose block widens the callee's failure into
`Failure`, drops every scope it leaves and fails (D7). A stored Effect value runs through its
exact representation's runner, as a callable with no new arguments: a construction's stored
arguments move (once) or copy into the target's parameters. A parameter of Effect contract type
gets an implicit representation binder like a callable parameter, so a generic runner is
specialized to its argument's exact Effect. A named non-generic function used as a value is a
capture-free exact callable; invoking it is a direct call, and running an invoked `effect fn` value
calls the instance. `Intrinsic.catchFailure<S>` builds an exact composite Effect; its run expands in
place (D4): the protected Effect fails into a temporary, a switch sends members of `S` to the
handler and injects the rest into the residual failure. `finalizeEffect`, its NonParking variant
and `useReleaseNonParking` expand the same way: both exits of the protected run (or of `use`, lent
the owned resource) run the `() ! never` finalizer (or `release`, which drops the resource), and a
held failure is raised afterwards. `Intrinsic.NonParking` bounds hold until the suspension stage,
since reaching parking is itself the `suspension` gap (D6). An `effect {}` block or anonymous
`effect fn` is an exact representation like an anonymous closure: its environment holds its
captures, and running it (or an invoked anonymous `effect fn`) calls its own instance with the
environment as parameter 0. A block derives its success, failure and requirement row from its
`return`, `fail` and `run` sites (EFF-002, EFF-011); sites that differ from that join are checked
again against it. Distinct exact Effects from `match` arms or from a body's returns under a
declared `Effect<...>` result join (EFF-013): one alternative is stored as itself, several as their
structural union, and `run` switches on the tag to each alternative's runner. A declared
`Effect<...>` result is a producer-owned family realized from those returns, like an opaque result.
An instance receives one hidden provider address per entry of its requirement row, in canonical
service-role key order (D2), and its key names each provider's type. Running
`Intrinsic.bindRequirement*<S>` serves `S` from the stored provider to the inner run only; running
`Svc.op(args)` calls the witness for the serving provider's type with the provider address as its
receiver. Program entry is the selected runtime's C export (ENTRY-001): `silk/native_start` runs a `pub effect fn main` through its
`EntryResult` adapters.
Catalog `Intrinsic` type families outside the storage core, such as `Intrinsic.Execution`, report
`core-type`.

The storage core follows the bootstrap. `Allocation`, `RawBuffer<T>` and `Slot<'storage, T>` are
reserved in type position, and `Intrinsic.SharedCore<T>` and `Intrinsic.StorageFailure` are sealed
families; `semantic.SealedCore` owns their identities and record storage. An allocation is six
target words (aligned base, requested bytes and alignment, reclaim tag, `malloc` context, active
marker), a raw buffer is its allocation and element count, a slot is one element address, and a
shared core addresses a local, non-atomic control block holding the strong count, the access
state, its own allocation and the value. The storage primitives the standard library calls
(`semantic.StorageOperation`) are typed from their written type arguments and expand to ordinary
MIR: layout validation, bounds checks and count exhaustion trap, `run
Intrinsic.systemAllocationAcquire(layout)` calls the sealed C `malloc` and fails with
`StorageFailure` on a refused request, raw-buffer copies and fills call `memmove` and `memset`, and
`Intrinsic.replace(place, value)` moves the displaced value out of a mutable place. Allocation glue
calls `free` on its context, a raw buffer drops only its allocation, and shared-core glue counts
references and drops the value and allocation with the last handle. Raw-buffer and slot contents
stay owned by library code. `layoutOf`, `sharedLayout` and `systemAllocationAcquire` exchange the
standard library's `silk/layout` `Layout` record, as the bootstrap's contracts name it.
Borrow checking remains step 14: successful builds print one `SILK_GAP borrow-check` summary when
reached bodies retain safety obligations. The TypeScript bootstrap compiler still builds it.
Typing therefore admits covariant region subtyping without the borrow checker. At an expected
value (a return, an annotated binding, a field) a reference, slice or `string` region, a shared
referent, an array element and a covariant nominal lifetime argument may differ: a `'static`
region shortens to any region, and a lifetime of the declaration enclosing a body outlives every
loan rooted in that body, both of which are proven. A caller-local region (a loan rooted in the body)
meeting another region that typing cannot relate, such as a declared lifetime, another
caller-local region, or a region an earlier call operand fixed for the same binder (including a
`'static` Effect environment), is admitted at the expected region, and the body retains a
`RegionRelation` safety obligation naming its origin and both regions for step 14. A binder an
earlier operand fixed to `'static` likewise relates a later loan of a declared lifetime, since
inferred `'static` evidence never requires `'static`. The relations
a call's operands retain are premises (offered outlives wanted) of that call's own bound proofs,
such as a provision section's `once Effect<'env; ...>` representation bound. A fixed
`'static` expectation of a shorter region, a declared region widened to another, and any owner,
access, element, pointee or type-argument difference stay type errors.

Build invocation: `silkc build <source> -o <output> --emit <executable|llvm-ir> --stdlib <directory>
--optimization <none|speed> --debug <true|false>`.
The output defaults to an executable. `--emit llvm-ir` writes the exact completed backend module
bytes to the requested file, returns success without invoking Clang, and creates no intermediate
executable or temporary IR file. Invalid or repeated output selectors fail before source loading.
With a prebuilt native compiler and Clang, `node compiler/scripts/test-native-build.ts
<native-compiler> <clang>` checks this CLI route, exact IR bytes, default linking and cleanup together.
Optimization defaults to `speed` and debug to `false`. These explicit logical choices are validated
and published as the content-keyed profile input before source loading; the native corpus runner
builds and runs every declared profile variant. Clang receives `-O0` or `-O2` and optional `-g`. The standard-library
root contains `silk/`; it is an explicit CLI input. A package without a `[build].composition`
takes its runtime from the library's `compositions.json` for the target and libc, so such a build
needs the library root even without standard-library imports; no listed runtime is a refusal. The nearest `silk.toml` selects `[package].root`, whose containing directory
is the root for local module paths. Without a manifest, the entry file's directory is the module
root. Paths must be normalized; absolute CLI paths and paths relative to the working directory are
accepted.

### One native generation and its smoke receipt

`NativeBuild.ts` accepts an explicit immutable native seed **N0** and the authored compiler/stdlib
snapshot exported by `SourceSnapshot.mjs`. It invokes N0 once to build **N1**, then uses only that
new executable to compile and run the shared `trivial-features` program. N0 must be a regular
executable with no write permission bits; a restored seed has mode `0555`. The output directory
must not exist and must be separate from the inputs. Existing outputs, symbolic links and a hard
link from N1 to N0 are rejected. Equal binary hashes are allowed: path freshness and the recorded
invocations establish the generations without assuming their bytes differ.

With Node 24, workspace dependencies installed, LLVM available, and GNU time installed on Linux:

```sh
node compiler/scripts/NativeBuild.ts \
  --seed /absolute/immutable/N0 \
  --snapshot /absolute/authored-snapshot \
  --output /absolute/fresh-native-run
```

`--optimization none|speed` and `--debug` select the explicit native profile (defaults: speed,
false). The native CLI chooses its host target; the receipt records the Linux host target triple.
`--time-command /path/to/time` selects GNU time, whose absence or malformed measurement fails the
run. Peak RSS is GNU time `%M` / Linux `ru_maxrss`, in KiB: the maximum resident set size of the
command and its waited children, not summed concurrent memory. Wall time measures each invocation
including the measurement wrapper. A contract-test measurement command supplies fixture values;
these are not real compiler measurements.

`build-receipt.json` retains N0/N1 SHA-256 hashes, the exact validated source and stdlib file hashes
and normalized digests, source commit and archive digest, target/profile, commands, working
directories, exits/signals, stdout/stderr, wall time and RSS for every attempted stage. Snapshot
and seed hashes are checked before and after each stage. The smoke source is frozen before the
native build from the existing plain `trivialFeatures` corpus template; the receipt records both
that source's hash and the supplying corpus file's hash. `--corpus-source` can select an explicit
copy of that corpus source file. Smoke success requires exit 42 and empty stdout.

Build refusal, missing output, signals, failed smoke
compilation, and wrong exit/stdout retain a failed receipt and a nonzero driver exit. No fallback
compiler, source repair, second build attempt or earlier output is used. The driver and its
injected-producer contracts establish the receipt boundary; they do not claim a successful real
self-build. Run the focused contracts with
`pnpm exec vitest run --config compiler/scripts/vitest.config.mjs compiler/scripts/NativeBuild.test.mjs`.

`silkc format [paths] [--check]` formats source without semantic analysis or code generation.
The nearest `silk.toml` above the working directory supplies `[package].root`; its containing
directory is the source root. With no paths the command recursively selects that root. Explicit
files and directories are resolved against the working directory, must stay inside the source
root, and select only exact `.silk` extensions. Selection is sorted by normalized path bytes and
deduplicated; symbolic links are rejected by the native filesystem provider. Use `--` before a
filename beginning with a dash.

Write mode replaces changed files; `--check` reports changes without writing. Damaged source is
reported with its first offending byte offset and remains untouched. Other readable selected
files are still processed. Exit status is `0` for success, `1` for damaged syntax or check-mode
drift, and `2` for project, selection, filesystem, allocation, or diagnostic-output failures.
The portable filesystem uses complete create-or-truncate writes; an interrupted or failed write
can leave a partial file, so formatter writes currently have the same limitation.

`driver.ModuleSources` reads only modules observed as absent by a reached semantic demand. It
publishes each file's exact bytes or absence as a separate `SourceRevision` mapping, then resumes
through `Semantic.revise`. Unused imports stay unread and unchanged per-file observations remain
reusable. Actual missing files report `MissingModule`; filesystem permission/I/O and malformed
manifest failures propagate rather than becoming backend coverage gaps.

A reached sealed runtime primitive that the canonical intrinsic catalog defines but selfhost has
not implemented reports `intrinsic-member`. `semantic.IntrinsicCatalog` retains the exact runtime
and mixed-phase member spellings; the corpus runner check compares them with the bootstrap catalog.
An unknown spelling remains `UnknownMember`. This classification adds no primitive implementation.
Selfhost implements `isizeToUsize`, which traps on a negative value (CONV-002), and the raw-pointer
primitives `pointerFromSlice`, `pointerAt`, `pointerRead` and `pointerRequalify`, instantiated from
their written type arguments. The unsafe members need an `unsafe` boundary or call acknowledgement;
pointer arguments take the ordinary immediate weakening, `pointerFromSlice` takes a shared slice,
requalification keeps one invariant pointee, and a read requires a `Copy` pointee. A foreign
declaration may narrow capture with one `Intrinsic.foreign(noCapture: (...))` field naming distinct
written raw-pointer parameters; the hint creates no loan and lowering may omit it. Other foreign
properties remain `foreign-contract` gaps.

Module-level `static if` arms belong to the containing module namespace (MODULE-STATIC-001/002). The
syntax index records the innermost arm that admits each declaration and keeps conditional groups
transparent to their members. A lookup demands each governing `Condition` query, so an inactive-only
declaration is absent, never checked, and its imports are never read; a repeated import counts once
among admitted candidates. A failed, non-`bool` or cyclic condition fails every lookup and impl set
it governs with its anchored rejection; a condition is a cycle member, so one that depends on its
own arm is always `Cycle`. Every demand made while evaluating a condition is keyed by that
condition, and inside that context interface scans for operator and method syntax skip names whose
every candidate sits in the condition's own arms, because unrelated declarations are not checked to
determine a condition. A package parameter written inside an arm is rejected by syntax with
`ConditionalParameter` before any condition runs (MODULE-STATIC-003). Static routing of mixed bodies
reads only the syntax index, so a name with a conditional candidate there is the explicit
`Unsupported` boundary `ConditionalName`. See the compatibility entry for both limits.

## Design notes

- [MIR core shape](docs/mir-core-shape.md): the final MIR forms, cleanup, failure edges,
  suspension, closures and the opt-in MIR check.
- [Effect calling convention](docs/effect-calling-convention.md): how native code receives Effect
  providers, returns typed failures, and expands the Effect composition intrinsics (roadmap step 5).

## Development branches and bootstrap

`selfhost` is the integration branch for the source-written compiler. Start native compiler work on
`selfhost-*` branches from the current `selfhost` tip, and target their pull requests at `selfhost`.
Use a hyphen after `selfhost`: Git cannot hold both the `selfhost` branch and a `selfhost/...`
branch. Keep the merged M1 history and later `main` work in this branch's ancestry.

Repairs to the TypeScript compiler, CLI, or standard library that the native compiler needs start
from a freshly fetched `main`. Review and merge each repair through a pull request targeting
`main`, with that branch's normal checks. Then fetch the merged `main` and merge it into a new
`selfhost-sync-*` branch based on the current `selfhost` tip. Review the merge and any conflict
resolution, run the focused native checks below, and target the synchronization pull request at
`selfhost`. Use a merge that retains both parents; do not copy repair commits into a private
bootstrap patch stream or reset `selfhost` onto another history. Update native feature branches
from the synchronized `selfhost` tip as needed.

For each bootstrap build, record the `selfhost` commit, the downloaded main compiler commit and CI
run, the host platform and LLVM target. The focused selfhost workflow downloads the latest verified
`silk-bootstrap` artifact using `.github/actions/download-bootstrap` and records its provenance in
the job summary. Invoke its `silk.mjs` with Node 24; native builds also require LLVM. No workspace
dependency install, TypeScript compiler build, or verification packaging job runs on selfhost.
Main also publishes `silk-selfhost-verification`; the download action fetches it from the same run
as the compiler. The verifier reads `compiler/scripts/selfhost-track.json` from this checkout and
checks its intrinsic catalog, authored corpus fixtures, and live formatted standard library,
preserving the native compiler safety gates.

For a local source bootstrap, the checkout supplies the TypeScript compiler and CLI sources in
`packages/compiler` and `packages/cli`, the standard library in `packages/compiler/stdlib`, and the
native sources and manifests in `compiler`. Install with `pnpm install --frozen-lockfile`, then
build the CLI. To use the same CI bootstrap locally instead, download `silk-bootstrap` from a
verified main run and use `node /absolute/path/silk.mjs` in place of `node packages/cli/dist/bin.js`
in the commands below. See [bundled CLI downloads](../packages/cli/README.md) for retention and
pinning instructions.

## Anonymous declaration identities

The syntax-only module index gives each anonymous callable and Effect literal its own
`DeclarationId`. An unnamed `Anonymous` or `EffectBlock` owner step carries its zero-based ordinal
among literals of that kind in the enclosing abstract body. Both `static if` arms count, and a
nested literal starts a new owner scope. Anonymous `effect fn` literals share the `EffectBlock`
kind with Effect blocks. Moving named declarations, changing offsets or adding unrelated bindings
does not change these identities. Inserting a same-kind literal before another changes its ordinal.
Literal declarations do not create module name candidates. Their written headers and body content
have separate fingerprints. Non-effect capture checking, capture-ordered environment layout and
drop glue, sections and direct invocation are implemented. See the
[Step 8 coverage receipt](docs/step8-callable-sweep.md) for structured claims, pins and remaining gaps.

## In-memory semantic queries

`semantic.Semantic` resolves demanded facts from a held, immutable, in-memory
`semantic.SourceRevision.Revision`. Each public demand takes a `semantic.Semantic.Request` ledger;
a fresh ledger starts with no roots or discoveries, even when the store reuses a completed fact.
The source index parses the complete names in a requested module, but it opens an imported module
only when a demanded name needs that import. A completed answer retains direct nested dependencies,
transitive demand evidence, and exact present or absent source observations. A cache hit supplies those
facts to the new request without rerunning its nested providers. Replayed discovery appears in the
new request ledger; the event log records only queries actually started or hit. Source bytes belong
to the held revision, with no host file snapshot or mutable filesystem provider in this API.

`Semantic.revise` selects another immutable revision. The next demand validates retained source
bytes and absent paths before reuse, so changed imported headers or newly present paths recompute
affected facts and diagnostics against the new source. Unrelated source changes leave completed
facts reusable. The source index retains completed presence or absence queries when their exact
content observation agrees, including parsed syntax, authored HIR, and name indexes for unchanged
files. Each parsed declaration also owns a lazy shared `BodyInput`: its exact source span and
canonical header/body bytes are captured once for typed bodies, selected static roots, and reuse
checks. Changed content releases its parsed unit and declaration inputs; a same-path edit never
reuses different bytes.
Previously issued authored cursors expire on every revision selection. A body can also retain its
checked payload after a same-file or imported callee body edit when its own declaration and the semantic results it consumed still match. That
validation starts a real query and records `Reuse`; it does not count as a `Hit`. Header and source
queries can run again. A store opened with `Semantic.traced` keeps `Semantic.eventLog`, the queries
actually run or hit; `Semantic.make` records no events, so a build keeps no per-demand log. Replaying a completed
answer's evidence does not create synthetic nested hit events. `Semantic.sourceEvents` records source
reads and name observations. The focused source-written M1 checks use these records to prove
avoided provider reads and semantic demands; they do not measure speed. The native `build`
mode consumes these demanded facts for its documented closed-body subset.

The current semantic subset resolves local names, ordinary namespace imports, selective imports,
explicit aliases, and a hybrid namespace alias with selected members. Qualified type names have
one namespace segment and one public member segment. Import paths map to slash-separated `.silk`
logical source paths within the importing module's source origin and package. Selected public import
chains resolve to the canonical declaration. Repeating an identical import binding, or writing an
alias equal to its default name, is one binding; two imports that bind one spelling to different
declarations still collide. The store resolves type aliases and nominal type
identities without inspecting fields or layout. Separate `demandMembers` and `demandMemberShape`
queries enumerate a struct's fields, tuple positions, enum cases, or union variants, then resolve
only a selected member's written types under a canonical nominal application. The member ordinal
comes from the ordered enumeration; a unit variant or scalar enum case has no payload types.
Neither query computes inline storage or target layout. For example, the identity and written
`next` field type below terminate even though a later layout request must reject its infinite
by-value representation:

```silk,ignore
struct Node { next: Node }
```

A generic member query substitutes the application's explicit type and lifetime arguments without
checking another member. In `Box<bool>`, requesting `value` yields `bool` even if `deferred` has an
invalid written type; requesting `deferred` then rejects at its undeclared lifetime:

```silk,ignore
struct Box<T> {
  value: T
  deferred: &'undeclared i32
}
fn boxed() -> Box<bool> { return () }
```

Applying a struct, tuple, or union needs its complete lifetime arity. Each lifetime its fields leave
unwritten is a generated parameter of the declaration, bound after its written parameters in field
order: an omitted borrow, slice, or `string` lifetime, an omitted callable or Effect environment,
and every lifetime of a nested nominal or alias used without lifetime arguments. An application
therefore resolves its field type names, through imports and aliases, but never their member types
or layout. With `deferred: Missing` above, `Box<bool>` rejects `UnknownName` at `Missing`, while
`Box`'s identity and member names stay available. A recursive field that would add lifetimes on
every turn, such as `struct Chain { next: &Chain }`, is `Unsupported`; recursion that omits none,
or writes its lifetimes as in `struct Node<'a> { next: &'a Node<'a> }`, keeps a finite arity.

Ordinary type and lifetime binders belong to their declarations. Written function signatures
resolve those binders and explicit nominal or alias arguments, including substitution through
alias targets. Each omitted input lifetime gets a distinct declaration-owned identity; an omitted
result lifetime uses the sole outer borrowed input when there is exactly one. An alias with an
omitted lifetime is expanded in the caller's header, so its uses remain independent. For example,
demanding the signature of `use` resolves `Same<bool>` to `Pair<bool, bool>`:

```silk,ignore
struct Pair<A, B> {}
type Same<T> = Pair<T, T>
fn use(value: Same<bool>) -> Same<bool> { return move value }
```

The supported primitive spellings are `bool`, `char`, signed and unsigned integers through 64 bits
and pointer size, `f32`, and `f64`. A missing result means unit. Signature facts also preserve
`string<'life>`, shared and exclusive references, borrowed slices, and raw pointer access,
nullability, extent, and written alignment. The only supported raw pointer address space is zero;
no target layout or host pointer width is inferred. The following header gives its parameter and
result the same declared lifetime identity:

```silk,ignore
fn view<'data>(value: &'data [i32]) -> &'data [i32] { return value }
```

These are type relationships, not a borrow-safety proof or a checked generic body. Public
contracts reject private nominal types; missing modules, inaccessible members, collisions, and
alias or import-name cycles produce anchored semantic rejections. Each cycle member rejects at its
own reference to the next member, with a path that starts and ends at that member, so its answer
does not depend on which member was demanded first. In `type A = B` and `type B = A`, `A` rejects
at its `B` and `B` at its `A`.

Signatures also describe callable and Effect contracts. `fn(A) -> B`, `mut fn(A) -> B`, and
`once fn(A) -> B` keep their invocation mode, `unsafe`, retained environment, ordered parameters,
and result. The builtin `Effect<'env; A ! E ? R>` needs no import and keeps its run mode (`once
Effect<...>`), environment, success type, failure type, and requirement row. An `effect fn` records
its written `! E` and `? R` channels; omitting them means `never` and the empty row, not inference.
`never` is the empty structural union. `A | B` flattens nested unions and drops repeated members, so
member order does not matter. A row keeps one entry per service and `at` role, with the strongest
written access, plus any `?R` row parameters. Bounds such as `T: Hash + Clock + 'a` and
`'long: 'short` are recorded in written order. A callable or Effect bound such as
`F: fn(i32) -> i32` records a representation parameter rather than an interface requirement. For
example, both headers below have the same channels, and `copy` retains both bounds:

```silk,ignore
service Clock {}
role Primary
struct Missing {}
struct Offline {}
effect fn first() -> i32 ! Missing | Offline ? &Clock at Primary | &mut Clock at Primary { return 0 }
effect fn second() -> i32 ! Offline | Missing ? &mut Clock at Primary { return 0 }
interface Hash {}
fn copy<'data, T: Hash + 'data>(value: &'data T) -> i32 { return 0 }
```

Delayed Effect results preserve their complete retained environments during callable and stored
operand comparison. Structural compatibility returns scalar and environment validity obligations;
the caller proves them from its declared bounds and authenticated invocation premises. A shorter
result promise never authorizes a captured loan to escape, and selected target bounds remain
independent obligations.

A callable contract can quantify invocation lifetimes:
`for<'call> fn<'env>(&'call i32) -> &'call i32` names them. An omitted lifetime in a callable
parameter is a fresh invocation lifetime, so `fn<'env>(&i32) -> &i32` is the same contract; an
omitted result lifetime inside the contract uses its sole borrowed parameter. Two contracts are
equal when some renaming of their used invocation lifetimes makes them equal. Binder names, binder
order, an unused binder, and member order in unions, rows, and environments are therefore not
identity, while written bounds such as `for<'a: 'b, 'b>` remain part of the contract. A quantified
contract inside another quantified contract is rejected, including one quantified only by an
omitted lifetime. An environment such as `Effect<'a & 'b; A>` is an order-independent
intersection in which `'static` and repeats disappear, so `'b & 'static & 'a` is the same
environment and `'a & 'a` is `'a`. A written `effect<'env> fn` or `effect<'a & 'b> fn` environment
is recorded with the signature. A declaration-owned lifetime argument can retain this complete
finite meet, including in a reference, slice or `string` region; inference never chooses an
arbitrary constituent or manufactures a static lifetime. Meet identity is associative, commutative
and idempotent with static as identity, independently of any ambient outlives bounds. Written
outlives premises and enclosing-body loan evidence prove validity through the meet rules:

```silk,ignore
fn apply(transform: fn<'static>(&i32) -> &i32) -> i32 { return 0 }
effect<'env> fn retain<T: 'env, 'env>(value: T) -> i32 { return 0 }
fn both<'a, 'b>(pending: Effect<'a & 'b; i32>) -> i32 { return 0 }
```

`Semantic.demandContract` returns the binders and bounds of a type, alias, interface, or service
declaration without demanding its identity or members. A `?R` binder of such a declaration takes
its row from the `? Row` suffix of an application, and the row is spliced wherever the binder is
used. A bound is recorded by the declaration fact and proved when a concrete application needs
it; an abstract use may rely only on an identical bound declared by its enclosing generic
declaration. Lifetime bounds such as `T: 'a` are also recorded. For example, `Sorted` has a
contract, `Sorted<i32>` rejects without proof that `i32` implements `Hash`, and `Loaded<? &Clock>` resolves
to an Effect requiring both `&Logger` and `&Clock`:

```silk,ignore
struct Sorted<T: Hash> { value: T }
interface Load<E, ?R> {}
type Loaded<?R> = Effect<'static; i32 ? &Logger | R>
fn loadable<T: Load<i32 ? &Clock>>(source: &T) -> i32 { return 0 }
```

Only services may appear in a requirement row, and an `at` path must name a role. Interfaces and
services are both valid bounds; a bound records the requirement and proves no conformance.
Requirement and bound errors, a failure or requirement channel on an ordinary function, a `?R`
binder used as an ordinary type, an ambiguous or nested callable quantifier, and a borrow or bare
callable or Effect inside a structural union have anchored rejections. A demanded generic body can
use its written bounds while checking ordinary values and calls. This contract-typing result does
not check captures, run Effects, or discharge ownership and lifetime safety. Effect bodies and
calls to effect or `unsafe` functions remain `Unsupported` even when their signatures resolve.

`Semantic.demandOperations` lists an interface's or service's operations; each operation resolves
under its contract's binders and an implicit `Self`. `demandImplementations` returns a module's
conformance and sealed-property `impl` heads, `demandConformanceHeads` every head for one contract
and provider owner read from only the modules permitted to own it, and `demandImplementationMembers`
a conformance's inline and mapped members. `demandInherentMembers` publishes an owner's inherent
members across its `impl` blocks; a repeated or claimed name publishes neither. `demandSignatureOf`
resolves a function or operation by its declaration identity under the same gates as the name
lookups `demandOperation` and `demandInherentMember`. `demandOperationUnder` resolves a contract
operation under one conformance head: the contract's binders and `Self` take the head's arguments,
the operation's own binders stay its parameters, and no bound is proved. Under
`impl Convert<i32> for Box<bool>`, `fn convert<U>(value: Self, other: U) -> T` has the parameters
`Box<bool>` and `U` and the result `i32`.

`demandWitnesses` pairs each operation of one conformance with the member that implements it and
checks the member's header against `demandOperationUnder`'s header. A missing or unknown member, a
mapped source function for a scalar or `string` provider, or an incompatible member rejects with
`IncompatibleWitness`, which names the first failing component. Ordinary and effect functions
never stand in for each other; an unsafe member cannot implement a safe operation. Operand modes
are literal: a member may ask for weaker access but not stronger or consuming access, and the
referent, region, and result match exactly. Failures and requirements may only narrow; callers
still see the operation's header. An `effect fn` member's environment must be a promised region, a
region the operation's inputs retain, or one with a written bound to a promised region; a written
member environment must also be kept by its stored inputs. No member body is read, and a
successful answer proves no conformance. Member-owned type, lifetime, and row binders receive
exact evidence from the substituted operation; an owned contract operand may be lent to an elided
member borrow without letting that borrow escape. A fixed requirement beside one open member row
is covered by the operation's fixed row before the open member row binds to its rigid parameters;
the resolved member row must still be covered by the operation row. A sole open environment
member binds its complete residual meet; equations with several unconstrained open members
remain `Unsupported`. Written transitive outlives premises retain their existing proof role.
`demandCoherence` decides a conformance head before any applicability or bound proof. Every written
parameter must occur in the interface application or provider (`UnconstrainedImplParameter`), and
every bound must name a parameter inside the provider without repeating an open parameter or
rewriting a fixed argument of the same interface (`NonterminatingConformance`, with the step). The
head is then compared with every other head in its owner bucket, read from both permitted modules.
Two heads conflict when some substitution makes both applications equal once lifetimes are erased:
bounds never separate them, so `impl<T: Left> M for Box<T>` and `impl<T: Right> M for Box<T>`
conflict, and neither head is admitted. Both heads report one diagnostic: the head later by module
identity and then source position is primary, and `path` names it and then the earliest other
conflicting head. Two unbounded heads that rename each other exactly, lifetimes included, are
`DuplicateConformance`; every other conflict is `OverlappingConformance`. Unions and requirement
rows are sets: `Box<T | i32>` and `Box<bool>` stay distinct, and `? &Clock | R` covers
`? &mut Clock` but `? &mut Clock | R` never covers `? &Clock`. A union member or row entry that
nests a parameter is matched against closed peers under one shared assignment; a successful
pairing is a conflict, and contradictory fixed evidence is distinct. Closed row keys compare after
lifetime projection and retain the strongest access when keys collapse. Set parameters used
elsewhere in the head and pairings whose normalized cardinality may change remain `Unsupported`
until matching can decide them. Sealed-property and inherent heads have no coherence answer yet.

`Intrinsic` is the sealed compiler namespace. It needs no import, and a declaration or import
binding named `Intrinsic` collides with it wherever that binding is looked up. `Intrinsic.Detached`
and `Intrinsic.NonParking` are witness-free properties recorded on generic bounds, and a Detached
representation parameter retains no region. An `Intrinsic.application` import selects the canonical
module explicitly bound to the semantic request; an active import without that binding rejects at
the import, and different bindings have separate query identities. Its imported members obey the
usual visibility and selective-import rules. Other intrinsic families and `impl Intrinsic` are
`Unsupported` until intrinsic applications exist.

Body-sensitive representation-property proofs, row subtraction such as `Without<R, K>` (which
belongs to the later provision and requirement-algebra work), requirements on type parameters,
static parameters, and other nonstandard callable header modifiers currently return `Unsupported`
rather than a provisional type. Variadic function definitions are also rejected; admitted C
imports use the integer-only boundary described below. A `where` clause is different: the first
stable language has no `where` clauses, so a written one is rejected as invalid syntax, not a
pending feature, even though the rejection currently uses the `Unsupported` code.

Calls with scalar results accept a contiguous ordered prefix of type, lifetime, and positional row
arguments. The exact matcher infers ordinary, lifetime, and row parameters from typed operands,
including nested nominal types and multiple rows fixed by independent evidence. Conflicting
evidence and binders present only in the result reject without using the expected result. The
typed call retains its completed generic application. Non-scalar parameter locals and their call
arguments retain resolved types; unsupported body forms still reject. Once operands fix a provider,
one uniquely matching coherent conformance or direct bound declared by the caller may fill
remaining interface arguments. It cannot override explicit or operand-derived arguments, choose
among multiple conformances, or infer an unknown provider. A checked scalar direct call proves the
completed signature's interface bounds before retaining its typed result. `typeof(item)` in a type
position names one visible, fully specialized named callable representation. Identical callable
use signatures do not make two named items identical. A public
signature cannot expose a private item. A `some` result records one producer-owned opaque
representation and its executable use contract. Checking its concrete realization in a body
remains part of the later complete-body work.
An omitted lifetime inside a declaration bound is recorded as a generated declaration binder.
Bounded nominal and alias applications prove their concrete interface goals; an abstract use may
rely only on an identical bound declared by its enclosing generic declaration.

An omitted callable or Effect environment elides like a borrow. An input retains the regions of its
borrows, non-`'static` nominal lifetime arguments, and callable or Effect environments; the
parameter and channel types of a callable or Effect are not stored. A representation parameter
(`F: fn(A) -> B`, `F: Effect<A>`) retains its bound contract's environment. An input whose stored
contents involve any other type parameter has no nameable region. For an ordinary function's `Effect` result, inputs that retain
nothing leave the omitted environment `'static`, so `fn closed() -> Effect<i32>` and
`fn later(value: i32) -> Effect<i32>` have results of the form `Effect<'static; i32>`. Otherwise a
single borrowed input supplies it as before, and any other case is rejected as `AmbiguousLifetime`
at the result. An `effect fn` success type that is an Effect gets no `'static` default. An `effect fn`
captures every input, so its omitted environment is the intersection
of the regions its inputs retain: `'static` for none, `'a & 'b` for two borrows, the pending
Effect's region for `once Effect<A>`. Generic stored contents such as `value: T` are rejected as
`AmbiguousLifetime` at that input, so the declaration writes `effect<'env> fn`. These defaults cover
only the result's own environment.
`fn nested() -> Effect<'static; Effect<i32>>` leaves the inner environment without a default, and
callables and Effects nested inside callables need their environments written. Invalid or unknown
lifetimes and pointer qualifiers have anchored rejections. Written `[T; N]` arrays
retain the exact non-negative decimal extent and element type, including at zero length. Extents
execute checked static expressions, including arithmetic, constants selected through imports, and
static calls; the final non-negative integer must fit the selected target's pointer width. A member type request
that elides a generated field lifetime is `Unsupported` until applications substitute generated
lifetimes into member types. No machine layout fact is inspected. Unused declarations
with these forms are still indexed as written
names and do not require semantic resolution.

Constants have two separate facts. `Semantic.demandConstant` resolves only the written type, which
must be `bool`, `char`, an integer or floating-point primitive, or `string`, whose omitted lifetime is
`'static`. Any other type is `InvalidConstant`, and the initializer is never read; an omitted
annotation is a syntax error. `Semantic.demandInitializer` first demands that type, checks the
initializer against it, then executes the checked static expression. It publishes canonical bool,
character, fixed-width or target-sized integer, floating-point, and UTF-8 text values. Supported
expressions include operators, local or namespace-qualified constant references, and calls to
checked static functions, including canonical inherent helpers. A reference to another constant
demands its type before its value. For example:

```silk,ignore
const limit: u8 = 255
const copied: u8 = limit
const first: i32 = second
const second: i32 = first
```

`copied` has the value 255, while the value demands of `first` and `second` reject with a `Cycle`,
each at its own reference to the other, whichever is demanded first; their `i32` types remain
available. A literal of the wrong kind or out of range rejects at its authored span, and a constant of a
different type is `TypeMismatch`. Runtime calls are `StaticPhaseViolation`; an unsupported checked
expression publishes no value. Static execution records reached body and initializer dependencies
and enforces step, depth, and retained-value limits, including retained text provenance. Returned
text aliases preserve their original authored spans.

A runtime body reads a local or namespace-qualified constant, such as `usize.MAX`, as its published
value at the declared type. The read demands the constant's content-keyed initializer and records
that value edge, so every reader shares one evaluation, and a rejected initializer rejects the reader
with the initializer's own diagnostic. MIR materializes the value at its use: integers with their
exact sign and magnitude, `bool`, floats (an `f32` widened exactly to the f64 operand bits), `char`
as its scalar value, and text as a descriptor over its program-lifetime bytes. A `char` value still
has no runtime layout and reports the `scalar-layout` gap.

The sealed `Intrinsic` surface supplies target and final-profile facts and static text operations.
One explicit final build profile controls selected static-if arms; inactive arms contribute no
annotation, call, or body demands. Authored generic/evidence execution, nominal resource safety,
and profile predicates remain explicitly deferred. Static-query reuse validates executed-body,
initializer and profile-input dependencies. Canonical values exclude source origins; each request
replays current source observations and registration checks before using a completed fact. Unrelated
edits can retain checked bodies, while changed helpers or selected profile content invalidate their
consumers. Foreign `static` data is outside this initializer path. The native CLI/backend coverage remains the limited subset
listed at the beginning of this document.

`Semantic.demandBody` checks one requested ordinary function body against its written signature.
It accepts fixed-width integer, `bool`, and unit literals, by-value parameter reads and whole-value
moves, immutable locals, explicit returns, and unit fallthrough. Generic parameters remain symbolic;
admitted nominal and other non-scalar by-value types are typed without claiming their ownership
safety. An immediate return or local annotation
selects an exact integer literal's type, including through a resolved alias. Without context, an
integer literal defaults to `i32`. For example, demanding
`answer` succeeds without checking `broken`; demanding `broken` rejects the unknown name at its
written span:

```silk,ignore
fn answer() -> i32 { return 42 }
fn broken() -> i32 { return missing }
```

`fn fits() -> u8 { return 255 }` succeeds, while `fn tooLarge() -> u8 { return 256 }` rejects the
exact out-of-range value. `fn inferred() -> u8 { let value = 255 return value }` rejects because
`value` is already `i32`; `fn annotated() -> u8 { let value: u8 = 255 return value }` succeeds.
Initializers see preceding locals and parameters, but not the binding they initialize. A local
may shadow a parameter in the function body; a second local with the same name in that block
rejects. A full direct call to a same-module or imported ordinary function checks each
argument against its written parameter type in source order. An exact integer literal uses that
parameter as its immediate type context; an already typed local keeps its fixed type. For example,
`fn pair(first: u8, second: i32) -> i32 { return second }` accepts `pair(255, 1)`, but rejects
passing a local initialized by `255` as its first argument because that local is already `i32`.
Too many arguments, a non-callable target, and an empty call of a function that needs arguments
receive distinct rejections. A valid nonempty partial application remains `Unsupported` in this
wave.

A unit function can return `()` or fall through an empty body. A reachable non-unit fallthrough,
incompatible return, or unsupported statement or expression is an anchored
rejection. A completed body answer retains typed nodes, the current source observation, callee signature
dependencies, and required runtime-body declarations for later closure. A body demand checks only
that declaration. Thus `fn caller() -> i32 { return leaf() }` can check successfully even when
`leaf` has an invalid body; a later build must validate that required body. Mutual calls with written
signatures do not force a body-query cycle. A body demand does not execute user code or prove that
the whole program is valid. Imported calls retain positive and negative name, import, and source
observations on fresh request hits.

A body answer distinguishes `FullyChecked` for the existing scalar subset from `ContractTyped`
for generic or non-scalar bodies. The latter retains source places that still need ownership,
lifetime, cleanup, and Effect safety checks. `ContractTyped` is a type result, not a proof that
those obligations have been discharged; consumers must not treat it as a safe executable body.
A written generic callee signature can type a call, including a nested result such as `Box<T>`,
without demanding the callee body, and both runtime branches are checked. Unsupported expressions
reject rather than leaving an untyped node in a successful body.

A demanded generic body uses its own declared bounds, even when a concrete caller supplies a
provider that implements the interface:

```silk,ignore
interface Read { fn read(value: Self) -> i32 }
fn bounded<T: Read>(value: T) -> i32 { return Read.read(move value) }
fn without<T>(value: T) -> i32 { return Read.read(move value) }
```

`bounded` has a `ContractTyped` body. Demanding `without` rejects for missing conformance,
regardless of its callers. Its body cannot gain a proof from a caller's concrete argument.

For example, after checking `caller`, changing only `leaf` from `return 1` to `return 2`
keeps the caller's checked payload, including when both functions share a file:

```silk,ignore
fn leaf() -> i32 { return 1 }
fn caller() -> i32 { let value = leaf() return value }
```

The edit leaves the called signature and the caller's declaration unchanged. Changing `leaf` to
`fn leaf() -> bool { return true }` makes the caller's `i32` return invalid, so it is checked again
and rejected. Adding or removing a previously missing imported declaration also updates its actual
consumers. Reused bodies carry the current source observation and current dependency evidence.
If a source edit moves the caller's syntax positions, changes its declaration, makes its owner
mapping ambiguous, or changes a dependency whose semantic identity cannot be compared exactly,
the checker runs again. Changed contract, proof, witness, inference, and method/operator selection
facts invalidate their consumers; a witness implementation-body-only edit can retain a
contract-typed caller after validation. A fresh specialization Pool uses the current validated
facts to distinguish a changed selected witness. These events prove only semantic-body reuse;
they do not imply MIR, LLVM, object, link, or persistent-cache reuse.

Richer facts follow the same validation rule. A fact stays valid only while every present or absent
source it observed is unchanged, so an edit anywhere in a module restarts the facts that read that
module, and a restarted fact may equal its earlier value. Facts that never read the edited module
remain hits. A checked body compares its direct results only after each consumed fact has been
revalidated against current sources. The comparison includes canonical type applications,
contracts, signatures with bounds and channels, complete positive and negative head sets,
coherence, proof bounds, operation and witness mappings, and the typed selection facts that depend
on them. Changed or unsupported identities conservatively recheck the body. For example, take
`consumer.silk`:

```silk,ignore
import geometry as Geometry
fn origin(at: Geometry.Point) -> () { return () }
fn caller() -> i32 { return Geometry.leaf() }
fn unrelated() -> i32 { return 2 }
```

and `geometry.silk`:

```silk,ignore
type Element = i32
pub struct Point { width: Element }
pub fn leaf() -> i32 { return 1 }
```

Changing `Element` to `bool` changes the requested `width` shape to `bool`. The recomputed identity
of `Point`, its member names, and the `origin` signature equal their earlier values. `caller` keeps
its checked payload because the `leaf` signature is unchanged, and `unrelated`, which never read
`geometry.silk`, is a hit. Then replace `Point` with
`struct Point { height: &'undeclared i32 depth: i32 }`. The member names change, the second member
(previously `UnknownMember`) has type `i32`, and the first member rejects its undeclared lifetime at
its current span. A written lifetime needs no resolution for `Point`'s arity, so `origin` still
resolves; a field type name such as `Missing` would instead reject every application of `Point`. A new store on the same revision returns the
same results. A typed failure while revalidating `caller` publishes no answer; the retry checks the
body again instead of restoring the earlier payload. The leaf body is never demanded.

Constant type and value facts have separate consumers. Suppose `library.silk` contains
`pub const base: u8 = 7` and the importing module contains:

```silk,ignore
import library { base }
const copied: u8 = base
const later: u8 = pending
```

Changing `base` to `9` restarts the value of `copied` but not its type fact, which never read the
library. Changing `base` to `pub const base: bool = true` makes the value of `copied` a `TypeMismatch`
at the `base` reference. The value of `later` is `UnknownName` at `pending` until
`const pending: u8 = 4` is added, and an edit that turns two initializers into a cycle rejects their
values with `Cycle` while their types stay available.

Ordinary runtime `if` statements require `bool` conditions and check both arms. For example,
`fn choose(flag: bool) -> i32 { if flag { return 1 } else { return 2 } }` has no reachable
fallthrough. `fn partial(flag: bool) -> i32 { if flag { return 1 } }` rejects because the false path
reaches the end, while a unit function may fall through. An arm with `return missing` rejects even
when a constant or a caller's known argument selects the other arm. A binding inside an arm stays
in that arm; another arm or a later statement cannot read it. Checked bodies retain both branch
nodes and whether each block can complete. Source after a return is still checked, although it
cannot make a completed path reachable again.

This native semantic API is not wired into the inspection executable above. Contract-level
conformance, method selection, and eligible closed scalar/string operator typing are available;
their ownership, capture, cleanup, and Effect safety obligations remain for M2.5. Function values,
sections, pointer-sized literal ranges, Effect execution, layout, and code emission are outside
the current body subset. A `static if` with a checked `bool` condition now checks only its selected
body arm, so `fn selected() -> i32 { static if true { return 1 } else { return 2 } }` has no reachable
fallthrough. Static selection does not use runtime branch checking. Unused declarations with
these forms remain indexed. The authored HIR keeps integer sign, radix, and exact decimal
magnitude beyond `u64`; body checking compares those digits without rounding through a
host number. Structured typed failures and cancellation release incomplete query reservations and
publication frames. A later demand can retry the same store. A fatal runtime trap ends the
process and has no such recovery guarantee. Compiler CLI integration, host-backed snapshots, and
later semantic and backend milestones remain future work.

### Semantic scope and later waves

These queries complete the M2.2 type and signature vocabulary: declaration-owned generic binders
and explicit applications; references, slices, raw pointers, lifetimes, and modifiers; nominal
identity, member enumeration, requested member shapes, and authored array extents; callable and
Effect signature contracts with written channels and recorded bounds; constant types and literal or
constant-to-constant values; and revision validation for each of these facts. A form outside that
vocabulary is rejected as invalid, like a `where` clause, or returns `Unsupported` until its wave:

- **M2.3, contract facts:** canonical interface/service scopes, implementation coherence,
  conditional conformance proof, witnesses, type/row/representation inference, abstract contract
  typing, and method and eligible operator selection are supported in the current semantic layer.
  Their demand and revision answers retain complete observations. A fresh per-request
  specialization `Pool` builds closed semantic and runtime identities from those validated facts;
  the Pool is not a revision-cached query answer. Retained instance answers belong to M3. Abstract
  generic bodies retain later safety obligations; body-sensitive property proofs belong to M2.5.
- **M2.4, static and configuration execution:** array extents such as `[Node; COUNT]`; constant
  initializers with calls, operators, qualified names, or floating-point, text, or character values;
  pointer-sized ranges and other target selection; target constants; static parameters; and package
  parameters.
- **M2.5, ownership, Effects, and remaining bodies:** borrow and capture safety, Effect bodies and
  calls, `unsafe` calls, partial application, aggregate construction and member access, and
  provision algebra such as `Without<R, K>`.
- **M2.6, representation and reflection:** layout, offsets, and rejecting infinite by-value storage
  such as `struct Node { next: Node }`.
- **M3, code generation:** MIR, LLVM, and reuse of lowered or emitted artifacts.

Native C imports with a nonempty fixed parameter prefix admit integer-only variadic tails on
AArch64 Darwin and x86_64 GNU Linux. Narrow signed/unsigned integers become signed i32 through
sign/zero extension respectively; wider integers retain their type. TypedBody and MIR retain
source and promoted tail types, and LLVM emission validates that evidence before emitting one
true variadic declaration and call function type. Zero-tail and differently shaped calls share
the same declaration; fixed/variadic status participates in canonical semantic signature identity
and reached symbol conflicts, so changing an imported ellipsis invalidates dependent call admission.
Fixed scalar/pointer C contracts and unsafe acknowledgement remain required. Floating, pointer,
reference, aggregate, bool, char and callable tails, variadic definitions/function pointers,
and other native targets remain outside this boundary.

## Inspect a source file

From the repository root:

```sh
pnpm exec silk run --manifest-path compiler/silk.toml -- compiler/src/main.silk
```

Pass one normalized relative path beneath the working directory. Absolute paths and `.`/`..`
components are rejected. File, allocation, host-input, and writer failures propagate from `main`.

The dump starts with `root #<id>`, then lists nodes in array order. Each node reports its kind and
half-open byte span. Indented lines contain child node IDs, token IDs with their kinds and spans,
or missing-token placeholders. The final section lists syntax diagnostics. Lexical diagnostics
are printed alongside invalid tokens. IDs belong to this tree only.

After a successful build, running the executable directly avoids rebuilding it. For example, on
Apple Silicon with the debug LLVM target:

```sh
compiler/build/llvm/aarch64-apple-darwin/debug/silk-compiler compiler/src/main.silk
```

## Inspect a lowered module

Prefix the path with `hir` to lower the file instead of dumping its syntax tree:

```sh
pnpm exec silk run --manifest-path compiler/silk.toml -- hir compiler/src/main.silk
```

Pass one normalized relative path, as in the syntax mode: `Path.joinUtf8` rejects absolute paths,
so an absolute argument fails with a file error rather than a lowering error.

The dump opens with the module's `//!` documentation and the declaration range, then lists every
arena node in postorder: `#<index> <kind> <start>..<end>`, one indented line per field, and a
`causes` line on any node that recorded recovery. Sections follow in a fixed order — `causes`,
`diagnostics`, `fingerprints` naming each declaration's owner key with its header and body digests
as hexadecimal, and `violations` reporting what `Hir.verify` found. Each section opens with its own
`<name> <count>` line, so a reader can check that a section holds what it announces.

A field occupies exactly one line. A child identity prints as `#id`, an absent child as `none`, a
child range as `[#a #b]`, a span as `start..end`, and an interned symbol as quoted text with `"`,
`\`, and the line breaks escaped, so a module documentation block or a text literal containing a
quote never closes its field early or opens a line the reader cannot classify. A `#<number>` inside
an owner key counts same-key siblings and is not an arena identity.

The text depends only on module content, so two builds of one file agree byte for byte. This is a
debug dump; the output is not a stable format.

## Representation and recovery

`SyntaxTree` owns the source `Bytes`, the complete token vector (including trivia), a flat node
vector, the root ID, and syntax diagnostics. A `NodeId` is exactly an index into that node vector.
Children are appended before parents; the source-file root is last. Nodes contain only their
kind, span, and direct `Element` vector. No child node or token payload is copied into a parent.

The parser reads significant tokens but retains trivia in the original token vector. Source bytes
allow contextual identifiers such as `where`, `with`, and `operator` to remain ordinary identifiers
elsewhere. `Parser.parse` takes ownership of both the bytes and their corresponding token vector;
those inputs must describe the same file.

Missing tokens produce zero-width placeholders and diagnostics. Unexpected source is retained in
error nodes. List and block loops enforce cursor progress, and recursive rules have a stack-safety
bound with iterative recovery. A malformed child does not invalidate valid siblings. Syntax
problems are result values, not effect failures; allocation failure is still an effect failure.
The AST inspection executable intentionally prints the recovered result instead of stopping at
its first syntax diagnostic. A future compilation driver can stop on that diagnostic.

## Lowered representation

`hir/Hir.silk` defines the target of lowering: a `Module` is one postorder node arena where a
`HirId` is exactly an index and children precede parents. A node owns no heap vector — single
children are `HirId`, optional children are `HirRef`, and lists are `Range` runs into one shared
child vector. Every byte string is interned through `hir/Intern.silk`, so a module holds no source
bytes and no `SyntaxTree`; `spans` and `nodeCauses` run parallel to `nodes` and keep coordinates
only. Every tagged record of the bootstrap `AuthoredHir` has a counterpart variant; the module doc
comment lists each deliberate difference.

`Hir.write` dumps a module as indented text and `Hir.render` produces the same bytes in an owned
buffer, so a test can compare a lowered module against expected text. `Hir.verify` reports the
arena invariants a module violates rather than asserting them, which replaces the bootstrap's
structured-clone publication step: `spans` and `nodeCauses` have the same length as `nodes`, every
child identity precedes the node referencing it and stays inside the arena, every child range,
cause range, symbol, and top-level declaration identity lies inside its storage, and every missing
or invalid node records at least one cause. `Hir.writeViolations` runs it and prints the result as
the dump's last section, so the `hir` mode reports a defect instead of printing a broken arena
silently. It verifies arena consistency, not lowering fidelity.

One reference is deliberately not an ownership edge. `IdentifierExpression.binding` names the
binder the identifier resolves to, which the block, parameter list, or pattern that declares it
already owns, so a binder is pointed at once per reader. Following it would reach a node twice.
Every other reference is an ownership edge, which makes the arena a forest rooted in the
declaration range.

That forest property — every node reached exactly once from the declaration range, and every
child's span inside its parent's — is the one arena invariant `Hir.verify` does not check. Proving
it needs a second traversal carrying a per-node owner count through all 132 variants of the
exhaustive field walk, only to distinguish the single resolution edge from every ownership edge.
`lower-corpus.mjs` below proves it instead, over every fixture, self-hosted source, and standard
library module, which is where an orphan would actually appear.

`hir/Draft.silk` owns the module while it is being built. Every node enters the arena through
`Draft.append`, which pushes one `nodes`, one `spans`, and one `nodeCauses` entry together, so the
three parallel vectors cannot drift. Child lists and recovery-cause runs are collected on scratch
vectors and copied into the module's shared storage when they close. Lexical binders use one flat
vector with a frame-start stack, so opening and closing a scope truncates rather than allocates.
The syntax accessors, the recovery-cause selection, and the name, path, and literal lowerings port
the bootstrap `AuthoredLowering` helpers of the same names; the literal decoders port
`internal/IntegerLiteral`, `internal/DurationLiteral`, `LiteralForm`, `StaticText`, and
`internal/Escape`. Integer magnitudes are exact interned decimal digits; their sign and written
radix stay separate. Floating and duration magnitudes remain `u64` and can have overflow causes.

`hir/LowerType.silk` lowers every type operand, generic binder list, row, `where` constraint, and
callable contract. `LowerType.lowerType` is the one type entry point: it unwraps grouping
parentheses in place, so a parenthesized type leaves no node, and retains a lifetime, a bare
requirement, or a damaged region in a type position as an invalid type. `LowerType.rowOperand`
selects between a type and a written requirement wherever a row admits both.
`LowerType.callableContract` reads the contract pieces directly off a callable header, because the
grammar attaches them there rather than to a node of their own.

`hir/LowerExpression.silk`, `hir/LowerPattern.silk`, and `hir/LowerStatement.silk` lower bodies.
They import one another the way the parser modules do, because an expression holds blocks, a block
holds statements, and a statement holds patterns and expressions. `LowerExpression.lowerExpression`
unwraps grouping parentheses in place, resolves every identifier against the draft's frame stack,
and leaves an unbound one absent for a later resolution phase. `LowerStatement.lowerBlock` opens
one frame per block, and a binding statement binds only after its initializer is lowered, so
`let x = x` reads the outer `x`. An `else if` chain nests: the chained conditional is the
`elseBranch` of the one before it, never a flat list. `LowerExpression.propertyClauses` lowers the
`with ns.op(key: value)` clauses a declaration or a foreign function type writes, keeping written
order and duplicate keys for a later validation phase.

`hir/LowerDeclaration.silk` lowers one declaration into three nodes: a header, a body, and the
`Declaration` that pairs them with an `OwnerKey`. The key is the declaration's source-independent
logical name — a category, an interned name, and the occurrence among same-key siblings — so moving
a declaration within its file does not rename it. Occurrence counting is per parent, not per module:
a `Scope` holds the keys already issued under one parent, and every members body opens a fresh one,
so two same-named functions in different implementations both take occurrence zero. A declaration
also interns the `///` block attached to it, following the bootstrap `DocBlock.ofNode` attachment
rules: exactly one line break between the block and the declaration, and every comment on its own
line. A static conditional lowers both arms, including the one its condition will not select.

`hir/Lower.silk` is the one HIR entry point. `Lower.lower(&SyntaxTree)` interns the leading `//!`
block as the module documentation, lowers every top-level declaration under one key scope, copies
the lexical and parser diagnostics into module coordinates, and answers a `Module` that refers to
nothing in the tree, which the caller then drops.

`hir/Fingerprint.silk` turns a lowered declaration into the content key a later incremental cache
compares. `Fingerprint.header` and `Fingerprint.body` encode a declaration's two halves as a flat
sequence of tag-and-length frames: a node frames its grammar category and then one frame per field
in declared order, a symbol frames the bytes it interns rather than its index, a child frames
inline rather than as an arena identity, a recovery cause frames its code without its span, and a
binder reference frames the binder's preorder ordinal within the declaration. Spans, `HirId`
values, sibling declarations, trivia, and the string table's layout never reach the bytes, so
reordering two declarations or interning extra strings beforehand leaves both encodings untouched.
`Fingerprint.headerDigest` and `Fingerprint.bodyDigest` are the SHA-256 of those bytes, and
`Fingerprint.moduleDigest` covers the module documentation and every declaration's two digests in
written order, which is the one place declaration order does count. The cache itself is out of
scope; these are its primitives.

CST construction remains postponed. The token vector retains source information, but there is no
second concrete-syntax tree to maintain.

Recursive rules share a budget of 32 active grammar operations. This counts parser operations,
not just parentheses: nested blocks, types, patterns, and expressions share the same budget.
Siblings restore their parent's depth. Exceeding the budget reports `NestingLimit` and skips the
damaged branch without recursive recovery. The budget is an implementation resource limit, not
a Silk grammar restriction or a limit on file size. The previous value of 256 exceeded the
available stack in the bootstrap-generated debug executable before recovery could run.

## Grammar modules

| Module                                         | Responsibility                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lexer/`                                   | Pull-based byte scanner, tokens, spans, and lexical diagnostics                                                                                |
| `parser/ParseState.silk`                       | Ownership-threaded cursor, node construction, contextual spelling, and recovery primitives                                                     |
| `parser/Parser.silk`                           | Source-file loop and final tree assembly                                                                                                       |
| `parser/Import.silk`                           | Module paths, aliases, selected members, and public imports                                                                                    |
| `parser/Declaration.silk`                      | Nominal declarations, functions, constants, parameters, services/interfaces, implementations, native headers, and static declaration groups    |
| `parser/Type.silk`                             | Type paths, generics, lifetimes, references, arrays, pointers, callable types, effect rows, and constraints                                    |
| `parser/Expression.silk`                       | Literals, constructors, calls, projections, prefix/infix precedence, pipelines, effects, anonymous callables, and matches                      |
| `parser/Pattern.silk`                          | Nominal/applied patterns, whole-value bindings, field shorthand/rest, enum/integer cases, and wildcards                                        |
| `parser/Statement.silk`                        | Bindings, assignments, control flow, transfers, static loops, unsafe blocks, and block recovery                                                |
| `parser/Property.silk`                         | Sealed function/module property syntax                                                                                                         |
| `parser/Grammar.silk`, `parser/Lookahead.silk` | Shared boundaries, precedence, and non-consuming ambiguity checks                                                                              |
| `parser/SyntaxTree.silk`                       | Tree ownership and flat AST printing                                                                                                           |
| `hir/Intern.silk`                              | Deduplicated byte-string storage: `Symbol` identities and the `StringTable` that produces them                                                 |
| `hir/Hir.silk`                                 | The flat HIR vocabulary, the `Module` arena, its debug dump writer, and its arena verifier                                                     |
| `hir/Draft.silk`                               | The in-progress module a lowering builds: arena appends, interning, binder frames, syntax accessors, and the name, path, and literal lowerings |
| `hir/LowerType.silk`                           | Types, generic parameters, rows, `where` constraints, and callable contracts                                                                   |
| `hir/LowerExpression.silk`                     | Expressions, match arms, anonymous callables, field initializers, and written property clauses                                                 |
| `hir/LowerPattern.silk`                        | Patterns, pattern fields and shorthand bindings, and member selectors                                                                          |
| `hir/LowerStatement.silk`                      | Statements, conditional chains, and the blocks that scope their bindings                                                                       |
| `hir/LowerDeclaration.silk`                    | Declaration headers and bodies, owner keys and occurrence counting, and attached documentation                                                 |
| `hir/Lower.silk`                               | The module entry point: documentation, top-level declarations, and copied frontend diagnostics                                                 |
| `hir/Fingerprint.silk`                         | The canonical content encoding of one declaration, its SHA-256 digests, and the module digest                                                  |

Grammar rules are ordinary Silk functions. They consume `State` and return it with either an
unfinished element list or a completed node ID. Replacement values are evaluated before assigning
them back to a local owner, as required by Silk's ownership rules.

## Verification

Build this checkout's bootstrap CLI, then run the source-written cases. The M1 query root imports
query and source-index cases. The semantic cases are split by topic into six roots that share
`semantic/SemanticCaseSupport.silk`; they, the callable-result cases and the frozen-target cases use
their own roots to keep each native compilation within the CI time and heap limits. The HIR root
runs the lowering, fingerprint, and parser cases without pulling the semantic engine into their
binary. `--no-cache` executes assertions even if a previous run stored passing results. The focused
Linux workflow runs these commands for pull requests targeting `selfhost` and pushes to `selfhost`.
Other pull-request targets and main pushes keep their existing broad CI. Native work branches are
named `selfhost-*`; pushing one does not start a second CI run before its pull request.
The heaps match the cases matrix in `.github/workflows/selfhost.yml`: a semantic root peaks near
11.3 GB, so run one at a time on a 15 GB machine.

```sh
CI=true node scripts/turbo.mjs run build --filter=@silklang/cli...
NODE_OPTIONS=--max-old-space-size=8192 node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/M1Cases.silk --no-cache
NODE_OPTIONS=--max-old-space-size=12288 node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/semantic/SemanticStaticCases.silk --no-cache
NODE_OPTIONS=--max-old-space-size=12288 node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/semantic/SemanticSignatureCases.silk --no-cache
NODE_OPTIONS=--max-old-space-size=12288 node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/semantic/SemanticConformanceCases.silk --no-cache
NODE_OPTIONS=--max-old-space-size=12288 node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/semantic/SemanticLoweringCases.silk --no-cache
NODE_OPTIONS=--max-old-space-size=12288 node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/semantic/SemanticCaptureCases.silk --no-cache
NODE_OPTIONS=--max-old-space-size=12288 node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/semantic/SemanticCallableCases.silk --no-cache
NODE_OPTIONS=--max-old-space-size=8192 node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/semantic/CallableResultCases.silk --no-cache
NODE_OPTIONS=--max-old-space-size=8192 node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/semantic/TargetCases.silk --no-cache
NODE_OPTIONS=--max-old-space-size=8192 node packages/cli/dist/bin.js test --manifest-path compiler/silk.toml --root src/hir/LoweringCases.silk --no-cache
```

The cases inspect query and source events, retained request evidence, and rejection codes and byte
spans. They cover an unused missing import and invalid declaration, demanded import and written
signature, memoized reuse, relevant and unrelated revisions, negative observations, exact integer
HIR, typed-failure retry, nested query cancellation with same-store retry, and source-publication
rollback. The cancellation proof combines the executed nested query case with reviewed semantic
publication boundaries; it does not claim an executed full-semantic cancellation fixture.

Keep this loop lean: each new case needs behavioral evidence that its neighbors cannot provide.
Until the self-hosted compiler is functional, each test must finish within 1 s on Linux CI;
target under 500 ms. The focused workflow checks the runner's per-test times. Shorten fixture
programs, share a parsed revision across assertions, and avoid repeated whole-module demands;
split only independent claims and retain their distinct checks.
Use the existing source-written roots, shared runners and fixtures, and the cheapest assertions
that can falsify the claim. Cover representative integration and failure boundaries rather than
adding per-feature native recompilations or exhaustive matrices. Run broader parser, HIR, corpus,
fuzz, stress, and benchmark work when a milestone or a specific regression calls for it. The
focused CI records separate step durations for dependency/toolchain setup, bootstrap compilation,
and each source-written compile-and-run command. Those last commands include native compilation and
test execution; their combined duration is not a runtime-only measurement. Compare actual cold and
warm CI runs before setting a time target; five minutes is an aspiration, not a correctness bound.

Check the self-hosted program with the bootstrap compiler when changing source outside that
focused entry:

```sh
pnpm exec silk check --manifest-path compiler/silk.toml
```

The source-written parser tests in `src/parser/ParserCases.silk` parse source strings, including
malformed syntax, and assert self-hosted parser behavior. The HIR lowering root imports them, so
the focused HIR run above discovers them; `src/main.silk` imports no test modules. The JavaScript
harness below remains the TypeScript-versus-self-hosted comparison.

After building the executable, run the parser corpus with its path:

```sh
node compiler/scripts/test-parser.mjs compiler/build/llvm/aarch64-apple-darwin/debug/silk-compiler
```

The harness reuses one built executable. It compares significant AST structure with the bootstrap
parser across grammar fixtures, the self-hosted sources, and the standard library. It also checks
postorder IDs, source spans, reachability, unique token ownership, and preservation of following
declarations after malformed syntax. Extra file paths after the executable select a smaller corpus.
The JavaScript harness imports the bootstrap package's built `dist` modules.

The default run also executes the behavioral cases in `scripts/parser-cases.mjs`, adapted from
the bootstrap parser tests. These compare acceptance and require specific valid constructs to
survive damage in both parsers. They do not compare diagnostic wording, diagnostic counts, error
tree shapes, or the two implementations' numerical resource budgets. Every native tree must
still satisfy the flat-tree invariants, and every diagnostic must address a valid source span.
The existing valid-file corpus retains its significant-tree comparison as a separate regression
check; a representation change can update that check without changing the behavioral cases.

Run only the behavioral cases, or select individual cases by name:

```sh
node compiler/scripts/test-parser.mjs compiler/build/llvm/aarch64-apple-darwin/debug/silk-compiler --cases
node compiler/scripts/test-parser.mjs compiler/build/llvm/aarch64-apple-darwin/debug/silk-compiler --cases missing-parameter-comma overdeep-call
```

Each case uses a temporary source file beneath `compiler/fixtures/`, which the harness removes
after success or failure. The native executable is built once, not once per test. The nesting
cases exercise both accepted inputs and diagnostic recovery, including depth-budget reuse by
sibling expressions and a following declaration after unclosed delimiters.

Lower the same corpus and check the arena the lowering produces:

```sh
node compiler/scripts/lower-corpus.mjs compiler/build/llvm/aarch64-apple-darwin/debug/silk-compiler
```

This harness reuses one built executable too, and imports nothing from the bootstrap package: every
assertion is a property of the self-hosted dump alone, never a comparison against
`AuthoredLowering`. It runs `hir` mode over the grammar fixtures, the self-hosted sources, and the
standard library, and asserts that the process exits cleanly, that the dump reads back with each
section holding the number of entries it announces, that `violations` is empty, that every child
identity precedes its parent, that one traversal from the declaration range reaches every node
exactly once, that a child's span lies inside its parent's, that every identifier resolves to a
binder, and that a file the parser accepts lowers without a recovery cause. Extra file paths after
the executable select a smaller corpus.

`fixtures/parser/` contains syntax-only programs: names need not resolve and operations need not
typecheck. `recovery.silk` deliberately contains syntax errors. The other files directly under
`fixtures/` exercise lexical categories and are not necessarily complete Silk programs.

Bootstrap issues encountered while developing this frontend are recorded in [BUGS.md](BUGS.md).

### Step 8 capture typing

Anonymous body checking retains one exact callable value type: an ordinary function application,
its callable use contract and capture field types. Capture fields follow first lexical use and
retain the strongest checked access. Copy values are snapshots; affine reads retain shared loans;
mutation and exclusive forwarding retain exclusive loans; affine moves produce once invocation.
The typed literal retains its separately checked body and environment aliases for MIR lowering.
The application retains enclosing generic scopes, including inputs used only by the body, and the
use contract quantifies the anonymous parameters' invocation lifetimes. Runtime construction,
invocation and capture glue use the exact environment type and original body instance, as
recorded in the [Step 8 coverage receipt](docs/step8-callable-sweep.md).

### Complete caller-region canonicalization

Selected applications retain exact lifetime evidence. Canonicalization first collects the entire
ordered application, enclosing scopes, static aggregate types, and provider inputs in their existing
D2 order. Declaration parameters, invocation binders and static remain rigid. Caller Local and
Supplied atoms receive one injective frozen map across all roots, so both sharing and incidence in
unordered meets survive alpha renaming. Ordered incidence is a proved fast path; unordered structural
correlations select the least complete exact record over all injective maps. Runtime encodings keep
lifetime erasure and canonical set order unchanged. Pure renaming preserves authenticated erased
callable caches and normalized requirement-row structure; actual substitutions continue through
ordinary owning factories. Frozen candidate traversal charges the same structural budget as collection;
it does not rerun semantic row normalization or quantified key comparison.

One complete transaction permits 32768 structural/work units, 65536 attempted search states, and
8388608 copied/produced/compared record bytes. Failed branches consume their budget. Cycles,
exhaustion and atoms absent from collection fail canonicalization without publishing a key. The
requesting semantic body or invocation anchors `Unsupported` at its authentic source origin;
generated query caches retain a source-neutral refusal. Bare named declarations have an empty
region domain and require no renaming search. Glue identity uses an original owning declaration;
union children select the least declaration record under the same bounded transaction.

Public `demandInstanceMir`/`demandInstanceText` requests provide an authentic source owner and span
separately from the instance key. A root request with the zero-span sentinel resolves that owner's
original authored header before publishing a canonical refusal. Reached call requests use the caller's
actual call span; generated glue edges carry their originating cleanup request through child glue and
hooks. These requesting coordinates never enter cached key identity or source-neutral failure facts.
Nested application encoding charges owned declaration snapshots before allocating them, including
failed copies after record-budget exhaustion. These source guarantees still require focused execution;
this source change makes no N0/N1 completion claim.
