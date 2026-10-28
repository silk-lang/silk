# WASI targets

Silk supports WASI Preview 1 commands and Preview 2 commands and components:

| Target | Final executable | Host ABI |
| --- | --- | --- |
| `wasm32-wasip1` | WebAssembly core module with `_start` | `wasi_snapshot_preview1` |
| `wasm32-wasip2` | WebAssembly component, with `wasi:cli/run` for commands | WASI Preview 2 interfaces or a selected WIT world |

Both targets use 32-bit pointers, the WebAssembly C calling convention, little-endian memory,
static linking, and `libc = "none"`. They use Silk's linear-memory allocator and byte routines.
No WASI SDK or libc sysroot is required. The existing `wasm32-unknown-unknown` target remains
freestanding.

## Build and run

Use Clang 22 or newer, with its WebAssembly linker. Preview 2 additionally needs
[wasm-tools](https://github.com/bytecodealliance/wasm-tools) and the
[WASI command adapter](https://github.com/bytecodealliance/wasmtime/releases).
Commands use `wasi_snapshot_preview1.command.wasm`. A component without command startup uses
`SILK_WASI_REACTOR_ADAPTER` only when it imports Preview 1 functions. Pure Preview 2 components
need no adapter.

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
versions into `.scratch/wasi-tools`, including both command and reactor adapters.

A Preview 2 build links a core module, embeds its WIT world with `wasm-tools component embed`,
then runs `wasm-tools component new`, supplying the selected adapter when needed. It publishes the component only after conversion succeeds. A failed conversion
preserves the previous output. The core module exports `cabi_realloc` so the adapter and application
share Silk's allocator. LLVM IR, bitcode, assembly, objects, and static archives remain
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
`silk doctest` executes examples from a package with a WASI default profile through Wasmtime,
mapping the package directory to guest `/` even when invoked from a subdirectory.

## Application entry

The bundled `silk.platform.wasi.start` runtime accepts `main` returning `()` or `i32`, and Effects with
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
| TCP streams and listeners (Preview 2) | `silk.net.socket_wasi`, implementing `ByteDuplex` |
| UDP datagrams (Preview 2) | `silk.net.datagram_wasi.UdpSocket` |
| `Resolver` (Preview 2) | `silk.net.resolver_wasi.WasiResolver` |
| `Http` (Preview 2) | `silk.http.client_wasi.WasiHttp` |
| Incoming HTTP (Preview 2) | `silk.http.server_wasi.Exchange` |

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

`silk.platform.wasi.preview1` exposes all Preview 1 system-call bindings and the canonical memory records for
custom providers, including polling, descriptor rights, offsets, metadata, and inherited sockets.
`silk.platform.wasi.preview2` exposes all 200 canonical imports of the bundled WASI 0.2.12 command and
HTTP interfaces: clocks, streams, polling, randomness, filesystem, sockets, DNS, and HTTP.
These unsafe bindings require canonical ABI layout, ownership, and resource lifetimes.
The higher-level providers own those resources and release them on success, failure, or timeout.
Clocks call Preview 2 directly. The command adapter supplies Preview 1 compatibility for the
remaining shared OS providers. A host may deny operations according to its capabilities.

`Target.arch()` returns `Arch.Wasm32`, `Target.operatingSystem()` returns `OperatingSystem.Wasi`,
and `Target.abi()` returns `Abi.Wasm` for both editions. `Intrinsic.profileText("target")`
returns the canonical target name, allowing a provider to distinguish the two previews.

## Preview 2 networking and HTTP

`Network.make()` acquires the host's default network capability. `Network.listen` and
`Network.connect` create TCP sockets; `Listener.accept` returns a connection implementing
`ByteDuplex`, including partial transfers, flushing, half-close, and close. Socket addresses
support IPv4 and IPv6, including IPv6 flow and scope values. `UdpSocket.bind` supports connected
and unconnected datagram streams; `send` preserves packet boundaries, and `receive` returns an
owned packet and source address. Empty datagrams remain distinct from stream EOF.

Provide `WasiResolver.make()` for `Resolver` to resolve domains with the host's name lookup
capability. Family filtering happens before the result limit; duplicate addresses are removed.
Network and stream deadlines use the supplied monotonic clock. DNS uses `OsMonotonicClock`.
An already expired deadline fails before starting the operation.

`WasiHttp.make()` implements the portable `Http` service. It delegates HTTP transport and TLS
verification to the host, honors response body limits and total deadlines, follows redirects,
rejects HTTPS downgrades, and strips credentials when the origin changes. Default limits are
30 seconds, 16 MiB of response body, and ten redirects. The client writes through host
backpressure and returns an owned response. Response trailers are consumed and released.

Grant the required host capabilities explicitly:

```sh
wasmtime run -S inherit-network=y -S allow-ip-name-lookup=y network.wasm
wasmtime run -S http=y http-client.wasm
```

An HTTP server exports `wasi:http/incoming-handler@0.2.12#handle` using the WIT world described
below. Its two `u32` arguments are owned incoming-request and response-outparam handles.
Transfer them exactly once to `unsafe Exchange.take(request, response)`. `Exchange.metadata`
returns owned method, URL parts, and ordered fields; `readBody` enforces a caller-supplied limit;
`respond` consumes the exchange and writes a status, fields, and body. Provide `Allocator` and
`MonotonicClock` around effectful calls. The host owns listening and HTTP framing. The acceptance
fixture in `compiler/fixtures/wasi-http-server/main.silk` is a complete echo handler.

The bundled `http` world includes `wasi:http/proxy@0.2.12`. Copy `stdlib/wit` into the server
package as `wit`, select `world = "http"` in `[component]`, and select `runtime = {kind = "none"}`
in the build profile. Build it, then run `wasmtime serve --addr 127.0.0.1:8080 <component>`.
Pure HTTP components do not need command startup, a Preview 1 adapter, or CLI filesystem grants.

## Custom WIT worlds, imports, and exports

A package can describe any synchronous component interface with its own WIT package:

```toml
[package]
name = "calculator"
source = "."

[build]
profile = "component"

[profiles.component]
target = "wasm32-wasip2"
runtime = {kind = "none"}

[component]
wit = "wit"
world = "calculator"
```

`component.wit` is a file or directory inside the package; its dependency packages belong in
its WIT `deps` directory. `component.world` selects a world in that package. Both fields are
required. Test runners select the bundled command world so a library's exported application
interface does not replace the test entry. WIT file contents and directory listings participate
in test-runner reuse validation.

For example, a `wit/world.wit` containing:

```wit
package example:calculator;
world calculator {
  export increment: func(value: u32) -> u32;
}
```

is implemented by:

```silk
export "C" fn increment(value: u32) -> u32 { return value + 1 }
```

An imported component function uses an ordinary foreign declaration with explicit module and
member names. The local link symbol must distinguish imports from different modules:

```silk
unsafe extern "C" fn read(handle: u32) -> u32 as "counter_read"
  with Intrinsic.foreign(module: "example:counter/api@1.0.0", name: "[method]counter.read")
```

`module` and `name` are nonempty string literals without NUL, accepted only on WebAssembly
function imports. `name` requires `module`; when omitted, it defaults to the link symbol.
These properties select linkage and make no memory or lifetime promise. Existing foreign
contract fields apply separately. Conflicting module/member claims for one link symbol are
rejected. WebAssembly export symbol strings may contain WIT punctuation, for example:

```silk
export "C" fn read(value: u32) -> u32 as "example:counter/api@1.0.0#read" { return value }
```

Silk's foreign declarations describe core ABI lanes. They do not automatically lift or lower WIT
values. Implement wrappers using the canonical ABI: flatten scalar parameters, use canonical
memory records for indirect results, and obey string/list allocation and resource transfer rules.
`cabi_realloc` shares Silk's allocator with the component machinery. Export `cabi_post_<export>`
to release returned buffers after the host lifts them. Exported resources use the canonical
`[resource-new]`, `[resource-rep]`, and destructor functions; borrowed and owned handles are
not interchangeable. Never keep a borrowed pointer or resource beyond its permitted call.

`compiler/fixtures/wasi-component` demonstrates module-qualified imports, interface exports,
UTF-8 strings, lists, records, owned and borrowed resources, and post-return cleanup. Its
consumer and provider are separately compiled components that compose through their WIT types.
The bundled WASI bindings use this same foreign-call machinery.

## Verification

```sh
node compiler/scripts/test-wasi.ts /path/to/silkc /path/to/clang .scratch/wasi-tools
```

The acceptance test validates and executes both artifact formats. It covers host inputs, streams,
filesystem capabilities and cleanup, clocks, randomness, command status, `run`, `test`, `doctest`, intermediate
artifacts, sockets, DNS, HTTP redirects and limits, repeated HTTP resource cleanup, HTTP serving,
custom WIT composition, and preservation of an existing output when component construction fails.
