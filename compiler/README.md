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

## Check roots

The language server checks one module or one declaration at a time, through
`Semantic.checkModule` and `Semantic.checkDeclaration`, so an edit refreshes only the
entries it reaches. `silk check --roots` checks the package as usual, then checks each of
its modules again through `checkModule` (plus `Semantic.checkForeignConflicts`) and
compares the two by module, code and span. It writes one
`silk-check-roots only=package|roots <module> <code> <start>-<end>` line per rejection
only one side reached, then `silk-check-roots modules=<count> rejections=<count>
differences=<count>`, and fails the check when they differ.

## Profiling with Tracy

`src/Profiler.silk` opens [Tracy](https://github.com/wolfpld/tracy) zones around the build
phases (`build`, `preloadProgram`, `buildArtifact`, `checkDeclarations`, `buildFrom`,
`compileIr`), every semantic query provider run (named by its family, such as `Body`, `Signature`,
`Mir` or `LlvmText`) and each `BorrowCheck`. Query and borrow-check zones carry the declaration
they work on, such as `semantic/Semantic.lowerMir`, as zone text. Ordinary builds leave it off, so they declare and call
nothing. To build an instrumented compiler at `.scratch/silk-tracy`:

```sh
SILK=path/to/silk CLANG=path/to/clang compiler/profiling/build-tracy.sh
```

The script fetches Tracy v0.14.1 into `.scratch`, copies the compiler to `.scratch/tracy-build`,
switches `Profiler.enabled` on there and links the Tracy client; the checkout is not modified.
Start the Tracy profiler or `tracy-capture -o run.tracy`, then run the compiler with
`TRACY_NO_EXIT=1` so it waits until the trace is sent. Use the Tracy v0.14.1 tools; the trace
protocol changes between releases. A new zone is one line, `let zone = Profiler.zone(b"name")`,
and lasts until the value drops; `Profiler.text(&zone, text)` labels it, inside
`static if Profiler.enabled` so ordinary builds never build the text.
