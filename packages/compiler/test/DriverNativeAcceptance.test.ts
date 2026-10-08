import * as Layer from 'effect/Layer'
import { NodeServices } from '@effect/platform-node'
import * as CliProgram from '../../cli/src/Program.js'
import * as CliTestExchange from '../../cli/src/TestExchange.js'
import type * as RuntimeComponent from '../src/RuntimeComponent.js'
import * as ArtifactComposition from '../src/ArtifactComposition.js'
import * as CompilationProfile from '../src/CompilationProfile.js'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, assert, it } from '@effect/vitest'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import { identity } from 'effect/Function'
import * as Json from './support/Json.js'
import * as ArtifactKind from '../src/ArtifactKind.js'
import * as NativeLinkInput from '../src/NativeLinkInput.js'
import * as NativeToolchain from '../src/NativeToolchain.js'
import type * as Storage from '../src/Storage.js'
import type * as ModuleClosure from '../src/ModuleClosure.js'
import * as Linker from '../src/Linker.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import { httpRedirectCorpusProgram, nativeCorpus, type NativeRun } from './support/corpus.js'
import { checkedConversionPrograms } from './support/checkedConversions.js'
import { base64AcceptanceSource } from './support/base64Acceptance.js'
import { httpClientPortableAcceptanceSource } from './support/httpClientAcceptance.js'
import { httpClientContentAcceptanceSource } from './support/httpClientContentAcceptance.js'
import { httpRequestPortableAcceptanceSource } from './support/httpRequestAcceptance.js'
import { bufferedByteIoWasmAcceptanceSource } from './support/bufferedByteIoAcceptance.js'
import { httpHeadAcceptanceSource } from './support/httpHeadAcceptance.js'
import { httpBodyAcceptanceSource } from './support/httpBodyAcceptance.js'
import { httpContentAcceptanceSource } from './support/httpContentAcceptance.js'
import { httpServerPortableAcceptanceSource } from './support/httpServerPortableAcceptance.js'
import { websocketUpgradePortableAcceptanceSource } from './support/websocketUpgradeAcceptance.js'
import { httpValuesAcceptanceSource } from './support/httpValuesAcceptance.js'
import { networkAddressResolutionCorpusProgram } from './support/networkAddressResolutionAcceptance.js'
import * as Driver from './support/TestDriver.js'
import * as NativeWork from './support/NativeWork.js'
import { unreachable } from './support/raise.js'
import type * as TestExecution from '../src/TestExecution.js'

const defaultClang = (): string => {
  if (existsSync('/opt/homebrew/opt/llvm/bin/clang')) return '/opt/homebrew/opt/llvm/bin/clang'
  if (existsSync('/usr/local/opt/llvm/bin/clang')) return '/usr/local/opt/llvm/bin/clang'
  return 'clang'
}

const configured = (name: string, fallback = ''): string =>
  Effect.runSync(Config.String(name).pipe(Config.withDefault(fallback)))
const clang = configured('SILK_TEST_CLANG', defaultClang())
const defaultLlvmAr = join(dirname(clang), 'llvm-ar')
// Every native case builds for the host's default profile, so the platform supply (tool
// versions, linker, and libraries) is resolved once here instead of in each case's build.
const toolchain: NativeToolchain.Toolchain = await Effect.runPromise(
  Effect.gen(function* () {
    const profile = yield* CompilationProfile.normalize({
      target: (yield* NativeToolchain.hostTarget()).id,
    })
    return yield* NativeToolchain.resolveToolchain(
      {
        _tag: 'Toolchain',
        clang,
        llvmAr: configured(
          'SILK_TEST_LLVM_AR',
          existsSync(defaultLlvmAr) ? defaultLlvmAr : 'llvm-ar',
        ),
        runtimeObjectCache: NativeToolchain.makeRuntimeObjectCache(),
      },
      profile,
    )
  }).pipe(Effect.map((resolved) => Object.freeze(resolved))),
)

// UTF-8, not charCodeAt: corpus programs may carry non-ASCII literals, and for ASCII sources the
// bytes are identical.
const encoder = new TextEncoder()
const ascii = (value: string): Uint8Array => encoder.encode(value)

const runnerPlanMagic = ascii('SLKTPLN1')
const runnerReceiptMagic = ascii('SLKTRCP1')

const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

const runnerU32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

const runnerU64 = (value: bigint): Uint8Array => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value, true)
  return bytes
}

const runnerText = (value: string): Uint8Array => {
  const bytes = encoder.encode(value)
  return concatBytes(runnerU64(BigInt(bytes.length)), bytes)
}

const runnerPerTestPlan = (
  manifest: TestExecution.Manifest,
  cachedNames: ReadonlySet<string> = new Set(),
): Uint8Array =>
  concatBytes(
    runnerPlanMagic,
    runnerU32(1),
    runnerU32(1),
    Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    runnerU64(BigInt(manifest.entries.length)),
    ...manifest.entries.map((entry, ordinal) => {
      const execution =
        entry.eligibility._tag === 'Eligible' ? entry.eligibility.identity : undefined
      return concatBytes(
        runnerU64(BigInt(ordinal)),
        runnerText(entry.test.identity),
        runnerText(execution ?? ''),
        Uint8Array.of(cachedNames.has(entry.test.name) && execution !== undefined ? 1 : 0),
      )
    }),
  )

const runnerUncachedPlan = Effect.fnUntraced(function* (manifest: TestExecution.Manifest) {
  const plan: CliTestExchange.UncachedPlan = {
    _tag: 'Uncached',
    nonce: Uint8Array.from({ length: 32 }, (_, index) => 32 - index),
    catalogDigest: yield* CliTestExchange.catalogDigest(
      manifest.entries.map((entry) => entry.test.identity),
    ),
    discovered: BigInt(manifest.entries.length),
  }
  return { plan, bytes: yield* CliTestExchange.encodePlan(plan) }
})

