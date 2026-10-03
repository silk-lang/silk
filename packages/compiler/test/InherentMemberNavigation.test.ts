import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Analysis from '../src/Analysis.js'
import { unreachable } from './support/raise.js'
import * as SemanticOccurrence from '../src/SemanticOccurrence.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as SourceSpan from '../src/SourceSpan.js'

const encoder = new TextEncoder()

const other = `pub fn map(value: i32) -> i32 { return value }
`

const main = `import other { map }
pub union Option<T> { None, Some { pub value: T } }
impl<T> Option<T> {
  pub fn some(value: T) -> Self { return Option.Some { value: move value } }
  pub fn map<U>(self: Self, f: once fn(T) -> U) -> Option<U> {
    return match move self {
      Option<T>.Some { value } => Option.some<U>(f(move value))
      Option<T>.None => Option<U>.None
    }
  }
}
fn addOne(value: i32) -> i32 { return value + 1 }
pub fn main() -> i32 {
  let value = Option.some(1)
  let piped = move value |> Option.map(addOne)
  let section = Option.map(addOne)
  let applied = Option<i32>.map(Option.some(2), addOne)
  drop piped
  drop applied
  drop section(Option.some(3))
  return map(0)
}`

/** The navigation claims are frontend facts, so all tests share one target-free snapshot. */
const Navigation = Context.Service<Analysis.FrontendSnapshot>('InherentMemberNavigation/snapshot')

const navigation = Layer.effect(
  Navigation,
  Analysis.make({ root: 'main' }).pipe(
    Effect.provide(
      SourceResolver.memory(
        new Map([
          ['main', encoder.encode(main)],
          ['other', encoder.encode(other)],
        ]),
      ),
    ),
  ),
)

const offsetOf = (source: string, spelling: string, occurrence = 0): number => {
  let offset = -1
  for (let index = 0; index <= occurrence; index += 1) offset = source.indexOf(spelling, offset + 1)
  if (offset < 0) throw new RangeError(`Fixture has no occurrence ${occurrence} of ${spelling}`)
  return offset
}

const identityKeyOf = (occurrence: SemanticOccurrence.SemanticOccurrence | undefined) =>
  occurrence?.resolution._tag === 'Available'
    ? SemanticOccurrence.identityKey(occurrence.resolution.identity)
    : undefined

/** Mirrors the editor's rename: every occurrence sharing the identity and the selected spelling. */
const renameMatches = (
  snapshot: Analysis.FrontendSnapshot,
  key: string,
  spelling: string,
): ReadonlyArray<readonly [string, SourceSpan.SourceSpan]> => {
  const matches: Array<readonly [string, SourceSpan.SourceSpan]> = []
  for (const [module, source] of Analysis.sources(snapshot)) {
    const whole = Option.getOrThrow(SourceSpan.make(source, 0, SourceFile.length(source)))
    const seen = new Set<string>()
    for (const occurrence of Analysis.semanticOccurrencesInRange(snapshot, module, whole)) {
      if (identityKeyOf(occurrence) !== key) continue
      if (Option.getOrUndefined(SourceFile.spelling(source, occurrence.span)) !== spelling) continue
      const at = `${occurrence.span.start}:${occurrence.span.end}`
      if (seen.has(at)) continue
      seen.add(at)
      matches.push([module, occurrence.span] as const)
    }
  }
  return matches
}

const rewrite = (
  source: string,
  spans: ReadonlyArray<SourceSpan.SourceSpan>,
  replacement: string,
): string =>
  [...spans]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (text, span) => `${text.slice(0, span.start)}${replacement}${text.slice(span.end)}`,
      source,
    )

