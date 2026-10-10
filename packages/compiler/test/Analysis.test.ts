import { records } from './support/records.js'
import * as Layer from 'effect/Layer'
import * as CompilerTrace from '../src/CompilerTrace.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Clock from 'effect/Clock'
import * as Option from 'effect/Option'
import * as Tracer from 'effect/Tracer'
import * as Analysis from '../src/Analysis.js'
import * as Frontend from '../src/Frontend.js'
import type * as ModuleClosure from '../src/ModuleClosure.js'
import * as ConformanceProof from '../src/ConformanceProof.js'
import * as ExecutableProperty from '../src/ExecutableProperty.js'
import * as ExecutionAffinity from '../src/ExecutionAffinity.js'
import * as ExecutionLifecycle from '../src/ExecutionLifecycle.js'
import * as Tir from '../src/Tir.js'
import * as Lifetime from '../src/Lifetime.js'
import * as LocalSharedOwnership from '../src/LocalSharedOwnership.js'
import * as ExpressionNesting from '../src/Parser/ExpressionNesting.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as SemanticDisplay from '../src/SemanticDisplay.js'
import * as SyntaxTree from '../src/SyntaxTree.js'
import * as Type from '../src/Type.js'
import { invalidMatchCorpus } from './support/corpus.js'
import * as Projections from './support/projections.js'
import { raise, unreachable } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

it.effect('runs unobserved synchronous passes without reading the trace clock', () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const value = { answer: 42 }
    const defect = new Error('unobserved pass defect')
    yield* Effect.gen(function* () {
      const trace = yield* CompilerTrace.capture()
      assert.strictEqual(
        trace('outer', () => trace('inner', () => value)),
        value,
      )
      assert.throws(
        () =>
          trace('failed', () => {
            throw defect
          }),
        defect,
      )
    }).pipe(
      Effect.withTracer(Tracer.nativeTracer),
      Effect.withTracerEnabled(true),
      Effect.withTracerTiming(true),
      Effect.provideService(Clock.Clock, {
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
        currentTimeMillis: clock.currentTimeMillis,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        currentTimeNanos: clock.currentTimeNanos,
        sleep: (duration) => clock.sleep(duration),
        currentTimeNanosUnsafe: () => unreachable('an unobserved pass has no trace timestamp'),
      }),
    )
  }),
)

it.effect('preserves synchronous trace nesting, results, and defects', () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.Span> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const value = { answer: 42 }
    const defect = new Error('trace probe')
    yield* Effect.gen(function* () {
      const trace = yield* CompilerTrace.capture()
      assert.strictEqual(
        trace('outer', () => trace('inner', () => value)),
        value,
      )
      assert.throws(
        () =>
          trace('failed', () =>
            trace('failedChild', () => {
              throw defect
            }),
          ),
        defect,
      )
      trace('sibling', () => undefined, { 'function.name': 'probe' })
    }).pipe(Effect.withSpan('root'), Effect.withTracer(tracer))
    const span = (name: string) => spans.find((item) => item.name === name) ?? unreachable(name)
    for (const [child, parent] of [
      ['outer', 'root'],
      ['inner', 'outer'],
      ['failedChild', 'failed'],
      ['sibling', 'root'],
    ] as const) {
      assert.strictEqual(Option.getOrUndefined(span(child).parent)?.spanId, span(parent).spanId)
    }
    for (const item of spans) assert.strictEqual(item.status._tag, 'Ended')
    for (const name of ['failed', 'failedChild']) {
      const status = span(name).status
      assert.strictEqual(status._tag === 'Ended' && status.exit._tag, 'Failure')
    }
    assert.strictEqual(span('sibling').attributes.get('function.name'), 'probe')
    const count = spans.length
    yield* Effect.gen(function* () {
      const trace = yield* CompilerTrace.capture()
      assert.strictEqual(
        trace('disabled', () => value),
        value,
      )
    }).pipe(Effect.withTracerEnabled(false), Effect.withTracer(tracer))
    assert.strictEqual(spans.length, count)
  }),
)

it.effect('traces frontend stages through ordinary, selected, and incomplete-profile returns', () =>
  Effect.gen(function* () {
    const conditional = ascii(`
static if Intrinsic.targetOperatingSystem() == "darwin" {
  pub fn value() -> i32 { return 1 }
} else {
  pub fn value() -> i32 { return 2 }
}`)
    const requests: ReadonlyArray<ModuleClosure.CompilationRequest> = [
      { root: 'ordinary' },
      {
        root: 'selected',
        configuration: {
          profile: {
            target: 'aarch64-apple-darwin',
            artifact: 'object',
            runtime: { kind: 'none' },
          },
        },
      },
      { root: 'incomplete' },
    ]
    for (const request of requests) {
      const spans: Array<Tracer.Span> = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const frontend = yield* Frontend.frontend(request).pipe(
        Effect.provide(
          SourceResolver.memory(
            new Map([
              [
                request.root,
                request.root === 'ordinary'
                  ? ascii('pub fn value() -> i32 { return 0 }')
                  : conditional,
              ],
            ]),
          ),
        ),
        Effect.withTracer(tracer),
      )
      const root =
        spans.find((span) => span.name === 'Frontend.frontend') ?? unreachable('frontend span')
      assert.strictEqual(root.attributes.get('frontend.root'), request.root)
      assert.strictEqual(
        root.attributes.get('frontend.requiresSelection'),
        request.root !== 'ordinary',
      )
      for (const name of [
        'normalizeProfile',
        'decodeBindings',
        'snapshotConfiguration',
        'assembleSnapshot',
      ]) {
        const span = spans.find((span) => span.name === `Frontend.${name}`) ?? unreachable(name)
        assert.strictEqual(Option.getOrUndefined(span.parent)?.spanId, root.spanId)
      }
      for (const span of spans) assert.strictEqual(span.status._tag, 'Ended', span.name)
      assert.isTrue(spans.some((span) => span.name === 'Source.load'))
      assert.isTrue(spans.some((span) => span.name === 'Hir.lower'))
      assert.isFalse(spans.some((span) => span.name.startsWith('PhaseReport.measure')))
      if (request.root === 'incomplete') {
        assert.isTrue(spans.some((span) => span.name === 'Frontend.diagnoseIncompleteProfile'))
        assert.isFalse(spans.some((span) => span.name === 'Frontend.analyzeFrontend'))
        assert.isAbove(frontend.diagnostics.length, 0)
      } else {
        assert.deepEqual(frontend.diagnostics, [])
        assert.isTrue(spans.some((span) => span.name === 'Frontend.analyzeSemantics'))
        assert.isTrue(spans.some((span) => span.name === 'Semantic.checkBody'))
        assert.strictEqual(frontend.selection !== undefined, request.root === 'selected')
        if (request.root === 'selected')
          assert.isTrue(spans.some((span) => span.name === 'Evaluation.evaluate'))
      }
    }
  }),
)

