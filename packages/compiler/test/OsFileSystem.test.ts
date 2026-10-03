import * as Layer from 'effect/Layer'
import * as NativeToolchain from '../src/NativeToolchain.js'
import * as TestToolchain from './support/TestToolchain.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Json from './support/Json.js'
import * as Analysis from '../src/Analysis.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Target from '../src/Target.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Driver from './support/TestDriver.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const trustDefinitions = (root: string): string => `fn trustLimits() -> TrustLoadLimits {
  let mut limits = TrustLoadLimits.defaults()
  limits.decode.inputBytes = usize.add(0, 1206)
  return limits
}
fn trustFailure(error: TrustSourceError) -> i32 {
  return match move error {
    TrustSourceError.File { operation, error: file } => {
      if operation != TrustFileOperation.Open { return 90 }
      return 10 + FileSystem.reasonCode(move file.reason)
    }
    TrustSourceError.InvalidConfiguration { reason } => 91
    TrustSourceError.LimitExceeded { kind, limit } => 92
    TrustSourceError.Decode { error: decode } => 93
  }
}
effect fn loadTrust(source: &mut NativeFileTrustSource) -> TrustSnapshot
! TrustSourceError | OutOfMemoryError
? &mut Allocator {
  return run TrustSource.load(trustLimits())
    |> Effect.provideMut<TrustSource>(move source)
}
effect fn trustAt(pathBytes: &[u8]) -> i32
! FileError | TrustSourceError | OutOfMemoryError
? &mut Allocator {
  let path = run Path.fromBytes(pathBytes)
  let mut source = run NativeFileTrustSource.make(b"${root}", &path)
  let loaded: Result<TrustSnapshot, TrustSourceError | OutOfMemoryError> = run Effect.result(
    loadTrust(&mut source),
  )
  drop source
  return match move loaded {
    Result<TrustSnapshot, TrustSourceError | OutOfMemoryError>.Success { value } => {
      return usize.toI32(TrustSnapshot.anchors(&value).length)
    }
    Result<TrustSnapshot, TrustSourceError | OutOfMemoryError>.Failure { error: failure } => match move failure {
      TrustSourceError trust => trustFailure(move trust)
      OutOfMemoryError memory => { fail move memory }
    }
  }
}
effect fn checkedTrustAt(pathBytes: &[u8]) -> i32 ! FileError | OutOfMemoryError
? &mut Allocator {
  let observed: Result<i32, FileError | TrustSourceError | OutOfMemoryError> = run Effect.result(
    trustAt(pathBytes),
  )
  return match move observed {
    Result<i32, FileError | TrustSourceError | OutOfMemoryError>.Success { value } => value
    Result<i32, FileError | TrustSourceError | OutOfMemoryError>.Failure { error: failure } => match move failure {
      FileError file => { fail move file }
      TrustSourceError trust => trustFailure(move trust)
      OutOfMemoryError memory => { fail move memory }
    }
  }
}
effect fn ownedTrust() -> i32 ! FileError | TrustSourceError | OutOfMemoryError
? &mut Allocator {
  let mut root = run Bytes.copy(b"${root}")
  let path = run Path.fromBytes(b"/trust.pem")
  let mut source = run NativeFileTrustSource.make(Bytes.asSlice(&root), &path)
  let mut callerRoot = Bytes.asMutSlice(&mut root)
  callerRoot[usize.ONE] = u8.toU8(120)
  drop callerRoot
  drop root
  drop path
  let snapshot = run loadTrust(&mut source)
  drop source
  return usize.toI32(TrustSnapshot.anchors(&snapshot).length)
}`

const nativeRoot = mkdtempSync(join(tmpdir(), 'silk-os-filesystem-'))
const outsideRoot = mkdtempSync(join(tmpdir(), 'silk-os-filesystem-outside-'))
const destinationRoot = mkdtempSync(join(tmpdir(), 'silk-os-filesystem-artifacts-'))
const outsideMarker = join(outsideRoot, 'marker')
writeFileSync(outsideMarker, 'untouched')
mkdirSync(join(nativeRoot, 'nested'))
symlinkSync(outsideRoot, join(nativeRoot, 'escape'))
const trustPem = readFileSync(
  new URL('../conformance/native-filesystem/trust.pem', import.meta.url),
)
const trustPath = join(nativeRoot, 'trust.pem')
const trustReplacement = join(nativeRoot, 'trust-replacement.pem')
const deniedTrustPath = join(nativeRoot, 'trust-denied.pem')
writeFileSync(trustPath, trustPem)
writeFileSync(trustReplacement, Buffer.concat([trustPem, trustPem]))
writeFileSync(deniedTrustPath, trustPem)
chmodSync(deniedTrustPath, 0o000)
mkdirSync(join(nativeRoot, 'trust-directory'))
symlinkSync(trustPath, join(nativeRoot, 'trust-link.pem'))
afterAll(() => {
  rmSync(nativeRoot, { recursive: true, force: true })
  rmSync(outsideRoot, { recursive: true, force: true })
  rmSync(destinationRoot, { recursive: true, force: true })
})

it.effect(
  'lowers the OS directory-list provider runner',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'os-filesystem/list-runner',
        ascii(`import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.os_filesystem { OsFileSystem }
