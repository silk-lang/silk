import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as DeclarationFacts from '../src/DeclarationFacts.js'
import * as Type from '../src/Type.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const namespaceProgram = `import silk.option { Option }
import silk.result { Result }
import silk.vector { Vector }
pub fn main() -> i32 {
  let values = Vector<i32>.make()
  let optional = Option<i32>.some(40)
  let result = Result<i32, i32>.succeed(2)
  drop values
  drop optional
  drop result
  return 42
}`

const jsonReaderProgram = `import silk.buffered_input { BufferedInput, BufferError }
import silk.byte_duplex { ByteDuplex }
import silk.json_reader { JsonReader, JsonReadToken }
import silk.json_scanner { JsonError }
import silk.monotonic_clock { MonotonicClock }
import silk.option { Option }
import silk.system_clock { Instant }
effect fn next<'scratch>(
  reader: &mut JsonReader,
  input: &mut BufferedInput,
  scratch: &'scratch mut [u8]
) -> JsonReadToken<'scratch>
! JsonError | BufferError
? &mut ByteDuplex | &mut MonotonicClock {
  return run JsonReader.next(&mut reader.*, &mut input.*, move scratch, Option<Instant>.none())
}
pub fn main() -> i32 { return 0 }`

const jsonCodecProgram = `import silk.json_codec { Decode, Deserialize, Serialize }
import silk.json_value { Json }
import silk.json_array { JsonArray }
import silk.json_object { JsonObject }
import silk.effect { Effect }
import silk.json_output { JsonOptions }
import silk.json_scanner { JsonError, JsonScanner }
import silk.result { Result }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.writer { Writer, WriterError }
fn read<T: Decode>(scanner: &mut JsonScanner) -> Result<T, JsonError> {
  return Decode.decode(&mut scanner.*)
}
fn decodeDocument(bytes: &[u8]) -> Result<i32, JsonError> {
  return Json.decode<i32>(bytes)
}
effect fn deserializeDocument(bytes: &[u8])
  -> i32 ! JsonError | OutOfMemoryError ? &mut Allocator {
  return run Json.deserialize<i32>(bytes)
}
effect fn readOwned<T: Deserialize>(scanner: &mut JsonScanner)
  -> T ! JsonError | OutOfMemoryError ? &mut Allocator {
  return run Deserialize.deserialize(&mut scanner.*)
}
effect fn write<T: Serialize>(value: &T, options: &JsonOptions)
  -> () ! JsonError | WriterError ? &mut Writer {
  return run Serialize.serialize(value, options)
}
effect fn writeObject(value: &i32, options: &JsonOptions)
  -> () ! JsonError | WriterError ? &mut Writer {
  return run JsonObject.begin(options)
    |> JsonObject.field("x", value)
    |> JsonObject.end
}
effect fn writeArray(values: &[i32], options: &JsonOptions)
  -> () ! JsonError | WriterError ? &mut Writer {
  return run JsonArray.begin(options)
    |> JsonArray.items(values)
    |> JsonArray.end
}
struct Sink {}
effect fn writeAll(self: &mut Sink, values: &[u8]) -> () ! WriterError { return () }
effect fn flush(self: &mut Sink) -> () ! WriterError { return () }
impl Writer for Sink { writeAll: Sink.writeAll flush: Sink.flush }
pub effect fn main() -> i32 ! JsonError | WriterError {
  let options = JsonOptions.compact()
  let value: i32 = 1
  let values = [value]
  let mut sink = Sink {}
  run writeObject(&value, &options) |> Effect.provideMut<Writer>(&mut sink)
  run writeArray(&values, &options) |> Effect.provideMut<Writer>(&mut sink)
  return 0
}`

const jsonReflectProgram = `import silk.effect { Effect }
import silk.json_output { JsonOptions }
import silk.json_reflect { JsonReflect }
import silk.json_scanner { JsonError }
import silk.writer { Writer, WriterError }

struct Hidden {}
struct Record { pub alpha: i32 hidden: Hidden pub beta: bool }

struct Sink {}
effect fn writeAll(self: &mut Sink, values: &[u8]) -> () ! WriterError { return () }
effect fn flush(self: &mut Sink) -> () ! WriterError { return () }
impl Writer for Sink { writeAll: Sink.writeAll flush: Sink.flush }

