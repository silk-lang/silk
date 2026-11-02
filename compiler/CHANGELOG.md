# Changelog

Auto-generated from `.changes/releases/*.toml`. Manual edits are overwritten on the next release; edit the authoritative TOML files instead.

## 0.1.0

### Minor

- Add the `wasm32-wasip1` and `wasm32-wasip2` targets with filesystem, networking, HTTP and WIT component support.
- An unoptimized debug executable, which compiles each codegen unit apart, carries line tables too, so debuggers, symbolizers and backtraces show `file:line:column` for its Silk frames. Each unit's lines come from its own text, so a function that moves recompiles only its unit. `--emit llvm-ir` of a debug build prints the same line tables as `!dbg` metadata.
- A `with Namespace.operation(...)` clause after a declaration header is no longer Silk syntax; it reports PAR0011, which names the directives to write before the declaration instead.
  - **Migration:** Move each `with Intrinsic.*(...)` clause into directives on the lines before the declaration: `with Intrinsic.inlineAlways()` is `@inlineAlways`, `with Intrinsic.foreign(memory: "read", callbacks: ("f",))` is `@foreign(memory: "read")` and `@callbacks("f")`, `with Intrinsic.machine(features: ("avx2",), naked: true)` is `@features("avx2")` and `@naked`, and `with Intrinsic.foreign(module: "m", name: "n")` on an import is `as "m#n"` after the signature.
- Interface and service operations can have default bodies.
- Rename the growable `Vector` collection to `List`.
  - **Migration:** Import `List` from `silk.list` instead of `Vector` from `silk.vector`, and rename `Vector` to `List` in types and calls.
- A structural union conforms to an interface when every member implements it (UNION-003).
- Add `silk check --roots` to cross-check per-module checking.
- `silk lsp` answers document symbols, folding ranges and formatting.
- A fatal trap in an unoptimized build also names the functions that called the trapping one.
- Interfaces can declare `static fn` operations, which conformances supply with `static fn` witnesses and static evaluation calls through the interface.
- Add `Corners` and `RoundedRect` to `silk.geometry`.
- Add `silk.geometry` (Point2/3, Vector2/3, Size2, Insets, Rect, Affine2, Matrix3/4) and the `Zero`, `One`, and `Float` interfaces to `silk.num.numeric`.
- `wasm32-unknown-unknown` modules report unhandled errors and traps into a buffer they export as `silk_report`, and the std lib's `host/wasm-runner.mjs` prints that report, rejecting a trap with a `SilkError` that carries it next to the engine's stack. A debug `wasm32-unknown-unknown` executable ships without its DWARF: it is written beside the module as `<output>.debug.wasm` for Chrome's DWARF support, with a source map `<output>.map` for Firefox and Safari.
  - **Migration:** The error type of an Effect that a `wasm32-unknown-unknown` program's `main` returns must implement `Debug`, as on native and WASI targets.
- Add `[native].function-order`, a file listing the functions a Linux or macOS executable places first in its code, so startup code can share pages.
- Allow one C declaration to combine `@callbacks`, `@deferredCallbacks` and `@threadCallbacks` lists that name different callbacks.
- Stable releases are prepared through a managed release PR; dev builds are published daily.
- Add transferable Execution handles that may move between threads.
- Add SIMD lane arithmetic, reductions, mask operations, loads, stores and conversions (SIMD-004, SIMD-005).
- `List.appendRepeated` works for any `Copy` element type, and new `List.appendSlice` appends a slice of any `Copy` element type in one copy.
- Add `build.silk`: a package computes generated modules, native sources and link entries at compile time with `silk.build.plan`, sandboxed by static evaluation.
- Run build.silk tool steps sandboxed on macOS through `sandbox-exec`, confining reads, writes and the network.
- The runtime prints an unhandled error's `Debug` value.
  - **Migration:** Every error type an effectful `main` can raise must implement `Debug`; `Format.debugFields` does it in one line.
- `silk lsp` with a missing pinned toolchain shows the install command in the editor.
- Native threads run on wasm32 with `threading = "multi"`.
- Add build.silk tool steps: a package program runs in a Landlock sandbox on Linux, a dependency's steps need the root's `[build].tools`, and `[build].unsandboxed-tools` opts in elsewhere.
- Add `Deflate.encodedBound`, the output size that `Deflate.encode` always fits in.
- `==` and `!=` compare two byte slices by their bytes, and `&[T]` implements `Equal` and `Order` element by element when `T` does.
- `Reflect.variants`, `variantLabel`, `variantFields`, `makeVariant` and `isVariant` reflect over the variants of a nominal union, and `Reflect.typeKind` reports `unionKind` for one.
- `string` and every integer type now implement `HashKey`, so `HashMap<string, i32>` and `HashSet<u64>` work without a key wrapper.
- Add `silk.build.source` (`Source.read`, `Source.text`) and `Intrinsic.embed`/`embedText` to embed package files at compile time.
- Add `silk.thread_pool`, a work-stealing thread pool.
- Admit lifetime parameters on `extern "C"` records, such as `extern "C" struct BufferRef<'a>`.
- A fatal trap in an unoptimized build also names the suspended callers of a function that resumed, such as the function a fiber forked, which the machine stack no longer holds once the function has parked. WebAssembly programs, which have no unwinder, now name these callers too.
- Method-call syntax and interface operations supply `static` arguments, through the interface, a method call or a generic bound.
- Format templates take `{1}` and `1$`/`w$` widths; `List` implements `Debug`.
- Add `silk.text.glob` for glob pattern matching and `silk.system.glob_scan` for finding the files a pattern matches.
- Add `silk generate [--check]`: runs a package's `[[generate]]` commands, keeps unchanged outputs untouched, and fails `--check` when committed output is stale.
- wasm32 executables reuse freed memory.
- Slices, fixed arrays, tuples and records have `Debug` forms.
- Add `[native.archive.<name>]`: hash-pinned archives fetched once into the archive store and named as `<name>:<path>` in `[native]` entries, with root and machine `[native.override.<name>]` directories.
- Add `silk check --replay <script>` to measure incremental rechecks.
- Add `silk lsp`, the language server.
- Add `Option.isSome` and `Option.isNone`.
- Add `Slice.asBytes` and `Slice.asMutBytes`, safe byte views of a slice of integers or floats, bounded by the new `ByteView` interface.
- Add `silk.sync` with `Arc`, `Mutex` and `Parker`, and `Pointer.borrow`/`borrowMut`.
- Add `silk.simd.*` modules, one per vector shape, and `silk.simd.mask*`.
- `silk lsp` answers hover, go to definition, inlay hints and signature help.
- A library's `[native].link` now reaches the executables that depend on it, and a link entry can name the systems it links on with `os = "macos"` (or a list).
- Add change notes and migration history for Silk packages (`silk change`, `silk change since`).
- `Writer.writeVectored` has a default body and `Writer.writeEach` is removed.
  - **Migration:** Delete a `writeVectored` implementation that only forwarded to `Writer.writeEach`.
- Inherent `impl` blocks can bound their parameters, as in `impl<T: Float> Vector2<T> { ... }`; their members exist where the bounds hold.
- Add `Pointer.borrowMany`/`borrowManyMut` and inline clauses `with Intrinsic.inline()`, `inlineAlways()` and `inlineNever()` (FUNC-003).
- Linux executables link without PIE by default; set `relocation = "pic"` in a profile for a PIE.
- Add `Effect.timeout` and `Effect.timeoutAt`: under a Scheduler, an effect still parked at its deadline is stopped in place, without a new Fiber, and fails with `TimeoutError`.
- Add `makeWithCapacity` to `List`, `Bytes`, `String`, `HashMap`, and `HashSet`, and `reserve` to `Bytes`, `String`, `HashMap`, and `HashSet`.
- Link Linux and macOS executables for another target when a platform supply resolves (an explicit `[native].platform-supply`, `SDKROOT`, or the SDK a Mac discovers), and add the `x86_64-apple-darwin` target.
- SIMD vectors can cross the C boundary as `extern "C"` parameters and results.
- Add `Slice.viewMut`, an exclusive subrange of a `&mut [T]`.
- Add SHA-256 architecture operations with portable fallbacks.
- `silk lsp` syncs open documents and publishes syntax diagnostics.
- `install.sh` installs into `$SILK_HOME/toolchains/<version>`; `SILK_HOME` replaces `SILK_INSTALL`.
  - **Migration:** Set `SILK_HOME` instead of `SILK_INSTALL`.
- Add repeated array expressions `[value; count]`.
- Package parameter values move to a typed `[config]` table.
  - **Migration:** Rewrite each `[[build.bindings]]` entry as a line under `[config]`, such as `main.port = 8080`, and profile bindings as `config.<module>.<parameter>` in `[profiles.<name>]`.
- Add `Intrinsic.simdShuffle` (SIMD-006).
- Generic recursion may move into the owned structure of a type argument (GEN-006).
- Add `silk.byte_search` with SIMD byte search.
- Move the last top-level std modules into their categories: `silk.option`, `silk.equal`, `silk.order` and `silk.ops` are now `silk.core.option`, `silk.core.equal`, `silk.core.order` and `silk.core.ops`; `silk.layout` is `silk.mem.layout`; `silk.format` is `silk.text.format`.
- A slice can provide an interface, and `Reflect.typeKind` answers for every type.
  - **Migration:** Where a reference is expected, `&s` for a slice `s` now borrows the slice itself (`& &[T]`); write `s` to pass the elements' borrow.
