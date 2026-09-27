import { records } from './support/records.js'
import * as Layer from 'effect/Layer'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Lifetime from '../src/Lifetime.js'
import * as NameResolution from '../src/NameResolution.js'
import * as Presentation from '../src/SemanticDisplay.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Type from '../src/Type.js'
import {
  allocatorSource,
  nestedBindingSource,
  recoveredMemberSource,
} from './support/editorCorpus.js'
import * as Projections from './support/projections.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const documentationText = (
  snapshot: Analysis.FrontendSnapshot,
  block: ReturnType<typeof Analysis.documentationAt>,
) => {
  if (block === undefined) return undefined
  const source = Projections.syntaxOf(snapshot, block.span.sourceId)?.source
  if (source === undefined) return undefined
  // A member's block is indented inside its impl; documentation ignores that indentation.
  return decoder
    .decode(SourceFile.toUint8Array(source).slice(block.span.start, block.span.end))
    .replace(/\n[ \t]+\/\/\//g, '\n///')
}

const occurrenceAt = (
  snapshot: Analysis.FrontendSnapshot,
  source: string,
  spelling: string,
  occurrence = 0,
) => {
  let offset = -1
  for (let index = 0; index <= occurrence; index += 1) offset = source.indexOf(spelling, offset + 1)
  return Analysis.semanticOccurrenceAt(snapshot, 'main', offset)
}

it.effect('presents anonymous contracts and resolves their nested lexical facts', () => {
  const source = `struct Failure {}
struct Token { value: i32 }
pub fn main() -> i32 {
  let offset = 2
  let value = 100
  let add = fn(value: i32) -> i32 {
    let local = value + offset
    return local
  }
  let shared = Token { value: 1 }
  let mut counter = 0
  let mut adjust = fn(delta: i32) -> i32 {
    counter = counter + delta
    return counter + shared.value
  }
  let recover = effect fn(error: Failure) -> i32 { return 42 }
  return add(40) + adjust(0) - 1
}`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const ordinaryFn = source.indexOf('fn(value')
      const exclusiveFn = source.indexOf('fn(delta')
      const effectFn = source.indexOf('fn(error')
      assert.strictEqual(
        Analysis.hoverSubjectAt(snapshot, 'main', ordinaryFn)?.presentation.text,
        'fn(value: i32) -> i32\nmode: fn\ncaptures: offset (Copy)',
      )
      assert.strictEqual(
        Analysis.hoverSubjectAt(snapshot, 'main', exclusiveFn)?.presentation.text,
        'fn(delta: i32) -> i32\nmode: mut fn\ncaptures: counter (exclusive), shared (shared)',
      )
      assert.strictEqual(
        Analysis.hoverSubjectAt(snapshot, 'main', effectFn)?.presentation.text,
        'effect fn(error: Failure) -> i32\nmode: fn\ncaptures: none',
      )

      const parameterDeclaration = Analysis.semanticOccurrenceAt(
        snapshot,
        'main',
        source.indexOf('value: i32', ordinaryFn),
      )
      const parameterUse = Analysis.semanticOccurrenceAt(
        snapshot,
        'main',
        source.indexOf('value +'),
      )
      assert.strictEqual(parameterDeclaration?.role, 'Declaration')
      assert.deepEqual(parameterUse?.resolution, parameterDeclaration?.resolution)

      const outerDeclaration = Analysis.semanticOccurrenceAt(
        snapshot,
        'main',
        source.indexOf('offset ='),
      )
      const capturedUse = Analysis.semanticOccurrenceAt(
        snapshot,
        'main',
        source.indexOf('offset\n'),
      )
      assert.deepEqual(capturedUse?.resolution, outerDeclaration?.resolution)

      const completion = Analysis.completionAt(snapshot, 'main', source.indexOf('return local'))
      const labels = completion?.candidates.map((candidate) => candidate.label) ?? []
      assert.includeMembers(labels, ['value', 'offset', 'local'])
      assert.isFalse(labels.some((label) => label.includes('$callable$')))
      assert.isFalse(
        snapshot.index.modules
          .flatMap((module) => module.members)
          .some(
            (member) =>
              member.name._tag === 'Present' && member.name.spelling.includes('$callable$'),
          ),
      )
      return undefined
    }),
  )
})

it.effect('completes anonymous callable starts without construction modifiers', () => {
  const source = `struct Failure {}
fn complete<T>(outer: T) -> i32 {
  let local = 1
  let transform = fn(value: ) -> i32 { return local }
  return 42
}
pub fn main() -> i32 {
  let handler = effect fn(error: Failure) -> i32 { return 42 }
  return 42
}`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const expressionOffset = source.indexOf('effect fn')
      const afterEffectOffset = expressionOffset + 'effect '.length
      const parameterTypeOffset = source.indexOf('value: ') + 'value: '.length
      const expressionLabels =
        Analysis.completionAt(snapshot, 'main', expressionOffset)?.candidates.map(
          (candidate) => candidate.label,
        ) ?? []
      const afterEffectLabels =
        Analysis.completionAt(snapshot, 'main', afterEffectOffset)?.candidates.map(
          (candidate) => candidate.label,
        ) ?? []
      const parameterTypeLabels =
        Analysis.completionAt(snapshot, 'main', parameterTypeOffset)?.candidates.map(
          (candidate) => candidate.label,
        ) ?? []
      assert.include(expressionLabels, 'fn')
      assert.includeMembers(afterEffectLabels, ['fn', '{'])
      assert.notInclude(expressionLabels, 'mut')
      assert.notInclude(expressionLabels, 'once')
      assert.notInclude(afterEffectLabels, 'mut')
      assert.notInclude(afterEffectLabels, 'once')
      assert.includeMembers(parameterTypeLabels, ['T', 'i32'])
      assert.notInclude(parameterTypeLabels, 'local')
      assert.notInclude(parameterTypeLabels, 'outer')
      return undefined
    }),
  )
})

it.effect('indexes allocator tokens as source binding, actor, and function identities', () =>
  Analysis.ofSource('main', encoder.encode(allocatorSource)).pipe(
    Effect.map((snapshot) => {
      const source = allocatorSource
      const binding = occurrenceAt(snapshot, source, 'allocator', 2)
      const actor = occurrenceAt(snapshot, source, 'Allocator', 2)
      const operation = occurrenceAt(snapshot, source, 'systemAllocatorProvider')
      assert.strictEqual(binding?.role, 'Declaration')
      assert.strictEqual(actor?.role, 'Actor')
      assert.strictEqual(operation?.role, 'Value')
      assert.isDefined(binding?.declaration)
      assert.strictEqual(actor?.resolution._tag, 'Available')
      assert.isDefined(operation?.declaration)
      assert.strictEqual(
        binding === undefined
          ? undefined
          : Analysis.occurrencePresentation(snapshot, 'main', binding)?.text,
        'let mut allocator: SystemAllocator',
      )
      assert.strictEqual(
        operation === undefined
          ? undefined
          : Analysis.occurrencePresentation(snapshot, 'main', operation)?.text,
        'pub fn systemAllocatorProvider() -> SystemAllocator',
      )
      return undefined
    }),
  ),
)

it.effect('presents and navigates source service declarations and operation contracts', () => {
  const source = `/// A portable logging contract.
pub service Logger {
  /// Reports whether logging is enabled.
  fn enabled() -> bool
}
pub fn main() -> i32 { return 0 }`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const service = occurrenceAt(snapshot, source, 'Logger')
      const operation = occurrenceAt(snapshot, source, 'enabled()')

      assert.strictEqual(service?.role, 'Declaration')
      assert.strictEqual(operation?.role, 'Declaration')
      assert.isDefined(service?.declaration)
      assert.isDefined(operation?.declaration)
      assert.strictEqual(
        service === undefined
          ? undefined
          : Analysis.occurrencePresentation(snapshot, 'main', service)?.text,
        'pub service Logger',
      )
      assert.strictEqual(
        operation === undefined
          ? undefined
          : Analysis.occurrencePresentation(snapshot, 'main', operation)?.text,
        'fn enabled() -> bool',
      )
      assert.strictEqual(
        documentationText(
          snapshot,
          Analysis.documentationAt(snapshot, 'main', source.indexOf('enabled()')),
        ),
        '/// Reports whether logging is enabled.',
      )
      return undefined
    }),
  )
})

it.effect('presents nominal unions, variants, and variant fields from canonical facts', () => {
  const source = `/// A computation outcome.
pub union Result<A, E> {
  /// A successful payload.
  Success { pub value: A },
  Failure { pub error: E },
}
pub fn main() -> i32 { return 0 }`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const declaration = occurrenceAt(snapshot, source, 'Result')
      const variant = occurrenceAt(snapshot, source, 'Success')
      const field = occurrenceAt(snapshot, source, 'value')
      const union = Analysis.unionByName(snapshot, 'main', 'Result')

      assert.strictEqual(declaration?.role, 'Declaration')
      assert.strictEqual(variant?.role, 'Declaration')
      assert.strictEqual(field?.role, 'Declaration')
      assert.strictEqual(variant?.resolution._tag, 'Available')
      assert.strictEqual(
        declaration === undefined
          ? undefined
          : Analysis.occurrencePresentation(snapshot, 'main', declaration)?.text,
        'pub union Result<A, E>',
      )
      assert.strictEqual(
        variant === undefined
          ? undefined
          : Analysis.occurrencePresentation(snapshot, 'main', variant)?.text,
        'Result<A, E>.Success { value: A }: Result<A, E>',
      )
      assert.strictEqual(
        documentationText(
          snapshot,
          Analysis.documentationAt(snapshot, 'main', source.indexOf('Success')),
        ),
        '/// A successful payload.',
      )
      assert.strictEqual(union._tag, 'Resolved')
      if (union._tag !== 'Resolved') return undefined
      const selected = Analysis.unionVariantByName(union.declaration, 'Success')
      assert.strictEqual(selected._tag, 'Resolved')
      if (selected._tag !== 'Resolved') return undefined
      assert.strictEqual(
        Analysis.unionVariantFieldByName(selected.variant, 'value')._tag,
        'Resolved',
      )
      return undefined
    }),
  )
})