interface RunnerReceipt {
  readonly mode: number
  readonly dispositions: ReadonlyArray<number>
  readonly counts: ReadonlyArray<bigint>
  readonly status: number
}

const runnerReceipt = (path: string, plan: Uint8Array): RunnerReceipt => {
  const bytes = readFileSync(path)
  assert.deepEqual(bytes.subarray(0, 8), runnerReceiptMagic)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.strictEqual(view.getUint32(8, true), 1)
  const mode = view.getUint32(12, true)
  assert.deepEqual(bytes.subarray(16, 48), plan.subarray(16, 48))
  assert.deepEqual(bytes.subarray(48, 80), createHash('sha256').update(plan).digest())
  let offset = 80
  const dispositions: Array<number> = []
  if (mode === 1) {
    const selected = view.getBigUint64(offset, true)
    offset += 8
    for (let index = 0n; index < selected; index += 1n) {
      offset += 8
      const declarationLength = Number(view.getBigUint64(offset, true))
      offset += 8 + declarationLength
      const executionLength = Number(view.getBigUint64(offset, true))
      offset += 8 + executionLength
      dispositions.push(view.getUint8(offset))
      offset += 1
    }
  }
  const counts = [
    view.getBigUint64(offset, true),
    view.getBigUint64(offset + 8, true),
    view.getBigUint64(offset + 16, true),
    view.getBigUint64(offset + 24, true),
    view.getBigUint64(offset + 32, true),
    view.getBigUint64(offset + 40, true),
  ]
  const status = view.getUint32(offset + 48, true)
  if (mode === 2) {
    assert.strictEqual(bytes.length, 256)
    assert.isTrue(bytes.subarray(offset + 52).every((value) => value === 0))
  } else assert.strictEqual(offset + 52, bytes.length)
  return { mode, dispositions, counts, status }
}

const runCompiled = Effect.fnUntraced(function* (
  path: string,
  run: NativeRun & { readonly timeout?: number } = {},
) {
  return yield* Effect.sync(() =>
    run.closeStderr
      ? spawnSync(
          '/bin/sh',
          ['-c', 'exec 2>&-; exec "$@"', 'silk-native-corpus', path, ...(run.arguments ?? [])],
          { encoding: 'utf8', ...(run.timeout === undefined ? {} : { timeout: run.timeout }) },
        )
      : spawnSync(path, run.arguments ?? [], {
          encoding: 'utf8',
          ...(run.timeout === undefined ? {} : { timeout: run.timeout }),
        }),
  )
})

const destinationRoot = mkdtempSync(join(tmpdir(), 'silk-driver-native-acceptance-'))
afterAll(() => {
  rmSync(destinationRoot, { recursive: true, force: true })
})

const compileSource = Effect.fnUntraced(function* (
  name: string,
  text: string,
  imports?: Readonly<Record<string, string>>,
  options: {
    readonly components?: ReadonlyArray<RuntimeComponent.Input>
    readonly artifactKind?: ArtifactKind.ArtifactKind
    readonly packageName?: string
    readonly nativeLinkInputs?: ReadonlyArray<NativeLinkInput.NativeLinkInput>
    readonly cache?: boolean
    readonly artifactStorage?: Storage.Service
    readonly optimization?: CompilationProfile.Optimization
    readonly debug?: boolean
    readonly sourceModule?: string
    readonly root?: string
    readonly discovery?: ModuleClosure.CompilationRequest['discovery']
  } = {},
) {
  const profile = yield* CompilationProfile.normalize({
    target: (yield* NativeToolchain.hostTarget()).id,
    artifact: ArtifactKind.profileArtifact(options.artifactKind ?? 'NativeExecutable'),
    optimization: options.optimization ?? 'speed',
    debug: options.debug ?? false,
  })
  return yield* Driver.compile({
    compilation: {
      root: options.root ?? options.sourceModule ?? 'memory/driver',
      ...(options.discovery === undefined ? {} : { discovery: options.discovery }),
      configuration: {
        profile: CompilationProfile.input(profile),
        package: `${options.packageName ?? 'compiler-test'}@0.0.0`,
        composition: {
          ...ArtifactComposition.defaults(profile),
          ...(options.components === undefined ? {} : { components: options.components }),
        },
      },
    },
    toolchain,
    artifactKind: options.artifactKind ?? 'NativeExecutable',
    packageName: options.packageName ?? 'compiler-test',
    destination: join(destinationRoot, name),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.nativeLinkInputs === undefined
      ? {}
      : { nativeLinkInputs: options.nativeLinkInputs }),
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([
        SourceFile.make(options.sourceModule ?? 'memory/driver', ascii(text)),
      ]).pipe(
        Layer.provideMerge(
          imports === undefined
            ? SourceResolver.empty
            : SourceResolver.memory(
                new Map(
                  Object.entries(imports).map(
                    ([module, source]) => [module, ascii(source)] as const,
                  ),
                ),
              ),
        ),
      ),
    ),
    options.artifactStorage === undefined
      ? identity
      : Effect.provideService(NativeToolchain.ArtifactStorage, options.artifactStorage),
  )
})

/** Compiles corpus C sources through the pinned Clang into durable objects under the test root. */
const compileCSources = Effect.fnUntraced(function* (
  name: string,
  sources: Readonly<Record<string, string>>,
) {
  const target = yield* NativeToolchain.hostTarget()
  return yield* NativeToolchain.withBuildScope(`${name}-c`, (scope) =>
    Effect.forEach(Object.entries(sources), ([unit, text]) =>
      Effect.gen(function* () {
        const object = yield* NativeToolchain.compileCObject(toolchain, scope, target, unit, text)
        const path = join(destinationRoot, `${name}-${unit}.o`)
        writeFileSync(path, readFileSync(object.artifact.path))
        return path
      }),
    ),
  )
})

