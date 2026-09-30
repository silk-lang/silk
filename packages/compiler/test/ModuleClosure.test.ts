import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Analysis from '../src/Analysis.js'
import * as AuthoredIdentity from '../src/AuthoredIdentity.js'
import * as Diagnostic from '../src/Diagnostic.js'
import * as DeclarationFacts from '../src/DeclarationFacts.js'
import * as ModuleClosure from '../src/ModuleClosure.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceOrigin from '../src/SourceOrigin.js'
import * as SourceResolver from '../src/SourceResolver.js'
import { unreachable } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const fn = 'pub fn main() -> i32 { return 42 }'

it.effect(
  'reuses exact shipped syntax while refreshing source policy and declaration selection',
  () =>
    Effect.gen(function* () {
      const name = 'silk/effect'
      const source = 'static if true { import left } else { import right }'
      const load = Effect.fnUntraced(function* (
        text = source,
        origin = SourceOrigin.memory(),
        selection?: ReadonlyMap<string, boolean>,
      ) {
        const closure = yield* ModuleClosure.loadProject({
          roots: [name],
          ...(selection === undefined ? {} : { selection: new Map([[name, selection]]) }),
        }).pipe(
          Effect.provide(
            Layer.succeed(SourceResolver.SourceResolver, {
              resolve: () => Effect.succeedSome(SourceResolver.resolved(ascii(fn), origin)),
              resolveStandardLibrary: () =>
                Effect.succeedSome(SourceResolver.resolved(ascii(text), origin)),
            }),
          ),
        )
        return (
          closure.modules.find((module) => module.name === name) ?? unreachable('shipped module')
        )
      })
      const first = yield* load()
      const condition = first.authored.module.declarations.at(0) ?? unreachable('condition')
      const owner = AuthoredIdentity.key(condition.owner)
      const selected = yield* load(source, SourceOrigin.memory(), new Map([[owner, true]]))
      assert.strictEqual(selected.syntax, first.syntax)
      assert.strictEqual(selected.authored, first.authored)
      assert.deepEqual(importNames(selected), ['left'])
      const alternate = yield* load(source, SourceOrigin.memory(), new Map([[owner, false]]))
      assert.strictEqual(alternate.syntax, first.syntax)
      assert.deepEqual(importNames(alternate), ['right'])

      const edited = yield* load(`${source}\npub fn added() -> i32 { return 7 }`)
      assert.notStrictEqual(edited.syntax, first.syntax)
      assert.strictEqual(edited.authored.module.declarations.length, 2)
      const origin = SourceOrigin.toolchainFile('file:///toolchain/effect.silk')
      const relocated = yield* load(source, origin)
      assert.notStrictEqual(relocated.syntax, first.syntax)
      assert.deepEqual(relocated.syntax.source.origin, origin)
      assert.strictEqual(relocated.authored.module.owner.namespace, 'toolchain')
    }),
)

it.effect(
  'selects module declarations through imported static helpers without resolving inactive imports',
  () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const sources = new Map([
        [
          'policy',
          ascii(
            'type Choice = bool\nconst enabled: Choice = true\npub static fn choose() -> Choice { return enabled }',
          ),
        ],
        ['active', ascii('pub fn value() -> i32 { return 42 }')],
      ])
      const resolver = Layer.succeed(SourceResolver.SourceResolver, {
        resolveStandardLibrary: SourceResolver.resolveEmbeddedStandardLibrary,
        resolve: Effect.fn('SelectionFixture.resolve')((module: string) =>
          Effect.sync(() => {
            calls.push(module)
            const bytes = sources.get(module)
            return bytes === undefined
              ? Option.none()
              : Option.some(SourceResolver.resolved(bytes, SourceOrigin.memory()))
          }),
        ),
      })
      const snapshot = yield* Analysis.make({
        root: 'root',
        configuration: {
          profile: {
            target: 'aarch64-apple-darwin',
            artifact: 'object',
            runtime: { kind: 'none' },
          },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make(
              'root',
              ascii(`import policy { choose }
static if choose() {
  import active { value }
  pub fn main() -> i32 { return value() }
} else {
  import missing
  pub fn main() -> i32 { return nonexistent() }
}`),
            ),
          ]).pipe(Layer.provideMerge(resolver)),
        ),
      )
      assert.deepEqual(snapshot.diagnostics, [])
      assert.deepEqual(calls, ['policy', 'active'])
      assert.deepEqual(Analysis.unusedImports(snapshot, 'root'), [])
      assert.deepEqual(
        snapshot.closure.modules.map((module) => module.name),
        ['active', 'policy', 'root'],
      )
      assert.strictEqual(Analysis.declarationByName(snapshot, 'root', 'main')._tag, 'Resolved')
      assert.strictEqual(snapshot.selection?.inactiveRanges.get('root')?.length, 1)
    }),
)

