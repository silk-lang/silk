# Native CLI parity with the TypeScript CLI

The native compiler replaces the TypeScript CLI (`packages/cli`, binary `silk`) once it covers
what users run on Linux x86-64, Linux ARM64 and macOS arm64. This table lists every surface
difference that matters for that independence. Status is one of: **done**, **PR #n** (open),
**needed** (missing, needed), or **not needed** (with the reason). WebAssembly and other targets
are follow-ups, so their surfaces are not needed here.

Snapshot: 2026-10-14, selfhost `54303d8`, with PRs #1687, #1689, #1699 and #1704.

## Commands

| TS command                                                                                                                                              | Native                                                                                         | Status                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [path] [--name]`                                                                                                                                  | `init`                                                                                         | done (#1675)                                                                                                                                                                                                |
| `build` (project)                                                                                                                                       | `build` without a source file                                                                  | PR #1687                                                                                                                                                                                                    |
| `run [-- args]`                                                                                                                                         | `run`, replacing the process with `execv`                                                      | done (#1672); flags in PR #1687                                                                                                                                                                             |
| `clean`                                                                                                                                                 | `clean`                                                                                        | done (#1684); `--manifest-path` in PR #1687                                                                                                                                                                 |
| `check` (analysis without artifacts, per target)                                                                                                        | none                                                                                           | needed: the DDC and users run it                                                                                                                                                                            |
| `test` (project: `--root`, `--file`, `--filter`, cached results)                                                                                        | `test <root> -o <exe> --no-cache` (file root, uncached)                                        | needed: project mode and flags; result cache (TEST-008) is a separate gap                                                                                                                                   |
| `format [paths] [--check]`                                                                                                                              | `format [paths] [--check]`                                                                     | done; `--manifest-path` needed                                                                                                                                                                              |
| `build-exe <source> -o` (`--source-root`, `--target`, `--optimization`, `--profile-input`, `--platform-supply`, `--clang`, `--save-temps`, `--timings`) | `build <source> -o` (`--emit`, `--target`, `--optimization`, `--debug`, `--stdlib`, `--stats`) | done for the core; `--clang` and `--platform-supply` needed (see Toolchain); `--source-root` needed; `--save-temps`/`--timings` not needed (diagnostics for compiler development, `--stats` covers timings) |
| `doc [-o] [--include-private]`                                                                                                                          | none                                                                                           | needed (documentation pipeline), lower priority                                                                                                                                                             |
| `doctest`                                                                                                                                               | none                                                                                           | needed (documentation pipeline), lower priority                                                                                                                                                             |
| `docs-site`                                                                                                                                             | none                                                                                           | needed (documentation pipeline), lower priority                                                                                                                                                             |
| `--version`, `--help`                                                                                                                                   | none (taken as a source path)                                                                  | needed, small                                                                                                                                                                                               |

## Project flags

| Flag                                                             | Status                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `--manifest-path`                                                | PR #1687 (`build`, `run`, `clean`); also needed on `test`, `check`, `format`                         |
| `--target <host\|id>` (repeatable)                               | PR #1687                                                                                             |
| `--release`, `--optimization debug\|release\|release-with-debug` | PR #1687, PR #1689                                                                                   |
| `--profile`, `--profile-input`                                   | PR #1689, PR #1699                                                                                   |
| `--verify-ir`                                                    | not needed: an internal audit of the TS lowering; native MIR verification runs in its own test tiers |
| `--trace`                                                        | not needed: exports Effect traces of the TS implementation                                           |
| `--watch`                                                        | needed, low priority (convenience)                                                                   |

## Manifest (`silk.toml`)

| Key                                                      | Status                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `[package] name`, `root`                                 | done                                                                     |
| `[package] version` (semver, required by TS)             | needed: native accepts a missing or invalid version; validate as TS does |
| `[build] targets`, `profile`, `bindings`, `[profiles.*]` | PR #1687, PR #1689                                                       |
| `[build] output-dir`, `artifact`, `stage`                | done (non-host executables and libraries wait for B8)                    |
| `[build] composition`, `native-link-inputs`              | done                                                                     |
| `[build] native-bindings`                                | needed: native ignores it                                                |
| `[build] platform-supply`                                | needed for macOS (SDK selection); native reads only `SDKROOT`            |
| Unknown `[build]` keys refused (TS)                      | needed: native ignores unknown keys                                      |

## Environment and toolchain

| Item                                                  | Status                                                                                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Clang                                                 | needed: TS runs `clang` from `PATH` (or `--clang`); native runs `SILKC_CLANG` or else `/usr/bin/clang`, which on Linux is rarely LLVM 22 |
| `SDKROOT`, `DEVELOPER_DIR` and SDK discovery on macOS | needed: TS resolves the SDK through `platform-supply`/`xcrun`; native needs `SDKROOT` set                                                |
| `SILK_NATIVE_CACHE_DIR`                               | not needed: the TS native artifact cache; native caching belongs to the incremental design                                               |
| `SILKC_CLANG`                                         | native-only override; keep, or rename with the binary                                                                                    |

## Exit codes and output

| Item                                                                                       | Status                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 0 success, 1 refused build or usage error, 2 operational failure, program status for `run` | done (usage errors exit 1 in both)                                                                                     |
| Project build lines (`build llvm/<t>: ok …`, `Build summary`)                              | PR #1687                                                                                                               |
| `Compiled <src> -> <artifact> (llvm, <target>, N symbols)` before `run`                    | needed, small                                                                                                          |
| Diagnostics: `path:line:col: error[CODE] message` with the TS codes and catalog wording    | needed, largest gap: native prints `SILK_BUILD_ERROR={json}` lines with internal codes and no source positions as text |
| Manifest and profile refusals (`Invalid Silk project manifest …`, `<code>: <subject>`)     | done / PR #1689                                                                                                        |

## Install layout

| Item                                                         | Status                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Binary name `silk` (TS npm bin)                              | needed: native is still `silkc`; Julia decided on one `silk` binary                |
| Standard library without `--stdlib`                          | PR #1704 (`<prefix>/lib/silk/stdlib` beside `<prefix>/bin`); TS embeds its library |
| Release archive with `bin/` and `lib/silk/stdlib` per target | needed: no packaging step produces the layout yet                                  |