const portableWasmCorpus = [
  {
    name: httpRedirectCorpusProgram.name,
    source: httpRedirectCorpusProgram.source,
    expected: 0,
  },
  {
    name: 'http-proxy-routed-preparation-and-scripted-tunnel-portability',
    source: httpClientPortableAcceptanceSource,
    expected: 0,
  },
  { name: 'http-client-content', source: httpClientContentAcceptanceSource, expected: 0 },
  { name: 'http-client-request', source: httpRequestPortableAcceptanceSource, expected: 0 },
  { name: 'http-values', source: httpValuesAcceptanceSource, expected: 0 },
  { name: 'http-head-parsing', source: httpHeadAcceptanceSource, expected: 42 },
  { name: 'http-body-framing', source: httpBodyAcceptanceSource, expected: 42 },
  { name: 'http-content-decoding', source: httpContentAcceptanceSource, expected: 0 },
  { name: 'http-server', source: httpServerPortableAcceptanceSource, expected: 0 },
  { name: 'websocket-upgrade', source: websocketUpgradePortableAcceptanceSource, expected: 0 },
  { name: 'base64-rfc4648', source: base64AcceptanceSource, expected: 42 },
  { name: 'buffered-byte-io', source: bufferedByteIoWasmAcceptanceSource, expected: 0 },
  {
    name: networkAddressResolutionCorpusProgram.name,
    source: networkAddressResolutionCorpusProgram.source,
    expected: 42,
  },
  // wasm32 is the only 32-bit target in the suite, so it is where a pointer-width conversion bound
  // fixed at 64 bits becomes observable.
  ...checkedConversionPrograms.map((program) => ({
    name: `${program.name}-wasm`,
    source: program.source,
    expected: 42,
  })),
] as const

const fixedScenarios = [
  'relinks named archives after content and search-resolution changes',
  'builds loadable shared/static libraries with only C exports visible',
  'runs the bundled test runner through typed failure, cleanup, filtering, and fatal traps',
  'runs a source-defined custom runner against a separate discovery root',
  'fails to link a foreign symbol nothing defines and keeps the linker output',
  'links and runs the native system and monotonic clock ABI',
] as const

const nativeWork = { native: nativeCorpus, fixed: fixedScenarios, wasm: portableWasmCorpus }

/**
 * `SILK_NATIVE_SHARD=k/n` runs shard k (1-based) of an n-way split of every native corpus case,
 * fixed scenario, and portable Wasm case. `SILK_NATIVE_CORPUS_CASES` selects a comma-separated
 * smoke set of native or Wasm cases, and `SILK_NATIVE_FIXED_TESTS=false` disables fixed scenarios
 * and unrequested Wasm cases. `NativeWork.select` is the only selection path.
 */
const requestedShard = configured('SILK_NATIVE_SHARD')
const requestedCases = new Set(
  configured('SILK_NATIVE_CORPUS_CASES')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length !== 0),
)
const selected = NativeWork.select(nativeWork, {
  shard:
    requestedShard === ''
      ? undefined
      : (NativeWork.parseShard(requestedShard) ??
        unreachable('SILK_NATIVE_SHARD must be k/n with 1 <= k <= n')),
  fixed: configured('SILK_NATIVE_FIXED_TESTS', 'true') === 'true',
  cases: requestedCases,
})

type EffectTest = Parameters<typeof it.effect>
const fixedScenario = (
  name: (typeof fixedScenarios)[number],
  self: EffectTest[1],
  timeout?: EffectTest[2],
): void => it.effect.skipIf(!selected.fixed.includes(name))(name, self, timeout)

// A requested case may name either corpus: the wasm entries are how a 32-bit regression reaches
// the PR lane, which sets `SILK_NATIVE_FIXED_TESTS=false`.
it('finds every requested native corpus case', () => {
  assert.deepStrictEqual(
    [...requestedCases].filter(
      (name) =>
        !selected.native.some((program) => program.name === name) &&
        !selected.wasm.some((program) => program.name === name),
    ),
    [],
  )
})

it('selects requested cases and deals every native, fixed, and Wasm case to exactly one shard', () => {
  const names = (work: NativeWork.NativeWork<NativeWork.Named, string, NativeWork.Named>) => [
    ...work.native.map((program) => `native:${program.name}`),
    ...work.fixed.map((name) => `fixed:${name}`),
    ...work.wasm.map((program) => `wasm:${program.name}`),
  ]
  // Names key build roots and case selection, so each category's names are unique.
  assert.strictEqual(new Set(names(nativeWork)).size, names(nativeWork).length)
  // Some cases run in both corpora; pick one name from each that the other lacks.
  const native =
    nativeCorpus.find((program) => !portableWasmCorpus.some(({ name }) => name === program.name)) ??
    unreachable('expected a native-only case')
  const wasm =
    portableWasmCorpus.find((program) => !nativeCorpus.some(({ name }) => name === program.name)) ??
    unreachable('expected a Wasm-only case')
  assert.deepStrictEqual(
    names(
      NativeWork.select(nativeWork, {
        shard: undefined,
        fixed: false,
        cases: new Set([native.name, wasm.name]),
      }),
    ),
    [`native:${native.name}`, `wasm:${wasm.name}`],
  )
  for (const count of [1, 2, 3, 4]) {
    const shards = Array.from({ length: count }, (_, index) =>
      NativeWork.select(nativeWork, {
        shard: { index: index + 1, count },
        fixed: true,
        cases: new Set(),
      }),
    )
    assert.deepStrictEqual(shards.flatMap(names).sort(), names(nativeWork).sort(), `${count}`)
    for (const shard of shards) {
      assert.isNotEmpty(shard.fixed, `${count}`)
      assert.isNotEmpty(shard.wasm, `${count}`)
    }
  }
})

const librarySource = `unsafe extern "C" fn abs(value: i32) -> i32
fn helper(value: i32) -> i32 { return value + 1 }
export "C" fn increment(value: i32) -> i32 { return unsafe abs(helper(value)) }
export "C" static silk_abi_version: u32 = 1`

const consumerSource = `#include "answer.h"
int main(void) { return increment(40) + (int32_t)silk_abi_version; }
`