it.effect(
  'resolves independent forward conditional declarations and keeps loaded inactive syntax diagnostics',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* Analysis.ofSource(
        'forward_selection',
        ascii(`
static if flag { pub fn main() -> i32 { return 1 } }
static if true { const flag: bool = true } else { fn bad() -> () { let = 1 } }
`),
        'aarch64-apple-darwin',
      )
      assert.strictEqual(
        Analysis.declarationByName(snapshot, 'forward_selection', 'main')._tag,
        'Resolved',
      )
      assert.isTrue(
        snapshot.diagnostics.some((diagnostic) => diagnostic.code === Diagnostic.missingTokenCode),
      )
      assert.isFalse(
        snapshot.diagnostics.some(
          (diagnostic) => diagnostic.code === Diagnostic.unknownValueReferenceCode,
        ),
      )
    }),
)

it.effect('publishes selected aliases across re-export chains with original identity', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.make({
      root: 'root',
      target: 'aarch64-apple-darwin',
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'root',
            ascii('import facade { selected }\npub fn main() -> i32 { return selected() }'),
          ),
        ]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map([
                [
                  'facade',
                  ascii(
                    'static if true { pub import middle { answer as selected } } else { pub import missing { answer as selected } }',
                  ),
                ],
                ['middle', ascii('pub import implementation { original as answer }')],
                ['implementation', ascii('pub fn original() -> i32 { return 42 }')],
              ]),
            ),
          ),
        ),
      ),
    )
    assert.deepEqual(snapshot.diagnostics, [])
    const selected = DeclarationFacts.publishedMember(snapshot.index, 'facade', 'selected')
    assert.strictEqual(selected._tag, 'Resolved')
    if (selected._tag === 'Resolved') {
      assert.deepEqual(selected.declaration.canonical, {
        _tag: 'Canonical',
        id: { _tag: 'CanonicalDeclarationId', module: 'implementation', name: 'original' },
      })
    }
    assert.isFalse(snapshot.closure.sources.has('missing'))
  }),
)

it.effect('diagnoses module condition availability cycles with source origins', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'cycle',
      ascii(`
static if right { const left: bool = true }
static if left { const right: bool = true }
`),
      'aarch64-apple-darwin',
    )
    const cycles = snapshot.diagnostics.filter(
      (diagnostic) => diagnostic.code === Diagnostic.staticEvaluationCycleCode,
    )
    assert.strictEqual(cycles.length, 2)
    for (const diagnostic of cycles) {
      assert.strictEqual(diagnostic.span.sourceId, 'cycle')
      assert.isTrue((diagnostic.relatedSpans?.length ?? 0) > 0)
    }
    assert.strictEqual(Analysis.memberByName(snapshot, 'cycle', 'left')._tag, 'Missing')
  }),
)

it.effect('tracks availability cycles through selective imports', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.make({
      root: 'root',
      target: 'aarch64-apple-darwin',
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'root',
            ascii(
              'import policy { enabled }\nstatic if enabled { pub const selected: bool = true }',
            ),
          ),
        ]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map([
                [
                  'policy',
                  ascii(
                    'import root { selected }\nstatic if selected { pub const enabled: bool = true }',
                  ),
                ],
              ]),
            ),
          ),
        ),
      ),
    )
    assert.deepEqual(
      snapshot.diagnostics
        .filter((diagnostic) => diagnostic.code === Diagnostic.staticEvaluationCycleCode)
        .map((diagnostic) => diagnostic.span.sourceId),
      ['policy', 'root'],
    )
  }),
)

