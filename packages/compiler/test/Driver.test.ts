import type * as ModuleClosure from '../src/ModuleClosure.js'
import * as CompilerDriver from '../src/Driver.js'
import * as HeapObservation from '../src/HeapObservation.js'
import { rsaWasmSource } from './support/rsaAcceptance.js'
import { aesGcmWasmAcceptanceSource } from './support/aesGcmAcceptance.js'
import { tlsHkdfWasmSource } from './support/tlsHkdfAcceptance.js'
import { tlsRecordWasmSource } from './support/tlsRecordAcceptance.js'
import { x25519WasmAcceptanceSource } from './support/x25519Acceptance.js'
import * as AbiManifest from '../src/AbiManifest.js'
import * as ForeignContract from '../src/ForeignContract.js'
import * as Target from '../src/Target.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, assert, it } from '@effect/vitest'
import * as Config from 'effect/Config'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as TestClock from 'effect/testing/TestClock'
import * as Analysis from '../src/Analysis.js'
import * as NativeLinkInput from '../src/NativeLinkInput.js'
import * as NativeToolchain from '../src/NativeToolchain.js'
import * as Storage from '../src/Storage.js'
import * as SemanticPersistence from '../src/SemanticPersistence.js'
import * as PhaseReport from '../src/PhaseReport.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as ToolchainIntegrity from '../src/ToolchainIntegrity.js'
import * as TestExecution from '../src/TestExecution.js'
import { independentExecutionFinalizedDestroy, invalidGenericCorpus } from './support/corpus.js'
import { ecdsaP256WasmSource } from './support/ecdsaP256Acceptance.js'
import { p256WasmAcceptanceSource } from './support/p256Acceptance.js'
import { chacha20Poly1305WasmSource } from './support/chacha20Poly1305Acceptance.js'
import { certificateWasmAcceptanceSource } from './support/certificateAcceptance.js'
import { certificateProfileWasmSource } from './support/certificateProfileAcceptance.js'
import { certificatePathWasmSource } from './support/certificatePathAcceptance.js'
import { trustSourceWasmSource } from './support/trustSourceAcceptance.js'
import * as Driver from './support/TestDriver.js'

const defaultClang = (): string => {
  if (existsSync('/opt/homebrew/opt/llvm/bin/clang')) return '/opt/homebrew/opt/llvm/bin/clang'
  if (existsSync('/usr/local/opt/llvm/bin/clang')) return '/usr/local/opt/llvm/bin/clang'
  return 'clang'
}

const clang = Effect.runSync(
  Config.String('SILK_TEST_CLANG').pipe(Config.withDefault(defaultClang())),
)
const toolchain: NativeToolchain.Toolchain = Object.freeze({
  _tag: 'Toolchain',
  clang,
  llvmAr: 'llvm-ar',
  runtimeObjectCache: NativeToolchain.makeRuntimeObjectCache(),
})

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const destinationRoot = mkdtempSync(join(tmpdir(), 'silk-driver-test-'))
afterAll(() => {
  rmSync(destinationRoot, { recursive: true, force: true })
})

const compileSource = (
  name: string,
  text: string,
  overrides: Partial<Driver.CompileRequest> = {},
): Effect.Effect<
  Driver.Outcome,
  ModuleClosure.ModuleClosureError | Driver.SourceResolutionFailed | NativeToolchain.ToolchainError
> =>
  Driver.compile({
    compilation: {
      root: 'memory/driver',
    },
    toolchain,
    optimization: 'release',
    destination: join(destinationRoot, name),
    // This file asserts exact phase reports, so it builds uncached unless a test opts back in.
    cache: false,
    ...overrides,
    artifactKind: overrides.artifactKind ?? 'NativeExecutable',
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([
        SourceFile.make(overrides.compilation?.root ?? 'memory/driver', ascii(text)),
      ]).pipe(Layer.provideMerge(SourceResolver.empty)),
    ),
  )

const expectedPhases = [
  'toolchain-integrity',
  'closure',
  'declaration-collection',
  'declaration-index',
  'name-resolution',
  'module-surface',
  'declaration-collection',
  'declaration-index',
  'name-resolution',
  'module-surface',
  'elaboration',
  'ownership',
  'opaque-realization',
  'instance-discovery',
  'target-layout',
  'mir-lowering',
  'toolchain-target',
  'mir-verification',
  'backend',
  'object',
  'runtime',
  'link',
]

it.effect('consumes a shorthand target when synthesizing the complete profile', () =>
  Effect.gen(function* () {
    const outcome = yield* compileSource(
      'shorthand-target.ll',
      'pub fn main() -> i32 { return 42 }',
      {
        compilation: {
          root: 'memory/shorthand-target',
          target: 'wasm32-unknown-unknown',
        },
        artifactKind: 'WebAssemblyModule',
        stage: 'llvm-ir',
      },
    )

    assert.strictEqual(outcome._tag, 'Compiled')
  }),
)

it.effect('publishes the runtime test catalog without result-cache identities when disabled', () =>
  Effect.gen(function* () {
    const root = 'memory/uncached-driver-tests'
    const outcome = yield* compileSource(
      'uncached-test-catalog',
      `test fn uncached() -> () {}
pub fn main() -> () {
  static for descriptor in Intrinsic.tests() {
    let body = Intrinsic.testFunction(descriptor)
    body()
  }
}`,
      {
        testResultCache: false,
        compilation: {
          root,
          discovery: {
            root,
            sources: new Map([
              [root, { ownership: 'Project', logicalPath: 'tests/uncached-driver-tests.silk' }],
            ]),
          },
        },
      },
    )
    assert.strictEqual(outcome._tag, 'Compiled')
    if (outcome._tag !== 'Compiled') return
    assert.deepStrictEqual(
      outcome.testCatalog?.entries.map((entry) => entry.name),
      ['uncached'],
    )
    assert.isUndefined(outcome.testManifest)
  }),
)