fixedScenario('relinks named archives after content and search-resolution changes', () =>
  NativeToolchain.withBuildScope('named-archive-cache', (scope) =>
    Effect.gen(function* () {
      const target = yield* NativeToolchain.hostTarget()
      const earlier = join(scope.root, 'earlier')
      const later = join(scope.root, 'later')
      yield* Effect.sync(() => {
        mkdirSync(earlier)
        mkdirSync(later)
      })
      const archive = Effect.fnUntraced(function* (directory: string, value: number) {
        const object = yield* NativeToolchain.compileCObject(
          toolchain,
          scope,
          target,
          'selected',
          `int silk_cache_selected(void) { return ${value}; }`,
        )
        const destination = join(directory, 'libsilk_cache_selected.a')
        const plan = yield* NativeToolchain.planNativeLink(
          toolchain,
          scope,
          'NativeStaticLibrary',
          yield* CompilationProfile.normalize({ target: target.id }),
          [object.artifact],
          [],
          destination,
          {
            request: { kind: 'default' },
            composition: { kind: 'default' },
            resolved: { kind: 'default' },
          },
        )
        yield* Linker.link({
          scope,
          plan,
          artifactKind: 'NativeStaticLibrary',
          destination,
          cache: Object.freeze({ _tag: 'Disabled' }),
        })
      })
      const source = `unsafe extern "C" fn silk_cache_selected() -> i32
pub fn main() -> i32 { return unsafe silk_cache_selected() }`
      const options = {
        cache: true,
        artifactStorage: yield* NativeToolchain.defaultArtifactStorage(
          join(scope.root, 'cache'),
        ).pipe(Effect.provide(NodeServices.layer)),
        nativeLinkInputs: [
          NativeLinkInput.searchPath(earlier),
          NativeLinkInput.searchPath(later),
          // Darwin's ordinary -l selection falls back to the sole .a fixture.
          NativeLinkInput.library(
            'silk_cache_selected',
            platform() === 'darwin' ? 'Dynamic' : 'Static',
          ),
        ],
      }
      const statuses: Array<number | null> = []
      const phases: Array<ReadonlyArray<string>> = []
      for (const [directory, value] of [
        [later, 11],
        [later, 22],
        [earlier, 33],
      ] as const) {
        yield* archive(directory, value)
        const outcome = yield* compileSource('named-archive-cache', source, undefined, options)
        assert.strictEqual(outcome._tag, 'Compiled')
        if (outcome._tag !== 'Compiled') return
        const run = yield* runCompiled(outcome.path)
        statuses.push(run.status)
        phases.push(outcome.report.map((entry) => entry.phase))
      }
      assert.deepStrictEqual(statuses, [11, 22, 33])
      for (const report of phases) {
        assert.include(report, 'link')
        assert.notInclude(report, 'artifact-cache')
      }
      assert.include(phases[1] ?? [], 'backend-cache')
      assert.include(phases[2] ?? [], 'backend-cache')
    }),
  ),
)

fixedScenario(
  'builds loadable shared/static libraries with only C exports visible',
  () =>
    Effect.gen(function* () {
      const sharedName = platform() === 'darwin' ? 'libsilk_answer.dylib' : 'libsilk_answer.so'
      const shared = yield* compileSource(sharedName, librarySource, undefined, {
        artifactKind: 'NativeSharedLibrary',
        packageName: 'answer',
        cache: true,
      })
      assert.strictEqual(shared._tag, 'Compiled')
      if (shared._tag !== 'Compiled') return
      assert.deepStrictEqual(
        shared.foreignExports.map((export_) => export_.symbol),
        ['increment'],
      )
      assert.deepStrictEqual(shared.foreignStatics, [
        { symbol: 'silk_abi_version', type: 'u32', direction: 'Export' },
      ])
      assert.deepStrictEqual(
        shared.foreignImports.map((import_) => import_.symbol),
        ['abs'],
      )
      assert.deepStrictEqual(shared.libraryInterface, {
        _tag: 'LibraryInterfaceArtifacts',
        cHeader: join(destinationRoot, 'answer.h'),
        abiManifest: join(destinationRoot, 'answer.abi.json'),
      })
      assert.strictEqual('termination' in shared, false)
      const interfacePhase = shared.report.find((entry) => entry.phase === 'library-interface')
      assert.deepStrictEqual(
        interfacePhase === undefined
          ? undefined
          : { inputs: interfacePhase.inputs, outputs: interfacePhase.outputs },
        { inputs: 3, outputs: 2 },
      )
      const firstHeader = readFileSync(join(destinationRoot, 'answer.h'))
      const firstManifest = readFileSync(join(destinationRoot, 'answer.abi.json'))

      const symbolDump =
        platform() === 'darwin'
          ? spawnSync('nm', ['-gU', shared.path], { encoding: 'utf8' })
          : spawnSync('nm', ['-D', '--defined-only', shared.path], { encoding: 'utf8' })
      assert.strictEqual(symbolDump.status, 0, symbolDump.stderr)
      const visible = symbolDump.stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/).at(-1) ?? '')
        .filter((symbol) => symbol.length > 0)
        .map((symbol) => (platform() === 'darwin' ? symbol.replace(/^_/, '') : symbol))
      assert.include(visible, 'increment')
      assert.include(visible, 'silk_abi_version')
      assert.deepStrictEqual(
        visible.filter((symbol) => symbol.startsWith('silk_') && symbol !== 'silk_abi_version'),
        [],
      )

      const consumerPath = join(destinationRoot, 'library-consumer.c')
      const sharedExecutable = join(destinationRoot, 'shared-consumer')
      writeFileSync(consumerPath, consumerSource)
      const sharedCompile = spawnSync(
        clang,
        [
          '-I',
          destinationRoot,
          consumerPath,
          shared.path,
          `-Wl,-rpath,${destinationRoot}`,
          '-o',
          sharedExecutable,
        ],
        { encoding: 'utf8' },
      )
      assert.strictEqual(sharedCompile.status, 0, sharedCompile.stderr)
      assert.strictEqual(spawnSync(sharedExecutable).status, 42)

      rmSync(join(destinationRoot, 'answer.h'))
      rmSync(join(destinationRoot, 'answer.abi.json'))
      const cachedShared = yield* compileSource(sharedName, librarySource, undefined, {
        artifactKind: 'NativeSharedLibrary',
        packageName: 'answer',
        cache: true,
      })
      assert.strictEqual(cachedShared._tag, 'Compiled')
      if (cachedShared._tag !== 'Compiled') return
      assert.include(
        cachedShared.report.map((entry) => entry.phase),
        'backend-cache',
      )
      assert.include(
        cachedShared.report.map((entry) => entry.phase),
        'artifact-cache',
      )
      assert.deepStrictEqual(readFileSync(join(destinationRoot, 'answer.h')), firstHeader)
      assert.deepStrictEqual(readFileSync(join(destinationRoot, 'answer.abi.json')), firstManifest)

      const firstArchive = yield* compileSource(
        'libsilk_answer-first.a',
        librarySource,
        undefined,
        {
          artifactKind: 'NativeStaticLibrary',
          packageName: 'answer',
          cache: false,
        },
      )
      assert.strictEqual(firstArchive._tag, 'Compiled')
      if (firstArchive._tag !== 'Compiled') return
      assert.deepStrictEqual(firstArchive.libraryInterface, shared.libraryInterface)
      assert.deepStrictEqual(readFileSync(join(destinationRoot, 'answer.h')), firstHeader)
      assert.deepStrictEqual(readFileSync(join(destinationRoot, 'answer.abi.json')), firstManifest)

      const staticExecutable = join(destinationRoot, 'static-consumer')
      const staticCompile = spawnSync(
        clang,
        ['-I', destinationRoot, consumerPath, firstArchive.path, '-lm', '-o', staticExecutable],
        { encoding: 'utf8' },
      )
      assert.strictEqual(staticCompile.status, 0, staticCompile.stderr)
      assert.strictEqual(spawnSync(staticExecutable).status, 42)
    }),
  60_000,
)