it.effect('uses completed package configuration and rejects default availability cycles', () =>
  Effect.gen(function* () {
    const valid = yield* Analysis.make({
      root: 'configured',
      configuration: {
        package: 'example@1',
        profile: { target: 'aarch64-apple-darwin', artifact: 'object', runtime: { kind: 'none' } },
      },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'configured',
            ascii(`pub param enabled: bool = true
static if enabled { pub const selected: i32 = 1 } else { import missing }`),
          ),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    assert.deepEqual(valid.diagnostics, [])
    assert.strictEqual(Analysis.memberByName(valid, 'configured', 'selected')._tag, 'Resolved')
    assert.isDefined(valid.profile)
    const cyclic = yield* Analysis.make({
      root: 'configured',
      configuration: {
        package: 'example@1',
        profile: { target: 'aarch64-apple-darwin', artifact: 'object', runtime: { kind: 'none' } },
      },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'configured',
            ascii(`pub param enabled: bool = choice
static if enabled { const choice: bool = true }`),
          ),
        ]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    const diagnostic = cyclic.diagnostics.find(
      (diagnostic) => diagnostic.code === Diagnostic.invalidConfigurationCode,
    )
    assert.strictEqual(diagnostic?.reason._tag, 'InvalidConfiguration')
    if (diagnostic?.reason._tag === 'InvalidConfiguration')
      assert.strictEqual(diagnostic.reason.error.code, 'DependencyCycle')
    assert.isTrue((diagnostic?.relatedSpans?.length ?? 0) > 0)
  }),
)

it.effect('rejects package schemas first discovered through selected imports', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.make({
      root: 'root',
      configuration: {
        package: 'example@1',
        profile: { target: 'aarch64-apple-darwin', artifact: 'object', runtime: { kind: 'none' } },
      },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make('root', ascii('static if true { import settings }')),
        ]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(new Map([['settings', ascii('pub param enabled: bool = true')]])),
          ),
        ),
      ),
    )
    const diagnostic = snapshot.diagnostics.find(
      (value) => value.code === Diagnostic.invalidConfigurationCode,
    )
    assert.strictEqual(diagnostic?.span.sourceId, 'settings')
    assert.isTrue((diagnostic?.relatedSpans?.length ?? 0) > 0)
  }),
)

it.effect('rejects non-static and non-boolean module conditions without admitting either arm', () =>
  Effect.gen(function* () {
    for (const condition of ['runtime()', '42', 'missing']) {
      const snapshot = yield* AnalysisFixture.declarations(
        'invalid_condition',
        ascii(`fn runtime() -> bool { return true }
static if ${condition} { pub const selected: i32 = 1 } else { pub const other: i32 = 2 }`),
        'aarch64-apple-darwin',
      )
      assert.isTrue(
        snapshot.diagnostics.some(
          (diagnostic) => diagnostic.code === Diagnostic.staticPhaseViolationCode,
        ),
      )
      assert.strictEqual(
        Analysis.memberByName(snapshot, 'invalid_condition', 'selected')._tag,
        'Missing',
      )
      assert.strictEqual(
        Analysis.memberByName(snapshot, 'invalid_condition', 'other')._tag,
        'Missing',
      )
      for (const diagnostic of snapshot.diagnostics)
        assert.strictEqual(diagnostic.span.sourceId, 'invalid_condition')
    }
  }),
)

const fixture = (
  rootModule: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Effect.Effect<ModuleClosure.Closure, ModuleClosure.ModuleClosureError> => {
  const rootText = entries.find(([name]) => name === rootModule)?.[1]
  if (rootText === undefined) throw new RangeError(`Fixture has no root source ${rootModule}`)
  const imports = new Map(
    entries
      .filter(([name]) => name !== rootModule)
      .map(([name, text]) => [name, ascii(text)] as const),
  )
  return ModuleClosure.load({ root: rootModule }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make(rootModule, ascii(rootText))]).pipe(
        Layer.provideMerge(SourceResolver.memory(imports)),
      ),
    ),
  )
}

