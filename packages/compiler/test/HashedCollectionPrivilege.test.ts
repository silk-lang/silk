import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Intrinsic from '../src/Intrinsic.js'
import * as MirVerification from '../src/MirVerification.js'

/**
 * No engine contains a hash operation.
 *
 * `HashMap` is ordinary library source over `Allocator` and typed storage, and every hash a program
 * computes is a call to a function some witness declared in Silk. That is a constraint on the
 * compiler rather than on the collections, so it is checked where a violation would appear: in the
 * catalogue of operations the compiler provides, and in the MIR of a program that really uses a map.
 *
 * The catalogue check is the wider of the two. An engine can only gain a primitive by an intrinsic
 * being declared, and semantic analysis, TIR, MIR, and LLVM lowering all draw from that one
 * catalogue — so a catalogue with no hash in it is several
 * statements at once, and it would fail on the first commit that added one anywhere.
 */

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const analyzed = (name: string, source: string) =>
  AnalysisFixture.retainingMain(name, ascii(source))

/** A program that inserts, grows, looks up and removes, so the whole map is lowered, not a corner. */
const usingAMap = `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.i32
import silk.hash { Hash }
import silk.hash { HashKey, HashSeed, Word }
import silk.hash_map { HashMap }
import silk.option { Option }

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut map = HashMap<Word, i32>.make(Hash.seed(12345))
  let mut key = 0
  while key < 20 {
    let previous = run HashMap<Word, i32>.insert(&mut map, Hash.word(i32.toU64(key)), key)
      |> Effect.provideMut(&mut allocator)
    drop previous
    key = key + 1
  }
  let taken = HashMap<Word, i32>.remove(&mut map, Hash.word(3))
  let removed = Option<i32>.unwrapOr(move taken, -1)
  if removed != 3 { return 1 }
  if !HashMap<Word, i32>.contains(&map, Hash.word(4)) { return 2 }
  let held = Option<i32>.unwrapOr(HashMap<Word, i32>.get(&map, Hash.word(4)), -1)
  if held != 4 { return 3 }
  return 42
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 99 }

pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`

/** A name that would betray a hash operation whatever it was called. */
const hashing = /hash|digest|fnv|murmur|siphash|checksum|crc/i

it.effect('computes every hash as an ordinary call to a witness’s own Silk function', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed('hashed-privilege/map', usingAMap)
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.mirOf(snapshot)
    assert.strictEqual(mir._tag, 'Available')
    if (mir._tag !== 'Available') return

    // The witness is a function of the standard library's own module, lowered like any other Silk
    // function — so it has a body in the MIR rather than being a name the backend recognizes.
    const lowered = mir.value.functions.map((fn) => `${fn.id.module}.${fn.id.name}`)
    assert.include(lowered, 'silk/hash.wordHash', `lowered functions: ${lowered.join(', ')}`)
    assert.include(lowered, 'silk/hash.Hash.mix')

    // The selected witness call still names that ordinary source body at the runtime boundary.
    const calls = mir.value.functions
      .flatMap(MirVerification.operations)
      .flatMap((operation) =>
        operation._tag === 'Call' ? [`${operation.target.module}.${operation.target.name}`] : [],
      )
    assert.include(calls, 'silk/hash.wordHash')

    // The collection itself is library source too, lowered from `hash_map.silk`.
    assert.isTrue(
      lowered.some((name) => name.startsWith('silk/hash_map.')),
      `no HashMap function was lowered: ${lowered.join(', ')}`,
    )
  }),
)

it('provides no hash operation to any engine', () => {
  // Every intrinsic the compiler declares, by the spelling a program would write. An engine cannot
  // implement an operation the catalogue does not name, so this one assertion covers analysis, the
  // TIR, MIR, and LLVM lowering.
  const spellings = Intrinsic.all().flatMap((actor) =>
    actor.operations.map((operation) => `${actor.spelling}.${operation.spelling}`),
  )
  assert.isAbove(spellings.length, 0, 'the catalogue was read')
  assert.deepEqual(
    spellings.filter((spelling) => hashing.test(spelling)),
    [],
  )
})