fixedScenario(
  'runs the bundled test runner through typed failure, cleanup, filtering, and fatal traps',
  () =>
    NativeToolchain.withBuildScope('source-test-runner', (scope) =>
      Effect.gen(function* () {
        const target = yield* NativeToolchain.hostTarget()
        const counter = yield* NativeToolchain.compileCObject(
          toolchain,
          scope,
          target,
          'test-release-counter',
          `static int releases = 0;
void silk_test_reset_releases(void) { releases = 0; }
void silk_test_mark_release(void) { releases += 1; }
int silk_test_release_count(void) { return releases; }`,
        )
        const tests = `import silk.effect { Effect }
unsafe extern "C" fn silk_test_reset_releases() -> ()
unsafe extern "C" fn silk_test_mark_release() -> ()
unsafe extern "C" fn silk_test_release_count() -> i32

pub struct ExpectedFailure {}
pub struct CleanupFailure {}

effect fn use(resource: &mut i32) -> () {
  resource.* = 42
  return ()
}

effect fn release(resource: &mut i32) -> () {
  drop resource
  unsafe silk_test_mark_release()
  return ()
}

fn choose(values: [i32; 1], index: usize) -> i32 { return values[index] }

test fn cacheablePass() -> () {}

test effect fn failsBeforeContinuation() -> () ! ExpectedFailure { fail ExpectedFailure {} }

test effect fn cleanupExactlyOnce() -> () ! CleanupFailure {
  unsafe silk_test_reset_releases()
  run Effect.useReleaseNonParking(0, use, release)
  if unsafe silk_test_release_count() != 1 { drop choose([0], 1) }
}

test fn runsAfterFailure() -> () {
  if unsafe silk_test_release_count() != 1 { drop choose([0], 1) }
}
`
        const outcome = yield* compileSource(
          'source-test-runner',
          'import tests.Cases\nimport tests.Trap',
          {
            'tests/Cases': tests,
            'tests/Trap':
              'fn choose(values: [i32; 1], index: usize) -> i32 { return values[index] }\ntest fn fatalTrap() -> () { drop choose([0], 1) }',
          },
          {
            sourceModule: 'tests/Root',
            root: 'silk/test_runner',
            cache: false,
            discovery: {
              root: 'tests/Root',
              sources: new Map([
                ['tests/Root', { ownership: 'Project', logicalPath: 'tests/Root.silk' }],
                ['tests/Cases', { ownership: 'Project', logicalPath: 'tests/Cases.silk' }],
                ['tests/Trap', { ownership: 'Project', logicalPath: 'tests/Trap.silk' }],
              ]),
            },
            nativeLinkInputs: [NativeLinkInput.object(counter.artifact.path)],
          },
        )
        assert.strictEqual(outcome._tag, 'Compiled', Json.stringify(outcome))
        if (outcome._tag !== 'Compiled') return
        const manifest = outcome.testManifest
        assert.isDefined(manifest)
        if (manifest === undefined) return
        assert.strictEqual(manifest.entries.length, 5)
        const cacheablePass = manifest.entries.find((entry) => entry.test.name === 'cacheablePass')
        assert.strictEqual(
          cacheablePass?.eligibility._tag,
          'Eligible',
          Json.stringify(cacheablePass),
        )

        let invocation = 0
        const argumentsFor = (
          plan: Uint8Array,
          arguments_: ReadonlyArray<string>,
        ): { readonly arguments: ReadonlyArray<string>; readonly resultPath: string } => {
          invocation += 1
          const runnerRoot = realpathSync(destinationRoot)
          const planPath = join(runnerRoot, `runner-plan-${invocation}.bin`)
          const resultPath = join(runnerRoot, `runner-result-${invocation}.bin`)
          writeFileSync(planPath, plan)
          rmSync(resultPath, { force: true })
          return {
            arguments: [
              ...arguments_,
              '--silk-test-plan',
              planPath,
              '--silk-test-result',
              resultPath,
            ],
            resultPath,
          }
        }

        const firstPlan = runnerPerTestPlan(manifest)
        const firstInvocation = argumentsFor(firstPlan, ['--file', 'tests/Cases.silk'])
        const first = yield* runCompiled(outcome.path, firstInvocation)
        const cachedPlan = runnerPerTestPlan(manifest, new Set(['cacheablePass']))
        const cachedInvocation = argumentsFor(cachedPlan, ['--file', 'tests/Cases.silk'])
        const second = yield* runCompiled(outcome.path, cachedInvocation)
        assert.strictEqual(
          first.status,
          1,
          Json.stringify({
            status: first.status,
            signal: first.signal,
            stdout: first.stdout,
            stderr: first.stderr,
          }),
        )
        assert.strictEqual(
          second.status,
          1,
          Json.stringify({
            status: second.status,
            signal: second.signal,
            stdout: second.stdout,
            stderr: second.stderr,
          }),
        )
        assert.match(first.stdout, /  tests\/Cases::cacheablePass\n    PASS  (?:<1|\d+) (?:us|ms)/)
        assert.match(
          first.stdout,
          /  tests\/Cases::failsBeforeContinuation\n    FAIL  (?:<1|\d+) (?:us|ms)/,
        )
        assert.match(
          first.stdout,
          /  tests\/Cases::cleanupExactlyOnce\n    PASS  (?:<1|\d+) (?:us|ms)/,
        )
        assert.match(
          first.stdout,
          /  tests\/Cases::runsAfterFailure\n    PASS  (?:<1|\d+) (?:us|ms)/,
        )
        assert.include(
          first.stdout,
          'Tests  3 passed, 1 failed (0 cached, 4 executed, 4 selected, 5 discovered)',
        )
        assert.include(second.stdout, '  tests/Cases::cacheablePass\n    CACHED')
        assert.notMatch(second.stdout, /tests\/Cases::cacheablePass\n    PASS/)
        assert.include(
          second.stdout,
          'Tests  3 passed, 1 failed (1 cached, 3 executed, 4 selected, 5 discovered)',
        )
        assert.match(first.stdout, /^Time   (?:<1|\d+) (?:us|ms)$/m)
        assert.match(second.stdout, /^Time   (?:<1|\d+) (?:us|ms)$/m)
        assert.deepEqual(runnerReceipt(firstInvocation.resultPath, firstPlan), {
          mode: 1,
          dispositions: [1, 1, 2, 1],
          counts: [5n, 4n, 0n, 4n, 3n, 1n],
          status: 1,
        })
        assert.deepEqual(runnerReceipt(cachedInvocation.resultPath, cachedPlan), {
          mode: 1,
          dispositions: [0, 1, 2, 1],
          counts: [5n, 4n, 1n, 3n, 3n, 1n],
          status: 1,
        })
        assert.match(first.stderr, /ExpectedFailure/)
        assert.isBelow(
          first.stdout.indexOf('tests/Cases::failsBeforeContinuation'),
          first.stdout.indexOf('tests/Cases::runsAfterFailure'),
        )

        const filteredPlan = runnerPerTestPlan(manifest)
        const filteredInvocation = argumentsFor(filteredPlan, [
          '--file',
          'tests/Cases.silk',
          '--filter',
          'CLEANUP',
        ])
        const filtered = yield* runCompiled(outcome.path, filteredInvocation)
        assert.strictEqual(filtered.status, 0, filtered.stderr)
        assert.match(
          filtered.stdout,
          /  tests\/Cases::cleanupExactlyOnce\n    PASS  (?:<1|\d+) (?:us|ms)/,
        )
        assert.include(
          filtered.stdout,
          'Tests  1 passed, 0 failed (0 cached, 1 executed, 1 selected, 5 discovered)',
        )
        assert.deepEqual(runnerReceipt(filteredInvocation.resultPath, filteredPlan).counts, [
          5n,
          1n,
          0n,
          1n,
          1n,
          0n,
        ])

        const emptyPlan = runnerPerTestPlan(manifest)
        const emptyInvocation = argumentsFor(emptyPlan, ['--filter', 'does-not-exist'])
        const empty = yield* runCompiled(outcome.path, emptyInvocation)
        assert.strictEqual(empty.status, 0, empty.stderr)
        assert.include(
          empty.stdout,
          'Tests  0 passed, 0 failed (0 cached, 0 executed, 0 selected, 5 discovered)',
        )
        assert.deepEqual(runnerReceipt(emptyInvocation.resultPath, emptyPlan).counts, [
          5n,
          0n,
          0n,
          0n,
          0n,
          0n,
        ])

        const uncachedExchange = yield* runnerUncachedPlan(manifest).pipe(
          Effect.provide(NodeServices.layer),
        )
        const hostSourceSeam = yield* CliProgram.runTest(outcome.path, uncachedExchange.plan, [
          '--filter',
          'does-not-exist',
        ]).pipe(Effect.provide(NodeServices.layer))
        assert.strictEqual(hostSourceSeam._tag, 'Completed')
        if (hostSourceSeam._tag === 'Completed') {
          assert.strictEqual(hostSourceSeam.status, 0)
          assert.strictEqual(hostSourceSeam.receipt._tag, 'Uncached')
          assert.deepEqual(hostSourceSeam.receipt.counts, {
            discovered: 5n,
            selected: 0n,
            cached: 0n,
            executed: 0n,
            passed: 0n,
            failed: 0n,
          })
        }
        const uncachedPlan = uncachedExchange.bytes
        const uncachedInvocation = argumentsFor(uncachedPlan, ['--file', 'tests/Cases.silk'])
        const uncached = yield* runCompiled(outcome.path, uncachedInvocation)
        assert.strictEqual(uncached.status, 1, uncached.stderr)
        assert.include(
          uncached.stdout,
          'Tests  3 passed, 1 failed (0 cached, 4 executed, 4 selected, 5 discovered)',
        )
        assert.deepEqual(runnerReceipt(uncachedInvocation.resultPath, uncachedPlan), {
          mode: 2,
          dispositions: [],
          counts: [5n, 4n, 0n, 4n, 3n, 1n],
          status: 1,
        })

        for (const [label, offset] of [
          ['magic', 0],
          ['version', 8],
          ['mode', 12],
          ['catalog', 48],
          ['count', 80],
          ['padding', 88],
        ] as const) {
          const damagedPlan = Uint8Array.from(uncachedPlan)
          damagedPlan[offset] = (damagedPlan.at(offset) ?? 0) ^ 1
          const damagedInvocation = argumentsFor(damagedPlan, [])
          const damaged = yield* runCompiled(outcome.path, {
            ...damagedInvocation,
            timeout: 3_000,
          })
          assert.isUndefined(damaged.error, `${label} compact plan stalled`)
          assert.strictEqual(damaged.signal, null, `${label} compact plan was terminated`)
          assert.strictEqual(damaged.status, 2, `${label} compact plan did not reject`)
          assert.strictEqual(damaged.stdout, '', `${label} compact plan ran test effects`)
          assert.isFalse(existsSync(damagedInvocation.resultPath))
        }

        const malformedPlan = runnerPerTestPlan(manifest)
        malformedPlan[0] = 0
        const malformedInvocation = argumentsFor(malformedPlan, [])
        const malformed = yield* runCompiled(outcome.path, malformedInvocation)
        assert.strictEqual(malformed.status, 2, malformed.stderr)
        assert.isFalse(existsSync(malformedInvocation.resultPath))

        const trappedPlan = runnerPerTestPlan(manifest)
        const trappedInvocation = argumentsFor(trappedPlan, ['--file', 'tests/Trap.silk'])
        const trapped = yield* runCompiled(outcome.path, trappedInvocation)
        assert.strictEqual(
          trapped.signal !== null || (trapped.status !== null && trapped.status !== 0),
          true,
          `expected fatal test trap, native exited ${trapped.status}`,
        )
        assert.include(trapped.stdout, '  tests/Trap::fatalTrap')
        assert.notInclude(trapped.stdout, 'Tests  ')
        assert.isFalse(existsSync(trappedInvocation.resultPath))
      }),
    ),
  120_000,
)

