import { locationAt } from './support/location.js'
import * as Layer from 'effect/Layer'
import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as CompilationProfile from '../src/CompilationProfile.js'
import * as MirVerification from '../src/MirVerification.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Evaluation from '../src/Evaluation.js'
import * as StaticValue from '../src/StaticValue.js'
import * as Target from '../src/Target.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'

const encoder = new TextEncoder()

const publicSurfaceProbe = `
struct ServerContext<A, E, ?R> { result: A }

impl<A, E, ?R> ServerContext<A, E, R> {
  effect<'session> fn use<'session, 'transport: 'session>(
    context: Self,
    session: &'session mut BufferedDuplex<'transport, MemoryByteDuplex>,
  ) -> A ! E ? R
  where &'transport mut MemoryByteDuplex provides &ByteDuplex
    from &mut ByteDuplex | &mut MonotonicClock {
    drop session
    let ServerContext<A, E, R> {result} = move context
    return move result
  }
}

impl<A, E, ?R> BufferedContext<MemoryByteDuplex, A, E ? R> for ServerContext<A, E, R> {
  use: ServerContext.use
}

effect<'env> fn realizeServerContext<'env, A: 'env, E: 'env, ?R>(
  transport: &'env mut MemoryByteDuplex,
  context: ServerContext<A, E, R>,
) -> A
! E | BufferError | OutOfMemoryError
? R | &mut Allocator
where R in Without<R, ByteDuplex> {
  return run withBufferedCapacityContext(
    move transport,
    usize.ONE,
    usize.ONE,
    move context,
  )
}

effect fn writeVectors<'transport, 'call, P>(
  session: &'call mut BufferedDuplex<'transport, P>,
  values: &[Bytes],
) -> () ! BufferError ? &mut MonotonicClock
where &'transport mut P provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock {
  return run BufferedDuplex.writeVecAll(
    &mut session.*,
    move values,
    Option.none<Instant>(),
  )
}

effect fn shutdownBufferedWrite<'transport, 'call, P>(
  session: &'call mut BufferedDuplex<'transport, P>,
  deadline: Option<Instant>,
) -> () ! BufferError ? &mut MonotonicClock
where &'transport mut P provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock {
  return run BufferedDuplex.shutdownWrite(&mut session.*, move deadline)
}

effect fn closeBuffered<'transport, 'call, P>(
  session: &'call mut BufferedDuplex<'transport, P>,
) -> () ! ByteIoError
where &'transport mut P provides &ByteDuplex from &mut ByteDuplex {
  return run BufferedDuplex.close(&mut session.*)
}

fn aliases(
  input: &BufferedInput,
  output: &BufferedOutput,
  transfer: &TransferOutcome,
  discarded: &DiscardOutcome,
) -> usize {
  drop input
  drop output
  drop transfer
  drop discarded
  drop BufferedTransfer {}
  return DEFAULT_CAPACITY + MAX_CAPACITY - 1056768
}
`

const ownershipSource = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.buffered_duplex {BufferedContext, BufferedDuplex, withBuffered, withBufferedPairCapacity}
import silk.buffered_input {BufferError}
import silk.byte_duplex {ByteDuplex, ByteIoError}
import silk.memory_byte_duplex {MemoryByteDuplex}
import silk.monotonic_clock {MonotonicClock}
import silk.option {Option}
import silk.system_clock {Instant}

effect fn conflict<'session, P>(
  session: &'session mut BufferedDuplex<'session, P>,
) -> () ! BufferError {
  let peeked = BufferedDuplex.peek(&session.*)
  run BufferedDuplex.consume(&mut session.*, 1)
  drop peeked
  return ()
}

effect<'call> fn leakSession<'call, P>(
  session: &'call mut BufferedDuplex<'call, P>,
) -> &'call mut BufferedDuplex<'call, P> {
  return move session
}