pub effect fn main() -> i32 ! JsonError | WriterError {
  let value = Record { alpha: 7, hidden: Hidden {}, beta: true }
  let options = JsonOptions.compact()
  let mut sink = Sink {}
  run JsonReflect.write<Record>(&value, &options) |> Effect.provideMut<Writer>(&mut sink)
  return 0
}`

it.effect('reflects only visible serializable fields across the stdlib boundary', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib-namespace/json-reflect',
      ascii(jsonReflectProgram),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        source: diagnostic.span.sourceId,
        start: diagnostic.span.start,
      })),
      [],
    )
  }),
)

const jsonReflectFailuresProgram = `import silk.effect { Effect }
import silk.json_output { JsonOptions }
import silk.json_reflect { JsonReflect }
import silk.json_scanner { JsonError }
import silk.writer { Writer, WriterError }

struct Hidden {}
struct Missing { pub value: Hidden }
tuple Pair(i32, i32)

struct Sink {}
effect fn writeAll(self: &mut Sink, values: &[u8]) -> () ! WriterError { return () }
effect fn flush(self: &mut Sink) -> () ! WriterError { return () }
impl Writer for Sink { writeAll: Sink.writeAll flush: Sink.flush }

pub effect fn main() -> i32 ! JsonError | WriterError {
  let missing = Missing { value: Hidden {} }
  let pair = Pair(1, 2)
  let options = JsonOptions.compact()
  let mut sink = Sink {}
  run JsonReflect.write<Missing>(&missing, &options)
    |> Effect.provideMut<Writer>(&mut sink)
  run JsonReflect.write<Pair>(&pair, &options)
    |> Effect.provideMut<Writer>(&mut sink)
  return 0
}`

it.effect('rejects positional aggregates and visible fields without Serialize', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib-namespace/json-reflect-invalid',
      ascii(jsonReflectFailuresProgram),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        source: diagnostic.span.sourceId,
        start: diagnostic.span.start,
      })),
      [
        { code: 'SEM0177', source: 'silk/json_reflect', start: 2091 },
        { code: 'SEM0083', source: 'silk/json_reflect', start: 2675 },
      ],
    )
  }),
)

it.effect('resolves JSON conversion contracts with exact allocation boundaries', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib-namespace/json-codec',
      ascii(jsonCodecProgram),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        source: diagnostic.span.sourceId,
        start: diagnostic.span.start,
      })),
      [],
    )
    const json = Analysis.declarationIndex(snapshot).modules.find(
      (candidate) => candidate.module === 'silk/json_value',
    )
    const decode = json?.declarations.find(
      (declaration) => declaration.associatedMember?.name === 'decode',
    )
    const deserialize = json?.declarations.find(
      (declaration) => declaration.associatedMember?.name === 'deserialize',
    )
    const serialize = json?.declarations.find(
      (declaration) => declaration.associatedMember?.name === 'serialize',
    )
    assert.isDefined(decode)
    assert.isDefined(deserialize)
    assert.isDefined(serialize)
    if (decode === undefined || deserialize === undefined || serialize === undefined) return
    const decoded = DeclarationFacts.callableContract(decode).result
    const deserialized = DeclarationFacts.callableContract(deserialize).result
    const serialized = DeclarationFacts.callableContract(serialize).result
    assert.isFalse(Type.isEffect(decoded), 'Json.decode must not require an allocator')
    assert.isTrue(Type.isEffect(deserialized))
    assert.isTrue(Type.isEffect(serialized))
    if (!Type.isEffect(deserialized) || !Type.isEffect(serialized)) return
    assert.deepEqual(Type.failureMembers(deserialized).map(Type.encode), [
      'silk/allocator.OutOfMemoryError',
      'silk/json_scanner.JsonError',
    ])
    assert.deepEqual(
      Type.requirementMembers(deserialized).map((requirement) => ({
        capability: Type.encode(requirement.capability),
        access: requirement.access,
      })),
      [{ capability: 'silk/allocator.Allocator', access: 'Exclusive' }],
    )
    assert.deepEqual(Type.failureMembers(serialized).map(Type.encode), [
      'silk/json_scanner.JsonError',
      'silk/writer.WriterError',
    ])
    assert.deepEqual(
      Type.requirementMembers(serialized).map((requirement) => ({
        capability: Type.encode(requirement.capability),
        access: requirement.access,
      })),
      [{ capability: 'silk/writer.Writer', access: 'Exclusive' }],
    )
  }),
)

it.effect('keeps the JSON reader result tied to scratch with exact effect rows', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib-namespace/json-reader',
      ascii(jsonReaderProgram),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).filter(
        (diagnostic) =>
          diagnostic.span.sourceId === 'stdlib-namespace/json-reader' ||
          diagnostic.span.sourceId === 'silk/json_reader',
      ),
      [],
    )
    const module = Analysis.declarationIndex(snapshot).modules.find(
      (candidate) => candidate.module === 'silk/json_reader',
    )
    const next = module?.declarations.find(
      (declaration) => declaration.associatedMember?.name === 'next',
    )
    const result = next === undefined ? undefined : DeclarationFacts.callableContract(next).result
    assert.isTrue(result !== undefined && Type.isEffect(result))
    if (result === undefined || !Type.isEffect(result)) return
    assert.deepEqual(Type.failureMembers(result).map(Type.encode), [
      'silk/buffered_input.BufferError',
      'silk/json_scanner.JsonError',
    ])
    assert.deepEqual(
      Type.requirementMembers(result).map((requirement) => ({
        capability: Type.encode(requirement.capability),
        access: requirement.access,
      })),
      [
        { capability: 'silk/byte_duplex.ByteDuplex', access: 'Exclusive' },
        { capability: 'silk/monotonic_clock.MonotonicClock', access: 'Exclusive' },
      ],
    )
  }),
)

it.effect('resolves Option, Result, and Vector operations through their namespaces', () =>
  Effect.gen(function* () {
    const module = 'stdlib-namespace/qualified'
    const snapshot = yield* AnalysisFixture.retainingMain(module, ascii(namespaceProgram))
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    for (const [spelling, expectedModule] of [
      ['Vector<i32>.make', 'silk/vector'],
      ['Option<i32>.some', 'silk/option'],
      ['Result<i32, i32>.succeed', 'silk/result'],
    ] as const) {
      const offset = namespaceProgram.indexOf(spelling) + spelling.indexOf('.') + 1
      const occurrence = Analysis.semanticOccurrenceAt(snapshot, module, offset)
      assert.strictEqual(occurrence?.role, 'Value', spelling)
      assert.strictEqual(occurrence?.declaration?.module, expectedModule, spelling)
    }
  }),
)

it.effect(
  'resolves the bounded byte duplex and scripted memory provider surfaces',
  () =>
    Effect.gen(function* () {
      const source = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.byte_duplex { ByteDuplex, ByteIoError, ReadTransfer }
import silk.bytes { Bytes }
import silk.effect { Effect }
import silk.memory_byte_duplex { MemoryByteDuplex, MemoryReadEvent, MemoryWriteAction, MemoryWriteEvent }
import silk.monotonic_clock { MonotonicClock }
import silk.option { Option }
import silk.random { Random }
import silk.system_clock { SystemClock }
import silk.tls_client { ClientConfig }
import silk.tls_connection { OwnedConnection, ConnectionError, ConnectionOptions, ConnectionPhase, withClient }
import silk.trust_snapshot { TrustSnapshot }
import silk.vector { Vector }
service Audit { effect fn record() -> () ? &mut Audit }
effect fn makeProvider() -> MemoryByteDuplex ! OutOfMemoryError ? &mut Allocator {
  let data = run Bytes.copy(&b"hello")
  let mut reads = Vector<MemoryReadEvent>.make()
  run Vector<MemoryReadEvent>.append(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(1, 0),
    bytes: move data,
  })
  let mut writes = Vector<MemoryWriteEvent>.make()
  run Vector<MemoryWriteEvent>.append(&mut writes, MemoryWriteEvent {
    readyAt: SystemClock.make(1, 0),
    action: MemoryWriteAction.Accept {count: 2},
  })
  return run MemoryByteDuplex.make(move reads, move writes, 16, 8, Option<i32>.none())
}
effect fn authenticated<P>(
  connection: &mut OwnedConnection<P>
) -> i32 ? &mut Audit {
  if connection.phase() == ConnectionPhase.Invalid { return 0 }
  run Audit.record()
  return 42
}
pub fn main() -> i32 { return 42 }`
      const snapshot = yield* AnalysisFixture.retainingMain(
        'stdlib-namespace/byte-duplex',
        ascii(source),
      )
      const index = Analysis.declarationIndex(snapshot)
      const module = index.modules.find((candidate) => candidate.module === 'silk/byte_duplex')
      const service = module?.services.find(
        (candidate) =>
          candidate.name._tag === 'Present' && candidate.name.spelling === 'ByteDuplex',
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      assert.deepEqual(
        service?.operations.map((operation) => ({
          name: operation.name._tag === 'Present' ? operation.name.spelling : 'missing',
          unsafe: operation.unsafe,
          properties: operation.staticProperties,
        })),
        [
          { name: 'readSomeRaw', unsafe: true, properties: [] },
          { name: 'writeSomeRaw', unsafe: true, properties: [] },
          { name: 'flushRaw', unsafe: true, properties: [] },
          { name: 'shutdownWriteRaw', unsafe: true, properties: [] },
          { name: 'closeRaw', unsafe: true, properties: ['Intrinsic.NonParking'] },
        ],
      )
      const wrappers = new Map(
        (module?.declarations ?? []).flatMap((declaration) =>
          declaration.associatedMember?.owner?.name === 'ByteDuplex'
            ? [[declaration.associatedMember.name, DeclarationFacts.callableContract(declaration)]]
            : [],
        ),
      )
      for (const name of ['readSome', 'writeSome', 'flush', 'shutdownWrite'] as const) {
        const result = wrappers.get(name)?.result
        assert.isTrue(result !== undefined && Type.isEffect(result), name)
        if (result === undefined || !Type.isEffect(result)) continue
        assert.deepEqual(Type.failureMembers(result).map(Type.encode), [
          'silk/byte_duplex.ByteIoError',
        ])
        assert.deepEqual(
          Type.requirementMembers(result).map((requirement) => ({
            capability: Type.encode(requirement.capability),
            access: requirement.access,
          })),
          [
            { capability: 'silk/byte_duplex.ByteDuplex', access: 'Exclusive' },
            { capability: 'silk/monotonic_clock.MonotonicClock', access: 'Exclusive' },
          ],
        )
      }
      const closeResult = wrappers.get('close')?.result
      assert.isTrue(closeResult !== undefined && Type.isEffect(closeResult))
      if (closeResult !== undefined && Type.isEffect(closeResult)) {
        assert.deepEqual(Type.failureMembers(closeResult).map(Type.encode), [
          'silk/byte_duplex.ByteIoError',
        ])
        assert.deepEqual(
          Type.requirementMembers(closeResult).map((requirement) =>
            Type.encode(requirement.capability),
          ),
          ['silk/byte_duplex.ByteDuplex'],
        )
      }
      const tlsModule = index.modules.find(
        (candidate) => candidate.module === 'silk/tls_connection',
      )
      const ownedConnection = tlsModule?.structs.find(
        (candidate) =>
          candidate.name._tag === 'Present' && candidate.name.spelling === 'OwnedConnection',
      )
      assert.deepEqual(
        ownedConnection?.fields.map((field) => field.visibility),
        ['Private', 'Private', 'Private'],
      )
      const authenticateOwned = tlsModule?.declarations.find(
        (declaration) =>
          declaration.name._tag === 'Present' && declaration.name.spelling === 'authenticateOwned',
      )
      assert.isDefined(authenticateOwned)
      if (authenticateOwned !== undefined) {
        const contract = DeclarationFacts.callableContract(authenticateOwned)
        assert.strictEqual(
          Type.encode(contract.parameters.at(2)?.type ?? 'never'),
          'silk/trust_snapshot.TrustSnapshot',
        )
        assert.isTrue(Type.isEffect(contract.result))
        if (!Type.isEffect(contract.result)) return
        assert.deepEqual(Type.failureMembers(contract.result).map(Type.encode), [
          'silk/allocator.OutOfMemoryError',
          'silk/tls_connection.ConnectionError',
        ])
        assert.deepEqual(
          Type.requirementMembers(contract.result).map((requirement) =>
            Type.encode(requirement.capability),
          ),
          [
            'silk/allocator.Allocator',
            'silk/monotonic_clock.MonotonicClock',
            'silk/random.Random',
            'silk/system_clock.SystemClock',
          ],
        )
      }
      const connectionOperations = (tlsModule?.declarations ?? []).filter(
        (declaration) => declaration.associatedMember?.owner?.name === 'OwnedConnection',
      )
      for (const name of ['readSome', 'writeSome', 'flush', 'shutdownWrite'] as const) {
        const operation = connectionOperations.find(
          (declaration) => declaration.associatedMember?.name === name,
        )
        const result =
          operation === undefined ? undefined : DeclarationFacts.callableContract(operation).result
        assert.isTrue(result !== undefined && Type.isEffect(result), name)
        if (result === undefined || !Type.isEffect(result)) continue
        assert.deepEqual(
          Type.requirementMembers(result).map((requirement) => Type.encode(requirement.capability)),
          ['silk/allocator.Allocator', 'silk/monotonic_clock.MonotonicClock', 'silk/random.Random'],
        )
      }
      const connectionClose = connectionOperations.find(
        (declaration) => declaration.associatedMember?.name === 'close',
      )
      const connectionCloseResult =
        connectionClose === undefined
          ? undefined
          : DeclarationFacts.callableContract(connectionClose).result
      assert.isTrue(connectionCloseResult !== undefined && Type.isEffect(connectionCloseResult))
      if (connectionCloseResult !== undefined && Type.isEffect(connectionCloseResult)) {
        assert.deepEqual(Type.failureMembers(connectionCloseResult).map(Type.encode), [
          'silk/tls_connection.ConnectionError',
        ])
        assert.deepEqual(Type.requirementMembers(connectionCloseResult), [])
      }
      const withClient = tlsModule?.declarations.find(
        (declaration) =>
          declaration.name._tag === 'Present' && declaration.name.spelling === 'withClient',
      )
      assert.isDefined(withClient)
      if (withClient !== undefined) {
        const contract = DeclarationFacts.callableContract(withClient)
        assert.include(
          Type.encode(contract.parameters.at(4)?.type ?? 'never'),
          'CallbackRequirements',
        )
        assert.include(Type.encode(contract.parameters.at(4)?.type ?? 'never'), 'OwnedConnection')
        assert.include(Type.encode(contract.result), 'CallbackRequirements')
        const exclusion = withClient.constraints.find(
          (constraint) =>
            constraint._tag === 'MembershipConstraint' && constraint.domain === 'Requirement',
        )
        assert.strictEqual(exclusion?.selected._tag, 'RowParameterExpression')
        if (exclusion?.selected._tag === 'RowParameterExpression')
          assert.strictEqual(exclusion.selected.parameter.name, 'CallbackRequirements')
        assert.strictEqual(exclusion?.source._tag, 'WithoutRowExpression')
        if (exclusion?.source._tag === 'WithoutRowExpression') {
          assert.strictEqual(exclusion.source.source._tag, 'RowParameterExpression')
          assert.strictEqual(exclusion.source.selected._tag, 'RequirementMemberExpression')
        }
      }

      const bypassSource = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.byte_duplex { ByteDuplex }
import silk.effect { Effect }
import silk.memory_byte_duplex { MemoryByteDuplex }
import silk.monotonic_clock { MonotonicClock }
import silk.ownership { Copy }
import silk.random { Random }
import silk.system_clock { SystemClock }
import silk.tls_client { ClientConfig }
import silk.tls_connection { OwnedConnection, ConnectionError, ConnectionOptions, withClient }
import silk.trust_snapshot { TrustSnapshot }
impl Copy for OwnedConnection<MemoryByteDuplex> {}
fn forgeOwner() -> OwnedConnection<MemoryByteDuplex> {
  return OwnedConnection<MemoryByteDuplex> {}
}
fn rawProvider(owner: &OwnedConnection<MemoryByteDuplex>) -> () {
  drop owner.provider
  return ()
}
fn rawProvenance(owner: &OwnedConnection<MemoryByteDuplex>) -> () {
  drop owner.provenance
  return ()
}
fn substituteProvider(
  owner: &mut OwnedConnection<MemoryByteDuplex>,
  replacement: MemoryByteDuplex,
) -> () {
  owner.provider = move replacement
  return ()
}
effect<'call> fn leakOwner<'call>(
  owner: &'call mut OwnedConnection<MemoryByteDuplex>,
) -> &'call mut OwnedConnection<MemoryByteDuplex> {
  return move owner
}
effect fn escapeOwner<'env>(
  transport: MemoryByteDuplex,
  config: &ClientConfig,
  trust: TrustSnapshot,
  options: ConnectionOptions,
) -> &'env mut OwnedConnection<MemoryByteDuplex>
! ConnectionError | OutOfMemoryError
? &mut SystemClock | &mut MonotonicClock | &mut Allocator | &mut Random {
  return run withClient<&'env mut OwnedConnection<MemoryByteDuplex>, never>(
    move transport,
    config,
    move trust,
    move options,
    leakOwner,
  )
}
effect fn bypass(
  connection: &mut OwnedConnection<MemoryByteDuplex>
) -> i32 ? &mut ByteDuplex {
  drop connection
  let closed = run Effect.result(ByteDuplex.close())
  drop closed
  return 42
}
effect fn rejected(
  transport: MemoryByteDuplex,
  config: &ClientConfig,
  trust: TrustSnapshot,
  options: ConnectionOptions,
) -> i32
! ConnectionError | OutOfMemoryError
? &mut SystemClock
  | &mut MonotonicClock
  | &mut Allocator
  | &mut Random
{
  return run withClient<i32, never>(move transport, config, move trust, move options, bypass)
}
pub fn main() -> i32 { return 42 }`
      const bypassSnapshot = yield* AnalysisFixture.retainingMain(
        'stdlib-namespace/byte-duplex-bypass',
        ascii(bypassSource),
      )
      const bypassDiagnostics = Analysis.diagnostics(bypassSnapshot)
      assert.deepEqual(
        bypassDiagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          span: bypassSource.slice(diagnostic.span.start, diagnostic.span.end).trim(),
        })),
        [
          { code: 'SEM0083', span: 'impl Copy for OwnedConnection<MemoryByteDuplex> {}' },
          { code: 'SEM0021', span: 'OwnedConnection<MemoryByteDuplex> {}' },
          { code: 'SEM0028', span: 'provider' },
          { code: 'SEM0028', span: 'provenance' },
          { code: 'SEM0028', span: 'provider' },
          {
            code: 'SEM0074',
            span: "withClient<&'env mut OwnedConnection<MemoryByteDuplex>, never>(\n    move transport,\n    config,\n    move trust,\n    move options,\n    leakOwner,\n  )",
          },
          {
            code: 'SEM0074',
            span: 'withClient<i32, never>(move transport, config, move trust, move options, bypass)',
          },
        ],
      )
    }),
  // Both the accepted callback and the bypass rejection analyze the TLS dependency graph.
  180_000,
)

it.effect('resolves selected scope actors for nonprimitive operation modules', () =>
  Effect.gen(function* () {
    const source = `import silk.execution { Execution }