it.effect('publishes a manifest and execution environment for a discovered-test executable', () =>
  Effect.gen(function* () {
    const root = 'memory/driver-tests'
    const outcome = yield* compileSource(
      'test-execution-manifest',
      `test fn alpha() -> () {}
test fn beta() -> () {}
pub fn main() -> () {
  static for descriptor in Intrinsic.tests() {
    let body = Intrinsic.testFunction(descriptor)
    body()
  }
}`,
      {
        compilation: {
          root,
          discovery: {
            root,
            sources: new Map([
              [root, { ownership: 'Project', logicalPath: 'tests/driver-tests.silk' }],
            ]),
          },
        },
      },
    )

    assert.deepEqual(
      outcome._tag === 'Rejected' ? outcome.diagnostics.map((diagnostic) => diagnostic.code) : [],
      [],
    )
    assert.strictEqual(outcome._tag, 'Compiled')
    if (outcome._tag !== 'Compiled') return
    assert.deepEqual(
      outcome.testManifest?.entries.map((entry) => entry.test.name),
      ['alpha', 'beta'],
    )
    assert.deepEqual(
      outcome.testManifest?.entries.map((entry) => entry.eligibility._tag),
      ['Eligible', 'Eligible'],
    )
    assert.deepStrictEqual(
      outcome.testCatalog?.entries,
      outcome.testManifest?.entries.map((entry) => entry.test),
    )

    const plan = outcome.linkPlan
    const bindingsIdentity = outcome.nativeBindings?.identity
    assert.isDefined(plan)
    assert.isDefined(bindingsIdentity)
    if (plan === undefined || bindingsIdentity === undefined) return
    const generated = plan.inputs
      .filter((input) => input.path.includes('silk-driver-'))
      .map((input) => input.path)
    const external = plan.inputs.find((input) => !generated.includes(input.path))
    assert.isDefined(external)
    if (external === undefined) return
    const native = TestExecution.nativeIdentity(plan, generated, bindingsIdentity, 'helper-policy')
    const generatedChanged = {
      ...plan,
      inputs: plan.inputs.map((input) =>
        generated.includes(input.path) ? { ...input, digest: `changed:${input.digest}` } : input,
      ),
    }
    const externalChanged = {
      ...plan,
      inputs: plan.inputs.map((input) =>
        input.path === external.path ? { ...input, digest: `changed:${input.digest}` } : input,
      ),
    }
    assert.strictEqual(
      TestExecution.nativeIdentity(generatedChanged, generated, bindingsIdentity, 'helper-policy'),
      native,
    )
    assert.notStrictEqual(
      TestExecution.nativeIdentity(externalChanged, generated, bindingsIdentity, 'helper-policy'),
      native,
    )
    assert.notStrictEqual(
      TestExecution.nativeIdentity(
        {
          ...plan,
          supply: {
            ...plan.supply,
            target:
              plan.supply.target.id === Target.aarch64AppleDarwin.id
                ? Target.x8664UnknownLinuxGnu
                : Target.aarch64AppleDarwin,
          },
        },
        generated,
        bindingsIdentity,
        'helper-policy',
      ),
      native,
    )
    assert.notStrictEqual(
      TestExecution.nativeIdentity(
        {
          ...plan,
          supply: {
            ...plan.supply,
            compiler: { ...plan.supply.compiler, digest: 'changed-compiler' },
          },
        },
        generated,
        bindingsIdentity,
        'helper-policy',
      ),
      native,
    )
    assert.notStrictEqual(
      TestExecution.nativeIdentity(plan, generated, bindingsIdentity, 'changed-helper-policy'),
      native,
    )

    const distribution = ToolchainIntegrity.installed()
    const runtime = TestExecution.runtimeIdentity(distribution)
    const runtimeComponent = distribution.components.find(
      (component) => component.kind === 'RuntimeSupport',
    )
    const sourceComponent = distribution.components.find((component) => component.kind === 'Source')
    assert.isDefined(runtimeComponent)
    assert.isDefined(sourceComponent)
    if (runtimeComponent === undefined || sourceComponent === undefined) return
    assert.notStrictEqual(
      TestExecution.runtimeIdentity({
        ...distribution,
        components: distribution.components.map((component) =>
          component.id === runtimeComponent.id
            ? { ...component, digest: 'changed-runtime' }
            : component,
        ),
      }),
      runtime,
    )
    assert.strictEqual(
      TestExecution.runtimeIdentity({
        ...distribution,
        components: distribution.components.map((component) =>
          component.id === sourceComponent.id
            ? { ...component, digest: 'changed-source' }
            : component,
        ),
      }),
      runtime,
    )
  }),
)

