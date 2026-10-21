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

## Edit replay

`silk check --replay <script>` measures how much of a revisable semantic store an edit
invalidates. It checks the package as `silk check` does, but in a store opened with
`Semantic.make`, then applies each edit of the script to the store's revision, calls
`Semantic.update` and checks again. It prints no diagnostics; each step writes one line:

```text
silk-replay step=1 kind=trivia module=silk/bytes.silk demands=376543 hits=375832 units-run=711 marked-outdated=469 graph-units=64792 graph-bytes=46662656 rejections=5 update-us=211 check-us=26868808
```

`demands`, `hits`, `units-run` and `marked-outdated` are what that step added to the store's
`Statistics`; `graph-units` and `graph-bytes` are the dependency graph's size after it.
`rejections` counts the root package's rejections and every parsed module's syntax errors, and
`update-us` and `check-us` are the wall time of `Semantic.update` and of the check. Step 0 is the
first check. The `replayUpdate` and `replayCheck` Tracy zones cover the same spans.

A script is a TOML file of `[[edit]]` tables applied in order. `kind` is `trivia`, `body`,
`header-same-type`, `header-new-type`, `add`, `delete` or `rename`, and `module` is the edited
module's path below the package's module directory. A rename names the new path in `to`; every
other kind replaces `find`, which must occur exactly once in the module, with `replace`.
`fixtures/replay` holds one script for the compiler and one for the standard library:

```sh
cd compiler && silk check --stdlib ../stdlib --replay fixtures/replay/compiler.toml
```

With `--differential`, each step also checks the same revision in a fresh `Semantic.oneShot`
store and compares the two stores' rejections by module, code and span. It writes
`silk-replay-differential step=<n> rejections=<count> differences=<count>`, after one
`silk-replay-differential step=<n> only=revised|one-shot <module> <code> <start>-<end>` line per
rejection only one store reached, and the replay exits with status 1 when any step differs. A
difference is a reconciliation bug in the revisable store. The one-shot store gets the revisable
store's final profile, so a step that edits a `param` declaration compares against the profile
assembled before the edit.

For the standard library, assemble `fixtures/stdlib-root` as the `stdlib-root` CI job does and
run `silk check --stdlib <that directory> --replay <checkout>/compiler/fixtures/replay/stdlib.toml`
in it.

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
`compileIr`, and `replayUpdate` and `replayCheck` for an edit replay), every semantic query provider run (named by its family, such as `Body`, `Signature`,
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