fixedScenario(
  'runs a source-defined custom runner against a separate discovery root',
  () =>
    NativeToolchain.withBuildScope('custom-source-test-runner', (scope) =>
      Effect.gen(function* () {
        const target = yield* NativeToolchain.hostTarget()
        const observations = yield* NativeToolchain.compileCObject(
          toolchain,
          scope,
          target,
          'custom-test-observations',
          `static int observed = 0;
void silk_test_observe_first(void) { observed += 10; }
void silk_test_observe_second(void) { observed += 2; }
int silk_test_observed(void) { return observed; }`,
        )
        const outcome = yield* compileSource(
          'custom-source-test-runner',
          `unsafe extern "C" fn silk_test_observed() -> i32
pub fn main() -> i32 {
  let mut count = 0
  static for descriptor in Intrinsic.tests() {
    let body = Intrinsic.testFunction(descriptor)
    body()
    count = count + 1
  }
  if count != 2 { return 1 }
  return unsafe silk_test_observed()
}`,
          {
            'custom/Tests': `unsafe extern "C" fn silk_test_observe_first() -> ()
unsafe extern "C" fn silk_test_observe_second() -> ()
test fn first() { unsafe silk_test_observe_first() }
test fn second() { unsafe silk_test_observe_second() }`,
          },
          {
            sourceModule: 'memory/custom_runner',
            discovery: {
              root: 'custom/Tests',
              sources: new Map([
                ['custom/Tests', { ownership: 'Project', logicalPath: 'custom/Tests.silk' }],
              ]),
            },
            nativeLinkInputs: [NativeLinkInput.object(observations.artifact.path)],
          },
        )
        assert.strictEqual(outcome._tag, 'Compiled', Json.stringify(outcome))
        if (outcome._tag !== 'Compiled') return
        const first = yield* runCompiled(outcome.path)
        const second = yield* runCompiled(outcome.path)
        assert.strictEqual(first.status, 12, first.stderr)
        assert.strictEqual(second.status, 12, second.stderr)
      }),
    ),
  120_000,
)

