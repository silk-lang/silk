# Source execution storage conformance

These probes test `silk/execution_storage` through ordinary C exports and verify
compiled suspension lifecycles through the selected component. Complete admission
is tracked in JUL-129 and the active OpenSpec change.

Build the compiler first. Native runs use the same explicit LLVM 22.1.8 tools,
SDK/sysroot, GCC support directory and execution image variables as
`conformance/native-process/NativeProcessConformance.test.mjs`. Header hashes are checked against
`openspec/changes/archive/2026-09-10-complete-native-runtime-migration/storage-supplies.json`.

```sh
node packages/compiler/conformance/execution-storage/run.mjs
SILK_STORAGE_FAULTS=true node packages/compiler/conformance/execution-storage/run.mjs
```

Both commands compile debug and optimized lanes. `layout.c` independently checks
record layout and declares the four operation signatures. The normal C caller
checks independent state, aligned reservations, non-LIFO release and zero,
overflow and invalid-alignment refusal. The fault caller interposes malloc/free,
refuses each of five state/frame allocations in turn and checks that every
successful allocation is released exactly once. Native objects must reference
the declared allocator and must not reference the obsolete frame bridge.

The normal native runner also compiles the shared latched-destruction, multiple-package
and non-LIFO fixtures through explicit storage-component bindings. An independently
compiled C main invokes each ordinary source export and checks its result. Each
fixture runs in both optimization modes on the selected native target; GNU lanes
execute in the pinned architecture-specific container. These probes exercise the
compiler frame ABI as well as the provider ABI. Suspending foreign exports remain
forbidden: the exported fixture synchronously drives an owned Execution.

The multiple-package receiver also interposes malloc/free with an allocation ledger.
It repeats the fixture with one nested library invocation at each readiness, registration,
suspension or completion callback in turn. Nested invocations must complete, release all their own
allocations exactly once, and leave every live outer allocation byte-for-byte
unchanged. The outer invocation then resumes its two packages and must release all
remaining allocations once. The sweep covers reentry while packages are active, parked and completing without
assuming a fixed callback count. This replaces the previous result-only C receiver for that fixture.

The freestanding Wasm probe needs only `SILK_SUPPLY_CLANG` pointing to Clang
22.1.8 with its Wasm linker:

```sh
node packages/compiler/conformance/execution-storage/wasm.mjs
```

It compiles the source provider and an independent C caller/allocator separately,
links without a standard library or undefined-symbol allowance, rejects any
module imports, and executes the C probe in Node. Both optimization modes verify
32-bit C widths, record layout, alignment, isolated state, non-LIFO release and
all five allocation failure points. This probe deliberately supplies its own
allocator to prove the provider ABI independently of the compiler's Wasm runtime.

The Wasm runner also compiles transient suspension, latched destruction, multiple
Execution packages and non-LIFO completion in both modes, rejects host imports and
checks their pinned results. Explicit source components that refuse state creation
or frame acquisition must produce a Wasm runtime trap in both modes. The owned Execution fixtures are shared with the
native acceptance corpus. Each Wasm artifact and digest is retained separately.
These end-to-end lanes use the existing linear-memory allocator, whose free
operation does not reclaim the underlying heap; the source component still
releases reservations and accounting through the shared ownership contract.

Reports, bitcode, objects, source, disassembly and executable artifacts are retained
under `.scratch/execution-storage`. Required platform CI runs all three commands
and uploads the directory. Local results do not substitute for observing CI.

The allocator interposer only records allocations and releases. It never initiates
reentry: an allocator that itself requires execution storage would violate the
bootstrap contract. Reentry occurs through ordinary source callbacks.

The same ledger and callback reentry sweep now cover latched cancellation and a
suspended typed-failure variant of the multiple-package program. The failure variant
parks before failing, recovers outside that suspended body, and completes alongside
a second package. Thus the receiver checks release after propagation as well as
normal completion and dropping a parked Execution. The variant is derived from the
shared multiple-package source; the runner fails if its designated body no longer
matches, and retains the exact generated fixture in each lane's evidence.

Every invoked Wasm export must have zero parameters. Source-entry lanes also reject
LLVM's synthetic `__original_main` export, which would reveal C main signature
rewriting even when JavaScript silently supplies missing arguments.

The independent Wasm probe additionally compiles the same instrumented cancellation,
completion and suspended-failure fixtures with the counting/reentry receiver. Its
freestanding C memory operations replace libc dependencies, while the receiver owns
malloc/free and checks every release. These six debug/optimized probes link without
host imports or the generated Wasm allocator. Native and Wasm share LifecycleFixture's
checked source transformation. The ordinary Driver lifecycle/refusal lanes remain
separate and continue checking the admitted default Wasm path.

The same command verifies the installed standalone source startup with integer, unit,
Effect-unit, captured suspended Effect and suspended typed-failure applications in both
modes. It invokes the source C `main` export, rejects all host imports and the retired
`silk_main` export, and checks status conversion. A failure payload whose destructor
traps distinguishes payload cleanup from simply returning failure status; a separate
bare-trap application checks the no-observer machine-trap policy. These cases do not
claim command/reactor initialization or structured embedded reporting support.
