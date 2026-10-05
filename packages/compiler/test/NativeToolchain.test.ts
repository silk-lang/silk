import * as AnalysisFixture from './support/AnalysisFixture.js'
import {
  linkedForeignDollarCSource,
  linkedForeignDollarSource,
} from './support/foreignDollarSymbol.js'
import type * as Backend from '../src/Backend.js'
import * as ForeignContract from '../src/ForeignContract.js'
import * as Result from 'effect/Result'
import * as HelperCapability from '../src/HelperCapability.js'
import * as ObjectSymbols from '../src/internal/ObjectSymbols.js'
import * as Schema from 'effect/Schema'
import * as LlvmBitcode from '@silklang/llvm/Bitcode'
import * as LlvmBlock from '@silklang/llvm/Block'
import * as LlvmBuilder from '@silklang/llvm/Builder'
import * as LlvmConstant from '@silklang/llvm/Constant'
import * as LlvmFunction from '@silklang/llvm/Function'
import * as LlvmFunctionBody from '@silklang/llvm/FunctionBody'
import * as LlvmType from '@silklang/llvm/Type'
import * as LlvmValue from '@silklang/llvm/Value'
import { NodeServices } from '@effect/platform-node'
import * as PlatformSupply from '../src/PlatformSupply.js'
import * as PlatformSupplyResolver from '../src/PlatformSupplyResolver.js'
import * as NativeLinkResolver from '../src/NativeLinkResolver.js'
import * as LinkerScript from '../src/internal/LinkerScript.js'
import * as NativeStub from '../src/internal/NativeStub.js'
import * as CompilationProfile from '../src/CompilationProfile.js'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, assert, it } from '@effect/vitest'
import * as Clock from 'effect/Clock'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as TestClock from 'effect/testing/TestClock'
import * as Analysis from '../src/Analysis.js'
import * as NativeLinkInput from '../src/NativeLinkInput.js'
import * as NativeToolchain from '../src/NativeToolchain.js'
import * as Storage from '../src/Storage.js'
import * as ObjectEmission from '../src/ObjectEmission.js'
import * as Linker from '../src/Linker.js'
import * as LlvmWasmRuntime from '../src/LlvmWasmRuntime.js'
import * as Target from '../src/Target.js'
import * as ToolchainPlan from '../src/ToolchainPlan.js'
import { unreachable } from './support/raise.js'

const defaultClang = (): string => {
  if (existsSync('/opt/homebrew/opt/llvm/bin/clang')) return '/opt/homebrew/opt/llvm/bin/clang'
  if (existsSync('/usr/local/opt/llvm/bin/clang')) return '/usr/local/opt/llvm/bin/clang'
  return '/usr/bin/clang'
}

const testPath = Effect.runSync(Config.String('PATH').pipe(Config.withDefault('')))
const clang = Effect.runSync(
  Config.String('SILK_TEST_CLANG').pipe(Config.withDefault(defaultClang())),
)
const defaultLlvmAr = join(dirname(clang), 'llvm-ar')
const toolchain: NativeToolchain.Toolchain = Object.freeze({
  _tag: 'Toolchain',
  clang,
  llvmAr: Effect.runSync(
    Config.String('SILK_TEST_LLVM_AR').pipe(
      Config.withDefault(existsSync(defaultLlvmAr) ? defaultLlvmAr : '/usr/bin/llvm-ar'),
    ),
  ),
})

const testRoot = mkdtempSync(join(tmpdir(), 'silk-native-boundary-test-'))
afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true })
})

const finalize = Effect.fnUntraced(function* (
  tools: NativeToolchain.Toolchain,
  scope: NativeToolchain.BuildScope,
  kind: ToolchainPlan.NativeArtifactKind,
  target: Target.Target,
  objects: ReadonlyArray<NativeToolchain.PathArtifact>,
  inputs: ReadonlyArray<NativeLinkInput.NativeLinkInput>,
  destination: string,
) {
  const profile = yield* profileFor(target).pipe(Effect.orDie)
  const selection = { kind: 'default' } as const
  const plan = yield* NativeToolchain.planNativeLink(
    tools,
    scope,
    kind,
    profile,
    objects,
    inputs,
    destination,
    { request: selection, composition: selection, resolved: selection },
  )
  return (yield* Linker.link({
    scope,
    plan,
    artifactKind: kind,
    destination,
    cache: Object.freeze({ _tag: 'Disabled' }),
  })).artifact
})

it('denies native final-cache admission without complete tool and implicit-input identities', () => {
  for (const kind of ['NativeExecutable', 'NativeSharedLibrary', 'NativeStaticLibrary'] as const) {
    assert.deepStrictEqual(NativeToolchain.finalArtifactCacheAdmission(kind), {
      _tag: 'Ineligible',
      reason: 'IncompleteNativeInputAccounting',
    })
  }
  assert.deepStrictEqual(NativeToolchain.finalArtifactCacheAdmission('WebAssemblyModule'), {
    _tag: 'ExistingWebAssemblyPolicy',
  })
})

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const setUint16LittleEndian = (bytes: Uint8Array, offset: number, value: number): void => {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
}

const setUint32LittleEndian = (bytes: Uint8Array, offset: number, value: number): void => {
  setUint16LittleEndian(bytes, offset, value & 0xffff)
  setUint16LittleEndian(bytes, offset + 2, value >>> 16)
}

const machOImage = (fileType: 1 | 2 | 6): Uint8Array => {
  const bytes = new Uint8Array(32)
  bytes.set([0xcf, 0xfa, 0xed, 0xfe])
  setUint32LittleEndian(bytes, 4, 0x0100_000c)
  setUint32LittleEndian(bytes, 12, fileType)
  return bytes
}

const elfImage = (machine: 62 | 183, fileType: 1 | 2 | 3, hasInterpreter = false): Uint8Array => {
  const bytes = new Uint8Array(fileType === 3 ? 68 : 64)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  setUint16LittleEndian(bytes, 16, fileType)
  setUint16LittleEndian(bytes, 18, machine)
  if (fileType === 3) {
    setUint32LittleEndian(bytes, 32, 64)
    setUint16LittleEndian(bytes, 54, 4)
    setUint16LittleEndian(bytes, 56, 1)
    setUint32LittleEndian(bytes, 64, hasInterpreter ? 3 : 1)
  }
  return bytes
}

const nativeObjectFor = (target: Target.Target): Uint8Array => {
  switch (target.id) {
    case 'aarch64-apple-darwin':
      return machOImage(1)
    case 'aarch64-unknown-linux-gnu':
      return elfImage(183, 1)
    case 'x86_64-unknown-linux-gnu':
      return elfImage(62, 1)
    case 'wasm32-unknown-unknown':
      return assert.fail('WebAssembly has no native object container')
  }
}

const staticArchive = (...objects: ReadonlyArray<Uint8Array>): Uint8Array => {
  const memberLength = (object: Uint8Array): number => 60 + object.length + (object.length % 2)
  const bytes = new Uint8Array(
    8 + objects.reduce((length, object) => length + memberLength(object), 0),
  )
  bytes.set(ascii('!<arch>\n'))
  let offset = 8
  for (const object of objects) {
    const header = new Uint8Array(60)
    header.fill(0x20)
    header.set(ascii('member.o/       '), 0)
    header.set(ascii(String(object.length).padEnd(10, ' ')), 48)
    header.set([0x60, 0x0a], 58)
    bytes.set(header, offset)
    bytes.set(object, offset + header.length)
    offset += memberLength(object)
  }
  return bytes
}

const malformedExtendedNameArchive = (nameLength: number): Uint8Array => {
  const bytes = new Uint8Array(8 + 60 + nameLength)
  bytes.set(ascii('!<arch>\n'))
  const header = new Uint8Array(60)
  header.fill(0x20)
  header.set(ascii(`#1/${String(nameLength)}`), 0)
  header.set(ascii(String(nameLength).padEnd(10, ' ')), 48)
  header.set([0x60, 0x0a], 58)
  bytes.set(header, 8)
  return bytes
}

const profileFor = Effect.fnUntraced(function* (
  target: Target.Target,
  optimization: ToolchainPlan.OptimizationProfile = 'release',
) {
  const initial = yield* CompilationProfile.normalize({
    target: target.id,
    optimization: optimization === 'debug' ? 'none' : 'speed',
    debug: optimization !== 'release',
  })
  return yield* CompilationProfile.publish(initial, [])
})

const artifactFor = Effect.fnUntraced(function* (
  target: Target.Target,
  profile: ToolchainPlan.OptimizationProfile,
) {
  const snapshot = yield* AnalysisFixture.declarations(
    'memory/native',
    ascii(
      'pub fn identity(value: i32) -> i32 { return value }\nexport "C" fn entry() -> i32 as "main" { return identity(identity(42)) }',
    ),
    target.id,
  )
  return yield* Analysis.codegen(snapshot, { mode: ToolchainPlan.codegenModeFor(profile) })
})

it.effect('plans fixed profile arguments against the canonical target id', () =>
  Effect.gen(function* () {
    const target = Target.aarch64AppleDarwin
    const debug = ToolchainPlan.objectCommand(
      clang,
      yield* profileFor(target, 'debug'),
      'in.bc',
      'out.o',
    )
    const release = ToolchainPlan.objectCommand(
      clang,
      yield* profileFor(target, 'release'),
      'in.bc',
      'out.o',
    )
    assert.deepEqual(debug.arguments, [
      '--target=aarch64-apple-darwin',
      '-c',
      '-x',
      'ir',
      'in.bc',
      '-fPIC',
      '-O0',
      '-g',
      '-mmacosx-version-min=11.0.0',
      '-o',
      'out.o',
    ])
    assert.deepEqual(release.arguments, [
      '--target=aarch64-apple-darwin',
      '-c',
      '-x',
      'ir',
      'in.bc',
      '-fPIC',
      '-O2',
      '-mmacosx-version-min=11.0.0',
      '-o',
      'out.o',
    ])
    const runtime = ToolchainPlan.cObjectCommand(clang, target, 'silk_runtime.c', 'silk_runtime.o')
    assert.deepEqual(runtime.arguments, [
      '--target=aarch64-apple-darwin',
      '-c',
      '-x',
      'c',
      'silk_runtime.c',
      '-O2',
      '-fPIC',
      '-fvisibility=hidden',
      '-o',
      'silk_runtime.o',
    ])
    const link = ToolchainPlan.nativeCommand(
      { clang, llvmAr: 'llvm-ar' },
      'NativeExecutable',
      target,
      ['program.o', 'silk_runtime.o', 'extra.o'],
      [NativeLinkInput.library('m', 'Dynamic'), NativeLinkInput.library('c', 'Dynamic')],
      'out',
    )
    if (link._tag !== 'PlannedCommand') return assert.fail('expected executable link plan')
    assert.deepEqual(link.arguments, [
      '--target=aarch64-apple-darwin',
      'program.o',
      'silk_runtime.o',
      'extra.o',
      '-lm',
      '-lc',
      '-o',
      'out',
    ])
  }),
)

