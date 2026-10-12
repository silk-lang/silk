import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import type * as DeclarationFacts from '../src/DeclarationFacts.js'
import type * as DeclarationIndex from '../src/DeclarationIndex.js'
import * as ModuleClosure from '../src/ModuleClosure.js'
import * as NameResolution from '../src/NameResolution.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Type from '../src/Type.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const collect = (
  rootModule: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Effect.Effect<DeclarationIndex.Index, ModuleClosure.ModuleClosureError> => {
  const rootText = entries.find(([name]) => name === rootModule)?.[1]
  if (rootText === undefined) throw new RangeError(`Fixture has no root source ${rootModule}`)
  return Effect.map(
    ModuleClosure.load({ root: rootModule }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make(rootModule, ascii(rootText))]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map(
                entries
                  .filter(([name]) => name !== rootModule)
                  .map(([name, text]) => [name, ascii(text)] as const),
              ),
            ),
          ),
        ),
      ),
    ),
    (closure) => NameResolution.analyze(closure).index,
  )
}

const codesOf = (index: DeclarationIndex.Index): ReadonlyArray<string> =>
  index.diagnostics.map((diagnostic) => diagnostic.code)

const structNamed = (
  index: DeclarationIndex.Index,
  name: string,
): DeclarationFacts.StructFact | undefined =>
  index.modules
    .flatMap((module) => module.structs)
    .find((struct) => struct.canonical._tag === 'Canonical' && struct.canonical.id.name === name)

/**
 * The compiler-owned indirections are the base case of the whole rule: their representations are
 * `{$allocation, count}` and `{$address}` whatever they hold, so a field of `Intrinsic.RawBuffer<Node>` needs
 * nothing about `Node`'s layout. Before this change `Type.nominals` recursed into type arguments
 * and this exact shape was `SEM0020` with an unavailable dependency.
 */
it.effect('accepts a struct that reaches itself through compiler-owned raw storage', () =>
  Effect.gen(function* () {
    const index = yield* collect('storage', [
      [
        'storage',
        'struct Node { next: Intrinsic.RawBuffer<Node> }\npub fn main() -> i32 { return 0 }',
      ],
    ])
    assert.deepEqual(codesOf(index), [])

    // The narrower graph is used for cycles only. The field still reports every nominal it names.
    const node = structNamed(index, 'Node')
    assert.strictEqual(node?.dependency._tag, 'Available')
    assert.deepEqual(
      node?.dependency._tag === 'Available'
        ? node.dependency.types.map((type) => Type.encode(type))
        : [],
      ['storage.Node', 'Intrinsic.RawBuffer<storage.Node>'],
    )
  }),
)

/**
 * The rule is general, not a standard-library privilege: any declaration that only ever holds its
 * parameter behind raw storage becomes recursion-capable, and nothing recognizes it by name.
 */
it.effect('accepts a cycle through a user generic that indirects its own parameter', () =>
  Effect.gen(function* () {
    const generic = yield* collect('indirecting', [
      [
        'indirecting',
        'struct Cell<T> { buffer: Intrinsic.RawBuffer<T> }\n' +
          'struct Node { next: Cell<Node> }\n' +
          'pub fn main() -> i32 { return 0 }',
      ],
    ])
    assert.deepEqual(codesOf(generic), [])
    assert.strictEqual(structNamed(generic, 'Node')?.dependency._tag, 'Available')

    // The same holds one level deeper, where the indirecting generic is reached through another
    // struct rather than named directly.
    const nested = yield* collect('nested', [
      [
        'nested',
        'struct Cell { buffer: Intrinsic.RawBuffer<Cell> }\n' +
          'struct Node { next: Cell }\n' +
          'pub fn main() -> i32 { return 0 }',
      ],
    ])
    assert.deepEqual(codesOf(nested), [])
    assert.strictEqual(structNamed(nested, 'Node')?.dependency._tag, 'Available')
  }),
)

/**
 * The counterpart, and the reason the analysis is a fixed point rather than a list of indirecting
 * shapes: a generic that holds its parameter as an ordinary field carries the cycle straight
 * through, and the struct is rejected exactly as a direct self-reference is.
 */
it.effect('keeps rejecting a cycle through a generic that inlines its own parameter', () =>
  Effect.gen(function* () {
    const index = yield* collect('inlining', [
      [
        'inlining',
        'struct Pair<T> { value: T }\n' +
          'struct Node { next: Pair<Node> }\n' +
          'pub fn main() -> i32 { return 0 }',
      ],
    ])
    assert.deepEqual(codesOf(index), ['SEM0020'])
    assert.strictEqual(structNamed(index, 'Node')?.dependency._tag, 'Unavailable')
  }),
)

