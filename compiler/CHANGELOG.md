# Changelog

Auto-generated from `.changes/releases/*.toml`. Manual edits are overwritten on the next release; edit the authoritative TOML files instead.

## 0.1.0

### Minor

Interface and service operations can have default bodies. An operation written with a body is its default: a conformance that leaves the operation out uses that body, and one that implements the operation replaces it. An interface default can call the interface's operations on `Self`; a service default calls the service's operations with `run`, and those reach the same provider. A default body is checked where its contract is declared, even when nothing uses it.

#### Migration

Migration notes not provided

Rename the growable Vector collection to List throughout the standard library and native compiler.

#### Migration

Import List from silk.list instead of Vector from silk.vector. Replace Vector type annotations and calls with List. The old type and module are removed; collection operations and storage behavior are unchanged.

`silk toolchain install` and `silk toolchain use` accept `latest` (the newest stable release, or the newest release while there is no stable one) and `dev` (the newest release of any kind); `use` pins the full version the alias names. Concurrent installs now wait on a lock in `$SILK_HOME` instead of downloading the same release twice, and the GitHub release listing is retried when it fails or comes back empty.

#### Migration

Migration notes not provided

A structural union now conforms to an interface when every member implements it and every operation of the interface receives `self` by `&Self` or `&mut Self` and names `Self` nowhere else (UNION-003). Calls on the union read its tag and forward to the active member's implementation, and method syntax such as `value.describe()` works too, so `{:?}` works on an error union such as `JsonError | OutOfMemoryError` when each member is `Debug`. An interface that names `Self` elsewhere, or a member without the conformance, is rejected with SEM0121 and a note on the operation that blocks dispatch.

#### Migration

Migration notes not provided

Add check roots for the language server: `Semantic.checkModule` checks one root module and `Semantic.checkDeclaration` one declaration, with the same rejections `checkDeclarations` reports for them, and `Semantic.checkForeignConflicts` the foreign symbol conflicts between modules. `silk check --roots` checks the package again through them and reports any rejection only one side reached.

#### Migration

Migration notes not provided

`silk lsp` answers document symbols (the outline of types, `impl`s, methods and functions), folding ranges (multi-line bodies, lists and literals, and comment runs) and whole-document formatting through `silk format`'s formatter.

#### Migration

Migration notes not provided

Prepare stable compiler releases through a maintained release PR, and publish daily or manually triggered dev builds without consuming pending changes.

#### Migration

From the virtual workspace root, select the package explicitly with silk changes --dir compiler. The stable release PR collects open changes into authoritative TOML history and the generated changelog; merging that PR publishes the stable release after verification. Dev builds snapshot the changes at their exact source commit without editing those files. Daily and manual dev publication share one version reservation and skip already published source commits. The changes library remains a separate workspace member; release coordination for multiple packages is not yet automatic.

Do not edit the managed release branch, PR title, or description; add review comments instead. Refreshes refuse detected human edits, and interrupted metadata publication is repaired without creating another release commit.

Dev reservations use internal Git refs rather than public tags, so failed publication attempts do not appear as releases. The retained n0 seed is now pinned at `v0.1.0-dev.1+5081812`; its download names and seed coordinates changed, but its verified compiler bytes did not.

`silk.execution` adds handles that may move between threads. `Execution.makeTransferable` takes a `Transferable` body and result and a `Transferable` and `Concurrent` readiness endpoint, and returns a `TransferableExecution<A>`. Its body parks with `Execution.parkTransferable`, whose `TransferableWake` can be signaled from any thread with `Execution.wakeTransferable`. `TransferableExecution.local` and `adopt` convert to and from the handle `Execution.drive` takes. Adopting or parking transferably in a package made by `Execution.make` is a fatal trap.

#### Migration

Migration notes not provided

Adds SIMD lane operations (SIMD-004, SIMD-005): wrapping, saturating, shift, rotate, minimum, maximum, square root and fused multiply-add lane arithmetic; checked, wrapping and unordered sums and the minimum, maximum and bitwise reductions; mask any, all, count, first-set and bit conversions; bounds-checked slice loads and stores with unsafe pointer forms; and lane-wise numeric conversion and bit casts. Each traps where its scalar form traps.

#### Migration

Migration notes not provided

`silk` now runs the toolchain a project pins: when `silk-version` (or `silk +<version>`, `SILK_TOOLCHAIN`, or the default in `$SILK_HOME/settings.toml`) selects another installed version, the command runs in that toolchain. A pinned version that is not installed exits with status 3 and prints the command that installs it. Locally built compilers follow only `silk +<version>`, and `SILK_TOOLCHAIN=local` keeps any compiler on itself.

#### Migration

Migration notes not provided

`silk lsp` in a project whose pinned toolchain is not installed starts a server that answers `initialize` with no capabilities and shows the install command as an error message, instead of exiting, so editors that only spawn `silk lsp` explain the problem.

#### Migration

Migration notes not provided

Run native threads on wasm32: a project profile with `target = "wasm32-unknown-unknown"` and `threading = "multi"` links a shared-memory wasi-threads module, `maxMemory` sets its memory limit (1 GiB by default), and `stdlib/host/wasm-runner.mjs` runs it in Node or a browser.

#### Migration

Migration notes not provided

`silk.thread_pool` runs tasks in parallel on a work-stealing pool of native threads. `ThreadPool.make` starts the workers, `Pool.spawn` starts a `Transferable` lazy effect as a task and returns a `TaskHandle` whose `join` parks the caller until the result is ready, and `Pool.block` runs a task from an ordinary thread. Parked tasks resume on whichever worker is free, and idle workers steal work from busy ones.

#### Migration

Migration notes not provided

`silk.format` templates take `{1}` to name a tuple field, so one field can show more than once, and take a width or precision from a `usize` argument with `1$` or `w$`, as in `{:>w$}` and `{:.1$}`. `List` implements `Debug`, and the `Debug` form of a whole float ends in `.0`, as `1.0`.

#### Migration

Migration notes not provided

wasm32 executables now reuse freed memory: the linked runtime replaces its bump allocator with one that bins, splits and coalesces freed chunks, and joining a native thread returns its stack to the heap.

#### Migration

Migration notes not provided

Slices implement `Debug` and write their elements, as `[1, 2, 3]`. A fixed array, an anonymous tuple, and an anonymous record have a `Debug` form wherever they are a `{:?}` argument of `Format.format` or a field that `Format.debugFields` writes: `[1, 2]`, `(1, "a")`, and `{ x: 1 }`.

#### Migration

Migration notes not provided

`silk check --replay <script>` replays a TOML script of source edits against a revisable semantic store and prints, for each edit, the demands, memo hits, units run and dependency-graph invalidations it caused, with its wall time. It is the measuring tool for incremental compilation.

#### Migration

Migration notes not provided

Add `silk lsp`, a language server skeleton that speaks JSON-RPC over standard input and output on a transport thread and a compiler thread. It handles `initialize` (negotiating UTF-8 positions when the client offers them), `initialized`, `shutdown` and `exit`, and answers every other request with MethodNotFound.

#### Migration

Migration notes not provided

Native threads can now share values. `silk.sync` adds `Arc<T>`, a reference-counted handle with an atomic count, `Mutex<T>`, a futex lock whose guard borrows the value, and `Parker` with `Unparker`, a one-token sleep another thread can end. They rest on the unsafe anchored borrows `Intrinsic.pointerBorrow` and `Intrinsic.pointerBorrowMut` (`Pointer.borrow` and `Pointer.borrowMut`), which turn a raw pointer into a reference that lives exactly as long as the caller's loan of an anchor. `NativeThread.processorCount` and `NativeThread.yieldNow` are new as well.

#### Migration

Migration notes not provided

Adds the `silk.simd` standard-library modules: one module per vector shape, such as `silk.simd.u8x16` and `silk.simd.f32x8`, for every lane type at 128 and 256 bits, and `silk.simd.mask2` to `silk.simd.mask32` for masks. Each module wraps the SIMD lane operations with documented, checked functions.

#### Migration

Migration notes not provided

`silk lsp` answers hover, go to definition, inlay hints and signature help from its checked store. Hovering a declaration shows its header and doc comment, a binding or field shows its type, and any other expression shows its type. Go to definition jumps to a declaration in any module, to a binding, or to a generic parameter. Each binding whose type was inferred gets a `: Type` hint, and the arguments of a call get its signature with the current parameter active.

#### Migration

Migration notes not provided

Introduce native changes and migration history for Silk packages and the compiler, including immutable dev snapshots and updated migration guidance.

#### Migration