it('plans shared links and deterministic static archives from structured inputs', () => {
  const shared = ToolchainPlan.nativeCommand(
    { clang, llvmAr: 'llvm-ar' },
    'NativeSharedLibrary',
    Target.aarch64AppleDarwin,
    ['program.o', 'runtime.o'],
    [
      NativeLinkInput.searchPath('/sdk/lib'),
      NativeLinkInput.library('z', 'Dynamic'),
      NativeLinkInput.object('/objects/extra.o'),
      NativeLinkInput.staticArchive('/archives/liblocal.a'),
      NativeLinkInput.framework('CoreFoundation'),
    ],
    'libprogram.dylib',
  )
  if (shared._tag !== 'PlannedCommand') return assert.fail('expected shared link plan')
  assert.deepStrictEqual(shared.arguments, [
    '--target=aarch64-apple-darwin',
    '-dynamiclib',
    '-Wl,-install_name,@rpath/libprogram.dylib',
    'program.o',
    'runtime.o',
    '-L/sdk/lib',
    '-lz',
    '/objects/extra.o',
    '/archives/liblocal.a',
    '-framework',
    'CoreFoundation',
    '-o',
    'libprogram.dylib',
  ])

  const archive = ToolchainPlan.nativeCommand(
    { clang, llvmAr: '/tool/llvm-ar' },
    'NativeStaticLibrary',
    Target.aarch64AppleDarwin,
    ['program.o', 'runtime.o'],
    [NativeLinkInput.object('/objects/extra.o')],
    'libprogram.a',
  )
  if (archive._tag !== 'PlannedCommand') return assert.fail('expected archive plan')
  assert.strictEqual(archive.command, '/tool/llvm-ar')
  assert.deepStrictEqual(archive.arguments, [
    'rcsD',
    'libprogram.a',
    'program.o',
    'runtime.o',
    '/objects/extra.o',
  ])

  const linuxStatic = ToolchainPlan.nativeCommand(
    { clang, llvmAr: 'llvm-ar' },
    'NativeSharedLibrary',
    Target.x8664UnknownLinuxGnu,
    [],
    [NativeLinkInput.library('answer', 'Static')],
    'libprogram.so',
  )
  if (linuxStatic._tag !== 'PlannedCommand') return assert.fail('expected Linux link plan')
  assert.deepStrictEqual(linuxStatic.arguments, [
    '--target=x86_64-unknown-linux-gnu',
    '-shared',
    '-Wl,-Bstatic',
    '-lanswer',
    '-Wl,-Bdynamic',
    '-o',
    'libprogram.so',
  ])
})

it('rejects target- and artifact-incompatible structured link inputs', () => {
  const staticLibrary = NativeLinkInput.library('answer', 'Static')
  const framework = NativeLinkInput.framework('CoreFoundation')
  const searchPath = NativeLinkInput.searchPath('/sdk/lib')
  const darwinStatic = ToolchainPlan.nativeCommand(
    { clang, llvmAr: 'llvm-ar' },
    'NativeSharedLibrary',
    Target.aarch64AppleDarwin,
    [],
    [staticLibrary],
    'libanswer.dylib',
  )
  const linuxFramework = ToolchainPlan.nativeCommand(
    { clang, llvmAr: 'llvm-ar' },
    'NativeExecutable',
    Target.x8664UnknownLinuxGnu,
    [],
    [framework],
    'answer',
  )
  const archiveSearch = ToolchainPlan.nativeCommand(
    { clang, llvmAr: 'llvm-ar' },
    'NativeStaticLibrary',
    Target.aarch64AppleDarwin,
    [],
    [searchPath],
    'libanswer.a',
  )
  if (darwinStatic._tag !== 'UnsupportedNativePlan') return assert.fail('expected rejection')
  assert.strictEqual(darwinStatic.artifactKind, 'NativeSharedLibrary')
  assert.deepStrictEqual(darwinStatic.target, Target.aarch64AppleDarwin)
  assert.deepStrictEqual(darwinStatic.input, staticLibrary)
  assert.strictEqual(darwinStatic.reason, 'StaticLibraryTarget')

  if (linuxFramework._tag !== 'UnsupportedNativePlan') return assert.fail('expected rejection')
  assert.strictEqual(linuxFramework.artifactKind, 'NativeExecutable')
  assert.deepStrictEqual(linuxFramework.target, Target.x8664UnknownLinuxGnu)
  assert.deepStrictEqual(linuxFramework.input, framework)
  assert.strictEqual(linuxFramework.reason, 'FrameworkTarget')

  if (archiveSearch._tag !== 'UnsupportedNativePlan') return assert.fail('expected rejection')
  assert.strictEqual(archiveSearch.artifactKind, 'NativeStaticLibrary')
  assert.deepStrictEqual(archiveSearch.target, Target.aarch64AppleDarwin)
  assert.deepStrictEqual(archiveSearch.input, searchPath)
  assert.strictEqual(archiveSearch.reason, 'StaticArchiveInput')

  const relativeObject = NativeLinkInput.object('-Wl,--export-dynamic')
  const unsafePath = ToolchainPlan.nativeCommand(
    { clang, llvmAr: 'llvm-ar' },
    'NativeExecutable',
    Target.x8664UnknownLinuxGnu,
    [],
    [relativeObject],
    '/tmp/out',
  )
  assert.strictEqual(unsafePath._tag, 'UnsupportedNativePlan')
  if (unsafePath._tag !== 'UnsupportedNativePlan') return
  assert.strictEqual(unsafePath.artifactKind, 'NativeExecutable')
  assert.strictEqual(unsafePath.target, Target.x8664UnknownLinuxGnu)
  assert.strictEqual(unsafePath.input, relativeObject)
  assert.strictEqual(unsafePath.reason, 'PathNotAbsolute')
})

it.effect(
  'includes the selected LLVM-Wasm freestanding runtime in the artifact cache identity',
  () =>
    Effect.gen(function* () {
      const compilationwasm32UnknownUnknown = yield* profileFor(Target.wasm32UnknownUnknown)
      const bitcode = Uint8Array.from([0, 1, 2, 3])
      const runtimeSource = NativeToolchain.artifactRuntimeSource('WebAssemblyModule', [])
      assert.strictEqual(runtimeSource, LlvmWasmRuntime.source)
      const keyFor = (runtimeSource: string) =>
        NativeToolchain.wasmArtifactCacheKey(
          toolchain,
          compilationwasm32UnknownUnknown,
          bitcode,
          runtimeSource,
        )
      const original = yield* keyFor(runtimeSource)
      const changed = yield* keyFor(`${runtimeSource}\n/* cache identity mutation */`)
      assert.notStrictEqual(original, changed)
      assert.match(original, /\.wasm$/)
      assert.match(changed, /\.wasm$/)
    }),
)

it.effect('authenticates artifact-cache payloads and rejects body or trailing corruption', () =>
  Effect.gen(function* () {
    let stored: Uint8Array | undefined
    const storage: Storage.Service = Storage.Storage.of({
      read: () => Effect.succeed(stored === undefined ? Option.none() : Option.some(stored)),
      publish: (_address, bytes) =>
        Effect.sync(() => {
          stored = Uint8Array.from(bytes)
        }),
    })
    const payload = Uint8Array.from([1, 2, 3, 4])
    // A record written as consecutive parts reads back as their concatenation.
    yield* NativeToolchain.writeArtifactCache(storage, 'entry', [
      payload.subarray(0, 1),
      payload.subarray(1),
    ])
    assert.deepStrictEqual(yield* NativeToolchain.readArtifactCache(storage, 'entry'), payload)
    assert.strictEqual(yield* NativeToolchain.readArtifactCache(storage, 'other-entry'), undefined)
    if (stored === undefined) return assert.fail('expected encoded cache entry')
    const encoded = stored

    const corrupted = Uint8Array.from(encoded)
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff
    stored = corrupted
    assert.strictEqual(yield* NativeToolchain.readArtifactCache(storage, 'entry'), undefined)

    const appended = new Uint8Array(encoded.length + 1)
    appended.set(encoded)
    stored = appended
    assert.strictEqual(yield* NativeToolchain.readArtifactCache(storage, 'entry'), undefined)
  }),
)

it.effect('yields a typed spawn failure with command, stage, and arbitrary cause', () =>
  Effect.gen(function* () {
    const target = yield* NativeToolchain.hostTarget()
    const compilation = yield* profileFor(target)
    const artifact = yield* artifactFor(target, 'release')
    let scopeRoot = ''
    const result = yield* Effect.result(
      NativeToolchain.withBuildScope('spawn-failure', (scope) => {
        scopeRoot = scope.root
        return ObjectEmission.materialize({
          toolchain: { _tag: 'Toolchain', clang: '/nonexistent/clang', llvmAr: 'llvm-ar' },
          scope,
          artifact,
          profile: compilation,
        })
      }),
    )
    assert.strictEqual(result._tag, 'Failure')
    if (result._tag !== 'Failure') return
    assert.strictEqual(result.failure._tag, 'ToolchainError')
    assert.strictEqual(result.failure.stage, 'object')
    assert.strictEqual(result.failure.reason._tag, 'SpawnFailed')
    if (result.failure.reason._tag !== 'SpawnFailed') return
    assert.strictEqual(result.failure.reason.planned.command, '/nonexistent/clang')
    assert.instanceOf(result.failure.reason.cause, Error)
    assert.strictEqual(existsSync(scopeRoot), false)
  }),
)

/**
 * A diamond whose join reads a value defined only in one arm: the dominance violation #130
 * emitted. `Bitcode.encode` does not run the in-process verifier, so the bytes reach clang as-is.
 */
const diamondBitcode = Effect.fnUntraced(function* (escapes: boolean) {
  const builder = yield* LlvmBuilder.make()
  const i32 = yield* LlvmType.integer(builder, 32)
  const type = yield* LlvmType.functionType(builder, i32, [i32])
  const fn = yield* LlvmFunction.declare(builder, 'diamond', type)
  yield* LlvmFunction.buildBody(
    builder,
    fn,
    Effect.fnUntraced(function* (body) {
      const entry = yield* LlvmBlock.make(body, 'entry')
      const taken = yield* LlvmBlock.make(body, 'taken')
      const otherwise = yield* LlvmBlock.make(body, 'otherwise')
      const join = yield* LlvmBlock.make(body, 'join')
      const argument = yield* LlvmValue.argument(body, 0)
      const zero = yield* LlvmConstant.integerSigned(builder, i32, 0n)
      yield* LlvmBlock.setInsertionPoint(body, entry)
      const condition = yield* LlvmFunctionBody.integerCompare(body, 'ne', argument, zero, 'cond')
      yield* LlvmFunctionBody.conditionalBranch(body, condition, taken, otherwise)
      yield* LlvmBlock.setInsertionPoint(body, taken)
      const armLocal = yield* LlvmFunctionBody.binary(body, 'add', argument, argument, 'armLocal')
      yield* LlvmFunctionBody.branch(body, join)
      yield* LlvmBlock.setInsertionPoint(body, otherwise)
      yield* LlvmFunctionBody.branch(body, join)
      yield* LlvmBlock.setInsertionPoint(body, join)
      const used = escapes ? armLocal : argument
      const result = yield* LlvmFunctionBody.binary(body, 'add', used, argument, 'result')
      yield* LlvmFunctionBody.returnValue(body, result)
    }),
  )
  return yield* LlvmBitcode.encode(builder)
})