it.layer(navigation)((it) => {
  it.effect('navigates from every call form of an inherent member to its declaration', () =>
    Effect.gen(function* () {
      const snapshot = yield* Navigation
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map(
          (diagnostic) => `${diagnostic.code} ${diagnostic.message}`,
        ),
        [],
      )
      const declarationOffset = offsetOf(main, 'pub fn map<U>') + 'pub fn '.length
      const declaration = Analysis.semanticOccurrenceAt(snapshot, 'main', declarationOffset)
      assert.strictEqual(declaration?.role, 'Declaration')
      assert.strictEqual(declaration?.span.start, declarationOffset)
      assert.strictEqual(declaration?.span.end, declarationOffset + 'map'.length)
      assert.strictEqual(declaration?.declaration?.selectionSpan.start, declarationOffset)
      const key = identityKeyOf(declaration)
      assert.strictEqual(key, 'declaration:main.Option.map')

      const piped = Analysis.semanticOccurrenceAt(
        snapshot,
        'main',
        offsetOf(main, '|> Option.map') + 10,
      )
      assert.strictEqual(piped?.role, 'Value')
      assert.strictEqual(identityKeyOf(piped), key)
      assert.strictEqual(piped?.declaration?.module, 'main')
      assert.strictEqual(piped?.declaration?.selectionSpan.start, declarationOffset)
      assert.strictEqual(piped?.declaration?.selectionSpan.end, declarationOffset + 'map'.length)

      const section = Analysis.semanticOccurrenceAt(
        snapshot,
        'main',
        offsetOf(main, '= Option.map(addOne)') + 9,
      )
      assert.strictEqual(section?.role, 'Value')
      assert.strictEqual(identityKeyOf(section), key)

      // The qualifier still identifies the owner type, not the member.
      const qualifier = Analysis.semanticOccurrenceAt(
        snapshot,
        'main',
        offsetOf(main, '|> Option.map') + 3,
      )
      assert.strictEqual(qualifier?.role, 'Actor')
      assert.strictEqual(identityKeyOf(qualifier), 'declaration:main.Option')

      // The root `map` imported from another module is a different identity.
      const rootCall = Analysis.semanticOccurrenceAt(
        snapshot,
        'main',
        offsetOf(main, 'return map(0)') + 7,
      )
      assert.strictEqual(identityKeyOf(rootCall), 'declaration:other.map')
    }),
  )

  it.effect('resolves an applied-qualifier call to the same member identity', () =>
    Effect.gen(function* () {
      const snapshot = yield* Navigation
      const applied = Analysis.semanticOccurrenceAt(
        snapshot,
        'main',
        offsetOf(main, 'Option<i32>.map') + 12,
      )
      assert.strictEqual(applied?.role, 'Value')
      assert.strictEqual(identityKeyOf(applied), 'declaration:main.Option.map')
    }),
  )

  it.effect('renames exactly the member identifier tokens across every call form', () =>
    Effect.gen(function* () {
      const snapshot = yield* Navigation
      const matches = renameMatches(snapshot, 'declaration:main.Option.map', 'map')
      assert.isTrue(matches.every(([module]) => module === 'main'))
      const renamed = rewrite(
        main,
        matches.map(([, span]) => span),
        'transform',
      )
      assert.strictEqual(
        renamed,
        main
          .replace('pub fn map<U>', 'pub fn transform<U>')
          .replace('|> Option.map(addOne)', '|> Option.transform(addOne)')
          .replace('= Option.map(addOne)', '= Option.transform(addOne)')
          .replace('Option<i32>.map(', 'Option<i32>.transform('),
      )
      // The root `map` in the other module keeps its own identity and spelling.
      assert.deepEqual(
        renameMatches(snapshot, 'declaration:other.map', 'map')
          .map(([module]) => module)
          .sort(),
        ['main', 'main', 'other'],
      )
    }),
  )

  it.effect('indexes the impl head once: its binder declares T and its owner names the union', () =>
    Effect.gen(function* () {
      const snapshot = yield* Navigation
      const head = offsetOf(main, 'impl<T> Option<T>')
      const binder = Analysis.semanticOccurrenceAt(snapshot, 'main', head + 5)
      assert.strictEqual(binder?.role, 'Declaration')
      assert.strictEqual(binder?.resolution._tag, 'Available')
      const binderKey = identityKeyOf(binder)
      assert.isDefined(binderKey)
      assert.strictEqual(binder?.declaration?.selectionSpan.start, head + 5)
      const owner = Analysis.semanticOccurrenceAt(snapshot, 'main', head + 8)
      assert.strictEqual(owner?.role, 'Type')
      assert.strictEqual(identityKeyOf(owner), 'declaration:main.Option')
      const argument = Analysis.semanticOccurrenceAt(snapshot, 'main', head + 15)
      assert.strictEqual(argument?.role, 'Type')
      assert.strictEqual(identityKeyOf(argument), binderKey)
      // A member's use of the owner binder reaches the head's declaration, and the head token is
      // indexed exactly once even though every member carries the binder.
      const use = Analysis.semanticOccurrenceAt(
        snapshot,
        'main',
        offsetOf(main, 'value: T) -> Self') + 7,
      )
      assert.strictEqual(identityKeyOf(use), binderKey)
      assert.strictEqual(use?.declaration?.selectionSpan.start, head + 5)
      const whole = Option.getOrThrow(
        SourceSpan.make(
          Analysis.sources(snapshot).get('main') ?? unreachable('main source'),
          head + 5,
          head + 6,
        ),
      )
      assert.strictEqual(
        Analysis.semanticOccurrencesInRange(snapshot, 'main', whole).filter(
          (occurrence) => occurrence.role === 'Declaration',
        ).length,
        1,
      )
    }),
  )
})
