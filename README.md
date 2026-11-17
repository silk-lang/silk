<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/silk-wordmark-dark.svg">
    <img src=".github/assets/silk-wordmark-light.svg" alt="Silk" width="240">
  </picture>
</p>

<h3 align="center">Built for the way software is written today.</h3>

<p align="center">
  <a href="https://github.com/silk-lang/silk/actions/workflows/selfhost.yml"><img src="https://github.com/silk-lang/silk/actions/workflows/selfhost.yml/badge.svg?branch=main" alt="Selfhost"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-c6a678" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/status-alpha-8b5cf6" alt="Alpha">
</p>

<p align="center">
  <a href="https://silklang.org">Website</a> ·
  <a href="https://silklang.org/docs/get-started/a-tour-of-silk">Tour</a> ·
  <a href="https://silklang.org/docs">Documentation</a> ·
  <a href="#install">Install</a> ·
  <a href="https://silklang.org/releases">Releases</a>
</p>

---

Working with agents is all about clear contracts. Silk exists to give you that. Every effect
function states what it returns, how it can fail and what it touches, down to the allocator. Every
value has an owner and every borrow has a lifetime, so nothing is left to luck.

Silk is a systems language. It compiles to native code and WebAssembly, has no garbage collector,
and its compiler is written in Silk.

```silk
import silk.core.effect { Effect }
import silk.io.logger { Logger, LogError }
import silk.io.logger_native { StdoutLogger }

pub service Random {
  effect fn next(self: &mut Self) -> u32
}

struct NoSides {}

effect fn roll(sides: u32) -> u32
  ! NoSides | LogError
  ? &mut Random | &mut Logger {
  if sides == 0 {
    fail NoSides {}
  }
  let face = (run Random.next()) % sides + 1
  run Effect.log("rolled {face}\n", &.{ face })
  return face
}
```

Read the signature of `roll` as a contract: it returns a `u32`, it can fail with `NoSides` or
`LogError`, and it needs a `Random` source and a `Logger`. Nothing else can happen in there
without the signature changing.

- **`service` names a need** without saying how it is met.
- **`!` lists the failures** and **`?` lists the needs.** Leave a need unprovided, or a failure
  unhandled, and the program does not compile.
- **`run` marks every effect.** An effect is a value until `run` executes it, so you can see where
  things happen.

## Why Silk

Code is now written by people and agents together, and reviewed by whoever did not write it. Silk
is designed for that loop.

- **The signature is the contract.** Failures (`! E`) and requirements (`? &Service`) are part of
  every effect function's type. Clocks, loggers, files, sockets, randomness and allocators are
  services that code asks for, and the caller decides what it gets.
- **Guardrails, not trust.** Values have one owner, `&` and `&mut` borrow them, and cleanup runs
  at a point you can see in the source. You do not have to trust that the author, human or not,
  remembered to free something or kept a reference alive.
- **No hidden heap.** Code that allocates asks for an `Allocator`. Pass the system allocator, an
  arena, or one that always refuses in a test. Running out of memory is a typed failure,
  `! OutOfMemoryError`, not a crash.
- **Few ways to write a thing.** Being explicit costs little when agents do the typing, so Silk
  spends it on clarity. There is usually one way to express something, which makes code easy to
  review and easy for an agent to match.
- **A fast loop.** Compile speed is a core value. Every feature is weighed by what it costs the
  rebuild. `silk check` reports errors without building, builds are incremental, and `silk test`
  runs only the tests a change can affect.
- **Library, not magic.** `Effect`, `Option`, `List`, fibers, schedulers and allocators are
  ordinary Silk in [`stdlib/`](stdlib). You can read them like your own code.

## Install

macOS (Apple Silicon) and Linux (x86-64 or ARM64):

```sh
curl -fsSL https://raw.githubusercontent.com/silk-lang/silk/main/install.sh | sh
```

Windows (x86-64), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/silk-lang/silk/main/install.ps1 | iex
```

Homebrew:

```sh
brew install silk-lang/tap/silk
```

Each release carries its own LLVM, so there is nothing else to install. The installer puts the
`silk` command in `~/.silk/bin` and keeps every Silk version side by side in `~/.silk/toolchains`.
A project pins its version with `silk-version` in `silk.toml`, and `silk` runs that version for
you. The [install guide](https://silklang.org/docs/get-started/install) covers mise, Scoop,
signature verification and choosing a version, and
[editor setup](https://silklang.org/docs/get-started/editor-setup) covers the language server.

## Quick start

```sh
silk init hello
cd hello
silk run
```

```console
Hello, world!
```

Even "hello world" says what it needs and how it can fail:

```silk
import silk.core.effect { Effect }
import silk.io.logger { LogError }
import silk.io.logger_native { StdoutLogger }

