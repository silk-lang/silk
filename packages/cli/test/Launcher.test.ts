import { NodeServices } from '@effect/platform-node'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Launcher from '../src/Launcher.js'

const launch = (overrides: Partial<Launcher.Launch> = {}): Launcher.Launch => ({
  executable: process.execPath,
  executableArguments: [],
  script: '/silk/cli.mjs',
  arguments: ['build', '--release'],
  nodeOptions: '',
  ...overrides,
})

it('keeps a semi-space size chosen on the command line or in NODE_OPTIONS', () => {
  assert.isFalse(Launcher.configured(launch({ nodeOptions: '--max-old-space-size=8192' })))
  assert.isTrue(Launcher.configured(launch({ executableArguments: ['--max-semi-space-size=64'] })))
  assert.isTrue(
    Launcher.configured(
      launch({ nodeOptions: '--max-old-space-size=8192 --max-semi-space-size 32' }),
    ),
  )
})

it('relaunches the same invocation with the sized young generation first', () => {
  const relaunched = Launcher.relaunchArguments(
    launch({ executableArguments: ['--enable-source-maps'] }),
  )
  assert.deepStrictEqual(relaunched, [
    `--max-semi-space-size=${Launcher.semiSpaceMegabytes}`,
    '--enable-source-maps',
    '/silk/cli.mjs',
    'build',
    '--release',
  ])
})

it.effect('returns the relaunched process status under the sized young generation', () =>
  Effect.gen(function* () {
    const status = yield* Launcher.relaunch(
      launch({
        executableArguments: ['-e'],
        script: `process.exit(process.execArgv.includes('--max-semi-space-size=${Launcher.semiSpaceMegabytes}') ? 42 : 1)`,
        arguments: [],
      }),
    )
    assert.strictEqual(status, 42)
  }).pipe(Effect.provide(NodeServices.layer)),
)