- Build macOS executables on any host without an Apple SDK: with no SDK found, links use Silk's own libSystem stub and `ld64.lld`.
- Add git dependencies pinned to a commit, as `vector = { git = "https://github.com/example/gpu.git", rev = "<full commit hash>", path = "vector" }`; `path` selects one package of a multi-package repository.
- The Execution package protocol is safe when a Wake is signaled from another thread.
- Add the Windows x86_64 target, no-CRT runtime, and native filesystem, process, and thread providers.
- Add optional services with `&Option<&S>` and `withSome`.
- Add `Slice.copyInto`, a bounds-checked bulk copy from one slice into another.
- WASI programs and tests report unhandled errors and traps like native ones, debug wasm builds name their functions as the source does, and `silk run` and `silk test` show each trap frame's source line.
  - **Migration:** The error type of an Effect that a WASI program's `main` returns must implement `Debug`, as on native targets.
- Add native threads (`silk.native_thread`) and `Pointer.take`/`Pointer.put`.
- `silk changes` is now `silk change` in the silk tool, and release settings live in `[release]`.
  - **Migration:** Replace `silk changes add <bump>` with `silk change <bump>`, and rename `[changes]` to `[release]` in `silk.toml`.
- Struct fields must be separated by commas (PAR0001 otherwise).
  - **Migration:** Add a comma after each struct field: `struct Point { x: i32, y: i32 }`.
- Silk versions belong to the `silk` tool; the compiler is `silkc` and no longer installs toolchains.
  - **Migration:** Replace `silk toolchain ...` and `silk +<version>` with `silk use`, `silk use <version>` and `silk set <version>`.
- Multi-package builds and checks show one line per unit and a final `Finished N packages` on stderr.
  - **Migration:** Scripts that read the `Package` headers or `Workspace summary` from stdout must use the exit status or the stderr report.
- A profile can set `cpu = { model = "native" }` to build for the running machine.
- An interface conformance may also live in the module that declares its first type argument, so a library can define `2.0 * vector` for its own vector type.
- Add per-function CPU features with `with Intrinsic.machine(features: (...))`.
- `silk build` and `silk check` show live progress on stderr; `--progress`, `--quiet` and `NO_COLOR` control it.
- Add `Pool.timeout` for thread pool fibers, with a per-fiber `PoolTask` provider that holds its deadlines; an Effect bound with fixed requirements now infers its success and failure from an Effect that needs fewer.
- Add `silk.arena`, an arena allocator.
- Add `countOnes`, `leadingZeros`, and `trailingZeros` to every integer module.
- Add `Intrinsic.allocationAdopt` for allocations over caller-provided storage.
- Add lambdas, `|x| x + 1` and `|x: T| -> R { ... }`, whose omitted parameter and result types come from where they are used.
- New `List.insertSlice` and `List.insertRepeated` insert many `Copy` elements at an index, growing the list at most once and moving the later elements with one overlapping copy.
- Add `Reflect.borrowFieldMut` to borrow a reflected field mutably.
- `string` now implements `Order` (by UTF-8 bytes) and `Equal`, and `f32` and `f64` implement `Order` with the IEEE 754 total order, so `List<string>.sort` and `List<f64>.sort` compile.
- Compiler builds carry one exact version, with commit-identifiable dev releases such as `0.1.0-dev.2+a1b2c3d4e5f6`.
- Add the nullable native function pointer type `?extern "C" fn(...) -> R` for C callback slots that may hold NULL, with `Intrinsic.pointerNullFunction`, and admit it in `Intrinsic.pointerIsNull` and `Intrinsic.pointerRequalify`.
- Add LZMA, LZMA2 and XZ decoding, and DEFLATE/zlib/gzip encoding with `Deflate.encode`.
- Add `multiplyHigh` to every integer module, such as `u64.multiplyHigh`, for the high half of a full double-width product.
- Add `effect` lambdas, `effect |x| run next(x)`, whose channels come from where they are used or from their body, so `Effect.flatMap(effect |who| run greet(who))` works.
- `silk build --target wasm32-unknown-unknown` links a freestanding WebAssembly module on any host.
- Add AES and carry-less multiplication architecture operations, with portable fallbacks in `silk.arch.aes`.
- Add Unicode 18 character properties, scripts, grapheme/word/sentence segmentation, line breaking with CSS options and Thai/Lao/Khmer/Myanmar dictionaries, bidi and script itemization to `silk.text`, and move NFC/NFD to Unicode 18.
  - **Migration:** Replace `Unicode.canonicalCombiningClass(cp)` with `CanonicalCombiningClass.of(cp).number()`, importing `CanonicalCombiningClass` from `silk.text.unicode_properties`. Replace `silk.text.unicode_tables` with `silk.text.unicode_data`.
- Add dotted tuple literals: `.(a)` is a one-element tuple without a trailing comma, as in `Format.format("{}", &.(count))`, and `.(a, b)` and `.()` work too.
- Add `silk.blake2b` and `silk.ed25519`.
- Add `silk.work_queue` with `WorkDeque`, `Injector` and `Mailbox`.
- Add `clearAndFree` to `List`, `Bytes`, `String`, `HashMap`, and `HashSet`, and `clear` (keeps the storage) to `String`, `HashMap`, and `HashSet`.
- Rework the `silk.toml` layout: `[package].source`, `main` and `kind`, `[native]`, `[unstable]`, publishing metadata, and dependency `silk-version` release lines.
  - **Migration:** Rename `[package].root` to `main` (relative to `source`), `[package].source-root` to `source`, `[build].artifact` to `[package].kind`, `[build].native-link-inputs` to `[native].link`, `[build].platform-supply` to `[native].platform-supply`, `[build].composition` to `[unstable].composition`, and profile `maxMemory`/`codeModel` to `max-memory`/`code-model`. A dependency's `silk-version` must share the compiler's release line.
- `silk build`, `check` and `run` report progress on stderr instead of printing `Compiled ...` and summaries on stdout.
  - **Migration:** Scripts that parsed `Compiled ... -> ...` or `build llvm/<target>: ok` from stdout must read the progress report on stderr or use the exit status.
- The compiler emits wasm32 objects with direct C calls.
- `silk build --timings` and `silk check --timings` list the slowest modules and functions.
- `silk debug` builds the package and starts it under a debugger: LLDB for a native program (`SILK_LLDB` overrides it), and for a WASI program Wasmtime's debugger stub, which waits on `--port` (1234 by default) for LLDB's `process connect --plugin wasm`. `silk run --coredump <path>` has Wasmtime write a core dump when a WASI program traps.
- `silk.io.logger_console.ConsoleLogger` logs from `wasm32-unknown-unknown` to the host's console through a `silk.console` import that only a module using it has, and `host/wasm-runner.mjs` supplies it (`options.onLog`). `silk.io.logger_wasi.WasiLogger` logs from `wasm32-wasip2` components through the draft `wasi:logging` interface, which the bundled `command` world now lists.
- Add `Pointer.dropInPlace`, which drops the value at a pointer without copying it out first.
- Add architecture SIMD operations for x86-64, AArch64 and wasm32 with portable fallbacks in `silk.arch.*`.
- Add `silk.http_client`, a high-level HTTP client with a request builder and buffered responses.
  - **Migration:** The previous low-level `silk.http_client` is now `silk.http_exchange`: rename the import, `ClientError` to `ExchangeError`, and `NativeClientError` to `NativeExchangeError`.
- A directory's `mod.silk` is the module its directory path names (MODULE-007).
- Add `tan`, `atan`, `atan2`, `asin`, `acos`, `exp`, `log`, `pow`, `cbrt`, `hypot` and `fma` to `silk.num.f64` and `silk.num.f32`.
- Add the thread properties `Transferable` and `Concurrent` (`silk.thread`).
- Add `wrappingTo` conversions between every pair of integer types, which keep the low bits like a C or Rust cast (`u16.wrappingToI16`, `i64.wrappingToI32`).
- `if` with a final `else` is an expression, and value blocks yield their last expression.
- `silk lsp` publishes semantic diagnostics; `--stdlib` selects the standard library.
- Add HTTP/2 client and server connections (`silk.http2`, `silk.http2_connection`).
- Add directives: write `@inline`, `@features("avx2")`, `@foreign(memory: "read")` and the rest before a function in place of a `with Intrinsic.*(...)` clause, and a WebAssembly import as `extern "C" fn read() -> i32 as "module#name"`. Reference roles are now written `&T #Role`.
  - **Migration:** Mark a reference's role with `#` instead of `@`: write `&Port #Reader` for `&Port @Reader`. `with` clauses keep compiling for now.