it.effect('rejects bitcode that fails LLVM module verification at the object step', () =>
  Effect.gen(function* () {
    const target = yield* NativeToolchain.hostTarget()
    const profile = yield* profileFor(target)
    const artifact = yield* artifactFor(target, 'release')
    const emit = Effect.fnUntraced(function* (escapes: boolean) {
      const bitcode = yield* diamondBitcode(escapes)
      return yield* NativeToolchain.withBuildScope('verifier-control', (scope) =>
        ObjectEmission.materialize({
          toolchain,
          scope,
          artifact: { ...artifact, bitcode },
          profile,
        }),
      ).pipe(Effect.result)
    })
    // The well-formed twin proves the encoding itself reaches codegen; only dominance differs.
    assert.strictEqual((yield* emit(false))._tag, 'Success')
    const rejected = yield* emit(true)
    assert.strictEqual(rejected._tag, 'Failure')
    if (rejected._tag !== 'Failure') return
    assert.strictEqual(rejected.failure._tag, 'ToolchainError')
    assert.strictEqual(rejected.failure.stage, 'object')
    assert.strictEqual(rejected.failure.reason._tag, 'SpawnFailed')
  }),
)

it.effect('rejects hosted language runtime dependencies before spawning a no-libc compiler', () =>
  Effect.gen(function* () {
    const initial = yield* CompilationProfile.normalize({
      target: 'x86_64-unknown-linux-gnu',
      libc: 'none',
      artifact: 'object',
    })
    const compilation = yield* CompilationProfile.publish(initial, [])
    const artifact = yield* artifactFor(compilation.target, 'release')
    const result = yield* Effect.result(
      NativeToolchain.withBuildScope(
        'raw-capability',
        Effect.fnUntraced(function* (scope) {
          return yield* ObjectEmission.materialize({
            toolchain: { _tag: 'Toolchain', clang: '/nonexistent/clang', llvmAr: 'llvm-ar' },
            scope,
            artifact: { ...artifact, nativeRuntimeSymbols: ['silk_test_unsupported_runtime'] },
            profile: compilation,
          })
        }),
      ),
    )
    assert.strictEqual(result._tag, 'Failure')
    if (result._tag !== 'Failure') return
    assert.strictEqual(result.failure.reason._tag, 'HelperFailed')
    if (result.failure.reason._tag !== 'HelperFailed') return
    assert.strictEqual(result.failure.reason.failure.code, 'MissingProvider')
    assert.deepStrictEqual(result.failure.reason.failure.origins, ['silk_test_unsupported_runtime'])
  }),
)

it.effect('reuses explicitly shared runtime bytes across cleaned build scopes', () =>
  Effect.gen(function* () {
    const target = yield* NativeToolchain.hostTarget()
    const cache = NativeToolchain.makeRuntimeObjectCache()
    const cachedToolchain = Object.freeze({ ...toolchain, runtimeObjectCache: cache })
    yield* NativeToolchain.withBuildScope('runtime-miss', (scope) =>
      NativeToolchain.compileRuntime(cachedToolchain, scope, target),
    )
    yield* NativeToolchain.withBuildScope('runtime-hit', (scope) =>
      NativeToolchain.compileRuntime(cachedToolchain, scope, target),
    )
    assert.deepEqual(NativeToolchain.runtimeObjectCacheStats(cache), {
      entries: 1,
      hits: 1,
      misses: 1,
    })
  }),
)

it.effect('removes a build scope after interruption', () =>
  Effect.gen(function* () {
    let scopeRoot = ''
    const fiber = yield* Effect.forkChild(
      NativeToolchain.withBuildScope('interrupted', (scope) => {
        scopeRoot = scope.root
        return Effect.never
      }),
    )
    yield* Effect.yieldNow
    yield* Fiber.interrupt(fiber)
    assert.isNotEmpty(scopeRoot)
    assert.strictEqual(existsSync(scopeRoot), false)
  }),
)

it.effect('retries a throwing scope cleanup without replacing the protected failure', () =>
  Effect.gen(function* () {
    const protectedFailure = Object.freeze({ _tag: 'ProtectedFailure' as const })
    let scopeRoot = ''
    let cleanupAttempts = 0
    const result = yield* Effect.result(
      NativeToolchain.withBuildScope(
        'cleanup-retry',
        (scope) => {
          scopeRoot = scope.root
          return Effect.fail(protectedFailure)
        },
        {
          cleanup: {
            remove: (path, options) => {
              cleanupAttempts += 1
              if (cleanupAttempts === 1) throw new Error('injected cleanup failure')
              rmSync(path, options)
            },
          },
        },
      ),
    )
    assert.strictEqual(result._tag, 'Failure')
    if (result._tag !== 'Failure') return
    assert.strictEqual(result.failure, protectedFailure)
    assert.strictEqual(cleanupAttempts, 2)
    assert.strictEqual(existsSync(scopeRoot), false)
  }),
)

it.effect('surfaces persistent cleanup failure after a successful protected operation', () =>
  Effect.gen(function* () {
    const cleanupFailure = Object.freeze({ injected: 'persistent-scope-cleanup' })
    let scopeRoot = ''
    const result = yield* Effect.result(
      NativeToolchain.withBuildScope(
        'cleanup-failure-after-success',
        (scope) => {
          scopeRoot = scope.root
          return Effect.succeed(42)
        },
        {
          cleanup: {
            remove: () => {
              throw cleanupFailure
            },
          },
        },
      ),
    )
    assert.strictEqual(result._tag, 'Failure')
    if (result._tag !== 'Failure') return
    assert.strictEqual(result.failure.operation, 'NativeToolchain.cleanupPath')
    assert.strictEqual(result.failure.stage, 'scope-cleanup')
    assert.strictEqual(result.failure.reason._tag, 'StorageFailed')
    if (result.failure.reason._tag !== 'StorageFailed') return
    assert.deepEqual(result.failure.reason.cause, {
      first: cleanupFailure,
      retry: cleanupFailure,
    })
    assert.strictEqual(existsSync(scopeRoot), false)
  }),
)

it.effect('preserves a primary failure when persistent cleanup also fails', () =>
  Effect.gen(function* () {
    const primaryFailure = Object.freeze({ _tag: 'ProtectedFailure' as const })
    const cleanupFailure = Object.freeze({ injected: 'persistent-scope-cleanup' })
    let scopeRoot = ''
    const result = yield* Effect.result(
      NativeToolchain.withBuildScope(
        'primary-and-cleanup-failure',
        (scope) => {
          scopeRoot = scope.root
          return Effect.fail(primaryFailure)
        },
        {
          cleanup: {
            remove: () => {
              throw cleanupFailure
            },
          },
        },
      ),
    )
    assert.strictEqual(result._tag, 'Failure')
    if (result._tag !== 'Failure') return
    assert.strictEqual(result.failure, primaryFailure)
    assert.strictEqual(existsSync(scopeRoot), false)
  }),
)

it.effect('failed rename removes its temporary sibling and preserves the destination', () =>
  Effect.gen(function* () {
    const destination = join(testRoot, 'occupied-destination')
    mkdirSync(destination)
    const result = yield* Effect.result(
      NativeToolchain.atomicCommit(destination, Uint8Array.of(1, 2, 3)),
    )
    assert.strictEqual(result._tag, 'Failure')
    if (result._tag !== 'Failure') return
    assert.strictEqual(result.failure.reason._tag, 'StorageFailed')
    assert.strictEqual(existsSync(destination), true)
    assert.deepEqual(
      readdirSync(testRoot).filter((name) => name.startsWith('occupied-destination.silk-tmp-')),
      [],
    )
  }),
)

it.effect('commits exact native-library interface siblings beside the primary artifact', () =>
  Effect.gen(function* () {
    const destination = join(testRoot, 'interface-success', 'libanswer.a')
    const primary = yield* NativeToolchain.atomicCommit(destination, ascii('archive'))
    const companions = yield* NativeToolchain.commitLibraryInterface(
      primary,
      destination,
      'answer',
      ascii('header\n'),
      ascii('{"silkForeignAbi":1}\n'),
    )
    assert.deepStrictEqual(companions, {
      _tag: 'LibraryInterfaceArtifacts',
      cHeader: join(testRoot, 'interface-success', 'answer.h'),
      abiManifest: join(testRoot, 'interface-success', 'answer.abi.json'),
    })
    assert.deepStrictEqual(readFileSync(companions.cHeader), ascii('header\n'))
    assert.deepStrictEqual(readFileSync(companions.abiManifest), ascii('{"silkForeignAbi":1}\n'))
  }),
)

it.effect('removes the primary and stale companions when manifest staging fails', () =>
  Effect.gen(function* () {
    const directory = join(testRoot, 'interface-failure')
    const destination = join(directory, 'libanswer.a')
    const primary = yield* NativeToolchain.atomicCommit(destination, ascii('archive'))
    const header = join(directory, 'answer.h')
    const manifest = join(directory, 'answer.abi.json')
    writeFileSync(header, ascii('stale header\n'))
    writeFileSync(manifest, ascii('{"stale":true}\n'))
    const unstagedManifest = new Proxy(ascii('{}\n'), {})

    const result = yield* Effect.result(
      NativeToolchain.commitLibraryInterface(
        primary,
        destination,
        'answer',
        ascii('header\n'),
        unstagedManifest,
      ),
    )

    assert.strictEqual(result._tag, 'Failure')
    assert.strictEqual(existsSync(primary), false)
    assert.strictEqual(existsSync(header), false)
    assert.strictEqual(existsSync(manifest), false)
  }),
)

it.effect('retries throwing atomic cleanup and leaves no staged sibling', () =>
  Effect.gen(function* () {
    const destination = join(testRoot, 'occupied-cleanup-retry')
    mkdirSync(destination)
    let cleanupAttempts = 0
    const result = yield* Effect.result(
      NativeToolchain.atomicCommit(destination, Uint8Array.of(4, 5, 6), {
        cleanup: {
          remove: (path, options) => {
            cleanupAttempts += 1
            if (cleanupAttempts === 1) throw new Error('injected cleanup failure')
            rmSync(path, options)
          },
        },
      }),
    )
    assert.strictEqual(result._tag, 'Failure')
    assert.strictEqual(cleanupAttempts, 2)
    assert.deepEqual(
      readdirSync(testRoot).filter((name) => name.startsWith('occupied-cleanup-retry.silk-tmp-')),
      [],
    )
  }),
)

