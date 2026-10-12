import * as Layer from 'effect/Layer'
import * as ArtifactComposition from '../src/ArtifactComposition.js'
import * as CompilationProfile from '../src/CompilationProfile.js'
import * as Target from '../src/Target.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Json from './support/Json.js'
import * as Analysis from '../src/Analysis.js'
import * as MirVerification from '../src/MirVerification.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

it.effect('keeps explicit libraries and objects free of default startup and storage roots', () =>
  Effect.gen(function* () {
    for (const target of ['aarch64-apple-darwin', 'wasm32-unknown-unknown']) {
      for (const artifact of ['object', 'loadable-module'] as const) {
        const snapshot = yield* Analysis.makeRealized({
          root: 'library/empty',
          configuration: { profile: { target, artifact } },
        }).pipe(
          Effect.provide(
            SourceResolver.overlay([
              SourceFile.make('library/empty', ascii('pub fn unused() -> i32 { return 42 }')),
            ]).pipe(Layer.provideMerge(SourceResolver.empty)),
          ),
        )
        assert.deepEqual(Analysis.diagnostics(snapshot), [])
        assert.deepEqual(
          Analysis.modules(snapshot).map((module) => module.name),
          ['library/empty'],
        )
        assert.isUndefined(snapshot.artifactPlan?.composition.runtime)
        assert.deepEqual(snapshot.artifactPlan?.composition.components, [])
        const mir = Analysis.loweredMir(snapshot)
        assert.deepEqual(mir.functions, [])
        assert.deepEqual(mir.foreignExports, [])
        assert.deepEqual(yield* MirVerification.verify(mir), [])
      }
    }
  }),
)

const forbiddenArtifactKeys = new Set([
  'allocationScope',
  'destinationScope',
  'finalizerRecord',
  'finalizerRecords',
  'providerDependency',
  'providerDependencies',
  'allocatorKind',
  'runnerCallback',
  'pendingStep',
  'requirementContainer',
  'requirementsContainer',
  'runtimeRequirements',
])

const visit = (value: unknown, path: string, violations: Array<string>): void => {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) visit(item, `${path}[${index}]`, violations)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenArtifactKeys.has(key)) violations.push(`${path}.${key}`)
    visit(child, `${path}.${key}`, violations)
  }
}

it.effect(
  'keeps allocation scopes finalizers provider dependencies and allocator kinds out of artifacts',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* Analysis.ofSourceRealized(
        'architecture/artifacts',
        ascii(
          'fn consume(value: Intrinsic.Allocation) -> i32 { return 0 }\npub fn main() -> i32 { return 42 }',
        ),
        'wasm32-unknown-unknown',
      )
      const violations: Array<string> = []
      visit(snapshot, 'snapshot', violations)
      assert.deepEqual(violations, [])
      assert.notInclude(
        Json.stringify(snapshot, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
        'Arena',
      )
    }),
)

it.effect('selects installed source startup by target and keeps runtime-none independent', () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [Target.Target, CompilationProfile.Libc, string]> = [
      [Target.aarch64AppleDarwin, 'system', 'silk/native_start'],
      [Target.aarch64UnknownLinuxGnu, 'gnu', 'silk/native_start'],
      [Target.x8664UnknownLinuxGnu, 'gnu', 'silk/native_start'],
      [Target.wasm32UnknownUnknown, 'none', 'silk/wasm_start'],
    ]
    for (const [target, libc, module] of cases) {
      const input = ArtifactComposition.defaults({
        target,
        libc,
        artifact: 'executable',
        runtime: { kind: 'default' },
      })
      const selected = yield* ArtifactComposition.decode(input)
      assert.deepEqual(
        selected.runtimes.map((runtime) => runtime.module),
        [module],
      )
      assert.deepEqual(
        selected.components.map((component) => component.capability),
        ['execution-storage'],
      )
      const absent = ArtifactComposition.defaults({
        target,
        libc,
        artifact: 'executable',
        runtime: { kind: 'none' },
      })
      assert.deepEqual(absent.components, [])
    }
    const legacy = yield* Effect.result(
      ArtifactComposition.decode({
        runtimes: [{ name: 'custom', module: 'runtime', invoke: 'start' }],
      }),
    )
    assert.isTrue(legacy._tag === 'Failure')
  }),
)

it.effect('loads default startup before realizing implicit-target convenience requests', () =>
  Effect.gen(function* () {
    const root = SourceFile.make('default/application', ascii('pub fn main() -> i32 { return 42 }'))
    for (const request of [
      Analysis.ofSourceRealized(root.id, Uint8Array.from(root.bytes)),
      Analysis.makeRealized({ root: root.id }).pipe(
        Effect.provide(
          SourceResolver.overlay([root]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      ),
    ]) {
      const snapshot = yield* request
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      assert.strictEqual(snapshot.artifactPlan?.composition.runtime?.module, 'silk/native_start')
      assert.deepEqual(
        Analysis.loweredMir(snapshot)
          .foreignExports.filter((entry) => entry.symbol === 'main')
          .map((entry) => entry.declaration.module),
        ['silk/native_start'],
      )
    }
  }),
)

it.effect(
  'validates default application calls through ordinary source diagnostics',
  () =>
    Effect.gen(function* () {
      const cases = [
        ['missing', 'pub fn answer() -> i32 { return 42 }', 'SEM0014'],
        ['generic', 'pub fn main<T>() -> i32 { return 42 }', 'SEM0052'],
        ['parameters', 'pub fn main(value: i32) -> i32 { return value }', 'SEM0078'],
      ] as const
      for (const [target, runtime] of [
        ['wasm32-unknown-unknown', 'silk/wasm_start'],
        ['x86_64-unknown-linux-gnu', 'silk/native_start'],
      ]) {
        for (const [name, source, code] of cases) {
          const snapshot = yield* Analysis.ofSourceRealized(
            `application/${name}`,
            ascii(source),
            target,
          )
          const diagnostics = Analysis.diagnostics(snapshot)
          const call = diagnostics.find((diagnostic) => diagnostic.code === code)
          assert.isDefined(call, name)
          assert.strictEqual(call?.span.sourceId, runtime)
          assert.notInclude(
            diagnostics.map((diagnostic) => diagnostic.code),
            'SEM0204',
          )
        }
      }
    }),
  { timeout: 120_000 },
)