- Expand the CPU feature catalog (AVX-512, BMI, FMA, SHA-3, dot product, relaxed SIMD), add `x86-64-v2/v3/v4` CPU models, and add `silk.simd` width helpers.
- A conditional conformance bound may repeat its parameter in the interface arguments, as in `impl<T: Add<T, T>> Sum<T> for Vec2<T>`, instead of reporting SEM0120.
- Add `String.capacity`, `String.reserveExact`, `String.shrinkToFit`, and `Bytes.shrinkToFit`; `List.shrinkToFit` on an empty list now releases its storage.
- `silk check --replay <script> --differential` compares each replayed revision against a fresh one-shot check.
- Add `Fiber.interrupt`, `Fiber.awaitEither` and `Fiber.race`: a parent can cancel a running child and wait for the first of two children.
- Add built-in SIMD types `simd<T, N>` and `mask<N>` with lane-wise operators and `Intrinsic.simd*` operations (SIMD-001).
- Add the `with Intrinsic.cold()` function clause: the function is never inlined and calls to it are treated as rarely reached.
- Add `[native].sources`: the build compiles a package's C, Objective-C and C++ files with Clang into cached objects that link like its `[native].link` entries.
- Add workspaces and path dependencies: `silk init --workspace|--lib`, `silk add`, `silk remove`, and workspace-wide commands with `-p`/`--workspace`.
- Add `silk.buffered_output.BufferedWriter`, a `Writer` that owns a destination `Writer` and buffers small writes.
- A debug build describes each parameter and `let` binding to the debugger, by name and type, at the slot that holds it, so LLDB's `frame variable` shows them in native and WebAssembly programs (also through `silk debug`). Integers, floats, `bool`, `char`, references, pointers, strings, slices, arrays and records are described; a record's fields are named by position for now, and a union shows its tag. Variables of a function that suspends, which live in its saved frame, are not described yet. `--emit llvm-ir` writes the same `#dbg_declare` records.
- Add `silk.cpu` for runtime CPU feature detection (`CpuFeatures.detect()`).
- Add `silk.core.schedule` with `Schedule`, and `Effect.repeat` and `Effect.retryWhile`; `Effect.retry` now takes a `&Schedule`.
  - **Migration:** Replace `Effect.retry(effect, n)` with `Effect.retry(effect, &Schedule.recurs(n))`, importing `Schedule` from `silk.core.schedule`, and provide `MonotonicClock` and `InsecureRandom` to the result, for example `OsMonotonicClock.make()` and `InsecureRandom.seeded(1)`.

### Patch

- The first `silk check` after a build reuses the build's analysis instead of walking every dependency from the runtime again, about 0.8 s instead of 6.7 s on a large multi-package program.
- A WebAssembly import, `as "module#name"`, on a non-wasm target now reports SEM0193 at its declaration in both `check` and `build`.
- An ambiguous documentation link names its candidates.
- Generated reference pages name generic implementations, with anchors such as `Box.impl.Drop`.
  - **Migration:** Update hand-written links to `#impl`, `#impl-2` or `#impl.member` anchors to the owner-qualified form, such as `#Box.impl.make`.
- Fix `Unicode.canonicalCombiningClass` and NFC/NFD ordering for the 34 marks Unicode 17 added, such as U+1ACF.
- `silk doctest` builds and runs examples that declare a `main`; mark compile-only examples `silk,no_run`.
- `c ? a : b` now suggests an `if` value, and a bare `match` through a reference reports one OWN0003 that suggests `&`.
- Language server hovers turn doc comment code links into links.
- Instance symbol names fold both digest halves in one pass over the encoding.
- `silk change` release notes list each change as one line and leave out empty migration sections.
- Appending a struct whose invariant lifetime comes from a body loan, such as a `Plan<'a>` holding a `List<Item<'a>>`, to a let-bound `List<Plan>` no longer reports SEM0012.
- Debug builds split large modules into 1 MB codegen units, so an edit recompiles about a quarter second of Clang work instead of 1.4 s.
  Builds write the semantic cache file on a thread of their own while codegen units compile and link.
  A `static for` over thousands of fields checks faster: MIR lowering no longer takes each call from the front of a list.
- Interface operations may declare their own type parameters, such as `fn echo<T>(self: &Self, value: T) -> T`, called as `Echo.echo<i32>(&p, 7)`, `p.echo(7)` or with inferred arguments.
- SEM0139 for a `@nonParking` operation run through `Effect.provideMut` points at your call instead of into the standard library.
- More diagnostics are reported at the user's call; `with Intrinsic.*` on a non-linked declaration is SEM0236.
- Copy coalescing counts how every local is named in one walk per function instead of rescanning the whole body for each candidate. Front-end instructions drop 6.1% on an hr_shape build.
- `silk doc` attaches a `///` block written between a declaration's directives and its header, and documents exported modules the root does not import.
- Split the cold cycle-scan, rotated-member and trace-recording paths out of `demandUnit`, `memberCycleAnswer` and `emit`, so their hot hit paths stay small. Front-end instructions drop 0.34% on an hr_shape build.
- Single-file `silk build` prints human diagnostics.
- `BufferedWriter` and `BufferedOutput.writeSomeWriter` send the pending bytes and then copy a write shorter than the buffer, so a `Writer` without its own `writeVectored` gets one write per fill.
- SEM0087 names the dropped result, and pipe precedence mistakes get a note.
- An unknown silk.toml field or table that is close to a supported one now names it, as in `package.nmae is not a supported field; did you mean package.name?`.
- Many instances of a generic function over a large struct build in linear time.
- A directive written twice, or two clashing inline hints, on a function now reports SEM0250 instead of an uncoded `unsupported`.
- A narrow union member, such as a one-byte error enum in a `Result<&[u8], E>`, is stored as a whole word, so copies of the union stay word-aligned and no longer miss store forwarding.
- Every standard library error implements `Debug`; add `Format.debugRecord` helpers and SEM0246.
- A call with a written type argument naming a caller lifetime, such as `hold<&'p i32>(&local)`, now rejects a borrow of a local at that lifetime (SEM0212).
- A missing root module names its path, and an unknown profile field suggests the nearest one.
- A `static for` whose iterable names something unknown, such as `Reflect.fields<T>()` without its import, reports that name (SEM0009) instead of an unsupported construct. SEM0009 also suggests the import for `Reflect`, `Format`, `StdoutWriter`, and `StderrWriter`.
- A dependency refused for its `silk-version` says what to do.
- Every diagnostic prints a message; project `silk build` prints diagnostics like `silk check`.
  - **Migration:** Tools that parsed `SILK_BUILD_ERROR` or `SILK_GAP borrow-check` lines from project `silk build` or `silk run` must use `silk check --json`.
- Stack lifetime markers shrink frames, raising nesting limits and reducing stack use of deep recursion.
- A typed `let` with a failing initializer still binds its name, so later errors appear in the same check.
- A `mut fn` binding passed to a `mut fn` parameter stays usable afterwards; passing it twice to one call is OWN0010.
- A git dependency written with `tag` or `branch` is refused with the hint to pin it to a full commit hash with `rev`.
- A no-change `silk check` is about twice as fast.
- `silk doc` and `silk doctest` print the dependency problem (such as a commit that is not fetched yet) instead of a generic invalid-project message.
- `UuidError`, `HpackError` and `ProtocolError` implement `Debug`.
- Language server hover and go to definition keep working in bodies with errors.
- SEM0012 for a call argument names the expected and actual types.
- Static evaluation charges a value shared by many calls once, so `Format.format` templates of a few thousand bytes or dozens of placeholders no longer hit SEM0181.
- A directive the parser already refused, such as one before an `import`, no longer also reports SEM0235 or SEM0236.
- Scalar enum errors (SEM0146 to SEM0162) now name the enum, member, value and representation range, and point to `Status.value(x)` where an enum meets an integer; static evaluation budget errors (SEM0179 to SEM0181) name their limit.
- The HTTP parser accepts `HTTP/1.1 200` with no reason phrase; the WebSocket server sends proper Close codes.
- SEM0121 for a `string` key, as in `HashMap<string, i32>.insert`, now says `string: silk.hash.HashKey` cannot be proved instead of the bare generic message.
- `silk format` formats a single `.silk` file outside any package.
- `silk lsp` shows why a package cannot be loaded, such as a git dependency whose commit is not fetched yet, on the first line of its open documents instead of publishing no diagnostics.
- Diagnostics fill more messages, unsupported constructs print as `path:line:col` lines, and named profiles build into their own directory.
  - **Migration:** Scripts that read `SILK_UNSUPPORTED_JSON` from project `silk check`, `build` or `run` must use `--json`. Named `--profile` outputs are now under `build/llvm/<target>/<profile>/`.