/** Inline recursion stays rejected, directly and through a zero-length array. */
it.effect('keeps rejecting inline self-reference and a zero-length array anchor', () =>
  Effect.gen(function* () {
    const direct = yield* collect('direct', [
      ['direct', 'struct Node { next: Node }\npub fn main() -> i32 { return 0 }'],
    ])
    assert.deepEqual(codesOf(direct), ['SEM0020'])
    assert.strictEqual(structNamed(direct, 'Node')?.dependency._tag, 'Unavailable')

    // A zero-length array of Node still requires Node's layout to exist, so it stays an inline
    // reach. This is why the standard library's vacancy marker is not generic.
    const anchored = yield* collect('anchored', [
      ['anchored', 'struct Node { anchor: [Node; 0] }\npub fn main() -> i32 { return 0 }'],
    ])
    assert.deepEqual(codesOf(anchored), ['SEM0020'])
    assert.strictEqual(structNamed(anchored, 'Node')?.dependency._tag, 'Unavailable')
  }),
)

/** Mutual inline recursion across modules keeps its one canonical diagnostic. */
it.effect('keeps rejecting mutual inline recursion across modules', () =>
  Effect.gen(function* () {
    const index = yield* collect('a/A', [
      ['a/A', 'import b.B\npub struct A { value: B.B }'],
      ['b/B', 'import a.A\npub struct B { value: A.A }'],
    ])
    assert.deepEqual(codesOf(index), ['SEM0020'])
    assert.strictEqual(structNamed(index, 'A')?.dependency._tag, 'Unavailable')
    assert.strictEqual(structNamed(index, 'B')?.dependency._tag, 'Unavailable')
  }),
)

/**
 * Both cycle sites read the same graph. The component walk decides whether a struct forms a
 * multi-member component, and a separate self-edge test decides whether a lone struct names
 * itself; if only one of them learned about indirection, a self-indirecting struct would still be
 * reported as a cycle of one.
 */
it.effect('agrees between the component walk and the self-edge test', () =>
  Effect.gen(function* () {
    const alone = yield* collect('alone', [
      [
        'alone',
        'struct Cell<T> { buffer: Intrinsic.RawBuffer<T> }\n' +
          'struct Node { next: Cell<Node> value: i32 }\n' +
          'pub fn main() -> i32 { return 0 }',
      ],
    ])
    assert.deepEqual(codesOf(alone), [])

    // Two structs whose only cycle passes through an indirection form a component of two, which is
    // the path through the component walk rather than the self-edge test.
    const mutual = yield* collect('mutual/A', [
      ['mutual/A', 'import mutual.B\npub struct A { value: Intrinsic.RawBuffer<B.B> }'],
      ['mutual/B', 'import mutual.A\npub struct B { value: Intrinsic.RawBuffer<A.A> }'],
    ])
    assert.deepEqual(codesOf(mutual), [])
    assert.strictEqual(structNamed(mutual, 'A')?.dependency._tag, 'Available')
    assert.strictEqual(structNamed(mutual, 'B')?.dependency._tag, 'Available')
  }),
)

/**
 * The fixed point is the least one, so it cannot depend on the order declarations arrive in.
 * Reversing the source order and shuffling the module order must produce the same answer.
 */
it.effect('produces the same answer regardless of declaration and module order', () =>
  Effect.gen(function* () {
    const forward = yield* collect('order', [
      [
        'order',
        'struct Cell<T> { buffer: Intrinsic.RawBuffer<T> }\n' +
          'struct Pair<T> { value: T }\n' +
          'struct Good { next: Cell<Good> }\n' +
          'pub fn main() -> i32 { return 0 }',
      ],
    ])
    const reversed = yield* collect('order', [
      [
        'order',
        'struct Good { next: Cell<Good> }\n' +
          'struct Pair<T> { value: T }\n' +
          'struct Cell<T> { buffer: Intrinsic.RawBuffer<T> }\n' +
          'pub fn main() -> i32 { return 0 }',
      ],
    ])
    assert.deepEqual(codesOf(forward), [])
    assert.deepEqual(codesOf(reversed), [])

    // A generic whose parameter only becomes inline through another generic needs more than one
    // round of the fixed point, and still lands in the same place from either direction.
    const chained = (first: string, second: string): string =>
      `${first}\n${second}\nstruct Node { next: Outer<Node> }\npub fn main() -> i32 { return 0 }`
    const inner = 'struct Inner<T> { value: T }'
    const outer = 'struct Outer<T> { inner: Inner<T> }'
    const innerFirst = yield* collect('chain', [['chain', chained(inner, outer)]])
    const outerFirst = yield* collect('chain', [['chain', chained(outer, inner)]])
    assert.deepEqual(codesOf(innerFirst), ['SEM0020'])
    assert.deepEqual(codesOf(outerFirst), ['SEM0020'])
  }),
)

/**
 * Layout is the reason the cycle rule may relax at all: a struct that reaches itself only through
 * raw storage has a finite catalog entry, computed from the indirection's own representation
 * without the element's layout ever being required.
 */
it.effect('lays out a struct that reaches itself through raw storage', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'inline-reach/layout',
      ascii(
        'struct Node { next: Intrinsic.RawBuffer<Node> value: i32 }\npub fn main() -> i32 { return 0 }',
      ),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const entry = Analysis.nominalLayout(snapshot, Type.nominal('inline-reach/layout', 'Node'))
    assert.strictEqual(entry?._tag, 'LayoutEntry')
    if (entry?._tag !== 'LayoutEntry') return
    assert.isAbove(entry.size, 0)
  }),
)
