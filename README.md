<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/silk-wordmark-dark.svg">
    <img src=".github/assets/silk-wordmark-light.svg" alt="Silk" width="240">
  </picture>
</p>

<p align="center">
  <strong>A systems language where every failure, requirement and resource is part of the type.</strong>
</p>

<p align="center">
  <a href="https://github.com/silk-lang/silk/actions/workflows/selfhost.yml"><img src="https://github.com/silk-lang/silk/actions/workflows/selfhost.yml/badge.svg?branch=main" alt="Selfhost"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-c6a678" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/status-pre--alpha-8b5cf6" alt="Pre-alpha">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#a-short-tour">Tour</a> ·
  <a href="reference/index.md">Language reference</a> ·
  <a href="reference/stdlib/index.md">Standard library</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

Silk compiles to native code and WebAssembly through LLVM, with no garbage collector, no hidden
allocation and no ambient I/O. A function's signature tells you everything it can do: what it
returns, how it can fail, and which services it needs. The compiler checks all of it, and cleanup
runs at a point you can see in the source.

```silk
effect fn remaining(deadline: u64) -> u64 ! Expired | LogError ? &Clock | &mut Logger {
  let now = run Clock.now()
  if now > deadline { fail Expired {} }
  run Effect.log("{left} ticks left\n", &.{ left: deadline - now })
  return deadline - now
}
```

Read it as "returns a `u64`, may fail with `Expired` or `LogError`, and needs a `Clock` to read and
a `Logger` to write to". The function doesn't know which clock or logger it gets. The caller
decides, and a test can hand it fakes.

The compiler is written in Silk and builds itself.

## Why Silk

- **Typed failures.** `! E` lists every error a computation can raise. `fail` raises one,
  `Effect.catch` handles it, and the handled error leaves the type.
- **Requirements instead of globals.** Clocks, loggers, allocators, file systems, sockets and
  random sources are `service`s that a computation asks for with `? &Service`. Providers are
  ordinary values, so a test or a browser host swaps one in without mocking anything global.
- **Ownership without a runtime.** Values are affine: `move` transfers them, `&` and `&mut` borrow
  them, and `Drop` runs exactly once at a deterministic point. Using a value after it moved is a
  compile error.
- **Explicit allocation.** Allocation is never hidden. Anything that allocates asks for
  `? &mut Allocator`, and you choose which allocator it gets.
- **Compile-time evaluation.** `static` parameters, `let static` and `static if` run at compile time
  against the selected target, and only the chosen branch reaches the program.
- **Little compiler magic.** Compiler operations that source can call live in the sealed
  `Intrinsic` namespace. `Effect`, `Result`, `List`, logging and the file system are ordinary Silk
  in [`stdlib/`](stdlib), and you can read them like your own code.

## Install

### macOS and Linux

On macOS (Apple Silicon) or Linux (x86-64 or ARM64):

```sh
curl -fsSL https://raw.githubusercontent.com/silk-lang/silk/main/install.sh | sh
```

The script installs the latest stable release in `~/.silk/toolchains/<version>` (set `SILK_HOME`
to change `~/.silk`) and makes it your default. It also installs [the silk tool](tool), the command
you type for Silk, as `~/.silk/bin/silk`; each release's compiler is `silkc`. It verifies the
compiler's SHA-256 and reported version, and the release signature when `minisign` is installed.
Earlier versions stay installed beside it.
Set `SILK_RELEASE=v0.2.0-beta.1` to select a published prerelease explicitly. Building programs
needs Clang 22 or newer on `PATH`, or `SILK_CLANG` pointing at it.

