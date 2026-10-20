# compiler

The native Silk compiler, written in Silk. It builds itself: CI compiles this
package with the pinned seed release (`native-seed.json`) to get N1, then N1
compiles it again.

| Path | What it holds |
| --- | --- |
| `src/` | Compiler source. `main.silk` is the entry point; `lexer/`, `parser/`, `hir/`, `semantic/`, `backend/` (MIR, layout, LLVM text), `diagnostic/`, `format/`, `documentation/`, `driver/` |
| `conformance/` | Native conformance programs and runners |
| `fixtures/` | Test inputs |
| `scripts/` | Build, release and verification scripts used by CI |
| `profiling/` | The opt-in Tracy build (see below) |
| `native-seed.json` | The pinned seed compiler used to build N1 |
| `silk.toml` | Package manifest |

The build and test steps CI runs are in `.github/workflows/selfhost.yml`.

## Profiling with Tracy

`src/Profiler.silk` opens [Tracy](https://github.com/wolfpld/tracy) zones around the build
phases (`build`, `preloadProgram`, `buildArtifact`, `checkDeclarations`, `buildFrom`,
`compileIr`), every semantic query provider run (named by its family, such as `Body`, `Signature`,
`Mir` or `LlvmText`) and each `BorrowCheck`. Ordinary builds leave it off, so they declare and call
nothing. To build an instrumented compiler at `.scratch/silk-tracy`:

```sh
SILK=path/to/silk CLANG=path/to/clang compiler/profiling/build-tracy.sh
```

The script fetches Tracy v0.14.1 into `.scratch`, copies the compiler to `.scratch/tracy-build`,
switches `Profiler.enabled` on there and links the Tracy client; the checkout is not modified.
Start the Tracy profiler or `tracy-capture -o run.tracy`, then run the compiler with
`TRACY_NO_EXIT=1` so it waits until the trace is sent. Use the Tracy v0.14.1 tools; the trace
protocol changes between releases. A new zone is one line, `let zone = Profiler.zone(b"name")`,
and lasts until the value drops.
