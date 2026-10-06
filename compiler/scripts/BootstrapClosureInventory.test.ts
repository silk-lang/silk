import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as ByteSize from 'effect/ByteSize'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Analysis from '@silklang/compiler/Analysis'
import * as Instances from '@silklang/compiler/Instances'
import * as SourceFile from '@silklang/compiler/SourceFile'
import * as SourceResolver from '@silklang/compiler/SourceResolver'
import * as Layer from 'effect/Layer'
import * as Tir from '@silklang/compiler/Tir'
import * as Stdlib from '@silklang/compiler/Stdlib'
import { createHash } from 'node:crypto'
import { unreachable } from '../../packages/compiler/test/support/raise.js'
import * as Inventory from './BootstrapClosureInventory.js'

const ascii = (source: string) => Uint8Array.from(source, (character) => character.charCodeAt(0))
const retainingMain = Effect.fnUntraced(function* (root: string, bytes: Uint8Array) {
  return yield* Analysis.makeRealized({
    root,
    configuration: {
      profile: {
        target: 'x86_64-unknown-linux-gnu',
        artifact: 'object',
        runtime: { kind: 'none' },
      },
      composition: {
        runtimes: [],
        defaults: [],
        retention: [{ module: root, declaration: 'main' }],
        requirements: [],
      },
    },
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make(root, bytes)]).pipe(
        Layer.provideMerge(SourceResolver.empty),
      ),
    ),
  )
})

it.effect(
  'checks immutable snapshot, embedded stdlib, executable and archive receipts before analysis',
  () =>
    Effect.gen(function* () {
      // Deliberately synthetic storage controls; these receipts make no real producer/run claim.
      const bytes = new Map<string, Uint8Array>([
        [
          'compiler/silk.toml',
          ascii('[package]\nname="silk-compiler"\nversion="0.1.0"\nroot="src/main.silk"'),
        ],
        ['compiler/src/main.silk', ascii('pub fn main() -> i32 { return 0 }')],
        ['packages/compiler/stdlib/manifest.json', ascii('[]')],
        ...Stdlib.manifest.map((value): [string, Uint8Array] => [
          `packages/compiler/stdlib/${value.path}`,
          value.bytes,
        ]),
      ])
      const hash = Effect.fnUntraced(function* (value: string | Uint8Array) {
        return yield* Effect.try(() => createHash('sha256').update(value).digest('hex'))
      })
      const hashed = yield* Effect.forEach(
        [...bytes],
        Effect.fnUntraced(function* ([path, value]) {
          return { path, mode: '100644', sha256: yield* hash(value) }
        }),
      )
      const files = hashed.sort((a, b) => {
        if (a.path < b.path) return -1
        if (a.path > b.path) return 1
        return 0
      })
      const fileDigest = (values: typeof files) =>
        hash(values.map(({ path, mode, sha256 }) => `${path}\0${mode}\0${sha256}\n`).join(''))
      const compilerDigest = yield* fileDigest(
        files.filter((file) => file.path.startsWith('compiler/')),
      )
      const stdlibDigest = yield* fileDigest(
        files.filter((file) => file.path.startsWith('packages/compiler/stdlib/')),
      )
      bytes.set('authored-inputs.tar', ascii('archive-control'))
      bytes.set('bootstrap.mjs', ascii('bootstrap-control'))
      const self: Inventory.BootstrapClosureInventory = {
        directory: '/snapshot',
        inputs: {
          schemaVersion: 1,
          sourceCommit: 'a'.repeat(40),
          roots: ['compiler', 'packages/compiler/stdlib'],
          files,
          normalizedDigest: yield* fileDigest(files),
          compilerDigest,
          stdlibDigest,
          archive: 'authored-inputs.tar',
          archiveSha256: yield* hash('archive-control'),
        },
        bootstrap: {
          commit: 'b'.repeat(40),
          runId: '1',
          file: '/snapshot/bootstrap.mjs',
          sha256: yield* hash('bootstrap-control'),
          stdlibDigest,
        },
        profile: {
          name: 'release-with-debug',
          target: 'x86_64-unknown-linux-gnu',
          optimization: 'speed',
          debug: true,
        },
      }
      let mode = 0o644
      const fallback = FileSystem.makeNoop({})
      const fileSystem = FileSystem.layerNoop({
        readFile: Effect.fnUntraced(function* (file: string) {
          const value = bytes.get(file.slice('/snapshot/'.length))
          return value === undefined ? yield* fallback.readFile(file) : value
        }),
        stat: Effect.fnUntraced(function* (file: string): Effect.fn.Return<FileSystem.File.Info> {
          return yield* Effect.succeed<FileSystem.File.Info>({
            type: 'File',
            mtime: Option.none(),
            atime: Option.none(),
            birthtime: Option.none(),
            dev: 1,
            ino: Option.none(),
            mode,
            nlink: Option.none(),
            uid: Option.none(),
            gid: Option.none(),
            rdev: Option.none(),
            size: ByteSize.bytes(bytes.get(file)?.length ?? 0),
            blksize: Option.none(),
            blocks: Option.none(),
          })
        }),
      })
      const verify = Inventory.verifyInputs(self).pipe(Effect.provide([fileSystem, Path.layer]))
      yield* verify
      bytes.set('compiler/src/main.silk', ascii('changed-source'))
      const changedSource = yield* Effect.result(verify)
      assert.isTrue(Result.isFailure(changedSource))
      if (Result.isFailure(changedSource))
        assert.strictEqual(changedSource.failure._tag, 'BootstrapClosureInventoryError')
      bytes.set('compiler/src/main.silk', ascii('pub fn main() -> i32 { return 0 }'))
      mode = 0o755
      assert.isTrue(Result.isFailure(yield* Effect.result(verify)))
      mode = 0o644
      bytes.set('authored-inputs.tar', ascii('changed-archive'))
      assert.isTrue(Result.isFailure(yield* Effect.result(verify)))
      bytes.set('authored-inputs.tar', ascii('archive-control'))
      bytes.set('bootstrap.mjs', ascii('changed-bootstrap'))
      assert.isTrue(Result.isFailure(yield* Effect.result(verify)))
    }),
)