it.effect(
  'forwards semantic persistence and bypasses it when compilation caching is disabled',
  () =>
    Effect.gen(function* () {
      const storage = Storage.memoryService()
      const persistence = () =>
        SemanticPersistence.make({
          storage,
          compilerIdentity: ToolchainIntegrity.installed().digest,
          maximumRecordBytes: 16 * 1024 * 1024,
        })
      // Reject before emission: this tests Driver's preparation wiring without invoking LLVM.
      const source = 'pub fn main() -> i32 { return missing }'
      const cold = persistence()
      const first = yield* compileSource('semantic-cache-cold', source, {
        cache: true,
      }).pipe(Effect.provideService(SemanticPersistence.SemanticPersistence, cold))
      assert.strictEqual(first._tag, 'Rejected')
      assert.isAbove(SemanticPersistence.counters(cold).published, 0)

      const warm = persistence()
      const second = yield* compileSource('semantic-cache-warm', source, {
        cache: true,
      }).pipe(Effect.provideService(SemanticPersistence.SemanticPersistence, warm))
      assert.strictEqual(second._tag, 'Rejected')
      assert.isAbove(SemanticPersistence.counters(warm).loaded, 0)

      const disabled = persistence()
      const before = SemanticPersistence.counters(disabled)
      const fresh = yield* compileSource('semantic-cache-disabled', source, {
        cache: false,
      }).pipe(Effect.provideService(SemanticPersistence.SemanticPersistence, disabled))
      assert.strictEqual(fresh._tag, 'Rejected')
      assert.deepEqual(SemanticPersistence.counters(disabled), before)
      if (first._tag === 'Rejected' && second._tag === 'Rejected' && fresh._tag === 'Rejected') {
        const diagnostics = (outcome: Driver.Rejected) =>
          outcome.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.span])
        assert.deepEqual(diagnostics(second), diagnostics(first))
        assert.deepEqual(diagnostics(fresh), diagnostics(first))
      }
    }),
  // Three cache paths took 19.8s locally on 2026-09-23 and exceeded 60s in CI shard 4.
  120_000,
)

it.effect('measures Effect phases with the fiber clock', () =>
  Effect.gen(function* () {
    const reports: Array<PhaseReport.PhaseReport> = []
    const value = yield* PhaseReport.measureEffectInto(
      reports,
      'controlled-clock',
      1,
      Effect.gen(function* () {
        yield* TestClock.adjust(1250)
        return 42
      }),
      () => 1,
    )
    assert.strictEqual(value, 42)
    assert.strictEqual(reports.at(0)?.elapsedMs, 1250)
  }),
)

it.effect(
  'reports every phase in order with counts and totals',
  () =>
    Effect.gen(function* () {
      const source = 'pub fn main() -> i32 { let values = [10, 42] return values[1] }'
      const outcome = yield* compileSource('report', source)
      const analysis = yield* Analysis.ofSourceRealized('memory/driver', ascii(source))

      assert.strictEqual(outcome._tag, 'Compiled')
      if (outcome._tag !== 'Compiled') return
      assert.deepEqual(
        outcome.report.map((entry) => entry.phase),
        expectedPhases,
      )
      for (const entry of outcome.report) {
        assert.isAtLeast(entry.elapsedMs, 0, entry.phase)
        assert.isAtLeast(entry.outputs, 0, entry.phase)
        assert.isAtLeast(entry.heapBytes, 0, entry.phase)
      }
      const layout = outcome.report.find((entry) => entry.phase === 'target-layout')
      assert.isAtLeast(layout?.outputs ?? 0, 2)
      const closure = outcome.report.find((entry) => entry.phase === 'closure')
      assert.strictEqual(closure?.inputs, 1)
      // The initial closure contains the application and selected runtime; static selection expands it.
      assert.strictEqual(closure?.outputs, 2)
      const compilerPhases = expectedPhases.slice(1, expectedPhases.indexOf('toolchain-target'))
      assert.deepEqual(
        Analysis.phases(analysis)
          .map((entry) => entry.phase)
          .filter((phase) => phase !== 'semantic-occurrences' && phase !== 'anonymous-expressions'),
        compilerPhases,
      )
    }),
  { timeout: 120_000 },
)

it.effect('omits the MIR audit by default in the compiler driver', () =>
  Effect.gen(function* () {
    const outcome = yield* CompilerDriver.compile({
      compilation: {
        root: 'memory/default-verification',
      },
      packageName: 'verification-test',
      toolchain,
      artifactKind: 'NativeExecutable',
      stage: 'llvm-ir',
      destination: join(destinationRoot, 'default-verification.ll'),
      cache: false,
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'memory/default-verification',
            ascii('pub fn main() -> i32 { return 42 }'),
          ),
        ]).pipe(Layer.provideMerge(Layer.merge(SourceResolver.empty, HeapObservation.layerTest))),
      ),
    )
    assert.strictEqual(outcome._tag, 'Compiled')
    assert.isFalse(outcome.report.some((entry) => entry.phase === 'mir-verification'))
  }),
)

it.effect('keeps array failures in their owning phase', () =>
  Effect.gen(function* () {
    const mismatch = yield* compileSource(
      'array-mismatch',
      'pub fn main() -> [i32; 2] { return [1] }',
    )
    assert.strictEqual(mismatch._tag, 'Rejected')
    assert.strictEqual(
      mismatch.report.some((entry) => entry.phase === 'target-layout'),
      false,
    )

    const unavailable = yield* compileSource(
      'array-unavailable-layout',
      `fn consume(values: [[[i32; 2147483647]; 2147483647]; 0]) -> i32 { return 42 }
pub fn main() -> i32 { return consume([]) }`,
    )
    assert.strictEqual(unavailable._tag, 'VerificationFailed')
    if (unavailable._tag !== 'VerificationFailed') return
    assert.isAbove(unavailable.error.violations.length, 0)
    assert.strictEqual(unavailable.report.at(-1)?.phase, 'mir-verification')
    assert.strictEqual(
      unavailable.report.some((entry) => entry.phase === 'object'),
      false,
    )
  }),
)