effect fn escapeSession<'env, P>(
  transport: &'env mut P,
) -> &'env mut BufferedDuplex<'env, P>
! BufferError | OutOfMemoryError
? &mut Allocator
where &'env mut P provides &ByteDuplex from &mut ByteDuplex,
  &'env mut P provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock {
  return run withBuffered<&'env mut BufferedDuplex<'env, P>, never>(
    move transport,
    leakSession,
  )
}

effect<'call> fn leakPeek<'call, P>(
  session: &'call mut BufferedDuplex<'call, P>,
) -> &'call [u8] {
  return BufferedDuplex.peek(&session.*)
}

effect fn escapePeek<'env, P>(transport: &'env mut P) -> &'env [u8]
! BufferError | OutOfMemoryError
? &mut Allocator
where &'env mut P provides &ByteDuplex from &mut ByteDuplex,
  &'env mut P provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock {
  return run withBuffered<&'env [u8], never>(move transport, leakPeek)
}

effect<'call> fn useAmbient<'call, P>(
  session: &'call mut BufferedDuplex<'call, P>,
) -> () ! ByteIoError ? &mut ByteDuplex | &mut MonotonicClock {
  drop session
  return run ByteDuplex.flush(Option.none<Instant>())
}

effect fn aliasAmbient<'env, P>(transport: &'env mut P) -> ()
! BufferError | ByteIoError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock | &mut ByteDuplex
where &'env mut P provides &ByteDuplex from &mut ByteDuplex,
  &'env mut P provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock {
  return run withBuffered<(), ByteIoError>(move transport, useAmbient)
}

effect<'source & 'destination> fn usePair<'source, 'destination, SP, DP>(
  source: &'source mut BufferedDuplex<'source, SP>,
  destination: &'destination mut BufferedDuplex<'destination, DP>,
) -> () {
  drop source
  drop destination
  return ()
}

effect fn aliasPair<'env, P>(transport: &'env mut P) -> ()
! BufferError | OutOfMemoryError
? &mut Allocator
where &'env mut P provides &ByteDuplex from &mut ByteDuplex,
  &'env mut P provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock {
  return run withBufferedPairCapacity<(), never>(
    &mut transport.*,
    4,
    4,
    &mut transport.*,
    4,
    4,
    usePair,
  )
}

effect<'source & 'destination> fn leakPairSession<'source, 'destination, SP, DP>(
  source: &'source mut BufferedDuplex<'source, SP>,
  destination: &'destination mut BufferedDuplex<'destination, DP>,
) -> &'source mut BufferedDuplex<'source, SP> {
  drop destination
  return move source
}

effect fn escapePairSession<'env, SP, DP>(
  source: &'env mut SP,
  destination: &'env mut DP,
) -> &'env mut BufferedDuplex<'env, SP>
! BufferError | OutOfMemoryError
? &mut Allocator
where &'env mut SP provides &ByteDuplex from &mut ByteDuplex,
  &'env mut DP provides &ByteDuplex from &mut ByteDuplex,
  &'env mut SP provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock,
  &'env mut DP provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock {
  return run withBufferedPairCapacity<&'env mut BufferedDuplex<'env, SP>, never>(
    move source, 4, 4, move destination, 4, 4, leakPairSession,
  )
}

effect<'source & 'destination> fn leakPairPeek<'source, 'destination, SP, DP>(
  source: &'source mut BufferedDuplex<'source, SP>,
  destination: &'destination mut BufferedDuplex<'destination, DP>,
) -> &'source [u8] {
  drop destination
  return BufferedDuplex.peek(&source.*)
}

effect fn escapePairPeek<'env, SP, DP>(
  source: &'env mut SP,
  destination: &'env mut DP,
) -> &'env [u8]
! BufferError | OutOfMemoryError
? &mut Allocator
where &'env mut SP provides &ByteDuplex from &mut ByteDuplex,
  &'env mut DP provides &ByteDuplex from &mut ByteDuplex,
  &'env mut SP provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock,
  &'env mut DP provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock {
  return run withBufferedPairCapacity<&'env [u8], never>(
    move source, 4, 4, move destination, 4, 4, leakPairPeek,
  )
}