With [Homebrew](https://brew.sh), which also installs Homebrew's LLVM and points `silk` at its Clang:

```sh
brew install silk-lang/tap/silk
```

With [mise](https://mise.jdx.dev), from the release archives:

```sh
mise use -g 'github:silk-lang/silk[version_prefix=v]'
```

Homebrew follows the same channel as the script. mise picks stable releases only; until the first
one exists, use `github:silk-lang/silk[version_prefix=v,prerelease=true]` to get dev releases.

### Windows

On Windows x86-64, run this in PowerShell:

```powershell
Invoke-RestMethod https://raw.githubusercontent.com/silk-lang/silk/main/install.ps1 | Invoke-Expression
```

The installer needs no administrator privileges. It installs `silk.exe` in
`$env:USERPROFILE\.silk\bin` and keeps each compiler and its standard library in
`$env:USERPROFILE\.silk\toolchains\<version>`. Set `$env:SILK_HOME` before installing to use
another directory. It selects the latest stable release, or the latest development release
until a stable release exists. To select a specific published release, set `$env:SILK_RELEASE`
to its full tag before running the command.

Add `%USERPROFILE%\.silk\bin` (or your custom `SILK_HOME`'s `bin` directory) to your **user Path**
in Windows' Environment Variables settings, then open a new terminal. For the default location,
you can also enable it in the current PowerShell session:

```powershell
$env:Path = "$env:USERPROFILE\.silk\bin;$env:Path"
silk --version
```

Building programs requires [LLVM 22 or newer](https://github.com/llvm/llvm-project/releases),
including Clang, LLD and `llvm-ar`. Add LLVM's `bin` directory to `PATH`, or set `$env:SILK_CLANG`
to the full path to `clang.exe`. See [Silk on Windows](reference/windows.md) for archive
verification, Scoop and mise installation, and the supported Windows filesystem scope.

### Silk versions

A project pins its Silk version with `silk-version` in `silk.toml`, under `[package]` or
`[workspace]`. `silk` reads the pin and runs that version from `~/.silk/toolchains`, so projects on
different versions work side by side. Outside a pinned project it runs your default version. In a
workspace the `[workspace]` pin wins over the members' own, and `silk set` sets it and moves any
member pins along with it.

```sh
silk use                    # install the version this project pins
silk use 0.1.0-dev.11       # install a version and make it your default
silk set latest             # pin this project to the newest stable release (--dev: include dev releases)
silk use list               # installed versions, and which one is selected here
silk use which              # the version selected here, and why
silk +0.1.0-dev.11 build    # run one command with an installed version
silk update self            # update the silk tool itself
```

Every other command, such as `silk build` or `silk test`, runs unchanged in the selected
version's compiler. When the pinned version is missing, the command exits with status 3 and names
the `silk use` command that fixes it. Set `SILK_AUTO_INSTALL=1`, or `auto-install = true` in
`~/.silk/settings.toml`, to install it automatically instead. `SILK_TOOLCHAIN=<version>`
overrides the selection for a shell. See [tool/README.md](tool) for the rest. Homebrew and mise
install `silk` beside its release's `silkc`, which it runs when nothing selects another version.

## Quick start

```sh
silk init hello
cd hello
silk run
```

```console
Hello, world!
```

`silk init` writes a `silk.toml` and a `src/main.silk`. Even "hello world" names what it needs:

```silk
import silk.core.effect { Effect }
import silk.io.logger { LogError }
import silk.io.logger_native { StdoutLogger }

pub effect fn main() -> ()
  ! LogError {
  let mut logger = StdoutLogger.make()

  run Effect.log("Hello, world!", &()) |> Effect.provideMut(&mut logger)
}
```

## Changes and releases

`silk change` records release notes and cuts releases. It is implemented in the [`changes/`](changes)
Silk package and reads the `[release]` table of `silk.toml`. From a package directory:

```sh
silk change minor "Reads now return a future." --migration "Await read()."
silk change status
silk change version --tag beta
silk change version
silk change release --json
silk change since 0.1.0 --json
```

Each contribution gets its own `.changes/<random>.md`, avoiding shared changelog edits in PRs.
Write the summary as one line. Migration guidance is only for changes that consumers must act on;
no guidance means no action is needed. Releases
consume pending changes, update the package version, and write authoritative
`.changes/releases/<version>.toml` records. `CHANGELOG.md` is regenerated from those records
with a warning that manual edits will be overwritten. An optional `[release].version-file`
generates a Silk module exposing the package's version in the same recovery transaction.
Commit the records, changelog, manifest, generated module, and consumed-file deletions together.
`release` checks the prepared release and exports its notes and metadata for a publisher.
These commands do not commit, tag, publish, or access Git.

`silk change since` selects compiler upgrades from the project's `package.silk-version`.
`since <dependency>` starts at that dependency's installed manifest version; `--to VERSION`
selects an exact target. Published queries compare immutable `changes-snapshot.toml` release
assets, including pending notes that actually shipped in a dev release—not today's open changes.
Unchanged notes are deduplicated across dev-to-stable promotion; edited migration guidance is
shown again as updated. `--source PATH` supports offline checkouts and snapshot files.
`silk change --help` lists the discovery and trust settings.

The compiler uses this flow itself. A maintained draft release PR collects pending changes;
merging it publishes stable after the native gates pass. Daily or manually triggered dev releases
use `0.1.0-dev.N+<commit>` versions without consuming pending notes or changing the committed
changelog. `0.1.0` remains reserved for the first announcement. See the
[compiler release procedure](compiler/README.md#release-versions).

## A short tour

### Services and providers

A `service` declares operations. Any value can provide it through an `impl`, and `Effect.provide`
hands that value to a computation.

```silk
service Clock {
  effect fn now() -> u64 ? &Clock
}

struct FixedClock { at: u64 }

impl Clock for FixedClock {
  effect fn now(self: &Self) -> u64 { return self.at }
}

struct Expired {}

effect fn expired(error: Expired) -> u64 { return 0 }

pub effect fn main() -> () ! LogError {
  let clock = FixedClock { at: 58 }
  let mut logger = StdoutLogger.make()
  let left = run Effect.catch<Expired>(remaining(100), expired)
    |> Effect.provide(&clock)
    |> Effect.provideMut(&mut logger)
}
```

```console
42 ticks left
```

`Effect.catch<Expired>` takes `Expired` out of the error type. `main` still declares `LogError`,
because nothing handled it.

### Tests swap the providers

`silk test` finds `test` declarations through the import graph. This one runs `remaining` against
the fixed clock and the standard library's in-memory logger:

```silk
test effect fn reportsTheTimeLeft() -> () ! AssertionError<'static> | Expired | LogError {
  let clock = FixedClock { at: 58 }
  let mut logger = Logger.inMemoryProvider()
  let left = run remaining(100)
    |> Effect.provide(&clock)
    |> Effect.provideMut(&mut logger)
  run Testing.expect(left == 42 && Logger.length(&logger) == 1, "one log line, 42 ticks left")
}
```

```console
$ silk test
  main::reportsTheTimeLeft
    PASS  19 us

Tests  1 passed, 0 failed (0 cached, 1 executed, 1 selected, 1 discovered)
```

### Ownership and cleanup

```silk
import silk.core.ownership { Drop }

struct Connection { id: i32 }

impl Drop for Connection {
  fn drop(self: &mut Connection) -> () { return () }
}

fn peek(connection: &Connection) -> i32 { return connection.id }

fn close(connection: Connection) -> i32 { return connection.id }

pub fn main() -> i32 {
  let connection = Connection { id: 7 }
  let seen = peek(&connection)
  let closed = close(move connection)
  return seen + closed
}
```

`peek` borrows the connection. `close` takes ownership, so `drop` runs when `close` returns. Change
the last line to `return seen + closed + connection.id` and the compiler stops you:

```console
src/main.silk:17:26: error[OWN0001] connection was moved and cannot be used again
```

### Unions and matching

Unions are structural, and a `match` has to cover every case.

```silk
struct Circle { radius: f64 }
struct Rect { width: f64, height: f64 }

fn area(shape: Circle | Rect) -> f64 {
  return match move shape {
    Circle c => 3.14159 * c.radius * c.radius
    Rect r => r.width * r.height
  }
}
```

### Compile-time selection

```silk
import silk.core.target { Target, Arch }

fn wordBits() -> u32 {
  static if Target.arch() == Arch.Wasm32 {
    return 32
  } else {
    return 64
  }
}
```

The condition is evaluated for the target being built. Only the chosen branch reaches the program,
so nothing is checked at run time.

## What's in the box

| Command                     | What it does                                                         |
| --------------------------- | -------------------------------------------------------------------- |
| `silk init`                 | Create a package with `silk.toml` and `src/main.silk`                |
| `silk build` / `silk run`   | Compile for one or more targets, in debug or `--release`             |
| `silk check`                | Check types, ownership and effects without building                  |
| `silk test`                 | Discover and run `test` declarations                                 |
| `silk format`               | Format source canonically, with `--check` for CI                     |
| `silk doc` / `silk doctest` | Extract documentation from `///` comments and compile their examples |
| `silk clean`                | Remove build output                                                  |

The [standard library](reference/stdlib/index.md) is written in Silk and documented with `silk doc`.
It includes:

- **Core:** `Effect`, `Result`, `Option`, `List`, `HashMap`, `Box`, `Shared`, strings, Unicode,
  formatting, and checked arithmetic for every scalar type.
- **Systems:** files, child processes, sockets, clocks, randomness, single-threaded fibers and
  schedulers, and WebAssembly start-up.
- **Data:** JSON and TOML, Base64, URIs, LZMA/LZMA2, XZ, and Zstandard decoding, and DEFLATE/zlib/gzip encoding and decoding.
- **Network:** HTTP/1.x and HTTP/2 clients and servers, HPACK, a WebSocket server, connection pooling, and TLS with X.509
  certificate path validation.
- **Crypto:** SHA-1, SHA-2 and SHA-3, HMAC, HKDF, AES-GCM, ChaCha20-Poly1305, X25519, and ECDSA
  P-256 and RSA signature verification.

## Platforms

Native hosts are Apple Silicon macOS (`aarch64-apple-darwin`), x86-64 Linux
(`x86_64-unknown-linux-gnu`) and ARM64 Linux (`aarch64-unknown-linux-gnu`). Intel macOS
(`x86_64-apple-darwin`) is a tier 2 output target. Any host links Linux and macOS executables
for another of these targets when the build names a [platform supply](reference/platform-supplies.md)
for it. WebAssembly
(`wasm32-unknown-unknown`) is a freestanding output target. WASI commands target
`wasm32-wasip1` (core modules) or `wasm32-wasip2` (components). Preview 2 also supports
TCP, UDP, DNS, HTTP clients and servers, and custom WIT worlds. See the
[WASI guide](reference/wasi.md) for build tools, runtime commands, and host services.

## Status

Silk is pre-alpha. The language is still being designed, and any API may change without notice.
The [language reference](reference/index.md) is prescriptive, and each rule says whether it is
confirmed, a candidate or still open.

Every change has to build the compiler with itself twice in a row and get identical LLVM IR both
times. It also has to run a shared corpus of 443 programs with exactly the expected results.

## Repository

| Path                      | Contents                                                   |
| ------------------------- | ---------------------------------------------------------- |
| [`compiler/`](compiler)   | The compiler, written in Silk                              |
| [`changes/`](changes)     | Changes, release versions, migration notes, and changelogs |
| [`tool/`](tool)           | The silk tool, the front door: Silk versions and forwarding |
| [`tomledit/`](tomledit)   | Comment-preserving `silk.toml` edits, shared by both       |
| [`stdlib/`](stdlib)       | The standard library                                       |
| [`reference/`](reference) | The language reference and the generated stdlib reference  |
| [`corpus/`](corpus)       | The shared acceptance corpus                               |
| [`examples/`](examples)   | Larger example programs                                    |

The root `silk.toml` defines a native workspace containing `compiler`, `changes`, `tomledit` and
`tool`. Members
share the root `build/` directory; the root is not itself a package. Select a member explicitly
from the root, for example `silk build --manifest-path compiler/silk.toml --stdlib stdlib` or
`silk change --dir compiler status`. Release operations affect one package at a time.

## Contributing

The compiler builds itself from the published seed pinned in
[`compiler/native-seed.json`](compiler/native-seed.json). [`compiler/README.md`](compiler/README.md)
walks through building it and running its source-written test suites. Repository tooling runs on
Node and pnpm:

```sh
pnpm install
pnpm test:scripts
```

On Debian or Ubuntu, `bash scripts/setup-linux-llvm.sh` installs the verified LLVM 22 toolchain
under `.scratch/llvm-22.1.8`. Put its `bin` directory on `PATH`.

## License

[MIT](LICENSE) © 2026 Julia Ortiz