it.effect('gates source rejection and operational resolution failure before backend work', () =>
  Effect.gen(function* () {
    const rejected = yield* compileSource('rejected', 'pub fn main() -> Mystery { return 42 }')
    assert.strictEqual(rejected._tag, 'Rejected')
    assert.strictEqual(
      rejected.report.some((entry) => entry.phase === 'target-layout'),
      false,
    )

    const resolver = Layer.succeed(SourceResolver.SourceResolver, {
      resolveStandardLibrary: SourceResolver.resolveEmbeddedStandardLibrary,
      resolve: (module: string) =>
        Effect.fail(
          new SourceResolver.SourceResolverError({
            operation: 'test.resolve',
            module,
            message: `cannot read ${module}`,
            reason: { _tag: 'WrappedFailure', cause: new Error(module) },
          }),
        ),
    })
    const failed = yield* Effect.result(
      Driver.compile({
        compilation: {
          root: 'memory/driver',
        },
        toolchain,
        optimization: 'release',
        artifactKind: 'NativeExecutable',
        destination: join(destinationRoot, 'resolution-failed'),
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make(
              'memory/driver',
              ascii('import unreadable\npub fn main() -> i32 { return 42 }'),
            ),
          ]).pipe(Layer.provideMerge(resolver)),
        ),
      ),
    )
    assert.strictEqual(failed._tag, 'Failure')
    if (failed._tag === 'Failure') {
      assert.strictEqual(failed.failure._tag, 'SourceResolutionFailed')
      if (failed.failure._tag !== 'SourceResolutionFailed') return
      assert.deepEqual(
        failed.failure.failures.map((failure) => failure.module),
        ['unreadable'],
      )
      assert.strictEqual(
        failed.failure.report.some((entry) => entry.phase === 'target-layout'),
        false,
      )
    }
  }),
)

it.effect('rejects a mismatched distribution before resolving user imports', () =>
  Effect.gen(function* () {
    const installed = ToolchainIntegrity.installed()
    const mismatched = ToolchainIntegrity.make(
      installed.components.map((component) =>
        component.kind === 'Catalog' ? { ...component, digest: 'f'.repeat(64) } : component,
      ),
    )
    let projectResolutions = 0
    const resolver = Layer.succeed(SourceResolver.SourceResolver, {
      resolveStandardLibrary: SourceResolver.resolveEmbeddedStandardLibrary,
      resolve: () => {
        projectResolutions += 1
        return Effect.succeedNone
      },
    })
    const outcome = yield* Driver.compile({
      compilation: {
        root: 'memory/driver',
      },
      toolchain,
      optimization: 'release',
      artifactKind: 'NativeExecutable',
      destination: join(destinationRoot, 'mismatched-distribution'),
      distribution: mismatched,
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            'memory/driver',
            ascii('import missing/project\npub fn main() -> i32 { return 42 }'),
          ),
        ]).pipe(Layer.provideMerge(resolver)),
      ),
    )

    assert.strictEqual(outcome._tag, 'ToolchainFailed')
    assert.strictEqual(projectResolutions, 0)
    assert.deepEqual(
      outcome.report.map((entry) => entry.phase),
      ['toolchain-integrity'],
    )
  }),
)

it.effect(
  'rejects missing promised runtime support after reachable planning and before emission',
  () =>
    Effect.gen(function* () {
      const distribution = ToolchainIntegrity.make(
        ToolchainIntegrity.installed().components.filter(
          (component) =>
            component.kind !== 'RuntimeSupport' || !component.id.endsWith('/Intrinsic.i32Add'),
        ),
      )
      const outcome = yield* compileSource(
        'missing-runtime',
        'pub fn main() -> i32 { return Intrinsic.i32Add(20, 22) }',
        { distribution },
      )

      assert.strictEqual(outcome._tag, 'ToolchainFailed')
      assert.strictEqual(outcome.report.at(-1)?.phase, 'toolchain-target')
      assert.isFalse(outcome.report.some((entry) => entry.phase === 'backend'))
    }),
)

it.effect(
  'reports a missing application call through source diagnostics before the toolchain',
  () =>
    Effect.gen(function* () {
      const outcome = yield* compileSource('no-entry', 'pub fn answer() -> i32 { return 42 }')

      assert.strictEqual(outcome._tag, 'Rejected')
      if (outcome._tag !== 'Rejected') return
      assert.isAbove(outcome.diagnostics.length, 0)
      assert.strictEqual(
        outcome.report.some((entry) => entry.phase === 'object'),
        false,
      )
    }),
)

it.effect('names the failing native stage with command provenance', () =>
  Effect.gen(function* () {
    const outcome = yield* Effect.result(
      compileSource('bad-toolchain', 'pub fn main() -> i32 { return 42 }', {
        toolchain: Object.freeze({
          _tag: 'Toolchain',
          clang: '/nonexistent/clang',
          llvmAr: 'llvm-ar',
        }),
      }),
    )

    assert.strictEqual(outcome._tag, 'Failure')
    if (outcome._tag !== 'Failure') return
    assert.strictEqual(outcome.failure._tag, 'ToolchainError')
    if (outcome.failure._tag !== 'ToolchainError') return
    assert.strictEqual(outcome.failure.stage, 'supply')
    assert.strictEqual(outcome.failure.reason._tag, 'SupplyFailed')
    if (outcome.failure.reason._tag !== 'SupplyFailed') return
    assert.strictEqual(outcome.failure.reason.failure.subject, '/nonexistent/clang')
    assert.strictEqual(outcome.failure.reason.failure.code, 'MissingCapability')
  }),
)

for (const program of invalidGenericCorpus) {
  it.effect(`rejects ${program.name} before layout and MIR`, () =>
    Effect.gen(function* () {
      const outcome = yield* compileSource(program.name, program.source)
      assert.strictEqual(outcome._tag, 'Rejected', program.name)
      if (outcome._tag !== 'Rejected') return
      const codes = outcome.diagnostics.map((diagnostic) => diagnostic.code)
      for (const code of program.codes) assert.include(codes, code, program.name)
      const phases = outcome.report.map((entry) => entry.phase)
      assert.notInclude(phases, 'target-layout', program.name)
      assert.notInclude(phases, 'mir-lowering', program.name)
      assert.notInclude(phases, 'backend', program.name)
      if (!program.codes.includes('SEM0053')) {
        assert.notInclude(phases, 'instance-discovery', program.name)
      }
    }),
  )
}