it.effect.each(selected.native)(
  'runs the native corpus case $name',
  (program) =>
    Effect.gen(function* () {
      const compiledObjects =
        program.nativeCSources === undefined
          ? []
          : yield* compileCSources(`corpus-${program.name}`, program.nativeCSources)
      const profiles = program.nativeProfiles ?? [
        { name: 'optimized', optimization: 'speed' as const, debug: false },
      ]
      for (const profile of profiles) {
        const outcome = yield* compileSource(
          `corpus-${program.name}-${profile.name}`,
          program.nativeSource ?? program.source,
          program.nativeImports,
          {
            ...(program.name === 'test-exchange-binary-framing' ||
            program.name === 'local-shared-nested-owned-result-cleanup'
              ? { cache: false }
              : {}),
            ...(program.nativeComponents === undefined
              ? {}
              : { components: program.nativeComponents }),
            nativeLinkInputs: [
              ...compiledObjects.map(NativeLinkInput.object),
              ...(program.nativeDynamicLibraries ?? []).map((name) =>
                NativeLinkInput.library(name, 'Dynamic'),
              ),
            ],
            optimization: profile.optimization,
            debug: profile.debug,
          },
        )

        const caseName = `${program.name} [${profile.name}]`
        let compilationMessage = caseName
        if (outcome._tag === 'BackendFailed') {
          compilationMessage = `${caseName}: ${outcome.error.message}\n${Json.stringify(outcome.error.reason)}`
        } else if (outcome._tag === 'VerificationFailed') {
          compilationMessage = `${caseName}: ${outcome.error.message}\n${Json.stringify(outcome.error.violations)}`
        } else if (outcome._tag === 'Rejected') {
          compilationMessage = `${caseName}: ${outcome.diagnostics
            .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
            .join('\n')}`
        }
        assert.strictEqual(outcome._tag, 'Compiled', compilationMessage)
        if (outcome._tag !== 'Compiled') return

        // Invocation variants exercise startup policy without recompiling the same profile.
        for (const invocation of program.nativeRuns ?? [{}]) {
          const run = yield* runCompiled(outcome.path, invocation)
          if (program.nativeStdout !== undefined)
            assert.strictEqual(run.stdout, program.nativeStdout, caseName)
          if (!invocation.closeStderr && program.nativeStderr !== undefined)
            assert.strictEqual(run.stderr, program.nativeStderr, caseName)
          if (program.expected._tag === 'Completes') {
            const nativeStatus = run.status === null ? null : BigInt(run.status)
            // POSIX exposes only the low unsigned byte of a process exit value.
            const expectedStatus = BigInt(program.expected.result) & 0xffn
            assert.strictEqual(
              nativeStatus,
              expectedStatus,
              `unexpected native result for ${caseName}: expected ${program.expected.result}, native ${run.status}; ${Json.stringify({ signal: run.signal, stderr: run.stderr })}`,
            )
          } else {
            assert.strictEqual(
              run.signal !== null || (run.status !== null && run.status !== 0),
              true,
              `expected ${caseName} to trap, native exited ${run.status}`,
            )
          }
        }
      }
    }),
  1_500_000,
)

