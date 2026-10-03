import { availableParallelism } from 'node:os'
import { defineConfig, mergeConfig, type ViteUserConfig } from 'vitest/config'

/**
 * Workspace-wide test defaults.
 *
 * Every package that runs Vitest extends this file, so the numbers below are decided once for the
 * workspace rather than rediscovered by each package after it has turned someone else's pull
 * request red. `scripts/test-config-coverage.test.mjs` fails the gate if a package with tests
 * stops extending it.
 */

/**
 * Vitest's default is 5 s, which is a budget for a test that does arithmetic, not for one that
 * drives a compiler. Two of the flaky-CI issues on this repo (#147, #173) were a test whose real
 * cost was well inside 5 s locally and outside it on a loaded shared runner: `packages/cli`
 * measured an amplification of ~57x between an idle machine and a contended one, and
 * `packages/lsp`'s slowest test runs 2.3 s locally, which needs only a 2.2x amplification to be
 * reported as a timeout rather than as a result.
 *
 * The floor is 60 s because 30 s was measured to be too low, not because 60 is a round number.
 * `pnpm check` saturates the runner end to end — the compiler suite alone is ~2,580 s of test CPU
 * on a 4-core host — and at that saturation the slowest tests in `packages/compiler` legitimately
 * run 30–38 s: `StackVmPressureDeterminism` 37.6 s and `LexerPressureDeterminism` 30.3 s. Those
 * pass only because each carries an explicit timeout; `ChildProcess.test.ts > lowers the native
 * execution to reachable native-only runtime symbols` carries none, inherited a 30 s floor, and
 * was reported as a timeout on CI. A floor a test in the workspace already exceeds is not a floor.
 * 60 s also matches the value `packages/cli` arrived at independently from its own measurement.
 *
 * This is not a performance gate and nothing here asserts how fast anything is. It exists so that
 * a correctness assertion is never reported as a timeout. The cost of raising it is that a test
 * that genuinely hangs takes a minute to say so, which is the trade `packages/cli` had
 * already accepted for the same reason.
 */
export const testTimeout = 60_000

/**
 * Every core, for the one package that has a reason to ask for them. Not a default — see below.
 */
export const wholeMachineWorkers = Math.max(1, availableParallelism())

/**
 * Deliberately absent from the defaults below: a per-suite worker count.
 *
 * Vitest's own default is already derived from the host — `availableParallelism() - 1` — and the
 * subtracted core is not an accident. It leaves something for the OS, the Turbo and pnpm
 * supervisors, and the I/O a test does outside its worker. An earlier revision of this file set
 * every package to the full core count and CI got worse, not better: `packages/cli` had
 * been running on vitest's default, the override took its spare core away, and its watcher test —
 * which asserts that a 200-file non-atomic write burst is never read mid-truncate, and so depends
 * on its own writer being schedulable — started failing (#177).
 *
 * What has to be bounded is how many suites run at once, and that is `scripts/concurrency.mjs`.
 * How many workers one suite uses is vitest's business, and vitest already scales it with the host.
 */
export const silkTestDefaults = {
  testTimeout,
  hookTimeout: testTimeout,
} as const

/** Extend the workspace defaults with whatever a package genuinely needs on top of them. */
export const defineSilkConfig = (overrides: ViteUserConfig = {}): ViteUserConfig =>
  mergeConfig(defineConfig({ test: { ...silkTestDefaults } }), defineConfig(overrides))

export default defineSilkConfig()
