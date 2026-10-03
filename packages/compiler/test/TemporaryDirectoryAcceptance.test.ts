import * as Layer from 'effect/Layer'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Json from './support/Json.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Driver from './support/TestDriver.js'
import * as TestToolchain from './support/TestToolchain.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const nativeRoot = mkdtempSync(join(tmpdir(), 'silk-temporary-directory-'))
const destinationRoot = mkdtempSync(join(tmpdir(), 'silk-temporary-directory-artifacts-'))
afterAll(() => {
  rmSync(nativeRoot, { recursive: true, force: true })
  rmSync(destinationRoot, { recursive: true, force: true })
})

/**
 * `TemporaryDirectory` has no `Drop` hook, so every one of these assertions is about an *explicit*
 * release. That is the decision this ticket settled: every removal path is
 * `effect fn ... ! FileError ? &mut FileSystem`, a `Drop` hook may carry neither row, and the only
 * way to fit one would have been an infallible intrinsic wrapping a fallible syscall. So release is
 * named at the call site — `release` when the caller wants the failure, `releaseIgnored` when it is
 * being handed to `Effect.ensuring`, whose finalizer is typed `! never`.
 *
 * The three scenarios share one executable. Each is its own function, so Silk emits each cleanup
 * shape per function in the IR and verifies it in-process, and each reports its failures in its
 * own exit-status band.
 *
 * The program reads its confined root from SILK_TEST_ROOT at runtime instead of baking the test
 * run's mkdtemp path into the source text. A per-run path in the source made every compilation
 * byte-unique, so the content-addressed emission and executable caches could never hit; with a
 * stable source they hit on every warm run.
 */
const nativeSource = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.bytes { Bytes }
import silk.effect { Effect }
import silk.filesystem { FileError, FileSystem, Path }
import silk.host_input { HostInputError, HostInput }
import silk.native_host_input { NativeHostInput }
import silk.option { Option }
import silk.os_filesystem { OsFileSystem }
import silk.os_host_input { OsHostInput }
import silk.result { Result }
import silk.string { InvalidUtf8, String }
import silk.u8

effect fn missingRoot() -> Bytes ! HostInputError {
  fail HostInput.inputFailure()
}

effect fn requiredRoot(found: Option<Bytes>) -> Bytes ! HostInputError {
  return match move found {
    Option<Bytes>.Some { value: bytes } => move bytes
    Option<Bytes>.None => run missingRoot()
  }
}

/// A root that is not valid UTF-8 is a harness defect, not a program outcome; trap like OsFileSystem.make
/// does for its own malformed-root preconditions.
effect fn invalidRoot() -> String ! OutOfMemoryError ? &mut Allocator {
  let invalid = 1 / 0
  return run String.copy("/")
}

effect fn confinedRootString() -> String ! HostInputError | OutOfMemoryError ? &mut Allocator {
  let inputs = run unsafe NativeHostInput.environmentSnapshot()
  let mut hostInput = OsHostInput.make(move inputs)
  let found = run Effect.provideMut(HostInput.variableNamed("SILK_TEST_ROOT"), &mut hostInput)
  let rootBytes = run requiredRoot(move found)
  let copied = run String.copyUtf8(Bytes.asSlice(&rootBytes))
  return match move copied {
    Result<String, InvalidUtf8>.Success { value } => move value
    Result<String, InvalidUtf8>.Failure { error } => run invalidRoot()
  }
}