import silk.format { Format }
import silk.hash { Hash }
import silk.metrics { Metrics }
import silk.numeric { Numeric }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
import silk.unicode { Unicode }
import silk.unicode_tables { UnicodeTables }

fn rawCount(buffer: &Intrinsic.RawBuffer<i32>) -> usize {
  unsafe { return RawBuffer.count<i32>(buffer) }
  return 0
}

fn take(slot: Intrinsic.Slot<i32>) -> i32 {
  unsafe { return Slot.take<i32>(move slot) }
  return 0
}

fn notify(execution: &mut Intrinsic.Execution<i32>) -> () {
  return Execution.notifyInitial<i32>(move execution)
}

pub fn main() -> i32 {
  let parsed = Format.signedValue("42")
  let seed = Hash.seed(17)
  let metrics = Metrics.make()
  let answer = Numeric.add<i32>(40, 2)
  let unicodeVersion = Unicode.dataVersion()
  let tableVersion = UnicodeTables.dataVersion()
  drop parsed
  drop seed
  drop metrics
  drop unicodeVersion
  drop tableVersion
  return answer
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib-namespace/scope-actors',
      ascii(source),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)

it.effect('consumes SHA and HMAC states when finish finalizes them', () =>
  Effect.gen(function* () {
    const source = `import silk.sha2 { Sha256 }
import silk.hmac { HmacSha256, HmacSha384 }
pub fn main() -> i32 {
  let empty: [u8; 0] = []
  let mut state = Sha256.make()
  state.update(&empty)
  let checkpoint = state.checkpoint()
  state.update(&empty)
  let checkpointAgain = state.checkpoint()
  let digest = state.finish()
  state.update(&empty)
  drop checkpoint
  drop checkpointAgain
  drop digest
  let mut hmac256 = HmacSha256.make(&empty)
  let tag256 = hmac256.finish()
  hmac256.update(&empty)
  drop tag256
  let hmac384 = HmacSha384.make(&empty)
  let tag384 = hmac384.finish()
  let again = hmac384.finish()
  drop tag384
  drop again
  return 42
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib-namespace/consuming-sha-finish',
      ascii(source),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['OWN0001', 'OWN0001', 'OWN0001'],
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) =>
        source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      ),
      ['state', 'hmac256', 'hmac384'],
    )
  }),
)

it.effect('rejects overlapping ChaCha20-Poly1305 input and output borrows', () =>
  Effect.gen(function* () {
    const source = `import silk.chacha20_poly1305 { ChaCha20Poly1305 }
pub fn main() -> i32 {
  let key: [u8; 0] = []
  let mut output: [u8; 0] = []
  let mut tag: [u8; 0] = []
  let sealed = ChaCha20Poly1305.seal(&key, &key, &key, &key, &mut output, &mut output)
  let opened = ChaCha20Poly1305.open(&key, &key, &key, &output, &tag, &mut output)
  drop sealed
  drop opened
  return 42
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib-namespace/chacha20-poly1305',
      ascii(source),
    )
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['OWN0010', 'OWN0010'],
    )
    assert.deepEqual(
      diagnostics.map((diagnostic) =>
        source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      ),
      ['&mut output', '&mut output'],
    )
  }),
)