pub effect fn main() -> ()
  ! LogError {
  let mut logger = StdoutLogger.make()

  run Effect.log("Hello, world!\n", &()) |> Effect.provideMut(&mut logger)
}
```

## A short tour

### Provide at the edge

`roll` above does not know which random source or logger it gets. Any value can provide a service
through an `impl`, and `main` picks the providers:

```silk
struct Fixed {
  value: u32,
}

impl Random for Fixed {
  effect fn next(self: &mut Self) -> u32 {
    return self.value
  }
}

effect fn noSides(error: NoSides) -> u32 {
  return 0
}

pub effect fn main() -> ()
  ! LogError {
  let mut random = Fixed { value: 41 }
  let mut logger = StdoutLogger.make()

  drop run roll(6)
    |> Effect.catch<NoSides>(noSides)
    |> Effect.provideMut(&mut random)
    |> Effect.provideMut(&mut logger)
}
```

```console
rolled 6
```

`Effect.catch<NoSides>` takes `NoSides` out of the failure type. `main` still declares `LogError`,
because nothing handled it.

### Tests swap the providers

The same `roll`, with a fixed source and the standard library's in-memory logger. Nothing is
mocked and nothing global is patched. `Testing` and `AssertionError` come from
`silk.testing.testing`:

```silk
test effect fn rollsTheFaceTheSourceGives() -> ()
  ! AssertionError<'static> | NoSides | LogError {
  let mut random = Fixed { value: 41 }
  let mut logger = Logger.inMemoryProvider()

  let face = run roll(6)
    |> Effect.provideMut(&mut random)
    |> Effect.provideMut(&mut logger)

  run Testing.expect(face == 6, "41 % 6 + 1 is 6")
  run Testing.expect(Logger.length(&logger) == 1, "one line was logged")
}
```

```console
$ silk test
  main::rollsTheFaceTheSourceGives
    PASS  44 us

Tests  1 passed, 0 failed (0 cached, 1 executed, 1 selected, 1 discovered)
```

Run it again without changing anything `roll` reaches and the result comes from the cache.

### The compiler says which line to move

Every borrow lives until its last use. A shared read cannot start while a mutable borrow of the
same value is still in use:

```silk
pub fn main() -> i32 {
  let mut x = 1
  let r = &mut x
  let s = &x
  r.* = 2
  return s.*
}
```

```console
src/main.silk:4:11: error[OWN0010] A shared borrow of `x` conflicts with an earlier mutable borrow of it that is still in use; use that borrow for the last time before this one
  note: src/main.silk:3:11: the earlier borrow starts here
```

Move `let s = &x` below `r.* = 2` and it compiles. Every error code is
[documented](https://silklang.org/docs/appendix/diagnostic-codes).

The [tour](https://silklang.org/docs/get-started/a-tour-of-silk) continues with fibers, retries on
a schedule, arenas, unions and compile-time evaluation, and
[the book](https://silklang.org/docs/book/overview) teaches the language from the start.

## Builds are Silk code

`silk.toml` says what a package is and what it depends on. Most packages need nothing more:

| Command                     | What it does                                                    |
| --------------------------- | --------------------------------------------------------------- |
| `silk init`                 | Create a package or a workspace, optionally from a template     |
| `silk build` / `silk run`   | Compile for one or more `--target`s, in dev mode or `--release` |
| `silk check`                | Report type, ownership and effect errors without building       |
| `silk test`                 | Run the tests a change can affect                               |
| `silk format`               | Format Silk and TOML, with `--check` for CI                     |
| `silk add` / `silk fetch`   | Manage dependencies                                             |
| `silk doc` / `silk doctest` | Extract `///` documentation and run its examples                |
| `silk pack`                 | Check a package and write its release archives                  |
| `silk lsp`                  | Start the language server                                       |

When a build needs more than flags can say, it is described in Silk, not in configuration. A
package's `src/tasks.silk` holds the commands of the project. Each command builds a graph of
compilations as plain values and hands it to the compiler:

```silk
union Tasks {
  Build { pub options: Options },
  Small { pub options: Options },
}

impl TaskSet for Tasks {
  effect fn perform(self: Tasks) -> ()
    ! BuildError
    ? &mut Allocator | &mut FileSystem | &mut HostInput {
    match move self {
      Tasks.Build { options } => {
        let program = run Compilation.fromPackage(&options)
        drop run program.build()
      }
      Tasks.Small { options } => {
        let program = run Compilation.fromPackage(&options)
        let small = run program.optimize(run Deferred<Optimize>.value(Optimize.Size))
        drop run small.build()
      }
    }
  }
}
```