it.effect('falls back to Node cleanup when injected atomic cleanup keeps failing', () =>
  Effect.gen(function* () {
    const destination = join(testRoot, 'occupied-cleanup-fallback')
    mkdirSync(destination)
    let cleanupAttempts = 0
    const result = yield* Effect.result(
      NativeToolchain.atomicCommit(destination, Uint8Array.of(7, 8, 9), {
        cleanup: {
          remove: () => {
            cleanupAttempts += 1
            throw new Error('injected persistent cleanup failure')
          },
        },
      }),
    )
    assert.strictEqual(result._tag, 'Failure')
    assert.strictEqual(cleanupAttempts, 2)
    assert.deepEqual(
      readdirSync(testRoot).filter((name) =>
        name.startsWith('occupied-cleanup-fallback.silk-tmp-'),
      ),
      [],
    )
  }),
)

it.effect('translates runtime Storage read failures with cache-stage provenance', () =>
  Effect.gen(function* () {
    const target = yield* NativeToolchain.hostTarget()
    const cause = Object.freeze({ injected: 'cache-read' })
    const error = new Storage.StorageError({
      operation: 'Storage.read',
      namespace: 'runtime-objects',
      key: 'injected',
      message: 'injected read failure',
      reason: { _tag: 'ReadFailure', cause },
    })
    const storage = Storage.Storage.of({
      read: () => Effect.fail(error),
      publish: () => Effect.void,
    })
    const cache = NativeToolchain.makeRuntimeObjectCache(storage)
    const result = yield* Effect.result(
      NativeToolchain.withBuildScope('cache-read-failure', (scope) =>
        NativeToolchain.compileRuntime(
          Object.freeze({ ...toolchain, runtimeObjectCache: cache }),
          scope,
          target,
        ),
      ),
    )
    assert.strictEqual(result._tag, 'Failure')
    if (result._tag !== 'Failure') return
    assert.strictEqual(result.failure.stage, 'cache-read')
    assert.strictEqual(result.failure.operation, 'NativeToolchain.RuntimeObjectCache.get')
    assert.strictEqual(result.failure.reason._tag, 'StorageFailed')
    if (result.failure.reason._tag !== 'StorageFailed') return
    assert.strictEqual(result.failure.reason.cause, error)
  }),
)

it.effect('translates runtime Storage publication failures with cache-stage provenance', () =>
  Effect.gen(function* () {
    const target = yield* NativeToolchain.hostTarget()
    const cause = Object.freeze({ injected: 'cache-write' })
    const error = new Storage.StorageError({
      operation: 'Storage.publish',
      namespace: 'runtime-objects',
      key: 'injected',
      message: 'injected publication failure',
      reason: { _tag: 'PublishFailure', cause },
    })
    const storage = Storage.Storage.of({
      read: () => Effect.succeedNone,
      publish: () => Effect.fail(error),
    })
    const cache = NativeToolchain.makeRuntimeObjectCache(storage)
    const result = yield* Effect.result(
      NativeToolchain.withBuildScope('cache-write-failure', (scope) =>
        NativeToolchain.compileRuntime(
          Object.freeze({ ...toolchain, runtimeObjectCache: cache }),
          scope,
          target,
        ),
      ),
    )
    assert.strictEqual(result._tag, 'Failure')
    if (result._tag !== 'Failure') return
    assert.strictEqual(result.failure.stage, 'cache-write')
    assert.strictEqual(result.failure.operation, 'NativeToolchain.RuntimeObjectCache.set')
    assert.strictEqual(result.failure.reason._tag, 'StorageFailed')
    if (result.failure.reason._tag !== 'StorageFailed') return
    assert.strictEqual(result.failure.reason.cause, error)
  }),
)

it('classifies cached artifacts by container, kind, and every canonical target', () => {
  const fixtures: ReadonlyArray<{
    readonly kind: NativeToolchain.FinalArtifact['kind']
    readonly target: Target.Target
    readonly bytes: Uint8Array
  }> = [
    {
      kind: 'NativeExecutable',
      target: Target.aarch64AppleDarwin,
      bytes: machOImage(2),
    },
    {
      kind: 'NativeSharedLibrary',
      target: Target.aarch64AppleDarwin,
      bytes: machOImage(6),
    },
    {
      kind: 'NativeExecutable',
      target: Target.aarch64UnknownLinuxGnu,
      bytes: elfImage(183, 2),
    },
    {
      kind: 'NativeExecutable',
      target: Target.aarch64UnknownLinuxGnu,
      bytes: elfImage(183, 3, true),
    },
    {
      kind: 'NativeSharedLibrary',
      target: Target.aarch64UnknownLinuxGnu,
      bytes: elfImage(183, 3),
    },
    {
      kind: 'NativeExecutable',
      target: Target.x8664UnknownLinuxGnu,
      bytes: elfImage(62, 2),
    },
    {
      kind: 'NativeExecutable',
      target: Target.x8664UnknownLinuxGnu,
      bytes: elfImage(62, 3, true),
    },
    {
      kind: 'NativeSharedLibrary',
      target: Target.x8664UnknownLinuxGnu,
      bytes: elfImage(62, 3),
    },
    ...Target.native.map((target) => ({
      kind: 'NativeStaticLibrary' as const,
      target,
      bytes: staticArchive(nativeObjectFor(target)),
    })),
    {
      kind: 'WebAssemblyModule',
      target: Target.wasm32UnknownUnknown,
      bytes: Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]),
    },
  ]
  const kinds: ReadonlyArray<NativeToolchain.FinalArtifact['kind']> = [
    'NativeExecutable',
    'NativeSharedLibrary',
    'NativeStaticLibrary',
    'WebAssemblyModule',
  ]

  for (const fixture of fixtures) {
    for (const kind of kinds) {
      for (const target of Target.all) {
        assert.strictEqual(
          NativeToolchain.isCachedArtifact(fixture.bytes, kind, target),
          kind === fixture.kind && target.id === fixture.target.id,
          `${fixture.kind}/${fixture.target.id} classified as ${kind}/${target.id}`,
        )
      }
    }
  }

  for (const kind of kinds) {
    for (const target of Target.all) {
      assert.strictEqual(NativeToolchain.isCachedArtifact(new Uint8Array(), kind, target), false)
      assert.strictEqual(
        NativeToolchain.isCachedArtifact(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]), kind, target),
        false,
      )
    }
  }

  const mixedArchive = staticArchive(machOImage(2), elfImage(62, 2))
  assert.strictEqual(
    NativeToolchain.isCachedArtifact(
      mixedArchive,
      'NativeStaticLibrary',
      Target.aarch64AppleDarwin,
    ),
    false,
  )
  assert.strictEqual(
    NativeToolchain.isCachedArtifact(
      mixedArchive,
      'NativeStaticLibrary',
      Target.x8664UnknownLinuxGnu,
    ),
    false,
  )
  assert.strictEqual(
    NativeToolchain.isCachedArtifact(
      malformedExtendedNameArchive(200_000),
      'NativeStaticLibrary',
      Target.x8664UnknownLinuxGnu,
    ),
    false,
  )
})

it.effect('returns validated cached WebAssembly bytes in memory', () =>
  Effect.gen(function* () {
    const target = Target.wasm32UnknownUnknown
    const destination = join(testRoot, 'cached-module.wasm')
    const bytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])
    const committed = yield* NativeToolchain.commitCachedArtifact(
      bytes,
      'WebAssemblyModule',
      target,
      destination,
    )
    assert.deepEqual(committed.bytes, bytes)
    assert.deepEqual(readFileSync(destination), bytes)
  }),
)

it.effect('rejects a missing linker input in the typed link channel', () =>
  Effect.gen(function* () {
    const target = yield* NativeToolchain.hostTarget()
    const result = yield* Effect.result(
      NativeToolchain.withBuildScope('missing-link-input', (scope) =>
        finalize(
          toolchain,
          scope,
          'NativeExecutable',
          target,
          [
            Object.freeze({
              _tag: 'PathArtifact',
              scope: scope.name,
              path: join(scope.root, 'missing.o'),
              target,
            }),
          ],
          [],
          join(testRoot, 'never-written'),
        ),
      ),
    )
    assert.strictEqual(result._tag, 'Failure')
    if (result._tag !== 'Failure') return
    assert.strictEqual(result.failure.reason._tag, 'LinkFailed')
    if (result.failure.reason._tag !== 'LinkFailed') return
    assert.include(result.failure.reason.output, 'missing linker input')
  }),
)

it.effect('rejects missing archive paths and unsupported inputs before spawning', () =>
  Effect.gen(function* () {
    const target = yield* NativeToolchain.hostTarget()
    const missing = join(testRoot, 'missing-library.a')
    const missingResult = yield* Effect.result(
      NativeToolchain.withBuildScope('missing-archive-input', (scope) =>
        finalize(
          toolchain,
          scope,
          'NativeSharedLibrary',
          target,
          [],
          [NativeLinkInput.staticArchive(missing)],
          join(testRoot, 'never-written-shared'),
        ),
      ),
    )
    assert.strictEqual(missingResult._tag, 'Failure')
    if (missingResult._tag === 'Failure') {
      assert.strictEqual(missingResult.failure.reason._tag, 'LinkFailed')
      if (missingResult.failure.reason._tag === 'LinkFailed')
        assert.include(missingResult.failure.reason.output, missing)
    }

    const unsupportedInput = NativeLinkInput.library('answer', 'Dynamic')
    const neverToolchain: NativeToolchain.Toolchain = Object.freeze({
      _tag: 'Toolchain',
      clang: join(testRoot, 'missing-clang'),
      llvmAr: join(testRoot, 'missing-llvm-ar'),
    })
    const unsupportedResult = yield* Effect.result(
      NativeToolchain.withBuildScope('unsupported-archive-input', (scope) =>
        finalize(
          neverToolchain,
          scope,
          'NativeStaticLibrary',
          target,
          [],
          [unsupportedInput],
          join(testRoot, 'never-written-archive'),
        ),
      ),
    )
    assert.strictEqual(unsupportedResult._tag, 'Failure')
    if (unsupportedResult._tag !== 'Failure') return
    assert.strictEqual(unsupportedResult.failure.reason._tag, 'UnsupportedPlan')
    if (unsupportedResult.failure.reason._tag !== 'UnsupportedPlan') return
    assert.strictEqual(unsupportedResult.failure.reason.plan.artifactKind, 'NativeStaticLibrary')
    assert.deepStrictEqual(unsupportedResult.failure.reason.plan.target, target)
    assert.deepStrictEqual(unsupportedResult.failure.reason.plan.input, unsupportedInput)
    assert.strictEqual(unsupportedResult.failure.reason.plan.reason, 'StaticArchiveInput')
  }),
)

