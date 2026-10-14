# C3 native CLI: progress checkpoint (2026-10-14, evening)

Never merge this branch. It sits on `selfhost-native-cli-stdlib` only to carry this note.

## Merged
- #1672 `silkc run`, #1675 `silkc init`, #1684 `silkc clean`.

## Open draft PRs (stacked, each on the previous)
1. #1687 flags (`--manifest-path`, `--target`, `--release`, project `build`): `selfhost-native-cli-flags` @ `1ab3f5711` (selfhost `72df128` merged in).
2. #1689 named profiles, `--optimization`, `[build].bindings` (parity fix: native ignored them): `selfhost-native-cli-profiles` @ `6936af481`. Adds `driver/ProjectProfile.silk` and `driver/ProjectPlan.silk`.
3. #1699 `--profile-input`: `selfhost-native-cli-profile-input` @ `7b9305680`.
4. #1704 installed stdlib at `<prefix>/lib/silk/stdlib` (realpath FFI): `selfhost-native-cli-stdlib` @ `0222e3618`.

Every head has: a seed self-build, its Cases (ProjectCases, ProjectCommandCases, TargetSelectorCases, CommandPathCases), `test-native-build.ts`, and a TS bootstrap check whose only errors are the 19 known `semantic/BorrowCheck.silk` errors from #1683 (selfhost ≥ c4fbf46, being fixed by the R3 session).

## Exact next step
- Wait for the coordinator's message that the BorrowCheck fix has merged. Then, per PR in stack order: merge selfhost in, re-run the TS bootstrap check (must be clean), dispatch `selfhost.yml` on the head, wait for the green `workflow_dispatch` run including "Bootstrap builds the compiler (T1 DDC)", put the run id in the PR body, mark it ready and message the coordinator.
- After each merge, merge selfhost into the next PR in the stack.

## Tooling notes
- Run Cases from the repository root with absolute roots: `$SILKC test $PWD/compiler/src/driver/<X>Cases.silk -o /tmp/t --stdlib $PWD/packages/compiler/stdlib --no-cache`.
- For a fast check of a driver module, run its Cases root with the seed (~30 s) before the ~12 min self-build.
- A worktree needs `node_modules` and `packages/cli/node_modules` symlinked from the main checkout before it can run `test-native-build.ts`.