const snapshot = (
  rootModule: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Effect.Effect<Analysis.Snapshot, ModuleClosure.ModuleClosureError> => {
  const rootText = entries.find(([name]) => name === rootModule)?.[1]
  if (rootText === undefined) throw new RangeError(`Fixture has no root source ${rootModule}`)
  const imports = new Map(
    entries
      .filter(([name]) => name !== rootModule)
      .map(([name, text]) => [name, ascii(text)] as const),
  )
  return Analysis.makeRealized({
    root: rootModule,
    configuration: AnalysisFixture.configuration(rootModule),
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make(rootModule, ascii(rootText))]).pipe(
        Layer.provideMerge(SourceResolver.memory(imports)),
      ),
    ),
  )
}

it.effect('answers multi-module queries from one snapshot', () =>
  Effect.gen(function* () {
    const self = yield* snapshot('root', [
      ['root', 'import lib\npub fn main() -> i32 { return 42 }'],
      ['lib', 'pub fn answer() -> i32 { return 1 }'],
    ])
    assert.deepEqual(
      Analysis.modules(self).map((module) => module.name),
      ['lib', 'root'],
    )
    assert.strictEqual(Projections.syntaxOf(self, 'lib')?.source.id, 'lib')
    assert.strictEqual(Analysis.declarationByName(self, 'lib', 'answer')._tag, 'Resolved')
    assert.strictEqual(Analysis.declarationByName(self, 'root', 'answer')._tag, 'Missing')
    assert.strictEqual(Projections.tirOf(self, 'root')?.functions.length, 1)
    assert.strictEqual(Analysis.moduleAnalysis(self, 'absent'), undefined)
    assert.deepEqual(Analysis.cycles(self), [])
    assert.deepEqual([...Analysis.sources(self).keys()], ['lib', 'root'])
  }),
)

it.effect('constructs frontend snapshots for deterministic damaged-source edits', () =>
  Effect.gen(function* () {
    const accepted = `pub fn inspect(value: i32) -> i32 {
  return match value { Token {} => 0 }
}`
    const damaged = [
      accepted.slice(0, accepted.indexOf('Token')),
      accepted.replace('Token {}', '['),
      accepted.replace('Token {}', '&'),
      accepted.replace('Token {}', '('),
      accepted.replace('Token {}', 'fn() -> i32 {}'),
      accepted.replace('Token {}', 'Without<i32, i32> {}'),
      accepted.replace('Token {}', 'Token {'),
      accepted.replace('=> 0', ''),
    ]

    for (const [ordinal, source] of damaged.entries()) {
      const self = yield* Analysis.make({
        root: `damaged-${ordinal}`,
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make(`damaged-${ordinal}`, ascii(source))]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      assert.strictEqual(
        Analysis.moduleSyntax(self, self.closure.rootModule)?.source.id,
        `damaged-${ordinal}`,
      )
    }
  }),
)

it.effect('resolves imported declarations as stored callable values', () =>
  Effect.gen(function* () {
    const source =
      'import lib\npub fn main() -> i32 { let callback = lib.identity return callback(42) }'
    const self = yield* snapshot('root', [
      ['root', source],
      ['lib', 'pub fn identity(value: i32) -> i32 { return value }'],
    ])
    const root = self.results.get('root')
    const main = records(root)?.functions.at(0)
    const binding = main?.statements.at(0)

    assert.strictEqual(
      binding?._tag === 'Bind' ? binding.initializer._tag : undefined,
      'FunctionItem',
    )
    assert.strictEqual(main?.returnedExpression._tag, 'CallableApply')
    assert.strictEqual(
      Analysis.semanticOccurrenceAt(self, 'root', source.indexOf('identity'))?.resolution._tag,
      'Available',
    )
    assert.strictEqual(
      Analysis.semanticOccurrenceAt(self, 'root', source.lastIndexOf('callback'))?.resolution._tag,
      'Available',
    )
    assert.deepEqual(root?.diagnostics, [])
  }),
)

it.effect('indexes automatic section targets and piped callable bindings', () =>
  Effect.gen(function* () {
    const source = `fn add(value: i32, amount: i32) -> i32 { return value + amount }
pub fn main() -> i32 { let increment = add(2) return 40 |> increment }`
    const self = yield* AnalysisFixture.retainingMain('main', ascii(source))

    assert.strictEqual(
      Analysis.semanticOccurrenceAt(self, 'main', source.lastIndexOf('add'))?.resolution._tag,
      'Available',
    )
    assert.strictEqual(
      Analysis.semanticOccurrenceAt(self, 'main', source.lastIndexOf('increment'))?.resolution._tag,
      'Available',
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
  }),
)

it.effect('retains inaccessible imported callable targets without inventing a value lookup', () =>
  Effect.gen(function* () {
    const self = yield* snapshot('root', [
      ['root', 'import lib\npub fn main() -> i32 { let callback = lib.hidden return 0 }'],
      ['lib', 'fn hidden(value: i32) -> i32 { return value }'],
    ])
    const root = self.results.get('root')
    const binding = records(root)?.functions.at(0)?.statements.at(0)
    const initializer = binding?._tag === 'Bind' ? binding.initializer : undefined

    assert.strictEqual(initializer?._tag, 'Unavailable')
    assert.include(root?.diagnostics.map((diagnostic) => diagnostic.code) ?? [], 'SEM0015')
  }),
)

it.effect('merges diagnostics while keeping unrelated facts queryable', () =>
  Effect.gen(function* () {
    const self = yield* snapshot('root', [
      ['root', 'import lib\nimport missing\npub fn main( -> Mystery { return @ 42 }'],
      ['lib', 'pub fn answer() -> i32 { return 1 }'],
    ])
    assert.strictEqual(Analysis.declarationByName(self, 'lib', 'answer')._tag, 'Resolved')
    const libFunction = Projections.tirOf(self, 'lib')?.functions.at(0)
    assert.strictEqual(
      libFunction === undefined ? undefined : Tir.returned(libFunction)._tag,
      'IntegerLiteral',
    )
    assert.include(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      'MOD0001',
    )
  }),
)

it.effect('answers repeated snapshots deterministically', () =>
  Effect.gen(function* () {
    const entries: ReadonlyArray<readonly [string, string]> = [
      ['root', 'import lib\npub fn main() -> i32 { return 42 }'],
      ['lib', 'pub fn same() -> i32 { return 1 }\npub fn same() -> i32 { return 2 }'],
    ]
    const first = yield* snapshot('root', entries)
    const second = yield* snapshot('root', [...entries].reverse())
    assert.deepEqual(first.closure, second.closure)
    assert.deepEqual(first.index, second.index)
    assert.deepEqual(Analysis.diagnostics(first), Analysis.diagnostics(second))
  }),
)

it.effect('reports only actionable diagnostics for empty and final-expression sources', () =>
  Effect.gen(function* () {
    const empty = yield* AnalysisFixture.declarations('memory/empty', new Uint8Array())
    assert.deepEqual(Analysis.diagnostics(empty), [])
    assert.deepEqual(records(Analysis.rootAnalysis(empty)).functions, [])

    const recovered = yield* AnalysisFixture.retainingMain(
      'memory/recovered-return',
      ascii('pub fn main() -> i32 { foo }'),
    )
    assert.deepEqual(
      Analysis.diagnostics(recovered).map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
      })),
      [
        { code: 'SEM0006', message: 'Unknown value foo' },
        { code: 'SEM0130', message: 'A reachable path must return i32' },
      ],
    )
  }),
)