it.effect('creates byte-identical deterministic archives from the same object input', () =>
  Effect.gen(function* () {
    const target = yield* NativeToolchain.hostTarget()
    const firstDestination = join(testRoot, 'deterministic-first.a')
    const secondDestination = join(testRoot, 'deterministic-second.a')
    const artifacts = yield* NativeToolchain.withBuildScope('deterministic-archive', (scope) =>
      Effect.gen(function* () {
        const object = yield* NativeToolchain.writeArtifact(
          scope,
          target,
          'fixture.o',
          nativeObjectFor(target),
        )
        const first = yield* finalize(
          toolchain,
          scope,
          'NativeStaticLibrary',
          target,
          [object],
          [],
          firstDestination,
        )
        const second = yield* finalize(
          toolchain,
          scope,
          'NativeStaticLibrary',
          target,
          [object],
          [],
          secondDestination,
        )
        return Object.freeze({ first, second })
      }),
    )
    const { first, second } = artifacts
    assert.deepStrictEqual(first.bytes, second.bytes)
    assert.strictEqual(
      NativeToolchain.isCachedArtifact(first.bytes, 'NativeStaticLibrary', target),
      true,
    )
    assert.deepStrictEqual(first.bytes, readFileSync(firstDestination))
    assert.deepStrictEqual(second.bytes, readFileSync(secondDestination))
  }),
)

it.effect(
  'links the runtime and program while returning executable bytes in memory',
  () =>
    Effect.gen(function* () {
      const target = yield* NativeToolchain.hostTarget()
      const compilation = yield* profileFor(target)
      const artifact = yield* artifactFor(target, 'release')
      const destination = join(testRoot, 'linked-program')
      const linked = yield* NativeToolchain.withBuildScope('link-run', (scope) =>
        Effect.gen(function* () {
          const object = yield* ObjectEmission.materialize({
            toolchain,
            scope,
            artifact,
            profile: compilation,
          })
          const runtime = yield* NativeToolchain.compileRuntime(toolchain, scope, target)
          assert.include(runtime.planned.arguments, 'cpp-output')
          assert.include(runtime.planned.arguments, join(scope.root, 'silk_runtime.i'))
          return yield* finalize(
            toolchain,
            scope,
            'NativeExecutable',
            target,
            [object.artifact, runtime.artifact],
            [],
            destination,
          )
        }),
      )
      assert.isAbove(linked.bytes.length, 0)
      assert.deepEqual(linked.bytes, readFileSync(linked.path))
      const run = spawnSync(linked.path, [], { encoding: 'utf8' })
      assert.strictEqual(run.status, 42)
    }),
  15_000,
)

