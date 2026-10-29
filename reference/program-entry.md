# Program entry

A build selects a source runtime, an application module, foreign exports, and optional retained
functions. Loader entry selection is independent. The compiler treats application calls as ordinary
Silk calls; it has no specially shaped `main` declaration or generated invocation adapter.
See [artifact roots and native requirements](artifact-roots-and-requirements.md).

## ENTRY-001 — Runtime source chooses a visible application function

**Status:** Confirmed

A selected runtime imports `Intrinsic.application`. That binding resolves to the canonical application
module with ordinary visibility rules. Source runtime code chooses which function to call, passes
arguments, and handles its result. A runtime descriptor names the runtime module, without an
`invoke` field. Foreign C exports and explicit retained declarations seed runtime reachability.

The installed executable defaults call public `app.main`. A custom runtime may choose another
visible function, including one with parameters. The name `main` has no compiler privilege.

```silk
import Intrinsic.application
export "C" fn enter() -> i32 as "main" { return application.answer(42) }
```

**Diagnostics:** Missing or private application members, invalid arguments, and unsupported results
are ordinary source errors at the runtime import or call. Explicit libraries, objects, and
runtime-none profiles acquire no default startup or execution-storage component.

## ENTRY-002 — Source startup owns execution

**Status:** Confirmed

The hosted executable default is `silk/platform/native/start`. Its source C `main(argc, argv)` snapshots
process inputs, creates a bounded lexical diagnostic observer, owns an Execution, and drives the
application to completion. It accepts ordinary integer or unit results, or an Effect producing unit
with no requirements or one mutable HostInput requirement. The HostInput requirement is satisfied
by an ordinary source provider backed by the owned snapshot.

The standalone WebAssembly default is `silk/platform/wasm/start`. Its C export is `main() -> i32`; it owns an
Execution and accepts integer, unit, or requirement-free Effect-unit results. It installs no native
host-input provider or diagnostic reporter and publishes no `silk_main` adapter.

The WASI command default is `silk/platform/wasi/start`. Its `_start() -> ()` export owns an Execution and
accepts integer, unit, or Effects producing either result, with no requirements or one mutable
HostInput requirement. It supplies an owned snapshot of WASI arguments and environment, finishes
cleanup, then exits through WASI. See [WASI targets](wasi.md).

These source runtimes require a NonParking application body. Nested transfers complete inside their
Execution; external parking requires a custom source runtime with an explicit scheduling policy.
An unexpected suspended completion is handled as a startup failure rather than silently completing.

**Diagnostics:** The selected source runtime's interface and NonParking obligations are checked
through ordinary specialization. No compiler entry-shape diagnostic or implicit scheduler exists.

## ENTRY-003 — Source policy handles unhandled outcomes

**Status:** Confirmed

Hosted startup accepts an Effect `main` only when each of its errors implements `Debug`. It keeps
the `Debug` form of an unhandled owned typed-failure payload, drops the payload, and then observes
its diagnostic context. Its bounded source reporter preserves the primary identity and available
origin/path/cause information, followed by that form. Reporting allocation refusal or write failure does not replace the application failure.
Unhandled typed failure and startup failure return status one. Unit and Effect success return zero;
an ordinary integer result is the returned status.

Standalone Wasm drops an unhandled typed-failure payload and returns one without host reporting.
WASI startup follows the same failure policy and passes status one to the host's exit operation.
Fatal traps remain abnormal termination and promise no cleanup; without a lexical source observer,
Wasm retains bare machine traps. A custom source composition may define its own status and reporting
policy using the same ordinary Effect, ownership, observer, and foreign-boundary operations.

**Boundary:** Diagnostic metadata travels through lexical observers and owned outcomes. No generated
C report policy, process-global failure state, or compiler-owned fixed report buffer is involved.

## ENTRY-004 — Source composition resolves application requirements

**Status:** Confirmed

Requirement rows retain ordinary Effect meaning. Hosted default startup supplies only its documented
mutable HostInput contract. It does not infer other services from the operating system. Applications
resolve remaining requirements through ordinary source providers, or select a custom runtime whose
source performs the required composition. Standalone Wasm defaults require a closed application
Effect and do not provide native services.

WASI default startup supplies HostInput. Filesystem, stream, clock, and random services use explicit
WASI providers; access remains subject to the capabilities granted by the host.

Runtime-none and library artifacts may retain ordinary functions with their own signatures; they
have no implicit application execution or entry-result conversion. Foreign export contracts still
apply independently at the C boundary.

## ENTRY-005 — Foreign exports define the platform entry ABI

**Status:** Confirmed

Hosted native startup uses the platform C entry ABI and libc startup. Standalone Wasm exports a
zero-parameter C `main` returning `i32`. `silk build --target wasm32-unknown-unknown` links that
module freestanding on any host: no libc and no start function, the compiler's C runtime beside the
program, and exports for exactly the C exports source names plus the linear memory. A
multi-threaded profile instead imports a shared memory and also exports `wasi_thread_start`
(THREAD-009 in [thread properties](thread-properties.md)). Raw Linux startup instead selects its
source `_start`, reads the validated initial stack, calls the application, and terminates through
the kernel; see [raw Linux](raw-linux.md).

WASI Preview 1 exports `_start` and imports `wasi_snapshot_preview1` operations. Preview 2 links
that core ABI with the standard command adapter into a component exporting `wasi:cli/run`.
The adapter and application share the core module's allocator through `cabi_realloc`.

Custom runtimes define their own C exports and loader entry according to the selected artifact and
target contracts. The compiler preserves those exports and validates their ABI, while source calls
and interfaces implement application adaptation. Empty libraries and retention-only objects are
valid and need no C export or loader entry.

**Evidence:** hosted startup conformance,
execution storage conformance,
and raw Linux conformance.