it.effect('excludes inactive foreign exports and invalid bodies from realization', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'selected_inventory',
      ascii(`
static if true {
  pub fn main() -> i32 { return 42 }
} else {
  export "C" fn inactive_export() -> i32 { return unknown() }
  unsafe extern "C" fn inactive_call() -> i32
  struct Hidden { value: Missing }
}
`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(snapshot.diagnostics, [])
    assert.deepEqual(snapshot.instances.foreignCalls, [])
    assert.deepEqual(snapshot.instances.foreignExports, [])
    assert.strictEqual(
      Analysis.memberByName(snapshot, 'selected_inventory', 'Hidden')._tag,
      'Missing',
    )
    assert.strictEqual(snapshot.mir._tag, 'Available')
  }),
)

const importNames = (module: ModuleClosure.Module): ReadonlyArray<string> =>
  module.imports.map((fact) =>
    fact.target._tag === 'Unavailable' ? '<unavailable>' : fact.target.module,
  )

it.effect('loads a diamond once per module and excludes unreachable sources', () =>
  Effect.gen(function* () {
    const calls: Array<string> = []
    const sources = new Map([
      ['root', ascii(`import left\nimport right\n${fn}`)],
      ['left', ascii(`import shared\n${fn}`)],
      ['right', ascii(`import shared\n${fn}`)],
      ['shared', ascii(fn)],
      ['island', ascii(fn)],
    ])
    const resolver = Layer.succeed(SourceResolver.SourceResolver, {
      resolveStandardLibrary: SourceResolver.resolveEmbeddedStandardLibrary,
      resolve: (module: string) =>
        Effect.sync(() => {
          calls.push(module)
          const bytes = sources.get(module)
          return bytes === undefined
            ? Option.none()
            : Option.some(SourceResolver.resolved(bytes, SourceOrigin.memory()))
        }),
    })
    const closure = yield* ModuleClosure.load({
      root: 'root',
    }).pipe(Effect.provide(resolver))

    assert.deepEqual(
      closure.modules.map((module) => module.name),
      ['left', 'right', 'root', 'shared'],
    )
    assert.deepEqual(calls, ['root', 'left', 'right', 'shared'])
    assert.deepEqual([...closure.sources.keys()], ['left', 'right', 'root', 'shared'])
    assert.deepEqual(closure.resolutionFailures, [])
  }),
)

it.effect('is deterministic across resolver supply order', () =>
  Effect.gen(function* () {
    const entries: ReadonlyArray<readonly [string, string]> = [
      ['root', `import zeta\nimport alpha\n${fn}`],
      ['zeta', `import alpha\n${fn}`],
      ['alpha', fn],
    ]
    const forward = yield* fixture('root', entries)
    const reversed = yield* fixture('root', [...entries].reverse())
    assert.deepEqual(forward, reversed)
  }),
)

it.effect('diagnoses absence and self-imports without resolving the root again', () =>
  Effect.gen(function* () {
    const closure = yield* fixture('root', [['root', `import missing\nimport root\n${fn}`]])
    const root = closure.modules.at(0)
    assert.notStrictEqual(root, undefined)
    if (root === undefined) return
    assert.deepEqual(importNames(root), ['missing', 'root'])
    assert.deepEqual(
      closure.diagnostics.map((diagnostic) => diagnostic.code),
      ['MOD0001', 'MOD0002'],
    )
    assert.strictEqual(root.imports.at(0)?.target._tag, 'Unknown')
    assert.strictEqual(root.imports.at(1)?.target._tag, 'Self')
  }),
)

it.effect('suppresses resolver calls and module diagnostics for damaged import syntax', () =>
  Effect.gen(function* () {
    const closure = yield* fixture('root', [['root', `import\n${fn}`]])
    const root = closure.modules.at(0)
    assert.strictEqual(root?.imports.at(0)?.target._tag, 'Unavailable')
    assert.deepEqual(closure.diagnostics, [])
    assert.deepEqual(
      root?.syntax.parserDiagnostics.map((diagnostic) => diagnostic.code),
      ['PAR0001'],
    )
  }),
)