struct ContextEscape<'env> {
  slot: &'env mut Option<&'env mut BufferedDuplex<'env, MemoryByteDuplex>>
}

impl<'env> ContextEscape<'env> {
  effect<'session> fn use<'session, 'transport: 'session>(
    mut context: Self,
    session: &'session mut BufferedDuplex<'transport, MemoryByteDuplex>,
  ) -> i32
  where &'transport mut MemoryByteDuplex provides &ByteDuplex
    from &mut ByteDuplex | &mut MonotonicClock {
    context.slot.* = Option.some(move session)
    return 0
  }
}

impl<'env> BufferedContext<MemoryByteDuplex, i32, never> for ContextEscape<'env> {
  use: ContextEscape.use
}

pub fn main() -> i32 { return 0 }
`

it.effect(
  'checks reference/public declarations and lowers bounded aggregate overflow',
  () =>
    Effect.gen(function* () {
      const reference = readFileSync(
        new URL('../../../apps/docs/content/reference/buffered-byte-io.md', import.meta.url),
        'utf8',
      )
      const example = /```silk\n([\s\S]*?)```/.exec(reference)?.[1]
      assert.isString(example)
      if (example === undefined) return
      const source = example
        .replace(
          `import silk.buffered_duplex {
  BufferedContext,
  BufferedDuplex,
  withBufferedCapacityContext,
}`,
          `import silk.buffered_duplex {
  BufferedContext,
  BufferedDuplex,
  DEFAULT_CAPACITY,
  withBuffered,
  withBufferedCapacityContext,
}`,
        )
        .replace(
          'import silk.buffered_input { BufferError, FillOutcome }',
          'import silk.buffered_input { BufferError, BufferedInput, DiscardOutcome, FillOutcome, MAX_CAPACITY }',
        )
        .replace(
          'import silk.byte_duplex { ByteDuplex }',
          `import silk.buffered_output { BufferedOutput }