it.effect(
  'preserves dollar-bearing foreign symbols through objects and a separate C link',
  () =>
    Effect.gen(function* () {
      const target = yield* NativeToolchain.hostTarget()
      const snapshot = yield* AnalysisFixture.declarations(
        'native/dollar-symbols',
        ascii(linkedForeignDollarSource),
        target.id,
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
      assert.deepEqual(
        artifact.foreignImports.map((entry) => entry.symbol),
        ['close$NOCANCEL', 'helper$version'],
      )
      for (const symbol of ['close$NOCANCEL', 'helper$version']) {
        assert.include(artifact.ir, `@${symbol}`)
      }

      const compilation = yield* profileFor(target)
      const destination = join(testRoot, 'linked-dollar-symbols')
      const linked = yield* NativeToolchain.withBuildScope('dollar-symbol-link', (scope) =>
        Effect.gen(function* () {
          const program = yield* ObjectEmission.materialize({
            toolchain,
            scope,
            artifact,
            profile: compilation,
          })
          const definitions = yield* NativeToolchain.compileCObject(
            toolchain,
            scope,
            target,
            'dollar-symbol-definitions',
            linkedForeignDollarCSource,
          )
          const inspect = (object: NativeToolchain.PathArtifact): ObjectSymbols.Inventory => {
            const inventory = ObjectSymbols.inspect(readFileSync(object.path), target)
            if (Result.isFailure(inventory)) return assert.fail(inventory.failure.detail)
            return {
              ...inventory.success,
              symbols: inventory.success.symbols.map((entry) => ({
                ...entry,
                name: HelperCapability.symbolName(target, entry.name),
              })),
              references: inventory.success.references.map((name) =>
                HelperCapability.symbolName(target, name),
              ),
            }
          }
          const programSymbols = inspect(program.artifact)
          const definitionSymbols = inspect(definitions.artifact)
          for (const symbol of ['close$NOCANCEL', 'helper$version']) {
            assert.isTrue(
              programSymbols.symbols.some((entry) => entry.name === symbol && !entry.defined),
              symbol,
            )
            assert.include(programSymbols.references, symbol)
            assert.isTrue(
              definitionSymbols.symbols.some((entry) => entry.name === symbol && entry.defined),
              symbol,
            )
          }
          const runtime = yield* NativeToolchain.compileRuntime(toolchain, scope, target)
          return yield* finalize(
            toolchain,
            scope,
            'NativeExecutable',
            target,
            [program.artifact, runtime.artifact, definitions.artifact],
            [],
            destination,
          )
        }),
      )
      const run = spawnSync(linked.path, [], { encoding: 'utf8' })
      assert.strictEqual(run.status, 42, run.stderr)
    }),
  15_000,
)

it('keeps relocatable form, exact loader symbols and ordered scripts distinct', () => {
  const tools = { clang, llvmAr: 'llvm-ar' }
  const target = Target.x8664UnknownLinuxGnu
  const object = ToolchainPlan.nativeCommand(
    tools,
    'NativeObject',
    target,
    ['/program.o'],
    [{ _tag: 'Object', path: '/support.o' }],
    '/result.o',
  )
  assert.strictEqual(object._tag, 'PlannedCommand')
  if (object._tag === 'PlannedCommand') {
    assert.include(object.arguments, '-r')
    assert.include(object.arguments, '-nostdlib')
    assert.isBelow(object.arguments.indexOf('/program.o'), object.arguments.indexOf('/support.o'))
  }
  const entry = ToolchainPlan.nativeCommand(
    tools,
    'NativeExecutable',
    target,
    ['/program.o'],
    [{ _tag: 'LinkerScript', path: '/layout.ld' }],
    '/program',
    { kind: 'named', name: 'machine_start' },
  )
  assert.strictEqual(entry._tag, 'PlannedCommand')
  if (entry._tag === 'PlannedCommand') {
    assert.include(entry.arguments, '-nostartfiles')
    assert.include(entry.arguments, 'machine_start')
    assert.include(entry.arguments, '/layout.ld')
  }
})

it.effect('selects one provider with artifact pin precedence and no cross-host fallback', () =>
  Effect.gen(function* () {
    const target = Target.aarch64AppleDarwin
    const pin: PlatformSupply.Explicit = {
      kind: 'explicit',
      target: target.id,
      root: '/pinned/sdk',
      linker: '/pinned/ld',
      origin: 'artifact pin',
    }
    const chosen = yield* PlatformSupply.select(
      target,
      Target.x8664UnknownLinuxGnu.id,
      { kind: 'automatic' },
      pin,
      { kind: 'managed', name: 'unused' },
    )
    assert.strictEqual(chosen.origin, 'artifact')
    assert.deepEqual(chosen.request, pin)
    for (const [request, code] of [
      [{ kind: 'automatic' }, 'HostMismatch'],
      [{ kind: 'managed', name: 'deferred' }, 'UnsupportedProvider'],
      [{ ...pin, target: Target.x8664UnknownLinuxGnu.id }, 'TargetMismatch'],
    ] as const) {
      const result = yield* Effect.result(
        PlatformSupply.select(target, Target.x8664UnknownLinuxGnu.id, request),
      )
      assert.strictEqual(result._tag, 'Failure')
      if (result._tag === 'Failure') assert.strictEqual(result.failure.code, code)
    }
    const invalid = yield* Effect.result(
      PlatformSupply.decode(
        { kind: 'explicit', target: target.id, root: '/sdk', linker: '/ld', flags: ['-bad'] },
        'manifest',
      ),
    )
    assert.strictEqual(invalid._tag, 'Failure')
  }),
)

it('preserves GNU input groups and discovers recursive script references without flattening', () => {
  const source =
    '/* contract */ SEARCH_DIR("=/usr/lib") GROUP ( libfirst.a AS_NEEDED ( -lsecond ) ) INCLUDE "layout.ld"\nSECTIONS { .text : { *(.text) } }'
  const parsed = LinkerScript.parse(source)
  assert.strictEqual(parsed._tag, 'Success')
  if (parsed._tag !== 'Success') return
  assert.deepEqual(
    parsed.success.references.map((reference) => [reference.kind, reference.value]),
    [
      ['search', '=/usr/lib'],
      ['input', 'libfirst.a'],
      ['input', '-lsecond'],
      ['include', 'layout.ld'],
    ],
  )
  const rendered = LinkerScript.render(parsed.success, [
    '/sdk/usr/lib',
    '/sdk/first.a',
    '/sdk/second.so',
    '/scope/layout.ld',
  ])
  assert.include(rendered, 'GROUP ( "/sdk/first.a" AS_NEEDED ( "/sdk/second.so" ) )')
  assert.include(rendered, 'SECTIONS { .text : { *(.text) } }')
  assert.strictEqual(LinkerScript.parse('INPUT ( missing.o')._tag, 'Failure')
  assert.strictEqual(LinkerScript.parse('STARTUP(other.o)')._tag, 'Failure')
  assert.strictEqual(LinkerScript.parse('LIB(hidden.a)')._tag, 'Failure')
})

it('distinguishes inline Darwin stub reexports from external and incompatible targets', () => {
  const source = `--- !tapi-tbd
tbd-version: 4
targets: [ arm64-macos ]
install-name: '/usr/lib/root.dylib'
reexported-libraries:
  - targets: [ arm64-macos ]
    libraries: [ '/usr/lib/inline.dylib', '/usr/lib/external.dylib' ]
  - targets: [ x86_64-macos ]
    libraries: [ '/usr/lib/wrong.dylib' ]
--- !tapi-tbd
tbd-version: 4
targets: [ arm64-macos ]
install-name: '/usr/lib/inline.dylib'
...
`
  const parsed = NativeStub.parse(source)
  assert.strictEqual(parsed._tag, 'Success')
  if (parsed._tag !== 'Success') return
  assert.deepEqual(parsed.success.imports, ['/usr/lib/external.dylib'])
  assert.strictEqual(
    NativeStub.parse(source.replaceAll('arm64-macos', 'arm64-ios'))._tag,
    'Failure',
  )
  assert.strictEqual(
    NativeStub.parse(source.replaceAll('tbd-version: 4', 'tbd-version: 5'))._tag,
    'Failure',
  )
})

it('reads driver argv without interpreting shell syntax', () => {
  const parsed = NativeLinkResolver.argumentsOf(
    ' "/path with spaces/ld" "-o" "$(unchanged)" "escaped\\\"quote"',
  )
  assert.strictEqual(parsed._tag, 'Success')
  if (parsed._tag === 'Success')
    assert.deepEqual(parsed.success, [
      '/path with spaces/ld',
      '-o',
      '$(unchanged)',
      'escaped"quote',
    ])
  assert.strictEqual(NativeLinkResolver.argumentsOf('"unfinished')._tag, 'Failure')
})

it.effect(
  'accounts for selected bytes and input ordering while ignoring non-emitted path relocation',
  () =>
    Effect.gen(function* () {
      const target = yield* NativeToolchain.hostTarget()
      const profile = yield* profileFor(target)
      const selected = yield* NativeToolchain.resolveToolchain(toolchain, profile)
      // A passed supply, not a stale tool spelling, selects the tools that run.
      const reselected = yield* NativeToolchain.resolveToolchain(
        { ...selected, clang: 'unvalidated-clang', llvmAr: 'unvalidated-llvm-ar' },
        profile,
      )
      assert.strictEqual(reselected.clang, selected.supply?.compiler.command)
      assert.strictEqual(reselected.llvmAr, selected.supply?.archiver.command)
      yield* NativeToolchain.withBuildScope(
        'supply-identities',
        Effect.fnUntraced(function* (scope) {
          const a = yield* NativeToolchain.writeArtifact(
            scope,
            target,
            'a.o',
            nativeObjectFor(target),
          )
          const b = yield* NativeToolchain.writeArtifact(
            scope,
            target,
            'b.o',
            new Uint8Array([...nativeObjectFor(target), 1]),
          )
          mkdirSync(join(scope.root, 'relocated'))
          const relocated = yield* NativeToolchain.writeArtifact(
            scope,
            target,
            'relocated/a.o',
            nativeObjectFor(target),
          )
          const entry = {
            request: { kind: 'default' },
            composition: { kind: 'default' },
            resolved: { kind: 'default' },
          } as const
          const plan = Effect.fnUntraced(function* (
            objects: ReadonlyArray<NativeToolchain.PathArtifact>,
            name = 'output.a',
            helpers: ReadonlyArray<HelperCapability.Report> = [],
          ) {
            return yield* NativeToolchain.planNativeLink(
              selected,
              scope,
              'NativeStaticLibrary',
              profile,
              objects,
              [],
              join(scope.root, name),
              entry,
              helpers,
            )
          })
          const first = yield* plan([a, b])
          const moved = yield* plan([relocated, b], 'relocated.a')
          const swapped = yield* plan([b, a])
          assert.strictEqual(first.identity, moved.identity)
          assert.notStrictEqual(first.identity, swapped.identity)
          const helperInventory: ObjectSymbols.Inventory = {
            format: target.operatingSystem === 'darwin' ? 'macho' : 'elf',
            symbols: [
              {
                name: target.operatingSystem === 'darwin' ? '_memcpy' : 'memcpy',
                defined: false,
                weak: false,
                visibility: 'default',
              },
            ],
            references: [],
          }
          const origins = { foreignImports: [], foreignStatics: [], nativeRuntimeSymbols: [] }
          const hostedHelper = yield* HelperCapability.reconcile(
            helperInventory,
            origins,
            profile,
            a.path,
            'same-object',
          )
          const bareProfile = yield* CompilationProfile.normalize({
            target: target.id,
            artifact: 'object',
            libc: 'none',
          })
          const bareHelper = yield* HelperCapability.reconcile(
            helperInventory,
            origins,
            bareProfile,
            a.path,
            'same-object',
          )
          assert.notStrictEqual(hostedHelper.identity, bareHelper.identity)
          const hostedPlan = yield* plan([a, b], 'hosted.a', [hostedHelper])
          const barePlan = yield* plan([a, b], 'bare.a', [bareHelper])
          assert.notDeepEqual(
            NativeToolchain.finalArtifactCacheAdmission('NativeStaticLibrary', hostedPlan),
            NativeToolchain.finalArtifactCacheAdmission('NativeStaticLibrary', barePlan),
          )
          const wrongTarget =
            target.operatingSystem === 'darwin'
              ? Target.x8664UnknownLinuxGnu
              : Target.aarch64AppleDarwin
          const wrongObject = yield* NativeToolchain.writeArtifact(
            scope,
            target,
            'wrong.o',
            nativeObjectFor(wrongTarget),
          )
          const incompatible = yield* Effect.result(plan([wrongObject]))
          assert.strictEqual(incompatible._tag, 'Failure')
          if (incompatible._tag === 'Failure') {
            assert.strictEqual(incompatible.failure.reason._tag, 'SupplyFailed')
            if (incompatible.failure.reason._tag === 'SupplyFailed')
              assert.strictEqual(incompatible.failure.reason.failure.code, 'TargetMismatch')
          }

          assert.deepEqual(
            NativeToolchain.finalArtifactCacheAdmission('NativeStaticLibrary', first),
            { _tag: 'CompleteNativePlan', identity: first.identity },
          )
          const changed = new Uint8Array([...nativeObjectFor(target), 2])
          writeFileSync(a.path, changed)
          const stale = yield* Effect.result(
            PlatformSupplyResolver.validateFiles(first.inputs).pipe(
              Effect.provide(NodeServices.layer),
            ),
          )
          assert.strictEqual(stale._tag, 'Failure')
          if (stale._tag === 'Failure') assert.strictEqual(stale.failure.code, 'ChangedInput')
          assert.notStrictEqual(first.identity, (yield* plan([a, b])).identity)
        }),
      )
    }),
)

it('freezes only admitted discovery environment channels', () => {
  const environment = {
    PATH: '/selected/tools',
    SDKROOT: '/selected/sdk',
    CPATH: '/unrecorded/include',
  }
  const resolver = PlatformSupplyResolver.make(environment)
  environment.SDKROOT = '/changed/sdk'
  assert.deepEqual(resolver.environment, { PATH: '/selected/tools', SDKROOT: '/selected/sdk' })
})

it.effect(
  'validates explicit Darwin SDK architecture, deployment and libSystem independently',
  () =>
    Effect.gen(function* () {
      const target = Target.aarch64AppleDarwin
      const profile = yield* profileFor(target)
      const sdk = join(testRoot, 'sdk-capabilities')
      mkdirSync(join(sdk, 'usr/lib'), { recursive: true })
      const metadata = join(sdk, 'SDKSettings.json')
      const system = join(sdk, 'usr/lib/libSystem.tbd')
      const settings = {
        Version: '15.5',
        SupportedTargets: { macosx: { Archs: ['arm64'], MaximumDeploymentTarget: '15.5.99' } },
      }
      writeFileSync(
        metadata,
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(settings).pipe(
          Effect.orDie,
        ),
      )
      writeFileSync(
        system,
        "--- !tapi-tbd\ntbd-version: 4\ntargets: [ arm64-macos ]\ninstall-name: '/usr/lib/libSystem.B.dylib'\n",
      )
      const resolver = PlatformSupplyResolver.make({
        PATH: testPath,
        SDKROOT: '/must-not-be-selected',
      })
      const resolve = Effect.fnUntraced(function* (deployment?: string) {
        return yield* PlatformSupplyResolver.resolveSupply(resolver, {
          profile: { ...profile, deployment },
          host: Target.x8664UnknownLinuxGnu.id,
          clang,
          llvmAr: toolchain.llvmAr,
          request: {
            kind: 'explicit',
            target: target.id,
            root: sdk,
            linker: clang,
            origin: 'explicit SDK fixture',
          },
        }).pipe(Effect.provide(NodeServices.layer))
      })
      const selected = yield* resolve()
      assert.strictEqual(selected.version, '15.5')
      assert.isUndefined(selected.consultedEnvironment['SDKROOT'])
      const deployment = yield* Effect.result(resolve('16.0.0'))
      assert.strictEqual(deployment._tag, 'Failure')
      if (deployment._tag === 'Failure')
        assert.strictEqual(deployment.failure.code, 'DeploymentMismatch')
      writeFileSync(
        metadata,
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          ...settings,
          SupportedTargets: { macosx: { Archs: ['x86_64'] } },
        }).pipe(Effect.orDie),
      )
      const architecture = yield* Effect.result(resolve())
      assert.strictEqual(architecture._tag, 'Failure')
      if (architecture._tag === 'Failure')
        assert.strictEqual(architecture.failure.code, 'TargetMismatch')
      writeFileSync(
        metadata,
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(settings).pipe(
          Effect.orDie,
        ),
      )
      writeFileSync(system, 'wrong libSystem contract')
      const library = yield* Effect.result(resolve())
      assert.strictEqual(library._tag, 'Failure')
      if (library._tag === 'Failure') {
        assert.strictEqual(library.failure.code, 'TargetMismatch')
        assert.strictEqual(library.failure.origin, 'SDK libSystem contract')
      }
      rmSync(system)
      const missing = yield* Effect.result(resolve())
      assert.strictEqual(missing._tag, 'Failure')
      if (missing._tag === 'Failure') assert.include(missing.failure.subject, 'libSystem.tbd')
    }),
)

it.effect('keys C objects by consumed headers and freezes preprocessing for inspection', () =>
  Effect.gen(function* () {
    const target = yield* NativeToolchain.hostTarget()
    const profile = yield* profileFor(target)
    const cache = NativeToolchain.makeRuntimeObjectCache()
    const selected = yield* NativeToolchain.resolveToolchain(
      { ...toolchain, runtimeObjectCache: cache },
      profile,
    )
    yield* NativeToolchain.withBuildScope(
      'header-identities',
      Effect.fnUntraced(function* (scope) {
        const header = join(scope.root, 'selected.h')
        writeFileSync(header, '#define VALUE 42\n')
        const source = '#include "selected.h"\nint value(void) { return VALUE; }'
        const first = yield* NativeToolchain.compileCObject(
          selected,
          scope,
          target,
          'consumer',
          source,
        )
        writeFileSync(join(scope.root, 'unused.h'), '#define UNUSED 9\n')
        const same = yield* NativeToolchain.compileCObject(
          selected,
          scope,
          target,
          'consumer',
          source,
        )
        writeFileSync(header, '#define VALUE 43\n')
        const changed = yield* NativeToolchain.compileCObject(
          selected,
          scope,
          target,
          'consumer',
          source,
        )
        assert.isDefined(first.artifact.translation)
        assert.strictEqual(
          first.artifact.translation?.identity,
          same.artifact.translation?.identity,
        )
        assert.notStrictEqual(
          first.artifact.translation?.identity,
          changed.artifact.translation?.identity,
        )
        assert.include(first.artifact.translation?.source ?? '', 'return 42')
        assert.include(changed.artifact.translation?.source ?? '', 'return 43')
        assert.deepEqual(NativeToolchain.runtimeObjectCacheStats(cache), {
          entries: 2,
          hits: 1,
          misses: 2,
        })
        assert.isTrue(
          first.artifact.translation?.headers.every((input) => !input.path.endsWith('unused.h')),
        )
      }),
    )
  }),
)

