# Silk

Silk is an unreleased low-level systems language built around explicit memory and execution
control, typed failures, replaceable service requirements, deterministic cleanup, and
tooling-friendly semantics. The repository is a strict TypeScript, ESM-only monorepo containing the
stage-0 compiler, runtime-facing libraries, editor tooling, and language-pressure programs.

Silk currently compiles one source program through a lossless frontend, module and type analysis,
HIR, ownership and cleanup planning, specialization, and MIR. Runtime artifacts—native executables
and WebAssembly modules—are emitted through LLVM. Target-sensitive compile-time constants are
resolved separately by static evaluation while the program is being analyzed.

The implemented bootstrap language includes modules and visibility, scalar families, typed scalar
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

## Language documentation

- [Getting started](apps/docs/content/language/tutorial.md) — build a first project and learn the core
  language through compiler-checked programs.
- [Language reference](apps/docs/content/reference/index.md) — prescriptive syntax, type,
  ownership, Effect, declaration, and control-flow rules with supporting evidence.
- [Ownership](apps/docs/content/language/ownership.md),
  [Effects and services](apps/docs/content/language/effects.md), and
  [Fibers](apps/docs/content/language/fibers.md) — focused explanations of Silk's central model.
- [Alpha status](apps/docs/content/language/alpha-status.md) — implemented scope, supported targets,
  and compatibility boundaries.
- [Standard library](apps/docs/content/language/stdlib/index.md) and
  [diagnostics](apps/docs/content/language/diagnostics.md) — generated lookup references.

This is still an alpha language. APIs may break freely. Cooperative single-threaded Fibers are
implemented; parallelism, multithreading, networking, a package registry, broad FFI, and
self-hosting remain future work chosen from executable evidence rather than compatibility
commitments.

## Packages

- [`@silklang/compiler`](packages/compiler) — the stage-0 compiler, LLVM backend, compile-time
  static evaluator, embedded Silk standard library, and supported analysis facade.
- [`@silklang/cli`](packages/cli) — project initialization, checking,
  multi-target builds, native execution, formatting, and documentation generation through `silk`.
- [`@silklang/llvm`](packages/llvm) — Effect-native LLVM IR construction and deterministic text
  and bitcode emission.
- [`@silklang/editor-support`](packages/editor-support) — portable CodeMirror integration,
  TextMate grammar, semantic editor projections, and the `<silk-snippet>` custom element.
- [`@silklang/lsp`](packages/lsp) — project-aware diagnostics, hover, navigation, completion,
  inlay hints, symbols, and canonical formatting over stdio.
- [`@silklang/docgen`](packages/docgen) — CommonMark documentation models, semantic links,
  highlighting, doctesting, deterministic JSON, and static-site rendering.
- [`silk-language`](apps/vscode) — the private Cursor/VS Code extension app.

## Evidence and direction

The compiler is exercised by seven familiar algorithms plus Silk-written lexer and bounded stack
VM pressure programs. A shared native acceptance corpus pins runtime outcomes independently, while
LLVM IR, object, C-fixture, and LLVM-to-Wasm tests cover their authoritative target boundaries.

Current specifications live under [`openspec/specs`](openspec/specs); active changes live under
[`openspec/changes`](openspec/changes), and completed design records live under
[`openspec/changes/archive`](openspec/changes/archive).

## Development

Supported native hosts are ARM64 Linux (`aarch64-unknown-linux-gnu`), x86-64 Linux
(`x86_64-unknown-linux-gnu`), and Apple Silicon macOS (`aarch64-apple-darwin`). Both the
TypeScript compiler and the source-written compiler support ARM64 Linux, including Debian cloud
VMs. WebAssembly (`wasm32-unknown-unknown`) is an output target.

CI uses standard GitHub-hosted `ubuntu-24.04` (x86-64), `ubuntu-24.04-arm` (ARM64), and
`macos-15` (Apple Silicon) runners. Both [repository CI](.github/workflows/ci.yml) and
[selfhost CI](.github/workflows/selfhost.yml) run for pull requests into `main` and in the merge
queue that lands them. A `main` push reuses the queue's green run of its commit.

CI can use the [standalone bootstrap compiler](packages/cli/README.md#standalone-compiler-for-ci)
stored as a GitHub Actions artifact from passing `main` commits: download `silk.mjs` and run it
with Node 24 or Bun.

```sh
pnpm install
pnpm dev
pnpm build
pnpm check
```

`pnpm dev` runs package compilers in watch mode alongside the documentation app. `pnpm build`
creates a dependency-ordered production build of every workspace package and app.

### Linux compiler development

Install Node 24 and the pnpm version in `package.json`. On Debian or Ubuntu, install the host C
development libraries and the verified LLVM tools, then build the CLI:

```sh
sudo apt-get update
sudo apt-get install build-essential curl xz-utils ca-certificates
bash scripts/setup-linux-llvm.sh
export PATH="$PWD/.scratch/llvm-22.1.8/bin:$PATH"
pnpm install --frozen-lockfile
pnpm --filter @silklang/cli... run build
node packages/cli/dist/bin.js init /tmp/silk-hello
node packages/cli/dist/bin.js run --manifest-path /tmp/silk-hello/silk.toml
```

The installer selects x86-64 or ARM64 from the running host and verifies the LLVM archive's
SHA-256. Native compilation selects the host target automatically. Keep the LLVM `bin` directory
on `PATH` in development shells; an older distribution Clang may not read Silk's LLVM 22 bitcode.
For the source-written compiler, use the `selfhost` branch and its
[bootstrap instructions](https://github.com/silk-lang/silk/blob/selfhost/compiler/README.md#development-branches-and-bootstrap). The published
native seed's host architecture is separate from the compiler's supported output targets.

Effect-returning tests use `it.effect` from `@effect/vitest`; pure tests use ordinary `it` with
`assert`.

## License

[MIT](LICENSE) © 2026 Julia Ortiz