it.effect('retains partial closure facts around ordered operational failures', () =>
  Effect.gen(function* () {
    const resolver = Layer.succeed(SourceResolver.SourceResolver, {
      resolveStandardLibrary: SourceResolver.resolveEmbeddedStandardLibrary,
      resolve: (module: string) => {
        if (module === 'readable') {
          return Effect.succeedSome(SourceResolver.resolved(ascii(fn), SourceOrigin.memory()))
        }
        return Effect.fail(
          new SourceResolver.SourceResolverError({
            operation: 'test.resolve',
            module,
            message: `cannot read ${module}`,
            reason: { _tag: 'WrappedFailure', cause: new Error(module) },
          }),
        )
      },
    })
    const closure = yield* ModuleClosure.load({
      root: 'root',
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make('root', ascii(`import zeta\nimport readable\nimport alpha\n${fn}`)),
        ]).pipe(Layer.provideMerge(resolver)),
      ),
    )

    assert.deepEqual(
      closure.modules.map((module) => module.name),
      ['readable', 'root'],
    )
    assert.deepEqual(
      closure.resolutionFailures.map((failure) => failure.module),
      ['alpha', 'zeta'],
    )
    assert.deepEqual(closure.diagnostics, [])
    assert.deepEqual(
      closure.modules
        .find((module) => module.name === 'root')
        ?.imports.map((fact) => fact.target._tag),
      ['Failed', 'Resolved', 'Failed'],
    )
  }),
)

it.effect('records cycles and exact dotted-to-canonical import provenance', () =>
  Effect.gen(function* () {
    const closure = yield* fixture('app/Main', [
      ['app/Main', `import compiler.Syntax { parse }\n${fn}`],
      ['compiler/Syntax', `import cycle.Other\npub fn parse() -> i32 { return 42 }`],
      ['cycle/Other', `import compiler.Syntax\n${fn}`],
    ])
    const imported = closure.modules.find((module) => module.name === 'app/Main')?.imports.at(0)
    assert.strictEqual(imported?.sourceSpelling, 'compiler.Syntax')
    assert.strictEqual(imported?.canonicalTarget, 'compiler/Syntax')
    assert.strictEqual(imported?.target._tag, 'Resolved')
    assert.deepEqual(closure.cycles, [['compiler/Syntax', 'cycle/Other']])
  }),
)

it.effect('maps reserved contextual path segments to canonical module identities', () =>
  Effect.gen(function* () {
    const closure = yield* fixture('app/Main', [
      ['app/Main', `import toolkit.effect.helpers\n${fn}`],
      ['toolkit/effect/helpers', 'pub fn answer() -> i32 { return 42 }'],
    ])
    const imported = closure.modules.find((module) => module.name === 'app/Main')?.imports.at(0)
    assert.strictEqual(imported?.sourceSpelling, 'toolkit.effect.helpers')
    assert.strictEqual(imported?.canonicalTarget, 'toolkit/effect/helpers')
    assert.strictEqual(imported?.target._tag, 'Resolved')
    assert.deepEqual(closure.diagnostics, [])
  }),
)

it.effect('preserves case and rejects malformed explicit root identities', () =>
  Effect.gen(function* () {
    const mismatch = yield* fixture('app/Main', [
      ['app/Main', `import compiler.Syntax\n${fn}`],
      ['compiler/syntax', fn],
    ])
    assert.deepEqual(
      mismatch.diagnostics.map((diagnostic) => diagnostic.code),
      ['MOD0001'],
    )
    for (const invalid of [
      '/absolute',
      'with.ext',
      'empty//segment',
      'dot/../segment',
      'scheme://module',
    ]) {
      const error = yield* Effect.flip(
        ModuleClosure.load({ root: invalid }).pipe(Effect.provide(SourceResolver.empty)),
      )
      assert.deepEqual(error.reason, { _tag: 'InvalidRoot', module: invalid })
    }
  }),
)