it.effect(
  'answers nominal declaration, field, dependency, and layout facts through the facade',
  () =>
    Effect.gen(function* () {
      const self = yield* AnalysisFixture.retainingMain(
        'memory/nominal-facade',
        ascii('struct Pair { left: i32 right: bool }\npub fn main() -> i32 { return 42 }'),
        'aarch64-apple-darwin',
      )
      const lookup = Analysis.structByName(self, 'memory/nominal-facade', 'Pair')
      assert.strictEqual(
        Analysis.memberByName(self, 'memory/nominal-facade', 'Pair')._tag,
        'Resolved',
      )
      assert.strictEqual(lookup._tag, 'Resolved')
      if (lookup._tag !== 'Resolved') return
      assert.strictEqual(Analysis.fieldByName(lookup.declaration, 'right')._tag, 'Resolved')
      assert.strictEqual(lookup.declaration.dependency._tag, 'Available')
      const layout = Analysis.nominalLayout(self, Type.nominal('memory/nominal-facade', 'Pair'))
      assert.strictEqual(layout?._tag, 'LayoutEntry')
    }),
)

it.effect(
  'keeps cross-module nominal identity and recursive unavailability queryable through the facade',
  () =>
    Effect.gen(function* () {
      const self = yield* snapshot('app/Main', [
        [
          'app/Main',
          'import model.Tree { Node }\nstruct Root { node: Node }\nstruct Loop { next: Loop }\npub fn main() -> i32 { return 42 }',
        ],
        ['model/Tree', 'pub struct Node { value: i32 }'],
      ])
      const root = Analysis.structByName(self, 'app/Main', 'Root')
      const loop = Analysis.structByName(self, 'app/Main', 'Loop')
      assert.strictEqual(root._tag, 'Resolved')
      assert.strictEqual(loop._tag, 'Resolved')
      if (root._tag !== 'Resolved' || loop._tag !== 'Resolved') return
      const node = Analysis.fieldByName(root.declaration, 'node')
      assert.strictEqual(node._tag, 'Resolved')
      if (node._tag !== 'Resolved' || node.field.declaredType._tag !== 'Resolved') return
      assert.deepEqual(node.field.declaredType.type, {
        _tag: 'NominalType',
        module: 'model/Tree',
        name: 'Node',
        arguments: [],
      })
      assert.strictEqual(
        Analysis.nominalLayout(self, Type.nominal('model/Tree', 'Node'))?._tag,
        'LayoutEntry',
      )
      const unavailable = Analysis.nominalLayout(self, Type.nominal('app/Main', 'Loop'))
      assert.strictEqual(unavailable?._tag, 'UnavailableLayoutEntry')
      assert.strictEqual(
        unavailable?._tag === 'UnavailableLayoutEntry' ? unavailable.cause?.code : undefined,
        'SEM0020',
      )
    }),
)

it.effect('emits clean snapshots and refuses diagnosed snapshots before the backend', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'memory/codegen',
      ascii('pub fn main() -> i32 { return 42 }'),
      'aarch64-apple-darwin',
    )
    const release = yield* Analysis.codegen(self, { mode: 'release' })
    assert.strictEqual(release._tag, 'LlvmBitcodeArtifact')
    assert.isTrue(release.symbols.some((entry) => entry.declaration.name === 'main'))

    const invalid = yield* AnalysisFixture.retainingMain(
      'memory/invalid',
      ascii('pub fn main() -> Mystery { return 42 }'),
      'aarch64-apple-darwin',
    )
    const blocked = yield* Effect.result(Analysis.codegen(invalid, { mode: 'release' }))
    assert.strictEqual(blocked._tag, 'Failure')
    if (blocked._tag === 'Failure') assert.strictEqual(blocked.failure._tag, 'CodegenUnavailable')
  }),
)

it.effect('preserves one exact target and layout plan across facade queries and MIR', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'memory/plan',
      ascii('import silk.i32\npub fn main() -> i32 { if i32.equals(1, 1) { return 42 } return 0 }'),
      'wasm32-unknown-unknown',
    )
    const target = Analysis.targetOf(self)
    const catalog = Analysis.layoutCatalogOf(self)
    const layout = Analysis.layoutOf(self)
    const mir = Analysis.mirOf(self)

    assert.strictEqual(target._tag, 'Resolved')
    assert.strictEqual(catalog._tag, 'Available')
    assert.strictEqual(layout._tag, 'Available')
    assert.strictEqual(mir._tag, 'Available')
    if (
      target._tag !== 'Resolved' ||
      catalog._tag !== 'Available' ||
      layout._tag !== 'Available' ||
      mir._tag !== 'Available'
    )
      return
    assert.strictEqual(catalog.value.target, target.target)
    assert.strictEqual(layout.value.target, target.target)
    assert.strictEqual(mir.value.layout, layout.value)
    assert.deepEqual(
      layout.value.entries.map((entry) => [entry.type, entry.size, entry.alignment]),
      [
        ['bool', 4, 4],
        ['i32', 4, 4],
      ],
    )
  }),
)

