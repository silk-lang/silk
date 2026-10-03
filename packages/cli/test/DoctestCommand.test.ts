import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as DoctestCommand from '../src/DoctestCommand.js'

/**
 * What only the command owns: reading a documentation JSON file, resolving module sources under a
 * root so a failure carries a line, and turning the run into an exit status.
 */

const module = `//! A project.

/// Documented.
///
/// \`\`\`silk
/// pub fn main() -> i32 { return missing() }
/// \`\`\`
pub fn documented() -> i32 { return 0 }
`

const fenceOffset = new TextEncoder().encode(module.slice(0, module.indexOf('/// ```'))).length
const fenceLine = module.slice(0, module.indexOf('/// ```')).split('\n').length

const documentation = {
  schema: 'silk-documentation',
  experimental: true,
  modules: [
    {
      name: 'project/main',
      sourceId: 'project/main',
      items: [
        {
          id: 'project/main::documented',
          kind: 'Function',
          name: 'documented',
          visibility: 'Public',
          signature: { text: 'pub fn documented() -> i32' },
          documentation: {
            blocks: [
              {
                _tag: 'CodeBlock',
                language: 'silk',
                value: 'pub fn main() -> i32 { return missing() }',
                example: true,
                source: { sourceId: 'project/main', start: fenceOffset, end: fenceOffset + 1 },
              },
            ],
          },
          children: [],
        },
      ],
    },
  ],
}

const project = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'silk-docgen-doctest-'))
  mkdirSync(join(root, 'src', 'project'), { recursive: true })
  writeFileSync(join(root, 'src', 'project', 'main.silk'), module)
  writeFileSync(join(root, 'documentation.json'), JSON.stringify(documentation))
  return root
}

it.effect(
  'exits non-zero for a failing example and resolves its line under the source root',
  () =>
    Effect.gen(function* () {
      const root = project()
      try {
        assert.strictEqual(
          yield* DoctestCommand.run({
            input: join(root, 'documentation.json'),
            sourceRoot: join(root, 'src'),
          }),
          1,
        )
        // The line comes from the module on disk, so the root really was consulted.
        assert.isAbove(fenceLine, 1)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
)

it.effect('refuses an input that is missing, malformed, or absent altogether', () =>
  Effect.gen(function* () {
    const root = project()
    try {
      assert.strictEqual(yield* DoctestCommand.run({ input: join(root, 'absent.json') }), 2)
      const malformed = join(root, 'malformed.json')
      writeFileSync(malformed, '{ not json')
      assert.strictEqual(yield* DoctestCommand.run({ input: malformed }), 2)
      assert.strictEqual(yield* DoctestCommand.run({}), 2)
      assert.strictEqual(yield* DoctestCommand.run({ stdlib: true, input: malformed }), 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }).pipe(Effect.provide(NodeServices.layer)),
)

// `--stdlib` is deliberately not exercised here. The `documentation:examples` script runs
// `silk doctest --stdlib` over the whole shipped standard library in CI, which covers this branch
// and `Stdlib.documentation` on the real manifest.