- The language server works in standard library files and on import statements.
- Several `_` field discards in one pattern work, and `List.insert` traps on an index past the length.
- Editing a logged or formatted message rebuilds only what the new message changes, not the whole program (the starter project: 649 functions to 12, 0.6 s to 0.28 s).
- Child processes start with `posix_spawn` on Linux, and Clang codegen is scheduled biggest first.
- OWN0004 shows how to move a value out before assigning its replacement.
- A generic comparison conformance, such as `impl<T: Equal> Equal for Value<T>`, now applies to `&a == &b` at a concrete type like `Value<i32>`, as generic arithmetic conformances already did.
- HIR nodes are 96 bytes instead of 160, which lowers a cold check or build of a large package by about 75 MB.
- Formatted calls check faster (100 distinct `log` templates build in 12.6 s instead of 16.4 s).
- Raw pointers can be union members, and generic `catchFailure`/`Effect.catch` handlers are instantiated at the failure type.
- The borrow checker visits only the loans in scope and the moves that reach each point, instead of testing every loan and move there. Compiling the compiler takes 1.3% fewer front-end instructions.
- Filesystem paths resolve through directories with search permission only.
- Type mismatch messages print types that contain generic parameters.
- Each query answer is about a third of its former size, so a cold check or build of a large package peaks about 7% lower.
- Binding and composition refusals name their field and line.
- SEM0167, SEM0019 and SEM0012 messages name what they are about.
- Rechecks and debug rebuilds after an edit only redo the modules and codegen units the edit reaches.
- `drop` and `fail` of a call with a `static` parameter, such as `drop unsafe Atomic.fetchAdd<u32>(...)`, now compile.
- Group the standard library into category directories, such as `silk.collections.list` and `silk.json.value`.
  - **Migration:** Replace each import path on the left with the one on the right. Where a namespace import's last segment changed (for example `import silk.toml_scanner` now binds `scanner`), rename its uses or add `as` with the old name.

    | Old | New |
    | --- | --- |
    | `silk.result` | `silk.core.result` |
    | `silk.effect` | `silk.core.effect` |
    | `silk.ownership` | `silk.core.ownership` |
    | `silk.bool` | `silk.core.bool` |
    | `silk.reflect` | `silk.core.reflect` |
    | `silk.compilation` | `silk.core.compilation` |
    | `silk.target` | `silk.core.target` |
    | `silk.static_sequence` | `silk.core.static_sequence` |
    | `silk.static_text` | `silk.core.static_text` |
    | `silk.i8` | `silk.num.i8` |
    | `silk.i16` | `silk.num.i16` |
    | `silk.i32` | `silk.num.i32` |
    | `silk.i64` | `silk.num.i64` |
    | `silk.isize` | `silk.num.isize` |
    | `silk.u8` | `silk.num.u8` |
    | `silk.u16` | `silk.num.u16` |
    | `silk.u32` | `silk.num.u32` |
    | `silk.u64` | `silk.num.u64` |
    | `silk.usize` | `silk.num.usize` |
    | `silk.f32` | `silk.num.f32` |
    | `silk.f64` | `silk.num.f64` |
    | `silk.numeric` | `silk.num.numeric` |
    | `silk.allocator` | `silk.mem.allocator` |
    | `silk.arena` | `silk.mem.arena` |
    | `silk.box` | `silk.mem.box` |
    | `silk.metrics` | `silk.mem.metrics` |
    | `silk.output` | `silk.mem.output` |
    | `silk.pointer` | `silk.mem.pointer` |
    | `silk.raw_buffer` | `silk.mem.raw_buffer` |
    | `silk.shared` | `silk.mem.shared` |
    | `silk.slot` | `silk.mem.slot` |
    | `silk.stack` | `silk.mem.stack` |
    | `silk.list` | `silk.collections.list` |
    | `silk.bytes` | `silk.collections.bytes` |
    | `silk.hash` | `silk.collections.hash` |
    | `silk.hash_map` | `silk.collections.hash_map` |
    | `silk.hash_set` | `silk.collections.hash_set` |
    | `silk.slice` | `silk.collections.slice` |
    | `silk.string` | `silk.text.string` |
    | `silk.char` | `silk.text.char` |
    | `silk.unicode` | `silk.text.unicode` |
    | `silk.unicode_tables` | `silk.text.unicode_tables` |
    | `silk.utf8_decoder` | `silk.text.utf8_decoder` |
    | `silk.byte_search` | `silk.text.byte_search` |
    | `silk.writer` | `silk.io.writer` |
    | `silk.logger` | `silk.io.logger` |
    | `silk.byte_duplex` | `silk.io.byte_duplex` |
    | `silk.buffered_duplex` | `silk.io.buffered_duplex` |
    | `silk.buffered_input` | `silk.io.buffered_input` |
    | `silk.buffered_output` | `silk.io.buffered_output` |
    | `silk.buffered_transfer` | `silk.io.buffered_transfer` |
    | `silk.standard_input` | `silk.io.standard_input` |
    | `silk.memory_byte_duplex` | `silk.io.memory_byte_duplex` |
    | `silk.os_writer` | `silk.io.writer_native` |
    | `silk.os_logger` | `silk.io.logger_native` |
    | `silk.os_standard_input` | `silk.io.standard_input_native` |
    | `silk.filesystem` | `silk.system.filesystem` |
    | `silk.child_process` | `silk.system.child_process` |
    | `silk.host_input` | `silk.system.host_input` |
    | `silk.monotonic_clock` | `silk.system.monotonic_clock` |
    | `silk.system_clock` | `silk.system.system_clock` |
    | `silk.random` | `silk.system.random` |
    | `silk.insecure_random` | `silk.system.insecure_random` |
    | `silk.insecure_seed` | `silk.system.insecure_seed` |
    | `silk.os_filesystem` | `silk.system.filesystem_native` |
    | `silk.os_child_process` | `silk.system.child_process_native` |
    | `silk.os_host_input` | `silk.system.host_input_native` |
    | `silk.os_monotonic_clock` | `silk.system.monotonic_clock_native` |
    | `silk.os_system_clock` | `silk.system.system_clock_native` |
    | `silk.os_random` | `silk.system.random_native` |
    | `silk.atomic` | `silk.concurrency.atomic` |
    | `silk.execution` | `silk.concurrency.execution` |
    | `silk.execution_storage` | `silk.concurrency.execution_storage` |
    | `silk.fiber` | `silk.concurrency.fiber` |
    | `silk.local_scheduler` | `silk.concurrency.local_scheduler` |
    | `silk.scheduler` | `silk.concurrency.scheduler` |
    | `silk.sync` | `silk.concurrency.sync` |
    | `silk.thread` | `silk.concurrency.thread` |
    | `silk.thread_pool` | `silk.concurrency.thread_pool` |
    | `silk.work_queue` | `silk.concurrency.work_queue` |
    | `silk.native_thread` | `silk.concurrency.thread_native` |
    | `silk.aes_gcm` | `silk.crypto.aes_gcm` |
    | `silk.arch.aes` | `silk.crypto.aes_round` |
    | `silk.blake2b` | `silk.crypto.blake2b` |
    | `silk.chacha20_poly1305` | `silk.crypto.chacha20_poly1305` |
    | `silk.ed25519` | `silk.crypto.ed25519` |
    | `silk.hkdf` | `silk.crypto.hkdf` |
    | `silk.hmac` | `silk.crypto.hmac` |
    | `silk.md5` | `silk.crypto.md5` |
    | `silk.p256` | `silk.crypto.p256` |
    | `silk.p384` | `silk.crypto.p384` |
    | `silk.rsa` | `silk.crypto.rsa` |
    | `silk.sha1` | `silk.crypto.sha1` |
    | `silk.sha2` | `silk.crypto.sha2` |
    | `silk.sha3` | `silk.crypto.sha3` |
    | `silk.x25519` | `silk.crypto.x25519` |
    | `silk.tls_client` | `silk.tls.client` |
    | `silk.tls_connection` | `silk.tls.connection` |
    | `silk.tls_hkdf` | `silk.tls.hkdf` |
    | `silk.tls_record` | `silk.tls.record` |
    | `silk.certificate` | `silk.tls.certificate` |
    | `silk.certificate_bundle` | `silk.tls.certificate_bundle` |
    | `silk.certificate_identities` | `silk.tls.certificate_identities` |
    | `silk.certificate_path` | `silk.tls.certificate_path` |
    | `silk.certificate_profile` | `silk.tls.certificate_profile` |
    | `silk.support.certificate_pem` | `silk.tls.certificate_pem` |
    | `silk.https_identity` | `silk.tls.https_identity` |
    | `silk.trust_anchor` | `silk.tls.trust_anchor` |
    | `silk.trust_snapshot` | `silk.tls.trust_snapshot` |
    | `silk.trust_source` | `silk.tls.trust_source` |
    | `silk.memory_trust_source` | `silk.tls.trust_source_memory` |
    | `silk.native_file_trust_source` | `silk.tls.trust_source_native` |
    | `silk.network_address` | `silk.net.address` |
    | `silk.resolver` | `silk.net.resolver` |
    | `silk.native_resolver` | `silk.net.resolver_native` |
    | `silk.wasi_resolver` | `silk.net.resolver_wasi` |
    | `silk.native_socket` | `silk.net.socket_native` |
    | `silk.wasi_socket` | `silk.net.socket_wasi` |
    | `silk.wasi_datagram` | `silk.net.datagram_wasi` |
    | `silk.http` | `silk.http.message` |
    | `silk.http2` | `silk.http.http2` |
    | `silk.http2_connection` | `silk.http.http2_connection` |
    | `silk.http2_frame` | `silk.http.http2_frame` |
    | `silk.http2_headers` | `silk.http.http2_headers` |
    | `silk.hpack` | `silk.http.hpack` |
    | `silk.support.hpack_tables` | `silk.http.hpack_tables` |
    | `silk.http_basic` | `silk.http.basic` |
    | `silk.http_body` | `silk.http.body` |
    | `silk.http_client` | `silk.http.client` |
    | `silk.http_client_native` | `silk.http.client_native` |
    | `silk.http_client_wasi` | `silk.http.client_wasi` |
    | `silk.http_connection_pool` | `silk.http.connection_pool` |
    | `silk.http_connection_pool_native` | `silk.http.connection_pool_native` |
    | `silk.http_content` | `silk.http.content` |
    | `silk.http_exchange` | `silk.http.exchange` |
    | `silk.http_exchange_native` | `silk.http.exchange_native` |
    | `silk.http_fetch` | `silk.http.fetch` |
    | `silk.http_fetch_native` | `silk.http.fetch_native` |
    | `silk.http_head` | `silk.http.head` |
    | `silk.http_headers` | `silk.http.headers` |
    | `silk.http_origin` | `silk.http.origin` |
    | `silk.http_proxy` | `silk.http.proxy` |
    | `silk.http_redirect` | `silk.http.redirect` |
    | `silk.http_request` | `silk.http.request` |
    | `silk.http_server` | `silk.http.server` |
    | `silk.http_server_native` | `silk.http.server_native` |
    | `silk.wasi_http_server` | `silk.http.server_wasi` |
    | `silk.http_target` | `silk.http.target` |
    | `silk.http_transport` | `silk.http.transport` |
    | `silk.websocket_server` | `silk.http.websocket_server` |
    | `silk.websocket_upgrade` | `silk.http.websocket_upgrade` |
    | `silk.json_array` | `silk.json.array` |
    | `silk.json_codec` | `silk.json.codec` |
    | `silk.json_object` | `silk.json.object` |
    | `silk.json_output` | `silk.json.output` |
    | `silk.json_reader` | `silk.json.reader` |
    | `silk.json_reflect` | `silk.json.reflect` |
    | `silk.json_scanner` | `silk.json.scanner` |
    | `silk.json_text` | `silk.json.text` |
    | `silk.json_value` | `silk.json.value` |
    | `silk.toml_codec` | `silk.toml.codec` |
    | `silk.toml_output` | `silk.toml.output` |
    | `silk.toml_scanner` | `silk.toml.scanner` |
    | `silk.toml_text` | `silk.toml.text` |
    | `silk.toml_value` | `silk.toml.value` |
    | `silk.uri` | `silk.uri.uri` |
    | `silk.uri_components` | `silk.uri.components` |
    | `silk.uri_percent` | `silk.uri.percent` |
    | `silk.uri_reference` | `silk.uri.reference` |
    | `silk.base64` | `silk.encoding.base64` |
    | `silk.uuid` | `silk.encoding.uuid` |
    | `silk.compression` | `silk.compress.limits` |
    | `silk.deflate` | `silk.compress.deflate` |
    | `silk.inflate` | `silk.compress.inflate` |
    | `silk.lzma` | `silk.compress.lzma` |
    | `silk.lzma2` | `silk.compress.lzma2` |
    | `silk.xz` | `silk.compress.xz` |
    | `silk.zstd` | `silk.compress.zstd` |
    | `silk.support.compression_checksum` | `silk.compress.checksum` |
    | `silk.support.lzma_decode` | `silk.compress.lzma_decode` |
    | `silk.support.lzma2_decode` | `silk.compress.lzma2_decode` |
    | `silk.support.zstd_block` | `silk.compress.zstd_block` |
    | `silk.support.zstd_checksum` | `silk.compress.zstd_checksum` |
    | `silk.simd` | `silk.simd.simd` |
    | `silk.cpu` | `silk.simd.cpu` |
    | `silk.arch.aarch64` | `silk.simd.aarch64` |
    | `silk.arch.wasm` | `silk.simd.wasm` |
    | `silk.arch.x86` | `silk.simd.x86` |
    | `silk.testing` | `silk.testing.testing` |
    | `silk.test_runner` | `silk.testing.runner` |
    | `silk.test_exchange` | `silk.testing.exchange` |
    | `silk.native_clock` | `silk.platform.native.clock` |
    | `silk.native_descriptor` | `silk.platform.native.descriptor` |
    | `silk.native_diagnostics` | `silk.platform.native.diagnostics` |
    | `silk.native_filesystem` | `silk.platform.native.filesystem` |
    | `silk.native_host_input` | `silk.platform.native.host_input` |
    | `silk.native_process` | `silk.platform.native.process` |
    | `silk.native_report` | `silk.platform.native.report` |
    | `silk.native_start` | `silk.platform.native.start` |
    | `silk.native_start_sync` | `silk.platform.native.start_sync` |
    | `silk.raw_linux` | `silk.platform.linux.syscall` |
    | `silk.raw_mapping` | `silk.platform.linux.mapping` |
    | `silk.raw_process_inputs` | `silk.platform.linux.process_inputs` |
    | `silk.raw_start` | `silk.platform.linux.start` |
    | `silk.wasi` | `silk.platform.wasi.preview1` |
    | `silk.wasi_preview2` | `silk.platform.wasi.preview2` |
    | `silk.wasi_clock` | `silk.platform.wasi.clock` |
    | `silk.wasi_component` | `silk.platform.wasi.component` |
    | `silk.wasi_descriptor` | `silk.platform.wasi.descriptor` |
    | `silk.wasi_filesystem` | `silk.platform.wasi.filesystem` |
    | `silk.wasi_host_input` | `silk.platform.wasi.host_input` |
    | `silk.wasi_http` | `silk.platform.wasi.http` |
    | `silk.wasi_stream` | `silk.platform.wasi.stream` |
    | `silk.wasi_start` | `silk.platform.wasi.start` |
    | `silk.wasm_start` | `silk.platform.wasm.start` |
