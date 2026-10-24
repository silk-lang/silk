# WASI targets

Silk supports two WASI command targets:

| Target | Final executable | Host ABI |
| --- | --- | --- |
| `wasm32-wasip1` | WebAssembly core module with `_start` | `wasi_snapshot_preview1` |
| `wasm32-wasip2` | WebAssembly component exporting `wasi:cli/run` | WASI Preview 2 command interfaces |

Both targets use 32-bit pointers, the WebAssembly C calling convention, little-endian memory,
static linking, and `libc = "none"`. They use Silk's linear-memory allocator and byte routines.
No WASI SDK or libc sysroot is required. The existing `wasm32-unknown-unknown` target remains
freestanding.

## Build and run

Use Clang 22 or newer, with its WebAssembly linker. Preview 2 additionally needs
[wasm-tools](https://github.com/bytecodealliance/wasm-tools) and the
[WASI command adapter](https://github.com/bytecodealliance/wasmtime/releases).
The adapter must be `wasi_snapshot_preview1.command.wasm`, not the reactor adapter.

```sh
export SILK_CLANG=/path/to/clang
export SILK_WASM_TOOLS=/path/to/wasm-tools
export SILK_WASI_ADAPTER=/path/to/wasi_snapshot_preview1.command.wasm
export SILK_WASMTIME=/path/to/wasmtime

silk build --target wasm32-wasip1
silk build --target wasm32-wasip2
silk run --target wasm32-wasip2 -- argument
silk test --target wasm32-wasip1
```

`wasm-tools` and `wasmtime` are found on `PATH` when their overrides are absent. The adapter
path is explicit. On Linux x86-64, `bash scripts/setup-wasi-tools.sh` installs checksum-verified
versions into `.scratch/wasi-tools`; use those paths for the three variables above.

A Preview 2 build first links a core module, then runs `wasm-tools component new` with the
command adapter. It publishes the component only after conversion succeeds. A failed conversion
preserves the previous output. LLVM IR, bitcode, assembly, objects, and static archives remain
core-code artifacts and do not invoke component tooling.

`silk run` inherits the terminal and maps the current host directory to guest `/`. It forwards
application arguments. WASI environment variables are explicit host grants; the compiler does
not copy its environment into the guest. For other directory mappings or environment variables,
run the output directly:

```sh
wasmtime run --dir ./data::/data --env MODE=production program.wasm argument
```

`silk test` also maps its build directory to its absolute guest path for plans, receipts, and
progress records. It uses Wasmtime for both editions. On WASI, `--timeout` limits a runner
instance; a trap or timeout resumes after the test recorded in its progress file.

## Application entry

The bundled `silk.wasi_start` runtime accepts `main` returning `()` or `i32`, and Effects with
either result. An Effect may require `&mut HostInput`; the runtime supplies an owned snapshot
of command arguments and environment. All other services use explicit providers.

Cleanup finishes before the WASI exit call. An unhandled failure drops its payload and exits
with status 1. An allocation failure or a parked application execution also exits with status 1.
The complete application must satisfy `Intrinsic.NonParking`.

Preview 1 uses the low eight bits of the application's status. Hosts can restrict accepted exit codes;
Wasmtime accepts application statuses below 126. Preview 2's `wasi:cli/run`
represents success or failure: zero succeeds and every nonzero status becomes failure.

## Standard library

| Service or API | WASI provider |
| --- | --- |
| `HostInput` | `WasiHostInput.capture`, also supplied by the entry runtime |
| `Writer`, `Logger` | `StdoutWriter`, `StderrWriter`, `StdoutLogger`, `StderrLogger` |
| `StandardInput` | `OsStandardInput` |
| `FileSystem` | `OsFileSystem` |
| `SystemClock`, `MonotonicClock` | `OsSystemClock`, `OsMonotonicClock` |
| `Random` | `OsRandom` |
| Allocation, containers, codecs, crypto, local executions | The target-neutral providers |

Filesystem roots use guest paths. `OsFileSystem.make("/data")` can access only a host-granted
preopen containing that path. A preopen named `.` represents guest `/`. The longest matching
preopen wins. Paths are opened component by component without following symbolic links.
Directory iteration, exclusive creation, atomic replacement/publication, temporary directories,
and synchronization use descriptor-relative WASI operations. Rights and synchronization support
remain host decisions; errors retain WASI errno values.

`HostInput.workingDirectory` returns guest `/`; WASI has no process-wide `chdir`. WASI does not
standardize terminal detection, so automatic logger colors are disabled. The command targets
are single-threaded. `threading = "multi"` is rejected; the existing freestanding WebAssembly
threads extension is separate. WASI provides no child-process spawning or POSIX signals.

`silk.wasi` exposes all Preview 1 system-call bindings and the canonical memory records for
custom providers, including polling, descriptor rights, offsets, metadata, and inherited sockets.
The Preview 2 adapter translates the command interfaces it implements; it does not add Preview 2
socket creation, DNS, arbitrary WIT imports/exports, or an HTTP world to Silk. Those interfaces
are not supplied by the OS providers. A host may reject unavailable operations with WASI errno.

`Target.arch()` returns `Arch.Wasm32`, `Target.operatingSystem()` returns `OperatingSystem.Wasi`,
and `Target.abi()` returns `Abi.Wasm` for both editions.

## Verification

```sh
node compiler/scripts/test-wasi.ts /path/to/silkc /path/to/clang .scratch/wasi-tools
```

The acceptance test validates and executes both artifact formats. It covers host inputs, streams,
filesystem capabilities and cleanup, clocks, randomness, command status, `run`, `test`, intermediate
artifacts, and preservation of an existing output when component construction fails.