it.effect('completes variants from a nominal union qualifier', () => {
  const source = `union State { Ready, Waiting { count: i32 } }
pub fn main() -> i32 { let state = State. return 0 }`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const offset = source.indexOf('State.') + 'State.'.length
      const completion = Analysis.completionAt(snapshot, 'main', offset)
      assert.deepEqual(
        completion?.candidates.map((candidate) => [candidate.label, candidate.kind]),
        [
          ['Ready', 'Constructor'],
          ['Waiting', 'Constructor'],
        ],
      )
      return undefined
    }),
  )
})

it.effect('completes variants and module operations from a file-named nominal union', () => {
  const source = `import state { State }
pub fn main() -> i32 {
  let state = State.ready()
  return 0
}`
  return Analysis.make({ root: 'main' }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make('main', encoder.encode(source))]).pipe(
        Layer.provideMerge(
          SourceResolver.memory(
            new Map([
              [
                'state',
                encoder.encode(
                  'pub union State { Ready, Waiting { count: i32 } }\nimpl State { pub fn ready() -> State { return State.Ready } }',
                ),
              ],
            ]),
          ),
        ),
      ),
    ),
    Effect.map((snapshot) => {
      const offset = source.indexOf('State.') + 'State.'.length
      const completion = Analysis.completionAt(snapshot, 'main', offset)
      assert.deepEqual(
        completion?.candidates.map((candidate) => [candidate.label, candidate.kind]),
        [
          ['Ready', 'Constructor'],
          ['Waiting', 'Constructor'],
          ['ready', 'AssociatedFunction'],
        ],
      )
      const operation = occurrenceAt(snapshot, source, 'ready')
      assert.strictEqual(operation?.resolution._tag, 'Available')
      assert.strictEqual(operation?.declaration?.module, 'state')
      assert.strictEqual(operation?.declaration?.selectionSpan?.sourceId, 'state')
      assert.include(
        operation === undefined
          ? ''
          : (Analysis.occurrencePresentation(snapshot, 'main', operation)?.text ?? ''),
        'pub fn ready() -> State',
      )
      return undefined
    }),
  )
})

it.effect('navigates constructor and pattern variants through one canonical identity', () => {
  const source = `union Option<T> { Some { value: T }, None }
fn unwrap(option: Option<i32>) -> i32 {
  return match move option {
    Option<i32>.Some { value } => value
    Option<i32>.None => 0
  }
}
pub fn main() -> i32 { return unwrap(Option<i32>.Some { value: 42 }) }`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const declaration = occurrenceAt(snapshot, source, 'Some')
      const pattern = occurrenceAt(snapshot, source, 'Some', 1)
      const construction = occurrenceAt(snapshot, source, 'Some', 2)

      assert.strictEqual(declaration?.role, 'Declaration')
      assert.strictEqual(pattern?.role, 'Value')
      assert.strictEqual(construction?.role, 'Value')
      assert.deepEqual(pattern?.resolution, declaration?.resolution)
      assert.deepEqual(construction?.resolution, declaration?.resolution)
      assert.deepEqual(pattern?.declaration, declaration?.declaration)
      assert.deepEqual(construction?.declaration, declaration?.declaration)
      return undefined
    }),
  )
})

it.effect('answers raw documentation for modules, declarations, children, and references', () => {
  const source = `//! Recovery module.
/// A recoverable problem.
pub struct Problem {
  /// Numeric problem code.
  pub code: i32
}
/// Recovers one problem.
pub effect fn recover(
  /// Problem to inspect.
  problem: Problem,
) -> i32 {
  return problem.code
}
pub fn main() -> i32 { return recover(Problem { code: 41 }) }
`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      assert.strictEqual(
        documentationText(snapshot, Analysis.moduleDocumentation(snapshot, 'main')),
        '//! Recovery module.',
      )
      assert.strictEqual(
        documentationText(
          snapshot,
          Analysis.documentationAt(snapshot, 'main', source.indexOf('recover(')),
        ),
        '/// Recovers one problem.',
      )
      assert.strictEqual(
        documentationText(
          snapshot,
          Analysis.documentationAt(snapshot, 'main', source.lastIndexOf('recover')),
        ),
        '/// Recovers one problem.',
      )
      assert.strictEqual(
        documentationText(
          snapshot,
          Analysis.documentationAt(snapshot, 'main', source.indexOf('problem:')),
        ),
        '/// Problem to inspect.',
      )
      assert.strictEqual(
        documentationText(
          snapshot,
          Analysis.documentationAt(snapshot, 'main', source.indexOf('code:')),
        ),
        '/// Numeric problem code.',
      )
      return undefined
    }),
  )
})

it.effect('links public Effect operations to visible standard-library source', () => {
  const source = `import silk.effect { Effect }
fn increment(value: i32) -> i32 { return value + 1 }
effect fn answer() -> i32 { return 41 }
pub effect fn main() -> i32 { return run answer() |> Effect.map(increment) }`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const occurrence = occurrenceAt(snapshot, source, 'map')
      assert.strictEqual(occurrence?.role, 'Value')
      assert.strictEqual(occurrence?.declaration?.module, 'silk/effect')
      assert.strictEqual(
        documentationText(
          snapshot,
          Analysis.documentationAt(snapshot, 'main', source.indexOf('map')),
        ),
        `/// Applies a pure callback to success while preserving typed failure and requirements.
///
/// # Details
///
/// \`onSuccess\` runs once only after \`self\` succeeds. A typed failure propagates without invoking the
/// callback. Use [\`flatMap\`] when the callback itself needs an Effect.`,
      )
      assert.strictEqual(
        occurrence === undefined
          ? undefined
          : Analysis.occurrencePresentation(snapshot, 'main', occurrence)?.text,
        "pub effect<'env> fn map<'env, A, B, E, ?R>(self: once Effect<'env; A ! E ? R>, onSuccess: once fn<'env>(A) -> B) -> B ! E ? R",
      )
      return undefined
    }),
  )
})

