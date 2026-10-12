import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as ConformanceProof from '../src/ConformanceProof.js'
import * as Type from '../src/Type.js'

const ascii = (value: string): Uint8Array => Uint8Array.from(value, (unit) => unit.charCodeAt(0))

const analyze = (name: string, source: string) =>
  AnalysisFixture.retainingMain(name, ascii(source), 'wasm32-unknown-unknown')

const reported = (
  snapshot: Analysis.Snapshot,
  code: string,
): ReadonlyArray<{
  readonly message: string
  readonly notes: ReadonlyArray<string>
  readonly related: ReadonlyArray<string>
}> =>
  Analysis.diagnostics(snapshot)
    .filter((diagnostic) => diagnostic.code === code)
    .map((diagnostic) => ({
      message: diagnostic.message,
      notes: diagnostic.notes ?? [],
      related: (diagnostic.relatedSpans ?? []).map((entry) => entry.label),
    }))

/**
 * The declarations every rejection fixture below reuses.
 *
 * `Schema` carries the only base witness, so a header that is rejected at declaration time can be
 * told apart from one that was admitted and simply had nothing to prove.
 */
const decoderBase = `interface Decoder {
  fn decode(value: &Self) -> i32
}

struct Schema { tag: i32 }

fn schemaDecode(value: &Schema) -> i32 { return value.tag }

impl Decoder for Schema { decode: Schema.schemaDecode }

struct MappedSchema<S> { source: S }

fn mappedDecode<S: Decoder>(value: &MappedSchema<S>) -> i32 {
  return Decoder.decode(&value.source) + 1
}
`

it.effect('rejects heads that may unify even when their bounds cannot both hold', () =>
  Effect.gen(function* () {
    // No type conforms to both `Left` and `Right`, and neither interface has a single
    // implementation. Coherence still reports the overlap, because whether a bound is satisfiable
    // is a property of the whole program: a later declaration could make both provable, and a
    // coherence answer that moved with the program would silently change the selected witness.
    const snapshot = yield* analyze(
      'conditional-conformance-rejection/bound-distinguished',
      `interface Decoder {
  fn decode(value: Self) -> i32
}

interface Left {
  fn leftward(value: Self) -> i32
}

interface Right {
  fn rightward(value: Self) -> i32
}

struct Wrapper<S> { source: S }

struct Boxed<T> { item: T }

fn wrapperDecode<S: Left>(value: &Wrapper<S>) -> i32 { return 1 }

fn boxedDecode<T: Right>(value: &Wrapper<Boxed<T>>) -> i32 { return 2 }

impl<S: Left> Decoder for Wrapper<S> { decode: Wrapper.wrapperDecode }

impl<T: Right> Decoder for Wrapper<Boxed<T>> { decode: Wrapper.boxedDecode }

pub fn main() -> i32 { return 0 }`,
    )
    assert.deepEqual(
      reported(snapshot, 'SEM0119').map((diagnostic) => diagnostic.message),
      [
        'conditional-conformance-rejection/bound-distinguished.Decoder for conditional-conformance-rejection/bound-distinguished.Wrapper<conditional-conformance-rejection/bound-distinguished.Boxed<%0>> may overlap conditional-conformance-rejection/bound-distinguished.Decoder for conditional-conformance-rejection/bound-distinguished.Wrapper<%0>',
      ],
    )
    assert.deepEqual(reported(snapshot, 'SEM0119').at(0)?.related, ['overlapping implementation'])
    assert.deepEqual(reported(snapshot, 'SEM0119').at(0)?.notes, [
      'Conformance overlap is decided without consulting bounds, because whether a bound is satisfiable changes as a program grows.',
    ])
  }),
)

it.effect('allows a service as an ordinary conditional proof requirement', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance-rejection/service-bound',
      `interface Mark {}
service Gate { effect fn read() -> i32 ? &Gate }
struct Wrap<S> { value: S }

impl<S: Gate> Mark for Wrap<S> {}

pub fn main() -> i32 { return 0 }`,
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.deepEqual(reported(snapshot, 'SEM0119'), [])
    assert.deepEqual(reported(snapshot, 'SEM0120'), [])
    const index = Analysis.declarationIndex(snapshot)
    assert.strictEqual(index.modules.at(0)?.conformances.at(0)?.validity._tag, 'ValidConformance')
    assert.strictEqual(index.modules.at(0)?.conformances.at(0)?.termination._tag, 'Terminating')
    const provider = Type.nominal('conditional-conformance-rejection/service-bound', 'Wrap', [
      'i32',
    ])
    const capability = Type.nominal('conditional-conformance-rejection/service-bound', 'Mark')
    assert.strictEqual(ConformanceProof.prove(index, provider, capability)._tag, 'Unproved')
    assert.isUndefined(ConformanceProof.witness(index, provider, capability))
    assert.isFalse(ConformanceProof.conforms(index, provider, capability))
  }),
)