- Common mistakes from other languages (`+=`, `++`, `for .. in`, `var`, `?:`) report one PAR0010 with the Silk spelling.
- Writing `?T` as a type reports PAR0007 suggesting `Option<T>`.
- SEM0083 no longer tells you to move an operator impl into the internal `intrinsic.operators` module.
- Clearer messages for unknown names, missing methods and pattern bindings; a leading byte order mark is accepted.
- A generic body can use an operator whose conformance holds under its own bounds, as `scale * point` with `impl<T: Multiply<T, T>> Multiply<Point<T>, Point<T>> for Scale<T>` under `T: Multiply<T, T>`, instead of reporting SEM0135.
- A repeated `@foreign` (or other repeated directive) on an `extern "C"` function is now SEM0250 in `silk check`, instead of an uncoded build error.
- Thread pool tasks are fibers: `Pool.fork` returns a `PoolFiber<A, E>` with `await`, `join` and `interrupt`, its outcome is the `Outcome` of `silk.concurrency.fiber`, `Pool.yieldNow` yields, and a wake of a parked fiber is no longer lost when two threads notify it in quick succession.
  - **Migration:** Replace `pool.spawn(task)` with `pool.fork(task)` and `TaskHandle<A>` with `PoolFiber<A, E>`, where `E` is the task's failure type (`never` for a closed task). A task no longer needs `Effect.result`: `join` and `Pool.block` raise its failure unchanged, and both can raise `Cancelled` (import it from `silk.concurrency.fiber`), so add it to the caller's errors.
- `silk format` handles a comment after the last statement of a closure argument.
- Accept a written type argument with an elided lifetime on a generic interface operation, as in `heads.pick<string>("a", "b")`.
- A cached `silk check` notices removed dependency names and modules a dependency stops exporting.
- Unknown `silk.toml`, `[package]`, dependency and profile keys are refused; unsupported profile options are refused instead of ignored.
  - **Migration:** Remove unknown keys from `silk.toml` and profiles. Profiles that set `sanitizers`, `unwind = "native"`, `safety = "unchecked"` or a non-default `entry` fail until those are supported.
- SEM0177 says when an argument has no visible named fields.
- Instance keys hash their identity as a stream and copy shared bytes in one pass.
- Implementing an interface with an omitted requirement row suggests `? never`.
- Rename `websocket_upgrade.Limits.default()` to `Limits.defaults()`.
  - **Migration:** Call `websocket_upgrade.Limits.defaults()` instead of `Limits.default()`.
- Add `silk update self [--dev]` to update the silk tool.
- A method call's written type argument may elide lifetimes, as in `r.pick<Engine<i32>>(e)`, as a function call's already could.
- The incremental cache image is about 60% smaller and loads faster.
- A `static` or `mut` parameter on a `static fn` reports SEM0251 instead of an uncoded "unsupported".
- Exact-equality type tables (applications, closed and written types) hash lifetimes too, so types that differ only in their borrow regions no longer share one hash chain. Compiling SilkJS's IR drops from about 6 minutes to 1m40s, and hr_shape's from 50s to 17s, with byte-identical output.
- Long operator chains compile; deeply nested calls and literals report PAR0005 instead of crashing.
- Two imports binding the same name report SEM0016 once.
- Text errors point at the fix. SEM0085 names the escape and the rule it breaks: a surrogate, a value above U+10FFFF, a byte string value above 0xFF, an unknown or malformed escape. `text.length`, `text[0]`, `text.startsWith(...)` and `text + "!"` point at `String.byteLength`, `String.utf8Bytes` and `String.nextScalar`, `String.startsWith(text, ...)`, and `String.append`.
- Calls that cannot pass static arguments yet report SEM0249 with the call to write.
- `silk change since` retries an empty GitHub release list.
- A pattern naming a private field of another module's variant now reports SEM0028 naming the variant and field, and suggests `..` or `pub`.
- `silk test` reuses the runner on the first rerun of an unchanged project.
- Format template errors say what to write; `w$` and `.p$` fields accept any integer.
- Static evaluation fixes for `Reflect.borrowField`, static operands in generic unions, and `compileError` reporting.
- Type mismatches that name a generic parameter note where the parameter comes from.
- An alias whose parameters are all lifetimes infers them at a call such as `IntRef.new(value)`, as the nominal `Wrapped<i32>.new(value)` does.
- Interning a query key hashes and compares its parts directly, so a lookup that finds the key no longer assembles a scoped key record.
- Clearer SEM0086, SEM0177, SEM0176, SEM0037 and SEM0210 messages.
- Add deferred same-thread foreign callbacks and require callback contracts for by-value C aggregate fields.
  - **Migration:** Name every callback field in by-value C arguments with a dotted path in `callbacks`, `deferredCallbacks`, or `threadCallbacks`. Mark calls that invoke retained same-thread callbacks with `Intrinsic.foreign(invokesDeferredCallbacks: true)`.
