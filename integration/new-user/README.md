# New-user integration tests

These tests use Silk the way someone new to it would. Each one starts from an empty home folder, installs a release with `install.sh`, and then follows the docs: `silk init`, run, check, build, test, format, dependencies, workspaces, toolchains, the language server, and every runnable program in the silk-lang/docs pages.

They check two things. Behavior has to work, and messages have to tell a newcomer what went wrong. A test marked `todo` records a known finding. It runs and reports, but does not fail the suite, so the suite stays green on a release that still has open findings. Remove the `todo` once a fix lands.

CI does not run these tests. They download a release, need Clang, and take a few minutes. Run them by hand against a release, before or after publishing one.

## Running

You need Node 22 or newer, `curl`, `tar`, and Clang 18 or newer on `PATH` (or `SILK_CLANG`). From the repository root:

```sh
node --test 'integration/new-user/*.test.mjs'
```

Run one area with `node --test integration/new-user/workspace.test.mjs`.

| Variable | Effect |
| --- | --- |
| `SILK_RELEASE` | Tag to install, such as `v0.1.0-dev.10+3934b61998da`. Default: whatever `install.sh` picks, as for a new user. |
| `SILK_NEW_USER_INSTALLER` | The `install.sh` to run: a path or an `https://` URL. Default: this repository's `install.sh`. Use `https://raw.githubusercontent.com/silk-lang/silk/main/install.sh` to test the published one. |
| `SILK_NEW_USER_DOCS` | A silk-lang/docs checkout. Without it, `docs.test.mjs` is skipped. |
| `SILK_NEW_USER_RUN_ALL` | `1` also runs docs programs whose output the page does not show, and fails on a crash. |
| `SILK_NEW_USER_MIRROR`, `SILK_NEW_USER_SECOND` | A `SILK_TOOLCHAIN_MIRROR` directory and a full version in it (not the one `install.sh` picks). They enable the tests that install a second toolchain. Without them those tests are skipped. |
| `SILK_NEW_USER_TMP` | Where the throwaway homes go. Default: the system temp folder. |
| `SILK_NEW_USER_TOOL` | A local `silk` tool build to test before a release ships it. After install.sh it is copied to `~/.silk/bin/silk`, as install.sh does. Build it with `--release`: a debug tool takes about 20 s to unpack a toolchain. With the tool present, `toolchain.test.mjs` is skipped and `tool.test.mjs` runs. |
| `SILK_NEW_USER_COMPILER` | A local `silk` binary to run instead of the installed release, through `SILK_TOOLCHAIN=local`, such as a build of main. It must sit at `<dir>/bin/silk` with the stdlib at `<dir>/lib/silk/stdlib`. install.sh still installs the release, so the install and toolchain tests keep testing that. |

`HTTPS_PROXY` and `GITHUB_TOKEN` pass through to the installer.

A mirror holds one `v<version>/` folder per release, with the release's assets: `silk-<version>-<target>.tar.gz`, its `.minisig`, `native-seed.json` and `changes-snapshot.toml`.

## The docs check on its own