it.effect('stops unsupported targets before MIR or native tools', () =>
  Effect.gen(function* () {
    for (const target of ['mips-unknown-none']) {
      const outcome = yield* compileSource(
        `target-${target}`,
        'pub fn main() -> i32 { return 42 }',
        {
          compilation: {
            root: 'memory/driver',
            target,
          },
        },
      )

      assert.strictEqual(outcome._tag, 'TargetFailed')
      assert.strictEqual(
        outcome.report.some((entry) => entry.phase === 'mir-lowering'),
        false,
      )
      assert.strictEqual(
        outcome.report.some((entry) => entry.phase === 'object'),
        false,
      )
    }
  }),
)

it.effect(
  'admits native final caching only after complete resolution and retains backend reuse',
  () =>
    Effect.gen(function* () {
      const entries = new Map<string, Uint8Array>()
      const reads: Array<string> = [],
        writes: Array<string> = []
      const artifactStorage: Storage.Service = Storage.Storage.of({
        read: (address) =>
          Effect.sync(() => {
            reads.push(address.key)
            const found = entries.get(address.key)
            return found === undefined ? Option.none() : Option.some(found)
          }),
        publish: (address, bytes) =>
          Effect.sync(() => {
            writes.push(address.key)
            entries.set(address.key, Uint8Array.from(bytes))
          }),
      })
      const source = 'pub fn main() -> i32 { return 42 }'
      for (const name of ['admission-first', 'admission-second']) {
        const outcome = yield* compileSource(name, source, { cache: true }).pipe(
          Effect.provideService(NativeToolchain.ArtifactStorage, artifactStorage),
        )
        assert.strictEqual(outcome._tag, 'Compiled')
        if (outcome._tag !== 'Compiled') return
        const phases = outcome.report.map((entry) => entry.phase)
        assert.include(phases, name === 'admission-first' ? 'link' : 'artifact-cache')
        assert.isDefined(outcome.linkPlan)
        assert.isFalse(outcome.linkPlan?.command.arguments.includes('-lm') ?? true)
        if (name === 'admission-second') assert.include(phases, 'backend-cache')
      }
      const nativeReads = reads.filter((key) => key.startsWith('native-')).length
      const failed = yield* Effect.result(
        compileSource('admission-missing-library', source, {
          cache: true,
          nativeLinkInputs: [NativeLinkInput.library('silk_missing_admission_fixture', 'Dynamic')],
        }).pipe(Effect.provideService(NativeToolchain.ArtifactStorage, artifactStorage)),
      )
      assert.strictEqual(failed._tag, 'Failure')
      if (failed._tag !== 'Failure' || failed.failure._tag !== 'ToolchainError')
        return assert.fail('expected toolchain failure')
      assert.strictEqual(failed.failure.reason._tag, 'SupplyFailed')
      if (failed.failure.reason._tag === 'SupplyFailed')
        assert.strictEqual(failed.failure.reason.failure.code, 'MissingCapability')
      assert.strictEqual(reads.filter((key) => key.startsWith('native-')).length, nativeReads)
      assert.strictEqual(writes.filter((key) => key.startsWith('native-')).length, 1)
    }),
  // Cold emission, cache reuse and a rejected supply took 39.9s locally on 2026-09-23;
  // the three complete source runtime pipelines exceeded 120s in CI shard 4.
  240_000,
)

it.effect('reports a missing request-supplied object as linker input even when cached', () =>
  Effect.gen(function* () {
    const missing = join(destinationRoot, 'missing-extra.o')
    const destination = join(destinationRoot, 'native-link-inputs')
    const result = yield* Effect.result(
      compileSource('native-link-inputs', 'pub fn main() -> i32 { return 42 }', {
        cache: true,
        nativeLinkInputs: [
          NativeLinkInput.object(missing),
          NativeLinkInput.library('c', 'Dynamic'),
        ],
      }),
    )
    assert.strictEqual(result._tag, 'Failure')
    if (result._tag !== 'Failure') return
    assert.strictEqual(result.failure._tag, 'ToolchainError')
    if (result.failure._tag !== 'ToolchainError') return
    assert.strictEqual(result.failure.stage, 'link')
    assert.strictEqual(result.failure.reason._tag, 'LinkFailed')
    if (result.failure.reason._tag !== 'LinkFailed') return
    assert.strictEqual(result.failure.reason.status, null)
    assert.strictEqual(result.failure.reason.output, `missing linker input: ${missing}`)
    const args = result.failure.reason.planned.arguments
    assert.deepEqual(args.slice(args.indexOf(missing)), [missing, '-lc', '-o', destination])
  }),
)

it.effect('translates an artifact Storage read failure at the Driver boundary', () =>
  Effect.gen(function* () {
    const cause = Object.freeze({ injected: 'artifact-cache-read' })
    const error = new Storage.StorageError({
      operation: 'Storage.read',
      namespace: 'native-artifacts',
      key: 'injected',
      message: 'injected read failure',
      reason: { _tag: 'ReadFailure', cause },
    })
    const artifactStorage: Storage.Service = Storage.Storage.of({
      read: () => Effect.fail(error),
      publish: () => Effect.void,
    })
    const result = yield* Effect.result(
      compileSource('throwing-artifact-cache-read', 'pub fn main() -> i32 { return 42 }', {
        cache: true,
      }).pipe(Effect.provideService(NativeToolchain.ArtifactStorage, artifactStorage)),
    )
    assert.strictEqual(result._tag, 'Failure')
    if (result._tag !== 'Failure') return
    assert.strictEqual(result.failure._tag, 'ToolchainError')
    if (result.failure._tag !== 'ToolchainError') return
    assert.strictEqual(result.failure.operation, 'NativeToolchain.ArtifactCache.get')
    assert.strictEqual(result.failure.stage, 'cache-read')
    assert.strictEqual(result.failure.reason._tag, 'StorageFailed')
    if (result.failure.reason._tag !== 'StorageFailed') return
    assert.strictEqual(result.failure.reason.cause, error)
  }),
)