- A threaded wasm32 build requires Clang 19 or newer.
- `silk add` refuses dependency cycles; a broken workspace member no longer stops the others.
- Negative integer patterns start a new match arm; common match mistakes report one PAR0010 with the fix.
- Calling an interface operation through a bound accepts operands that share one of its lifetimes at different regions, as a free function call does.
- Rechecking a large file after an edit in one process, as the language server does, is much faster: matching its declarations to the previous revision no longer compares every declaration with every other (21.6 s to 2.3 s after a one-line edit of the compiler's largest file).
- A drop on a failure path runs on a copy of a whole aggregate local, so the local no longer escapes and LLVM can keep it in registers on the hot path: a struct moved into an inlined constructor is stored straight into its destination instead of through a stack temporary and `memcpy`.
- An edit that adds, removes or renames a call now rebuilds only the functions it touched and the ones they newly reach, instead of walking the whole program again.
- An import of a moved module suggests its new path.
- Shift-count traps report the caller's line; `.len` on slices, out-of-range tuple elements, tuple arity, and `<<`/`>>` get messages that name the type and the fix.
- Optimized builds work again with Clang 18 to 21.
- A selected generic body now infers a call's lifetimes from its written types, so a match on `View<'a>` after `Format.format` no longer reports SEM0042.
- `count as i32` reports PAR0002 naming the conversion functions to use.
- Workspace members that share an output directory keep separate incremental caches (`<output-dir>/cache/<package>`), so building one member no longer throws away the warm cache of another.
- The first rebuild after a cold build reuses the executable instead of loading the program again (1.3 s to 0.06 s for the compiler).
- Integer arithmetic that always traps is a compile error: SEM0248 for division by constant zero, SEM0247 for constant overflow.
  - **Migration:** Replace intentional traps such as `1 / 0` with `Intrinsic.trap("reason")`.
- Formatting a float below one with a precision no longer prints a stray `1`.
- Checks and builds store each syntax node in 36 bytes instead of 96, about 75 MB less on a large program.
- Rebuilds after adding or removing a call walk a module's escape check again from its last record, lowering only the changed bodies (compiler add-call edit 41 s to 7 s).
  The escape check enters each function once instead of once per region pattern.
- Fix a double free when dropping arena allocations on wasm32.
- An `Option` of a `Copy` type is now `Copy`, so a struct with an `Option` field can implement `Copy`.
- A rebuild after an edit that adds or removes a call walks the recorded escape and build walks again faster (rebuilding the compiler after such an edit: 5.0 s to 4.35 s).
- Static functions accept `input |> f(rest)` and receiver syntax for static methods.
- The semantic cache is two files, decoded on two threads, so an edit build waits less for it.
- A build that changes nothing writes nothing on every target and profile.
- Release settings are read only from `[release]`; silk tool help and pin fixes.
  - **Migration:** Rename `[changes]` to `[release]` in `silk.toml`.
- Starts native programs faster when the environment is large: the runtime now copies all environment variables into one buffer, measured with `strlen` and copied in bulk, instead of one zero-filled allocation and a checked byte loop per variable (an empty program with 190 variables went from 423K to 282K instructions).
- UTF-8 validation of ASCII text is about ten times faster with SIMD.
- Rebuild cached declaration identities without building a second copy of their module or encoding them again, so a small edit rebuilds about 7% faster.
- Reading a parsed source checks its slot directly instead of building and dropping a name selection. Front-end instructions drop 1.0% on an hr_shape build.
- The HIR lowering tests import `Option` from its new `silk.core.option` home again.
- Diagnostic and formatting fixes from the reference review; SEM0074 is replaced by SEM0234.
- Requiring `&Option<&mut S>` reports SEM0240.
- Dependencies and source files reached through symbolic links are read correctly.
- A function that takes a callable or an `Effect` and whose body is at most two statements without a loop, such as `Effect.result` or `catchAll`, is always inlined, so catching a failure with `Effect.result` in a hot loop runs as fast as `Intrinsic.catchFailure`.
- An unproved operator interface is named from the module users import, such as `silk.order.Order`, instead of `intrinsic.operators.Order`.
- SEM0236 lists `@deferredCallbacks` and `@invokesDeferredCallbacks`, SEM0241 names `@features(...)`, and type messages spell arrays as `[T; n]`.
- Reaching a type through a module name in value position reports SEM0238 with the import to write.
- Diagnostics name tuple, record and `static if` types and spell modules dotted (`silk.option.Option<i32>`).
- A `static if` or other static root inside a generic function can call functions that need its bounds.
- Reading a parsed source no longer re-checks the held revision when the answer observes the same bytes as its filled slot. Front-end instructions drop 1.6% on an hr_shape build.
- Types can nest 511 levels deep and deeply nested types check in linear time.
- `HashMap` and `HashSet` lookups are about 1.6 times faster near maximum load.
- Canonical encodings compare eight bytes at a time.
- Optimized builds with `--debug true` (and the `release-with-debug` profile) now carry DWARF line tables: a subprogram per function at its declaration's line, and a line and column on each statement, so profilers, debuggers and symbolizers map code, inlined helpers included, back to source. Builds without debug information are unchanged.
- Source demands remember the last module key they found, so the usual run of demands for one module skips the key table probe. Front-end instructions drop 1.0% on an hr_shape build.
- More errors name their subject and the fix (SEM0001, SEM0015, SEM0016, SEM0028, SEM0076, SEM0212, MOD0001).
- Release archives carry the compiler as `bin/silkc` and the silk tool as `bin/silk`.
- `install.sh` retries empty or failed GitHub release listings and explains rate limits.
- A failure piped into `Effect.catchAll` whose handler takes a wider union reaches the handler as that union instead of crashing.
- Importing a re-imported name says where it is declared; a missing `Display` points at `{value:?}`.
- Clearer SEM0067 for `catchAll` handlers and new LEX0013 for digits outside a literal's base.
- A source demand that finds a completed answer no longer pays for the reconciliation and publication paths: the pending-change check is inline and both slow paths run out of line.
- An unknown module member read as a value (`f64.NOPE`) reports SEM0014, and a module-qualified type with explicit arguments (`g.Box<i32>.make`) reports SEM0238, instead of an unsupported construct.
- Diagnostics name files relative to the project root.
- Imports match file paths case-sensitively on every host; MOD0001 suggests the differently cased file.
  - **Migration:** Rename imports whose letter case differs from the file path, such as `import util.math` for `util/Math.silk`.
- Debug `silk build` reuses the check cache and previous code generation (no-change rebuild of the compiler under 7 s).
- More manifest and profile fields are validated at their line; MOD0004 explains importing `Intrinsic`.
  - **Migration:** Remove unknown keys from `[workspace]`, compositions and bindings, and `deployment` from profiles that do not target `aarch64-apple-darwin`.
- `@nonParking` on a function is now enforced: a call to one that can park reports SEM0139 at the call.
- The compiler writes nested type and argument identity encodings in place and pre-sizes declaration encodings, cutting about 1.30f frontend work.
- Source queries return completed answers without a publication scope, and observation matching tries the observed mapping before the revision's hash lookup.
- `silk check` keeps a semantic cache in the build directory, so rechecking an unchanged project takes seconds.
- `&[]` and a borrow of an empty `const` array are valid as `&'static [T]`.
- Ownership and effect errors name what they are about and the fix.
- Trapping integer conversions and slices report why and where you called them; SEM0002 names the range.
- A handler or callable whose parameter is a wider union than its use passes is now accepted, as `Effect.catchAll(onAny)` with `onAny(error: Overdrawn | Frozen)` after `Overdrawn` is handled; the argument is widened at the call.
- `List.insert` and `List.remove` move the tail with one overlapping copy instead of one element at a time.
- A rebuild after an edit loads faster: files the last build read are parsed ahead on spare threads, and parsing sizes its buffers up front (rebuilding the compiler after adding a call: 4.5 s to 4.05 s).
- Clearer messages for private fields, providers (SEM0123, SEM0071) and cross-package imports.
- A Rust-style `as` cast and tuple elements written as fields (`Pair { 0: a }`) each report one error that names the Silk form.
- Declaration bounds that depend on each other, such as `T: Read<'a>, E: Extension<'a, T>`, are now accepted.
- Base64 encoding and decoding are about three times faster with SIMD.
- Checking and building programs that instantiate many generic functions is about 10% faster.
- The standard library writes directives such as `@inlineAlways` and `@nonParking` in place of `with Intrinsic.*` clauses, and its WebAssembly imports as `as "module#name"`.
- A generic call no longer refuses a later operand whose type differs from an earlier one only in lifetimes, as `refs(&left, &right)` or `Order.compare(&left, &right)` for two `string` parameters with separate lifetimes.
- Messages name types from other packages with their package name, and library errors are reported once at their own site.
- Diagnostic fixes: tests with requirement rows, malformed literals, format template errors, and `Display` for `bool` and `char`.
  - **Migration:** Move services out of test signatures and provide them inside the test body.
- Silk code can call `export "C"` functions directly; SEM0082 and SEM0187 say how to fix unsafe and callback errors.
- C imports and exports with non-C parameter types report SEM0187 at the declaration.
- Add `Atomic.wait`, `notifyOne` and `notifyAll`.
- SEM0037 and OWN0018 print their general messages again when the callable message does not apply.
- `silk init --workspace` now also creates a starter executable member, `app` (or the `--name` given), listed in `members`, so `silk run` at the root prints Hello, world! right away.
- Building a union value zeroes the padding after its tag, so loops that build union values keep fewer values in registers.
- Rebuilding after an edit spends less time replaying escape checks and writing the semantic cache; with the cache read on a thread, rebuilding the compiler after an edit takes 5.9 s instead of 6.6 s.
- `silk add` given a workspace lists its members instead.
- By-value method receivers infer lifetimes from the receiver, so `NativeHttp` builders accept runtime strings.
- Anonymous tuple types such as `(i32, i32)` report PAR0008 suggesting a named `tuple`.
- A sealed bound such as `Args<A: Copy, B: Copy>` in an implementation head no longer reports a false SEM0223 cycle.
- Debug builds leave a function's slots and parameter spills unlocated, so an LLDB breakpoint on a function shows its parameters; `silk debug` shows a `string` by its length, and an empty `SILK_LLDB` falls back to `lldb` on PATH.
- Read files into a buffer sized from the file length, and size decoded cache lists up front, so a small edit rebuilds about 10% faster.
- A cold check or build of a large package peaks about 130 MB lower: tokens and per-node HIR spans take half the space, and syntax trees drop their nodes once lowered.
- 16-byte union values copy as one 128-bit integer (1 to 6.5% fewer instructions on SilkJS benchmarks).
- `silk toolchain` and `NativeHttp.fromEnvironment` use HTTP proxies from the environment.
- Operators select an implementation with lifetime parameters, such as `&left < &right` on two `string<'a>`.
- Pass small Copy records (up to 32 bytes, at most four scalar leaves: pointers, integers, floats, bools, slices) to Silk functions as one LLVM parameter per scalar instead of by pointer, so hot-loop state no longer has to live on the stack.
- `silk use` and `silk update self` download from GitHub again; HTTP field limits are raised.
- Read the standard-library modules the language uses without an import (layout, option and the operator interfaces) from the `standard` object of `compositions.json`.
- A cached `silk build` no longer emits a function again when an edit only moves it, as inserting a line or a declaration above it does. A one-line edit near the top of a large file now emits the functions it changed instead of every function below it.
- Inline the fast path of `List.reserve` and `List.reserveExact` (one capacity check) and keep their growth out of line.
- The language server reports SEM0014 on the import line, as `silk check` does.
- More unknown manifest keys and component capabilities are refused at their line.
  - **Migration:** Remove unknown keys from binding origins and values, profile `entry` and `runtime` tables and `[native].platform-supply`, and capabilities other than `execution-storage` from compositions.
- Library exports are all checked and tested, plus array literal, `T: Copy`, match and union lifetime fixes.
  - **Migration:** A library whose `exports` modules contain errors, or whose `exports` names a missing module, is now rejected; fix the module or the manifest entry.
- Rechecking in one process after an edit, as the language server does, no longer walks the edited module's escapes again from scratch: the check replays its own last walk and lowers only the bodies whose MIR changed (a one-line body edit of the compiler rechecks in 2.5 s instead of 5.5 s).
- A shared borrow of a constant, such as `&TABLE` or `&TABLE[i]`, is valid as `&'static`.
- Ownership and drop errors name what they are about: a bare block (PAR0010), `Intrinsic.replace(&mut slot, v)` (SEM0036), a part moved out of a Drop type (OWN0002), a binding moved inside a loop (OWN0005), a second `drop` (OWN0001), `impl Copy` on a Drop type (SEM0083) and `c.drop()` (SEM0010).
- Native threads get an 8 MiB stack, fixing `silk lsp` crashes on macOS.
- A misspelled profile field is suggested by its full path (`did you mean profiles.fast.optimization?`) and a swap of two letters counts as one edit, as for the other manifest fields.
- `silk check` writes its cache in a background copy of the process, as `silk build` does, so a check after an edit returns about a second sooner.
- Cold builds are faster: build records no longer canonicalize instance keys that carry no providers a second time.
- Fix file metadata, directory listing, `realpath` and CPU feature detection on `x86_64-apple-darwin`.
- Add `Intrinsic.frameAddress`, `Intrinsic.stackAllocate` and `silk.stack`.
- Concurrent builds of one package no longer break each other.
- Fix automatic Windows installation when selecting a development release.
- Command-line polish: `silk help`, clearer usage errors with suggestions, and `silk init` hints.
  - **Migration:** Scripts that matched `silk: usage:` should match `usage: silk`.
- `silk doctest` and `silk format` work at a workspace root.
- `Intrinsic.RawBuffer<T>` is four words instead of six, so `List<T>` is 40 bytes instead of 56 on 64-bit targets.
- Programs that observe diagnostics compile faster: each module's line table is built once when it is parsed, instead of once for every function lowered from it.
- Add atomic memory operations and `silk.atomic`.
- Arithmetic over bare literals takes its type from the other operand on either side.
- A generic `fail` instantiated with a union member builds.
- Plain integer placeholders in `Format.format` write their digits at once, about three times cheaper.
- A match on `r.*` through a shared reference reads only the parts its arms bind instead of copying the whole value first.
- Incremental builds after a small edit are faster. The cache no longer copies a source file to digest it. A module's escape check no longer resolves the signature of every function that needs providers or is generic only to learn that no escape walk starts from it. A struct and the `impl` block of the same name no longer share one cached check, which made both check again after any edit to their file. A build after a body edit no longer lowers every caller on the path from the entry to the edited function to find its key.
- Passing a failing Effect where a call needs an infallible one reports SEM0052 suggesting `Effect.result(...)`.
- `x < y && y > (x + 1)` parses as two comparisons.
- Generic intrinsics such as `pointerReinterpret` no longer report SEM0012 inside selected static templates.
- A member of `impl<T: Read> Read for Wrapper<T>` may spell `Wrapper<T>` instead of `Self`, and an operation may return `Values<Self>` where `Values<T: Domain>`.
- Command-line fixes: Clang errors, `--clang` for packages, usage exit codes, `--help` per command, and `SILK_GAP` receipts only with `SILK_RECEIPTS=1`.
  - **Migration:** Scripts that read `SILK_GAP` lines from a build's stderr must set `SILK_RECEIPTS=1`.
- A cached check keeps its errors, so rechecking unchanged sources reports them without checking again.
- Keep an explicit linker's written path, so `ld64.lld` keeps lld's Mach-O flavor.
- `SEM0099` for an explicit type argument with an omitted lifetime, such as `Option<&Value>.None`, now points at the construction instead of the standard library declaration.
- A composition that selects a standard-library runtime for a target it does not support is refused when the package loads, naming the runtime to use.
- Check reports syntax errors alongside a refused package parameter schema; SEM0236 names both foreign linkages.
- UTF-8 validation of non-ASCII text is about three times faster with SIMD.
- A build of a program that observes diagnostics lowers its functions once instead of twice, which cuts a large cold build by about 2 s and 200 MB.
- `let _ = e` reports SEM0087 pointing at `drop e`.
- The language server now shows the type of every inferred binding on hover and in inlay hints, including Effect values, tuples, records and closures, instead of `_`.
- A generic operator conformance such as `impl<T: Add<T, T>> Add<Value<T>, Value<T>> for Value<T>` now works at its `+` sites.
- Workspace fixes for `silk run`, `format`, `doc`, `add`, `remove`, dependency order and `test --filter`.
- `silk format` writes raw pointer types as `[*]const u8` and keeps `with Intrinsic.foreign(...)` together.
- Read the 128-bit powers of ten for float parsing and shortest float formatting from a read-only table instead of decoding hex text on every lookup.
- Calling a generic function whose bound a type parameter does not declare now reports SEM0121 naming the missing bound instead of an unsupported-construct gap.
- Optimized code uses smaller stack frames and inlines more drop glue and callable wrappers.
- A float literal that rounds to infinity at its type, such as `1.0e100` as `f32`, is now an error (`SEM0095`) instead of silently becoming infinity.
- On Linux, executables link with the `ld.lld` installed beside Clang when there is one, and a build no longer waits to prune old cache packs, read its own executable twice or free its plan before it exits (compiler edit build 3.35 s to 3.05 s).
- `Format.f64Value` and `Format.f32Value` parse short decimals such as `12.5` about twice as fast.
- `silk lsp` answers completion and accepts incremental text changes.
- Allocation drop glue is no longer kept out of line: an adopted allocation's reclaim call goes through one shared guarded helper, so a value holding a `List` or `RawBuffer` can stay in registers and be built in place.
- A rebuild after an edit no longer re-reads the declarations of the edited file whose tokens did not change (rebuilding the compiler after an edit: 6.1 s to 5.5 s).
- Interning an already known declaration skips the source read when no unit records it.
- Hovering a directive such as `@inlineAlways` in the language server shows what it does, and the generated reference keeps a declaration's directives in its signature.
- `if` values parse as call arguments and array elements, with clearer SEM0049 and SEM0087 messages.
- A struct, union or array repeat literal is built in its destination, and a result passed by address is built in the caller's slot, so returning a large literal no longer copies it.
- Code emission remembers the layout each recent type handle matched.
- Generic code fixes for static arguments, `let static`, raw-pointer Drop recursion and piped comparisons.
- Unknown keys in `[build].composition` entries are refused at their line.
  - **Migration:** Remove unknown keys from `[unstable].composition` entries.
- A WebAssembly trace names a suspending function's `$step` and `$enter` functions after the function, such as `main.pick$step`, instead of by a content hash.
- The compiler finds its standard library through symbolic links.
- A provider whose type is a type parameter with a service bound, as `&mut W` with `W: Writer`, can now be passed to `Effect.provideMut`; without the bound it is SEM0123 instead of unsupported.
- Unknown composition binding operations and misplaced `translator` origins are refused at their line.
  - **Migration:** Remove unknown `operation` values from composition component bindings, and `translator` from bindings with `provenance = "literal"`.
- A match arm qualified by a name the module never imports, such as `Result.Success` without `import silk.result { Result }`, now reports SEM0009 with the missing import instead of SEM0042.
- The language server rechecks workspace members against the open text of their dependencies.
- A conditional conformance can bound the parts of an `Effect` type in its provider.
- `silk check`, `build` and `test` check every loaded module of each dependency and report errors at the dependency's own file.
  - **Migration:** A dependency with errors in functions your package never calls now fails your build; fix or update the dependency.
- JSON scanning of string-heavy input is about twice as fast with 128-bit vectors.
- The backend now writes LLVM bitcode directly instead of printing LLVM text for Clang to parse; `--emit llvm-ir` still prints the IR.
- `silk lsp` answers requests between declarations while it rechecks a large module.
- Missing-Clang and framework link input errors name `--clang` and the manifest entry.
- A C-style `*n` now reports one PAR0010 saying Silk writes a dereference after the value, `n.*`, instead of a PAR0002/PAR0001/SEM0035 cascade.
- Stricter declaration checks for Drop and Copy impls, C symbol names, C symbol conflicts and C-layout structs.
  - **Migration:** Fix declarations now rejected at `silk check`: `impl Drop` must declare exactly `fn drop(self: &mut Self) -> ()`, `impl Copy` declares no members, link names must be ASCII identifiers not reserved by the compiler, and C-layout structs take no type parameters and only C-compatible fields.
- Borrowing an indexed source no longer looks up a name bucket it never reads.
- OWN0016 and SEM0139 name the Effect or function that causes them.
- The compiler writes application and instance-key identity fields in place, cutting about 0.65% of frontend work.
- A struct with an elided lifetime can now be kept in a `List` or `HashMap` bound to a local and returned, as in `let names = List<Name>.make()` then `return move names`. The local's element lifetime is inferred to equal the result's instead of failing with SEM0129. When a returned or assigned value differs from its expected type only in lifetimes, SEM0129 and the other mismatch errors now name both types and note that only their lifetimes differ.
- `silk doctest` with no input checks the current package's examples directly.
- Dependency lists are deduplicated through an index sized for them up front.
- SEM0135 and SEM0087 messages name the operator, operand types and statement context.
- An incremental build after a function body edit is faster: the escape check and the build find the edited function in the cache by its own record, so they no longer lower every caller on the path from the entry to it again, including callers that pass it references or providers (a one-line body edit of the compiler went from 10.8 s to 5.4 s).
- The compiler allocates list storage once when it copies a list of known length, and fills new intern-index buckets in one step, cutting about 1% of front-end instructions.
- Manifest errors name their line and say what is wrong.

  - A `silk.toml` that is not TOML is refused at the parser's line, with its reason, such as `` `name` is written twice `` or "a value must be a quoted string, a number, a boolean, an array or an inline table". Before, every syntax error said only "the manifest is not valid TOML".
  - A refused `package.name`, `package.version`, `package.silk-version` or `package.kind` is reported at its line and echoes the value written: `package.version "1.0" is not a semantic version; write MAJOR.MINOR.PATCH, as 1.0.0`. A missing `name` says it is missing. `package.main`, `build.stage`, `build.targets` and `build.output-dir` refusals give their line too.
  - A refused dependency is a manifest error like the others: it exits with status 2 and gives the `silk.toml` line at fault. That is the dependency's entry or field in the depending manifest, or the line of the dependency's own manifest when that one is at fault, as for a dependency whose `silk.toml` is not TOML. `[package].exports` refusals give their line too.
- Silk now refuses Clang older than 22 with a clear message instead of letting it crash on the bitcode; install.sh checks for Clang 22 too.
- `silk check` reports a `compileError` that the target selects in a standard library function the package calls, as `silk build` does.
- Optimized builds no longer copy a large `Copy` parameter, or a field of one, before passing it to a callee that only reads it.
- Debug build caches are much smaller and no-change or one-line-edit rebuilds are about twice as fast.
- A build that records no reads keeps each declaration's template binders instead of reading them from syntax again.
- `--timings` now bills each module's check for the work it caused itself: lowering a changed function counts as that function's module, and the runtime walk counts as the runtime module, rather than as whichever module's check happened to need it first.
- Test and effect errors (SEM0062, SEM0066, SEM0218) say what to write.
- Checks and builds use about 110 MB less memory on a large program: dependency edges keep their reverse links only once an editor session invalidates, and per-call borrow facts no longer reserve spare capacity.
- Lifetime planning leaves out scalar slots, which get no markers, and skips the analysis for a function with no other candidate.
- Foreign and match fixes: `export "C" fn` in any module is emitted, and wrong Drop receivers and redundant type binder arms are reported.
- `silk.http_server` serves HTTP/1.0 clients and answers unreadable requests with a proper 4xx/5xx status.
- `@features(...)` with a non-literal entry reports only the parse error, without a following SEM0242.
- Released compilers are built with profile-guided optimization: `silk check` is about 17% faster.
- The LLVM backend remembers each local's storage alignment, so places rooted at a local skip a type-layout lookup.
- silk tool fixes: typo suggestions for `use`/`set`/`update`, `silk use uninstall`, interrupted install cleanup, and clearer pin mismatch notes.
- `silk format` indents the arguments of a call that wraps after a `|>` or operator continuation one level past that line, with the closing parenthesis under it.
- A repeated `?` in a type, or `?` in a type argument, reports PAR0007 once.
- Add `PoolFiber.awaitEither` and `PoolFiber.race` for thread pool fibers.
- Checks and builds keep their query key tables and hash indexes smaller, about 35 MB less on a large program.
- `silk lsp` starts warm from the `silk check` cache (first diagnostics on the compiler in about 8 s instead of 55 s).
- `silk check` exits without freeing its analysis one piece at a time, which ends a large check about 1.5 s sooner.
- `silk foo.silk` with no such file reports the missing source file and exits 2.
- On wasm32 and other non-hosted runtimes, SEM0225 names the entry shapes the runtime accepts.
- Starts native programs faster: the runtime now copies each command-line argument and environment variable with one allocation and a plain byte loop, instead of one `Bytes.append` per byte. `List.reserveExact` and other first growth of an empty list now adopt the new storage directly instead of migrating an empty buffer.
- A repeat literal of a constant whose bytes are all the same, such as `[false; N]`, `[0; N]` or `[255u8; N]`, is filled with one memset instead of a store loop.
- A bounded inherent block can call its bounds' operations, as `Zero.zero()` or `value.twice()` inside `impl<T: Zero + Twice> Pair<T>`, instead of reporting "unsupported" or SEM0200.
- A `[native].link` entry the target cannot link, such as a framework on Linux, now fails that package's link step and prints its `Failed` line.
- `Compilation.optimization()` returns the new `Optimization.Size` for `optimization = "size"` builds instead of failing with SEM0177.
- Language fixes: `while true` without `break` is `never`, function values coerce to annotated `fn` types, more pattern forms, and order-independent lifetime inference.
  - **Migration:** A requirement row naming one service with both shared and exclusive access, such as `? &Clock | &mut Clock`, is now SEM0233; write the service once with the access you need.
- `a == b` on `Equal` values reports SEM0135 with a hint to compare borrows, as in `&a == &b`.
- Indexing a constant array, as in `TABLE[i]`, reads the element from the constant's read-only storage instead of building the whole array on the stack at every read.
- A check after a check reuses the runtime's escape walks again, so a check edit no longer re-types the bodies the runtime reaches.
- `silk lsp` answers find references, rename and workspace symbols.
- `Reflect.fields<T>()` lists only `pub` fields; SEM0176 and SEM0223 messages say what went wrong.
  - **Migration:** To reflect the fields the calling module can see, including private ones, call `Intrinsic.reflectFields<T>()` instead of `Reflect.fields<T>()`.
- SEM0051 names the generic and both counts: "`pick` takes 1 type argument, but 2 were written".
- `silk lsp` memory no longer grows with every edit in a long session.
- `silk format` keeps a comment after a bare `return`.
- The bitcode writer remembers its integer and pointer types instead of interning them again on every use.
- The `sew` front door is now `silk`, and the compiler in a release is `bin/silkc`.
  - **Migration:** Replace `sew` commands with `silk use`, `silk set`, `silk change` and `silk update self`. Rerun install.sh to remove `$SILK_HOME/bin/sew`.
- A call with too few arguments where a value is required reports SEM0007 at the call.
- Long postfix chains no longer crash `silk check` or the language server; over-long ones report PAR0005.
- A macOS build with no `deployment` uses the SDK's minimum when it is above 11.0.0, so Xcode 27 SDKs no longer fail with DeploymentMismatch.
- Checks and builds release each source file's tokens once the file is indexed, about 25 MB less on a large program.
- Link one copy of the foreign-call personality per image, so macOS builds with many modules no longer exceed Apple ld's compact-unwind personality limit.
- Passing a callable with the wrong mode (once/mut) reports SEM0076 naming both modes.
- Builds and checks read and decode the semantic cache on a thread of their own while the sources load.
- A build whose sources, manifests and toolchain settings are all unchanged reuses its executable without loading a module (the compiler's own no-op build drops from 1.4 s to 0.1 s). The record of what it read is `<artifact>.inputs`, beside the executable.
- Optimized builds no longer write stack lifetime markers for scalar locals, which SROA promotes to registers anyway. This cuts the LLVM IR that clang reads by about a sixth on large programs and speeds up the clang phase of a SilkJS release build by about 4-9%.
- Optimized builds copy values between places that cannot overlap with `memcpy`, so LLVM builds a struct literal like `Outer { inner: Inner.new() }` directly in its binding instead of in temporaries.
- `silk format` puts each step of a pipeline with two or more `|>` on its own line; a single `|>` stays inline when it fits.
- A cached `silk check` no longer reports bogus errors after a file it read was edited in place.
- `silk format` ends every list it breaks across lines with a trailing comma, and keeps match arm bodies after a comment indented.