it.effect(
  'links Scheduler and Fiber hovers to their canonical documented Silk declarations',
  () => {
    const source = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.fiber { Fiber, Cancelled, Outcome }
import silk.local_scheduler { LocalScheduler, StalledError }
import silk.monotonic_clock { MonotonicClock }
import silk.scheduler { Scheduler, PendingPublication, TaskIdExhaustedError }

effect fn child() -> i32
? &mut Scheduler | &mut MonotonicClock {
  return 42
}

effect fn prepareOnly() -> PendingPublication<i32, never>
! OutOfMemoryError | TaskIdExhaustedError
? &mut Scheduler | &mut MonotonicClock {
  return run Scheduler.prepare<i32, never>(child())
}

effect fn program() -> i32
! OutOfMemoryError | TaskIdExhaustedError | Cancelled
? &mut Scheduler | &mut MonotonicClock {
  let childFiber = run Fiber.forkChild<i32, never>(child())
  return run Fiber.join<i32, never>(move childFiber)
}

effect fn observe(fiber: Fiber<i32, never>) -> Outcome<i32, never> {
  return run Fiber.await<i32, never>(move fiber)
}

fn inspectErrors(
  exhausted: &TaskIdExhaustedError,
  cancelled: &Cancelled,
  stalled: &StalledError,
) -> () { return () }

effect fn runProgram(scheduler: &mut LocalScheduler) -> i32
! OutOfMemoryError
  | TaskIdExhaustedError
  | Cancelled
  | StalledError
? &mut MonotonicClock {
  return run LocalScheduler.execute(move scheduler, program())
}

pub fn main() -> i32 {
  let scheduler = LocalScheduler.make()
  drop scheduler
  return 42
}`
    return Analysis.ofSource('main', encoder.encode(source)).pipe(
      Effect.map((snapshot) => {
        assert.deepEqual(Analysis.diagnostics(snapshot), [])

        for (const [module, summary, declaration] of [
          [
            'silk/scheduler',
            '//! Provider protocol for preparing and atomically publishing child Fibers.',
            'pub service Scheduler',
          ],
          [
            'silk/fiber',
            '//! Affine Fiber handles, typed outcomes, and one-observer completion.',
            'pub struct Fiber<A, E>',
          ],
          [
            'silk/local_scheduler',
            '//! Deterministic single-threaded execution for structured Fibers.',
            'pub struct LocalScheduler',
          ],
        ] as const) {
          const moduleDocumentation = documentationText(
            snapshot,
            Analysis.moduleDocumentation(snapshot, module),
          )
          assert.isTrue(moduleDocumentation?.startsWith(summary), module)
          const canonical = Projections.syntaxOf(snapshot, module)?.source
          assert.isDefined(canonical, module)
          const canonicalText =
            canonical === undefined ? '' : decoder.decode(SourceFile.toUint8Array(canonical))
          assert.isTrue(canonicalText.startsWith(summary), module)
          assert.include(canonicalText, declaration, module)
        }

        for (const [needle, offset, module, presentation, summary] of [
          [
            'Scheduler.prepare<i32',
            'Scheduler.'.length,
            'silk/scheduler',
            "effect<'static> fn prepare<A: 'static, E: 'static>",
            '/// Prepares one lazy child task and returns its affine publication value.',
          ],
          [
            'PendingPublication<i32',
            0,
            'silk/scheduler',
            'pub struct PendingPublication<A, E>',
            '/// A prepared child Fiber and the canonical data required for atomic publication.',
          ],
          [
            'exhausted: &TaskIdExhaustedError',
            'exhausted: &'.length,
            'silk/scheduler',
            'pub struct TaskIdExhaustedError',
            '/// A typed failure that reports exhaustion of the task identity space.',
          ],
          [
            'Fiber.forkChild',
            'Fiber.'.length,
            'silk/fiber',
            "pub effect<'static> fn forkChild<A: 'static, E: 'static>",
            '/// Prepares and atomically publishes one child task, then returns its affine Fiber.',
          ],
          [
            '-> Outcome<i32, never>',
            '-> '.length,
            'silk/fiber',
            'pub struct Outcome<A, E>',
            '/// The three possible terminal observations of a Fiber.',
          ],
          [
            'cancelled: &Cancelled',
            'cancelled: &'.length,
            'silk/fiber',
            'pub struct Cancelled',
            '/// A Fiber outcome that reports structured task cancellation.',
          ],
          [
            'LocalScheduler.execute',
            'LocalScheduler.'.length,
            'silk/local_scheduler',
            "pub effect<'life2> fn execute<A: 'static, E: 'static, 'life2>",
            '/// Runs one lazy root program under this Scheduler and returns its typed outcome.',
          ],
          [
            'stalled: &StalledError',
            'stalled: &'.length,
            'silk/local_scheduler',
            'pub struct StalledError',
            '/// Reports that no task is ready and no event registration remains while the root is incomplete.',
          ],
        ] as const) {
          const position = source.indexOf(needle) + offset
          const occurrence = Analysis.semanticOccurrenceAt(snapshot, 'main', position)
          assert.strictEqual(occurrence?.resolution._tag, 'Available', needle)
          assert.strictEqual(occurrence?.declaration?.module, module, needle)
          assert.strictEqual(occurrence?.declaration?.selectionSpan?.sourceId, module, needle)
          assert.include(
            Analysis.hoverSubjectAt(snapshot, 'main', position)?.presentation.text ?? '',
            presentation,
            needle,
          )
          const documentation = documentationText(
            snapshot,
            Analysis.documentationAt(snapshot, 'main', position),
          )
          assert.isTrue(documentation?.startsWith(summary), needle)
        }
        return undefined
      }),
    )
  },
)

it.effect('navigates and presents the source-defined Vector lexical view accessors', () => {
  const source = `import silk.usize
import silk.vector { Vector }
pub fn main() -> i32 {
  let mut values = Vector.make<i32>()
  let shared = Vector.asSlice<i32>(&values)
  let exclusive = Vector.asMutSlice<i32>(&mut values)
  return usize.toI32(shared.length + exclusive.length)
}`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      for (const [name, documentation] of [
        [
          'asSlice',
          `/// Borrows the initialized elements as one shared lexical slice.
///
/// # Gotchas
///
/// Do not retain this slice across an operation that can grow the vector.`,
        ],
        [
          'asMutSlice',
          `/// Borrows all initialized elements as one exclusive lexical slice.
///
/// # Gotchas
///
/// Do not retain this slice across an operation that can grow the vector.`,
        ],
      ] as const) {
        const occurrence = occurrenceAt(snapshot, source, name)
        assert.strictEqual(occurrence?.resolution._tag, 'Available')
        assert.strictEqual(occurrence?.declaration?.module, 'silk/vector')
        assert.isDefined(occurrence?.declaration?.selectionSpan)
        assert.include(
          occurrence === undefined
            ? ''
            : (Analysis.occurrencePresentation(snapshot, 'main', occurrence)?.text ?? ''),
          `fn ${name}<T, 'life1>`,
        )
        assert.strictEqual(
          documentationText(
            snapshot,
            Analysis.documentationAt(snapshot, 'main', source.lastIndexOf(name)),
          ),
          documentation,
        )
      }
      const vectorSource = Projections.syntaxOf(snapshot, 'silk/vector')?.source
      assert.isDefined(vectorSource)
      assert.include(
        vectorSource === undefined ? '' : decoder.decode(SourceFile.toUint8Array(vectorSource)),
        'RawBuffer.view<T>',
      )
      const rawBufferSource = Projections.syntaxOf(snapshot, 'silk/raw_buffer')?.source
      assert.include(
        rawBufferSource === undefined
          ? ''
          : decoder.decode(SourceFile.toUint8Array(rawBufferSource)),
        'return Intrinsic.rawBufferView<T>',
      )
      return undefined
    }),
  )
})

it.effect('navigates and presents the source-defined owned Bytes surface', () => {
  const source = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.bytes { Bytes }
import silk.usize
effect fn build() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let mut bytes = Bytes.make()
  let copied = run Bytes.copy(Bytes.asSlice(&bytes))
  let grown = run Bytes.append(&mut bytes, Bytes.asSlice(&copied))
  let count = Bytes.length(&bytes)
  let writable = Bytes.asMutSlice(&mut bytes)
  return usize.toI32(count + writable.length)
}
pub fn main() -> i32 { return 0 }`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      for (const [name, documentation] of [
        ['make', '/// Creates an empty `Bytes` value without allocating storage.'],
        [
          'copy',
          `/// Copies a complete borrowed byte sequence into independently owned storage.
///
/// # Details
///
/// Empty input does not allocate. Nonempty input uses one allocation sized to its byte length.`,
        ],
        [
          'append',
          `/// Appends a complete borrowed byte sequence in source order.
///
/// # Details
///
/// If growth fails, the original bytes and their length remain unchanged.`,
        ],
        ['length', '/// Returns the initialized byte count.'],
        ['asSlice', '/// Borrows all initialized octets as one shared lexical slice.'],
        [
          'asMutSlice',
          `/// Borrows all initialized octets as one exclusive lexical slice.
///
/// # Gotchas
///
/// Do not retain this slice across [\`append\`], because an append can replace the allocation.`,
        ],
      ] as const) {
        const occurrence = occurrenceAt(snapshot, source, name, 0)
        assert.strictEqual(occurrence?.resolution._tag, 'Available')
        assert.strictEqual(occurrence?.declaration?.module, 'silk/bytes')
        assert.isDefined(occurrence?.declaration?.selectionSpan)
        assert.include(
          occurrence === undefined
            ? ''
            : (Analysis.occurrencePresentation(snapshot, 'main', occurrence)?.text ?? ''),
          `fn ${name}`,
        )
        assert.strictEqual(
          documentationText(
            snapshot,
            Analysis.documentationAt(snapshot, 'main', source.indexOf(name)),
          ),
          documentation,
        )
      }
      const bytesSource = Projections.syntaxOf(snapshot, 'silk/bytes')?.source
      assert.isDefined(bytesSource)
      const text =
        bytesSource === undefined ? '' : decoder.decode(SourceFile.toUint8Array(bytesSource))
      assert.include(text, 'pub struct Bytes')
      assert.include(text, 'values: Vector<u8>')
      assert.notInclude(text, 'FileSystem')
      const completionOffset = source.indexOf('Bytes.') + 'Bytes.'.length
      const labels = Analysis.completionAt(snapshot, 'main', completionOffset)?.candidates.map(
        (candidate) => candidate.label,
      )
      for (const name of ['make', 'copy', 'append', 'length', 'asSlice', 'asMutSlice'])
        assert.include(labels ?? [], name)
      return undefined
    }),
  )
})