it.effect('keeps unsupported targets explicit and queryable without manufacturing MIR', () =>
  Effect.gen(function* () {
    const unsupported = yield* AnalysisFixture.retainingMain(
      'memory/unsupported',
      ascii('pub fn main() -> i32 { return 42 }'),
      'mips-unknown-none',
    )

    assert.strictEqual(Analysis.targetOf(unsupported)._tag, 'Unavailable')
    assert.strictEqual(Analysis.layoutCatalogOf(unsupported)._tag, 'Unavailable')
    assert.strictEqual(Analysis.layoutOf(unsupported)._tag, 'Unavailable')
    assert.strictEqual(Analysis.mirOf(unsupported)._tag, 'Unavailable')
  }),
)

it.effect('keeps invalid match corpus failures phase-owned and downstream facts queryable', () =>
  Effect.gen(function* () {
    for (const program of invalidMatchCorpus) {
      const self = yield* AnalysisFixture.retainingMain(
        `memory/${program.name}`,
        ascii(program.source),
        'wasm32-unknown-unknown',
      )
      const codes = Analysis.diagnostics(self).map((diagnostic) => diagnostic.code)
      for (const code of program.codes) assert.include(codes, code, program.name)
      assert.strictEqual(Analysis.mirOf(self)._tag, 'Unavailable', program.name)
      assert.isAtLeast(
        Projections.matchesOf(self, `memory/${program.name}`).length,
        1,
        program.name,
      )
    }
  }),
)

it.effect(
  'answers local, parameter, callable, field, and half-open semantic occurrence queries',
  () =>
    Effect.gen(function* () {
      const source = `struct Pair { left: i32 right: i32 }
fn identity(value: i32) -> i32 {
  let local = value
  let pair = Pair { left: local, right: 0 }
  return pair.left
}
pub fn main() -> i32 { return identity(42) }`
      const self = yield* AnalysisFixture.retainingMain('main', ascii(source))
      const targetAt = (spelling: string, occurrence = 0) => {
        let offset = -1
        for (let index = 0; index <= occurrence; index += 1)
          offset = source.indexOf(spelling, offset + 1)
        return Analysis.semanticOccurrenceAt(self, 'main', offset)
      }

      assert.strictEqual(targetAt('value', 1)?.resolution._tag, 'Available')
      assert.strictEqual(targetAt('local', 1)?.resolution._tag, 'Available')
      assert.strictEqual(targetAt('Pair', 1)?.resolution._tag, 'Available')
      assert.strictEqual(targetAt('left', 2)?.resolution._tag, 'Available')
      assert.strictEqual(targetAt('identity', 1)?.resolution._tag, 'Available')

      const localReference = source.indexOf('local right')
      assert.strictEqual(
        Analysis.semanticOccurrenceAt(self, 'main', localReference + 'local'.length),
        undefined,
      )
      assert.strictEqual(
        Analysis.semanticOccurrenceAt(self, 'main', source.indexOf('return pair') - 1),
        undefined,
      )
    }),
)

it.effect('resolves imported and qualified declarations without spelling lookup', () =>
  Effect.gen(function* () {
    const root = `import lib { answer }
import other
pub fn main() -> i32 { return answer() + other.answer() }`
    const self = yield* snapshot('root', [
      ['root', root],
      ['lib', 'pub fn answer() -> i32 { return 42 }'],
      ['other', 'pub fn answer() -> i32 { return 7 }'],
    ])
    const selected = [
      Analysis.semanticOccurrenceAt(self, 'root', root.indexOf('answer()')),
      Analysis.semanticOccurrenceAt(self, 'root', root.lastIndexOf('answer()')),
    ]
    for (const [index, target] of selected.entries()) {
      assert.strictEqual(target?.resolution._tag, 'Available')
      if (target?.resolution._tag !== 'Available') continue
      assert.strictEqual(target.declaration?.module, index === 0 ? 'lib' : 'other')
      assert.strictEqual(target.declaration?.selectionSpan.start, 'pub fn '.length)
    }
  }),
)

it.effect('keeps unavailable and damaged semantic occurrences isolated and deterministic', () =>
  Effect.gen(function* () {
    const source =
      'fn valid(value: i32) -> i32 { return value }\nfn damaged( -> i32 { return missing() }'
    const first = yield* AnalysisFixture.retainingMain('main', ascii(source))
    const second = yield* AnalysisFixture.retainingMain('main', ascii(source))
    const availableOffset = source.indexOf('value }')
    const missingOffset = source.indexOf('missing')
    assert.deepEqual(
      Analysis.semanticOccurrenceAt(first, 'main', availableOffset),
      Analysis.semanticOccurrenceAt(second, 'main', availableOffset),
    )
    assert.strictEqual(
      Analysis.semanticOccurrenceAt(first, 'main', availableOffset)?.resolution._tag,
      'Available',
    )
    assert.strictEqual(
      Analysis.semanticOccurrenceAt(first, 'main', missingOffset)?.resolution._tag,
      'Missing',
    )
  }),
)

it.effect('constructs a frontend snapshot without runtime realization', () =>
  Effect.gen(function* () {
    const frontend = yield* Analysis.ofSource('main', ascii('pub fn main() -> i32 { return 42 }'))

    assert.deepEqual(
      Analysis.phases(frontend).map((entry) => entry.phase),
      [
        'closure',
        'declaration-collection',
        'declaration-index',
        'name-resolution',
        'module-surface',
        'elaboration',
        'ownership',
        'opaque-realization',
        'semantic-occurrences',
        'anonymous-expressions',
      ],
    )
    assert.strictEqual(Object.hasOwn(frontend, 'instances'), false)
    assert.strictEqual(Object.hasOwn(frontend, 'layout'), false)
    assert.strictEqual(Object.hasOwn(frontend, 'mir'), false)
    assert.deepEqual(Analysis.diagnostics(frontend), [])
  }),
)

