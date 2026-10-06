import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as ByteSize from 'effect/ByteSize'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Analysis from '@silklang/compiler/Analysis'
import * as AuthoredIdentity from '@silklang/compiler/AuthoredIdentity'
import type * as DeclarationFacts from '@silklang/compiler/DeclarationFacts'
import * as Instances from '@silklang/compiler/Instances'
import * as SourceFile from '@silklang/compiler/SourceFile'
import * as StaticValue from '@silklang/compiler/StaticValue'
import * as Type from '@silklang/compiler/Type'
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

const inlineSource = `interface Read<T> { fn read(self: &Self) -> T }
struct Box<T> { value: T }
impl<T: Copy> Read<T> for Box<T> { fn read(self: &Self) -> T { return self.value } }
struct Other { value: i32 }
impl Read<i32> for Other { fn read(self: &Self) -> i32 { return self.value } }
struct Mapped { value: i32 }
impl Mapped { fn read(self: &Self) -> i32 { return self.value } }
impl Read<i32> for Mapped { read: Mapped.read }
fn get<T, P: Read<T>>(provider: &P) -> T { return Read<T>.read(provider) }
service Source { effect fn load() -> i32 ? &mut Source }
struct Provider {}
impl Source for Provider { effect fn load(self: &mut Self) -> i32 { return 42 } }
pub fn main() -> i32 {
  let first = Box<i32> { value: 42 }
  let narrow = Box<u8> { value: 1 }
  let other = Other { value: 3 }
  let mapped = Mapped { value: 4 }
  let mut provider = Provider {}
  let value = get<i32, Box<i32>>(&first)
  let byte = get<u8, Box<u8>>(&narrow)
  let second = get<i32, Other>(&other)
  let third = get<i32, Mapped>(&mapped)
  let supplied = run Intrinsic.bindRequirementMut<Source>(Source.load(), &mut provider)
  return value + second + third + supplied
}`