it.effect('completes and navigates the source-defined logging surface', () => {
  const source = `import silk.os_logger { StdoutLogger }
import silk.effect { Effect }
import silk.logger { LogError }
import silk.logger { LogLevel }
import silk.logger { Logger }
effect fn pending() -> () ! LogError ? &mut Logger {
  return run Effect.logWarning("ready", &())
}
effect fn direct() -> () ! LogError ? &mut Logger {
  return run Logger.log(LogLevel.Info, "direct", &())
}
pub fn main() -> i32 {
  let memory = Logger.inMemoryProvider()
  let output = StdoutLogger.make()
  return 42
}`
  return Analysis.ofSource('main', encoder.encode(source), 'x86_64-unknown-linux-gnu').pipe(
    Effect.map((snapshot) => {
      const logger = occurrenceAt(snapshot, source, 'Logger.log', 0)
      assert.strictEqual(logger?.role, 'Actor')
      assert.strictEqual(logger?.declaration?.module, 'silk/logger')

      for (const [spelling, module, ordinal] of [
        ['logWarning', 'silk/effect', 0],
        ['log(', 'silk/logger', 0],
        ['Info', 'silk/logger', 0],
        ['inMemoryProvider', 'silk/logger', 0],
        ['make()', 'silk/os_logger', 0],
      ] as const) {
        const occurrence = occurrenceAt(snapshot, source, spelling, ordinal)
        assert.isDefined(occurrence, spelling)
        assert.strictEqual(occurrence?.declaration?.module, module, spelling)
        assert.isDefined(
          occurrence === undefined
            ? undefined
            : Analysis.occurrencePresentation(snapshot, 'main', occurrence),
          spelling,
        )
      }

      assert.strictEqual(
        documentationText(
          snapshot,
          Analysis.documentationAt(snapshot, 'main', source.indexOf('logWarning')),
        ),
        `/// Sends one complete message at \`LogLevel.Warning\` through the required mutable [\`Logger\`].`,
      )
      for (const [prefix, expected] of [
        ['Effect.', ['log', 'logAt', 'logTrace', 'logDebug', 'logInfo', 'logWarning', 'logError']],
        ['Logger.', ['log', 'inMemoryProvider', 'failure', 'length', 'levelAt']],
        ['LogLevel.', ['Trace', 'Debug', 'Info', 'Warning', 'Error']],
      ] as const) {
        const offset = source.indexOf(prefix) + prefix.length
        const labels = Analysis.completionAt(snapshot, 'main', offset)?.candidates.map(
          (candidate) => candidate.label,
        )
        for (const label of expected) assert.include(labels ?? [], label, prefix)
      }
      return undefined
    }),
  )
})

it.effect('completes and navigates the portable Path and FileSystem surface', () => {
  const source = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.filesystem { FileError, FileSystem, Path }
effect fn inspect(path: &Path) -> bool ! FileError ? &mut FileSystem {
  let info = run FileSystem.stat(path)
  return run FileSystem.exists(path)
}
effect fn locate(base: &Path) -> Path ! FileError | OutOfMemoryError ? &mut Allocator {
  return run Path.resolve(base, "child")
}
effect fn canonical() -> Path ! OutOfMemoryError ? &mut Allocator { return run Path.root() }
fn code(error: &FileError) -> i32 { return FileSystem.operationCode(error.operation) }
pub fn main() -> i32 { return 42 }`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      for (const [spelling, ordinal, expected] of [
        ['stat', 0, ["effect<'life0> fn stat<'life0>(", '! FileError ? &mut FileSystem']],
        [
          'exists',
          0,
          ["pub effect<'life0> fn exists<'life0>(", '-> bool ! FileError ? &mut FileSystem'],
        ],
        [
          'resolve',
          0,
          [
            "pub effect<'life0 & 'life1> fn resolve<'life0, 'life1>(",
            '! FileError | OutOfMemoryError ? &mut Allocator',
          ],
        ],
      ] as const) {
        const occurrence = occurrenceAt(snapshot, source, spelling, ordinal)
        assert.strictEqual(occurrence?.declaration?.module, 'silk/filesystem', spelling)
        const presentation =
          occurrence === undefined
            ? ''
            : (Analysis.occurrencePresentation(snapshot, 'main', occurrence)?.text ?? '')
        for (const fragment of expected) assert.include(presentation, fragment, spelling)
        assert.isDefined(occurrence?.declaration?.selectionSpan, spelling)
      }

      const fileError = occurrenceAt(snapshot, source, 'FileError', 1)
      assert.strictEqual(fileError?.declaration?.module, 'silk/filesystem')
      assert.strictEqual(
        documentationText(
          snapshot,
          Analysis.documentationAt(snapshot, 'main', source.indexOf('resolve(base')),
        ),
        `/// Resolves relative text lexically against an explicit absolute base.
///
/// # Details
///
/// Empty text and \`.\` keep the base; \`..\` removes components; ordinary components append. An
/// absolute relative value, an empty interior component, NUL, or any attempt to escape above root
/// fails with the \`InvalidPath\` reason. Resolution is lexical and never accesses the filesystem.`,
      )

      for (const [prefix, expected] of [
        [
          'FileSystem.',
          [
            'readFile',
            'writeFile',
            'stat',
            'listDirectory',
            'createDirectory',
            'removeFile',
            'removeDirectory',
            'exists',
            'error',
            'errorWithCode',
            'providerCode',
          ],
        ],
        ['Path.', ['make', 'root', 'join', 'resolve', 'isRoot', 'name', 'parent']],
      ] as const) {
        const offset = source.indexOf(prefix) + prefix.length
        const labels = Analysis.completionAt(snapshot, 'main', offset)?.candidates.map(
          (candidate) => candidate.label,
        )
        for (const label of expected) assert.include(labels ?? [], label, prefix)
      }
      return undefined
    }),
  )
})

it.effect('completes inherent members after a nominal qualifier with kind labels', () => {
  const source = `pub union Option<T> { None, Some { pub value: T } }
impl<T> Option<T> {
  pub fn none() -> Self { return Option<T>.None }
  pub fn some(value: T) -> Self { return Option.Some { value: move value } }
  pub fn map<U>(self: Self, transform: once fn(T) -> U) -> Option<U> {
    return match move self {
      Option<T>.Some { value } => Option.some<U>(transform(move value))
      Option<T>.None => Option.none<U>()
    }
  }
}
pub fn main() -> i32 { let option = Option. return 0 }`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const offset = source.indexOf('Option.') + 'Option.'.length
      const completion = Analysis.completionAt(snapshot, 'main', offset)
      assert.deepEqual(
        completion?.candidates.map((candidate) => [candidate.label, candidate.kind]),
        [
          ['None', 'Constructor'],
          ['Some', 'Constructor'],
          ['none', 'AssociatedFunction'],
          ['some', 'AssociatedFunction'],
          ['map', 'Method'],
        ],
      )
      assert.strictEqual(
        completion?.candidates.find((candidate) => candidate.label === 'map')?.detail?.text,
        "pub fn map<T, U, 'life2>(self: Option<T>, transform: once fn<'life2>(T) -> U) -> main.Option<U>",
      )
      return undefined
    }),
  )
})

it.effect('lists a private inherent member only inside its declaring module', () => {
  const main = `import shapes { Counter }
pub fn main() -> i32 { let counter = Counter. return 0 }`
  const shapes = `pub struct Counter { value: i32 }
impl Counter {
  pub fn make(value: i32) -> Self { return Counter { value: value } }
  fn secret(self: &Self) -> i32 { return self.value }
}
pub fn local() -> i32 { let counter = Counter. return 0 }`
  return Analysis.make({ root: 'main' }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make('main', encoder.encode(main))]).pipe(
        Layer.provideMerge(SourceResolver.memory(new Map([['shapes', encoder.encode(shapes)]]))),
      ),
    ),
    Effect.map((snapshot) => {
      const labels = (module: string, source: string) =>
        Analysis.completionAt(
          snapshot,
          module,
          source.indexOf('Counter.') + 'Counter.'.length,
        )?.candidates.map((candidate) => [candidate.label, candidate.kind])
      assert.deepEqual(labels('main', main), [['make', 'AssociatedFunction']])
      assert.deepEqual(labels('shapes', shapes), [
        ['make', 'AssociatedFunction'],
        ['secret', 'Method'],
      ])
      return undefined
    }),
  )
})

it.effect('answers deterministic inferred hints and recovered completions', () =>
  Analysis.ofSource('main', encoder.encode(recoveredMemberSource)).pipe(
    Effect.map((snapshot) => {
      const source = recoveredMemberSource
      const hints = Analysis.typeHints(snapshot, 'main', 0, encoder.encode(source).length)
      assert.deepEqual(
        hints.map((hint) => hint.presentation.text),
        ['SystemAllocator'],
      )
      const offset = encoder.encode(
        source.slice(0, source.indexOf('Effect.') + 'Effect.'.length),
      ).length
      const first = Analysis.completionAt(snapshot, 'main', offset)
      const second = Analysis.completionAt(snapshot, 'main', offset)
      assert.deepEqual(second, first)
      assert.include(first?.candidates.map((candidate) => candidate.label) ?? [], 'catch')
      return undefined
    }),
  ),
)

it.effect('presents canonical string in hover, inlay hints, and semantic occurrences', () => {
  const source = `fn identity(value: string) -> string {
  let result = value
  return result
}
fn explicit(value: string<'static>) -> string<'static> { return value }`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const hints = Analysis.typeHints(snapshot, 'main', 0, encoder.encode(source).length)

      for (const spelling of ['string', "string<'static>"]) {
        const occurrence = occurrenceAt(snapshot, source, spelling)
        const hover = Analysis.hoverSubjectAt(snapshot, 'main', source.indexOf(spelling))
        assert.strictEqual(occurrence?.role, 'Type')
        assert.deepEqual(occurrence?.resolution, {
          _tag: 'Available',
          identity: {
            _tag: 'IntrinsicActorIdentity',
            id: { _tag: 'IntrinsicActorId', name: 'string' },
          },
        })
        assert.strictEqual(hover?.presentation.text, 'intrinsic type string')
      }
      assert.deepEqual(
        hints.map((hint) => hint.presentation.text),
        ["string<'life0>"],
      )
      assert.strictEqual(
        Analysis.expressionsOf(snapshot, 'main').some(
          (expression) => expression._tag !== 'Unavailable' && Type.isString(expression.type),
        ),
        true,
      )
      return undefined
    }),
  )
})