import silk.filesystem { DirectoryEntry, FileError, FileSystem, Path }
import silk.vector { Vector }

pub effect fn main() -> () ! FileError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut fs = run OsFileSystem.make(b"/tmp") |> Effect.provideMut(&mut allocator)
  let path = run Path.root() |> Effect.provideMut(&mut allocator)
  let entries = run Intrinsic.bindRequirementMut(
    Intrinsic.bindRequirementMut(FileSystem.listDirectory(&path), &mut fs),
    &mut allocator
  )
  drop entries
  return ()
}`),
        'aarch64-apple-darwin',
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
      yield* Analysis.codegen(snapshot, { mode: 'release' })
    }),
  60000,
)

it.effect(
  'runs OS and explicit trust providers against real confined files',
  () =>
    Effect.gen(function* () {
      const source = `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.u32
import silk.u8
import silk.usize
import silk.os_filesystem { OsFileSystem }
import silk.native_filesystem { NativeFileSystem }
import silk.bytes { Bytes }
import silk.filesystem { FileError, FileSystem, Path }
import silk.result { Result }
import silk.native_file_trust_source { NativeFileTrustSource }
import silk.trust_snapshot { TrustFileOperation, TrustLoadLimits, TrustSnapshot, TrustSourceError }
import silk.trust_source { TrustSource }
import silk.vector { Vector }
${trustDefinitions(nativeRoot)}
effect fn program() -> i32 ! FileError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut fs = run OsFileSystem.make(b"${nativeRoot}") |> Effect.provideMut(&mut allocator)
  let path = run Path.make("/hello.txt") |> Effect.provideMut(&mut allocator)
  let input = [u8.toU8(104), u8.toU8(101), u8.toU8(108), u8.toU8(108), u8.toU8(111)]
  let written = run Intrinsic.bindRequirementMut(FileSystem.writeFile(&path, &input), &mut fs)
  let owned = run Intrinsic.bindRequirementMut(
    Intrinsic.bindRequirementMut(FileSystem.readFile(&path), &mut fs),
    &mut allocator
  )
  let bytes = Bytes.asSlice(&owned)
  if bytes.length != usize.add(0, 5) { return 1 }
  if bytes[usize.add(0, 0)] != u8.toU8(104) { return 2 }
  let removed = run Intrinsic.bindRequirementMut(FileSystem.removeFile(&path), &mut fs)
  let empty = run Path.make("/empty") |> Effect.provideMut(&mut allocator)
  let created = run Intrinsic.bindRequirementMut(FileSystem.createDirectory(&empty), &mut fs)
  let removedEmpty = run Intrinsic.bindRequirementMut(FileSystem.removeDirectory(&empty), &mut fs)
  let parent = run Path.make("/nested") |> Effect.provideMut(&mut allocator)
  let rawName = [u8.toU8(${process.platform === 'darwin' ? 195 : 255}), u8.toU8(${process.platform === 'darwin' ? 169 : 97})]
  let rawPath = run Path.joinBytes(&parent, &rawName) |> Effect.provideMut(&mut allocator)
  run FileSystem.writeFile(&rawPath, &input) |> Effect.provideMut(&mut fs)
  let listed = run FileSystem.listDirectory(&parent) |> Effect.provideMut(&mut fs) |> Effect.provideMut(&mut allocator)
  if Vector.length(&listed) != 1 { return 5 }
  let listedEntries = Vector.asSlice(&listed)
  let listedPath = Path.rawBytes(&listedEntries[0].path)
  if listedPath.length != 10 || listedPath[8] != u8.toU8(${process.platform === 'darwin' ? 195 : 255}) { return 6 }
  run FileSystem.removeFile(&rawPath) |> Effect.provideMut(&mut fs)
  let mut kind = 0
  let mut length: usize = 0
  let escaped = run Effect.result(NativeFileSystem.inspect(b"${nativeRoot}", b"/../outside", &mut kind, &mut length, 2))
  let rejected = match move escaped {
    Result<(), FileError>.Success { value } => false
    Result<(), FileError>.Failure { error } => true
  }
  if rejected == false { return 3 }
  let followed = run Effect.result(NativeFileSystem.inspect(b"${nativeRoot}", b"/escape/marker", &mut kind, &mut length, 2))
  let blocked = match move followed {
    Result<(), FileError>.Success { value } => false
    Result<(), FileError>.Failure { error } => true
  }
  if blocked == false { return 4 }
  let trustResult: Result<i32, FileError | TrustSourceError | OutOfMemoryError> = run Effect.result(
    ownedTrust() |> Effect.provideMut(&mut allocator),
  )
  let anchors = match move trustResult {
    Result<i32, FileError | TrustSourceError | OutOfMemoryError>.Success { value } => value
    Result<i32, FileError | TrustSourceError | OutOfMemoryError>.Failure { error } => match move error {
      FileError file => { fail move file }
      TrustSourceError trust => { return trustFailure(move trust) }
      OutOfMemoryError memory => { fail move memory }
    }
  }
  let missing = run checkedTrustAt(b"/trust-missing.pem") |> Effect.provideMut(&mut allocator)
  if missing != 10 { return 7 }
  let denied = run checkedTrustAt(b"/trust-denied.pem") |> Effect.provideMut(&mut allocator)
  if denied != 12 { return 8 }
  let linked = run checkedTrustAt(b"/trust-link.pem") |> Effect.provideMut(&mut allocator)
  if linked != 13 { return 9 }
  let wrongKind = run checkedTrustAt(b"/trust-directory") |> Effect.provideMut(&mut allocator)
  if wrongKind != 14 { return 10 }
  return 40 + anchors
}