it.effect('keeps an over-budget expression queryable through the analysis facade', () =>
  Effect.gen(function* () {
    const depth = ExpressionNesting.limit + 1_000
    const rejected = `${'('.repeat(depth)}1${')'.repeat(depth)}`
    const source = `fn damaged() -> i32 { return ${rejected} }
fn after() -> i32 { return 42 }`
    const frontend = yield* Analysis.ofSource('main', ascii(source))
    const syntax =
      Analysis.moduleSyntax(frontend, frontend.closure.rootModule) ?? raise('root syntax')

    assert.strictEqual(frontend._tag, 'AnalysisSnapshot')
    assert.strictEqual(
      syntax.parserDiagnostics.filter((diagnostic) => diagnostic.code === 'PAR0005').length,
      1,
    )
    assert.include(
      Analysis.diagnostics(frontend).map((diagnostic) => diagnostic.code),
      'PAR0005',
    )
    assert.strictEqual(Analysis.declarationByName(frontend, 'main', 'after')._tag, 'Resolved')
    assert.strictEqual(SyntaxTree.directNodes(syntax.root, 'FunctionDeclaration').length, 2)
  }),
)

it.effect('publishes sealed local-shared identity, affinity, and structural obligations', () =>
  Effect.gen(function* () {
    const source = `struct Token { value: i32 }
struct Generic<T> { value: T }
struct Pair<T> { first: Intrinsic.SharedCore<T> second: Intrinsic.SharedCore<T> }
union LocalHolder<T> { Empty, Full { core: Intrinsic.SharedCore<T> } }
struct LocalWrap<T> { core: Intrinsic.SharedCore<T> }
struct Damaged { first: Missing second: AlsoMissing }
struct Shared { value: i32 }
struct SharedCore { value: i32 }
struct Deferred { value: i32 }
struct Scheduler { value: i32 }
struct LocalRuntimeHandle { value: i32 }
impl Copy for LocalWrap<i32> {}
fn moveCore<T>(value: Intrinsic.SharedCore<T>) -> Intrinsic.SharedCore<T> { return move value }
fn duplicate(value: Intrinsic.SharedCore<i32>) -> Intrinsic.SharedCore<i32> { return value }
fn select(value: i32, core: Intrinsic.SharedCore<i32>) -> i32 { return value }
fn capture(core: Intrinsic.SharedCore<i32>) -> once fn<'static>(i32) -> i32 { return select(move core) }
fn moveCapture(core: Intrinsic.SharedCore<i32>) -> i32 {
  let first = select(move core)
  let second = move first
  drop second
  return 0
}
fn captureEffect(core: Intrinsic.SharedCore<i32>) -> i32 {
  let pending = effect { drop move core return 0 }
  drop pending
  return 0
}
fn moveEffect(core: Intrinsic.SharedCore<i32>) -> i32 {
  let first = effect { drop move core return 0 }
  let second = move first
  drop second
  return 0
}
pub fn main() -> i32 { return 0 }`
    const self = yield* Analysis.ofSource('main', ascii(source))
    const ownership = self.ownership.get('main')
    const moveCore = ownership?.functions.find(
      (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'moveCore',
    )
    const binding = moveCore?.bindings.at(0)
    const openElement = Type.parameter({ module: 'main', name: 'moveCore' }, 0, 'T')
    const openCore = Type.sharedCore(openElement)

    assert.isTrue(binding?.type !== undefined && Type.equals(binding.type, openCore))
    assert.strictEqual(binding?.category._tag, 'MoveOnly')
    assert.strictEqual(binding?.executionAffinity._tag, 'LocalExecution')
    assert.strictEqual(
      LocalSharedOwnership.count(binding?.localSharedObligations ?? LocalSharedOwnership.none),
      1,
    )
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      ['SEM0001', 'SEM0001', 'SEM0083', 'OWN0003'],
    )
    const duplicateRead = Analysis.diagnostics(self).find(
      (diagnostic) => diagnostic.code === 'OWN0003',
    )
    assert.strictEqual(
      duplicateRead === undefined
        ? undefined
        : source.slice(duplicateRead.span.start, duplicateRead.span.end).trim(),
      'value',
    )
    const duplicate = ownership?.functions.find(
      (fn) =>
        fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'duplicate',
    )
    assert.strictEqual(
      LocalSharedOwnership.count(
        duplicate?.bindings.at(0)?.localSharedObligations ?? LocalSharedOwnership.none,
      ),
      1,
    )

    const pair = Type.nominal('main', 'Pair', ['i32'])
    assert.isFalse(ConformanceProof.copyType(self.index, Type.sharedCore('i32')))
    assert.isFalse(
      ConformanceProof.copyType(self.index, Type.sharedCore(Type.nominal('main', 'Token'))),
    )
    assert.strictEqual(ExecutionAffinity.ofType(self.index, pair)._tag, 'LocalExecution')
    assert.strictEqual(LocalSharedOwnership.count(LocalSharedOwnership.ofType(self.index, pair)), 2)
    const localHolder = Type.nominal('main', 'LocalHolder', ['i32'])
    assert.strictEqual(ExecutionAffinity.ofType(self.index, localHolder)._tag, 'LocalExecution')
    const localHolderObligations = LocalSharedOwnership.ofType(self.index, localHolder)
    assert.strictEqual(localHolderObligations._tag, 'ActiveNominalUnion')
    if (localHolderObligations._tag !== 'ActiveNominalUnion') return
    assert.deepEqual(
      localHolderObligations.cases.map((_, ordinal) =>
        LocalSharedOwnership.count(localHolderObligations, ordinal),
      ),
      [0, 1],
    )
    assert.strictEqual(
      LocalSharedOwnership.count(
        LocalSharedOwnership.ofType(self.index, Type.fixedArray(Type.sharedCore('i32'), 2)),
      ),
      2,
    )
    const capture = ownership?.functions.find(
      (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'capture',
    )
    assert.strictEqual(capture?.callables.at(0)?.executionAffinity._tag, 'LocalExecution')
    assert.strictEqual(
      LocalSharedOwnership.count(
        capture?.callables.at(0)?.localSharedObligations ?? LocalSharedOwnership.none,
      ),
      1,
    )
    const moveCapture = ownership?.functions.find(
      (fn) =>
        fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'moveCapture',
    )
    const movedCallable = moveCapture?.bindings.find((candidate) => candidate.name === 'second')
    assert.strictEqual(movedCallable?.executionAffinity._tag, 'LocalExecution')
    assert.strictEqual(
      LocalSharedOwnership.count(
        movedCallable?.localSharedObligations ?? LocalSharedOwnership.none,
      ),
      1,
    )
    const captureEffect = ownership?.functions.find(
      (fn) =>
        fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'captureEffect',
    )
    const pending = captureEffect?.bindings.find((candidate) => candidate.name === 'pending')
    assert.strictEqual(pending?.executionAffinity._tag, 'LocalExecution')
    assert.strictEqual(
      LocalSharedOwnership.count(pending?.localSharedObligations ?? LocalSharedOwnership.none),
      1,
    )
    const moveEffect = ownership?.functions.find(
      (fn) =>
        fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'moveEffect',
    )
    const movedEffect = moveEffect?.bindings.find((candidate) => candidate.name === 'second')
    assert.strictEqual(movedEffect?.executionAffinity._tag, 'LocalExecution')
    assert.strictEqual(
      LocalSharedOwnership.count(movedEffect?.localSharedObligations ?? LocalSharedOwnership.none),
      1,
    )
    const union = Type.union([Type.sharedCore('i32'), Type.nominal('main', 'Token')])
    assert.strictEqual(union._tag, 'Normalized')
    if (union._tag !== 'Normalized' || !Type.isUnion(union.type)) return
    const unionObligations = LocalSharedOwnership.ofType(self.index, union.type)
    assert.strictEqual(unionObligations._tag, 'ActiveUnion')
    if (unionObligations._tag !== 'ActiveUnion') return
    assert.deepEqual(
      unionObligations.cases.map((entry, ordinal) => [
        Type.isSharedCore(entry.member),
        LocalSharedOwnership.count(unionObligations, ordinal),
      ]),
      [
        [false, 0],
        [true, 1],
      ],
    )

    const genericParameter = Type.parameter({ module: 'main', name: 'Generic' }, 0, 'T')
    const openGeneric = Type.nominal('main', 'Generic', [genericParameter])
    assert.strictEqual(ExecutionAffinity.ofType(self.index, openGeneric)._tag, 'ParameterDependent')
    assert.strictEqual(
      ExecutionAffinity.ofType(self.index, Type.nominal('main', 'Generic', ['i32']))._tag,
      'Unrestricted',
    )
    assert.strictEqual(
      ExecutionAffinity.ofType(
        self.index,
        Type.nominal('main', 'Generic', [Type.sharedCore('i32')]),
      )._tag,
      'LocalExecution',
    )
    const damaged = ExecutionAffinity.ofType(self.index, Type.nominal('main', 'Damaged'))
    assert.strictEqual(damaged._tag, 'Unavailable')
    if (damaged._tag !== 'Unavailable') return
    assert.deepEqual(
      damaged.causes.map((cause) => cause.code),
      ['SEM0001', 'SEM0001'],
    )

    assert.strictEqual(ExecutionAffinity.ofBorrow(self.index, 'i32', pair)._tag, 'LocalExecution')
    assert.strictEqual(
      ExecutionAffinity.ofEnvironment(self.index, [{ type: pair }])._tag,
      'LocalExecution',
    )
    assert.strictEqual(
      LocalSharedOwnership.count(
        LocalSharedOwnership.ofEnvironment(self.index, [{ access: 'Take', type: pair }]),
      ),
      2,
    )
    for (const name of ['Shared', 'SharedCore', 'Deferred', 'Scheduler', 'LocalRuntimeHandle']) {
      const ordinary = Type.nominal('main', name)
      assert.isFalse(Type.isSharedCore(ordinary))
      assert.strictEqual(ExecutionAffinity.ofType(self.index, ordinary)._tag, 'Unrestricted')
      assert.strictEqual(
        LocalSharedOwnership.count(LocalSharedOwnership.ofType(self.index, ordinary)),
        0,
      )
    }
    const forgedCore = Type.nominal('Intrinsic', 'SharedCore', ['i32'])
    assert.isFalse(Type.isSharedCore(forgedCore))
    assert.isFalse(Type.isIntrinsicNominal(forgedCore))
    assert.strictEqual(ExecutionAffinity.ofType(self.index, forgedCore)._tag, 'Unrestricted')
    assert.strictEqual(
      LocalSharedOwnership.count(
        LocalSharedOwnership.ofType(self.index, Type.slot(openCore, Lifetime.staticLifetime)),
      ),
      0,
    )

    const fact = LocalSharedOwnership.inspect(Type.sharedCore(Type.nominal('main', 'Token')))
    assert.deepEqual(fact, {
      _tag: 'LocalSharedCoreFact',
      identity: 'Intrinsic.SharedCore',
      type: Type.sharedCore(Type.nominal('main', 'Token')),
      element: Type.nominal('main', 'Token'),
      role: 'LocalSharedStrong',
      category: 'Affine',
      affinity: { _tag: 'LocalExecution' },
    })
    assert.notInclude(Object.keys(fact ?? {}), 'address')
    assert.notInclude(Object.keys(fact ?? {}), 'count')
    assert.notInclude(Object.keys(fact ?? {}), 'layout')
    assert.strictEqual(
      ExecutionAffinity.encode(fact?.affinity ?? ExecutionAffinity.unrestricted),
      'LocalExecution',
    )

    const recovery = yield* Analysis.ofSource(
      'recovery',
      ascii(
        'fn inspect(value: Intrinsic.SharedCore<Missing>) -> i32 { return 0 }\npub fn main() -> i32 { return 0 }',
      ),
    )
    const recovered = recovery.ownership.get('recovery')?.functions.at(0)?.bindings.at(0)
    assert.deepEqual(
      Analysis.diagnostics(recovery).map((diagnostic) => diagnostic.code),
      ['SEM0001'],
    )
    assert.strictEqual(recovered?.category._tag, 'Unavailable')
    assert.strictEqual(recovered?.executionAffinity._tag, 'Unavailable')
    assert.strictEqual(recovered?.localSharedObligations._tag, 'Unavailable')
    assert.strictEqual(
      LocalSharedOwnership.count(recovered?.localSharedObligations ?? LocalSharedOwnership.none),
      0,
    )
  }),
)

it.effect('realizes immutable target snapshots from the same frontend facts', () =>
  Effect.gen(function* () {
    const frontend = yield* AnalysisFixture.frontend(
      'main',
      ascii('pub fn main() -> i32 { return 42 }'),
    )
    const native = yield* Analysis.realize(frontend, AnalysisFixture.configuration('main')).pipe(
      Effect.provide(SourceResolver.empty),
    )
    const wasm = yield* Analysis.realize(
      frontend,
      AnalysisFixture.configuration('main', 'wasm32-unknown-unknown'),
    ).pipe(Effect.provide(SourceResolver.empty))
    assert.deepEqual(Analysis.diagnostics(native), [])
    assert.deepEqual(Analysis.diagnostics(wasm), [])

    assert.strictEqual(native.results, frontend.results)
    assert.strictEqual(wasm.results, frontend.results)
    assert.strictEqual(native.ownership, frontend.ownership)
    assert.strictEqual(wasm.ownership, frontend.ownership)
    assert.strictEqual(Object.hasOwn(frontend, 'instances'), false)
    assert.strictEqual(native.target._tag, 'Resolved')
    assert.strictEqual(wasm.target._tag, 'Resolved')
    if (native.target._tag !== 'Resolved' || wasm.target._tag !== 'Resolved') return
    assert.strictEqual(native.target.target.kind, 'Native')
    assert.strictEqual(wasm.target.target.id, 'wasm32-unknown-unknown')
    assert.deepEqual(
      Analysis.phases(native)
        .slice(Analysis.phases(frontend).length)
        .map((entry) => entry.phase),
      ['instance-discovery', 'target-layout', 'mir-lowering'],
    )
  }),
)

it.effect('publishes sealed affine Execution identity, affinity, and logical lifecycle facts', () =>
  Effect.gen(function* () {
    const self = yield* Analysis.ofSource(
      'execution-semantics',
      ascii(
        `struct Execution<T> { value: T }
struct NestedLoan<'a> { value: &'a i32 }
union NestedUnionLoan<'a> { Empty, Ready { value: &'a i32 } }
fn retain(value: Intrinsic.Execution<i32>) -> () { drop value }
fn ordinary(value: Execution<i32>) -> () { drop value }
pub fn main() -> i32 { return 42 }`,
      ),
    )
    const intrinsic = self.index.modules
      .at(0)
      ?.declarations.find(
        (declaration) =>
          declaration.name._tag === 'Present' && declaration.name.spelling === 'retain',
      )
      ?.parameters.at(0)?.declaredType
    const ordinary = self.index.modules
      .at(0)
      ?.declarations.find(
        (declaration) =>
          declaration.name._tag === 'Present' && declaration.name.spelling === 'ordinary',
      )
      ?.parameters.at(0)?.declaredType

    assert.strictEqual(intrinsic?._tag, 'Resolved')
    if (intrinsic?._tag !== 'Resolved') return
    assert.isTrue(Type.isExecution(intrinsic.type))
    assert.strictEqual(ExecutionAffinity.ofType(self.index, intrinsic.type)._tag, 'LocalExecution')
    const fact = ExecutionLifecycle.ofType(self.index, intrinsic.type)
    assert.strictEqual(fact._tag, 'Available')
    if (fact._tag !== 'Available') return
    assert.strictEqual(fact.fact.identity, 'Intrinsic.Execution')
    assert.isTrue(fact.fact.affine)
    assert.isFalse(fact.fact.copy)
    assert.isFalse(fact.fact.threadTransfer)
    assert.strictEqual(fact.fact.initial, 'Unstarted')
    assert.strictEqual(
      ExecutionLifecycle.encode(fact.fact),
      'Intrinsic.Execution<i32> affine=yes copy=no transfer=no affinity=LocalExecution initial=Unstarted states=Unstarted,Running,Relinquished,Completed,Destroyed loans=Rejected/MayCrossParking/LoanBeforeReferent/Rejected shared=PreservedAcrossParking/RejectParking',
    )
    assert.deepEqual(ExecutionLifecycle.transition('Relinquished', 'Drive'), {
      _tag: 'Transition',
      state: 'Running',
    })
    assert.deepEqual(ExecutionLifecycle.transition('Running', 'Drive'), {
      _tag: 'FatalIntrinsicStateTrap',
      state: 'Running',
      event: 'Drive',
    })
    assert.strictEqual(ordinary?._tag === 'Resolved' && Type.isExecution(ordinary.type), false)
    assert.strictEqual(
      ExecutableProperty.detachedOfEnvironment(self.index, [
        { ordinal: 0, access: 'Take', type: Type.sharedCore('i32') },
      ])._tag,
      'Satisfied',
    )
    assert.strictEqual(
      ExecutionAffinity.ofEnvironment(self.index, [{ type: Type.sharedCore('i32') }])._tag,
      'LocalExecution',
    )
    const localLifetime = Lifetime.local(
      { module: 'execution-semantics', name: 'retain' },
      'capture',
      0,
    )
    const lexical = ExecutableProperty.detachedOfEnvironment(self.index, [
      {
        ordinal: 0,
        access: 'Take',
        type: Type.reference('Shared', 'i32', localLifetime),
      },
    ])
    assert.strictEqual(lexical._tag, 'Unsatisfied')
    assert.strictEqual(
      lexical._tag === 'Unsatisfied' ? lexical.causes.at(0)?.reason : undefined,
      'LexicalLoan',
    )
    for (const borrowed of [Type.string(localLifetime), Type.slot('i32', localLifetime)]) {
      const verdict = ExecutableProperty.detachedOfEnvironment(self.index, [
        { ordinal: 0, access: 'Take', type: borrowed },
      ])
      assert.strictEqual(verdict._tag, 'Unsatisfied')
      assert.strictEqual(
        verdict._tag === 'Unsatisfied' ? verdict.causes.at(0)?.reason : undefined,
        'LexicalLoan',
      )
    }
    const provider = ExecutableProperty.detachedOfEnvironment(self.index, [
      {
        ordinal: 0,
        access: 'Take',
        type: Type.nominal('execution-semantics', 'Execution'),
        providedRequirement: { providerAccess: 'Shared' },
      },
    ])
    assert.strictEqual(provider._tag, 'Unsatisfied')
    assert.strictEqual(
      provider._tag === 'Unsatisfied' ? provider.causes.at(0)?.reason : undefined,
      'ProviderLoan',
    )
    const nested = ExecutableProperty.detachedOfEnvironment(self.index, [
      {
        ordinal: 0,
        access: 'Take',
        type: Type.nominal('execution-semantics', 'NestedLoan', [localLifetime]),
      },
    ])
    assert.strictEqual(nested._tag, 'Unsatisfied')
    assert.strictEqual(
      nested._tag === 'Unsatisfied' ? nested.causes.at(0)?.reason : undefined,
      'NestedLoan',
    )
    assert.include(
      nested._tag === 'Unsatisfied' ? nested.causes.at(0)?.path.join(' -> ') : '',
      'NestedLoan.value',
    )
    const nestedUnion = ExecutableProperty.detachedOfEnvironment(self.index, [
      {
        ordinal: 0,
        access: 'Take',
        type: Type.nominal('execution-semantics', 'NestedUnionLoan', [localLifetime]),
      },
    ])
    assert.strictEqual(nestedUnion._tag, 'Unsatisfied')
    assert.strictEqual(
      nestedUnion._tag === 'Unsatisfied' ? nestedUnion.causes.at(0)?.reason : undefined,
      'NestedLoan',
    )
    assert.include(
      nestedUnion._tag === 'Unsatisfied' ? nestedUnion.causes.at(0)?.path.join(' -> ') : '',
      'NestedUnionLoan.Ready.value',
    )

    const duplicate = yield* Analysis.ofSource(
      'execution-move',
      ascii(
        `fn duplicate(value: Intrinsic.Execution<i32>) -> () {
  let owned = move value
  drop owned
  drop value
}
pub fn main() -> i32 { return 42 }`,
      ),
    )
    assert.deepEqual(
      Analysis.diagnostics(duplicate).map((diagnostic) => diagnostic.code),
      ['OWN0001'],
    )

    const malformed = yield* Analysis.ofSource(
      'execution-malformed',
      ascii(
        'fn retain(value: Intrinsic.Execution<Missing>) -> () { drop value }\npub fn main() -> i32 { return 42 }',
      ),
    )
    const malformedType = malformed.index.modules
      .at(0)
      ?.declarations.at(0)
      ?.parameters.at(0)?.declaredType
    assert.deepEqual(
      Analysis.diagnostics(malformed).map((diagnostic) => diagnostic.code),
      ['SEM0001'],
    )
    assert.strictEqual(malformedType?._tag, 'Applied')
    assert.strictEqual(
      malformedType === undefined
        ? undefined
        : ExecutionAffinity.ofDeclaredType(malformed.index, malformedType)._tag,
      'Unavailable',
    )
  }),
)

it.effect('resolves public foreign functions across modules under the unsafe rule', () =>
  Effect.gen(function* () {
    const root = `import lib { abs }
import lib
pub fn main() -> i32 { return unsafe abs(1) + unsafe lib.abs(2) + lib.hidden(3) }`
    const self = yield* Analysis.make({ root: 'root' }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make('root', ascii(root))]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map([
                [
                  'lib',
                  ascii(`pub unsafe extern "C" fn abs(value: i32) -> i32
unsafe extern "C" fn hidden(value: i32) -> i32`),
                ],
              ]),
            ),
          ),
        ),
      ),
    )
    const selected = Analysis.semanticOccurrenceAt(self, 'root', root.indexOf('abs(1)'))
    const qualified = Analysis.semanticOccurrenceAt(self, 'root', root.indexOf('abs(2)'))

    assert.strictEqual(selected?.declaration?.module, 'lib')
    assert.strictEqual(qualified?.declaration?.module, 'lib')
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => [
        diagnostic.code,
        root.slice(diagnostic.span.start, diagnostic.span.end),
      ]),
      [['SEM0015', 'hidden']],
    )
  }),
)