it.effect('publishes proved hover contracts and inferred provider-selector hints', () => {
  const source = `import silk.os_writer { StdoutWriter }
import silk.writer { Writer, WriterError }
import silk.writer { Writer }
import silk.effect { Effect }

fn inspect(value: StdoutWriter) -> () { return () }

pub effect fn main() -> () ! WriterError {
  let mut streams = StdoutWriter.make()
  return run Writer.writeAll(b"Hello, world!")
    |> Effect.provideMut(&mut streams)
}`
  return Analysis.ofSource('main', encoder.encode(source), 'x86_64-unknown-linux-gnu').pipe(
    Effect.map((snapshot) => {
      const contractsAt = (spelling: string, occurrence = 0) => {
        let offset = -1
        for (let index = 0; index <= occurrence; index += 1)
          offset = source.indexOf(spelling, offset + 1)
        return (
          Analysis.hoverSubjectAt(snapshot, 'main', offset)?.implementedContracts.map(
            (contract) => contract.text,
          ) ?? []
        )
      }

      assert.deepEqual(contractsAt('StdoutWriter'), ['Writer'])
      assert.deepEqual(contractsAt('make()'), ['Writer'])
      assert.deepEqual(contractsAt('streams', 1), ['Writer'])
      assert.deepEqual(
        Analysis.hoverSubjectAt(
          snapshot,
          'main',
          source.indexOf('make()') + 'make'.length,
        )?.implementedContracts.map((contract) => contract.text) ?? [],
        ['Writer'],
      )

      const hints = Analysis.typeHints(snapshot, 'main', 0, encoder.encode(source).length)
      const selectors = hints.filter((hint) => hint._tag === 'ProviderSelectorTypeHint')
      assert.strictEqual(selectors.length, 1)
      assert.strictEqual(selectors.at(0)?.presentation.text, 'Writer')
      assert.strictEqual(
        selectors.at(0)?.span.start,
        source.indexOf('provideMut(') + 'provideMut'.length,
      )
      const selectorOffset = source.indexOf('provideMut(') + 'provideMut'.length
      assert.deepEqual(
        Analysis.typeHints(snapshot, 'main', 0, selectorOffset).filter(
          (hint) => hint._tag === 'ProviderSelectorTypeHint',
        ),
        [],
      )
      assert.deepEqual(
        Analysis.typeHints(snapshot, 'main', selectorOffset, selectorOffset + 1)
          .filter((hint) => hint._tag === 'ProviderSelectorTypeHint')
          .map((hint) => hint.presentation.text),
        ['Writer'],
      )
      assert.deepEqual(
        Analysis.typeHints(snapshot, 'main', 0, encoder.encode(source).length),
        hints,
      )
      return undefined
    }),
  )
})

it.effect('presents selected imports and shared and owned provider selectors', () => {
  const selectedImportSource = `import silk.os_writer { StdoutWriter }
import silk.writer { Writer, WriterError }
import silk.effect { Effect }

pub effect fn main() -> () ! WriterError {
  let mut streams = StdoutWriter.make()
  return run Writer.writeAll(b"selected\\n")
    |> Effect.provideMut(&mut streams)
}`
  const accessFormsSource = `import silk.effect { Effect }

service Clock {}
struct FixedClock {}
impl Clock for FixedClock {}
effect fn read() -> i32 ? &Clock { return 42 }

pub fn main() -> i32 {
  let sharedClock = FixedClock {}
  let shared = read() |> Effect.provide(&sharedClock)
  drop shared
  let ownedClock = FixedClock {}
  let owned = read() |> Effect.bindRequirementOwned(move ownedClock)
  return run owned
}`
  return Effect.all([
    Analysis.ofSource('main', encoder.encode(selectedImportSource), 'x86_64-unknown-linux-gnu'),
    Analysis.ofSource('main', encoder.encode(accessFormsSource)),
  ]).pipe(
    Effect.map(([selectedImport, accessForms]) => {
      assert.deepEqual(Analysis.diagnostics(selectedImport), [])
      assert.deepEqual(
        Analysis.typeHints(selectedImport, 'main', 0, encoder.encode(selectedImportSource).length)
          .filter((hint) => hint._tag === 'ProviderSelectorTypeHint')
          .map((hint) => hint.presentation.text),
        ['Writer'],
      )

      assert.deepEqual(Analysis.diagnostics(accessForms), [])
      assert.deepEqual(
        Analysis.typeHints(accessForms, 'main', 0, encoder.encode(accessFormsSource).length)
          .filter((hint) => hint._tag === 'ProviderSelectorTypeHint')
          .map((hint) => hint.presentation.text),
        ['Clock', 'Clock'],
      )
      return undefined
    }),
  )
})

it.effect('omits ambiguous and invalid selectors while preserving recovered facts', () => {
  const ambiguousSource = `import silk.effect { Effect }
service Alpha {}
service Beta {}
struct Provider {}
impl Alpha for Provider {}
impl Beta for Provider {}
effect fn work() -> i32 ? &Alpha | &Beta { return 42 }
pub fn main() -> i32 {
  let provider = Provider {}
  let recipe = work() |> Effect.provide(&provider)
  return 0
}`
  const recoveredSource = `import silk.effect { Effect }
service Clock {}
struct FixedClock {}
impl Clock for FixedClock {}
effect fn read() -> i32 ? &Clock { return 42 }
pub fn main() -> i32 {
  let clock = FixedClock {}
  let valid = read() |> Effect.provide(&clock)
  let invalid = read() |> Effect.provide(&missing)
  return Effect.
}`
  return Effect.all([
    Analysis.ofSource('main', encoder.encode(ambiguousSource)),
    Analysis.ofSource('main', encoder.encode(recoveredSource)),
  ]).pipe(
    Effect.map(([ambiguous, recovered]) => {
      assert.include(
        Analysis.diagnostics(ambiguous).map((diagnostic) => diagnostic.code),
        'SEM0125',
      )
      assert.deepEqual(
        Analysis.typeHints(ambiguous, 'main', 0, encoder.encode(ambiguousSource).length).filter(
          (hint) => hint._tag === 'ProviderSelectorTypeHint',
        ),
        [],
      )

      assert.isAbove(Analysis.diagnostics(recovered).length, 0)
      assert.deepEqual(
        Analysis.typeHints(recovered, 'main', 0, encoder.encode(recoveredSource).length)
          .filter((hint) => hint._tag === 'ProviderSelectorTypeHint')
          .map((hint) => hint.presentation.text),
        ['Clock'],
      )
      assert.deepEqual(
        Analysis.hoverSubjectAt(
          recovered,
          'main',
          recoveredSource.indexOf('FixedClock'),
        )?.implementedContracts.map((contract) => contract.text),
        ['Clock'],
      )
      return undefined
    }),
  )
})

it.effect('omits explicit provider selectors while retaining binding hints', () => {
  const source = `import silk.os_writer { StdoutWriter }
import silk.writer { Writer, WriterError }
import silk.effect { Effect }

pub effect fn main() -> () ! WriterError {
  let mut streams = StdoutWriter.make()
  return run Writer.writeAll(b"ok\\n")
    |> Effect.provideMut<Writer>(&mut streams)
}`
  return Analysis.ofSource('main', encoder.encode(source), 'x86_64-unknown-linux-gnu').pipe(
    Effect.map((snapshot) => {
      const hints = Analysis.typeHints(snapshot, 'main', 0, encoder.encode(source).length)
      assert.deepEqual(
        hints.map((hint) => hint._tag),
        ['BindingTypeHint'],
      )
      assert.strictEqual(hints.at(0)?.presentation.text, 'StdoutWriter')
      return undefined
    }),
  )
})

it.effect('sorts multiple hover contracts and proves conditional applications', () => {
  const source = `service Beta {}
service Alpha {}
struct Provider {}
impl Beta for Provider {}
impl Alpha for Provider {}

interface Eligible {}
service Wrapped {}
struct Good {}
struct Bad {}
impl Eligible for Good {}
struct Box<T> { value: T }
impl<T: Eligible> Wrapped for Box<T> {}

fn provider() -> Provider { return Provider {} }
fn good() -> Box<Good> { return Box<Good> { value: Good {} } }
fn bad() -> Box<Bad> { return Box<Bad> { value: Bad {} } }
pub fn main() -> i32 { return 0 }`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const contractsAt = (spelling: string) =>
        Analysis.hoverSubjectAt(
          snapshot,
          'main',
          source.indexOf(spelling),
        )?.implementedContracts.map((contract) => contract.text) ?? []

      assert.deepEqual(contractsAt('Provider'), ['Alpha', 'Beta'])
      assert.deepEqual(contractsAt('provider()'), ['Alpha', 'Beta'])
      assert.deepEqual(contractsAt('good()'), ['Wrapped'])
      assert.deepEqual(contractsAt('bad()'), [])
      return undefined
    }),
  )
})