it.effect('rejects overlapping Base64 input and output borrows', () =>
  Effect.gen(function* () {
    const source = `import silk.base64 { Base64 }
pub fn main() -> i32 {
  let mut bytes: [u8; 4] = [90, 103, 61, 61]
  let encoded = Base64.encodeInto(&mut bytes, &bytes)
  let decoded = Base64.decodeInto(&mut bytes, &bytes)
  drop encoded
  drop decoded
  return 42
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib-namespace/base64-overlapping-borrows',
      ascii(source),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['OWN0010', 'OWN0010'],
    )
  }),
)

it.effect('enforces P-256 scalar ownership and explicit Random', () =>
  Effect.gen(function* () {
    const source = `import silk.p256 { P256, P256Error }
import silk.result { Result }
pub fn consume() -> i32 {
  let bytes: [u8; 32] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1]
  let admitted = P256.fromBytes(&bytes)
  return match move admitted {
    Result<P256, P256Error>.Success { value: scalar } => {
      let publicKey = scalar.publicKey()
      let shared = scalar.agree(&publicKey)
      drop shared
      let again = scalar.publicKey()
      drop again
      return 42
    }
    Result<P256, P256Error>.Failure { error } => 1
  }
}
pub effect fn main() -> i32 {
  let scalar = run P256.generate()
  drop scalar
  return consume()
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib-namespace/p256-owner-and-random',
      ascii(source),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        text: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'OWN0001', text: 'scalar' },
        { code: 'SEM0071', text: 'run P256.generate()' },
      ],
    )
  }),
)

