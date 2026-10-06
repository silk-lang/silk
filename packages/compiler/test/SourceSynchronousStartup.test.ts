import { assert, it } from '@effect/vitest'
import { NodeServices } from '@effect/platform-node'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Analysis from '../src/Analysis.js'
import * as ArtifactComposition from '../src/ArtifactComposition.js'
import * as ModuleClosure from '../src/ModuleClosure.js'
import * as NativeLinkInput from '../src/NativeLinkInput.js'
import * as NativeToolchain from '../src/NativeToolchain.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Stdlib from '../src/Stdlib.js'
import * as Target from '../src/Target.js'
import * as Driver from './support/TestDriver.js'
import * as Json from './support/Json.js'
import * as Process from './support/Process.js'
import * as TestToolchain from './support/TestToolchain.js'
import { synchronousStartupFailure, synchronousStartupSuccess } from './support/corpus.js'

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text)
const runtime = 'silk/native_start_sync'
const application = 'startup/application'

const configuration = (
  target: string,
): NonNullable<ModuleClosure.CompilationRequest['configuration']> => ({
  profile: {
    target,
    artifact: 'executable',
    runtime: { kind: 'named', name: 'synchronous' },
    optimization: 'speed',
    debug: false,
  },
  composition: {
    runtimes: [{ name: 'synchronous', module: runtime }],
    components: [],
    defaults: [],
    retention: [],
    requirements: [],
  },
})

const sources = (source: string) =>
  SourceResolver.overlay([SourceFile.make(application, ascii(source))]).pipe(
    Layer.provideMerge(SourceResolver.empty),
  )

const analyze = Effect.fnUntraced(function* (source: string, target: string) {
  return yield* Analysis.makeRealized({
    root: application,
    configuration: configuration(target),
  }).pipe(Effect.provide(sources(source)))
})

const compile = Effect.fnUntraced(function* (
  source: string,
  destination: string,
  linkInputs: ReadonlyArray<NativeLinkInput.NativeLinkInput> = [],
) {
  const target = yield* NativeToolchain.hostTarget()
  const toolchain = yield* TestToolchain.configured
  return yield* Driver.compile({
    compilation: { root: application, configuration: configuration(target.id) },
    toolchain,
    artifactKind: 'NativeExecutable',
    destination,
    cache: false,
    nativeLinkInputs: linkInputs,
  }).pipe(Effect.provide(sources(source)))
})