it.effect('translates an artifact Storage publication failure at the Driver boundary', () =>
  Effect.gen(function* () {
    const cause = Object.freeze({ injected: 'artifact-cache-write' })
    const error = new Storage.StorageError({
      operation: 'Storage.publish',
      namespace: 'native-artifacts',
      key: 'injected',
      message: 'injected publication failure',
      reason: { _tag: 'PublishFailure', cause },
    })
    const artifactStorage: Storage.Service = Storage.Storage.of({
      read: () => Effect.succeedNone,
      publish: () => Effect.fail(error),
    })
    const result = yield* Effect.result(
      compileSource('throwing-artifact-cache-write', 'pub fn main() -> i32 { return 42 }', {
        cache: true,
      }).pipe(Effect.provideService(NativeToolchain.ArtifactStorage, artifactStorage)),
    )
    assert.strictEqual(result._tag, 'Failure')
    if (result._tag !== 'Failure') return
    assert.strictEqual(result.failure._tag, 'ToolchainError')
    if (result.failure._tag !== 'ToolchainError') return
    assert.strictEqual(result.failure.operation, 'NativeToolchain.ArtifactCache.set')
    assert.strictEqual(result.failure.stage, 'cache-write')
    assert.strictEqual(result.failure.reason._tag, 'StorageFailed')
    if (result.failure.reason._tag !== 'StorageFailed') return
    assert.strictEqual(result.failure.reason.cause, error)
  }),
)

it.effect(
  'selects the durable disk cache from SILK_NATIVE_CACHE_DIR by default',
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), 'silk-default-cache-'))),
      (cacheDirectory) =>
        Effect.gen(function* () {
          // No artifact Storage is pinned on either toolchain: the durable reuse below can only come
          // from the environment-selected default, and each compile builds its own toolchain value
          // so nothing is shared between them but the directory.
          const source = 'pub fn main() -> i32 { return 40 + 2 }'
          const first = yield* compileSource('default-cache-first', source, {
            verifyMir: false,
            toolchain: Object.freeze({ _tag: 'Toolchain', clang, llvmAr: 'llvm-ar' }),
            cache: true,
          })
          const second = yield* compileSource('default-cache-second', source, {
            toolchain: Object.freeze({ _tag: 'Toolchain', clang, llvmAr: 'llvm-ar' }),
            cache: true,
          })
          assert.strictEqual(first._tag, 'Compiled')
          assert.strictEqual(second._tag, 'Compiled')
          if (first._tag !== 'Compiled' || second._tag !== 'Compiled') return
          assert.strictEqual(
            first.report.some((entry) => entry.phase === 'link'),
            true,
          )
          assert.strictEqual(
            second.report.some((entry) => entry.phase === 'backend-cache'),
            true,
          )
          assert.strictEqual(
            second.report.some((entry) => entry.phase === 'artifact-cache'),
            true,
          )
          assert.isFalse(first.report.some((entry) => entry.phase === 'mir-verification'))
          assert.isBelow(
            second.report.findIndex((entry) => entry.phase === 'mir-verification'),
            second.report.findIndex((entry) => entry.phase === 'backend-cache'),
          )
          assert.isTrue(second.report.some((entry) => entry.phase === 'mir-verification'))
          assert.deepEqual(readFileSync(second.path), readFileSync(first.path))
          const run = spawnSync(second.path, [], { encoding: 'utf8' })
          assert.strictEqual(run.status, 42)
        }).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ SILK_NATIVE_CACHE_DIR: cacheDirectory }),
          ),
        ),
      (cacheDirectory) =>
        Effect.sync(() => rmSync(cacheDirectory, { recursive: true, force: true })),
    ),
  { timeout: 120_000 },
)

it.effect('rejects a supplied foreign contract before backend-cache or native-tool access', () =>
  Effect.gen(function* () {
    const text =
      'unsafe extern "C" fn foreign_operation() -> i32\npub fn main() -> i32 { return unsafe foreign_operation() }'
    const root = SourceFile.make('memory/driver', ascii(text))
    const supplied = SourceFile.make(
      'interfaces/vendor.abi.json',
      AbiManifest.encode(
        AbiManifest.make(
          Target.aarch64AppleDarwin,
          [
            {
              variadic: false,
              symbol: 'foreign_operation',
              parameters: [],
              result: 'i32',
              contract: { ...ForeignContract.conservative, memory: 'none' },
            },
          ],
          [],
          [],
        ),
      ),
    )
    let cacheReads = 0
    const outcome = yield* compileSource('rejected-interface', text, {
      compilation: { root: root.id, target: 'aarch64-apple-darwin' },
      foreignInterfaces: [supplied],
      cache: true,
      toolchain: { ...toolchain, clang: 'must-not-invoke-clang' },
    }).pipe(
      Effect.provideService(
        NativeToolchain.ArtifactStorage,
        Storage.Storage.of({
          read: () =>
            Effect.sync(() => {
              cacheReads += 1
              return Option.none()
            }),
          publish: () => Effect.void,
        }),
      ),
    )
    assert.strictEqual(outcome._tag, 'Rejected')
    if (outcome._tag !== 'Rejected') return
    const mismatch = outcome.diagnostics.find((diagnostic) => diagnostic.code === 'SEM0192')
    assert.strictEqual(mismatch?.span.sourceId, supplied.id)
    assert.strictEqual(mismatch?.relatedSpans?.at(0)?.span.sourceId, root.id)
    assert.isTrue(outcome.sources.has(supplied.id))
    assert.strictEqual(cacheReads, 0)
    assert.isFalse(existsSync(join(destinationRoot, 'rejected-interface')))
  }),
)