it.effect('verifies ECDSA messages without providers or retained input loans', () =>
  Effect.gen(function* () {
    const source = `import silk.p256 { EcdsaP256Sha256 }
pub fn main() -> i32 {
  let mut key: [u8; 1] = [0]
  let mut message: [u8; 1] = [0]
  let mut signature: [u8; 1] = [0]
  let result = EcdsaP256Sha256.verify(&key, &message, &signature)
  key[0] = 1
  message[0] = 1
  signature[0] = 1
  drop result
  let again = EcdsaP256Sha256.verify(&key, &message, &signature)
  drop again
  return 42
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib-namespace/ecdsa-borrowed-inputs',
      ascii(source),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)

it.effect('keeps admitted RSA public key representation private', () =>
  Effect.gen(function* () {
    const source = `import silk.rsa { RsaPublicKey }
fn width(key: &RsaPublicKey) -> usize {return key.width}
pub fn main() -> i32 {return 0}`
    const snapshot = yield* AnalysisFixture.retainingMain('stdlib-namespace/rsa', ascii(source))
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.deepEqual(
      diagnostics.map((d) => d.code),
      ['SEM0028'],
    )
    assert.deepEqual(
      diagnostics.map((d) => source.slice(d.span.start, d.span.end)),
      ['width'],
    )
  }),
)

it.effect('checks TLS digest widths and rejects overlapping secret/output borrows', () =>
  Effect.gen(function* () {
    const source = `import silk.tls_hkdf { TlsHkdfSha256 }
pub fn main() -> i32 {
  let mut secret: [u8; 32] = [${Array.from({ length: 32 }, () => 0).join(', ')}]
  let wrong: [u8; 48] = [${Array.from({ length: 48 }, () => 0).join(', ')}]
  let label: [u8; 1] = [1]
  let empty: [u8; 0] = []
  let badHash = TlsHkdfSha256.deriveSecretFromHash(&secret, &label, &wrong)
  let overlap = TlsHkdfSha256.expandLabel(&secret, &label, &empty, &mut secret)
  drop badHash
  drop overlap
  return 0
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'stdlib-namespace/tls-contracts',
      ascii(source),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((d) => ({
        code: d.code,
        span: source.slice(d.span.start, d.span.end),
      })),
      [
        { code: 'SEM0056', span: 'wrong' },
        { code: 'OWN0010', span: '&mut secret' },
      ],
    )
  }),
)