/// The whole lifecycle against a real confined root: two makes give two paths, the made directory
/// exists, and an artifact written to a durable path outside the scopes survives their release.
/// Each numbered return is one acceptance criterion.
effect fn releasesScopes() -> i32 ! FileError | OutOfMemoryError | HostInputError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let root = run confinedRootString() |> Effect.provideMut(&mut allocator)
  let mut fs = run OsFileSystem.make(String.utf8Bytes(String.view(&root))) |> Effect.provideMut(&mut allocator)
  let parent = run Path.make("/scopes") |> Effect.provideMut(&mut allocator)
  let prepared = run Intrinsic.bindRequirementMut(
    Intrinsic.bindRequirementMut(FileSystem.createDirectoriesRecursively(&parent), &mut fs),
    &mut allocator
  )
  let first = run Intrinsic.bindRequirementMut(
    Intrinsic.bindRequirementMut(FileSystem.temporaryDirectory(&parent, "silk-build-"), &mut fs),
    &mut allocator
  )
  let second = run Intrinsic.bindRequirementMut(
    Intrinsic.bindRequirementMut(FileSystem.temporaryDirectory(&parent, "silk-build-"), &mut fs),
    &mut allocator
  )

  // Two makes, two paths.
  if Path.view(&first.path) == Path.view(&second.path) { return 1 }

  // The made directory is there.
  if run Intrinsic.bindRequirementMut(FileSystem.exists(&first.path), &mut fs) {} else { return 2 }

  // The artifact a caller keeps: written to a durable path outside the scope before it releases.
  let payload = [u8.toU8(1), u8.toU8(2), u8.toU8(3)]
  let durable = run Path.join(&parent, "promoted.bin") |> Effect.provideMut(&mut allocator)
  let promoted = run Intrinsic.bindRequirementMut(FileSystem.writeFile(&durable, &payload), &mut fs)

  let released = run Intrinsic.bindRequirementMut(
    Intrinsic.bindRequirementMut(FileSystem.release(move first), &mut fs),
    &mut allocator
  )
  let releasedSecond = run Intrinsic.bindRequirementMut(
    Intrinsic.bindRequirementMut(FileSystem.release(move second), &mut fs),
    &mut allocator
  )
  return 0
}

/// Recursive removal against a real populated tree. \`release\` removes contents, not just an empty
/// directory, and the primitive underneath removes exactly one *empty* directory, so the two-pass
/// walk is the part that has to be right, and this is it running on a real filesystem.
effect fn removesTree() -> i32 ! FileError | OutOfMemoryError | HostInputError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let root = run confinedRootString() |> Effect.provideMut(&mut allocator)
  let mut fs = run OsFileSystem.make(String.utf8Bytes(String.view(&root))) |> Effect.provideMut(&mut allocator)
  let target = run Path.make("/tree") |> Effect.provideMut(&mut allocator)
  let removed = run Intrinsic.bindRequirementMut(
    Intrinsic.bindRequirementMut(FileSystem.removeDirectoryRecursively(&target), &mut fs),
    &mut allocator
  )
  return 0
}

/// Several populated scopes, each released while the others are still owned. This is the shape
/// that trapped at \`-O0\` while #130's crash was being narrowed: one owner's cleanup is a
/// conditional arm, and the values the arm reloads are read again at the arm's join. Both a
/// populated tree and a live neighbour are needed; two bare scopes released in sequence do not
/// reach it.
effect fn releasesManyScopes() -> i32 ! FileError | OutOfMemoryError | HostInputError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let root = run confinedRootString() |> Effect.provideMut(&mut allocator)
  let mut fs = run OsFileSystem.make(String.utf8Bytes(String.view(&root))) |> Effect.provideMut(&mut allocator)
  let parent = run Path.make("/many") |> Effect.provideMut(&mut allocator)
  let prepared = run Intrinsic.bindRequirementMut(
    Intrinsic.bindRequirementMut(FileSystem.createDirectoriesRecursively(&parent), &mut fs),
    &mut allocator
  )
  let payload = [u8.toU8(1), u8.toU8(2), u8.toU8(3)]
${[0, 1, 2]
  .map(
    (index) => `  let scope${index} = run Intrinsic.bindRequirementMut(
    Intrinsic.bindRequirementMut(FileSystem.temporaryDirectory(&parent, "silk-many${index}-"), &mut fs),
    &mut allocator
  )
  let nested${index} = run Path.join(&scope${index}.path, "nested") |> Effect.provideMut(&mut allocator)
  let madeNested${index} = run Intrinsic.bindRequirementMut(
    Intrinsic.bindRequirementMut(FileSystem.createDirectoriesRecursively(&nested${index}), &mut fs),
    &mut allocator
  )
  let file${index} = run Path.join(&nested${index}, "payload.bin") |> Effect.provideMut(&mut allocator)
  let wrote${index} = run Intrinsic.bindRequirementMut(FileSystem.writeFile(&file${index}, &payload), &mut fs)
  if run Intrinsic.bindRequirementMut(FileSystem.exists(&scope${index}.path), &mut fs) {} else { return ${index + 3} }`,
  )
  .join('\n')}
