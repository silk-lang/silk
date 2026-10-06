# Synchronous source startup

`silk/native_start_sync` is an explicitly selected hosted runtime for Darwin ARM64 and GNU Linux
x86-64/ARM64. Its application contract is an i32 Effect requiring shared or mutable `HostInput`.
It does not replace the default `silk/native_start`, whose six ordinary result adaptations and owned Execution
and diagnostic observer remain available.

Select the module through ordinary source composition, for example a runtime named `synchronous`
with module `silk/native_start_sync`. The compiler resolves `Intrinsic.application` to the selected
application module. The runtime exports C `main(argc, argv)` in source; no function or wrapper
spelling selects a compiler-generated invocation policy.

Startup creates the ordinary system allocator provider and uses it only to capture owned
`NativeHostInput` arguments and environment. It moves the snapshot into `OsHostInput`, creates a
mutable local host, and lends `&mut host` through `Effect.provideMut<HostInput>`. That loan ends before
the local provider releases its snapshot. Working-directory requests use the existing ordinary
provider and observe the directory at the time of each request. Applications supply any other
services themselves, including the allocator required by lookups returning owned bytes.

`Effect.provideMut<HostInput>` supplies either `&HostInput` or `&mut HostInput` through ordinary
service binding (SERV-006). The exclusive provider loan satisfies shared access as well as
exclusive access. No nominal selector or compiler privilege constrains the application. A closed
row, additional unsatisfied requirements, unsupported result types, and parking are rejected by
the source calls and the `NonParking` bound.

The application status passes through unchanged. Both initialization and application typed failures
use an ordinary generic `Effect.catchAll` callback that drops the owned error and returns one. There
is no Execution, scheduler, diagnostic observer, report policy, or compiler-owned root provider in
this composition. An ordinary `Intrinsic.NonParking` callable bound checks the complete application
call. Fatal traps promise no cleanup.

The dedicated `SourceSynchronousStartup` tests explicitly select this runtime, verify the source
module closure, and execute its C entry. A C boundary audit checks owned input bytes after foreign
mutation, per-call cwd reads, success status, exactly-once affine failure-payload cleanup, complete
provider release, partial capture failure, invalid argc, and deterministic capture allocation
refusal. The application examples also run under the unchanged full hosted runtime in the shared
native corpus; those default-runtime regressions are separate from the explicit composition proof.

The installed module is registered in the stdlib manifest and generated source catalog. Parser and
HIR source corpora discover stdlib `.silk` files recursively; formatter verification discovers
tracked `.silk` files. They include this source without a second fixed file inventory.

This source work lands on `main`, passes exact-head CI, and reaches `selfhost` through a main sync.
It does not remove the native compiler's generated entry. Ordinary plain-i32 source adaptation is
the separate follow-up [#931](https://github.com/julia-script/silk/issues/931); source selection and
native adapter removal must wait for both source contracts to be integrated and validated. Native
suspension and full observer support retain their separate implementation obligations.
