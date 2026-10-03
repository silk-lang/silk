# @silklang/cli

The project-oriented command line interface for the Silk bootstrap compiler.

## Create a project

```bash
silk init hello
cd hello
silk run
```

`silk init [path] [--name <name>]` creates an executable project:

```text
hello/
├── silk.toml
├── .gitignore
└── src/
    └── main.silk
```

The generated manifest is intentionally sparse:

```toml
[package]
name = "hello"
version = "0.1.0"
root = "src/main.silk"
```

The package name is derived from the selected directory unless `--name` is supplied. Initialization
may add a project to a non-empty directory, but it never overwrites `silk.toml` or `src/main.silk`.
It preserves an existing `.gitignore` byte-for-byte apart from appending the exact `/build/` rule
when needed. A failed or interrupted initialization rolls back only paths it created.

## Project manifest

Every project requires `[package].name`, `[package].version`, and `[package].root`. Names start with
a lowercase letter and contain lowercase letters, digits, or hyphens. Versions follow Semantic
Versioning. Paths are relative to the manifest. The entry directory is the default source root; a
wider root can be selected explicitly:

```toml
[package]
name = "hello"
version = "0.1.0"
root = "src/app/Main.silk"
source-root = "src"

[build]
targets = ["host", "wasm32-unknown-unknown"]
artifact = "executable"
output-dir = "build"
```

`[build]` is optional. The materialized defaults are targets `["host"]` and output directory
`build`, with an `executable` artifact and no native link inputs. `host` resolves to the current
canonical native triple; duplicate resolved targets are built once in first-seen order.

Native LLVM projects may select `shared-library` or `static-library`. Link inputs are structured
inline tables, kept in declaration order; there is no raw linker-flag form:

```toml
[build]
targets = ["host"]
artifact = "shared-library"
native-link-inputs = [
  { search-path = "vendor/lib" },
  { library = "answer", mode = "dynamic" },
  { object = "native/extra.o" },
  { static-archive = "vendor/libsupport.a" },
  { framework = "CoreFoundation" },
]
```

Object, archive, and search paths are resolved relative to `silk.toml` and may not escape the
project. Frameworks are Apple-only, and static archives accept only object inputs. WebAssembly
plans reject library artifact kinds and native link inputs during preflight.

Project commands discover the nearest ancestor `silk.toml`. `--manifest-path <path>` selects one
exact manifest instead.

## Build, check, and run

```bash
silk check
silk build
silk build --release
silk build --target host --target wasm32-unknown-unknown
silk run -- --literal-program-argument
```

One or more `--target` flags replace the complete manifest target array; they do not append to it.
LLVM supports native targets and `wasm32-unknown-unknown`.

Build preflights the entire target batch, then processes it sequentially. Every target is
attempted after a valid preflight, successful sibling artifacts remain committed, and the command
prints target outcomes followed by success/failure totals. Artifacts use LLVM-qualified paths:

```text
build/llvm/<canonical-target>/<profile>/<artifact-file>
```

For example:

```text
build/llvm/wasm32-unknown-unknown/debug/hello.wasm
build/llvm/aarch64-apple-darwin/release/libhello.dylib
build/llvm/x86_64-unknown-linux-gnu/release/libhello.so
build/llvm/aarch64-apple-darwin/release/libhello.a
```

A successful native shared- or static-library build also writes `hello.h` and
`hello.abi.json` beside the platform library and reports all three paths. The header includes
`<stdint.h>`, C++ linkage guards, exact-width scalar types, opaque `const void *` / `void *`
pointers, and recursively valid C function-pointer declarators. The JSON document has schema
marker `"silkForeignAbi": 4`, the canonical target, and symbol-sorted `exports` and `imports`
arrays whose entries distinguish functions from data. Function records include a required `variadic` boolean, fixed parameter types, and their normalized memory, capture, complete-call borrow, synchronous callback invocation, returned-alias, no-return and forbidden-unwind contract. Native function-pointer entries retain nonnullness and access behavior in the manifest; C headers erase those non-C facts. Both files are regenerated from the
verified backend inventory on cache hits, so cached and uncached builds produce identical bytes.
Executables and WebAssembly modules do not produce either companion.

`silk check` analyzes every resolved target in order without Clang, linker, or artifact
work. Diagnostics and summaries are target-qualified. `silk run` uses the selected profile and
requires an executable matching the host target. After a successful build, run returns the program's exact exit status.

Shared options are:

- `--manifest-path <path>` — select an exact manifest.
- `--target <host|canonical-target>` — repeatable; replace the manifest targets.
- `--profile <name>` — select a named project compilation profile.
- `--profile-input <json>` — select a complete logical profile with typed bindings.
- `--optimization <debug|release|release-with-debug>` — optimization for target shorthand.
- `--release` — shorthand for `--optimization release`.
- `--verify-ir` — on `build` and `run`, audit compiler MIR invariants before emission and the emitted LLVM module before encoding; disabled by default.