it.effect('registers an explicit synchronous runtime without changing hosted defaults', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const entry = Stdlib.find(runtime)
    assert.isDefined(entry)
    const bytes = yield* fs.readFile(path.resolve('stdlib/silk/native_start_sync.silk'))
    assert.deepEqual(Stdlib.sources.get(runtime), bytes)
    assert.strictEqual(Stdlib.findNamespace('NativeStartSync')?.module, runtime)
    for (const [target, libc] of [
      [Target.aarch64AppleDarwin, 'system'],
      [Target.aarch64UnknownLinuxGnu, 'gnu'],
      [Target.x8664UnknownLinuxGnu, 'gnu'],
    ] as const) {
      const selected = yield* ArtifactComposition.decode(
        ArtifactComposition.defaults({
          target,
          libc,
          artifact: 'executable',
          runtime: { kind: 'default' },
        }),
      )
      assert.deepEqual(
        selected.runtimes.map((value) => value.module),
        ['silk/native_start'],
      )
      assert.deepEqual(
        selected.components.map((value) => value.capability),
        ['execution-storage'],
      )
    }
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect(
  'rejects unsupported entry results, unsatisfied requirements, owned syntax, and parking in source',
  () =>
    Effect.gen(function* () {
      const prefix = 'import silk.host_input { HostInput, HostInputError }\n'
      const cases = [
        ['plain', 'pub fn main() -> i32 { return 17 }'],
        ['closed', 'pub effect fn main() -> i32 { return 17 }'],
        [
          'unit',
          prefix +
            'pub effect fn main() -> () ! HostInputError ? &mut HostInput { let count = run HostInput.argumentCount() return () }',
        ],
        [
          'extra',
          prefix +
            'service Extra { effect fn value() -> i32 ? &mut Extra }\npub effect fn main() -> i32 ! HostInputError ? &mut HostInput | &mut Extra { let count = run HostInput.argumentCount() return run Extra.value() }',
        ],
        [
          'owned',
          prefix + 'pub effect fn main() -> i32 ! HostInputError ? HostInput { return 17 }',
        ],
        [
          'parking',
          prefix +
            'import silk.execution { Execution }\nfn register(wake: Intrinsic.Wake) -> () { drop wake }\npub effect fn main() -> i32 ! HostInputError ? &mut HostInput { let count = run HostInput.argumentCount() run Execution.park(register) return 17 }',
        ],
      ] as const
      const observed = []
      for (const [name, source] of cases) {
        const snapshot = yield* analyze(source, 'x86_64-unknown-linux-gnu')
        observed.push({
          name,
          diagnostics: Analysis.diagnostics(snapshot).map((diagnostic) => [
            diagnostic.code,
            diagnostic.span.sourceId,
          ]),
        })
      }
      assert.deepEqual(observed, [
        { name: 'plain', diagnostics: [['SEM0123', runtime]] },
        { name: 'closed', diagnostics: [['SEM0123', runtime]] },
        { name: 'unit', diagnostics: [['SEM0040', runtime]] },
        { name: 'extra', diagnostics: [['SEM0071', runtime]] },
        {
          name: 'owned',
          diagnostics: [
            ['SEM0123', runtime],
            ['SEM0001', application],
          ],
        },
        { name: 'parking', diagnostics: [['SEM0139', runtime]] },
      ])
    }),
  { timeout: 120_000 },
)

// These execute explicitly selected startup's foreign boundary. Target-neutral application
// behavior is also covered under the unchanged default runtime in the shared native corpus.
it.effect(
  'executes explicit startup with mutable success17, typed failure1, and shared status23',
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'silk-source-startup-' })
        for (const [name, source, status] of [
          ['success', synchronousStartupSuccess, 17],
          ['failure', synchronousStartupFailure, 1],
          [
            'shared',
            'import silk.host_input { HostInput, HostInputError }\npub effect fn main() -> i32 ! HostInputError ? &HostInput { return 23 }',
            23,
          ],
        ] as const) {
          const result = yield* compile(source, path.join(directory, name))
          if (result._tag !== 'Compiled') assert.fail(Json.stringify(result))
          assert.strictEqual(result.artifactPlan?.composition.runtime?.module, runtime)
          assert.deepEqual(result.diagnostics, [])
          assert.deepEqual(result.artifactPlan?.composition.components, [])
          const modules = result.artifactPlan?.sources.map((source) => source.module) ?? []
          assert.includeMembers(modules, [runtime, 'silk/native_host_input', 'silk/os_host_input'])
          assert.notIncludeMembers(modules, [
            'silk/native_start',
            'silk/execution',
            'silk/native_diagnostics',
            'silk/native_report',
          ])
          assert.isTrue(result.symbols.some((symbol) => symbol.declaration.module === runtime))
          assert.deepEqual(
            result.foreignExports.map((entry) => entry.symbol),
            ['main'],
          )
          const process = yield* Process.run(result.path, ['owned-input'])
          assert.strictEqual(Number(process.exitCode), status)
          assert.strictEqual(process.stdout, '')
          assert.strictEqual(process.stderr, '')
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
)

it.effect(
  'releases lexical HostInput and failure payload once across success and startup faults',
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: 'silk-source-startup-audit-',
        })
        const source = yield* fs.readFileString(
          path.resolve('test/fixtures/source-startup/audit.silk'),
        )
        const receiver = yield* fs.readFileString(
          path.resolve('test/fixtures/source-startup/audit.c'),
        )
        const target = yield* NativeToolchain.hostTarget()
        const toolchain = yield* TestToolchain.configured
        const result = yield* NativeToolchain.withBuildScope('source-startup-audit', (scope) =>
          Effect.gen(function* () {
            const object = yield* NativeToolchain.compileCObject(
              toolchain,
              scope,
              target,
              'audit',
              receiver,
            )
            return yield* compile(source, path.join(directory, 'audit'), [
              NativeLinkInput.object(object.artifact.path),
            ])
          }),
        )
        if (result._tag !== 'Compiled') assert.fail(Json.stringify(result))
        assert.strictEqual(result.artifactPlan?.composition.runtime?.module, runtime)
        const process = yield* Process.run(result.path, [])
        assert.deepEqual(process, { exitCode: 42, stdout: '', stderr: '' })
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
)
