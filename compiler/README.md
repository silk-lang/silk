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
silk-replay step=1 kind=trivia module=silk/bytes.silk demands=211352 hits=211338 units-run=14 marked-outdated=14 graph-units=64550 graph-bytes=46662656 rejections=5 update-us=238 check-us=904871
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

With `SILK_REPLAY_RUNS` set, every edit step also writes one `silk-replay-run step=<n> <unit>`
line per unit it ran, such as `Body silk/bytes.Bytes.append`, and one
`silk-replay-stale step=<n> <unit> <- <dependee>` line per outdated unit that failed
verification, naming the first dependee it found changed: another unit, a whole `file`, or an
`input` by its module and selector. Count them to find what an edit fans out through:

```sh
SILK_REPLAY_RUNS=1 silk check ... --replay <script> | grep '^silk-replay-stale step=4 ' | sort | uniq -c
```

For the standard library, assemble `fixtures/stdlib-root` as the `stdlib-root` CI job does and
run `silk check --stdlib <that directory> --replay <checkout>/compiler/fixtures/replay/stdlib.toml`
in it.

### Replay budgets

The `incremental` CI job replays both scripts and checks each step against
`fixtures/replay/budgets.json` with `.github/scripts/check-replay-budgets.mjs`. An edit fails its
budget when it runs more units or marks more outdated than the step allows, or when its demands
exceed the allowed fraction of the initial check's. Those demands are the fixed cost of an
update: the recheck walks every root again and hits nearly every unit it reaches. `update-us` is
capped too, and the compiler script's rejection counts must match. The same job runs the
standard library script with `--differential` and replays every corpus program with
`.github/scripts/replay-corpus.mjs`, which adds a comment to each `main.silk` and removes it again
and requires both stores to agree. The compiler replay runs without `--differential`, since two
compiler stores need more memory than a CI runner has.

The budgets allow twice the measured units (at least 20 more) and one and a half times the
measured demand fraction. When a change moves a step's numbers for a good reason, replay the
script and update its entry. Measured on 2026-10-21, add and delete on 2026-10-22:

| Step | Compiler units | Compiler demands | Stdlib units | Stdlib demands |
| --- | --- | --- | --- | --- |
| initial check | 132,048 | 15,869,737 | 64,550 | 2,185,506 |
| trivia | 3 | 6.8% | 16 | 9.7% |
| body | 2 | 6.8% | 17 | 9.7% |
| header, same type | 7 | 6.8% | 25 | 9.9% |
| add | 9 | 6.4% | 32 | 10.7% |
| header, new type | 6 | 6.8% | 19 | 9.7% |
| delete | 5 | 6.4% | 28 | 10.7% |
| rename | 8 | 6.2% | 176 | 9.9% |

An update marks outdated every unit that consumed a change, directly or through another unit,
and a demand then verifies an outdated unit before it reruns it: the unit stays current when
every dependee it consumed kept its answer, judged by the answer fingerprints. A budgeted
`verified` count is a floor on the units an edit confirms that way. Implementation heads and
members store absolute spans, so an edit that moves an `impl` reruns its heads, but their answers
hash without those spans and their dependers are verified. The units that rerun on a trivia edit
are those heads and MIR lowerings, whose `module:line:column` site labels move with the lines.
A call through a type or a receiver reads the owner's member of its own name (the
`InherentMember` family, a projection of the owner's whole member list), so adding or deleting a
method reruns only the member list and the projections of names that changed. On a 4-core x86_64 machine the
compiler's first check took about 67 s and each edit's recheck 7 to 18 s, almost all of it the
walk over every root.

## Check roots

The language server checks one module or one declaration at a time, through
`Semantic.checkModule` and `Semantic.checkDeclaration`, so an edit refreshes only the
entries it reaches. `silk check --roots` checks the package as usual, then checks each of
its modules again through `checkModule` (plus `Semantic.checkForeignConflicts`) and
compares the two by module, code and span. It writes one
`silk-check-roots only=package|roots <module> <code> <start>-<end>` line per rejection
only one side reached, then `silk-check-roots modules=<count> rejections=<count>
differences=<count>`, and fails the check when they differ.

## Toolchains

Every `silk` is also a version manager. Installed toolchains live in `$SILK_HOME` (default
`~/.silk`):

```text
~/.silk/
  bin/silk                     link to the default toolchain's compiler (install.sh)
  settings.toml                default = "<version>", optional auto-install = true
  toolchains/<version>/bin/silk
  toolchains/<version>/lib/silk/stdlib
```

A command selects a toolchain by the first of these that applies: `silk +<version>`,
`SILK_TOOLCHAIN`, `silk-version` in the nearest `silk.toml` (the workspace that lists the package
first, then the package; `0.0.0` means unpinned), `default` in `settings.toml`, and finally the
running compiler. When the selection is another installed toolchain, `silk` sets
`SILK_TOOLCHAIN` to it and replaces itself with that compiler, which then runs the command. A
compiler never re-executes itself, `SILK_TOOLCHAIN=local` keeps the running compiler, a local
`0.0.0` build follows only `+<version>`, and `silk toolchain` always runs in the compiler you
started. A missing selection exits with status 3 and names the install command, unless
`SILK_AUTO_INSTALL=1` or `auto-install = true` installs it first. For `silk lsp`, so editors that
only spawn the server do not see it crash, a missing selection instead starts a server with no
capabilities that answers `initialize`, shows the message as an error, and exits on `exit`.

`silk toolchain install` downloads `silk-<version>-<target>.tar.gz` and its `.minisig` from the
GitHub release, or from `$SILK_TOOLCHAIN_MIRROR/v<version>/` when set. Installation needs a valid
signature by the release key with the trusted comment `silk v<version> <archive>`, and a
`bin/silk` whose SHA-256 matches the release's `native-seed.json`. The archive is unpacked into a
hidden staging directory under `toolchains/` and renamed into place, so an interrupted install
leaves no half-written toolchain. Network failures exit with status 4 and failed checks with 5.

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