it.effect('qualifies same-spelled contracts and excludes invalid conformances', () => {
  const qualifiedSource = `import contracts
service Contract {}
struct Provider {}
impl Contract for Provider {}
impl contracts.Contract for Provider {}
pub fn main() -> Provider { return Provider {} }`
  const contracts = `pub service Contract {}`
  const invalidSource = `service Broken { fn value() -> i32 }
struct Provider {}
impl Broken for Provider {}
pub fn main() -> Provider { return Provider {} }`
  return Effect.all([
    Analysis.make({ root: 'main' }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make('main', encoder.encode(qualifiedSource))]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(new Map([['contracts', encoder.encode(contracts)]])),
          ),
        ),
      ),
    ),
    Analysis.ofSource('main', encoder.encode(invalidSource)),
  ]).pipe(
    Effect.map(([qualified, invalid]) => {
      assert.deepEqual(
        Analysis.hoverSubjectAt(
          qualified,
          'main',
          qualifiedSource.indexOf('Provider'),
        )?.implementedContracts.map((contract) => contract.text),
        ['contracts.Contract', 'Contract'],
      )
      assert.isAbove(Analysis.diagnostics(invalid).length, 0)
      assert.deepEqual(
        Analysis.hoverSubjectAt(invalid, 'main', invalidSource.indexOf('Provider'))
          ?.implementedContracts,
        [],
      )
      return undefined
    }),
  )
})

it.effect('hints user-defined provider-selection combinators without name checks', () => {
  const source = `service Clock {}
struct FixedClock {}
impl Clock for FixedClock {}

effect fn read() -> i32 ? &mut Clock { return 42 }

effect fn bind<?S, A, P, E, ?R>(
  self: once Effect<A ! E ? R>,
  provider: &mut P
) -> A ! E ? Without<R, S>
where &mut P provides S from R {
  return run Intrinsic.bindRequirementMut<S>(move self, provider)
}

pub fn main() -> i32 {
  let mut clock = FixedClock {}
  return run bind(read(), &mut clock)
}`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const hints = Analysis.typeHints(snapshot, 'main', 0, encoder.encode(source).length)
      const selector = hints.find((hint) => hint._tag === 'ProviderSelectorTypeHint')
      assert.strictEqual(selector?.presentation.text, 'Clock')
      assert.strictEqual(selector?.span.start, source.indexOf('bind(read') + 'bind'.length)
      return undefined
    }),
  )
})

it.effect('excludes conformances whose provider or contract endpoint is private', () => {
  const root = `import lib
pub fn main() -> i32 {
  let provider = lib.make()
  return 0
}`
  const privateContractLibrary = `service Hidden {}
pub struct Provider {}
impl Hidden for Provider {}
pub fn make() -> Provider { return Provider {} }`
  const privateProviderLibrary = `pub service Visible {}
struct Provider {}
impl Visible for Provider {}
pub fn make() -> Provider { return Provider {} }`
  const analyze = Effect.fnUntraced(function* (library: string) {
    return yield* Analysis.make({ root: 'main' }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make('main', encoder.encode(root))]).pipe(
          Layer.provideMerge(SourceResolver.memory(new Map([['lib', encoder.encode(library)]]))),
        ),
      ),
    )
  })
  return Effect.all([analyze(privateContractLibrary), analyze(privateProviderLibrary)]).pipe(
    Effect.map((snapshots) => {
      for (const snapshot of snapshots) {
        assert.deepEqual(
          Analysis.hoverSubjectAt(snapshot, 'main', root.indexOf('make'))?.implementedContracts,
          [],
        )
        assert.deepEqual(
          Analysis.hoverSubjectAt(snapshot, 'main', root.indexOf('provider'))?.implementedContracts,
          [],
        )
      }
      return undefined
    }),
  )
})

it.effect(
  'retains exact semantic tokens for calls, constructors, initializers, and projections',
  () => {
    const source = `import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
struct Pair { left: i32 }
fn pick() -> i32 {
  let pair = Pair { left: 1 }
  let allocator = Allocator.systemAllocatorProvider()
  return pair.left
}`
    return Analysis.ofSource('main', encoder.encode(source)).pipe(
      Effect.map((snapshot) => {
        const selectedText = (spelling: string, from = 0): string | undefined => {
          const offset = source.indexOf(spelling, from)
          const occurrence = Analysis.semanticOccurrenceAt(snapshot, 'main', offset)
          return occurrence === undefined
            ? undefined
            : source.slice(occurrence.span.start, occurrence.span.end)
        }
        const constructor = source.indexOf('Pair {')
        const initializer = source.indexOf('left:', constructor)
        const qualifier = source.indexOf('Allocator.system')
        const member = source.indexOf('systemAllocatorProvider')
        const projection = source.lastIndexOf('left')
        assert.strictEqual(selectedText('Pair', constructor), 'Pair')
        assert.strictEqual(selectedText('left', initializer), 'left')
        assert.strictEqual(selectedText('Allocator', qualifier), 'Allocator')
        assert.strictEqual(
          selectedText('systemAllocatorProvider', member),
          'systemAllocatorProvider',
        )
        assert.strictEqual(selectedText('left', projection), 'left')
        return undefined
      }),
    )
  },
)

const genericNominalSource = `struct Problem {}
struct Box<T> { value: T }
fn unwrap(box: Box<Problem>) -> Problem { return box.value }
pub fn main() -> i32 { return 0 }`

it.effect('recursively indexes generic nominal and type-parameter references', () =>
  Analysis.ofSource('main', encoder.encode(genericNominalSource)).pipe(
    Effect.map((snapshot) => {
      const source = genericNominalSource
      const typeParameterUse = occurrenceAt(snapshot, source, 'T', 1)
      const appliedTarget = occurrenceAt(snapshot, source, 'Box', 1)
      const appliedArgument = occurrenceAt(snapshot, source, 'Problem', 1)
      assert.strictEqual(typeParameterUse?.role, 'Type')
      assert.strictEqual(appliedTarget?.role, 'Type')
      assert.strictEqual(appliedArgument?.role, 'Type')
      assert.isDefined(typeParameterUse?.declaration)
      assert.isDefined(appliedTarget?.declaration)
      assert.isDefined(appliedArgument?.declaration)
      return undefined
    }),
  ),
)

it.effect('indexes every row-expression and constraint binder reference', () => {
  const source = `effect fn bind<?S, P, ?R>(
  self: once Effect<i32 ? R>,
  provider: &mut P
) -> i32 ? Without<R, S>
where &mut P provides S from R {
  return run self
}`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const occurrences = snapshot.semanticOccurrences.modules.get('main')?.occurrences ?? []
      const spellings = occurrences.map((occurrence) =>
        decoder.decode(encoder.encode(source).slice(occurrence.span.start, occurrence.span.end)),
      )
      const count = (spelling: string): number =>
        spellings.filter((candidate) => candidate === spelling).length

      assert.strictEqual(count('S'), 3)
      assert.strictEqual(count('P'), 3)
      assert.strictEqual(count('R'), 4)
      for (const spelling of ['S', 'P', 'R']) {
        const references = occurrences.filter(
          (occurrence, ordinal) =>
            spellings.at(ordinal) === spelling && occurrence.role !== 'Declaration',
        )
        assert.isTrue(references.length > 0)
        assert.isTrue(references.every((occurrence) => occurrence.role === 'Type'))
        assert.isTrue(references.every((occurrence) => occurrence.declaration !== undefined))
      }
      return undefined
    }),
  )
})

it.effect('completes from the innermost lexical scope and excludes later declarations', () => {
  const source = nestedBindingSource
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const analysis = Analysis.rootAnalysis(snapshot)
      const scopes = analysis.lexicalScopes
      assert.isTrue(scopes.some((scope) => scope.parent !== undefined))

      const nestedOffset = encoder.encode(source.slice(0, source.indexOf('val\n') + 3)).length
      const nested = Analysis.completionAt(snapshot, 'main', nestedOffset)
      const values =
        nested?.candidates.filter((candidate) => candidate.label === 'value') ?? Object.freeze([])
      assert.strictEqual(values.length, 1)
      const innerBinding = records(analysis)
        .functions.at(0)
        ?.bindings.filter((binding) => binding.name === 'value')
        .at(-1)
      const identity = values.at(0)?.identity
      assert.strictEqual(
        identity?._tag === 'SemanticCandidate' && identity.identity._tag === 'BindingIdentity'
          ? identity.identity.id.ordinal
          : undefined,
        innerBinding?.id.ordinal,
      )

      const beforeOffset = encoder.encode(source.slice(0, source.indexOf('lat\n') + 3)).length
      const before = Analysis.completionAt(snapshot, 'main', beforeOffset)
      assert.notInclude(before?.candidates.map((candidate) => candidate.label) ?? [], 'later')
      return undefined
    }),
  )
})

it.effect('includes match pattern bindings only inside their arm scope', () => {
  const source = `struct Full { value: i32 }
pub fn main() -> i32 {
  let full = Full { value: 1 }
  return match move full {
    Full { value } => val
  }
}`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const offset = encoder.encode(source.slice(0, source.lastIndexOf('val') + 3)).length
      const completion = Analysis.completionAt(snapshot, 'main', offset)
      const value = completion?.candidates.find((candidate) => candidate.label === 'value')
      assert.strictEqual(
        value?.identity._tag === 'SemanticCandidate' ? value.identity.identity._tag : undefined,
        'PatternBindingIdentity',
      )
      return undefined
    }),
  )
})