it.effect('preserves authored inline operation tokens separately from compiler lookup names', () =>
  Effect.gen(function* () {
    const root = 'inventory/inline'
    const snapshot = yield* retainingMain(root, ascii(inlineSource))
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const captured = yield* Inventory.capture(snapshot)
    assert.strictEqual(captured.status, 'Complete')
    assert.deepEqual(captured.missingProvenance, [])
    const inline = captured.selectedAuthoredFunctions.filter((value) => {
      const declaration = Analysis.declarationForIdentity(snapshot, {
        _tag: 'DeclarationIdentity',
        id: value.id,
      })
      return (
        declaration?._tag === 'FunctionDeclaration' &&
        declaration.conformanceImplementation !== undefined
      )
    })
    assert.strictEqual(inline.length, 3)
    const reads = inline.filter((value) => value.name.spelling === 'read')
    assert.strictEqual(reads.length, 2)
    assert.notDeepEqual(reads.at(0)?.owner, reads.at(1)?.owner)
    assert.notDeepEqual(reads.at(0)?.id, reads.at(1)?.id)
    const specializationCounts = reads
      .map(
        (value) =>
          captured.instances.filter(
            (instance) =>
              instance.originalDeclaration?.sourceId === value.id.sourceId &&
              instance.originalDeclaration.ordinal === value.id.ordinal,
          ).length,
      )
      .toSorted((a, b) => a - b)
    assert.deepEqual(specializationCounts, [1, 2])
    for (const value of inline) {
      const declaration = Analysis.declarationForIdentity(snapshot, {
        _tag: 'DeclarationIdentity',
        id: value.id,
      })
      if (
        declaration?._tag !== 'FunctionDeclaration' ||
        declaration.conformanceImplementation === undefined ||
        declaration.name._tag !== 'Present'
      )
        return yield* Effect.die('expected actual inline FunctionDeclaration')
      assert.strictEqual(value.lookupName, declaration.name.spelling)
      assert.notStrictEqual(value.lookupName, value.name.spelling)
      assert.strictEqual(value.name.spelling, declaration.conformanceImplementation.operation)
      assert.strictEqual(
        inlineSource.slice(value.name.span.start, value.name.span.end),
        value.name.spelling,
      )
      const module = Analysis.declarationIndex(snapshot).modules.find(
        (value) => value.module === root,
      )
      const conformance = module?.conformances.find(
        (value) => value.ordinal === declaration.conformanceImplementation?.ordinal,
      )
      const operations =
        conformance?.operations.filter(
          (operation) =>
            operation.form === 'Inline' &&
            operation.name._tag === 'Present' &&
            operation.name.spelling === value.name.spelling,
        ) ?? []
      assert.strictEqual(operations.length, 1)
      const operation = operations.at(0) ?? unreachable('expected exact inline operation')
      assert.strictEqual(
        AuthoredIdentity.anchorKey(operation.anchor),
        AuthoredIdentity.anchorKey(value.anchor),
      )
      assert.strictEqual(
        AuthoredIdentity.anchorKey(operation.name.anchor),
        AuthoredIdentity.anchorKey(value.name.anchor),
      )
      assert.isTrue(AuthoredIdentity.equals(value.name.anchor.owner, value.owner))
    }
    const mapped =
      captured.selectedAuthoredFunctions.find(
        (value) =>
          value.canonical._tag === 'Canonical' && value.canonical.id.name === 'Mapped.read',
      ) ?? unreachable('expected mapped function')
    assert.strictEqual(mapped.name.spelling, 'read')
    assert.strictEqual(mapped.lookupName, 'read')
    const original = inline.at(0) ?? unreachable('expected selected inline declaration')
    const declaration = Analysis.declarationForIdentity(snapshot, {
      _tag: 'DeclarationIdentity',
      id: original.id,
    })
    if (
      declaration?._tag !== 'FunctionDeclaration' ||
      declaration.conformanceImplementation === undefined
    )
      return yield* Effect.die('expected inline metadata for refusal controls')
    const implementation = declaration.conformanceImplementation
    const ordinal = implementation.ordinal
    const reviseConformance = (
      change: (value: DeclarationFacts.ConformanceFact) => DeclarationFacts.ConformanceFact,
    ): Analysis.Snapshot => ({
      ...snapshot,
      index: {
        ...snapshot.index,
        modules: snapshot.index.modules.map((module) =>
          module.module !== root
            ? module
            : {
                ...module,
                conformances: module.conformances.map((value) =>
                  value.ordinal !== ordinal ? value : change(value),
                ),
              },
        ),
      },
    })
    const reviseDeclaration = (
      change: (value: DeclarationFacts.DeclarationFact) => DeclarationFacts.DeclarationFact,
    ): Analysis.Snapshot => ({
      ...snapshot,
      index: {
        ...snapshot.index,
        modules: snapshot.index.modules.map((module) =>
          module.module !== root
            ? module
            : {
                ...module,
                members: module.members.map((value) =>
                  value._tag !== 'FunctionDeclaration' ||
                  value.id.sourceId !== original.id.sourceId ||
                  value.id.ordinal !== original.id.ordinal
                    ? value
                    : change(value),
                ),
              },
        ),
      },
    })
    const invalidInputs: ReadonlyArray<readonly [string, Analysis.Snapshot]> = [
      [
        'absent conformance',
        reviseConformance((value) => ({ ...value, ordinal: ordinal + 1_000_000 })),
      ],
      [
        'duplicate conformance',
        {
          ...snapshot,
          index: {
            ...snapshot.index,
            modules: snapshot.index.modules.map((module) => ({
              ...module,
              conformances: module.conformances.flatMap((value) =>
                module.module === root && value.ordinal === ordinal ? [value, value] : [value],
              ),
            })),
          },
        },
      ],
      [
        'wrong operation',
        reviseConformance((value) => ({
          ...value,
          operations: value.operations.map((operation) => ({
            ...operation,
            name: { ...operation.name, _tag: 'Present', spelling: 'different-token' },
          })),
        })),
      ],
      [
        'wrong header anchor',
        reviseConformance((value) => ({
          ...value,
          operations: value.operations.map((operation) => ({
            ...operation,
            anchor: mapped.anchor,
          })),
        })),
      ],
      [
        'wrong name anchor',
        reviseConformance((value) => ({
          ...value,
          operations: value.operations.map((operation) => ({
            ...operation,
            name: { ...operation.name, anchor: mapped.name.anchor },
          })),
        })),
      ],
      [
        'mapped operation',
        reviseConformance((value) => ({
          ...value,
          operations: value.operations.map((operation) => ({ ...operation, form: 'Mapped' })),
        })),
      ],
      [
        'absent metadata',
        reviseDeclaration((value) => {
          const { conformanceImplementation: _missing, ...rest } = value
          return rest
        }),
      ],
      [
        'wrong metadata ordinal',
        reviseDeclaration((value) => ({
          ...value,
          conformanceImplementation: {
            ...implementation,
            ordinal: ordinal + 1_000_000,
          },
        })),
      ],
      [
        'wrong metadata operation',
        reviseDeclaration((value) => ({
          ...value,
          conformanceImplementation: {
            ...implementation,
            operation: 'different-token',
          },
        })),
      ],
      ['wrong owner', reviseDeclaration((value) => ({ ...value, owner: mapped.owner }))],
      [
        'wrong raw token',
        {
          ...snapshot,
          closure: {
            ...snapshot.closure,
            sources: new Map(
              [...snapshot.closure.sources].map(([module, file]) => [
                module,
                module !== root
                  ? file
                  : SourceFile.make(
                      root,
                      ascii(
                        inlineSource.slice(0, original.name.span.start) +
                          'x'.repeat(original.name.span.end - original.name.span.start) +
                          inlineSource.slice(original.name.span.end),
                      ),
                    ),
              ]),
            ),
          },
        },
      ],
    ]
    for (const [label, input] of invalidInputs) {
      const refused = yield* Inventory.capture(input)
      assert.strictEqual(refused.status, 'Incomplete', label)
      assert.isAbove(refused.missingProvenance.length, 0, label)
      const affected = refused.instances.filter(
        (value) =>
          value.origin.kind === 'MissingAuthoredProvenance' &&
          value.origin.declaration.sourceId === original.id.sourceId &&
          value.origin.declaration.ordinal === original.id.ordinal,
      )
      assert.isAbove(affected.length, 0, label)
      assert.isTrue(
        affected.every((value) => value.originalDeclaration === undefined),
        label,
      )
      assert.isFalse(
        refused.selectedAuthoredFunctions.some(
          (value) =>
            value.id.sourceId === original.id.sourceId && value.id.ordinal === original.id.ordinal,
        ),
        label,
      )
    }
  }),
)

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
      assert.strictEqual(captured.executionKeyScope, 'LOCAL_COMPLETE_KEY_RECORDS')
      assert.isTrue(
        captured.reachedExecutionEdges.every(
          (edge) =>
            Number.isInteger(edge.owner) &&
            edge.owner >= 0 &&
            edge.owner < captured.executionKeys.length &&
            Number.isInteger(edge.target) &&
            edge.target >= 0 &&
            edge.target < captured.executionKeys.length,
        ),
      )
      const fullKey = (value: Instances.InstanceKey) => ({
        identity: Instances.keyText(value),
        declaration: value.declaration,
        typeArguments: value.typeArguments.map(Type.encodeGenericArgument),
        staticArguments: value.staticArguments.map(StaticValue.encode),
        contractRow: value.contractRow,
        evidence: value.evidence,
      })
      assert.deepEqual(
        captured.reachedExecutionEdges.map((edge) => ({
          ...edge,
          owner: captured.executionKeys.at(edge.owner),
          target: captured.executionKeys.at(edge.target),
        })),
        snapshot.instances.executionEdges.map((edge) => ({
          kind: edge.kind,
          owner: fullKey(edge.owner),
          target: fullKey(edge.target),
          providers: (edge.providers ?? []).map((provider) => ({
            capability: Type.encode(provider.capability),
            providerType: Type.encode(provider.providerType),
            role: provider.role,
          })),
        })),
      )
      assert.deepEqual(
        captured.reachedExecutionEdges.map((edge) => [
          edge.kind,
          captured.executionKeys.at(edge.owner)?.identity,
          captured.executionKeys.at(edge.target)?.identity,
        ]),
        snapshot.instances.executionEdges.map((edge) => [
          edge.kind,
          Instances.keyText(edge.owner),
          Instances.keyText(edge.target),
        ]),
      )
      assert.strictEqual(
        captured.residualSiteScope,
        'PARENT_INSTANCE_ARTIFACT_AND_ORIGINAL_DECLARATION',
      )
      for (const [at, parent] of captured.instances.entries()) {
        const original =
          snapshot.instances.instances.at(at) ?? unreachable('expected selected instance')
        const declaration = Analysis.declarationForIdentity(snapshot, {
          _tag: 'DeclarationIdentity',
          id: original.function.declaration.id,
        })
        const originalSpan =
          declaration === undefined
            ? undefined
            : Analysis.nameResolution(snapshot).contexts.spanOf(declaration.anchor)
        assert.deepEqual(
          parent.residualBodySites.map((site) => ({
            ...site,
            instance: parent.key.identity,
            artifact: parent.artifact,
            originalDeclaration: parent.originalDeclaration,
            originalDeclarationSpan: parent.originalDeclarationSpan,
          })),
          Tir.nodesOf(original.function).map((node) => ({
            evidence: 'PRESENT_IN_SELECTED_RESIDUAL_BODY',
            instance: Instances.keyText(original.key),
            artifact: original.function.artifact,
            originalDeclaration: declaration?.id,
            originalDeclarationSpan:
              originalSpan === undefined
                ? undefined
                : {
                    sourceId: originalSpan.sourceId,
                    start: originalSpan.start,
                    end: originalSpan.end,
                  },
            node: node.id,
            tag: '_tag' in node && typeof node._tag === 'string' ? node._tag : 'Unknown',
            origin: node.origin,
            span: { sourceId: node.span.sourceId, start: node.span.start, end: node.span.end },
          })),
        )
      }
    }),
)