it.effect(
  'deduplicates original specialization owners and labels dead residual sites as presence only',
  () =>
    Effect.gen(function* () {
      const source = `pub fn identity<T>(value: T) -> T { return move value }
fn selected(static value: i64) -> i32 { return 42 }
fn unused() -> i32 { return 99 }
fn completion() -> i32 { let static value = 42 while true {} return value }
pub fn main() -> i32 {
  let first = identity<i32>(selected(9007199254740993))
  let second = identity<u8>(1)
  let completed = completion()
  return first
}`
      // A retained object fixture isolates exporter claims; analyze() always uses the real seed plan.
      const snapshot = yield* retainingMain('inventory/program', ascii(source))
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const captured = yield* Inventory.capture(snapshot)
      const identity = captured.selectedAuthoredFunctions.filter(
        (value) => value.name.spelling === 'identity',
      )
      assert.strictEqual(identity.length, 1)
      assert.strictEqual(
        captured.instances.filter((value) => value.key.declaration.name === 'identity').length,
        2,
      )
      assert.isFalse(
        captured.selectedAuthoredFunctions.some((value) => value.name.spelling === 'unused'),
      )
      for (const value of captured.selectedAuthoredFunctions) {
        assert.strictEqual(
          source.slice(value.name.span.start, value.name.span.end),
          value.name.spelling,
        )
        assert.isAbove(value.owner.path.length, 0)
      }
      assert.deepEqual(captured.missingProvenance, [])
      assert.strictEqual(captured.status, 'Complete')
      const staticInstance =
        captured.instances.find((value) => value.key.declaration.name === 'selected') ??
        unreachable('expected static specialization')
      assert.include(
        staticInstance.key.staticArguments.at(0) ?? unreachable('expected encoded integer'),
        '9007199254740993',
      )
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(captured)
      assert.include(encoded, '9007199254740993')
      const missingIndex = yield* Inventory.capture({
        ...snapshot,
        index: {
          ...snapshot.index,
          modules: snapshot.index.modules.filter((module) => module.module !== 'inventory/program'),
        },
      })
      assert.strictEqual(missingIndex.status, 'Incomplete')
      assert.isAbove(missingIndex.missingProvenance.length, 0)
      assert.isTrue(
        missingIndex.instances
          .filter((value) => value.key.declaration.module === 'inventory/program')
          .every((value) => value.origin.kind === 'MissingAuthoredProvenance'),
      )
      const missingSource = yield* Inventory.capture({
        ...snapshot,
        closure: {
          ...snapshot.closure,
          sources: new Map(
            [...snapshot.closure.sources].filter(([module]) => module !== 'inventory/program'),
          ),
        },
      })
      assert.strictEqual(missingSource.status, 'Incomplete')
      assert.isAbove(missingSource.missingProvenance.length, 0)
      const sites = captured.instances.flatMap((value) => value.residualBodySites)
      assert.isAbove(sites.length, 0)
      assert.isTrue(sites.every((value) => value.evidence === 'PRESENT_IN_SELECTED_RESIDUAL_BODY'))
      // The synthetic completion after an infinite loop is residual presence, never execution evidence.
      const synthetic = sites.filter((value) => value.origin._tag === 'Synthetic')
      assert.isAbove(synthetic.length, 0)
      const completion =
        captured.instances.find((value) => value.key.declaration.name === 'completion') ??
        unreachable('expected completion control')
      assert.isTrue(completion.residualBodySites.some((site) => site.tag === 'While'))
      assert.isTrue(
        completion.residualBodySites.some(
          (site) => site.tag === 'IntegerLiteral' && site.origin._tag === 'Synthetic',
        ),
      )
      assert.deepEqual(
        captured.reachedExecutionEdges.map((edge) => [
          edge.kind,
          edge.owner.identity,
          edge.target.identity,
        ]),
        snapshot.instances.executionEdges.map((edge) => [
          edge.kind,
          Instances.keyText(edge.owner),
          Instances.keyText(edge.target),
        ]),
      )
      const original =
        snapshot.instances.instances.at(0) ?? unreachable('expected selected instance')
      assert.deepEqual(
        captured.instances.at(0)?.residualBodySites.map((site) => site.node),
        Tir.nodesOf(original.function).map((node) => node.id),
      )
    }),
)

