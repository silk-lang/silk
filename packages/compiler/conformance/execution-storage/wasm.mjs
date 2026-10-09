import * as WasmEntryFixture from './WasmEntryFixture.mjs'
import * as LifecycleFixture from './LifecycleFixture.mjs'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Driver from '../../dist/Driver.js'
import * as Analysis from '../../dist/Analysis.js'
import * as SourceFile from '../../dist/SourceFile.js'
import * as SourceResolver from '../../dist/SourceResolver.js'
import * as NodeHeapObservation from '../../dist/NodeHeapObservation.js'
import * as PlatformSupplyResolver from '../../dist/PlatformSupplyResolver.js'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Config from 'effect/Config'
import * as Data from 'effect/Data'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Console from 'effect/Console'
import * as Stream from 'effect/Stream'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { fileURLToPath } from 'node:url'

class ConformanceError extends Data.TaggedError('ConformanceError') {}
const execute = Effect.fnUntraced(
  /** @param {Uint8Array<ArrayBuffer>} bytes @param {string} entry @param {number | 'Trap'} expected */
  function* (bytes, entry, expected) {
    const failure = (cause) => new ConformanceError({ message: 'Wasm execution failed', cause })
    const module = yield* Effect.tryPromise({
      try: () => WebAssembly.compile(bytes),
      catch: failure,
    })
    const imports = yield* Effect.try({
      try: () => WebAssembly.Module.imports(module),
      catch: failure,
    })
    if (imports.length !== 0)
      return yield* new ConformanceError({ message: 'Unexpected host imports', imports })
    const exports = yield* Effect.try({
      try: () => WebAssembly.Module.exports(module),
      catch: failure,
    })
    const instance = yield* Effect.tryPromise({
      try: () => WebAssembly.instantiate(module),
      catch: failure,
    })
    const invoke = instance.exports[entry]
    if (typeof invoke !== 'function' || invoke.length !== 0)
      return yield* new ConformanceError({
        message: `Expected zero-argument Wasm export ${entry}`,
        arity: typeof invoke === 'function' ? invoke.length : undefined,
      })
    const arity = invoke.length
    const result = yield* Effect.result(
      Effect.try({
        try: () => {
          return invoke()
        },
        catch: failure,
      }),
    )
    if (Result.isFailure(result)) {
      if (expected === 'Trap' && result.failure.cause instanceof WebAssembly.RuntimeError)
        return { imports, exports, arity, outcome: 'Trap' }
      return yield* result.failure
    }
    if (result.success !== expected)
      return yield* new ConformanceError({
        message: `${entry}: expected ${expected}, received ${result.success}`,
      })
    return { imports, exports, arity, status: result.success }
  },
)
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const clang = yield* Config.String('SILK_SUPPLY_CLANG')
  const output = path.resolve(
    yield* Config.String('SILK_STORAGE_WASM_OUTPUT').pipe(
      Config.withDefault('.scratch/execution-storage/wasm32'),
    ),
  )
  const directory = path.dirname(fileURLToPath(import.meta.url))
  yield* fs.makeDirectory(output, { recursive: true })
  const run = Effect.fnUntraced(
    /** @param {string} command @param {ReadonlyArray<string>} args */
    function* (command, args) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              stdin: 'ignore',
              stdout: 'pipe',
              stderr: 'pipe',
            }),
          )
          const [status, stdout, stderr] = yield* Effect.all(
            [
              child.exitCode,
              Stream.mkString(Stream.decodeText(child.stdout)),
              Stream.mkString(Stream.decodeText(child.stderr)),
            ],
            { concurrency: 'unbounded' },
          )
          if (status !== 0)
            return yield* new ConformanceError({ message: `${command}: ${status}\n${stderr}` })
          return { command, arguments: args, status, stdout, stderr }
        }),
      )
    },
  )
  const version = yield* run(clang, ['--version'])
  if (!version.stdout.includes('22.1.8'))
    return yield* new ConformanceError({ message: 'Storage conformance requires Clang 22.1.8' })
  const source = yield* fs.readFile(path.join(directory, 'fixture.silk'))
  const receiver = yield* fs.readFile(path.join(directory, 'wasm-receiver.c'))
  const probes = [{ name: 'abi', source, receiver }]
  const memory = yield* fs.readFileString(path.join(directory, 'freestanding-memory.c'))
  const countedReceiver =
    memory +
    '\n' +
    (yield* fs.readFileString(path.join(directory, 'reentrant-receiver.c')))
      .replaceAll('#include <stdio.h>', '')
      .replaceAll('#include <string.h>', '')
      .replace('int main(void)', 'int storage_probe(void)')
  for (const name of [
    'latched-destroy',
    'finalized-destroy',
    'multiple-packages',
    'suspended-failure',
  ]) {
    const fixture = yield* fs.readFileString(
      path.join(directory, `${name === 'suspended-failure' ? 'multiple-packages' : name}.silk`),
    )
    const body = yield* LifecycleFixture.expose(fixture, {
      failure: name === 'suspended-failure',
      reentrant: true,
    })
    probes.push({
      name,
      source: new TextEncoder().encode(body),
      receiver: new TextEncoder().encode(countedReceiver),
    })
  }
  const report = {
    schema: 1,
    target: 'wasm32-unknown-unknown',
    version,
    source: PlatformSupplyResolver.digest(source),
    receiver: PlatformSupplyResolver.digest(receiver),
    lanes: [],
  }
  for (const probe of probes) {
    const { source, receiver } = probe
    for (const optimization of ['none', 'speed']) {
      const snapshot = yield* Analysis.makeRealized({
        root: 'storage-conformance/root',
        configuration: {
          profile: {
            target: 'wasm32-unknown-unknown',
            artifact: 'object',
            entry: { kind: 'none' },
            optimization,
            debug: optimization === 'none',
          },
          composition: {
            components: [
              {
                capability: 'execution-storage',
                bindings: ['create', 'acquire', 'release', 'destroy'].map((operation) => ({
                  operation,
                  module: 'silk/execution_storage',
                  declaration: 'silk_execution_storage_' + operation,
                })),
              },
            ],
            retention: ['create', 'acquire', 'release', 'destroy'].map((operation) => ({
              module: 'silk/execution_storage',
              declaration: 'silk_execution_storage_' + operation,
            })),
          },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make('storage-conformance/root', source)]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      const diagnostics = Analysis.diagnostics(snapshot)
      if (diagnostics.length > 0)
        return yield* new ConformanceError({
          message: diagnostics.map((item) => `${item.code}: ${item.message}`).join('\n'),
        })
      const artifact = yield* Analysis.codegen(snapshot, {
        mode: optimization === 'none' ? 'debug' : 'release',
      })
      if (
        artifact.nativeRuntimeSymbols.some(
          (symbol) => symbol !== 'malloc' && symbol !== 'calloc' && symbol !== 'free',
        ) ||
        /silk_coroutine_frame_(push|pop)_v1/.test(artifact.ir)
      )
        return yield* new ConformanceError({
          message: 'Provider requires a generated runtime bridge',
        })
      const prefix = path.join(output, `${probe.name}-${optimization}`)
      yield* fs.writeFile(prefix + '.silk', source)
      yield* fs.writeFile(prefix + '.bc', artifact.bitcode)
      yield* fs.writeFileString(prefix + '.ll', artifact.ir)
      yield* fs.writeFile(prefix + '.c', receiver)
      const flags = [
        '--target=wasm32-unknown-unknown',
        '-ffreestanding',
        '-fno-builtin',
        optimization === 'none' ? '-O0' : '-O2',
        ...(optimization === 'none' ? ['-g'] : []),
      ]
      const compilation = yield* run(clang, [...flags, '-c', prefix + '.bc', '-o', prefix + '.o'])
      const cCompilation = yield* run(clang, [
        ...flags,
        '-Werror',
        '-c',
        prefix + '.c',
        '-o',
        prefix + '-c.o',
      ])
      const link = yield* run(clang, [
        ...flags,
        '-nostdlib',
        '-Wl,--no-entry',
        '-Wl,--export=storage_probe',
        prefix + '.o',
        prefix + '-c.o',
        '-o',
        prefix + '.wasm',
      ])
      const bytes = yield* fs.readFile(prefix + '.wasm')
      const execution = yield* execute(bytes, 'storage_probe', 42)
      report.lanes.push({
        name: probe.name,
        source: PlatformSupplyResolver.digest(source),
        receiver: PlatformSupplyResolver.digest(receiver),
        optimization,
        compilation,
        cCompilation,
        link,
        execution,
        artifact: PlatformSupplyResolver.digest(bytes),
      })
      yield* Console.log(`wasm32 ${optimization}: ${probe.name} independent storage probe passed`)
    }
  }
  const lifecycle = []
  for (const [name, expected] of [
    ['transient', 42],
    ['latched-destroy', 42],
    ['finalized-destroy', 42],
    ['finalized-choice', 42],
    ['multiple-packages', 42],
    ['non-lifo', 240],
    ['refuse-state', 'Trap'],
    ['refuse-frame', 'Trap'],
  ]) {
    const refusal = name.startsWith('refuse-')
    const source = yield* fs.readFile(
      path.join(directory, (refusal ? 'transient' : name) + '.silk'),
    )
    const provider =
      'export "C" fn refuse_create() -> ?*mut u8 { return Intrinsic.pointerNull<u8>() }\n' +
      'export "C" fn refuse_acquire(state: ?*mut u8, size: usize, alignment: usize) -> ?*mut u8 { return Intrinsic.pointerNull<u8>() }'
    const composition = refusal
      ? {
          runtimes: [{ name: 'standalone', module: 'silk/wasm_start' }],
          defaults: ['standalone'],
          components: [
            {
              capability: 'execution-storage',
              bindings: ['create', 'acquire', 'release', 'destroy'].map((operation) => {
                const rejected =
                  (name === 'refuse-state' && operation === 'create') ||
                  (name === 'refuse-frame' && operation === 'acquire')
                return {
                  operation,
                  module: rejected ? 'fixture/refusal' : 'silk/execution_storage',
                  declaration: rejected
                    ? `refuse_${operation}`
                    : `silk_execution_storage_${operation}`,
                }
              }),
            },
          ],
        }
      : undefined
    for (const optimization of ['none', 'speed']) {
      const destination = path.join(output, `${name}-${optimization}.wasm`)
      const result = yield* Driver.compile({
        compilation: {
          root: `storage-conformance/${name}`,
          configuration: {
            ...(composition === undefined ? {} : { composition }),
            profile: {
              target: 'wasm32-unknown-unknown',
              optimization,
              debug: optimization === 'none',
            },
          },
        },
        toolchain: { _tag: 'Toolchain', clang },
        artifactKind: 'WebAssemblyModule',
        packageName: 'storage-conformance',
        destination,
        cache: false,
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make(`storage-conformance/${name}`, source)]).pipe(
            Layer.provideMerge(
              refusal
                ? SourceResolver.memory(
                    new Map([['fixture/refusal', new TextEncoder().encode(provider)]]),
                  )
                : SourceResolver.empty,
            ),
          ),
        ),
      )
      if (result._tag !== 'Compiled')
        return yield* new ConformanceError({
          message: `${name} ${optimization}: ${result._tag}`,
          result,
        })
      const bytes = yield* fs.readFile(destination)
      const execution = yield* execute(bytes, 'main', expected)
      lifecycle.push({
        name,
        optimization,
        source: PlatformSupplyResolver.digest(source),
        ...(refusal ? { composition, provider } : {}),
        artifact: PlatformSupplyResolver.digest(bytes),
        execution,
      })
      yield* Console.log(`wasm32 ${optimization}: ${name} lifecycle passed`)
    }
  }
  const entry = []
  for (const fixture of WasmEntryFixture.all) {
    const source = new TextEncoder().encode(fixture.source)
    for (const optimization of ['none', 'speed']) {
      const destination = path.join(output, `entry-${fixture.name}-${optimization}.wasm`)
      const result = yield* Driver.compile({
        compilation: {
          root: `wasm-entry/${fixture.name}`,
          configuration: {
            profile: {
              target: 'wasm32-unknown-unknown',
              optimization,
              debug: optimization === 'none',
            },
          },
        },
        toolchain: { _tag: 'Toolchain', clang },
        artifactKind: 'WebAssemblyModule',
        packageName: 'wasm-entry',
        destination,
        cache: false,
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make(`wasm-entry/${fixture.name}`, source)]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      if (result._tag !== 'Compiled')
        return yield* new ConformanceError({
          message: `entry ${fixture.name} ${optimization}: ${result._tag}`,
          result,
        })
      const bytes = yield* fs.readFile(destination)
      const execution = yield* execute(bytes, 'main', fixture.expected)
      if (
        execution.exports.some((symbol) => ['silk_main', '__original_main'].includes(symbol.name))
      )
        return yield* new ConformanceError({ message: 'Obsolete generated Wasm entry export' })
      entry.push({
        name: fixture.name,
        optimization,
        source: PlatformSupplyResolver.digest(source),
        artifact: PlatformSupplyResolver.digest(bytes),
        execution,
      })
      yield* Console.log(`wasm32 ${optimization}: ${fixture.name} source entry passed`)
    }
  }
  yield* fs.writeFileString(
    path.join(output, 'report.json'),
    (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      ...report,
      lifecycle,
      entry,
    }).pipe(Effect.orDie)) + '\n',
  )
})
NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHeapObservation.layer)),
  ),
)