it.effect.each(selected.wasm)(
  'runs the shared portable corpus case $name through LLVM-to-Wasm',
  ({ name, source, expected }) =>
    Effect.gen(function* () {
      const outcome = yield* Driver.compile({
        compilation: {
          root: `memory/${name}-wasm`,
          target: 'wasm32-unknown-unknown',
        },
        toolchain,
        optimization: 'release',
        destination: join(destinationRoot, `${name}.wasm`),
        cache: false,
        artifactKind: 'WebAssemblyModule',
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make(`memory/${name}-wasm`, ascii(source))]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      assert.strictEqual(
        outcome._tag,
        'Compiled',
        outcome._tag === 'Rejected'
          ? outcome.diagnostics
              .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
              .join('\n')
          : outcome._tag,
      )
      if (outcome._tag !== 'Compiled') return
      yield* Effect.sync(() => {
        const module = new WebAssembly.Module(Uint8Array.from(readFileSync(outcome.path)))
        assert.deepEqual(WebAssembly.Module.imports(module), [])
        const main = new WebAssembly.Instance(module).exports['main']
        assert.isFunction(main)
        if (typeof main === 'function') assert.strictEqual(main(), expected)
      })
    }),
  600_000,
)

fixedScenario(
  'fails to link a foreign symbol nothing defines and keeps the linker output',
  () =>
    Effect.gen(function* () {
      const destination = join(destinationRoot, 'foreign-undefined')
      const result = yield* Effect.result(
        compileSource(
          'foreign-undefined',
          `unsafe extern "C" fn silk_test_missing_symbol(value: i32) -> i32
pub fn main() -> i32 { return unsafe silk_test_missing_symbol(1) }`,
        ),
      )
      assert.strictEqual(result._tag, 'Failure')
      if (result._tag !== 'Failure') return
      assert.strictEqual(result.failure._tag, 'ToolchainError')
      if (result.failure._tag !== 'ToolchainError') return
      assert.strictEqual(result.failure.reason._tag, 'LinkFailed')
      if (result.failure.reason._tag !== 'LinkFailed') return
      assert.match(result.failure.reason.output, /silk_test_missing_symbol/)
      assert.strictEqual(existsSync(destination), false)
    }),
  120_000,
)
fixedScenario(
  'links and runs the native system and monotonic clock ABI',
  () =>
    Effect.gen(function* () {
      const outcome = yield* compileSource(
        'native-clocks',
        `import silk.effect { Effect }
import silk.monotonic_clock { MonotonicClock }
import silk.os_monotonic_clock { OsMonotonicClock }
import silk.os_system_clock { OsSystemClock }
import silk.system_clock { SystemClock }
pub fn main() -> i32 {
  let mut system = OsSystemClock.make()
  let systemNow = run Effect.provideMut(SystemClock.now(), &mut system)
  let systemResolution = run Effect.provideMut(SystemClock.getResolution(), &mut system)
  let systemFraction = SystemClock.nanoseconds(&systemNow)
  if systemFraction < 0 { return 1 }
  if systemFraction >= 1000000000 { return 2 }
  if systemResolution == 0 { return 3 }

  let mut monotonic = OsMonotonicClock.make()
  let mark = run Effect.provideMut(MonotonicClock.now(), &mut monotonic)
  let monotonicResolution = run Effect.provideMut(
    MonotonicClock.getResolution(),
    &mut monotonic
  )
  let monotonicFraction = SystemClock.nanoseconds(&mark)
  if monotonicFraction < 0 { return 4 }
  if monotonicFraction >= 1000000000 { return 5 }
  if monotonicResolution == 0 { return 6 }
  run Effect.provideMut(MonotonicClock.waitUntil(move mark), &mut monotonic)
  run Effect.provideMut(MonotonicClock.waitFor(1), &mut monotonic)
  return 42
}`,
      )
      assert.strictEqual(
        outcome._tag,
        'Compiled',
        outcome._tag === 'BackendFailed'
          ? `${outcome.error.message}\n${Json.stringify(outcome.error.reason)}`
          : outcome._tag,
      )
      if (outcome._tag !== 'Compiled') return
      const run = yield* runCompiled(outcome.path)
      assert.strictEqual(run.signal, null)
      assert.strictEqual(run.status, 42)
    }),
  120_000,
)