it.effect('scopes let-pattern and if-let bindings for completion and navigation', () => {
  const source = `struct Full { value: i32 }
pub fn main() -> i32 {
  let first = Full { value: 1 }
  let Full { value } = move first
  let copied = val
  let second = Full { value: 2 }
  if let Full inner = &second { let taken = inn } else { let missed = inn }
  return value
}`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const atCompletion = (prefix: string) =>
        Analysis.completionAt(snapshot, 'main', source.indexOf(prefix) + prefix.length)
      assert.include(
        atCompletion('let copied = val')?.candidates.map((candidate) => candidate.label) ?? [],
        'value',
      )
      assert.include(
        atCompletion('let taken = inn')?.candidates.map((candidate) => candidate.label) ?? [],
        'inner',
      )
      assert.notInclude(
        atCompletion('let missed = inn')?.candidates.map((candidate) => candidate.label) ?? [],
        'inner',
      )

      const declarationOffset = source.indexOf('value }')
      const useOffset = source.lastIndexOf('value')
      const declaration = Analysis.semanticOccurrenceAt(snapshot, 'main', declarationOffset)
      const use = Analysis.semanticOccurrenceAt(snapshot, 'main', useOffset)
      assert.strictEqual(declaration?.role, 'Declaration')
      assert.strictEqual(use?.declaration?.selectionSpan.start, declaration?.span.start)
      assert.strictEqual(
        Analysis.hoverSubjectAt(snapshot, 'main', useOffset)?.presentation.text,
        'let value: i32',
      )
      assert.strictEqual(
        Projections.statementsOf(snapshot, 'main').filter((statement) => statement._tag === 'Bind')
          .length,
        5,
      )
      return undefined
    }),
  )
})

it.effect('retains exact import, alias, qualifier, and unavailable-member tokens', () => {
  const root = `import lib as Library { answer as read, hidden }
pub fn main() -> i32 { return read() }`
  const library = `pub fn answer() -> i32 { return 42 }
fn hidden() -> i32 { return 0 }`
  return Analysis.make({ root: 'root' }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make('root', encoder.encode(root))]).pipe(
        Layer.provideMerge(SourceResolver.memory(new Map([['lib', encoder.encode(library)]]))),
      ),
    ),
    Effect.map((snapshot) => {
      const at = (spelling: string, occurrence = 0) => {
        let offset = -1
        for (let index = 0; index <= occurrence; index += 1)
          offset = root.indexOf(spelling, offset + 1)
        return Analysis.semanticOccurrenceAt(snapshot, 'root', offset)
      }
      const alias = at('Library')
      const sourceMember = at('answer')
      const localMember = at('read')
      const use = at('read', 1)
      const unavailable = at('hidden')
      assert.strictEqual(alias?.role, 'Import')
      assert.strictEqual(alias?.declaration?.module, 'root')
      assert.strictEqual(sourceMember?.role, 'Import')
      assert.strictEqual(sourceMember?.declaration?.module, 'lib')
      assert.strictEqual(localMember?.role, 'Import')
      assert.strictEqual(localMember?.span.start, root.indexOf('read'))
      assert.strictEqual(use?.declaration?.module, 'lib')
      assert.strictEqual(unavailable?.resolution._tag, 'Unavailable')
      return undefined
    }),
  )
})

it.effect('keeps struct field tooling visibility-aware across modules', () => {
  const root = `import lib
fn invalid() -> i32 {
  let secret = lib.Secret { value: 1, key: 2 }
  return 0
}
pub fn main() -> i32 {
  let secret = lib.make(1)
  return secret.
}`
  const library = `pub struct Secret { pub value: i32 key: i32 }
pub fn make(value: i32) -> Secret { return Secret { value: value, key: 7 } }`
  return Analysis.make({ root: 'main' }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make('main', encoder.encode(root))]).pipe(
        Layer.provideMerge(SourceResolver.memory(new Map([['lib', encoder.encode(library)]]))),
      ),
    ),
    Effect.map((snapshot) => {
      const completionOffset = root.lastIndexOf('secret.') + 'secret.'.length
      const labels = Analysis.completionAt(snapshot, 'main', completionOffset)?.candidates.map(
        (candidate) => candidate.label,
      )
      assert.include(labels ?? [], 'value')
      assert.notInclude(labels ?? [], 'key')

      const privateInitializer = Analysis.semanticOccurrenceAt(
        snapshot,
        'main',
        root.indexOf('key:'),
      )
      assert.strictEqual(privateInitializer?.resolution._tag, 'Available')
      assert.strictEqual(privateInitializer?.declaration?.module, 'lib')
      assert.include(
        Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
        'SEM0021',
      )
      return undefined
    }),
  )
})