// The native corpus covers the full profile; this one portability leg exercises owned byte views
// and strict PEM decoding with wasm32 pointer widths and the shipped Wasm allocator.
it.effect('executes bounded certificate decoding through LLVM-to-Wasm', () =>
  Effect.gen(function* () {
    const outcome = yield* compileSource('certificate.wasm', certificateWasmAcceptanceSource, {
      compilation: {
        root: 'memory/certificate-wasm',
        target: 'wasm32-unknown-unknown',
      },
      artifactKind: 'WebAssemblyModule',
    })
    assert.strictEqual(outcome._tag, 'Compiled')
    if (outcome._tag !== 'Compiled') return
    const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
    assert.deepEqual(WebAssembly.Module.imports(module), [])
    const instance = new WebAssembly.Instance(module)
    const main = instance.exports['main']
    assert.isFunction(main)
    if (typeof main === 'function') assert.strictEqual(main(), 0)
  }),
)

it.effect(
  'stores an unsupported certificate trust anchor through LLVM-to-Wasm',
  () =>
    Effect.gen(function* () {
      const outcome = yield* compileSource(
        'certificate-profile.wasm',
        certificateProfileWasmSource,
        {
          compilation: {
            root: 'memory/certificate-profile-wasm',
            target: 'wasm32-unknown-unknown',
          },
          artifactKind: 'WebAssemblyModule',
        },
      )
      assert.strictEqual(outcome._tag, 'Compiled')
      if (outcome._tag !== 'Compiled') return
      const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
      assert.deepEqual(WebAssembly.Module.imports(module), [])
      const instance = new WebAssembly.Instance(module)
      const main = instance.exports['main']
      assert.isFunction(main)
      if (typeof main === 'function') assert.strictEqual(main(), 42)
    }),
  300_000,
)

it.effect(
  'executes bounded certificate-path validation through LLVM-to-Wasm',
  () =>
    Effect.gen(function* () {
      const outcome = yield* compileSource('certificate-path.wasm', certificatePathWasmSource, {
        compilation: {
          root: 'memory/certificate-path-wasm',
          target: 'wasm32-unknown-unknown',
        },
        artifactKind: 'WebAssemblyModule',
      })
      assert.strictEqual(outcome._tag, 'Compiled')
      if (outcome._tag !== 'Compiled') return
      const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
      assert.deepEqual(WebAssembly.Module.imports(module), [])
      const instance = new WebAssembly.Instance(module)
      const main = instance.exports['main']
      assert.isFunction(main)
      if (typeof main === 'function') assert.strictEqual(main(), 0)
    }),
  300_000,
)

it.effect(
  'copies empty explicit trust through LLVM-to-Wasm',
  () =>
    Effect.gen(function* () {
      const outcome = yield* compileSource('trust-source.wasm', trustSourceWasmSource, {
        compilation: {
          root: 'memory/trust-source-wasm',
          target: 'wasm32-unknown-unknown',
        },
        artifactKind: 'WebAssemblyModule',
      })
      assert.strictEqual(
        outcome._tag,
        'Compiled',
        outcome._tag === 'Rejected'
          ? outcome.diagnostics
              .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
              .join('\n')
          : undefined,
      )
      if (outcome._tag !== 'Compiled') return
      const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
      assert.deepEqual(WebAssembly.Module.imports(module), [])
      const instance = new WebAssembly.Instance(module)
      const main = instance.exports['main']
      assert.isFunction(main)
      if (typeof main === 'function') assert.strictEqual(main(), 42)
    }),
  300_000,
)

it.effect(
  'runs structured cancellation finalizers through LLVM-to-Wasm',
  () =>
    Effect.gen(function* () {
      const outcome = yield* compileSource(
        'execution-finalized-destroy.wasm',
        independentExecutionFinalizedDestroy,
        {
          compilation: {
            root: 'memory/execution-finalized-destroy-wasm',
            target: 'wasm32-unknown-unknown',
          },
          artifactKind: 'WebAssemblyModule',
        },
      )
      assert.strictEqual(outcome._tag, 'Compiled')
      if (outcome._tag !== 'Compiled') return
      const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
      assert.deepEqual(WebAssembly.Module.imports(module), [])
      const instance = new WebAssembly.Instance(module)
      const main = instance.exports['main']
      assert.isFunction(main)
      if (typeof main === 'function') assert.strictEqual(main(), 42)
    }),
  300_000,
)

// A single portability leg covers 64-bit MAC arithmetic and 32-bit slice addressing.
it.effect('executes ChaCha20-Poly1305 through LLVM-to-Wasm', () =>
  Effect.gen(function* () {
    const outcome = yield* compileSource('chacha20-poly1305.wasm', chacha20Poly1305WasmSource, {
      compilation: {
        root: 'memory/chacha20-poly1305-wasm',
        target: 'wasm32-unknown-unknown',
      },
      artifactKind: 'WebAssemblyModule',
    })
    assert.strictEqual(outcome._tag, 'Compiled')
    if (outcome._tag !== 'Compiled') return
    const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
    assert.deepEqual(WebAssembly.Module.imports(module), [])
    const instance = new WebAssembly.Instance(module)
    const main = instance.exports['main']
    assert.isFunction(main)
    if (typeof main === 'function') assert.strictEqual(main(), 42)
  }),
)

