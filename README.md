# Silk

Silk is an unreleased low-level systems language built around explicit memory and execution
control, typed failures, replaceable service requirements, deterministic cleanup, and
tooling-friendly semantics. The compiler is written in Silk and builds itself.

Silk currently compiles one source program through a lossless frontend, module and type analysis,
HIR, ownership and cleanup planning, specialization, and MIR. Runtime artifacts—native executables
and WebAssembly modules—are emitted through LLVM. Target-sensitive compile-time constants are
resolved separately by static evaluation while the program is being analyzed.

The implemented language includes modules and visibility, scalar families, typed scalar
constants, structs, fixed arrays, runtime slices, structural unions and exhaustive matching,
generics, first-class callables and pipelines, mutation, structured loops, recursion, affine
ownership, shared and exclusive borrowing, deterministic `Drop`, explicit allocation, static text
and byte data, and typed `Effect` computations with explicit service requirements. Canonical
`Result`, `Effect`, and `Vector` operations are ordinary navigable Silk source rather than
compiler-recognized library names. Portable semantic logging is likewise source-defined:
`Effect.log` and its level-specific aliases submit one complete borrowed `string` and a closed
`LogLevel` through an explicit replaceable `Logger`, with stdout and deterministic in-memory
providers supplied by the standard library.
Portable whole-file interaction is source-defined as well: normalized provider-absolute `Path`
values and a seven-operation mutable `FileSystem` service can be implemented by application-owned
native, browser, Wasm, or test providers without introducing ambient storage or host imports.

## Install

On macOS (Apple Silicon) or Linux (x86-64 or ARM64), install the native compiler from the newest
published build of `main`:

```sh
curl -fsSL https://raw.githubusercontent.com/silk-lang/silk/main/install.sh | sh
```

The script puts `silk` in `~/.silk/bin` (set `SILK_INSTALL` to change it) with its standard
library beside it, and checks the compiler's SHA-256 against the release. Building programs needs
Clang 22 or newer on `PATH`, or `SILK_CLANG` set to it. Archives downloaded through a browser are
quarantined by macOS; files fetched by the script are not, so Gatekeeper lets them run.

## Repository

- [`compiler/`](compiler) — the native compiler, written in Silk, and the tooling CI runs around
  it in [`compiler/scripts/`](compiler/scripts).
- [`stdlib/`](stdlib) — the standard library.
- [`reference/`](reference/index.md) — the prescriptive language reference, and the generated
  [standard-library reference](reference/stdlib/index.md).
- [`corpus/`](corpus) — the shared native acceptance corpus.
- [`bootstrap/`](bootstrap) — the frozen TypeScript compiler, kept only to build the first native
  compiler from source.

This is still an alpha language. APIs may break freely.

## Development

Supported native hosts are ARM64 Linux (`aarch64-unknown-linux-gnu`), x86-64 Linux
(`x86_64-unknown-linux-gnu`), and Apple Silicon macOS (`aarch64-apple-darwin`). WebAssembly
(`wasm32-unknown-unknown`) is an output target.

The compiler builds itself from the published seed pinned in
[`compiler/native-seed.json`](compiler/native-seed.json); see [`compiler/README.md`](compiler/README.md).
[Selfhost CI](.github/workflows/selfhost.yml) checks it, and [repository CI](.github/workflows/ci.yml)
runs formatting, lint, and the tooling's own tests:

```sh
pnpm install
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:scripts
```

On Debian or Ubuntu, `bash scripts/setup-linux-llvm.sh` installs the verified LLVM tools under
`.scratch/llvm-22.1.8`. Keep its `bin` directory on `PATH`; an older distribution Clang may not read
Silk's LLVM 22 bitcode.

## License

[MIT](LICENSE) © 2026 Julia Ortiz
