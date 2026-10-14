// Compile-time receipt replay. Build packages/compiler first; this never generates or runs code.
import { deepStrictEqual } from 'node:assert'
import * as Effect from 'effect/Effect'
import * as Analysis from '../../../packages/compiler/dist/Analysis.js'
import receipt from './outside-owner-cases.json' with { type: 'json' }

const replay = Effect.fn('R3.replayOutsideOwners')(function* () {
  const results = []
  for (const entry of receipt.cases) {
    const snapshot = yield* Analysis.ofSource(
      `r3/${entry.name}`,
      new TextEncoder().encode(entry.source),
    )
    const actual = Analysis.diagnostics(snapshot).map(({ code, span }) => ({
      code,
      start: span.start,
      end: span.end,
      text: entry.source.slice(span.start, span.end),
    }))
    results.push({ name: entry.name, diagnostics: actual })
  }
  return results
})

const actual = await Effect.runPromise(replay())
deepStrictEqual(
  actual,
  receipt.cases.map(({ name, diagnostics }) => ({ name, diagnostics })),
)
await Effect.runPromise(
  Effect.log(`${receipt.cases.length} compile-time Cases match code/span receipts`),
)