Named and complete profiles conflict with target and optimization flags. With no explicit selector,
the project default profile wins, followed by manifest targets and explicit host resolution.
See [compilation profiles](../../apps/docs/content/reference/compilation-profiles.md) for the TOML
schema, binding provenance, and the matching LSP `profile`, `profileInput`, and `target` settings.

## Test

`silk test` compiles every test discovered from the package root, then lets the bundled source
runner apply `--file` and `--filter` selection. Completed passing tests are reused by default through
compiler-issued execution identities; failures always execute again.

```bash
silk test
silk test --root src/tests.silk --file src/parser_tests.silk --filter invalid
silk test --no-cache
```

The summary reports discovered, selected, cached, executed, passed, and failed counts. Result
records live in `test-results-v1` beneath `<build.output-dir>/.silk-cache`. `--no-cache` bypasses all
test-result reads and writes for that invocation without disabling compiler or native-artifact
caches. There is no test watch option.

An execution identity includes compiler-known dependencies and normalized execution configuration;
it is broader than the local authored fingerprint exposed in test metadata. It does not track
arbitrary runtime files, environment variables, network data, time, randomness, or side effects
from earlier tests. Reusing a pass does not replay that test's output or other effects.

Completed test runs return `0` when every selected test passes (including zero selected tests), `1`
for typed test failures, and `2` for runner or cache-exchange operational failures. Abnormal child
termination remains distinct.

## Format

`silk format` formats every exact `.silk` file beneath the project source root. Positional files and
directories restrict the selection; `--check` reports drift without writing. Formatting does not
accept target or profile options.

```bash
silk format
silk format src/model src/Draft.silk
silk format --check
```

The canonical representation uses a 100-column target, two-space indentation, LF endings, no
trailing whitespace, and one final newline. Damaged syntax is reported and left unchanged while
other selected files continue.

## Generate documentation

`silk doc` analyzes the reachable project source closure without invoking a backend, linker, or
program. It writes deterministic, formatter-neutral JSON to `build/documentation.json` by default:

```bash
silk doc
silk doc --output artifacts/api.json
silk doc --include-private
```

Public declarations and public struct fields are included by default. `--include-private` retains
private items with their visibility. The complete model includes module and declaration documents,
first-class parameter/field documentation, compiler-derived signatures, examples, best-effort
semantic links, and logical source provenance. Output is marked experimental and is intentionally
not yet a versioned compatibility contract. Source damage or resolution failures are reported
before the atomic destination write, so no partial JSON is committed.

`silk doctest` compiles fenced Silk examples carried by that JSON. `--source-root` lets reports map
source byte offsets back to one-based lines; `--stdlib` checks compiler-shipped standard-library
documentation instead of a JSON file.

```bash
silk doctest --input build/documentation.json --source-root src
silk doctest --stdlib
```

`silk docs-site` renders the formatter-neutral JSON as a standalone static HTML site with a search
index and the embeddable Silk snippet element:

```bash
silk docs-site --input build/documentation.json --output build/site --title "My library"
silk docs-site --input build/documentation.json --output build/site \
  --snippet-bundle node_modules/@silklang/editor-support/dist/silk-snippet.bundle.js
```

Without `--snippet-bundle`, fenced Silk examples render as static code blocks. Supplying a bundle
adds it to the generated files and upgrades the examples when the site loads.

## Direct-file compilation

`silk build-exe` is the low-level, native-only escape hatch for compiling a rooted source without a
manifest:

```bash
silk build-exe main.silk -o ./main
silk build-exe ./src/app/Main.silk --source-root ./src -o ./main
```

It supports `--source-root`, `--output`/`-o`, native `--target`, `--optimization`, `--profile-input`, `--clang`,
`--save-temps`, `--timings`, and `--verify-ir`.

## Exit behavior

- `0` — every selected target succeeded.
- `1` — at least one source, semantic, entry, or backend-emission rejection occurred.
- `2` — configuration, storage, target preflight, or external toolchain work failed; this takes
  precedence over exit `1` in a mixed batch.
- `silk format` uses `1` for drift/damaged syntax and `2` for project, selection, storage, or write
  failures.
- `silk doc` uses `1` for source rejection and `2` for project, resolution, or destination failure.
- `silk doctest` uses `1` for failing examples and `2` for invalid or unreadable input.
- `silk docs-site` uses `2` for invalid input, unavailable assets, or output failures.
- `silk run` returns the program's exit status after a successful build.

Each target commits atomically. A failed target leaves no partial destination and does not remove a
successful sibling artifact.
