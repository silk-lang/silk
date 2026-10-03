import { assert, it } from '@effect/vitest'
import * as Result from 'effect/Result'
import * as ProjectOptions from '../src/ProjectOptions.js'

it('leaves omitted optimization available for project profile selection', () => {
  assert.deepStrictEqual(ProjectOptions.resolve({ release: false }), Result.succeed({}))
})

it('uses release as a optimization shorthand', () => {
  assert.deepStrictEqual(
    ProjectOptions.resolve({ release: true }),
    Result.succeed({ optimization: 'release' }),
  )
  assert.deepStrictEqual(
    ProjectOptions.resolve({ release: true, optimization: 'release' }),
    Result.succeed({ optimization: 'release' }),
  )
})

it('preserves explicit project selection flags', () => {
  assert.deepStrictEqual(
    ProjectOptions.resolve({
      release: false,
      manifestPath: 'nested/silk.toml',
      targets: ['aarch64-apple-darwin', 'wasm32-unknown-unknown'],
      optimization: 'release-with-debug',
      verifyIr: true,
    }),
    Result.succeed({
      manifestPath: 'nested/silk.toml',
      targets: ['aarch64-apple-darwin', 'wasm32-unknown-unknown'],
      optimization: 'release-with-debug',
      verifyIr: true,
    }),
  )
})

it('rejects a release shorthand that contradicts an explicit optimization', () => {
  const resolved = ProjectOptions.resolve({ release: true, optimization: 'debug' })
  assert.strictEqual(Result.isFailure(resolved), true)
  if (Result.isFailure(resolved)) {
    assert.strictEqual(resolved.failure.reason._tag, 'ConflictingProfile')
  }
})