it.effect(
  'preserves actual cleanup/provider edges and intrinsic spans without inventing generated names',
  () =>
    Effect.gen(function* () {
      const source = `service Source { effect fn load() -> i32 ? &mut Source }
struct Provider {}
impl Provider { effect fn load(self: &mut Self) -> i32 { return 42 } }
impl Source for Provider { load: Provider.load }
struct Owned { value: i32 }
impl Drop for Owned { fn drop(self: &mut Owned) -> () { return () } }
fn makeOwned() -> Owned { return makeOwned() }
pub fn main() -> i32 {
  let mut provider = Provider {}
  let owned = makeOwned()
  drop owned
  let finish = fn(value: i32) -> i32 { return value }
  let result = run Intrinsic.bindRequirementMut<Source>(Source.load(), &mut provider)
  return finish(result)
}`
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
      const generated = captured.instances.filter((value) => value.origin.kind === 'Generated')
      assert.isAbove(generated.length, 0)
      for (const instance of generated) assert.isUndefined(instance.originalDeclaration)
    }),
)

it.effect(
  'keeps differing full records with equal identity separate and preserves edge order',
  () =>
    Effect.gen(function* () {
      // Pure codec controls do not represent a compiler-produced snapshot or successful analysis.
      const first: Inventory.EncodedInstanceKey = {
        identity: 'same-identity-control',
        declaration: { _tag: 'CanonicalDeclarationId', module: 'control', name: 'first' },
        typeArguments: [],
        staticArguments: [],
        contractRow: [],
        evidence: [],
      }
      const other = { ...first, evidence: ['different-full-record-control'] }
      const edge: Inventory.KeyedExecutionEdge = {
        kind: 'Runtime',
        owner: first,
        target: first,
        providers: [
          {
            capability: 'capability-control',
            providerType: 'provider-control',
            role: 'role-control',
          },
        ],
      }
      const edges = [edge, { ...edge, owner: other }, edge]
      const compact = yield* Inventory.encodeExecutionEdges(edges)
      assert.strictEqual(compact.executionKeyScope, 'LOCAL_COMPLETE_KEY_RECORDS')
      assert.deepEqual(compact.executionKeys, [first, other])
      assert.deepEqual(
        compact.reachedExecutionEdges.map((value) => ({
          ...value,
          owner: compact.executionKeys.at(value.owner),
          target: compact.executionKeys.at(value.target),
        })),
        edges,
      )
    }),
)