it.effect('retains valid plain and Effect test contracts without changing their channels', () =>
  Effect.gen(function* () {
    const source = `pub service Clock { fn now() -> i32 }
test fn plain() {}
pub test effect fn effectful() -> () ! i32 ? &Clock { fail 1 }
fn test() {}`
    const snapshot = yield* Analysis.ofSource('test-contracts', ascii(source))
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const declarations = Analysis.declarationIndex(snapshot).modules.flatMap(
      (module) => module.declarations,
    )
    const tests = declarations.filter((declaration) => declaration.test)
    assert.deepEqual(
      tests.map((declaration) => [
        declaration.name._tag === 'Present' ? declaration.name.spelling : undefined,
        declaration.functionKind,
        declaration.parameterCount,
        declaration.returnType._tag === 'Resolved'
          ? Type.equals(declaration.returnType.type, Type.unit)
          : false,
      ]),
      [
        ['plain', 'Ordinary', 0, true],
        ['effectful', 'Effect', 0, true],
      ],
    )
    assert.deepEqual(tests[1]?.failureRow.failures.map(Type.encode), ['i32'])
    assert.isAbove(tests[1]?.requirementRow.requirements.length ?? 0, 0)
    assert.strictEqual(
      tests[0] === undefined ? undefined : SemanticDisplay.functionDeclaration(tests[0]).text,
      'test fn plain() -> ()',
    )
    assert.match(
      tests[1] === undefined ? '' : SemanticDisplay.functionDeclaration(tests[1]).text,
      /^pub test effect<[^>]+> fn effectful\(\) -> \(\) ! i32 \? &Clock$/,
    )
    assert.isFalse(
      declarations.some(
        (declaration) =>
          declaration.name._tag === 'Present' &&
          declaration.name.spelling === 'test' &&
          declaration.test,
      ),
    )
  }),
)

it.effect('rejects test declarations outside the finite module-level unit contract', () =>
  Effect.gen(function* () {
    const cases = [
      'test static fn selected() {}',
      'test unsafe fn selected() {}',
      'test unsafe extern "C" fn selected()',
      'test export "C" fn selected() as "selected" {}',
      'test fn selected(value: i32) {}',
      'test fn selected<T>() {}',
      'test fn selected() -> i32 { return 1 }',
      'struct Box {}\nimpl Box { test fn selected() {} }',
    ]
    for (const [ordinal, source] of cases.entries()) {
      const snapshot = yield* Analysis.ofSource(`invalid-test-${ordinal}`, ascii(source))
      const diagnostics = Analysis.diagnostics(snapshot).filter(
        (diagnostic) => diagnostic.code === 'SEM0218',
      )
      assert.strictEqual(diagnostics.length, 1, source)
      const diagnostic = diagnostics[0]
      assert.strictEqual(
        diagnostic === undefined
          ? undefined
          : source.slice(diagnostic.span.start, diagnostic.span.end),
        'test',
        source,
      )
    }
  }),
)
