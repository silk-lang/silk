import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'

/**
 * `HashMap` and `HashSet` as a program uses them: insert, lookup, removal, the equivalence deciding
 * which entries are one entry, growth that keeps every entry, and a failed growth that keeps the map.
 *
 * Runtime behavior is pinned in the native corpus (`support/corpus.ts`); this file retains the
 * cheapest structured analysis claims.
 */

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const analyzed = (name: string, source: string, target?: string) =>
  AnalysisFixture.retainingMain(name, ascii(source), target)

const messages = (snapshot: Analysis.Snapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.message)

const mapImports = `import silk.hash { Hash }
import silk.hash { HashKey, HashSeed, Word }
import silk.i32
import silk.hash_map { HashMap }
import silk.option { Option }
import silk.u64
import silk.usize`

it.effect('refuses a key type that has no HashKey witness', () =>
  Effect.gen(function* () {
    // The bound is what makes a hashed collection safe to instantiate: a key with no witness has no
    // hash and no equivalence, and the instantiation is reported rather than accepted.
    const snapshot = yield* analyzed(
      'hashed-collections/no-witness',
      `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.hash { Hash }
import silk.hash { HashKey }
${mapImports}

struct Unhashed { tag: i32 }

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut map = HashMap<Unhashed, i32>.make(Hash.seed(1))
  let placed = run HashMap<Unhashed, i32>.insert(&mut map, Unhashed { tag: 1 }, 2)
    |> Effect.provideMut(&mut allocator)
  drop placed
  return 0
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 99 }

pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    )
    assert.deepEqual(messages(snapshot), [
      'Invalid conformance: hashed-collections/no-witness.Unhashed does not implement HashKey',
    ])
  }),
)