it.effect(
  'compiles Wasm C under a host supply and rejects a supply for another native target',
  () =>
    Effect.gen(function* () {
      const host = yield* NativeToolchain.hostTarget()
      const other = Target.native.find((target) => target.id !== host.id) ?? unreachable()
      const cache = NativeToolchain.makeRuntimeObjectCache()
      const selected = yield* NativeToolchain.resolveToolchain(
        { ...toolchain, runtimeObjectCache: cache },
        yield* profileFor(host),
      )
      yield* NativeToolchain.withBuildScope(
        'wasm-c-under-host-supply',
        Effect.fnUntraced(function* (scope) {
          const wasm = Target.wasm32UnknownUnknown
          const runtime = yield* NativeToolchain.compileCObject(
            selected,
            scope,
            wasm,
            'wasm_runtime',
            LlvmWasmRuntime.source,
          )
          assert.isUndefined(runtime.artifact.translation)
          // The host supply takes no part in the Wasm object's identity: the same Clang reuses it.
          yield* NativeToolchain.compileCObject(
            {
              _tag: 'Toolchain',
              clang: selected.clang,
              llvmAr: selected.llvmAr,
              runtimeObjectCache: cache,
            },
            scope,
            wasm,
            'wasm_runtime',
            LlvmWasmRuntime.source,
          )
          assert.deepEqual(NativeToolchain.runtimeObjectCacheStats(cache), {
            entries: 1,
            hits: 1,
            misses: 1,
          })
          const mismatch = yield* Effect.result(
            NativeToolchain.compileCObject(selected, scope, other, 'other', 'int value(void);'),
          )
          assert.strictEqual(mismatch._tag, 'Failure')
          if (mismatch._tag !== 'Failure') return
          assert.strictEqual(mismatch.failure.reason._tag, 'SupplyFailed')
          if (mismatch.failure.reason._tag !== 'SupplyFailed') return
          assert.strictEqual(mismatch.failure.reason.failure.code, 'TargetMismatch')
        }),
      )
    }),
)

it.effect(
  'resolves foreign absolute symlinks inside the sysroot and rejects retargeted snapshots',
  () =>
    Effect.gen(function* () {
      const root = join(testRoot, 'symlink-root')
      mkdirSync(join(root, 'usr/lib'), { recursive: true })
      writeFileSync(join(root, 'usr/lib/first'), 'same bytes')
      writeFileSync(join(root, 'usr/lib/second'), 'same bytes')
      symlinkSync('/usr/lib', join(root, 'lib'))
      symlinkSync('first', join(root, 'usr/lib/selected'))
      const selected = yield* PlatformSupplyResolver.file(
        join(root, 'lib/selected'),
        'library',
        'sysroot fixture',
        root,
      )
      assert.strictEqual(
        selected.path,
        yield* PlatformSupplyResolver.physicalPath(join(root, 'usr/lib/first')),
      )
      rmSync(join(root, 'usr/lib/selected'))
      symlinkSync('second', join(root, 'usr/lib/selected'))
      const changed = yield* Effect.result(PlatformSupplyResolver.validateFiles([selected]))
      assert.strictEqual(changed._tag, 'Failure')
      if (changed._tag === 'Failure') assert.strictEqual(changed.failure.code, 'ChangedInput')
      // A settled file's digest is reused while its stat identity holds, even across an
      // identity-preserving rewrite, and is re-read once the identity changes.
      const settled = join(root, 'usr/lib/settled')
      writeFileSync(settled, 'old bytes')
      utimesSync(settled, 0, 0)
      const snapshot = yield* PlatformSupplyResolver.file(settled, 'library', 'settled', root)
      writeFileSync(settled, 'new bytes')
      utimesSync(settled, 0, 0)
      yield* PlatformSupplyResolver.validateFiles([snapshot])
      writeFileSync(settled, 'new bytes')
      const rewritten = yield* Effect.result(PlatformSupplyResolver.validateFiles([snapshot]))
      assert.strictEqual(rewritten._tag, 'Failure')
      if (rewritten._tag === 'Failure') assert.strictEqual(rewritten.failure.code, 'ChangedInput')
      // Settledness follows the host clock that stamps mtime, not the fiber Clock: a file modified
      // in the host's future is never memoized, however far the TestClock runs ahead.
      const future = join(root, 'usr/lib/future')
      const hostNow = yield* TestClock.withLive(Clock.currentTimeMillis)
      const futureSeconds = hostNow / 1000 + 60
      writeFileSync(future, 'old bytes')
      utimesSync(future, futureSeconds, futureSeconds)
      yield* TestClock.setTime(hostNow + 120_000)
      const pending = yield* PlatformSupplyResolver.file(future, 'library', 'future', root)
      writeFileSync(future, 'new bytes')
      utimesSync(future, futureSeconds, futureSeconds)
      const unsettled = yield* Effect.result(PlatformSupplyResolver.validateFiles([pending]))
      assert.strictEqual(unsettled._tag, 'Failure')
      if (unsettled._tag === 'Failure') assert.strictEqual(unsettled.failure.code, 'ChangedInput')
      symlinkSync('loop', join(root, 'usr/lib/loop'))
      const cycle = yield* Effect.result(
        PlatformSupplyResolver.physicalPath(join(root, 'lib/loop'), root),
      )
      assert.strictEqual(cycle._tag, 'Failure')
      if (cycle._tag === 'Failure') assert.strictEqual(cycle.failure.code, 'UnsupportedInput')
    }).pipe(Effect.provide(NodeServices.layer)),
)

it.effect(
  'reads symbols and relocations from pinned native and Wasm objects and rejects truncated tables',
  () =>
    Effect.gen(function* () {
      const fixture = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            objects: Schema.Record(Schema.String, Schema.String),
            cycles: Schema.Record(Schema.String, Schema.String),
          }),
        ),
      )(readFileSync(new URL('./fixtures/helper-object-symbols.json', import.meta.url), 'utf8'))
      for (const target of [...Target.native, Target.wasm32UnknownUnknown]) {
        const encoded = fixture.objects[target.id]
        assert.isDefined(encoded)
        if (encoded === undefined) return assert.fail('Missing object fixture')
        const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'))
        const inventory = ObjectSymbols.inspect(bytes, target)
        if (Result.isFailure(inventory)) return assert.fail(inventory.failure.detail)
        const normalized = inventory.success.symbols.map((entry) => ({
          ...entry,
          name: HelperCapability.symbolName(target, entry.name),
        }))
        assert.deepEqual(
          normalized.find((entry) => entry.name === 'helper_entry'),
          {
            name: 'helper_entry',
            defined: true,
            weak: false,
            visibility: 'hidden',
          },
        )
        assert.isTrue(
          normalized.some((entry) => entry.name === 'weak_entry' && entry.defined && entry.weak),
        )
        assert.deepEqual(
          normalized
            .filter((entry) => !entry.defined && !entry.name.startsWith('__'))
            .map((entry) => entry.name)
            .sort(),
          ['foreign_data', 'foreign_value'],
        )
        assert.deepEqual(
          inventory.success.references
            .map((name) => HelperCapability.symbolName(target, name))
            .filter((name) => !name.startsWith('__')),
          ['foreign_data', 'foreign_value'],
        )
        const cycleBytes = fixture.cycles[target.id]
        if (cycleBytes === undefined) return assert.fail('Missing cycle object fixture')
        const cycle = ObjectSymbols.inspect(
          Uint8Array.from(Buffer.from(cycleBytes, 'base64')),
          target,
        )
        if (Result.isFailure(cycle)) return assert.fail(cycle.failure.detail)
        const profile = yield* CompilationProfile.normalize({
          target: target.id,
          libc: 'none',
          artifact: 'object',
          entry: { kind: 'none' },
          runtime: { kind: 'none' },
        })
        const provider = yield* HelperCapability.provider('memcpy', profile)
        const verified = yield* Effect.result(
          HelperCapability.verifyProviders([provider], cycle.success, target),
        )
        if (Result.isSuccess(verified))
          return assert.fail('Emitted self-reference escaped verification')
        assert.strictEqual(verified.failure.code, 'ProviderCycle')
        for (const length of [0, 7, 24, bytes.length - 1])
          assert.isTrue(Result.isFailure(ObjectSymbols.inspect(bytes.subarray(0, length), target)))
      }
    }),
)

it.effect('keys a reusable helper object by every input that shapes it, and only those', () =>
  Effect.gen(function* () {
    const profile = yield* CompilationProfile.normalize({
      target: 'x86_64-unknown-linux-gnu',
      libc: 'none',
    })
    const arm = yield* CompilationProfile.normalize({ target: 'aarch64-unknown-linux-gnu' })
    const memcpy = yield* HelperCapability.provider('memcpy', profile)
    const memset = yield* HelperCapability.provider('memset', profile)
    const compiler = { digest: 'clang-digest', version: 'clang version 22.1.8' }
    const key = (
      facts: CompilationProfile.Facts,
      overrides: {
        readonly distribution?: string
        readonly backend?: string
        readonly providers?: ReadonlyArray<HelperCapability.Provider>
        readonly compiler?: typeof compiler
      } = {},
    ) =>
      NativeToolchain.helperCacheKey(
        overrides.distribution ?? 'distribution',
        overrides.backend ?? 'llvm',
        overrides.providers ?? [memcpy, memset],
        facts,
        overrides.compiler ?? compiler,
      )
    const base = key(profile)
    // Provider order and program-only facts do not split the cache across programs. Helpers are
    // always optimized, so the program's optimization is one of those facts.
    assert.strictEqual(key(profile, { providers: [memset, memcpy] }), base)
    assert.strictEqual(key({ ...profile, safety: 'unchecked', artifact: 'loadable-module' }), base)
    assert.strictEqual(
      key({ ...profile, optimization: profile.optimization === 'none' ? 'speed' : 'none' }),
      base,
    )
    const variants = [
      key(profile, { providers: [memcpy] }),
      key(profile, { distribution: 'other-distribution' }),
      key(profile, { backend: 'other-backend' }),
      key({ ...profile, target: arm.target }),
      key({ ...profile, cpu: { ...profile.cpu, model: 'x86-64-v3' } }),
      key({ ...profile, cpu: { ...profile.cpu, features: ['+avx2'] } }),
      key({ ...profile, deployment: '12.0.0' }),
      key({ ...profile, relocation: profile.relocation === 'pic' ? 'static' : 'pic' }),
      key({ ...profile, codeModel: profile.codeModel === 'small' ? 'large' : 'small' }),
      key({ ...profile, debug: !profile.debug }),
      key(profile, { compiler: { ...compiler, digest: 'other-clang-digest' } }),
      key(profile, { compiler: { ...compiler, version: 'clang version 22.1.9' } }),
    ]
    assert.strictEqual(new Set([base, ...variants]).size, variants.length + 1)
  }),
)