it.effect('renders inferred types through unambiguous imports and canonical fallbacks', () => {
  const root = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.box { Box }
import types.Models
import types.Models { Box as Selected }
struct Selected {}
struct Problem {}
pub fn main() -> i32 { return 0 }`
  const models = `pub struct Box<T> { value: T }
pub struct Other {}`
  return Analysis.make({ root: 'main' }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make('main', encoder.encode(root))]).pipe(
        Layer.provideMerge(
          SourceResolver.memory(new Map([['types/Models', encoder.encode(models)]])),
        ),
      ),
    ),
    Effect.map((snapshot) => {
      const scope = NameResolution.scopeOf(snapshot.resolution, 'main')
      const box = Type.nominal('types/Models', 'Box', Object.freeze(['i32']))
      const other = Type.nominal('types/Models', 'Other')
      const problem = Type.nominal('main', 'Problem')
      const failureRow = Type.parameter({ module: 'main', name: 'transform' }, 0, 'E')
      const requirementRow = Type.parameter(
        { module: 'main', name: 'transform' },
        1,
        'R',
        'RequirementRow',
      )
      assert.strictEqual(Presentation.type(box, 'main', scope), 'Models.Box<i32>')
      assert.strictEqual(Presentation.type(other, 'main', scope), 'Models.Other')
      assert.strictEqual(Presentation.type(box, 'detached'), 'types/Models.Box<i32>')
      assert.strictEqual(
        Presentation.scopedNominal(Type.nominal('silk/allocator', 'Allocator'), 'main', scope).text,
        'Allocator',
      )
      assert.strictEqual(Presentation.scopedNominal(box, 'main', scope).text, 'Models.Box<i32>')

      const effect = Type.effect(
        Type.reference('Exclusive', box, Lifetime.staticLifetime),
        [problem, failureRow],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
        [
          Object.freeze({
            capability: Type.nominal('silk/allocator', 'Allocator'),
            role: 'Heap',
            access: 'Exclusive' as const,
          }),
        ],
        [requirementRow],
      )
      assert.strictEqual(
        Presentation.type(effect, 'main', scope),
        "Effect<'static; &'static mut Models.Box<i32> ! Problem | E ? &mut Allocator at Heap | R>",
      )
      const retainedType = Type.parameter({ module: 'main', name: 'retain' }, 0, 'T')
      const retainedEnvironment = Lifetime.bound({ module: 'main', name: 'retain' }, 1, 'env')
      const retained = Type.effect('i32', [], {
        environment: retainedEnvironment,
        lifetimeBinders: [],
        typeOutlives: [{ type: retainedType, lifetime: retainedEnvironment }],
      })
      const retainedPresentation = Presentation.expressionType(retained, 'main', scope)
      assert.strictEqual(retainedPresentation.text, "Effect<'env; i32>")
      assert.deepEqual(retainedPresentation.lifetimeRequirements, ["T: 'env"])
      assert.strictEqual(
        Presentation.genericArgument(Type.failureValue([problem]), 'main', scope),
        'Problem',
      )
      assert.strictEqual(
        Presentation.genericArgument(
          Type.requirementRowArgument([
            {
              capability: Type.nominal('silk/allocator', 'Allocator'),
              role: 'Heap',
              access: 'Exclusive',
            },
          ]),
          'main',
          scope,
        ),
        '? &mut Allocator at Heap',
      )
      const union = Type.union(
        Object.freeze([problem, Type.nominal('silk/allocator', 'OutOfMemoryError')]),
      )
      assert.strictEqual(
        union._tag === 'Normalized' ? Presentation.type(union.type, 'main', scope) : undefined,
        'Problem | OutOfMemoryError',
      )
      return undefined
    }),
  )
})

it.effect('keeps recovered Unicode-adjacent occurrence indexes compact and deterministic', () => {
  const source = `import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
// π🙂
struct Problem {}
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return 0
}
fn damaged( -> {`
  return Effect.gen(function* () {
    const first = yield* Analysis.ofSource('main', encoder.encode(source))
    const second = yield* Analysis.ofSource('main', encoder.encode(source))
    const firstIndex = first.semanticOccurrences.modules.get('main')
    const secondIndex = second.semanticOccurrences.modules.get('main')
    assert.deepEqual(secondIndex, firstIndex)
    assert.strictEqual(firstIndex?.prefixMaximumEnd.length, firstIndex?.occurrences.length)

    const byteOffset = encoder.encode(
      source.slice(0, source.indexOf('let mut allocator') + 'let mut '.length),
    ).length
    const occurrence = Analysis.semanticOccurrenceAt(first, 'main', byteOffset)
    assert.strictEqual(occurrence?.role, 'Declaration')
    assert.isDefined(occurrence?.declaration)
    assert.isUndefined(
      occurrence === undefined
        ? undefined
        : Analysis.semanticOccurrenceAt(first, 'main', occurrence.span.end),
    )
    return undefined
  })
})

it.effect('preserves ambiguous, missing, namespace, and type completion contexts', () =>
  Effect.gen(function* () {
    // Two bindings the module wrote itself still collide, and an ambiguous qualifier offers nothing.
    const ambiguousSource = `import silk.vector { Vector }
struct Vector {}
pub fn main() -> i32 { return Vector. }`
    const ambiguous = yield* Analysis.ofSource('main', encoder.encode(ambiguousSource))
    const ambiguousResult = Analysis.completionAt(
      ambiguous,
      'main',
      ambiguousSource.indexOf('return Vector.') + 'return Vector.'.length,
    )
    assert.deepEqual(ambiguousResult?.context, {
      _tag: 'ValueMemberContext',
      state: 'Ambiguous',
    })
    assert.deepEqual(ambiguousResult?.candidates, [])

    // A seeded standard-library namespace is a prelude, so a local declaration of the same spelling
    // takes it rather than colliding with it: the qualifier is the empty local struct, which has no
    // inherent members to offer, and completion is empty rather than ambiguous.
    const shadowedSource = `struct SystemAllocator {}
pub fn main() -> i32 { return SystemAllocator. }`
    const shadowed = yield* Analysis.ofSource('main', encoder.encode(shadowedSource))
    const shadowedResult = Analysis.completionAt(
      shadowed,
      'main',
      shadowedSource.indexOf('SystemAllocator.') + 'SystemAllocator.'.length,
    )
    assert.deepEqual(shadowedResult?.context, {
      _tag: 'ActorMemberContext',
      actor: 'SystemAllocator',
    })
    assert.deepEqual(shadowedResult?.candidates, [])
    // The source is deliberately truncated after the dot, so it carries the parser's recovery
    // diagnostic; what matters is that no binding collision joins it.
    assert.notInclude(
      Analysis.diagnostics(shadowed).map((diagnostic) => diagnostic.code),
      'SEM0016',
    )

    const missingSource = `pub fn main() -> i32 { return Mystery. }`
    const missing = yield* Analysis.ofSource('main', encoder.encode(missingSource))
    assert.deepEqual(
      Analysis.completionAt(missing, 'main', missingSource.indexOf('Mystery.') + 'Mystery.'.length)
        ?.context,
      { _tag: 'ValueMemberContext', state: 'Missing' },
    )

    const namespaceSource = `import lib
struct Local {}
pub fn main(value: i32) -> i32 { return lib. }`
    const namespace = yield* Analysis.make({
      root: 'main',
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make('main', encoder.encode(namespaceSource))]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map([
                [
                  'lib',
                  encoder.encode(
                    'pub fn visible() -> i32 { return 1 }\nfn hidden() -> i32 { return 0 }',
                  ),
                ],
              ]),
            ),
          ),
        ),
      ),
    )
    const namespaceResult = Analysis.completionAt(
      namespace,
      'main',
      namespaceSource.indexOf('lib.') + 'lib.'.length,
    )
    assert.deepEqual(namespaceResult?.context, { _tag: 'ActorMemberContext', actor: 'lib' })
    assert.include(namespaceResult?.candidates.map((candidate) => candidate.label) ?? [], 'visible')
    assert.notInclude(
      namespaceResult?.candidates.map((candidate) => candidate.label) ?? [],
      'hidden',
    )

    const serviceSource = `service LocalLogger { fn enabled() -> bool }
pub fn main() -> i32 { return LocalLogger. }`
    const serviceSnapshot = yield* Analysis.ofSource('main', encoder.encode(serviceSource))
    const serviceResult = Analysis.completionAt(
      serviceSnapshot,
      'main',
      serviceSource.indexOf('LocalLogger.') + 'LocalLogger.'.length,
    )
    assert.deepEqual(serviceResult?.context, {
      _tag: 'ActorMemberContext',
      actor: 'LocalLogger',
    })
    assert.deepEqual(
      serviceResult?.candidates.map((candidate) => candidate.label),
      ['enabled'],
    )

    const importedServiceSource = `import contracts { ContractLogger }
pub fn main() -> i32 { return ContractLogger. }`
    const importedService = yield* Analysis.make({
      root: 'main',
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make('main', encoder.encode(importedServiceSource)),
        ]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map([
                [
                  'contracts',
                  encoder.encode('pub service ContractLogger { fn enabled() -> bool }'),
                ],
              ]),
            ),
          ),
        ),
      ),
    )
    const importedServiceResult = Analysis.completionAt(
      importedService,
      'main',
      importedServiceSource.indexOf('ContractLogger.') + 'ContractLogger.'.length,
    )
    assert.deepEqual(importedServiceResult?.context, {
      _tag: 'ActorMemberContext',
      actor: 'ContractLogger',
    })
    assert.deepEqual(
      importedServiceResult?.candidates.map((candidate) => candidate.label),
      ['enabled'],
    )

    const typeSource = `struct Local {}
union LocalChoice { Empty }
service Logger { fn enabled() -> bool }
fn identity<T>(value: ) -> i32 { return 0 }`
    const typeSnapshot = yield* Analysis.ofSource('main', encoder.encode(typeSource))
    const typeResult = Analysis.completionAt(
      typeSnapshot,
      'main',
      typeSource.indexOf('value: ') + 'value: '.length,
    )
    assert.deepEqual(typeResult?.context, { _tag: 'DeclaredTypeContext' })
    assert.include(typeResult?.candidates.map((candidate) => candidate.label) ?? [], 'Local')
    assert.include(typeResult?.candidates.map((candidate) => candidate.label) ?? [], 'LocalChoice')
    assert.include(typeResult?.candidates.map((candidate) => candidate.label) ?? [], 'Logger')
    assert.include(typeResult?.candidates.map((candidate) => candidate.label) ?? [], 'f32')
    assert.include(typeResult?.candidates.map((candidate) => candidate.label) ?? [], 'f64')
    assert.include(typeResult?.candidates.map((candidate) => candidate.label) ?? [], 'string')
    assert.notInclude(typeResult?.candidates.map((candidate) => candidate.label) ?? [], 'true')

    const importedUnionSource = `import contracts { ContractChoice }
fn identity(value: ) -> i32 { return 0 }`
    const importedUnion = yield* Analysis.make({
      root: 'main',
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make('main', encoder.encode(importedUnionSource))]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map([['contracts', encoder.encode('pub union ContractChoice { Empty }')]]),
            ),
          ),
        ),
      ),
    )
    const importedUnionResult = Analysis.completionAt(
      importedUnion,
      'main',
      importedUnionSource.indexOf('value: ') + 'value: '.length,
    )
    assert.include(
      importedUnionResult?.candidates.map((candidate) => candidate.label) ?? [],
      'ContractChoice',
    )
  }),
)

it.effect('presents and completes the sealed suspension intrinsic with its exact rows', () => {
  const source = `pub fn main() -> i32 {
  let deferred = Intrinsic.suspendEffect(effect { return 42 })
  let pending = Intrinsic.
  return 42
}`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const operationOffset = source.indexOf('suspendEffect')
      const hover = Analysis.hoverSubjectAt(snapshot, 'main', operationOffset)
      assert.strictEqual(
        hover?.presentation.text,
        'fn Intrinsic.suspendEffect<A, E, ?R>(deferred: once Effect<A ! E ? R>) -> Effect<A ! E ? R>',
      )

      const completionOffset = encoder.encode(
        source.slice(0, source.indexOf('Intrinsic.', operationOffset) + 'Intrinsic.'.length),
      ).length
      const completion = Analysis.completionAt(snapshot, 'main', completionOffset)
      const candidate = completion?.candidates.find(
        (candidate) => candidate.label === 'suspendEffect',
      )
      assert.strictEqual(
        candidate?.detail?.text,
        'fn Intrinsic.suspendEffect<A, E, ?R>(deferred: once Effect<A ! E ? R>) -> Effect<A ! E ? R>',
      )
      return undefined
    }),
  )
})

it.effect('keeps inherent members out of a module-namespace completion', () => {
  const shapes = `pub struct Counter { value: i32 }
impl Counter { pub fn make() -> Self { return Counter { value: 1 } } }
pub fn helper() -> i32 { return 1 }
`
  const source = `import shapes
pub fn main() -> i32 { let value = shapes. return 0 }`
  return Analysis.make({ root: 'main' }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make('main', encoder.encode(source))]).pipe(
        Layer.provideMerge(SourceResolver.memory(new Map([['shapes', encoder.encode(shapes)]]))),
      ),
    ),
    Effect.map((snapshot) => {
      const offset = source.indexOf('shapes.') + 'shapes.'.length
      const completion = Analysis.completionAt(snapshot, 'main', offset)
      assert.deepEqual(
        [...(completion?.candidates.map((candidate) => candidate.label) ?? [])].sort(),
        ['Counter', 'helper'],
      )
      return undefined
    }),
  )
})

it.effect('completes members of the aliased owner after a type-alias qualifier', () => {
  const source = `pub struct Counter { value: i32 }
impl Counter { pub fn make() -> Self { return Counter { value: 1 } } }
type Tally = Counter
pub fn main() -> i32 { let value = Tally. return 0 }`
  return Analysis.ofSource('main', encoder.encode(source)).pipe(
    Effect.map((snapshot) => {
      const offset = source.indexOf('Tally.') + 'Tally.'.length
      const completion = Analysis.completionAt(snapshot, 'main', offset)
      assert.deepEqual(
        completion?.candidates.map((candidate) => [candidate.label, candidate.kind]),
        [['make', 'AssociatedFunction']],
      )
      return undefined
    }),
  )
})
