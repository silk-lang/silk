# C3 native CLI: progress checkpoint (2026-10-14)

This is ticket C3: the native `silkc` grows the project-level commands of the TypeScript CLI
(`packages/cli`). Each item is one PR against `selfhost`, and the branch prefix is `selfhost-native-cli-`.
This file is self-contained for someone who only has GitHub access.

## State per item

1. **`silkc run`.** Done. PR #1672 is merged into selfhost. Its T1 DDC, run 38573039547, was green.
2. **`silkc init`.** PR #1675 is a draft. Its branch `selfhost-native-cli-init` is rebased onto selfhost `3a8ae4877` (after S3 #1674), at head `a5eb62e65`.
   - No T1 DDC has run on it yet. Run 38579301820 is a `pull_request` run, and those skip the DDC.
   - A native N1 self-build of this head with the seed succeeded (exit 0). A local TypeScript-bootstrap check of it was interrupted (exit 130, no output), so there is no bootstrap verdict yet.
3. **`silkc clean`.** The branch `selfhost-native-cli-clean` (commit "Add silkc clean ...") is based on the *old* init commit `0e74b0ac0`. No PR yet; the PR body draft is below.
   - Self-build smoke and the `test-native-build.ts` clean check have NOT run on this commit yet. Only the `ProjectCommandCases` and `ProjectCases` Cases passed.
4. **Manifest and project flags.** Work in progress on `wip/selfhost-native-cli-flags-checkpoint` (never merge). It sits on top of the clean commit:
   - `driver/ProjectCommand.silk`: shared `Options` (`--manifest-path`, repeatable `--target`, `--release`, `--stdlib`) for `run` and project `build`, plus `clean --manifest-path`.
   - `driver/TargetSelector.silk`: `host` or a canonical name, resolved in order and deduplicated. Has `TargetSelectorCases`.
   - `driver/Project.silk`: `[build].targets`, with validation.
   - `driver/ModuleSources.silk`: `makeInPackage(source, manifest, ...)`, so `--manifest-path` builds with exactly that manifest. `make` still discovers the manifest upward.
   - `main.silk`: project-level `silkc build` (no source file) builds each target, prints `build llvm/<target>: ok|failed` and a `Build summary`, and aggregates status as 2 > 1 > 0. `run` takes `--target` (the first must be the host) and `--release`. The README is updated.
   - The Cases `ProjectCases`, `ProjectCommandCases` and `TargetSelectorCases` passed with an older self-built compiler.
   - `main.silk` has NOT been compiled yet: no self-build, no smoke, no TS bootstrap check.
   - Still to do in item 4:
     - (a) Finish, check and split out a clean PR for the flags above.
     - (b) Locate the stdlib relative to the installed compiler. A draft is in `WIP-drafts/InstalledCompiler.silk` (`realpath` FFI; layout `<prefix>/bin/silkc` beside `<prefix>/lib/silk/stdlib`). Explicit `--stdlib` stays.
     - (c) `--profile <name>` and named `[profiles.*]` with `[build].profile` and bindings, as in TS `ProjectProfile.ts`. The native side has `InitialProfile.Input` and `ProfileBinding.Supplied` to build on.

## Exact next action

1. On `selfhost-native-cli-init` (`a5eb62e65`), run the TS bootstrap check (below). It must report no errors; watch for the OWN0012/OWN0019 failures that broke another agent's DDC.
2. Then `gh workflow run selfhost.yml --ref selfhost-native-cli-init`. Wait for the `workflow_dispatch` run on that head to pass, mark #1675 ready, and `gh pr merge 1675 --merge`.
3. Rebase clean: `git rebase --onto origin/selfhost 0e74b0ac0 selfhost-native-cli-clean`. Self-build, run the Cases and `test-native-build.ts`, open the PR with the body below, run the TS check and the DDC, then merge.
4. Rebase the checkpoint onto the merged clean, and continue item 4 as listed above.

## How to check things (recreate the local tooling)

- **LLVM 22:** put its `bin` on `PATH` and set `SILKC_CLANG=<llvm>/bin/clang`.
- **Self-build** (about 4 min on 16 cores, about 10 GB RAM). `WIP-drafts/selfbuild.sh` is a copy of the script:
  ```sh
  # selfbuild.sh <worktree> <output>
  cd "$1" && <seed-silkc> build "$1/compiler/src/main.silk" -o "$2" \
    --stdlib "$1/packages/compiler/stdlib" --optimization speed > "$2.log" 2>&1; echo "exit $?" >> "$2.log"
  ```
  `<seed-silkc>` is any recent native compiler, such as the pinned seed in `compiler/native-seed.json`.
- **Focused Cases:** from `compiler/`, run `$SILKC test src/driver/<Name>Cases.silk -o /tmp/t --stdlib $PWD/../packages/compiler/stdlib --no-cache`. The files are `ProjectCases`, `ProjectCommandCases`, `ProjectInitializerCases` and `TargetSelectorCases`. All of them are imported by `src/M1Cases.silk`, which is the CI root.
- **CLI smoke** (the existing CLI tier): `node compiler/scripts/test-native-build.ts <built-silkc> <clang>` after `pnpm install --frozen-lockfile`. It covers run, init and (on the clean branch) clean.
- **TS bootstrap check:** first `pnpm --filter @silklang/cli... run build`, then:
  ```sh
  cd compiler
  NODE_OPTIONS=--max-old-space-size=12288 node ../packages/cli/dist/bin.js check --manifest-path silk.toml --target x86_64-unknown-linux-gnu
  ```
  Run it in a worktree you don't switch branches in. The DDC itself runs `build --manifest-path silk.toml --release --target x86_64-unknown-linux-gnu` with the synced bootstrap.

## Decisions (for review)

- `run` replaces the process with `execv` (`driver/ProcessImage.silk`, compiler-local FFI like `CompilerBug.silk`; no new intrinsic). `silk.child_process` closes stdin, empties the environment and captures output, so it cannot match TS `silk run`, which inherits stdio and the environment.
- `init` writes `src/main.silk`, as the TS initializer does. The ticket text said `src/Main.silk`.
- The project `build`'s non-host targets and library artifacts fail per target, because native silkc links executables only for the host. Revisit after B8's `--emit object|static-library|shared-library` lands.

## Clean PR body draft

Ticket C3, item 3. `silkc clean [--manifest-path]` (the flag comes with item 4) removes `[build].output-dir` recursively and prints `Removed <dir>`. An absent output directory gives status 0; a missing, unreadable or invalid manifest, or a failed removal, gives status 2 with the TS wording. Manifest discovery and read failures, for `run` too, now use the TS wording with status 2 instead of escaping as file errors with status 1. Evidence: the Cases, plus `test-native-build.ts` (`clean` after `run`, then again).