`Build` replaces what `silk build` does, and `silk task small` runs the other one. The imports and
the command-line description are left out here. A command is typed and checked like the rest of
your code, and a dependency's tasks never run on your machine. See
[Projects](https://silklang.org/docs/projects/overview) for build graphs, generated code, C
sources and packaging.

## Batteries included

The [standard library](https://silklang.org/docs/std/overview) is written in Silk, under the same
allocator, failure and service rules as your code. An HTTPS client needs one dependency: the
toolchain.

- **Core:** `Effect`, `Option`, `Result`, `List`, `HashMap`, `Box`, `Shared`, strings, Unicode,
  formatting, regular expressions and checked arithmetic.
- **Concurrency:** fibers, schedulers, retries and repeats on a `Schedule`, and virtual time for
  tests.
- **Systems:** files, child processes, sockets, clocks, randomness, typed SIMD vectors, and Linux
  executables that link no C library.
- **Network:** HTTP/1.1 and HTTP/2 clients and servers, WebSocket, connection pooling, and TLS 1.3
  with X.509 path validation.
- **Crypto:** SHA-2, SHA-3, BLAKE2, HMAC, HKDF, AES-GCM, ChaCha20-Poly1305, X25519 and Ed25519.
- **Data:** JSON, TOML, YAML, schemas with derived codecs, Base64, URIs, and DEFLATE, gzip,
  Zstandard, XZ and LZMA2 decoding in fixed memory.
- **Programs:** typed command lines with `silk.cli`, and the build graph API behind `tasks.silk`.

Files, processes, clocks, randomness and sockets are services, so every one of them has a
stand-in for tests.

## Platforms

Silk runs on macOS (Apple Silicon, with Intel as a tier 2 host), Linux (x86-64 and ARM64) and
Windows (x86-64). It compiles to macOS, Linux with or without libc, Windows and WebAssembly, and
any host can build for all of them.

Executables for another system link with no SDK or sysroot (see
[platform supplies](reference/platform-supplies.md)). WebAssembly output is freestanding
`wasm32-unknown-unknown`, or WASI Preview 1 and Preview 2 (see the [WASI guide](reference/wasi.md)).
[Silk on Windows](reference/windows.md) covers the Windows details.

## Where Silk comes from

- **[Effect](https://effect.website)** showed how far typed errors, services and effects can carry
  a codebase as it grows. Silk exists because that kind of scalability should not be limited to
  JavaScript.
- **[Rust](https://www.rust-lang.org)** designed the memory model today's software needs: every
  value has an owner and every borrow has a lifetime.
- **[Zig](https://ziglang.org)** showed the value of being explicit about system resources, and
  that a fast, incremental compiler is essential to any loop.

## Status

Silk is in alpha. The compiler already builds itself, and every change has to build it twice in a
row with identical output and pass a shared corpus of programs with exactly the expected results.

The language, the standard library and the tools are moving fast, and APIs will change rapidly
before 1.0. Every [release](https://silklang.org/releases) lists what changed and how to migrate.
Try it, pin your toolchain, and help shape what Silk becomes.

## Repository

| Path                      | Contents                                                     |
| ------------------------- | ------------------------------------------------------------ |
| [`compiler/`](compiler)   | The compiler, written in Silk                                |
| [`stdlib/`](stdlib)       | The standard library                                         |
| [`tool/`](tool)           | The `silk` command: Silk versions and forwarding to `silkc`  |
| [`changes/`](changes)     | `silk change`: release notes, versions and changelogs        |
| [`tomledit/`](tomledit)   | Comment-preserving `silk.toml` edits                         |
| [`reference/`](reference) | The language reference and the generated stdlib reference    |
| [`corpus/`](corpus)       | The shared acceptance corpus                                 |
| [`examples/`](examples)   | Larger example programs                                      |

## Contributing

Issues and pull requests are welcome. The compiler builds itself from the published seed pinned in
[`compiler/native-seed.json`](compiler/native-seed.json); [`compiler/README.md`](compiler/README.md)
describes its layout and [`.github/CI.md`](.github/CI.md) the checks a pull request runs. The root
`silk.toml` is a workspace of `compiler`, `changes`, `tomledit` and `tool`, so select a member from
the root, for example `silk build --manifest-path compiler/silk.toml --stdlib stdlib`.

Repository tooling runs on Node and pnpm:

```sh
pnpm install
pnpm test:scripts
```

## License

[MIT](LICENSE) © 2026 Julia Ortiz