import silk.buffered_transfer { BufferedTransfer, TransferOutcome }
import silk.byte_duplex { ByteDuplex, ByteIoError }
import silk.bytes { Bytes }`,
        )
        .replace('pub fn main() -> i32 {', `${publicSurfaceProbe}\npub fn main() -> i32 {`)
        .replace(
          '  let filled = run BufferedDuplex.fill(',
          `  let outputs: [Bytes; 0] = []
  run writeVectors(&mut session.*, &outputs)
  run shutdownBufferedWrite(&mut session.*, Option.none<Instant>())
  let filled = run BufferedDuplex.fill(`,
        )
      const sourceId = 'buffered-byte-io/reference-and-public-surface'
      const selected = AnalysisFixture.configuration(sourceId)
      const composition = selected.composition
      assert.isDefined(composition)
      if (composition === undefined) return
      const snapshot = yield* Analysis.makeRealized({
        root: sourceId,
        configuration: {
          ...selected,
          composition: {
            ...composition,
            retention: [{ module: 'silk/buffered_output', declaration: 'checkedAggregateLength' }],
          },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make(sourceId, encoder.encode(source))]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const mir = Analysis.loweredMir(snapshot)
      const aggregate = mir.functions.find(
        (fn) => fn.id.name === 'checkedAggregateLength$effect$-1',
      )
      assert.isDefined(aggregate)
      if (aggregate === undefined) return
      const operations = MirVerification.operations(aggregate)
      assert.isTrue(
        operations.some(
          (operation) =>
            operation._tag === 'Call' &&
            operation.target.module === 'silk/usize' &&
            operation.target.name === 'checkedAdd',
        ),
      )
      assert.isTrue(
        operations.some(
          (operation) =>
            operation._tag === 'ConstructUnionVariant' &&
            operation.variant.name === 'LengthOverflow',
        ),
      )

      const profile = yield* CompilationProfile.normalize({
        target: Target.x8664UnknownLinuxGnu.id,
      })
      const span = locationAt('buffered-byte-io/aggregate-overflow')
      const maximum = StaticValue.admit(
        { _tag: 'IntegerValue', type: 'usize', value: (1n << 64n) - 1n },
        { pointerBits: 64 },
      )
      const one = StaticValue.admit(
        { _tag: 'IntegerValue', type: 'usize', value: 1n },
        { pointerBits: 64 },
      )
      assert.strictEqual(maximum._tag, 'Admitted')
      assert.strictEqual(one._tag, 'Admitted')
      if (maximum._tag !== 'Admitted' || one._tag !== 'Admitted') return
      assert.strictEqual(
        Evaluation.evaluatePrimitive(
          Evaluation.targetEnvironment(profile),
          'Add',
          [maximum.value, one.value],
          span,
        )._tag,
        'Failed',
      )
    }),
  45_000,
)

it.effect(
  'rejects peek mutation, scoped session and peek escape, contextual escape, and ambient duplex aliasing',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.declarations(
        'buffered-byte-io/ownership-rejections',
        encoder.encode(ownershipSource),
      )
      const declarations = [
        'conflict',
        'escapeSession',
        'escapePeek',
        'aliasAmbient',
        'aliasPair',
        'escapePairSession',
        'escapePairPeek',
        'contextEscape',
      ] as const
      const starts = declarations.map((name) =>
        ownershipSource.indexOf(
          name === 'contextEscape' ? 'struct ContextEscape' : `effect fn ${name}`,
        ),
      )
      const ownerAt = (offset: number): (typeof declarations)[number] | undefined =>
        declarations.findLast((_, index) => (starts.at(index) ?? Number.MAX_SAFE_INTEGER) <= offset)
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => ({
          code: diagnostic.code,
          owner: ownerAt(diagnostic.span.start),
          span: ownershipSource.slice(diagnostic.span.start, diagnostic.span.end).trim(),
        })),
        [
          { code: 'OWN0010', owner: 'conflict', span: '&mut session.*' },
          {
            code: 'SEM0074',
            owner: 'escapeSession',
            span: `withBuffered<&'env mut BufferedDuplex<'env, P>, never>(
    move transport,
    leakSession,
  )`,
          },
          { code: 'SEM0122', owner: 'escapeSession', span: 'leakSession' },
          {
            code: 'SEM0074',
            owner: 'escapePeek',
            span: `withBuffered<&'env [u8], never>(move transport, leakPeek)`,
          },
          { code: 'SEM0122', owner: 'escapePeek', span: 'leakPeek' },
          {
            code: 'SEM0074',
            owner: 'aliasAmbient',
            span: 'withBuffered<(), ByteIoError>(move transport, useAmbient)',
          },
          { code: 'OWN0010', owner: 'aliasPair', span: '&mut transport.*' },
          {
            code: 'SEM0074',
            owner: 'escapePairSession',
            span: `withBufferedPairCapacity<&'env mut BufferedDuplex<'env, SP>, never>(
    move source, 4, 4, move destination, 4, 4, leakPairSession,
  )`,
          },
          { code: 'SEM0122', owner: 'escapePairSession', span: 'leakPairSession' },
          {
            code: 'SEM0074',
            owner: 'escapePairPeek',
            span: `withBufferedPairCapacity<&'env [u8], never>(
    move source, 4, 4, move destination, 4, 4, leakPairPeek,
  )`,
          },
          { code: 'SEM0122', owner: 'escapePairPeek', span: 'leakPairPeek' },
          {
            code: 'SEM0037',
            owner: 'contextEscape',
            span: 'Option.some(move session)',
          },
          {
            code: 'SEM0083',
            owner: 'contextEscape',
            span: `impl<'env> BufferedContext<MemoryByteDuplex, i32, never> for ContextEscape<'env> {
  use: ContextEscape.use
}`,
          },
          { code: 'SEM0051', owner: 'contextEscape', span: 'BufferedContext' },
        ],
      )
    }),
  45_000,
)