Add one change file per contribution with silk changes add and describe API, behavior and default changes with --migration. Keep its generated filename stable: that identity follows the note into release history. Stable releases commit authoritative .changes/releases/*.toml records and regenerate CHANGELOG.md; manual Markdown edits are overwritten. Published changes-snapshot.toml assets capture exactly the changes included in each release, not later edits on main. Before upgrading, run silk changes since for the compiler or silk changes since DEPENDENCY for an installed library. Use --to VERSION to select an exact target. Unchanged dev notes are not repeated on stable promotion; revised notes are shown as updated guidance. Update package.silk-version only after migrating and verifying the project.

Automatic dev discovery requires the new positive-counter and 12-character hexadecimal commit format. Legacy bootstrap tags are retained for reproducibility but do not outrank new dev snapshots.

`Writer.writeVectored` has a default body that calls `writeAll` once for each slice, so a provider with no faster way to write several slices leaves it out. `Writer.writeEach` is removed: delete a `writeVectored` that only forwarded to it. Providers with a lifetime parameter, such as `Filler<'a>`, get the default too.

#### Migration

Migration notes not provided

Add `silk toolchain install [version]`, which downloads a release from GitHub (or the directory `SILK_TOOLCHAIN_MIRROR` names), checks its minisign signature, trusted comment and compiler SHA-256, and installs it into `$SILK_HOME/toolchains`. Without a version it installs the one the project pins. With `SILK_AUTO_INSTALL=1` or `auto-install = true` in `$SILK_HOME/settings.toml`, a command that needs a missing pinned toolchain installs it first.

#### Migration

Migration notes not provided

Vectors cross the C boundary. A `simd<T, N>` with fixed-width integer or floating-point lanes may be a parameter or result of an `extern "C"` or `export "C"` function, and passes in one vector register the way C vector types do: 128 bits on every target, 256 bits on x86-64 with `avx` and 512 bits with `avx512f`, and 64 bits on AArch64. A width the target's C ABI does not pass that way, or one that needs a CPU feature the profile does not select, reports SEM0244.

#### Migration

Migration notes not provided

Adds the SHA-256 instructions to the architecture operations: `sha256rnds2`, `sha256msg1` and `sha256msg2` on x86-64, under the new `sha` feature that `silk.cpu` detects, and `sha256h`, `sha256h2`, `sha256su0` and `sha256su1` on AArch64. `silk.arch.x86` and `silk.arch.aarch64` wrap them with portable fallbacks.

#### Migration

Migration notes not provided

Add `silk toolchain list`, `which`, `default` and `uninstall` for managing compiler toolchains installed under `$SILK_HOME/toolchains`, and `[workspace].silk-version` for pinning a workspace's compiler.

#### Migration

Migration notes not provided

`silk lsp` now keeps the documents a client opens in sync (full text sync through `didOpen`, `didChange` and `didClose`) and publishes their syntax diagnostics. Open documents are laid over the files on disk in a revisable store per package; a burst of edits is analyzed once, before the next request or when the input goes quiet, and an edit that changes only trivia runs no semantic work.

#### Migration

Migration notes not provided

`install.sh` installs into the toolchain layout: the release goes to `$SILK_HOME/toolchains/<version>` (`SILK_HOME` replaces `SILK_INSTALL`, default `~/.silk`), `$SILK_HOME/bin/silk` links to it, and `settings.toml` makes it the default. Earlier toolchains stay installed. An install in the old layout is not migrated: its `bin/silk` is replaced by the link, and its `lib/silk` and `release` files stay until removed by hand.

#### Migration

Migration notes not provided

Add repeated fixed-array expressions [value; count], with compile-time counts, single operand evaluation, Copy checking, and static execution.

Counts retain enclosing static locals, selected static parameters, and static-for bindings inside static initializers. Missing counts preserve following declarations during parser recovery.

#### Migration

Use [0; N] instead of manually listing zeroes. Counts follow fixed-array length rules; counts above one require Copy. Zero counts still evaluate and discard the operand.

Package parameter values move to a typed `[config]` table. A key is the root module's path and the parameter's name, and the value is plain TOML checked against the parameter's declared type: `[config]` with `main.limit = 42` replaces a `[[build.bindings]]` entry with its `package`, `module`, `parameter`, tagged `value` and `origin`. A profile sets its own values with `config.main.limit = 8` in `[profiles.<name>]`, and they win over `[config]`. A refused value is reported at the line of its key.

#### Migration

Rewrite each `[[build.bindings]]` entry as a line under `[config]`, and each `[[profiles.<name>.bindings]]` entry as `config.<module>.<parameter>` in that profile: `value = { kind = "integer", value = "8080" }` for `parameter = "port"` in module `main` becomes `main.port = 8080`, and an array value becomes a TOML array. `build.bindings` and a profile's `bindings` are refused at their line, naming `config`. `--profile-input` JSON keeps the tagged `bindings` transport.

Adds `Intrinsic.simdShuffle`, which builds a vector from the lanes of two vectors chosen by a static index array (SIMD-006). Out-of-range indices, mixed lane types and runtime indices are rejected at compile time.

#### Migration

Migration notes not provided

Adds `silk.byte_search`: `find`, `findLast`, `find2`, `find3`, `count` and `findSlice` over byte slices. They compare sixteen bytes at a time where the CPU has 128-bit vectors, which makes `find` about eight times faster than a byte loop on long inputs, and fall back to a plain loop elsewhere.

#### Migration

Migration notes not provided

A slice can provide an interface, as `string` and the scalars do: `impl<'a, T: Debug> Debug for &'a [T]`. `&[T]` and `&mut [T]` are separate providers, and only the interface's module can declare such a conformance. Where a reference is expected, such as an interface receiver `&Self` or a generic `&T` parameter, `&s` for a slice `s` now borrows the slice itself (`& &[T]`) instead of reborrowing its elements. `Reflect.typeKind` answers for every type: fixed arrays are the new `arrayKind` and every other non-aggregate type is `otherKind`, so a generic body can branch on any type parameter.

#### Migration

Migration notes not provided

The Execution package protocol is now safe when a Wake is signaled from another thread. The compiler accesses the package's authority count, lifecycle and notifying marker atomically, and the control-word operations become an acquire `executionLoad`, a release `executionStore` and a new `executionCompareExchange`. `silk.execution` packs the park generation and readiness phase into one control word, moves between phases only by compare-exchange, and publishes `Eligible` before it runs the readiness endpoint. A notification that races a drop now runs nothing instead of trapping. Handles stay local: none is `Transferable` yet.

#### Migration

Migration notes not provided

Optional services: an effect can require `&Option<&S>` and branch with `withSome<&S>(absent, present)` from `silk.option`. `Option<P>.some(provider)` serves it as present, `Option<never>.none()` as absent, and `provideSome<&S>(effect, &provider)` lifts a borrowed provider. `never` now conforms to every service, and a provision inside a generic function is decided when `R in Without<R, S>` keeps the selected key out of the rest of the row.

#### Migration

Migration notes not provided

Silk programs can now start native threads. `silk.native_thread` adds `NativeThread.spawn`, which runs a detached `Transferable` closure on a new `pthread_create` thread, and `JoinHandle.join`, which returns its result; an unjoined handle waits for its thread when dropped. Two compiler additions support it: the foreign property `Intrinsic.foreign(threadCallbacks: (...))` admits a reference-free export address that native code may invoke on another thread, and the unsafe `Intrinsic.pointerTake` (with `Pointer.take` and `Pointer.put`) moves a non-`Copy` value out of and into raw storage.

#### Migration

Migration notes not provided

`silk changes` moves into the silk tool as `silk change`, and `silk change patch|minor|major "Summary"` replaces `silk changes add`. The other subcommands (`status`, `version`, `release`, `snapshot`, `since`, `recover`) are unchanged. The compiler no longer has a `changes` command and no longer links the changeset package. A manifest's release settings now live in `[release]`. `[changes]` stays readable as its earlier spelling until the repository's own manifests move after the next seed, and a manifest that writes both is refused. Generated version modules now say `Auto-generated by silk change version`.

#### Migration

Migration notes not provided

Struct fields must be separated by commas, as union variant fields are; a trailing comma is still allowed. A field list separated by line breaks alone now reports a missing `,` (PAR0001). Rewrite such a declaration by adding a comma after each field.

#### Migration

Migration notes not provided

Silk versions now belong to the silk tool, the front door that ships beside the compiler, which is now `silkc`. `silk use` installs the version a project pins, `silk use <version>` installs a version and makes it your default, `silk set <version>` pins the project, and every other command, such as `silk build`, runs unchanged in the selected version's `silkc`. The compiler no longer chooses or installs toolchains: it has no `toolchain` command or `+<version>` argument, and `silkc` started directly always runs itself.

#### Migration

Migration notes not provided

A `silk build` or `silk check` over several packages or targets shows one line per finished unit on a terminal, with a `[2/5]` live line for the running one, and ends with `Finished 3 packages` or `Failed 1 of 3 packages` on standard error instead of the `Package` headers and `Workspace summary` on standard output.

#### Migration

Migration notes not provided

A manifest profile can set `cpu = { model = "native" }` to build for the machine running the compiler: Silk asks the CPU through `silk.cpu` and adds each feature it has to the profile's feature list, so the profile still names a concrete set. Only the compiler's own target can be native. The x86-64 feature table in the profiles reference now lists `sha`.

#### Migration

Migration notes not provided

Adds per-function CPU features. `with Intrinsic.machine(features: ("avx2",))` on an `unsafe fn` compiles that function for the listed CPU features and their implications, and admits the architecture operations they enable, so a program can pick a kernel at run time with `silk.cpu`. An unknown feature reports SEM0242 and a safe function with `features` reports SEM0243. Vectors wider than 128 bits and masks of more than 16 lanes now cross Silk function boundaries through memory, so functions compiled with and without AVX agree on how they are passed.

#### Migration

Migration notes not provided

Show live compilation progress for `silk build` and `silk check` on standard error: on a terminal one status line redraws with the current phase, counts and elapsed time, then each phase (load, check, codegen, borrow, link) leaves a summary row with its time and a final Finished or Failed line. Piped output gets the same rows as plain lines. `--progress auto|live|plain|never` (or `SILK_PROGRESS`) chooses the display, `--quiet`/`-q` keeps only the final line, and `NO_COLOR` turns colors off.

#### Migration

Migration notes not provided

Add `silk.arena`, an arena allocator that takes its chunks from another allocator, in the style of Zig's `ArenaAllocator`. `Arena<A>` is itself an `Allocator`, so any container can allocate from it. Each chunk counts its live allocations, so an allocation may outlive the arena, move to another thread, or be dropped early, and the chunk returns to the child when its last allocation and the arena are both done with it. `reset` hands every chunk back or keeps an empty one for reuse.

#### Migration

Migration notes not provided

Add the unsafe `Intrinsic.allocationAdopt(base, layout, reclaim, context)`, which builds an `Intrinsic.Allocation` over storage the caller proves valid. Dropping such an allocation calls `reclaim(context)` once, from whichever thread drops it, instead of releasing system storage, so source allocators can hand out allocations that every container already accepts.

#### Migration

Migration notes not provided

Give published compiler builds one exact version across the executable, initialized projects, release tags and native archives, with commit-identifiable dev releases.

#### Migration

Dev versions use the upcoming stable core, a monotonic counter and source metadata, for example 0.1.0-dev.2+a1b2c3d4e5f6. The full commit is recorded in the release snapshot and immutable build receipts; retries do not allocate another version for the same commit. Stable 0.1.0 remains reserved for announcement. The committed 0.0.0 baseline marks an unreleased history floor, not a published stable compiler. Use SILK_CHANNEL=dev for dev installation or SILK_RELEASE=vVERSION for an exact release; automatic installation uses dev when no stable release exists. Older development binaries reported 0.1.0 without reliably identifying their source. Use --from 0.0.0 to review the initial recorded changes rather than treating those old versions as a reliable upgrade baseline.

`silk build --target wasm32-unknown-unknown` now links a WebAssembly module on any host. The module carries a small freestanding C runtime (allocator and byte routines), has no host imports, and exports only the C exports source names, such as `main`, plus its memory.

#### Migration

Migration notes not provided

Adds AES rounds and carry-less multiplication to the architecture operations: `aesenc`, `aesenclast`, `aesdec`, `aesdeclast`, `aesimc` and `pclmulqdq` on x86-64, and `aese`, `aesd`, `aesmc` and `aesimc` on AArch64. `silk.arch.x86` and `silk.arch.aarch64` wrap them on 16-byte states, falling back to the new `silk.arch.aes`, which computes SubBytes, ShiftRows, MixColumns and their inverses with portable constant-time code.

#### Migration

Migration notes not provided

Add `silk.blake2b` (BLAKE2b-512, RFC 7693) and `silk.ed25519` (Ed25519 signature verification, RFC 8032) to the standard library.

#### Migration

Migration notes not provided

`silk.work_queue` adds queues that move owned values between native threads. `WorkDeque` is a Chase-Lev work-stealing deque whose `Worker` pushes and pops at the bottom while `Stealer`s take from the top, `Injector` is a shared FIFO queue under a `Mutex`, and `Mailbox` is a lock-free multi-producer, single-consumer queue with `MailboxSender` and `MailboxReceiver` handles.

#### Migration

Migration notes not provided

Reworks the `silk.toml` layout before 0.1.0. `[package].source` (default `src`) and `[package].main` (default `main.silk`, or `lib.silk` for a library) replace `root` and `source-root`; `[package].kind` replaces `[build].artifact` and adds `library`, Silk source that `silk build` checks without making an artifact; `version` defaults to `0.0.0`; names may use `_`, and `self`, `silk` and `silkc` are reserved package and dependency names. Native link inputs and the platform supply move to `[native]`, the runtime composition to `[unstable]`. Publishing metadata (`description`, `license`, `repository`, `homepage`, `readme`, `authors`, `keywords`) and `[tool.<name>]` are accepted; `[dev-dependencies]`, `[target]`, `[lints]`, `[test]`, `[bench]`, `[bin]`, `package.include` and non-path dependency sources are refused as not supported yet. Profiles default to the host target, use kebab-case keys, and `dev` and `release` are built in. A dependency's `silk-version` now names the release line it was written for: same minor before 1.0, same major after, and a dev release only matches itself. `silk init` writes the new layout.

#### Migration

Rename `[package].root` to `main` (now relative to `source`, which defaults to `src`), `[package].source-root` to `source`, `[build].artifact` to `[package].kind`, `[build].native-link-inputs` to `[native].link`, `[build].platform-supply` to `[native].platform-supply`, `[build].composition` to `[unstable].composition`, and profile `maxMemory`/`codeModel` to `max-memory`/`code-model` (`--profile-input` JSON keeps `codeModel` and `maxMemory`). The earlier spellings are refused at their line, with a message naming the replacement. A dependency's `silk-version` must now share the compiler's release line.

`silk build`, `silk check` and `silk run` no longer print `Compiled ... -> ...`, `build llvm/<target>: ok`, `check <target>: ok` or the build and check summaries on standard output: the progress report on standard error names each artifact and result instead.

#### Migration

Migration notes not provided

The compiler now emits wasm32 objects: direct C calls with scalar and pointer lanes are admitted on wasm32, and a data address converts to and from `usize` there. C statics, variadic tails and callback lanes stay refused on wasm32.

#### Migration

Migration notes not provided

`silk build --timings` and `silk check --timings` list the five slowest modules to check, bodies to borrow-check and functions to emit before the final `Finished` line.

#### Migration

Migration notes not provided

Adds architecture SIMD operations: a typed catalog of x86-64, AArch64 and wasm32 instructions that the portable vector operations do not express, such as `pshufb`, `pmaddubsw`, saturating packs, `psadbw`, `tbl`, `udot`, `addp`, `i8x16.swizzle` and the saturating narrows. Each operation is checked against the profile's target and CPU features and reports SEM0241 when they are missing. `silk.arch.x86`, `silk.arch.aarch64` and `silk.arch.wasm` wrap them in functions that use the instruction when the build enables it and compute the same lanes with portable code otherwise.

#### Migration

Migration notes not provided

Add `silk.http_client`, a short way to make HTTP requests: an `Http` service, a chained `Request` builder (`Request.get(url).query(...).bearer(...)`, `.json(&value)`), a buffered `Response` with `status()`, `text()`, `json()`, `decode<T>()` and `expectOk()`, and one `HttpError` with a `kind`. `silk.http_client_native` provides it with `NativeHttp`, which owns sockets, TLS, clocks, trust, timeouts, body limits and redirects. Every status is a response; `expectOk()` or `NativeHttp.failOnStatus()` turn 4xx and 5xx into errors.

The previous low-level `silk.http_client` module is now `silk.http_exchange` (`ClientError` is `ExchangeError`, `NativeClientError` is `NativeExchangeError`).

#### Migration

Migration notes not provided

New sealed thread properties `Intrinsic.Transferable` and `Intrinsic.Concurrent`, published as `silk.thread.Transferable` and `silk.thread.Concurrent`. Both are bounds derived from a type's stored parts: scalars, text and enums have both, raw pointers and `Shared<T>` have neither, `&T` needs a `Concurrent` referent, and records, unions, arrays and closures follow their parts. A module asserts a property for its own type with an empty `impl`, which the compiler does not check. An unsatisfied bound reports `SEM0121`, and an `impl` with members or for an enum reports `SEM0083`.

#### Migration

Migration notes not provided

`silk lsp` publishes semantic diagnostics. Each package is opened as `silk check` opens it, on a revisable store, and its modules are checked one at a time between messages, the modules of open documents first, so a request waits for at most one module's check. A changed document's diagnostics wait for its module's check unless it has syntax errors, which are published at once. `silk lsp --stdlib <directory>` selects the standard library, and a `silk/statistics` request reports a document's store counters.

#### Migration

Migration notes not provided

Expands the CPU feature catalog of every target (24 x86-64 features, including AVX-512, BMI and FMA; 12 AArch64 features, including SHA-3 and dot product; and wasm32 relaxed SIMD). A profile's features now include everything they imply, so `avx512bw` also enables `avx512f`, `avx2` and the SSE chain. x86-64 profiles accept the `x86-64-v2`, `x86-64-v3` and `x86-64-v4` CPU models, which enable each level's features and pass the model to Clang. The default CPU is unchanged. Adds `silk.simd` with `preferredBytes` and `hardware` for choosing a vector width at compile time.

#### Migration

Migration notes not provided

Add `silk toolchain use <version>`, which installs a version and pins the project to it: the `[workspace]` table of the workspace that lists the package, or the package's own `[package]` table, keeping the rest of `silk.toml` as written.

#### Migration

Migration notes not provided

`silk check --replay <script> --differential` also checks each replayed revision in a fresh one-shot store and reports every rejection only one of the two stores reaches, exiting with status 1 when they differ.

#### Migration

Migration notes not provided

Adds the built-in SIMD types `simd<T, N>` and `mask<N>` (SIMD-001). Arithmetic and bitwise operators apply lane by lane and trap per lane like their scalar forms, `==` and `!=` compare whole vectors, and `Intrinsic.simdSplat`, `simdExtract`, `simdInsert`, `simdFromArray`, `simdToArray`, the `simdLanes*` comparisons and `simdSelect` build, read, compare and select vectors. A shape outside the rules reports SEM0239.

#### Migration

Migration notes not provided

Add workspace and dependency commands: `silk init --workspace` and `silk init --lib`, automatic workspace membership for packages created inside a workspace, `silk add <path>` and `silk remove <name>` for path dependencies, and workspace-wide `build`, `check`, `test`, `run` and `clean` with `--package`/`-p` and `--workspace` member selection.

#### Migration

Migration notes not provided

Adds `silk.cpu`, runtime CPU feature detection. `CpuFeatures.detect()` returns the features of the running machine, read with `cpuid` and `xgetbv` on x86-64 Linux, `getauxval` on AArch64 Linux and `sysctlbyname` on AArch64 Darwin, and always includes `CpuFeatures.selected()`, the features the build selects. `CpuFeatures.has` takes the feature names of the compilation profile.

#### Migration

Migration notes not provided

### Patch

An ambiguous documentation link warns that it is ambiguous and names its candidates, instead of saying it names no declaration.

#### Migration

Migration notes not provided

Name generic implementations in generated reference pages: `silk doc-reference` now titles `impl<T> Box<T>` as Implementation `Box<T>` instead of an empty name, and `silk doc` reports the implemented types as written.

#### Migration

Reference anchors for implementations now carry the owner type: `Box.impl` for an inherent implementation and `Box.impl.Drop` for an interface implementation, with members below them such as `Box.impl.make`. Update hand-written links that targeted the old `#impl`, `#impl-2` or `#impl.member` anchors.

`silk doctest` in a package now builds and runs each example that declares a `main`, after checking it, and fails the example when the program exits with a status other than 0, printing its output. An example marked `silk,no_run` is only checked, as is every example with `--input`, `--stdlib`, or a `--target` other than the host. The examples build with the package's default profile into `build/doctest/`.

#### Migration

Migration notes not provided

The language server can tell what a written name refers to (`lsp.Names.at`). A name in a type path, in a header or a body, resolves at module scope as language lookup does: an enclosing declaration's generic parameter, then the module's declarations and imports, then the members each earlier segment names. A name in a body expression reads the checked body's editor table: the declaration a call or value read selects, the binding a local use reads, or the field a projection names.

#### Migration

Migration notes not provided

Language server hovers turn a doc comment's code links, such as [`FileSystem.providerCode`], into links to the line that declares what they name, resolved as the documentation generator resolves them. A link that names nothing shows as plain code instead of keeping its brackets.

#### Migration

Migration notes not provided

A debug build after a one-line edit replays its last walk again instead of walking the whole program. When a check had lowered a function under a different lifetime pattern than the one the build reached first, the build followed that other pattern's calls, so its record named calls a later build could not find again. On the compiler's own sources, an edit to one function took 1m40s instead of about 6 seconds.

#### Migration

Migration notes not provided

More diagnostic locations from the language reference review:

- A refusal inside a standard-library static helper (`StaticSequence.length`, `concat`, `at`) or from `Reflect.fields` over a union in `static for` is reported at the user's call, with the library site as related information.
- The `import silk.<primitive>` hint is not given when the module has syntax errors.
- `pub param o: ?i32` is SEM0214 (optional types are not supported as package parameters) instead of an unsupported construct.
- `with Intrinsic.foreign(...)` or `with Intrinsic.machine(...)` on a declaration without `extern`/`export` linkage is the new SEM0236 at the clause.

#### Migration

Migration notes not provided

Single-file `silk build <file>` prints human diagnostics like the package build (the `SILK_BUILD_ERROR` records remain under `SILK_RECEIPTS`), and its `Compiled` line shows paths from the working directory, or absolute paths, instead of paths relative to the source directory.

#### Migration

Migration notes not provided

SEM0087 on an expression statement again names the dropped result, as in "an Effect of `i32` that is never run (write `run` before it to run it, or `drop` it to discard it)", instead of the catalog's generic description. A wrong argument count for a call on the left of an infix operator in a pipe target, as in `1 |> add(2) != 3`, now carries a note that `|>` binds more loosely than the operator and shows how to parenthesize.

#### Migration

Migration notes not provided

Building many instances of one generic function over a large struct takes linear time: whether dropping a type runs cleanup is decided once per type instead of once per function body. A `static for` that reads each of 3,200 fields with `Reflect.borrowField` checks in 2 s instead of 12 s, and builds in 10 s instead of 24 s.

#### Migration

Migration notes not provided

Every error type of the standard library implements `Debug`, so `{:?}` shows its fields, as `FileError { operation: ReadFile, reason: NotFound, providerCode: 2 }`. The reason, kind and component enums and unions that the errors hold implement it too, and so do `String` (as quoted text) and `Bytes` (as a list of numbers). `Format.debugRecord`, `Format.debugField` and `Format.debugFinish` write a hand-written `Debug` form with labeled fields, for a type with private fields or a union variant.

Specialization admits a recursive application whose changed type argument lies within the owned structure of the earlier one. `Debug` for an `Option<Line>` where `Line` has an `Option<i32>` field no longer fails with SEM0053.

`f: mut F` and `f: once F` report SEM0246, which says that `mut` belongs before the parameter name (`mut f: F`), instead of a generic "not supported" message.

#### Migration

Migration notes not provided

A dependency refused for its `silk-version` now says what to do: build with the Silk it names (`silk set <version>`), or set the dependency's `silk-version` to the running Silk if it builds there. On a dev release it also explains that a dev release builds only packages written for that same dev release.

#### Migration

Migration notes not provided

Clearer diagnostics: every diagnostic now prints a message (the catalog meaning when a template cannot be filled yet), `silk check` reports a `main` the runtime cannot start as SEM0225 at the entry's `main` instead of failing later inside the std lib, project `silk build` prints diagnostics in the same form as `silk check` instead of `SILK_BUILD_ERROR` records, syntax errors no longer come with spurious "unsupported" lines, a move error names the whole moved place, package parameter declaration errors carry SEM0214 and a reason, ambiguous receiver operations report SEM0200 (several bounds) and SEM0202 (several conformances), and bodies the borrow checker cannot prove yet are listed as notes instead of `SILK_GAP` lines, which no longer appear on fully checked builds.

#### Migration

Tools that parsed `SILK_BUILD_ERROR` or `SILK_GAP borrow-check` lines from project `silk build` or `silk run` output must use `silk check --json` or the single-file `silk build <source> -o <output>` form, which keeps those records.

The compiler now marks where each simple temporary and named local is live, so LLVM can reuse its stack slot once the value is dead. The compiler's own frames shrink by 2 to 10 times on deeply nested code, so the nesting limits that report PAR0005 rise: 291 method calls in one chain (was 71), 408 field or index links (was 167), 204 nested calls (was 100), 170 nested array or tuple literals (was 62), 1018 chained operators (was 499), 681 nested blocks (was 59) and 454 nested `if` statements (was 44). Programs built by this compiler also get these markers, so their deeply recursive functions use less stack.

#### Migration

Migration notes not provided

A typed `let` whose initializer fails, such as `let a: i32 = "s"`, still binds `a` as an `i32`, so later errors that use `a` are reported in the same check instead of after the first one is fixed. `OWN0003` for a `&mut` reference passed by value, such as `bump(r)` twice, now says to lend it again with `&mut r` (a reborrow) or to give it away with `move r`.

#### Migration

Migration notes not provided

A `silk check` with nothing changed is about twice as fast: source files are read in 64 KiB blocks instead of byte by byte, each module is parsed once instead of twice, and loading the cache no longer re-fingerprints the declarations of files whose bytes are unchanged.

#### Migration

Migration notes not provided

Language server hover and go to definition keep working in a function body that has an error, on the statements around the one that failed, including when the error is in a function the body calls. A type written as a value's qualifier, such as `Logger` in `Logger.make()`, now hovers with its declaration and doc comment and goes to its definition.

#### Migration

Migration notes not provided

A call argument type mismatch (SEM0012) now names the expected and actual types.

#### Migration

Migration notes not provided

The HTTP response parser, and so the HTTP client, accepts a status line with no space after the code when there is no reason phrase (`HTTP/1.1 200`), as curl and browsers do. The WebSocket server sends Close 1009 for a message larger than the buffer, as it already did for one over `maxMessageBytes`, and with no deadline it now gives a failure's Close one second instead of dropping the connection without one, so a client sees 1009, 1002, 1003 or 1007 instead of 1006.

#### Migration

Migration notes not provided

A semantic store can write an image of its dependency graph for an on-disk cache: each module check that reported nothing, with every unit and source read it rests on, under a stamp naming the compiler build, the target and the profile. An image written by another compiler, or for another target or profile, reads as nothing. Nothing reads or writes the cache file yet.

#### Migration

Migration notes not provided

`silk format` formats an exact `.silk` file wherever it is, with no `silk.toml` and outside any package source root, as editors that format a scratch file on save expect. A directory or the default selection still needs a package. `silk doc` reports an invalid import, or any other rejection, as `silk check` does (`src/main.silk:1:8: error[MOD0001] Unknown module nothing`) instead of `main.silk at byte 7: MissingModule`.

#### Migration

Migration notes not provided

`let x = if ...` reports the new PAR0009, which says `if` is a statement in Silk and to assign the binding in each branch, instead of PAR0001 "Expected identifier" and a cascade.

#### Migration

Migration notes not provided

Diagnostics fill more of their messages: a selected `compileError` prints its own text, an unknown module names its path, a non-exhaustive enum or union match names the members it misses, a missing operator names the operator and operand types, ambiguous receiver operations name the candidate interfaces, borrow conflicts say which loan is mutable or shared, and a primitive namespace used without its import (such as `u32.toU64`) suggests `import silk.u32`. A call that does not prove its callee's `where S in R` requirement-row premise now reports the new SEM0234, naming the premise, instead of the `Effect.provide` code SEM0074. Unsupported constructs in project `silk check`, `silk build` and `silk run` print a `path:line:col: unsupported` line instead of a `SILK_UNSUPPORTED_JSON` record (`--json` and the single-file `silk build <source> -o <output>` form keep the record). Package parameter errors keep their reason: an unsupported parameter type, a value failing its `where` predicate (named), an unknown or mistyped binding (with the `silk.toml` line), and a `param` outside the root module (reported at that declaration). An import refused for several reasons, such as an unknown module with several selected names, prints once. `silk format` no longer breaks the line between `if`, `while` or `return` and a `!` operand. A named `--profile` builds into `build/llvm/<target>/<profile>/` instead of overwriting the default debug artifact, and a failing `silk run` prints the `[target]` header and a run summary.

#### Migration

Migration notes not provided

The language server now works in standard-library files: a file reached by go to definition belongs to the package that imports it, so hover, go to definition and diagnostics work there too. Hover and go to definition also work on import statements: a module path or alias shows the module and goes to its file, and a selected member shows and goes to the declaration it imports. The `initialize` result names the standard library under `capabilities.experimental.standardLibrary`, so editors can send its files to the same server.

#### Migration

Migration notes not provided

Fixes:
- One pattern may discard several fields with `_` (`Box { width: _, height: _, depth }`). The second `_` used to report SEM0048. `_` never binds a name, so it also never conflicts with a local.
- `List.insert` traps when the index is more than the length. It used to check the index only against the capacity, so an index between the length and the capacity left an uninitialized element in the list.

#### Migration

Migration notes not provided

OWN0004 names the assignment's destination and shows the two-step form that works: `` `request` is consumed while computing its own replacement; move it out first with `let current = move request`, then assign `request` from `current` ``.

#### Migration

Migration notes not provided

`silk toolchain default <version>` now also points `$SILK_HOME/bin/silk` at the default toolchain when it is installed, so the `silk` on PATH (which runs every `silk toolchain` command) moves to it instead of staying on the release install.sh last linked. `latest` now means the newest stable release only; `silk toolchain install latest --dev` and `use latest --dev` include dev releases (the same as `dev`).

`silk toolchain use` now always pins the full version it installed, so `use 0.1.0-dev.9` writes `0.1.0-dev.9+<commit>` like `use latest` does. When the GitHub release listing fails and HTTPS_PROXY is set, the error says that `silk toolchain` connects directly and names the alternatives.

#### Migration

Migration notes not provided

Checking a formatted call is faster: the standard library checks a template's placeholders against its arguments with plain loops, so each distinct template no longer type-checks the validation again. A program with 100 distinct `log` templates builds in 12.6 s instead of 16.4 s. `List` keeps a single buffer instead of switching between an empty and a full representation.

#### Migration

Migration notes not provided

Filesystem paths resolve with search permission alone. Directories along a path are opened for search only (`O_PATH` on Linux, `O_SEARCH` on macOS), so `silk init`, builds and every `silk.filesystem` call work below an ancestor that can be traversed but not listed, such as a 0711 home directory or Homebrew's Linux test sandbox. Directories that are read or synchronized are still opened for reading.

#### Migration

Migration notes not provided

Type mismatch diagnostics (SEM0012, SEM0129 and the like) now print types that contain a generic parameter, spelling the parameter as the declaration writes it, as in "Expected i32 but received T". A static argument whose value has another type, such as a reflected field passed through a generic wrapper in a `static for`, names both types and the field the repetition reached.

#### Migration

Migration notes not provided

Binding and composition fixes from the documentation review:

- A composition component binding without an `operation`, or with one that is not a string, is refused at its entry instead of failing later with ARTIFACT-001.
- Binding refusals name their field and its line: a forbidden or unknown `origin.provenance`, a missing provenance, a missing or empty `origin.source`, a mistyped `origin.translator` or identity field. A missing `origin`, identity field or `value` is reported at the binding's own line.

#### Migration

None: these manifests were already refused or failed to build; only the messages and lines change.

More diagnostics name what they are about instead of printing only the catalog meaning. An unknown union variant (SEM0167) names the union and the variant and lists the variants the union has. A public declaration that exposes a private type (SEM0019) names the private type and says how to fix it. A `static for` over reflected fields whose requested field type does not match a field's type (SEM0012) names both types and the field.

#### Migration

Migration notes not provided

An edit now rechecks far less of a package. `silk check` checks the escapes of each module's bodies on their own instead of walking the whole program from `main` on every check, so an edit to one module reruns only the modules that call into it. A debug build of an executable splits its code into one unit per module and keeps each unit's object in `<output>.units` beside the output, so a rebuild compiles only the units whose code changed, on all cores.

#### Migration

Migration notes not provided

Clearer messages for mistakes new users make:

- `x += 1`, `x++`, `for i in 0..10 { }`, `var x = 0` and `c ? a : b` each report one PAR0010 error that names the Silk spelling, instead of several PAR0001 or SEM0006 errors.
- `match u` over a non-Copy value now says "`match u` moves `u`; write `match move u` to take it apart, or `match &u` to look at it" (OWN0003), and a missing arm in the same match is reported too.
- An incomplete match over a named union names it, as "Match over Shape does not cover Line" (SEM0044), the way enums already do.
- Returning or assigning an Effect that was never run, as in `let x = f()` for an `effect fn`, says "expected i32 but received an Effect of `i32` that is never run (write `run` before the call that makes it)".
- A struct or variant literal that leaves out fields names them: "`P { ... }` omits fields `y` and `z`" (SEM0024).

#### Migration

Migration notes not provided

Writing an optional type as `?T` (for example `param o: ?i32 = 1` or `let x: ?i32 = 3`) is the new PAR0007, "`?T` is not a Silk type; write an optional type as `Option<T>`", reported once at the `?`. The parser keeps the rest of the declaration, so no cascade of PAR0002 or package-parameter errors follows.

#### Migration

Migration notes not provided

Clearer messages for unknown names, missing methods, pattern bindings and private construction, and a leading byte order mark is accepted:

- SEM0010 names the type and the missing member, such as ``silk/list.List<i32> has no method `push` ``.
- SEM0001 and SEM0009 name the unknown type even inside a generic application such as `List<string>`, and a commonly used standard-library type suggests its import, such as ``is `import silk.list { List }` missing?``.
- SEM0048 names the binding and, for a record field, suggests binding the field to another name, as in `{ value: found }`.
- SEM0021 names the struct or variant it cannot construct, such as `Shape.Square`, without naming its private fields.
- A UTF-8 byte order mark at the start of a source file is whitespace instead of LEX0001 followed by a missing `main`.

#### Migration

Migration notes not provided

`silk format` no longer refuses a file with a comment after the last statement of a closure passed as an argument, such as `call(fn() -> () { n = n + 1 // counted })`. It wrote that comment twice and then stopped with "Cannot format without changing the syntax". It also keeps the space in `fn() -> ()` inside a generic bound.

#### Migration

Migration notes not provided

Manifest and module fixes from the documentation review:

- Unknown keys at the top level of `silk.toml`, in `[package]` and in dependency entries are refused at their line, like `[build]` and `[workspace]` already were.
- Profile errors name the manifest line, the profile and the key, and an unknown profile key is refused.
- A profile `artifact` that differs from `[build].artifact` is refused before building instead of failing at link time.
- Profile `cpu` features, `codeModel = "large"` (x86_64) and `link = "static"` reach Clang. `sanitizers`, `unwind = "native"`, `safety = "unchecked"`, `threading = "multi"` and a non-default `entry` are refused as not supported by the native compiler yet, instead of being ignored.
- A local `silk` or `Intrinsic` module is refused as a reserved name, and importing `Intrinsic` other than `Intrinsic.application` is the new MOD0004.
- A module that imports itself reports MOD0002 only, without SEM0016 in other modules.

#### Migration

Remove unknown keys from `silk.toml` files and profiles. Profiles that set `sanitizers`, `unwind = "native"`, `safety = "unchecked"`, `threading = "multi"` or `entry` now fail to build until those are supported.

SEM0177 for a template field on an argument with no visible named fields says so instead of listing `<Option.none>`.

#### Migration

Migration notes not provided

Implementing an interface whose requirement row is omitted (`?R` with no row) now says the row argument is missing and suggests `? never`.

#### Migration

Migration notes not provided

Rename `websocket_upgrade.Limits.default()` to `Limits.defaults()`, matching `websocket_server`.

#### Migration

Migration notes not provided

`silk update self [--dev]` replaces `$SILK_HOME/bin/silk` with the newest signed release's tool (the newest dev release with `--dev`, or while no stable release exists) and installs no Silk version. install.sh installs the tool as `$SILK_HOME/bin/silk`. `silk use uninstall` says when the current project pins the version it removed.

#### Migration

Migration notes not provided

A chain of up to 256 infix operators, such as a generated sum, now compiles: the backend lowers left-nested chains without recursing once per operator, so the documented limit of 256 nested expression children holds for chains (it was about 135). Deeply nested calls, arrays and tuples, which crashed the compiler at about 250 levels, now report PAR0005 at 100 nested calls or 62 nested array or tuple literals, and PAR0005 no longer says "expression" when a type or block is what nests too deeply.

#### Migration

Migration notes not provided

Two imports that bind the same name report SEM0016 once, at the second import, instead of at every use.

#### Migration

Migration notes not provided

`silk changes since` requests GitHub's release list again when it comes back empty, which GitHub does at random, instead of reporting that no published release is available.

#### Migration

Migration notes not provided

`silk test` reuses the runner on the first rerun of an unchanged project. The reuse record had noted the runner file itself, which the first build had not linked yet, so the first rerun always built the runner again.

#### Migration

Migration notes not provided

Fixes four static evaluation and diagnostics bugs.

- `Reflect.borrowField` and user functions taking `static field: Intrinsic.Field<Owner, Value>` accept a field from `static for field in Reflect.fields<T>()` in a non-generic function, also when the owner has a `string` field. They no longer fail with SEM0012.
- A static operand, such as a `let static` binding, a static call or a `run` expression, can be a field value in a variant literal of an applied generic union, such as `Parsed<T>.Failed { error: e }`. Before, this was "unsupported".
- `silk check` reports a `compileError` that a library's static branch selects for a call from a `main` that requires a provider, as `silk build` does. The error is located at the user's call, with a note at the library site; notes in another module than the error are now printed.
- A syntax error the parser recovered from fails the check phase of `silk build` before codegen.

#### Migration

Migration notes not provided

A type mismatch that names a generic parameter adds a note saying where the parameter comes from and that it can be any type, as in "`T` is a type parameter of `wrap`, so it can be any type". A bounded parameter says "any type that meets its bounds".

#### Migration

Migration notes not provided

Clearer diagnostics:
- SEM0086 says which rule a constant breaks: a type outside the constant contract (naming the type), an initializer that does not evaluate to exactly the declared type or holds references, allocated memory or Drop cleanup, a missing initializer, or an array length or repeat count that is not a non-negative integer.
- `Effect.log("hi {name}", &())` and other templates with placeholders but arguments without fields report SEM0177 saying the values go in fields, such as `&.{name: value}`, instead of SEM0176.
- Reading a runtime value where a static one is needed, such as a `let` local passed as a log template, names the value in SEM0176.
- SEM0037 names both types when an annotated binding such as `let s: string = total(items)` receives a value of another type.
- `fn noun() -> string { return "task" }` reports SEM0210 suggesting `string<'static>`: with no borrowed input, the result can only borrow program-long data.
- `silk toolchain use 0.0.0` explains that 0.0.0 is the version of a compiler built from source and means unpinned.

#### Migration

Migration notes not provided

A threaded wasm32 build (`threading = "multi"`) refuses a Clang older than 19, naming it and `SILK_CLANG`. Clang 18 crashed on such a module with `optimization = "speed"`, and without it wrote a module the host rejected while the build reported `Finished`.

#### Migration

Migration notes not provided

`silk add` refuses a package that already depends on the current one with a message naming both, and a workspace member whose dependencies cannot load fails on its own: the other members still run and the workspace summary is still written.

#### Migration

Migration notes not provided

Optimized builds work again with Clang 18 to 21. The stack lifetime markers added in the previous release used the one-operand `llvm.lifetime.start` form that only Clang 22 accepts, so `silk build --release` crashed older Clang; the compiler now emits the two-operand form, which every supported Clang accepts.

#### Migration

Migration notes not provided

An unexpected `as`, as in `count as i32`, reports PAR0002 with a message that says Silk has no `as` cast and names `usize.toI32` and `usize.checkedToI32`.

#### Migration

Migration notes not provided

A float below one formatted with a precision no longer prints a stray `1` in the units place when its rounding carries or rounds it away. `0.000001` with `{:.3}` prints `0.000`, `1.0e-7` with `{:.11}` prints `0.00000010000`, and `0.0999` with `{:.2}` prints `0.10`.

#### Migration

Migration notes not provided

Dropping an adopted allocation (`Intrinsic.allocationAdopt`, as `silk.arena` makes) on wasm32 always reaches its reclaim function. System storage was tagged with reclaim value 1, and on wasm32 a function address is its table index, so a reclaim function at index 1 was mistaken for system storage: its drops called `free` on the reclaim context instead, which double-freed arena chunks (`memory access out of bounds at ...free`). System storage is now tagged 0, which no reclaim function can occupy on any target.

#### Migration

Migration notes not provided

`Reflect.fields<T>()` lists the fields visible from the code that calls it, as documented, so a module reflects the private fields of its own types. It used to judge visibility from the standard library's `silk/reflect` module, which listed only public fields.

#### Migration

Migration notes not provided

Static functions accept two more call forms that runtime code already has. `input |> f(rest)` in a static body is the direct call `f(input, rest)`, as `input |> f` already was; `input |> f()` reports SEM0078, as at run time. Receiver syntax calls a static method, as in `Spec.make().bump()` or `spec.bump()`, where only the qualified `Spec.bump(spec)` worked before.

#### Migration

Migration notes not provided

A manifest's release settings are read only from `[release]`; the earlier `[changes]` spelling is no longer accepted. `silk use --help`, `silk set -h` and `silk update --help` print the help. `silk toolchain` and `silk changes` now say which commands replaced them instead of reaching the compiler. `silk set` notes when the pinned version is older than the tool, since that version may not read the manifest. `silk change status` says "1 pending change has no migration note" for a single change. At a workspace root that pins no `silk-version`, commands run the version its members pin instead of your default, and stop with an error naming `silk set` when the members pin different versions.

#### Migration

Migration notes not provided

`String.fromUtf8` and the other UTF-8 checks skip runs of ASCII sixteen bytes at a time where the CPU has 128-bit vectors: about ten times faster on ASCII text, and slightly faster on text that mixes in other characters.

#### Migration

Migration notes not provided

Diagnostics and formatting fixes from the language reference review:

- `u32.MAX` without `import silk.u32` suggests the import, like the call form.
- SEM0214 names the package parameter and reports at its declaration for an unbound parameter and an enum-typed parameter, and gives the specific reason for a default of the wrong type, a non-`bool` `where` predicate, and a `param` inside a module-level `static if`. A matching array binding is accepted.
- An unsupported construct reached through static evaluation of another module is reported at the call in the evaluated file.
- `silk format` breaks a long signature's value parameters before its generic list, and writes a trailing comma only when a list stays broken.
- A `main` the selected runtime cannot start (for example `pub fn main() -> i32` under `silk/native_start_sync`) is SEM0225 at `main` from check, instead of a build failure inside the runtime.
- An unknown `with Intrinsic.*` property or property argument is the new SEM0235 at check time.
- A generic function used as a value takes its type arguments from an expected `typeof(f<...>)`.
- Static function bodies are no longer reported as awaiting the borrow check.
- SEM0074 is removed; SEM0234 replaced its producers.

#### Migration

Migration notes not provided

A requirement on an optional service with exclusive access, `&Option<&mut S>`, which no provider can satisfy, reports SEM0240 at the requirement.

#### Migration

Migration notes not provided

Symbolic links in package paths:

- A dependency whose `path` goes through a symbolic link, such as a linked folder or `/tmp` on macOS, is read at its real directory instead of failing with `no readable silk.toml`.
- A source file that is a symbolic link, or that sits under a linked folder, is read through the link.
- A dependency without a readable `silk.toml` names the directory it looked in, and a source file that cannot be read is named on its own line before the failure.

#### Migration

Migration notes not provided

Reaching a type through a module name in value position (`inflate.Inflater.make()` after `import silk.inflate`) reports SEM0238 with the import to write, instead of an unsupported construct.

#### Migration

Migration notes not provided

Types can nest 511 levels deep instead of 255, and checking deeply nested types takes linear time: 511 levels of `&Box<&Box<...>>` check in about 1 s instead of over 7 minutes. An anonymous function is refused at its `fn` when its signature would not fit the nesting budget, so 408 of them nest instead of 409.

#### Migration

Migration notes not provided

`HashMap` and `HashSet` keep the top seven bits of each entry's hash in its state byte, so a lookup skips slots that cannot hold its key without reading them, sixteen at a time where the CPU has 128-bit vectors. Lookups in a map near its maximum load are about 1.6 times faster. Bucket positions and iteration order are unchanged.

#### Migration

Migration notes not provided

Semantic stores can name their units and source inputs with stable bytes that mean the same in every process: a module by its path, a declaration by its full identity, and a source input's declaration by that identity rather than a handle. A store reads back the inputs another store wrote. This is groundwork for the on-disk cache; nothing is written to disk yet.

#### Migration

Migration notes not provided

More errors name their subject and the fix:

- SEM0076: "The Effect passed here also requires &mut Logger, but the expected Effect may only require &mut Scheduler | &mut MonotonicClock", as for a fiber's child that needs a service the scheduler does not provide.
- SEM0212: "This value must live for `'static`, but it borrows something that lives only as long as a lifetime of the enclosing function; pass owned data instead of a borrow". Other SEM0212 and SEM0213 messages no longer read as cut off.
- SEM0015: "`secret` is private to geo/shapes; mark it `pub` there to use it here".
- SEM0016: "Multiple bindings claim shapes; rename one with `as`".
- SEM0028: "Field `x` of geo/shapes.P is private; mark it `pub x` to use it outside its module".
- SEM0001 asks whether an import is missing for `Copy`, `Drop`, `Equal`, `Order`, `Ordering`, `HashKey`, `Display` and `Debug`, as it already did for `List` and other common types.
- MOD0001 suggests a module one typo away: "did you mean `geo.shapes`?" for `import geo.shape`.

`var x = 0` still reports PAR0010, but `x` is now declared as a mutable binding, so later uses of `x` no longer each report an unknown value.

A method call that borrows its receiver names the receiver: SEM0057 says "`board` is not mutable" for `board.add(1)` instead of naming `add`, OWN0010 says "A mutable borrow of `board`", and OWN0019 says "`first` is used after `board`" for a borrow returned by `board.first()` instead of "a temporary value".

#### Migration

Migration notes not provided

Release archives now carry the compiler as `bin/silkc` and the silk tool, built from the same sources, as `bin/silk`. `silk --version` reports the Silk version the directory selects.

#### Migration

Migration notes not provided

`install.sh` retries GitHub's release list when it comes back empty, which GitHub does at random and most often right after a release is published, instead of reporting that no dev release exists. It also retries network and server errors, says when a GitHub API rate limit resets and that `GITHUB_TOKEN` raises it, reports GitHub's message for other refused requests, and no longer prints `printf: write error: Broken pipe`.

#### Migration

Migration notes not provided

A debug build that changes nothing now writes nothing: it no longer links the executable again when the link command and the objects it names are the ones the last link used. A module's escape check that a build confirms by replaying its last walk is now kept in the cache too, so later builds take it as it is instead of replaying it every time. On the compiler's own sources, after an edit and a revert each build used to replay two modules' checks again.

#### Migration

Migration notes not provided

Add independently tested internal source-analysis rule, reaching-definition, and ordered-policy kernels for the compiler's complete-source migration.

#### Migration

No user action is required. This prerequisite does not replace the production borrow checker or change accepted Silk programs. The complete source analysis and checker cutover remain separate work.

Diagnostics name what they are about in more places. An `Effect.catchAll` handler whose parameter misses failures of the handled Effect now reports SEM0067 with the missing failures when the parameter is a union, when the Effect has a single failure, and when the Effect is piped into `Effect.catchAll(handler)`; several missing failures are worded in the plural. A base-prefixed integer literal with a digit or letter outside its base, such as `0xG1` or `0o9`, reports the new LEX0013 at the literal instead of a duration error or a stray SEM0087. LEX0002, LEX0003 and LEX0009 to LEX0012 fill their message templates with the modifier, literal kind, unit or amount they name. A related location at the diagnostic's own line and column no longer prints as a `note:`.

#### Migration

Migration notes not provided

A debug build with nothing changed no longer parses the program's sources. The build cache keeps each file's imports by the digest of its bytes, so loading reads an unchanged file's imports without parsing it, and adoption finds a cached declaration at its recorded position. The C export scan skips files with no foreign declarations, and the import check (IMPORT-003) is kept per module in the cache. On the compiler itself, a no-op build drops from 4.0 s to 1.8 s and its peak memory from 1.35 GB to 0.68 GB.

#### Migration

Migration notes not provided

Adding or deleting a method no longer reruns every body that calls another method of the same type: a call reads only the member of its own name. In the edit replay, adding a method reruns 9 units of the compiler instead of 532, and 32 of the standard library instead of 660. `SILK_REPLAY_RUNS=1` makes `silk check --replay` list the units each edit reran and why.

#### Migration

Migration notes not provided

`silk build`, `check`, `run` and `test` name the files in their diagnostics relative to the project root: the workspace root for a workspace member (`glob/src/Glob.silk:1:1`), else the package directory. Files outside it, such as the standard library's, keep their absolute paths, and `--json` output stays absolute.

A multi-package build clears its live progress line before printing diagnostics, so the `[<target>]` heading no longer runs into the spinner, and SEM0225 for a missing `main` now points library packages at `[build] artifact = "static-library"`.

#### Migration

Migration notes not provided

An import resolves only a file whose path matches the module path exactly, including letter case, on every host. A case-insensitive filesystem such as the macOS default no longer lets `import util.math` open `util/Math.silk`, so a package that builds on macOS also builds on Linux. When a file differs from the import only in letter case, the `MOD0001` error adds a note naming it: ``did you mean `util.Math`?``.

#### Migration

Migration notes not provided

A debug `silk build` reuses the previous build's work. The build reads the semantic cache that `silk check` keeps, so unchanged modules are not checked again, and it replays the previous build's code generation: only the functions an edit touched are lowered again, and the rest of the LLVM text comes from the cache. An edit that changes which functions the program reaches builds the program again in full. A rebuild with no changes on the compiler's own sources goes from about 2 minutes to under 7 seconds. The executable is the same one a clean build links.

A debug build of a large program no longer fails to link when a string constant holds `@`, and a codegen unit's object no longer depends on the scratch file name it was compiled from, so a rebuild links the same executable a clean build does.

#### Migration

Migration notes not provided

More manifest and profile fixes from the documentation review:

- An unknown `[workspace]` key, an invalid quoted profile name such as `[profiles."1fast"]` and an unknown binding field are refused at their manifest line, and the binding error names the field.
- Unknown keys in `[build].composition` are refused instead of ignored.
- A refused `--profile-input` field is reported against `--profile-input`, not `silk.toml`.
- `deployment` is refused on targets other than `aarch64-apple-darwin`, where it was ignored.
- An executable built with `runtime = { kind = "none" }` that exports no C `main` is refused before linking instead of failing in the linker.
- The MOD0004 message now describes what it refuses: importing `Intrinsic`, whose intrinsics are written `Intrinsic.<name>` without an import.

#### Migration

Remove unknown keys from `[workspace]`, `[build].composition` and bindings, and remove `deployment` from profiles that do not target `aarch64-apple-darwin`.

`silk check` keeps a semantic cache in the project's output directory (`build/cache/semantic-<digest>`, one file per target and profile) and reuses every module check whose sources still read the same, so checking an unchanged project again takes seconds. Checks that report anything are not cached and run again. A cache written by another compiler build, target or profile is ignored and replaced. Development builds that cannot read their own executable keep no cache.

#### Migration

Migration notes not provided

Ownership and effect errors now name what they are about and the fix:

- SEM0057: "`n` is not mutable; declare it with `mut`, as in `let mut n`, to borrow it with `&mut`".
- SEM0058: "`x` is a shared reference, so it cannot lend `&mut` access; take a `&mut` reference where it comes from to change what it points at".
- OWN0010: "A mutable borrow of `p` conflicts with an earlier shared borrow of it that is still in use; use that borrow for the last time before this one".
- OWN0011: "Assigning `p` while a borrow of it is still in use; use that borrow for the last time before this".
- OWN0019: "`r` is used after `x`, which it borrows, ended or was replaced".
- SEM0063: "Only an `effect fn` can `fail`; declare `f` as an `effect fn` that names the failure type after `!`".
- SEM0066: "This `run` can fail with `E`, which the enclosing function does not declare; add `! E` to its signature, or handle the failure with `Effect.result`".
- SEM0071: "This `run` needs `&mut Logger`, which the enclosing function does not provide; add `? &mut Logger` to its signature, or provide it with `|> Effect.provideMut(&mut value)`".
- SEM0077: "`f` changes what it captures, so calling it needs a mutable binding; declare it `let mut f`".

The note under a borrow conflict now says "the borrow starts here" instead of "related location". `pub fn main() -> string` reports SEM0225, the result the runtime cannot start, instead of the SEM0210 `'static` hint.

#### Migration

Migration notes not provided

Integer conversions that trap, such as `i32.toUsize(-1)` or `usize.toI32(5000000000)`, now report why and where you called them: "fatal trap: i32.toUsize: the value is negative" at your line, instead of "arithmetic overflow" inside the standard library. `String.slice` and `Slice.view` do the same for a range past the end.

SEM0002 names the literal, the type and its range: "Integer literal 300 is outside the u8 range, 0 through 255".

#### Migration

Migration notes not provided

A revisable semantic store keeps each module's declaration sweep and the package's escape check between revisions, so a recheck after a small edit verifies the modules the edit did not reach instead of walking their roots again. In the edit replay, a trivia edit to the compiler makes 98 thousand demands instead of 1.2 million.

#### Migration

Migration notes not provided

`Base64.encodeInto`, `Base64.decodedLength` and `Base64.decodeInto` work on sixteen characters at a time where the CPU has 128-bit vectors, about three times faster on large inputs. Output and errors are unchanged.

#### Migration

Migration notes not provided

Diagnostic fixes from the documentation review:

- A test with a requirement row is rejected by `silk check` (SEM0218) instead of failing inside the test runner.
- Malformed literals (`0x`, `1_`, `5q`) and unterminated strings report their LEX codes from `check` and `build`.
- A failing assertion prints its message under the failing test in the runner output.
- An empty array literal `[]` is accepted for element types with an elided lifetime.
- Format template errors (unknown field, missing positional field) and a missing `Display` are reported at the user's call instead of inside `silk/format`.
- `bool` and `char` implement `Display`.
- An `Effect.catch` handler whose parameter misses a failure of the handled Effect reports SEM0067 instead of "unsupported".
- A `compileError` reached through a static branch notes the selecting call as a related location.

#### Migration

Move services out of test signatures and provide them inside the test body.

Reuse semantic bodies across unrelated storage and operation edits by tracking the declaration, member, and catalog inputs they actually consume. Preserve invalidation for changed fields, original operation contracts, missing members, implementation membership, and relocated diagnostics.

#### Migration

Migration notes not provided

`silk.atomic` gains `Atomic.wait`, `Atomic.notifyOne` and `Atomic.notifyAll`: block a thread while a `u32` holds an expected value, and wake it after a store. GNU/Linux uses the private `futex` operations through `syscall`, macOS uses `__ulock_wait` and `__ulock_wake`, and single-threaded WebAssembly answers without sleeping. No compiler change: these are ordinary selected library declarations.

#### Migration

Migration notes not provided

`silk add` given a workspace now says that it is a workspace and lists its members to add instead, rather than reporting the workspace's manifest as broken.

#### Migration

Migration notes not provided

A method call whose receiver is taken by value (`self: Self`) now infers the owner's lifetimes from the receiver, as `Type.member(move value, ...)` already did, so a later operand can shorten them. `NativeHttp.make().baseUrl(url)`, `.header(name, value)` and `.trustBundle(path)` accept strings read at run time, from a config file, an environment variable or an argument, instead of only literals (SEM0012 `Expected string<'static>`).

#### Migration

Migration notes not provided

Writing an anonymous tuple type such as `fn pair() -> (i32, i32)` is the new PAR0008, "Silk has no anonymous tuple types; declare one with a name, as in `tuple Pair(i32, i32)`, and write `Pair`", reported once over the parenthesized list instead of PAR0001 "Expected `)`" and a cascade of return errors.

#### Migration

Migration notes not provided

`silk check` and `silk build` no longer walk the whole program again after a one-line edit. The escape check that starts from the runtime walks every instance `main` reaches, which took close to a minute on the compiler's own sources after any edit. The cache now keeps a record of each module's walk, and the next check lowers only the instances an edit touched and confirms that they still reach and summarize what they did. An edit that changes what the walk reads checks the module again in full. On the compiler's own sources a check after a one-line body edit goes from about 70 seconds to about 6.

A module's escape check also walks less when one of its bodies hands a local-shared access to a callback: it walks the bodies the callback can reach instead of every body it left to other modules' checks.

#### Migration

Migration notes not provided

`silk toolchain` and `NativeHttp.fromEnvironment` now go through HTTP proxies. HTTPS requests use `HTTPS_PROXY`, `https_proxy`, `ALL_PROXY` or `all_proxy` as a `CONNECT` tunnel, so TLS still checks the server certificate; plain HTTP uses `HTTP_PROXY`, `http_proxy`, `ALL_PROXY` or `all_proxy`. Credentials in the proxy URL (`http://user:pass@proxy:3128`) are sent as Basic `Proxy-Authorization`, and `NO_PROXY`/`no_proxy` lists hosts (and their subdomains) that are reached directly. Only `http://` proxies are supported; an `https://` or `socks5://` proxy URL is an error. The listing error no longer says that `silk toolchain` ignores HTTPS_PROXY.

The `silk.http_exchange_native` route provider now reads and writes its socket directly, so `withProxyRoute` compiles when it is used (it failed with SEM0053 before).

#### Migration

Migration notes not provided

`silk use <version>` and `silk update self` download from GitHub again. GitHub now answers release downloads with a `Content-Security-Policy` header of over 9 KiB, and the HTTP client refused field values over 8 KiB. `silk.http_exchange` `Limits.defaults()` now allows field values up to 64 KiB and response heads up to 256 KiB; trailer limits are unchanged. When a download fails, the error now names the lower-level cause.

#### Migration

Migration notes not provided

The language server reports an import of a name its module does not have (SEM0014) on the import line, as `silk check` does. Before, the editor showed only the errors the missing name caused further down.

#### Migration

Migration notes not provided

More manifest fixes from the documentation review:

- An unknown field of a `[build].composition` entry is located in that entry (also the second or later entry, inline or as `[[...]]` tables), not at an earlier line that writes the same name.
- A component `capability` other than `execution-storage`, the only one the native compiler reads, is refused at its line.
- Unknown keys in a binding's `origin` and `value` tables and in a profile's `entry` and `runtime` tables are named and located.
- An unknown `[build].platform-supply` key (or `support` entry key) is named at its line, and other platform-supply errors give the line.

#### Migration

Remove unknown keys from binding origins and values, profile `entry` and `runtime` tables and `[build].platform-supply`, and capabilities other than `execution-storage` from compositions.

Language fixes found while writing the Silk book: a library checks every module its `[package].exports` lists and `silk test` discovers their tests, even when the root module imports none of them (an exports entry that names no module of the package is now refused); an array literal without a context type takes the shortest region of its elements instead of the first element's type, so `[header("a", b"x"), header("b", &local)]` compiles; a `T: Copy` bound on a move-only type, such as `List.get` or `Pointer.read` of a non-Copy element, is SEM0121 instead of an "unsupported" gap; `match status` on a reference is SEM0226 with a `match &status.*` hint instead of "unsupported"; an unsuffixed integer literal match arm takes the integer type of the other arms instead of forming a union with `i32`; and a union whose variant field elides a `string` lifetime, or an `impl` of a struct whose field does, now works instead of failing with SEM0051.

#### Migration

A library whose exported modules contain errors, or whose `exports` names a missing module, is now rejected at `silk check`; fix the module or the manifest entry.

Native threads now get an 8 MiB stack, the main-thread default on Darwin and Linux, instead of the platform's thread default. On macOS that default is 512 KiB, so `silk lsp` crashed with SIGBUS while checking ordinary code (a chain of about ten `||` operands was enough) on its compiler thread.

#### Migration

Migration notes not provided

Two commands that build one package at the same time, such as a build on save in an editor and `silk run` in a terminal, no longer break each other. Each command makes its intermediate files and its output in a new directory of its own beside the output, then renames the output into place, so a running command always finds a whole executable. `FileSystem.createDirectoriesRecursively` and `FileSystem.writeFileWithParents` accept a directory that another process creates while they run.

#### Migration

Migration notes not provided

Command-line polish from new-user testing:

- `silk help` prints the overview and `silk help <command>` that command's options.
- `silk --help` leads with one line for each command, project commands first, and no longer starts with `silk:`. The single-file `build` and `test` forms come last in `silk help build` and `silk help test`.
- A refused project command line names the argument and why: an unknown option with the closest one the command takes (``unknown option `--relase`; did you mean `--release`?``), a missing value, a repeated option, or `--lib` with `--workspace`. The command's usage lines follow instead of every command's.
- With no `silk.toml` found, the message suggests `silk init`.
- `silk format` on a path that does not exist says so instead of calling it outside the source root.
- `silk clean` says `Nothing to clean` when the build directory does not exist, instead of `Removed`.
- SEM0090's meaning no longer lists operation bodies, which are defaults since interface and service operations can declare them.

#### Migration

Scripts that matched `silk: usage:` in `silk --help` or in a usage error should match `usage: silk`.

`silk doctest` at a workspace root checks and runs the examples of every member with a source root, each member's results under a `Package <name>` line, instead of asking for `--manifest-path`. It fails when any example fails or no member has one. `silk format` given a directory that holds source roots, such as `.` at a package or workspace root, now selects every source root inside it instead of refusing it as outside the source root.

#### Migration

Migration notes not provided

Atomic memory operations, the first threading primitive:

- Thirteen intrinsics: `atomicLoad`, `atomicStore`, `atomicSwap`, `atomicCompareExchange`, `atomicCompareExchangeWeak`, `atomicFetchAdd`, `atomicFetchSubtract`, `atomicFetchBitAnd`, `atomicFetchBitOr`, `atomicFetchBitXor`, `atomicFetchMinimum`, `atomicFetchMaximum` and `atomicFence`. Each takes its memory ordering as static text and lowers to one LLVM atomic instruction.
- `silk.atomic` wraps them with a `MemoryOrder` enum and a `CompareExchange<T>` result.
- An ordering an operation does not admit (an acquire store, a releasing compare-exchange failure, a relaxed fence), unknown ordering text, or an element other than an integer or data pointer is the new SEM0237.
- The reference gains `reference/atomic-memory-operations.md`: the C++20 memory model and its data-race rule.

#### Migration

Migration notes not provided

Arithmetic over bare literals now takes its type from the other operand on either side of an operator: `(1 + 2) == x` with `x: i64` checks like `x == (1 + 2)` instead of failing with SEM0135.

#### Migration

Migration notes not provided

A generic `fail` whose failure type is instantiated with a union member now builds instead of reporting `unsupported[union-form]`.

#### Migration

Migration notes not provided

Preserve cached nominal identities and selective imports across unrelated source edits. Reconcile changed modules before projecting cached declaration handles, preserve deletion history, and retry failed reconciliation without publishing stale answers. Other semantic readers continue to invalidate from their consumed source bytes.

#### Migration

Migration notes not provided

The lexer finds the end of a line comment with `silk.byte_search`, sixteen bytes at a time.

#### Migration

Migration notes not provided

Passing an Effect that can fail where a call needs one that cannot, such as `pool.spawn(work())` for an `effect fn work() -> i64 ! OutOfMemoryError`, reports SEM0052 naming the error and suggesting `Effect.result(...)` instead of a bare inference failure. `Pool.spawn` documents the same.

#### Migration

Migration notes not provided

`x < y && y > (x + 1)` and similar expressions parse as two comparisons. The check for a generic call such as `make<T>(x)` no longer looks past `&&`, `||` or a closing parenthesis it did not open, which used to report PAR0001 "Expected `>`".

#### Migration

Migration notes not provided

Generic intrinsics such as `Intrinsic.pointerReinterpret<*mut Cell<T>, *mut u8>(cell)` no longer report SEM0012 inside a generic body that a `static if` turns into a selected template. The argument is typed in the closed application while the written type arguments name the caller's binders, and the two are now compared in the same domain.

#### Migration

Migration notes not provided

Command-line fixes from the documentation review:

- A Clang that cannot start is named with where it came from (`SILK_CLANG`, `--clang` or PATH), and the run still prints its target and summary lines.
- `silk build`, `run` and `test` accept `--clang <path>` for packages too.
- `install.sh` accepts Clang 18 and notes that no-libc targets need Clang 22.
- `--stdlib` naming a missing or empty directory says so instead of ARTIFACT-001.
- An invalid native link input names the manifest entry and the rule it breaks.
- Successful builds no longer print `SILK_GAP` borrow-check receipts unless `SILK_RECEIPTS=1` is set; the corpus and self-build harnesses set it.
- An unknown command word is reported as one; usage errors exit 2; `silk <command> --help` prints that command's usage.
- Doctests can import their own package, and each error prints once.
- `silk doc` warns about documentation links that resolve to nothing.
- `silk test` fails when `--file` or `--filter` selects no tests.
- `silk changes` prints the lock recovery hint only for failures that can leave a lock.
- Single-file build and test report a missing `silk.toml` the same way (exit 2).
- Human diagnostics print related locations as `note:` lines.

#### Migration

Scripts that read `SILK_GAP` lines from a build's stderr must set `SILK_RECEIPTS=1`.

A refused package parameter schema no longer hides the module's syntax errors: check and build report both. SEM0236 names both foreign linkages: `Intrinsic.foreign` and `Intrinsic.machine` apply only to `extern "C"` or `export "C"` functions.

#### Migration

Migration notes not provided

`String.fromUtf8` and the other UTF-8 checks validate text sixteen bytes at a time with byte table lookups on x86-64 with SSSE3 (for example `cpu.model = "x86-64-v2"` or `"native"`), on AArch64 and on wasm32 with `simd128`. Text with many non-ASCII characters validates about three times faster there; the reported error offsets are unchanged.

#### Migration

Migration notes not provided

`let _ = e` reports SEM0087 with a message that says it does not discard a value in Silk and points at `drop e`, instead of the generic expression statement description.

#### Migration

Migration notes not provided

Workspace roots: `silk run` runs the only executable member, `silk format` and `silk doc` cover every member, and members build, check and test in dependency order. `silk add` places a new `[dependencies]` table after `[package]`, `silk remove` drops a table it empties, packages created inside a workspace get no `.gitignore` of their own, and dependency cycles name both packages. `silk test --filter` matches the reported `module::name`.

#### Migration

Migration notes not provided

`silk format` writes raw pointer types as `[*]const u8` and `[*]mut u8`, with no space after `[*]`, matching `*const u8`. It also keeps a declaration property clause together as `with Intrinsic.foreign(...)` instead of spacing it out as `Intrinsic .foreign (...)`.

#### Migration

Migration notes not provided

`silk lsp` answers completion (`textDocument/completion`, triggered by `.`) and accepts incremental text changes. Names in scope come from the module's syntax: its declarations, imports, module aliases, and the bindings, parameters and generic parameters around the cursor, so they complete in a body that does not check yet and demand nothing. After `.`, a checked expression's type lists its fields and methods; in a half-typed body the receiver's written type answers instead, and a type or module alias lists its variants, static members or public declarations. A `didChange` notification may now carry ranged edits, applied in order.

#### Migration

Migration notes not provided

Struct fields may be separated by commas, as union variant fields are, and a trailing comma is allowed: `struct Point { x: i32, y: i32 }`. A struct whose fields are separated by line breaks alone is still accepted for now; a later version requires the commas, so one separator rule covers structs and unions.

#### Migration

Migration notes not provided

Generic code fixes found while writing `silk.work_queue`:

- A generic function or `impl<T>` method in your own package can pass static arguments, such as the `MemoryOrder` of `Atomic.load`, and use `let static`. Its unreached template body is still checked.
- Inside a generic instance whose body has static work, a local holding a call result such as `let p = parcelAt<T>(raw)` passes where the callee's own type is expected, instead of SEM0012.
- A `Drop` hook that frees a value reached through a raw pointer may drop the same generic type again at a type no larger than its own, such as an `Arc` state that releases a `Box<Node<T>>`, instead of SEM0053.
- `x |> f != 7` reports the comparison it pipes into (SEM0135) instead of an unsupported construct. `run` takes the whole pipeline, so write `(run x |> f) != 7` to compare the result.

#### Migration

Migration notes not provided

Composition fixes from the documentation review:

- Unknown keys inside `[build].composition` entries (`runtimes`, `components` and their `bindings`, `retention`) are refused at their line, also inside multi-line inline arrays, and a `defaults` entry that is not a runtime name is refused. An unknown `retention` key no longer reports that the build selects no single runtime (ARTIFACT-001).
- The `build.composition.requirements` refusal names its manifest line.

#### Migration

Remove unknown keys from `[build].composition` entries.

The compiler finds its standard library when `<prefix>/lib/silk/stdlib` is a symbolic link, as package managers often install it, and `--stdlib` accepts a symbolic link to a library directory.

#### Migration

Migration notes not provided

Two more manifest fixes from the documentation review:

- An execution-storage binding `operation` other than `create`, `acquire`, `release` or `destroy` is refused at its line instead of being ignored.
- A binding `origin` with `provenance = "literal"` that names a `translator` is refused at its line: only `translated-public` names a translator.

#### Migration

Remove unknown operations from composition component bindings, and `translator` from literal binding origins.

In a workspace, the language server now rechecks a member against the open text of the members it depends on, and keeps a member's saved text once its document closes, so an edit to a library member reaches the files that import it. Completion inside an import's member list, as in `import pricing.lib { | }`, offers only the public members of that module.

#### Migration

Migration notes not provided

A conditional conformance can bound the parts of an `Effect` type in its provider, such as `impl<'env, E: Debug> Outcome<Effect<'env; i32 ! E>> for Runner<Effect<'env; i32 ! E>>`. These bounds were rejected with SEM0120 as if they did not descend.

#### Migration

Migration notes not provided

`silk check`, `silk build` and `silk test` check the loaded modules of every dependency package along with the root package. An error in a dependency is reported at the dependency's own file and line, and fails the build even when the app never calls the broken function. Before, a dependency body was only checked through the app's calls, and its errors were reported at the app's call site.

#### Migration

Migration notes not provided

`JsonScanner` and `JsonScanState` skip plain bytes inside strings sixteen at a time where the CPU has 128-bit vectors, which makes scanning string-heavy JSON about twice as fast.

#### Migration

Migration notes not provided

`silk lsp` checks a module whose kept sweep no longer verifies one declaration per work step, so hover and other requests are answered between declarations instead of waiting for the whole module. A module the edit did not reach is still checked in one step. `Semantic` gains `moduleSweepCurrent`, `moduleDeclarations` and `prepareDeclaration` for this.

#### Migration

Migration notes not provided

The missing-Clang message mentions `--clang`; a framework link input refused at link time carries the manifest and entry prefix like other link-input errors.

#### Migration

Migration notes not provided

Sounder declarations: `impl Drop` must declare exactly `fn drop(self: &mut Self) -> ()` (SEM0084) and `impl Copy` declares no members (SEM0083), where wrong hooks used to crash at run time; linked function and static symbols must be ASCII identifiers (SEM0190) the compiler does not reserve, such as `main` or `__silk_*` (SEM0191); claims of one C symbol must agree (SEM0192), and an import of a symbol the package exports binds to that definition; `export "C" static` now defines its object and can be read by name; C-layout structs take no type parameters (SEM0205) and hold only C-compatible fields (SEM0206).

#### Migration

Programs with a Drop hook of another shape, members in `impl Copy`, reserved or non-identifier link names, conflicting C signatures for one symbol, or C-layout structs with generics or fields such as `bool` or `string` are now rejected at `silk check`; fix the declaration the diagnostic points at.

`silk doctest` with no input checks the examples of the package around the working directory (or the one `--manifest-path` names), extracting its documentation in memory and resolving its imports against its source root, so `silk doc` and `-i ... --source-root src` are no longer needed. An example imports a hyphenated package by the name its dependents write, with underscores (`doc_9.lib` for `doc-9`). Documentation command errors now name the command that failed, such as `silk doctest:`.

#### Migration

Migration notes not provided

Debug builds keep each module's LLVM text in its own file next to the cache instead of inside it. A build reuses a module's object without reading its text when nothing in the module changed, and names the build record's entries by digest instead of by their full keys. On the compiler's own sources the cache goes from about 507 MB to 108 MB plus 191 MB of module text, a build with no changes goes from about 7 seconds to 4, and a build after a one-line edit goes from about 13 seconds to 6.

#### Migration

Migration notes not provided

Foreign and match follow-ups: an `export "C" fn` in any module of the package is now emitted, not only in the root module; a declaration with a syntax error no longer adds a spurious SEM0190; a Drop hook with a `mut self` receiver is SEM0084 (the receiver is exactly `self: &mut Self`); and a type binder arm such as `Color v =>` after arms that already cover every member is SEM0043, as `_` is.

#### Migration

Migration notes not provided

`silk.http_server` answers an HTTP/1.0 request with an HTTP/1.1 response head, as RFC 9110 allows, so a server that always responds with HTTP/1.1 serves HTTP/1.0 clients such as `curl --http1.0` and ApacheBench. Such a response cannot be chunked. A request the server cannot read now gets a bare status before the connection closes, instead of a closed socket: 400 for a malformed head or body framing, 413 for a body over the limits, 414 for a long target, 431 for header fields over the limits, 501 for an unknown transfer coding, and 505 for an unknown version. With `maxInformationalResponses` set to 0, `Expect: 100-continue` reads the body without sending `100 Continue`. The docs of `Path.resolve` say that a single trailing `/` is ignored.

#### Migration

Migration notes not provided

A semantic store can keep editor tables: `Semantic.selectEditorTables` makes each checked body record the names its syntax resolves (the declaration a call or value read selects, the local a use reads, the field a projection names, and the type an annotation writes), each at its own anchor-relative origin. The language server selects them; builds and checks leave them off and their output and memory are unchanged.

#### Migration

Migration notes not provided

The silk tool answers a first word one edit away from `use`, `set` or `update` (such as `silk uze`) with a suggestion instead of forwarding it to the compiler. `silk use <version>` replaces a version directory that lost its compiler, `silk use uninstall` removes one, and an install that holds the lock removes staging directories interrupted installs left. A member's own `silk-version` that disagrees with its workspace's pin is named in a note on every forwarded command and in `silk use which`. `silk set` names the version it replaced on its result line and no longer suggests `silk changes since`, which did not work in user projects. A `SILK_TOOLCHAIN` that is not a version is a usage error (exit 2) like a malformed `+<version>`, and `silk use list` without a usable `SILK_HOME` says so instead of reporting no versions.

#### Migration

Migration notes not provided

A repeated `?` in an optional type spelling, and `?` written in a type argument, are reported once as PAR0007 instead of a cascade of parse and name errors.

#### Migration

Migration notes not provided

`silk lsp` starts warm from the semantic cache `silk check` writes: module checks whose sources still read the same are current as soon as a package opens. The server writes the cache once a package's first full check finishes and again on `shutdown`. On the compiler package, the first diagnostics for `main.silk` arrive after about 8 s instead of 55 s.

#### Migration

Migration notes not provided

`silk foo.silk` or `silk ./frob` with no such file reports the missing source file and exits 2 with the usage, instead of `cannot read: not found`.

#### Migration

Migration notes not provided

On wasm32 and other non-hosted runtimes, SEM0225 names the entry shapes the selected runtime accepts.

#### Migration

Migration notes not provided

Fewer language gaps:
- `while true` without a `break` never completes, so `fn f() -> never { while true { } }` checks and code after it is unreachable.
- `let f: fn(i32) -> i32 = inc` accepts a named function or closure whose contract matches, and intrinsic results such as `Intrinsic.pointerNull<i32>()` coerce to annotated, argument and result types like other values.
- `if let` works on scalar enum members, a scalar `match` can bind the whole value with a type binder (`i32 x => ...`), enum discriminants accept `0x`/`0o`/`0b` literals, struct patterns may nest enum members (`Paint { color: Color.Red, .. }`), and pattern `let`/`if let` take a temporary without `move`.
- `loop { }` reports PAR0006 with the `while true` spelling, and `const A = 5` reports one SEM0086 asking for the type annotation.
- Lifetime inference no longer depends on parameter order, and a result-only lifetime with several outlives bounds shortens to their meet instead of `'static`.
- A named `effect fn` with generic contents gets an elided environment (`effect fn keep<A>(value: A) -> A` checks), `where S in R` lets a `? S` effect run inside `? R`, and a requirement row naming one service with both shared and exclusive access is SEM0233.

#### Migration

A requirement row such as `? &Clock | &mut Clock` is now rejected with SEM0233; write the service once with the access you need.

`silk lsp` answers find references (`textDocument/references`), rename (`textDocument/rename`) and workspace symbols (`workspace/symbol`). A search reads only the modules whose text spells the name and resolves each written name the way hover does, so it finds a declaration through imports, headers, bodies and its own name, and a local or generic parameter within its body. Rename refuses a new name that is not an identifier and a declaration from outside the package.

#### Migration

Migration notes not provided

A long `silk lsp` session no longer grows with every edit: after each step the server drops the roots its request demanded and the lowered MIR functions that reruns replaced (`Request.forgetRoots`, `Semantic.releaseStaleMir`). Over 40 edits to the standard library the store grew 6 MB instead of 107 MB. `silk check --replay` reports `answers=` and `mir-functions=`, and CI replays a twenty-edit script that must end the same size it started.

#### Migration

Migration notes not provided

`silk format` keeps a comment after a bare `return`, such as `return // nothing to do`, where it lately refused the file, and no longer adds a blank line after that `return`.

#### Migration

Migration notes not provided

The front door that dev releases installed as `sew` is now `silk`, and the compiler in a release is `bin/silkc`: `silk use`, `silk set`, `silk change` and `silk update self` replace the `sew` commands, and every other `silk` command still runs in the selected version. `silk help` lists both the project commands and the tool's own. A dev install that has `$SILK_HOME/bin/sew` moves over by running install.sh again, which removes `bin/sew`. The tool still runs versions released before the rename, whose compiler is `bin/silk`.

#### Migration

Migration notes not provided

A call with too few arguments, such as `add(2, 3)` for a three-parameter `add`, used where a plain value is required (a returned or assigned value, an argument, or an operand) now reports `SEM0007 Expected 3 arguments but received 2` at the call. It used to report a misleading error at the surrounding return or operator. A call with fewer arguments is still a partial application wherever a callable fits, as in `let partial = add(2, 3)`.

#### Migration

Migration notes not provided

A long postfix chain such as `a.inner.inner...`, `f().f()...` or `x[0][0]...` no longer crashes `silk check` or the language server: each link after the first is charged its stack cost, so 167 field or index links or 71 method calls fit and a longer chain reports PAR0005. A flat chain of infix operators such as a generated `1 + 1 + ...` no longer counts each operator as a nesting level, so it fits up to 499 operators (it was 256).

#### Migration

Migration notes not provided

A once Effect passed to a `mut Effect` parameter, or a `mut fn` passed to a `fn` parameter, reports SEM0076 naming both modes instead of SEM0052.

#### Migration

Migration notes not provided

`silk toolchain which` with `SILK_TOOLCHAIN=local` reports the running compiler; `silk +<version>` refuses a version that is not a semantic version; a relative `SILK_TOOLCHAIN_MIRROR` is reported as `silk toolchain: ...`; `silk toolchain --help` prints the toolchain usage; and a `HOME` that does not exist is refused instead of having settings created below it.

#### Migration

Migration notes not provided

`silk toolchain use` in a workspace now also updates the `silk-version` of every member that pins its own version, so the members no longer keep naming the old version. Run inside a member, it pins the workspace that lists the member, as it already did when the workspace had a pin.

#### Migration

Migration notes not provided