it.effect('resolves root origins and reuses the root on an import back edge', () =>
  Effect.gen(function* () {
    const calls: Array<string> = []
    const origin = SourceOrigin.projectFile('/project/app/Main.silk')
    const resolver = Layer.succeed(SourceResolver.SourceResolver, {
      resolveStandardLibrary: SourceResolver.resolveEmbeddedStandardLibrary,
      resolve: (module: string) =>
        Effect.sync(() => {
          calls.push(module)
          return Option.some(
            SourceResolver.resolved(
              ascii(module === 'app/Main' ? 'import child' : 'import app.Main'),
              origin,
            ),
          )
        }),
    })
    const closure = yield* ModuleClosure.load({ root: 'app/Main' }).pipe(Effect.provide(resolver))
    assert.deepEqual(calls, ['app/Main', 'child'])
    assert.deepEqual(closure.sources.get('app/Main')?.origin, origin)
    assert.deepEqual(closure.cycles, [['app/Main', 'child']])
  }),
)

it.effect('fails unavailable required roots before returning a partial project', () =>
  Effect.gen(function* () {
    const calls: Array<string> = []
    const failure = new SourceResolver.SourceResolverError({
      module: 'broken',
      operation: 'test.root',
      message: 'unreadable root',
      reason: { _tag: 'WrappedFailure', cause: new Error('storage failure') },
    })
    const resolver = Layer.succeed(SourceResolver.SourceResolver, {
      resolveStandardLibrary: SourceResolver.resolveEmbeddedStandardLibrary,
      resolve: Effect.fnUntraced(function* (module: string) {
        calls.push(module)
        if (module === 'broken') return yield* failure
        return Option.none()
      }),
    })
    const invalid = yield* Effect.flip(
      ModuleClosure.loadProject({ roots: ['valid', '../invalid'] }).pipe(Effect.provide(resolver)),
    )
    assert.deepEqual(invalid.reason, { _tag: 'InvalidRoot', module: '../invalid' })
    assert.deepEqual(calls, [])
    const missing = yield* Effect.flip(
      ModuleClosure.loadProject({ roots: ['z', 'a'] }).pipe(Effect.provide(resolver)),
    )
    assert.deepEqual(missing.reason, { _tag: 'MissingRoot', module: 'a' })
    assert.deepEqual(calls, ['a'])
    const unreadable = yield* Effect.flip(
      ModuleClosure.load({ root: 'broken' }).pipe(Effect.provide(resolver)),
    )
    assert.deepEqual(unreadable.reason, {
      _tag: 'RootResolutionFailed',
      module: 'broken',
      error: failure,
    })
    const empty = yield* Effect.flip(
      ModuleClosure.loadProject({ roots: [] }).pipe(Effect.provide(resolver)),
    )
    assert.deepEqual(empty.reason, { _tag: 'EmptyRoots' })
  }),
)

it.effect('shares root, composition, and import outcomes across selected discovery passes', () =>
  Effect.gen(function* () {
    const calls: Array<string> = []
    const sources = new Map([
      [
        'root',
        ascii(
          'import shared\nstatic if true { import selected }\nexport "C" fn main() -> i32 { return 0 }',
        ),
      ],
      ['shared', ascii('pub fn value() -> i32 { return 1 }')],
      ['selected', ascii('import shared')],
    ])
    const resolver = Layer.succeed(SourceResolver.SourceResolver, {
      resolveStandardLibrary: SourceResolver.resolveEmbeddedStandardLibrary,
      resolve: (module: string) =>
        Effect.sync(() => {
          calls.push(module)
          const bytes = sources.get(module)
          return bytes === undefined
            ? Option.none()
            : Option.some(SourceResolver.resolved(bytes, SourceOrigin.memory()))
        }),
    })
    const analysis = yield* Analysis.make({
      root: 'root',
      configuration: {
        profile: {
          target: 'x86_64-unknown-linux-gnu',
          artifact: 'object',
          runtime: { kind: 'none' },
        },
        composition: {
          runtimes: [],
          defaults: [],
          retention: [{ module: 'shared', declaration: 'value' }],
          requirements: [],
        },
      },
    }).pipe(Effect.provide(resolver))
    assert.deepEqual(calls, ['root', 'shared', 'selected'])
    assert.deepEqual(
      analysis.closure.modules.map((module) => module.name),
      ['root', 'selected', 'shared'],
    )
    assert.deepEqual(analysis.diagnostics, [])
  }),
)