it.effect('rejects a requirement that repeats a binder the header uses once', () =>
  Effect.gen(function* () {
    // The provider still descends here, so only the occurrence condition can reject the header:
    // a requirement that trades depth for width would let one proof step ask two questions the
    // same size as the one it answers.
    const snapshot = yield* analyze(
      'conditional-conformance-rejection/increasing-occurrences',
      `${decoderBase}
interface Duo<T, U> {}

impl<S: Duo<S, S>> Decoder for MappedSchema<S> {
  decode: MappedSchema.mappedDecode
}

pub fn main() -> i32 { return 0 }`,
    )
    assert.deepEqual(
      reported(snapshot, 'SEM0120').flatMap((diagnostic) => diagnostic.notes),
      [
        'requirement conditional-conformance-rejection/increasing-occurrences.Duo<%0, %0> for %0 repeats %0 3 times where the header uses it 1',
      ],
    )
  }),
)

it.effect('reports two identical conditional headers as an overlap rather than a duplicate', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyze(
      'conditional-conformance-rejection/duplicate',
      `${decoderBase}
impl<S: Decoder> Decoder for MappedSchema<S> {
  decode: MappedSchema.mappedDecode
}

impl<S: Decoder> Decoder for MappedSchema<S> {
  decode: MappedSchema.mappedDecode
}

pub fn main() -> i32 { return 0 }`,
    )
    // Two headers that both declare requirements are reported as the overlap they are even when
    // their shapes are identical: naming them duplicates would suggest the bounds were compared,
    // and coherence never reads a bound. An unbounded repeat is still named a duplicate.
    const overlaps = reported(snapshot, 'SEM0119')
    assert.strictEqual(overlaps.length, 1)
    assert.include(overlaps.at(0)?.message ?? '', 'may overlap')
    assert.deepEqual(overlaps.at(0)?.related, ['overlapping implementation'])
    assert.deepEqual(reported(snapshot, 'SEM0083'), [])
  }),
)

it.effect('rejects sealed Drop and Copy heads that depend on regions', () =>
  Effect.gen(function* () {
    // Lifetimes never decide which code runs: cleanup and copying are selected per type during
    // lowering, so a sealed head may not name `'static`, repeat one region, or bound a region.
    // Conformance heads may, because coherence erases lifetimes and typing proves their relations.
    // A bound the provider's declaration already requires holds for every value of the type, so a
    // head may repeat it. An interface bound is a region bound in disguise: `Box<Tag<'x>>` would
    // run its hook only when `'x` is `'static`.
    const source = `interface Mark {}
struct Lasting<'a> { value: &'a i32 }
struct Pair<'a, 'b> { left: &'a i32 right: &'b i32 }
struct Ordered<'a, 'b> { left: &'a i32 right: &'b i32 }
struct Held<'a, T> { value: &'a T }
struct Free<'a, 'b> { left: &'a i32 right: &'b i32 }
struct Token<F: once fn(i32) -> i32> { marker: F }
struct Kept<F: once fn<'static>(i32) -> i32> { marker: F }
struct Long<'a: 'b, 'b> { left: &'a i32 right: &'b i32 }
interface Label {}
struct Tag<'a> { value: &'a i32 }
struct Box<T> { value: T }
struct Labelled<T: Label> { value: T }

impl Drop for Lasting<'static> {
  fn drop(self: &mut Lasting<'static>) -> () { return () }
}
impl<'a> Drop for Pair<'a, 'a> {
  fn drop(self: &mut Pair<'a, 'a>) -> () { return () }
}
impl<'a: 'b, 'b> Copy for Ordered<'a, 'b> {}
impl<'a, T: 'a> Copy for Held<'a, T> {}
impl<'a, 'b> Drop for Free<'a, 'b> {
  fn drop(self: &mut Free<'a, 'b>) -> () { return () }
}
impl<F: once fn<'static>(i32) -> i32> Drop for Token<F> {
  fn drop(self: &mut Token<F>) -> () { return () }
}
impl<F: once fn<'static>(i32) -> i32> Drop for Kept<F> {
  fn drop(self: &mut Kept<F>) -> () { return () }
}
impl<'a: 'b, 'b> Copy for Long<'a, 'b> {}
impl<'a: 'static> Label for Tag<'a> {}
impl<T: Label> Drop for Box<T> {
  fn drop(self: &mut Box<T>) -> () { return () }
}
impl<T: Label> Drop for Labelled<T> {
  fn drop(self: &mut Labelled<T>) -> () { return () }
}
impl Mark for Lasting<'static> {}
impl<'a> Mark for Pair<'a, 'a> {}
impl<'a: 'b, 'b> Mark for Ordered<'a, 'b> {}

pub fn main() -> i32 { return 0 }`
    const snapshot = yield* analyze('conditional-conformance-rejection/region-selective', source)
    assert.deepEqual(
      Analysis.diagnostics(snapshot)
        .filter((diagnostic) => diagnostic.code === 'SEM0220')
        .map((diagnostic) =>
          source.slice(diagnostic.span.start, diagnostic.span.end).split('\n').at(0),
        ),
      [
        "impl Drop for Lasting<'static> {",
        "impl<'a> Drop for Pair<'a, 'a> {",
        "impl<'a: 'b, 'b> Copy for Ordered<'a, 'b> {}",
        "impl<'a, T: 'a> Copy for Held<'a, T> {}",
        "impl<F: once fn<'static>(i32) -> i32> Drop for Token<F> {",
        'impl<T: Label> Drop for Box<T> {',
      ],
    )
  }),
)
