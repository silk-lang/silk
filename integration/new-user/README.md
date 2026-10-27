# New-user integration tests

These tests use Silk the way someone new to it would. Each one starts from an empty home folder, installs a release with `install.sh`, and then follows the docs: `silk init`, run, check, build, test, format, dependencies, workspaces, toolchains, the language server, and every runnable program in the silk-lang/docs pages.

They check two things. Behavior has to work, and messages have to tell a newcomer what went wrong. A test marked `todo` records a known finding. It runs and reports, but does not fail the suite, so the suite stays green on a release that still has open findings. Remove the `todo` once a fix lands.

CI does not run these tests. They download a release, need Clang, and take a few minutes. Run them by hand against a release, before or after publishing one.

## Running

You need Node 22 or newer, `curl`, `tar`, and Clang 22 or newer on `PATH` (or `SILK_CLANG`). From the repository root:

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
| `SILK_NEW_USER_COMPILER` | A local compiler to run instead of the installed release, such as a build of main. It must sit at `<dir>/bin/silkc` with the stdlib at `<dir>/lib/silk/stdlib`. Each home gets a copy as the version `0.0.0-local`, selected with `SILK_TOOLCHAIN`. install.sh still installs the release, so the install and toolchain tests keep testing that. |
| `SILK_NEW_USER_TOOL` | A local `silk` tool to run instead of the one install.sh installs, such as a build of `tool/`. |

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
| `install.test.mjs` | `install.sh`: the tool and toolchain layout, default, reinstall, bad tag and channel |
| `toolchain.test.mjs` | `silk use` and `silk set`, pins, exit 3 for a missing pin, `+version`, auto-install, `latest` and `dev` |
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
| `fuzz/huge-sources.py <dir>` | Huge and malformed sources (deep nesting, 30,000 lets, binary garbage, a BOM); flags crashes and timeouts |
| `node fuzz/lsp-edits.mjs <package> <seed> <steps> [burst]` | Random edits to the package's `src/main.silk` in `silk lsp`, with hover, completion, definition, symbols and formatting after each; compares diagnostics with `silk check` |

For example, 100 arithmetic programs, three at a time:

```sh
seq 1 100 | xargs -P3 -I{} integration/new-user/fuzz/compare.sh integration/new-user/fuzz/arithmetic.py {} /tmp/fuzz
```