// The native corpus covers the full profile; this one portability leg exercises partial AES blocks and 64-bit GHASH
// plus authentication failure preservation with wasm32 pointer widths and the shipped Wasm allocator.
it.effect('executes bounded AES-GCM through LLVM-to-Wasm', () =>
  Effect.gen(function* () {
    const outcome = yield* compileSource('aes-gcm.wasm', aesGcmWasmAcceptanceSource, {
      compilation: {
        root: 'memory/aes-gcm-wasm',
        target: 'wasm32-unknown-unknown',
      },
      artifactKind: 'WebAssemblyModule',
    })
    assert.strictEqual(outcome._tag, 'Compiled')
    if (outcome._tag !== 'Compiled') return
    const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
    assert.deepEqual(WebAssembly.Module.imports(module), [])
    const instance = new WebAssembly.Instance(module)
    const main = instance.exports['main']
    assert.isFunction(main)
    if (typeof main === 'function') assert.strictEqual(main(), 0)
  }),
)

it.effect('executes P-256 agreement through LLVM-to-Wasm without host imports', () =>
  Effect.gen(function* () {
    const outcome = yield* compileSource('p256.wasm', p256WasmAcceptanceSource, {
      compilation: {
        root: 'memory/p256-wasm',
        target: 'wasm32-unknown-unknown',
      },
      artifactKind: 'WebAssemblyModule',
    })
    assert.strictEqual(outcome._tag, 'Compiled')
    if (outcome._tag !== 'Compiled') return
    const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
    assert.deepEqual(WebAssembly.Module.imports(module), [])
    const instance = new WebAssembly.Instance(module)
    const main = instance.exports['main']
    assert.isFunction(main)
    if (typeof main === 'function') assert.strictEqual(main(), 0)
  }),
)

// The native corpus covers the full profile; this one portability leg exercises bounded field arithmetic
// and ephemeral ownership with wasm32 pointer widths and the shipped Wasm allocator.
it.effect('executes bounded X25519 agreement through LLVM-to-Wasm', () =>
  Effect.gen(function* () {
    const outcome = yield* compileSource('x25519.wasm', x25519WasmAcceptanceSource, {
      compilation: {
        root: 'memory/x25519-wasm',
        target: 'wasm32-unknown-unknown',
      },
      artifactKind: 'WebAssemblyModule',
    })
    assert.strictEqual(outcome._tag, 'Compiled')
    if (outcome._tag !== 'Compiled') return
    const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
    assert.deepEqual(WebAssembly.Module.imports(module), [])
    const instance = new WebAssembly.Instance(module)
    const main = instance.exports['main']
    assert.isFunction(main)
    if (typeof main === 'function') assert.strictEqual(main(), 0)
  }),
)

it.effect('executes ECDSA P-256 verification through LLVM-to-Wasm without host imports', () =>
  Effect.gen(function* () {
    const outcome = yield* compileSource('ecdsa-p256.wasm', ecdsaP256WasmSource, {
      compilation: {
        root: 'memory/ecdsa-p256-wasm',
        target: 'wasm32-unknown-unknown',
      },
      artifactKind: 'WebAssemblyModule',
    })
    assert.strictEqual(outcome._tag, 'Compiled')
    if (outcome._tag !== 'Compiled') return
    const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
    assert.deepEqual(WebAssembly.Module.imports(module), [])
    const instance = new WebAssembly.Instance(module)
    const main = instance.exports['main']
    assert.isFunction(main)
    if (typeof main === 'function') assert.strictEqual(main(), 42)
  }),
)

it.effect('executes bounded RSA verification through LLVM-to-Wasm', () =>
  Effect.gen(function* () {
    const outcome = yield* compileSource('rsa.wasm', rsaWasmSource, {
      compilation: {
        root: 'memory/rsa-wasm',
        target: 'wasm32-unknown-unknown',
      },
      artifactKind: 'WebAssemblyModule',
    })
    assert.strictEqual(outcome._tag, 'Compiled')
    if (outcome._tag !== 'Compiled') return
    const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
    assert.deepEqual(WebAssembly.Module.imports(module), [])
    const instance = new WebAssembly.Instance(module)
    const main = instance.exports['main']
    assert.isFunction(main)
    if (typeof main === 'function') assert.strictEqual(main(), 42)
  }),
)

// Two compact label derivations cover both digest widths on wasm32; native owns the boundary corpus.
it.effect('executes TLS HKDF through LLVM-to-Wasm without host imports', () =>
  Effect.gen(function* () {
    const outcome = yield* compileSource('tls-hkdf.wasm', tlsHkdfWasmSource, {
      compilation: {
        root: 'memory/tls-hkdf-wasm',
        target: 'wasm32-unknown-unknown',
      },
      artifactKind: 'WebAssemblyModule',
    })
    assert.strictEqual(outcome._tag, 'Compiled')
    if (outcome._tag !== 'Compiled') return
    yield* Effect.sync(() => {
      const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
      assert.deepEqual(WebAssembly.Module.imports(module), [])
      const main = new WebAssembly.Instance(module).exports['main']
      assert.isFunction(main)
      if (typeof main === 'function') assert.strictEqual(main(), 0)
    })
  }),
)

// Native coverage owns protected fixtures and transport state; this leg witnesses fixed record
// storage and borrowed pending output at wasm32 pointer width with the shipped allocator.
it.effect('executes bounded TLS record framing through LLVM-to-Wasm', () =>
  Effect.gen(function* () {
    const outcome = yield* compileSource('tls-record.wasm', tlsRecordWasmSource, {
      compilation: {
        root: 'memory/tls-record-wasm',
        target: 'wasm32-unknown-unknown',
      },
      artifactKind: 'WebAssemblyModule',
    })
    assert.strictEqual(outcome._tag, 'Compiled')
    if (outcome._tag !== 'Compiled') return
    yield* Effect.sync(() => {
      const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
      assert.deepEqual(WebAssembly.Module.imports(module), [])
      const main = new WebAssembly.Instance(module).exports['main']
      assert.isFunction(main)
      if (typeof main === 'function') assert.strictEqual(main(), 0)
    })
  }),
)