it.effect(
  'keeps TLS record views tied to their receive owner and rotates epochs by ownership',
  () =>
    Effect.gen(function* () {
      const source = `import silk.tls_record { CipherSuite, TlsRecordReceiver, TlsRecordSender }
fn inspect(receiver: &mut TlsRecordReceiver, input: &[u8]) -> i32 {
  let record = TlsRecordReceiver.record(&receiver.*)
  let progress = TlsRecordReceiver.feedInput(move receiver, input)
  drop record
  drop progress
  return 42
}
fn rotateSender(sender: &mut TlsRecordSender, secret: &[u8]) -> i32 {
  let replaced = TlsRecordSender.replaceEpoch(
    &mut sender.*,
    CipherSuite.Aes128GcmSha256,
    secret,
  )
  let remaining = sender.recordsRemaining()
  let pending = sender.pendingOutput()
  drop replaced
  drop remaining
  drop pending
  return 42
}
fn rotateReceiver(receiver: &mut TlsRecordReceiver, secret: &[u8]) -> i32 {
  let replaced = TlsRecordReceiver.replaceEpoch(
    &mut receiver.*,
    CipherSuite.Aes128GcmSha256,
    secret,
  )
  let record = receiver.record()
  drop replaced
  drop record
  return 42
}
pub fn main() -> i32 { return 42 }`
      const snapshot = yield* AnalysisFixture.retainingMain(
        'stdlib-namespace/tls-record-view',
        ascii(source),
      )
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => ({
          code: diagnostic.code,
          span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
        })),
        [{ code: 'OWN0011', span: 'receiver' }],
      )
    }),
)

it.effect(
  'pins the authenticated TLS client provider row and output lifetime',
  () =>
    Effect.gen(function* () {
      const source = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.random { Random }
import silk.result { Result }
import silk.system_clock { Instant }
import silk.tls_client { Client, ClientConfig, TlsError }
import silk.trust_snapshot { TrustSnapshot }
import silk.usize
effect fn construct<'a>(config: &ClientConfig<'a>, trust: TrustSnapshot, time: Instant) -> Result<Client, TlsError>
! OutOfMemoryError
? &mut Allocator | &mut Random {
  return run Client.make(config, move trust, move time)
}
fn retainAcrossMutation(client: &mut Client) -> usize {
  let pending = Client.pendingOutput(&client.*)
  drop Client.ackWritten(&mut client.*, usize.ZERO)
  return pending.length
}
pub fn main() -> i32 { return 42 }`
      const snapshot = yield* AnalysisFixture.retainingMain(
        'stdlib-namespace/authenticated-tls-client',
        ascii(source),
      )
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => ({
          code: diagnostic.code,
          span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
        })),
        [{ code: 'OWN0010', span: '&mut client.*' }],
      )
    }),
  120_000,
)