${[0, 1, 2]
  .map(
    (index) => `  let released${index} = run Intrinsic.bindRequirementMut(
    Intrinsic.bindRequirementMut(FileSystem.release(move scope${index}), &mut fs),
    &mut allocator
  )`,
  )
  .join('\n')}
  return 0
}

/// Folds one scenario into an exit status: 0 when it passed, its numbered check when one failed,
/// and otherwise its own band: \`base\` plus the portable file reason code (0 through 9), \`base + 10\`
/// for allocation failure, and \`base + 11\` for a missing root.
fn scenarioStatus(completed: Result<i32, FileError | OutOfMemoryError | HostInputError>, base: i32) -> i32 {
  return match move completed {
    Result<i32, FileError | OutOfMemoryError | HostInputError>.Success { value } => value
    Result<i32, FileError | OutOfMemoryError | HostInputError>.Failure { error } => match move error {
      FileError failure => base + failure.reason.code
      OutOfMemoryError exhausted => base + 10
      HostInputError missing => base + 11
    }
  }
}

pub fn main() -> i32 {
  let scopes = run Effect.result(releasesScopes())
  let scopesStatus = scenarioStatus(move scopes, 100)
  if scopesStatus != 0 { return scopesStatus }
  let tree = run Effect.result(removesTree())
  let treeStatus = scenarioStatus(move tree, 120)
  if treeStatus != 0 { return treeStatus }
  let many = run Effect.result(releasesManyScopes())
  let manyStatus = scenarioStatus(move many, 140)
  if manyStatus != 0 { return manyStatus }
  return 42
}`

it.effect(
  'creates, populates, and releases temporary directories against a real root',
  () =>
    Effect.gen(function* () {
      mkdirSync(join(nativeRoot, 'tree', 'nested'), { recursive: true })
      writeFileSync(join(nativeRoot, 'tree', 'shallow.bin'), 'a')
      writeFileSync(join(nativeRoot, 'tree', 'nested', 'deep.bin'), 'b')
      const compiled = yield* Driver.compile({
        compilation: {
          root: 'temporary-directory/native',
        },
        toolchain: yield* TestToolchain.configured,
        // Release, so this also stands as the regression test for #130: the backend used to let
        // a cleanup arm's reloaded lanes escape into the arm's join block, which is invalid SSA,
        // and Clang crashed on it at -O2 instead of diagnosing it. Before the fix the many-scopes
        // scenario trapped (SIGILL) even at -O0: the join read an undefined union tag and fell
        // through to the invalid-tag trap.
        optimization: 'release',
        artifactKind: 'NativeExecutable',
        destination: join(destinationRoot, 'native'),
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make('temporary-directory/native', ascii(nativeSource)),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      )
      assert.strictEqual(compiled._tag, 'Compiled', Json.stringify(compiled).slice(0, 2500))
      if (compiled._tag !== 'Compiled') return
      assert.deepEqual(compiled.diagnostics, [])
      const run = spawnSync(compiled.path, [], {
        encoding: 'utf8',
        env: { ...process.env, SILK_TEST_ROOT: nativeRoot },
      })
      // The status, not just the absence of a crash, is what says every release actually ran.
      assert.strictEqual(
        run.status,
        42,
        Json.stringify({ signal: run.signal, stderr: run.stderr, stdout: run.stdout }),
      )
      // The same statements read off the real filesystem rather than through the program: both
      // scopes are gone and the promoted artifact is the only thing their parent still holds; the
      // populated tree, its nested directory and both files are gone; and every populated scope
      // was released.
      assert.deepEqual(readdirSync(join(nativeRoot, 'scopes')), ['promoted.bin'])
      assert.isFalse(existsSync(join(nativeRoot, 'tree')))
      assert.deepEqual(readdirSync(join(nativeRoot, 'many')), [])
    }),
  360_000,
)