it.effect(
  'preserves actual cleanup/provider edges and intrinsic spans without inventing generated names',
  () =>
    Effect.gen(function* () {
      const source = `import silk.effect { Effect }
service Source { effect fn load() -> i32 ? &mut Source }
struct Provider {}
impl Provider { effect fn load(self: &mut Self) -> i32 { return 42 } }
impl Source for Provider { load: Provider.load }
struct Owned { storage: RawBuffer<i32> }
impl Drop for Owned { fn drop(self: &mut Owned) -> () { return () } }
fn makeOwned() -> Owned { return makeOwned() }
effect fn program() -> i32 {
  let mut provider = Provider {}
  let owned = makeOwned()
  drop owned
  return run Source.load() |> Effect.provideMut<Source>(&mut provider)
}
pub fn main() -> i32 { return run program() }`
      const snapshot = yield* retainingMain('inventory/providers', ascii(source))
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const captured = yield* Inventory.capture(snapshot)
      assert.include(
        captured.reachedExecutionEdges.map((edge) => edge.kind),
        'Cleanup',
      )
      assert.include(
        captured.reachedExecutionEdges.map((edge) => edge.kind),
        'Provider',
      )
      assert.deepEqual(
        captured.reachedIntrinsics,
        snapshot.instances.intrinsics.map((call) => ({
          operation: call.operation,
          span: { sourceId: call.span.sourceId, start: call.span.start, end: call.span.end },
        })),
      )
      assert.deepEqual(captured.missingProvenance, [])
      const portable = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        selected: captured,
        requestedProfile: snapshot.configuration?.profile,
        requestedComposition: snapshot.configuration?.composition,
        composition: snapshot.composition,
      })
      assert.include(portable, 'PRESENT_IN_SELECTED_RESIDUAL_BODY')
      for (const instance of captured.instances.filter(
        (value) => value.origin.kind === 'Generated',
      ))
        assert.isUndefined(instance.residualBodySites.at(0)?.originalDeclaration)
    }),
)