pub fn main() -> i32 {
  let completed = run Effect.result(program())
  return match move completed {
      Result<i32, FileError | OutOfMemoryError>.Success { value } => value
      Result<i32, FileError | OutOfMemoryError>.Failure { error } => match move error {
        FileError failure => 20 + failure.operation.code * 20 + failure.reason.code
        OutOfMemoryError exhausted => 250
      }
  }
}
export "C" fn enter() -> i32 as "main" { return main() }`
      const compiled = yield* Driver.compile({
        compilation: {
          root: 'os-filesystem/native-provider',
          configuration: {
            profile: {
              target: (yield* NativeToolchain.hostTarget()).id,
              runtime: { kind: 'none' },
              optimization: 'speed',
              debug: false,
            },
          },
        },
        toolchain: yield* TestToolchain.configured,
        artifactKind: 'NativeExecutable',
        destination: join(destinationRoot, 'native-provider'),
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make('os-filesystem/native-provider', ascii(source)),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      )
      assert.strictEqual(
        compiled._tag,
        'Compiled',
        Json.stringify(compiled._tag === 'BackendFailed' ? compiled.error : compiled),
      )
      if (compiled._tag !== 'Compiled') return
      assert.notStrictEqual(process.getuid?.(), 0, 'permission fixture requires a non-root runner')
      const first = spawnSync(compiled.path, [], { encoding: 'utf8' })
      assert.strictEqual(
        first.status,
        41,
        Json.stringify({ signal: first.signal, stderr: first.stderr, stdout: first.stdout }),
      )
      renameSync(trustReplacement, trustPath)
      const second = spawnSync(compiled.path, [], { encoding: 'utf8' })
      assert.strictEqual(
        second.status,
        42,
        Json.stringify({ signal: second.signal, stderr: second.stderr, stdout: second.stdout }),
      )
      assert.strictEqual(readFileSync(outsideMarker, 'utf8'), 'untouched')
    }),
  // This compiles both ordinary filesystem actors once before exercising real confined files.
  120_000,
)

it.effect('omits native filesystem providers from Wasm and no-libc selections', () =>
  Effect.gen(function* () {
    const source = 'import silk.os_filesystem { OsFileSystem }\npub fn main() -> i32 { return 42 }'
    for (const target of Target.all) {
      const snapshot = yield* Analysis.makeRealized({
        root: 'filesystem/unavailable',
        configuration: {
          profile: { target: target.id, artifact: 'object', libc: 'none', entry: { kind: 'none' } },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make('filesystem/unavailable', ascii(source))]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => [
          diagnostic.code,
          diagnostic.span.start,
          diagnostic.span.end,
        ]),
        [
          [
            'SEM0014',
            source.indexOf('OsFileSystem'),
            source.indexOf('OsFileSystem') + 'OsFileSystem'.length,
          ],
        ],
      )
      assert.deepEqual(snapshot.instances.foreignCalls, [])
    }
  }),
)

it.effect('consumes a native file handle exactly once in source ownership analysis', () =>
  Effect.gen(function* () {
    const source = `import silk.native_filesystem { NativeFileSystem, FileHandle }
import silk.filesystem { FileSystem, FileError }
pub effect fn closeTwice(handle: FileHandle) -> () ! FileError {
  run NativeFileSystem.closeFile(move handle, FileSystem.readFileOperation())
  run NativeFileSystem.closeFile(move handle, FileSystem.readFileOperation())
}`
    const snapshot = yield* AnalysisFixture.declarations(
      'filesystem/consumed-handle',
      ascii(source),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.start,
        diagnostic.span.end,
      ]),
      [
        [
          'OWN0001',
          source.lastIndexOf('move handle'),
          source.lastIndexOf('move handle') + 'move handle'.length,
        ],
      ],
    )
  }),
)