it.effect(
  'leaves hosted helpers to libc and realizes no-libc helpers optimized once for any program mode',
  () =>
    Effect.gen(function* () {
      const target = yield* NativeToolchain.hostTarget()
      const hosted = yield* profileFor(target, 'debug')
      const selected = yield* NativeToolchain.resolveToolchain(toolchain, hosted)
      const entries = new Map<string, Uint8Array>()
      const store: Storage.Service = Storage.Storage.of({
        read: (address) =>
          Effect.sync(() => {
            const found = entries.get(address.key)
            return found === undefined ? Option.none() : Option.some(found)
          }),
        publish: (address, bytes) =>
          Effect.sync(() => {
            entries.set(address.key, Uint8Array.from(bytes))
          }),
      })
      const cache: NativeToolchain.HelperCache = {
        _tag: 'ReadWrite',
        store,
        distribution: 'distribution',
      }
      const symbols = ['memcpy', 'memset'].map((name) => ({
        name: target.operatingSystem === 'darwin' ? `_${name}` : name,
        defined: false,
        weak: false,
        visibility: 'default' as const,
      }))
      const report = (profile: CompilationProfile.Facts) =>
        HelperCapability.reconcile(
          {
            format: target.operatingSystem === 'darwin' ? 'macho' : 'elf',
            symbols,
            references: [],
          },
          { foreignImports: [], foreignStatics: [], nativeRuntimeSymbols: [] },
          profile,
          'program.o',
          'program-digest',
        )
      yield* NativeToolchain.withBuildScope(
        'helper-realization',
        Effect.fnUntraced(function* (scope) {
          const hostedReport = yield* report(hosted)
          assert.deepEqual(
            hostedReport.requirements.map((entry) => entry.provider.kind),
            ['platform', 'platform'],
          )
          assert.isUndefined(
            yield* NativeToolchain.compileHelpers(selected, scope, hosted, hostedReport, cache),
          )
          const realized: Array<NativeToolchain.HelperObject> = []
          for (const optimization of ['none', 'speed'] as const) {
            const profile = yield* CompilationProfile.normalize({
              target: target.id,
              libc: 'none',
              artifact: 'object',
              entry: { kind: 'none' },
              runtime: { kind: 'none' },
              optimization,
            })
            const helpers = yield* report(profile)
            const compiled = yield* NativeToolchain.compileHelpers(
              selected,
              scope,
              profile,
              helpers,
              cache,
            )
            if (compiled === undefined) return assert.fail('expected a source helper object')
            realized.push(compiled)
          }
          const [debugProgram, releaseProgram] = realized
          if (debugProgram === undefined || releaseProgram === undefined)
            return assert.fail('expected both helper realizations')
          // A debug program still realizes optimized helpers, which a release program then reuses.
          assert.isFalse(debugProgram.reused)
          assert.include(debugProgram.object.planned.arguments, '-O2')
          assert.notInclude(debugProgram.object.planned.arguments, '-O0')
          assert.isTrue(releaseProgram.reused)
        }),
      )
    }),
)

it.effect(
  'executes the no-libc source memory providers across lengths, offsets and overlap',
  () =>
    Effect.gen(function* () {
      const target = yield* NativeToolchain.hostTarget()
      const selected = yield* NativeToolchain.resolveToolchain(toolchain, yield* profileFor(target))
      const profile = yield* CompilationProfile.normalize({
        target: target.id,
        libc: 'none',
        artifact: 'object',
        entry: { kind: 'none' },
        runtime: { kind: 'none' },
      })
      const darwin = target.operatingSystem === 'darwin'
      const symbols = ['memcpy', 'memmove', 'memset', 'memcmp', darwin ? 'bzero' : 'bcmp'].map(
        (name) => ({
          name: darwin ? `_${name}` : name,
          defined: false,
          weak: false,
          visibility: 'default' as const,
        }),
      )
      const report = yield* HelperCapability.reconcile(
        { format: darwin ? 'macho' : 'elf', symbols, references: [] },
        { foreignImports: [], foreignStatics: [], nativeRuntimeSymbols: [] },
        profile,
        'program.o',
        'program-digest',
      )
      const linked = yield* NativeToolchain.withBuildScope(
        'source-memory-execution',
        Effect.fnUntraced(function* (scope) {
          const helpers = yield* NativeToolchain.compileHelpers(selected, scope, profile, report, {
            _tag: 'Disabled',
          })
          if (helpers === undefined) return assert.fail('expected a source helper object')
          // The helper object's definitions take precedence over libc for the receiver's calls.
          const receiver = yield* NativeToolchain.compileCObject(
            selected,
            scope,
            target,
            'source-memory-receiver',
            readFileSync(new URL('./fixtures/source-memory-helpers.c', import.meta.url), 'utf8'),
          )
          return yield* finalize(
            selected,
            scope,
            'NativeExecutable',
            target,
            [receiver.artifact, helpers.object.artifact],
            [],
            join(testRoot, 'source-memory-helpers'),
          )
        }),
      )
      const run = spawnSync(linked.path, [], { encoding: 'utf8' })
      assert.strictEqual(run.status, 42, run.stderr)
    }),
  30_000,
)

it.effect(
  'accounts emitted helper ABIs separately from source foreign calls and runtime contracts',
  () =>
    Effect.gen(function* () {
      const profile = yield* CompilationProfile.normalize({ target: 'x86_64-unknown-linux-gnu' })
      const foreign: Backend.ForeignImport = {
        symbol: 'foreign_read',
        parameters: [],
        result: 'i32',
        variadic: false,
        contract: ForeignContract.conservative,
      }
      const input = {
        foreignImports: [foreign],
        foreignStatics: [],
        nativeRuntimeSymbols: ['malloc', 'calloc'],
      }
      const symbols = ['memcpy', 'fmodf', 'malloc', 'calloc', 'foreign_read'].map((name) => ({
        name,
        defined: false,
        weak: false,
        visibility: 'default' as const,
      }))
      const report = yield* HelperCapability.reconcile(
        { format: 'elf', symbols, references: symbols.map((entry) => entry.name) },
        input,
        profile,
        'program.o',
        'object-digest',
      )
      assert.deepEqual(
        report.requirements.map((entry) => [
          entry.contract.symbol,
          entry.contract.parameters,
          entry.contract.result,
        ]),
        [
          ['fmodf', ['f32', 'f32'], 'f32'],
          ['memcpy', ['pointer', 'pointer', 'u64'], 'pointer'],
        ],
      )
      // Hosted libc supplies both families; only libm is an added link input.
      assert.deepEqual(
        report.requirements.map((entry) => [
          entry.provider.kind,
          entry.provider.root,
          entry.contract.retention,
        ]),
        [
          ['platform', 'm', 'platform-symbol'],
          ['platform', 'c', 'platform-symbol'],
        ],
      )
      assert.deepEqual(report.runtime, ['calloc', 'malloc'])
      assert.deepEqual(report.foreign, ['foreign_read'])
      assert.deepEqual(HelperCapability.linkInputs([report]), [
        NativeLinkInput.library('m', 'Dynamic'),
      ])
      const empty = yield* HelperCapability.reconcile(
        { format: 'elf', symbols: [], references: [] },
        input,
        profile,
        'empty.o',
        'empty-digest',
      )
      assert.deepEqual(HelperCapability.linkInputs([empty]), [])
      assert.notStrictEqual(report.identity, empty.identity)
      for (const [symbol, code] of [
        ['unknown_helper', 'UnexplainedSymbol'],
        ['calloc', 'UnexplainedSymbol'],
        ['__atomic_load_16', 'UnsupportedFamily'],
        ['__stack_chk_fail', 'UnsupportedFamily'],
        ['__divti3', 'UnsupportedFamily'],
        ['__rust_probestack', 'UnsupportedFamily'],
        ['__asan_report_load8', 'UnsupportedFamily'],
        ['_Unwind_Resume', 'UnsupportedFamily'],
      ]) {
        const result = yield* Effect.result(HelperCapability.provider(symbol ?? '', profile))
        if (Result.isSuccess(result)) return assert.fail('Unexpected helper provider')
        assert.strictEqual(result.failure.code, code)
      }
      const noLibc = yield* CompilationProfile.normalize({
        target: profile.target.id,
        libc: 'none',
        artifact: 'object',
        entry: { kind: 'none' },
        runtime: { kind: 'none' },
      })
      const absent = yield* Effect.result(HelperCapability.provider('fmod', noLibc))
      if (Result.isSuccess(absent)) return assert.fail('Unexpected no-libc arithmetic provider')
      assert.strictEqual(absent.failure.code, 'MissingProvider')
      const source = yield* HelperCapability.provider('memcpy', noLibc)
      assert.deepEqual([source.kind, source.root], ['source', 'silk.support.memcpy'])
    }),
)

it.effect(
  'rejects direct and transitive provider cycles, incompatible targets and emitted self dependencies',
  () =>
    Effect.gen(function* () {
      const profile = yield* CompilationProfile.normalize({
        target: 'aarch64-apple-darwin',
        libc: 'none',
        artifact: 'object',
        entry: { kind: 'none' },
        runtime: { kind: 'none' },
      })
      const copy = yield* HelperCapability.provider('memcpy', profile)
      const move = yield* HelperCapability.provider('memmove', profile)
      const abi = yield* Effect.result(
        HelperCapability.verifyExports(
          [copy],
          [
            {
              symbol: 'memcpy',
              parameters: [],
              result: 'i32',
              variadic: false,
              contract: ForeignContract.conservative,
            },
          ],
          profile,
        ),
      )
      if (Result.isSuccess(abi)) return assert.fail('Mismatched C helper signature was admitted')
      assert.strictEqual(abi.failure.code, 'IncompatibleProvider')

      for (const [providers, code] of [
        [[{ ...copy, requires: ['memcpy'] }], 'ProviderCycle'],
        [
          [
            { ...copy, requires: ['memmove'] },
            { ...move, requires: ['memcpy'] },
          ],
          'ProviderCycle',
        ],
        [[{ ...copy, requires: ['missing'] }], 'MissingProvider'],
        [[{ ...copy, targets: [] }], 'IncompatibleProvider'],
      ] as const) {
        const outcome = yield* Effect.result(
          HelperCapability.closure(['memcpy'], providers, profile.target),
        )
        if (Result.isSuccess(outcome)) return assert.fail('Unexpected valid provider graph')
        assert.strictEqual(outcome.failure.code, code)
      }
      const outcome = yield* Effect.result(
        HelperCapability.verifyProviders(
          [copy],
          {
            format: 'macho',
            symbols: [{ name: '_memcpy', defined: true, weak: false, visibility: 'default' }],
            references: ['_memcpy'],
          },
          profile.target,
        ),
      )
      if (Result.isSuccess(outcome)) return assert.fail('Unexpected self-reference admission')
      assert.strictEqual(outcome.failure.code, 'ProviderCycle')
      assert.deepEqual(outcome.failure.origins, [copy.id, 'memcpy', copy.id])
    }),
)