`docs-samples.mjs` builds every program in the docs (a ` ```silk ` block with a `main`) as `src/main.silk` of a fresh package. Where the page shows what the program prints, it compares the output. Where the page shows the errors it fails with, it compares code, line, column and message. It also reports which programs `silk format` would change.

```sh
node integration/new-user/docs-samples.mjs ../docs [--filter book/07] [--run-all] [--release] [--json results.json]
```

`--run-all` also runs programs whose output the page does not show, and flags crashes. `--release` runs every program in debug and release too, and flags any difference (`release-differs`).

Excerpts that lean on the rest of the page are retried with the page's imports. Labelled files (`` `src/helper.silk`: ``, `` `silk.toml`: ``) become part of the same package. The few programs that need more than that, such as a C object or a running server, are listed in `contextual` with the reason.

## Files

| File | Covers |
| --- | --- |
| `install.test.mjs` | `install.sh`: layout, default, reinstall, bad tag and channel |
| `tool.test.mjs` | The silk tool: `silk use`, `use list`/`which`/`uninstall`, `silk set`, `+version`, forwarding to silkc, exit 3 and the editor message for a missing pin, `silk update` |
| `targets.test.mjs` | Targets and profiles: `--target`, cross-target objects, release and named profiles, `cpu.features`, static linking, every refused profile field and combination, `--profile-input`, a wasm32 module under node |
| `params.test.mjs` | Package parameters: defaults, `where`, project and profile bindings and their precedence, declaration and binding errors, `static if` on a parameter |
| `toolchain.test.mjs` | `silk toolchain`, pins, exit 3 for a missing pin, `+version`, auto-install, `latest` and `dev` |
| `project.test.mjs` | `silk init`, run with arguments and exit status, check, build, clean, format, `silk add` and `silk remove`, modules, runtime traps, CLI messages |
| `testing.test.mjs` | `silk test`: passing, failing and trapping tests, `--filter` |
| `workspace.test.mjs` | Workspaces: init, build order, `-p`, test summary, format, doc, clean, manifest mistakes |
| `diagnostics.test.mjs` | Common first-program mistakes and the error each gets, and `silk check --json` |
| `lsp.test.mjs` | `silk lsp` as an editor starts it: diagnostics, hover, definition, completion, formatting, symbols, a missing toolchain |
| `docs.test.mjs` | `docs-samples.mjs` as a test, one subtest per program, plus the guides whose blocks make one whole program, built in debug and release |
| `stability.test.mjs` | Parser and typing corners, symbolic links, dependency diamonds, and warm rebuilds after edits matching clean builds |

## Fuzzers

`fuzz/` holds tools for the stability rounds. They are not tests: run them by hand, with the `silk` you want to test first on PATH (or `SILK_TOOLCHAIN` naming an installed local build).

| Tool | Does |
| --- | --- |
| `fuzz/compare.sh <generator> <seed> <dir>` | Generates a program and its expected output with a generator below, runs it in debug and release, and prints `MISMATCH` for any difference |
| `fuzz/arithmetic.py` | i64 arithmetic, comparisons, loops, arrays, structs and helper functions, with a Python reference |
| `fuzz/collections.py` | Random operations on `HashMap`, `HashSet` and `List`, with a Python model |
| `fuzz/trees.py` | Expression trees in `Box`-based unions, evaluated by reference, by a `mut fn` visitor and by consuming the tree, with a Python reference |
| `fuzz/format-roundtrip.sh <package> <dir>` | Formats a copy of a package that checks clean, then checks the result is stable, still checks, and runs with the same output |
| `fuzz/numfmt/run.sh <seed> <dir>` | Prints the same values with the same format specs from Silk and from Rust (`rustc` needed), and reports any line that differs |
| `fuzz/hashes/` | Every hash and HMAC in the stdlib against Python's hashlib, on 326 input sizes fed in uneven pieces (build `main.silk`, then `diff.sh <binary>`) |
| `fuzz/json/`, `fuzz/toml/` | `main.silk` parses standard input and writes it back; `drive.py <binary> <seed> <count>` sends random and broken documents and compares with Python's json or tomllib |
| `fuzz/inflate/`, `fuzz/zstd/` | `main.silk` decodes standard input (one leading format byte) in uneven pieces; `drive.py <binary> <seed> <count>` sends streams and corrupted copies from Python's zlib or the `zstandard` package (`pip install zstandard`) and compares |
| `fuzz/paths/` | `drive.py <binary> <seed> <count>` checks `Path.fromBytes`, `joinBytes`, `resolve` and `parent` against a model of the documented rules |
| `fuzz/process/main.silk` | Child process cases: 40 MB of output on both pipes, odd arguments, an empty environment, signals, a closed stdout, 500 spawns |
| `fuzz/http/attack.py` | Normal, odd and hostile requests against the guide 10 server on port 18080 (build it from the guide with `serve(18080, 100000)`), checking that it answers and stays up |
| `fuzz/http-client/` | `server.py` answers each path on 127.0.0.1:18081 with a scripted, sometimes broken, response; `main.silk` reads a base line, a bundle line, then one URL per line from standard input and prints what `NativeHttp` made of each |
| `fuzz/huge-sources.py <dir>` | Huge and malformed sources (deep nesting, 30,000 lets, binary garbage, a BOM); flags crashes and timeouts |
| `node fuzz/lsp-edits.mjs <package> <seed> <steps> [burst]` | Random edits to the package's `src/main.silk` in `silk lsp`, with hover, completion, definition, symbols and formatting after each; compares diagnostics with `silk check` |
| `node fuzz/lsp-modules.mjs <empty dir> <seed> <steps>` | Writes a three-module package, then makes random edits to the two imported modules in `silk lsp` and checks every open file's diagnostics against `silk check` (`LSP_TRACE=1` prints each publish). Like the tests, it runs the `silk` on PATH under `$HOME/.silk/bin` unless `SILK_NEW_USER_COMPILER` is set |
| `node fuzz/lsp-typing.mjs <package> <file to type> [start file with @@]` | Types a file into `silk lsp` one character at a time, as an editor does (an incremental change per key, a completion request after each identifier character), at the `@@` marker of the start file. Prints the slowest completion and hover, and whether the final diagnostics match `silk check`. Set `SILK_NEW_USER_COMPILER` as for the tests |
| `python3 -I fuzz/incremental.py <empty dir> <seed> <steps> [modules]` | Random edits to a multi-module package (constants, bodies, a struct field read across modules, the import graph, renames, whitespace, comments, an unchanged rewrite, a type error fixed next step), an incremental `silk build` after each, compared with a Python model and every 10 steps with a clean build. `-I` keeps `fuzz/collections.py` from shadowing the standard library |

For example, 100 arithmetic programs, three at a time:

```sh
seq 1 100 | xargs -P3 -I{} integration/new-user/fuzz/compare.sh integration/new-user/fuzz/arithmetic.py {} /tmp/fuzz
```
