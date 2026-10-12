import { it } from '@effect/vitest'
import { writeFileSync } from 'node:fs'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Stdlib from '../src/Stdlib.js'

const ascii = (value: string): Uint8Array => new TextEncoder().encode(value)

it.effect('sweep', () =>
  Effect.gen(function* () {
    const found: Array<string> = []
    for (const entry of Stdlib.manifest) {
      const path = entry.module.replaceAll('/', '.')
      const snapshot = yield* Analysis.ofSource(
        `sweep/${entry.module}`,
        ascii(`import ${path}\npub fn main() -> i32 { return 0 }`),
      )
      for (const diagnostic of Analysis.diagnostics(snapshot))
        if (diagnostic.severity === 'error' && diagnostic.span.sourceId !== `sweep/${entry.module}`)
          found.push(`${entry.module} ${diagnostic.code} ${JSON.stringify(diagnostic.span)} ${diagnostic.message}`)
    }
    writeFileSync('/home/user/silk/.scratch/fwd/sweep.txt', `SWEEP ${found.length}\n${found.join('\n')}\n`)
  }),
{ timeout: 1_200_000 })
