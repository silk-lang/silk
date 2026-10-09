import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Tir from '../src/Tir.js'
import * as InstanceDiagnostics from '../src/InstanceDiagnostics.js'
import * as Mir from '../src/Mir.js'
import * as MirVerification from '../src/MirVerification.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Type from '../src/Type.js'
import { unreachable } from './support/raise.js'
import * as Projections from './support/projections.js'

/**
 * The bound-operation call at a source witness.
 *
 * A bound reaches its operations two ways: through the operator that spells one, and through the
 * bound's own name for one no operator spells. A provider answers either with a sealed intrinsic or
 * with a function of its own actor. The two spellings and the two witness kinds are independent, so
 * every combination has to lower — and the non-operator call at a source witness is the one that
 * did not, because bound-operation lowering read only the intrinsic a witness named.
 */

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const analyzed = (
  name: string,
  source: string,
  target?: string,
  options?: Parameters<typeof Analysis.ofSourceRealized>[3],
) => AnalysisFixture.retainingMain(name, ascii(source), target, options)

const frontend = (name: string, source: string) => Analysis.ofSource(name, ascii(source))

const encodable = (head: string) => `${head} Encodable<A> { fn encode(value: &Self) -> A }
pub struct Age { pub value: i32 }
impl Encodable<i32> for Age {
  fn encode(value: &Self) -> i32 { return value.value }
}`

/** Analyzes a root beside one imported model module; the claims are frontend facts. */
const withModel = (root: string, source: string, model: string, modelSource: string) =>
  Analysis.make({ root }).pipe(
    Effect.provide(
      SourceResolver.memory(
        new Map([
          [root, ascii(source)],
          [model, ascii(modelSource)],
        ]),
      ),
    ),
  )

const messages = (snapshot: Analysis.FrontendSnapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.message)

it.effect(
  'selects concrete source witnesses for fallback, specialization, and Effect adaptation',
  () =>
    Effect.gen(function* () {
      const fallback = yield* analyzed(
        'interface-operation-witness/provider-evidence',
        `interface Seed<A> { fn seed() -> A }
interface Encodable<A> { fn encode(self: &Self) -> A }
struct Age { value: i32 }
interface Decoder { fn decode(value: Self) -> i32 }
fn decodeAge(value: &Age) -> i32 { return value.value }
impl Decoder for Age { decode: Age.decodeAge }
impl Seed<i32> for Age { fn seed() -> i32 { return 20 } }
impl Encodable<i32> for Age { fn encode(self: &Self) -> i32 { return self.value } }
fn seeded<T: Seed<i32>>() -> i32 { return Seed<i32>.seed() }
fn encodeConcrete<T: Encodable<i32>>(age: &Age) -> i32 {
  let encoded = Encodable<i32>.encode(&age.*)
  return (&age.*) |> Encodable<i32>.encode
}
pub fn main() -> i32 {
  let age = Age { value: 22 }
  return seeded<Age>() + encodeConcrete<Age>(&age) + Decoder.decode(move age)
}`,
      )
      assert.deepEqual(Analysis.diagnostics(fallback), [])
      const fallbackInstances = Analysis.instancesOf(fallback).instances.map(
        (instance) => instance.key.declaration.name,
      )
      assert.include(fallbackInstances, 'impl@1.seed')
      assert.include(fallbackInstances, 'impl@2.encode')
      assert.include(fallbackInstances, 'decodeAge')
      assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(fallback)), [])
      assert.isTrue(
        Analysis.loweredMir(fallback)
          .functions.flatMap(MirVerification.operations)
          .some((operation) => operation._tag === 'Call' && operation.target.name === 'decodeAge'),
      )

      const specialized = yield* analyzed(
        'bound-operation-witness/per-specialization',
        `interface Keyed { fn digest(left: &Self, right: &Self) -> i32 }
struct Cell { weight: i32 }
struct Tag { code: i32 }
fn cellDigest(left: &Cell, right: &Cell) -> i32 { return 10 }
fn tagDigest(left: &Tag, right: &Tag) -> i32 { return left.code + right.code }
impl Keyed for Cell { digest: Cell.cellDigest }
impl Keyed for Tag { digest: Tag.tagDigest }
fn digestOf<T: Keyed>(left: T, right: T) -> i32 { return Keyed.digest(&left, &right) }
pub fn main() -> i32 {
  let cell = digestOf<Cell>(Cell { weight: 1 }, Cell { weight: 2 })
  let tag = digestOf<Tag>(Tag { code: 30 }, Tag { code: 2 })
  return cell + tag
}`,
      )
      assert.deepEqual(Analysis.diagnostics(specialized), [])
      const targets = Analysis.instancesOf(specialized).instances.map(
        (instance) => instance.key.declaration.name,
      )
      assert.include(targets, 'cellDigest')
      assert.include(targets, 'tagDigest')

      const adapted = yield* analyzed(
        'bound-operation-witness/effect-operator-boundary',
        `interface Combined { operator + effect fn add(left: &Self, right: &Self) -> Self }
struct Cell { code: i32 }
fn cellAdd(left: &Cell, right: &Cell) -> Cell {
  return Cell { code: left.code + right.code }
}
impl Combined for Cell { add: Cell.cellAdd }
fn combined<T: Combined>(left: T, right: T) -> T { return run ((&left) + (&right)) }
pub fn main() -> i32 {
  let cell = combined<Cell>(Cell { code: 20 }, Cell { code: 1 })
  return cell.code + 21
}`,
      )
      assert.deepEqual(Analysis.diagnostics(adapted), [])
      assert.include(
        Analysis.instancesOf(adapted).instances.map((instance) => instance.key.declaration.name),
        'cellAdd',
      )
      assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(adapted)), [])
    }),
)

it.effect('keeps invalid applied interface operations out of realization', () =>
  Effect.gen(function* () {
    const prelude = `pub interface Encodable<A> {
  effect fn encode(self: &Self) -> A
}
struct Age { value: u32 }
struct Other { value: u32 }
impl Encodable<u32> for Age {
  effect fn encode(self: &Self) -> u32 { return self.value }
}`
    const escaping = yield* frontend(
      'interface-operation-witness/escaping-section',
      `${prelude}
pub fn main() -> i32 {
  let encoder = Encodable<u32>.encode
  return 0
}`,
    )
    assert.include(
      Analysis.diagnostics(escaping).map((diagnostic) => diagnostic.code),
      'SEM0099',
    )

    const missing = yield* frontend(
      'interface-operation-witness/missing-conformance',
      `${prelude}
pub fn main() -> i32 {
  let value = Other { value: 32 }
  let encoded = run Encodable<u32>.encode(&value)
  return 0
}`,
    )
    assert.include(
      Analysis.diagnostics(missing).map((diagnostic) => diagnostic.code),
      'SEM0121',
    )
    const calls = Projections.tirOf(
      missing,
      'interface-operation-witness/missing-conformance',
    )?.functions.flatMap((fn) =>
      fn.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)
        .filter((expression) => expression._tag === 'InterfaceOperationCall'),
    )
    assert.deepEqual(calls, [])

    const ambiguous = yield* frontend(
      'interface-operation-witness/ambiguous-fallback',
      `interface Seed<A> { fn seed() -> A }
fn ambiguous<A: Seed<i32>, B: Seed<i32>>() -> i32 {
  return Seed<i32>.seed()
}
pub fn main() -> i32 { return 0 }`,
    )
    assert.include(
      Analysis.diagnostics(ambiguous).map((diagnostic) => diagnostic.code),
      'SEM0097',
    )

    const appliedService = yield* frontend(
      'interface-operation-witness/applied-service',
      `service Source<A> { effect fn read() -> A ? &Source<A> }
pub fn main() -> i32 {
  let value = run Source<i32>.read()
  return 0
}`,
    )
    assert.include(
      Analysis.diagnostics(appliedService).map((diagnostic) => diagnostic.code),
      'SEM0010',
    )

    const resultDirected = yield* frontend(
      'interface-operation-witness/result-does-not-select',
      `interface Seed<A> { fn seed() -> A }
struct Age { value: i32 }
impl Seed<i32> for Age { fn seed() -> i32 { return 32 } }
fn selectedByResult() -> i32 { return Seed<i32>.seed() }
pub fn main() -> i32 { return 0 }`,
    )
    assert.include(
      Analysis.diagnostics(resultDirected).map((diagnostic) => diagnostic.code),
      'SEM0099',
    )

    const conflictingSelf = yield* frontend(
      'interface-operation-witness/conflicting-self',
      `interface Pair<A> { fn combine(left: &Self, right: &Self) -> A }
struct Age { value: i32 }
struct Other { value: i32 }
impl Pair<i32> for Age { fn combine(left: &Self, right: &Self) -> i32 { return 1 } }
pub fn main() -> i32 {
  let age = Age { value: 1 }
  let other = Other { value: 2 }
  let left = &age
  let right = &other
  return Pair<i32>.combine(left, right)
}`,
    )
    const conflict = Analysis.diagnostics(conflictingSelf).find(
      (diagnostic) => diagnostic.code === 'SEM0100',
    )
    assert.strictEqual(conflict?.reason._tag, 'TypeArgumentConflict')
    if (conflict?.reason._tag === 'TypeArgumentConflict') {
      assert.strictEqual(conflict.reason.parameter, 'Self')
      assert.include(conflict.reason.written, 'Age')
      assert.include(conflict.reason.implied, 'Other')
    }

    const invalidOwnerApplications: ReadonlyArray<readonly [string, string, string]> = [
      [
        'unknown-member',
        `${prelude}
pub fn main() -> i32 {
  let value = Age { value: 32 }
  let encoded = run Encodable<u32>.missing(&value)
  return 0
}`,
        'SEM0010',
      ],
      [
        'wrong-arity',
        `${prelude}
pub fn main() -> i32 {
  let value = Age { value: 32 }
  let encoded = run Encodable<u32, string>.encode(&value)
  return 0
}`,
        'SEM0051',
      ],
      [
        'wrong-kind',
        `interface Needs<?R> { fn inspect(self: &Self) -> i32 }
struct Age { value: i32 }
pub fn main() -> i32 {
  let age = Age { value: 32 }
  return Needs<i32>.inspect(&age)
}`,
        'SEM0088',
      ],
    ]
    for (const [name, source, code] of invalidOwnerApplications) {
      const snapshot = yield* frontend(`interface-operation-witness/${name}`, source)
      assert.include(
        Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
        code,
      )
    }
  }),
)

it.effect('indexes namespace-qualified applied interface owners without duplicate call paths', () =>
  Effect.gen(function* () {
    const module = 'interface-operation-witness/qualified-tooling'
    const source = `import model.Encoding
pub fn main() -> i32 {
  let age = Encoding.Age { value: 42 }
  let encoded = Encoding.Encodable<i32>.encode(&age)
  return (&age) |> Encoding.Encodable<i32>.encode
}`
    const snapshot = yield* withModel(module, source, 'model/Encoding', encodable('pub interface'))
    assert.deepEqual(messages(snapshot), [])

    const appliedOffset = source.indexOf('Encoding.Encodable<i32>.encode')
    const namespace = Analysis.semanticOccurrenceAt(snapshot, module, appliedOffset)
    const owner = Analysis.semanticOccurrenceAt(
      snapshot,
      module,
      appliedOffset + 'Encoding.'.length,
    )
    const operation = Analysis.semanticOccurrenceAt(
      snapshot,
      module,
      appliedOffset + 'Encoding.Encodable<i32>.'.length,
    )
    assert.strictEqual(namespace?.role, 'Actor')
    assert.strictEqual(namespace?.resolution._tag, 'Available')
    assert.strictEqual(owner?.role, 'Type')
    assert.strictEqual(owner?.resolution._tag, 'Available')
    assert.strictEqual(operation?.role, 'Operation')
    assert.strictEqual(operation?.resolution._tag, 'Available')

    const inaccessible = yield* withModel(
      `${module}/inaccessible`,
      `import model.Hidden
pub fn main() -> i32 {
  let age = Hidden.Age { value: 42 }
  return Hidden.Encodable<i32>.encode(&age)
}`,
      'model/Hidden',
      encodable('interface'),
    )
    assert.include(
      Analysis.diagnostics(inaccessible).map((diagnostic) => diagnostic.code),
      'SEM0009',
    )
    const inaccessibleCalls = Projections.tirOf(
      inaccessible,
      `${module}/inaccessible`,
    )?.functions.flatMap((fn) =>
      fn.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)
        .filter((expression) => expression._tag === 'InterfaceOperationCall'),
    )
    assert.deepEqual(inaccessibleCalls, [])
  }),
)

it.effect('lends owned operands to source witnesses without promising static storage', () =>
  Effect.gen(function* () {
    const source = `interface Decoder {
  fn decode(value: Self) -> i32
}

struct Cell { code: i32 }

fn decodeCell(value: &Cell) -> i32 { return value.code }

impl Decoder for Cell { decode: Cell.decodeCell }

interface StaticDecoder { fn decode(value: Self) -> i32 }
fn staticDecode(value: &'static Cell) -> i32 { return value.code }
impl StaticDecoder for Cell { decode: Cell.staticDecode }

interface BoundDecoder { fn decode(value: Self) -> i32 }
fn boundDecode<'a: 'static>(value: &'a Cell) -> i32 { return value.code }
impl BoundDecoder for Cell { decode: Cell.boundDecode }

pub fn main() -> i32 { return 0 }`
    const snapshot = yield* frontend(
      'bound-operation-witness/value-contract-borrowed-witness',
      source,
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        source: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'SEM0083', source: 'decode: Cell.staticDecode' },
        { code: 'SEM0083', source: 'decode: Cell.boundDecode' },
      ],
    )
  }),
)

it.effect('cleans an owned witness operand after success or failure', () =>
  Effect.gen(function* () {
    const self = yield* analyzed(
      'bound-operation-witness/owned-adapter-cleanup',
      `
struct Failed {}
struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
interface Decode { effect<'env> fn decode<'env>(value: Self) -> i32 ! Failed }
effect fn decode(value: &Token) -> i32 ! Failed {
  if value.value == 0 { fail Failed {} }
  return value.value
}
impl Decode for Token { decode: Token.decode }
effect fn program() -> i32 ! Failed { return run Decode.decode(Token { value: 42 }) }
effect fn recover(error: Failed) -> i32 { drop error return 0 }
pub fn main() -> i32 { return run Intrinsic.catchFailure<Failed>(program(), recover) }
`,
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    const mir = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const runner =
      mir.functions.find((fn) => fn.id.name === 'program$effect$0') ??
      unreachable('expected owned witness adapter runner')
    const operations = Mir.executionOperations({ entry: runner.entry, regions: runner.regions })
    const run = operations.find((operation) => operation._tag === 'RunStaticEffect')
    assert.strictEqual(run?._tag, 'RunStaticEffect')
    if (run?._tag !== 'RunStaticEffect') return
    assert.deepEqual(
      run.releases?.map((release) => [release.local.ordinal, release.cleanup._tag]),
      [[0, 'HookCleanup']],
    )
    assert.deepEqual(
      operations
        .filter((operation) => operation._tag === 'Drop')
        .map((operation) => [operation.local.ordinal, operation.cleanup._tag]),
      [[0, 'HookCleanup']],
    )
    const loan = operations.find(
      (operation) => operation._tag === 'BeginLoan' && operation.root.ordinal === 0,
    )
    assert.strictEqual(loan?._tag, 'BeginLoan')
    if (loan?._tag !== 'BeginLoan') return
    assert.deepEqual(
      run.failureLoanEnds?.map((end) => end.slice.ordinal),
      [loan.destination.ordinal],
    )
    const successEnd = operations.findIndex(
      (operation) =>
        operation._tag === 'EndLoan' && operation.slice.ordinal === loan.destination.ordinal,
    )
    assert.isAbove(successEnd, operations.indexOf(run))
    assert.isAbove(
      operations.findIndex((operation) => operation._tag === 'Drop'),
      successEnd,
    )
  }),
)

it.effect('requires explicit moves for operator-spelled value operands', () =>
  Effect.gen(function* () {
    const snapshot = yield* analyzed(
      'bound-operation-witness/operator-value-ownership',
      `interface Combined {
  operator + fn add(left: Self, right: Self) -> Self
}

struct Token { code: i32 }

fn tokenAdd(left: Token, right: Token) -> Token {
  return Token { code: left.code + right.code }
}

impl Combined for Token { add: Token.tokenAdd }

fn implicitTwice<T: Combined>(left: T, right: T) -> T {
  let first = left + right
  return left + right
}

pub fn main() -> i32 { return 0 }`,
    )
    assert.deepEqual(messages(snapshot), [
      'Moving left requires an explicit move',
      'Moving right requires an explicit move',
      'Moving left requires an explicit move',
      'Moving right requires an explicit move',
    ])
  }),
)

/**
 * The second half of #155, which outlives the lowering fix: a call that passes analysis and lowers
 * to nothing is a silent miscompile, because lowering answers an unlowerable call by dropping it
 * and the specialized instance then fails MIR validation with no diagnostic naming a cause.
 *
 * The conformance checker admits exactly the two witness kinds lowering knows, so no source the
 * frontend accepts reaches the state today — that agreement is the invariant, and it is precisely
 * what broke when witness admissibility widened in #142 while lowering kept reading only intrinsics.
 * The check is therefore driven against an index in which the named witness is absent, which is the
 * shape any future disagreement takes.
 */
const module = 'bound-operation-witness/unlowerable'

const witnessed = `interface Keyed {
  fn digest(left: &Self, right: &Self) -> u64
}

struct Cell { weight: i32 }

fn cellDigest(left: &Cell, right: &Cell) -> u64 { return 7 }

impl Keyed for Cell { digest: Cell.cellDigest }

fn digestOf<T: Keyed>(left: T, right: T) -> u64 { return Keyed.digest(&left, &right) }

pub fn main() -> i32 {
  let out = digestOf<Cell>(Cell { weight: 1 }, Cell { weight: 2 })
  if out == 7 { return 42 }
  return 1
}`

it.effect('reports a bound operation whose selected witness cannot be lowered', () =>
  Effect.gen(function* () {
    const reachable = yield* analyzed(module, witnessed)
    assert.deepEqual(messages(reachable), [])
    // The same program with the witness function absent: the conformance still names it, so the
    // call still checks, and the index has nothing to lower the call to.
    const absent = yield* analyzed(module, witnessed.replace('fn cellDigest', 'fn cellDigested'))
    const violations = InstanceDiagnostics.unlowerableWitnessViolations(
      Analysis.instancesOf(reachable),
      Analysis.declarationIndex(absent),
    )
    assert.deepEqual(
      violations.map((violation) => `${violation.code}: ${violation.message}`),
      [`SEM0101: Keyed.digest has no witness that can be lowered for ${module}.Cell`],
    )
    // The diagnostic points at the call the specialization cannot run, not at the conformance.
    assert.deepEqual(
      violations.map((violation) =>
        witnessed.slice(violation.span.start, violation.span.end).trim(),
      ),
      ['Keyed.digest(&left, &right)'],
    )
  }),
)

it.effect('reports nothing for either witness kind a conformance may name', () =>
  Effect.gen(function* () {
    // The check must not fire on source that lowers: a source witness, an intrinsic witness, and
    // the operator spelling of both.
    const sourceWitness = yield* analyzed(module, witnessed)
    const intrinsicWitness = yield* analyzed(
      'bound-operation-witness/intrinsic-unlowerable',
      `interface Keyed {
  fn digest(left: Self, right: Self) -> Self
}

impl Keyed for i32 { digest: Intrinsic.i32WrappingAdd }

fn digestOf<T: Keyed>(left: T, right: T) -> T {
  return Keyed.digest(move left, move right)
}

pub fn main() -> i32 { return digestOf<i32>(20, 22) }`,
    )
    for (const snapshot of [sourceWitness, intrinsicWitness]) {
      assert.deepEqual(messages(snapshot), [])
      assert.deepEqual(
        InstanceDiagnostics.unlowerableWitnessViolations(
          Analysis.instancesOf(snapshot),
          Analysis.declarationIndex(snapshot),
        ),
        [],
      )
    }
  }),
)

it.effect('preserves ownership and exact Effect rows through applied interface calls', () =>
  Effect.gen(function* () {
    const sourceModule = 'bound-operation-witness/applied-contract-shapes'
    const snapshot = yield* analyzed(
      sourceModule,
      `import silk.effect { Effect }
service Clock {}
struct Problem {}
interface Access<A> {
  fn consume(value: Self) -> A
  fn mutate(value: &mut Self) -> A
}
interface Pending<A> {
  effect fn read(value: &Self) -> A ! Problem ? &Clock
}
struct Cell { value: i32 }
impl Access<i32> for Cell {
  fn consume(value: Self) -> i32 { return value.value }
  fn mutate(value: &mut Self) -> i32 { value.value = 22 return value.value }
}
impl Pending<i32> for Cell {
  effect fn read(value: &Self) -> i32 { return value.value }
}
fn consume(value: Cell) -> i32 { return Access<i32>.consume(move value) }
fn mutate(value: &mut Cell) -> i32 { return Access<i32>.mutate(value) }
fn pending(value: &Cell) -> Effect<i32 ! Problem ? &Clock> {
  return Pending<i32>.read(value)
}
pub fn main() -> i32 {
  let owned = consume(Cell { value: 20 })
  let mut cell = Cell { value: 0 }
  return owned + mutate(&mut cell)
}`,
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
    const functions = Projections.tirOf(snapshot, sourceModule)?.functions ?? []
    const calls = functions.flatMap((fn) =>
      fn.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)
        .filter((expression) => expression._tag === 'InterfaceOperationCall'),
    )
    assert.deepEqual(
      calls.map((call) => ({
        operation: call.operation,
        parameters: call.contract.operands.map((operand) => operand.access),
        failures: call.contract.failureRow.failures.map(Type.encode),
        requirements: call.contract.requirementRow.requirements.map((requirement) => ({
          capability: Type.encode(requirement.capability),
          access: requirement.access,
        })),
      })),
      [
        { operation: 'consume', parameters: ['Take'], failures: [], requirements: [] },
        { operation: 'mutate', parameters: ['Exclusive'], failures: [], requirements: [] },
        {
          operation: 'read',
          parameters: ['Shared'],
          failures: [`${sourceModule}.Problem`],
          requirements: [{ capability: `${sourceModule}.Clock`, access: 'Shared' }],
        },
      ],
    )
  }),
)

it.effect('retains exact witness failure and requirement rows at interface boundaries', () =>
  Effect.gen(function* () {
    const callOf = (snapshot: Analysis.FrontendSnapshot, sourceModule: string, name: string) =>
      Projections.tirOf(snapshot, sourceModule)
        ?.functions.find(
          (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === name,
        )
        ?.statements.flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)
        .find((expression) => expression._tag === 'InterfaceOperationCall')

    const inlineModule = 'bound-operation-witness/inline-scalar-effect'
    const inline = yield* frontend(
      inlineModule,
      `struct Problem { code: i32 }
service Output { effect fn emit(number: i32) -> i32 ? &Output }
struct FixedOutput {}
effect fn emit(self: &FixedOutput, number: i32) -> i32 { return number }
impl Output for FixedOutput { emit: FixedOutput.emit }
interface Present { effect fn present(value: &Self) -> i32 ! Problem ? &Output }
impl Present for i32 {
  effect fn present(value: &Self) -> i32 ! Problem ? &Output { return run Output.emit(42) }
}
fn pending<T: Present>(value: &T) -> Effect<i32 ! Problem ? &Output> {
  return Present.present(value)
}

pub fn main() -> i32 { return 0 }`,
    )
    assert.deepEqual(Analysis.diagnostics(inline), [])
    const inlineCall = callOf(inline, inlineModule, 'pending')
    assert.strictEqual(inlineCall?._tag, 'InterfaceOperationCall')
    if (inlineCall?._tag === 'InterfaceOperationCall') {
      assert.deepEqual(inlineCall.contract.lifetimes.lifetimeBinders, [])
      const retainedParameters = (inlineCall.contract.lifetimes.typeOutlives ?? []).flatMap(
        (bound) => Type.parameters(bound.type),
      )
      assert.isTrue(retainedParameters.some((parameter) => parameter.name === 'T'))
      assert.isFalse(retainedParameters.some((parameter) => parameter.name === 'Self'))
      assert.deepEqual(inlineCall.contract.failureRow.failures.map(Type.encode), [
        `${inlineModule}.Problem`,
      ])
      assert.deepEqual(
        inlineCall.contract.requirementRow.requirements.map((requirement) => ({
          capability: Type.encode(requirement.capability),
          access: requirement.access,
        })),
        [{ capability: `${inlineModule}.Output`, access: 'Shared' }],
      )
    }

    const smallerModule = 'bound-operation-witness/smaller-effect-row'
    const smaller = yield* frontend(
      smallerModule,
      `struct Problem {}
struct Extra {}
interface Decoder { effect fn decode(value: &Self) -> i32 ! Problem | Extra }
struct Cell { code: i32 }
effect fn decodeCell(value: &Cell) -> i32 ! Problem { return value.code }
impl Decoder for Cell { decode: Cell.decodeCell }
fn pending<T: Decoder>(value: &T) -> Effect<i32 ! Problem | Extra> {
  return Decoder.decode(value)
}

pub fn main() -> i32 { return 0 }`,
    )
    assert.deepEqual(Analysis.diagnostics(smaller), [])
    const smallerCall = callOf(smaller, smallerModule, 'pending')
    assert.strictEqual(smallerCall?._tag, 'InterfaceOperationCall')
    if (smallerCall?._tag === 'InterfaceOperationCall')
      assert.deepEqual(smallerCall.contract.failureRow.failures.map(Type.encode), [
        `${smallerModule}.Extra`,
        `${smallerModule}.Problem`,
      ])

    const pureModule = 'bound-operation-witness/pure-effect-boundary'
    const pure = yield* frontend(
      pureModule,
      `struct Problem {}
interface Decoder { effect fn decode(value: &Self) -> i32 ! Problem }
struct Cell { code: i32 }
fn decodeCell(value: &Cell) -> i32 { return value.code }
impl Decoder for Cell { decode: Cell.decodeCell }
fn pending<T: Decoder>(value: &T) -> Effect<i32 ! Problem> {
  return Decoder.decode(value)
}

pub fn main() -> i32 { return 0 }`,
    )
    assert.deepEqual(Analysis.diagnostics(pure), [])
    const pureCall = callOf(pure, pureModule, 'pending')
    assert.strictEqual(pureCall?._tag, 'InterfaceOperationCall')
    if (pureCall?._tag === 'InterfaceOperationCall')
      assert.deepEqual(pureCall.contract.failureRow.failures.map(Type.encode), [
        `${pureModule}.Problem`,
      ])

    const accessModule = 'bound-operation-witness/requirement-access-widening'
    const access = yield* frontend(
      accessModule,
      `service Clock {}
service Meter {}
struct FixedClock {}
struct FixedMeter {}
impl Clock for FixedClock {}
impl Meter for FixedMeter {}
interface Decoder { effect fn decode(value: &mut Self) -> i32 ? &mut Clock | &Meter }
struct Cell { code: i32 }
effect fn readClock() -> i32 ? &Clock { return 42 }
effect fn decodeCell(value: &Cell) -> i32 ? &Clock { return run readClock() }
impl Decoder for Cell { decode: Cell.decodeCell }
fn pending<T: Decoder>(value: &mut T) -> mut Effect<i32 ? &mut Clock | &Meter> {
  return Decoder.decode(value)
}
pub fn main() -> i32 { return 0 }`,
    )
    assert.deepEqual(Analysis.diagnostics(access), [])
    const accessCall = callOf(access, accessModule, 'pending')
    assert.strictEqual(accessCall?._tag, 'InterfaceOperationCall')
    if (accessCall?._tag === 'InterfaceOperationCall')
      assert.deepEqual(
        accessCall.contract.requirementRow.requirements.map((requirement) => ({
          capability: Type.encode(requirement.capability),
          access: requirement.access,
        })),
        [
          { capability: `${accessModule}.Clock`, access: 'Exclusive' },
          { capability: `${accessModule}.Meter`, access: 'Shared' },
        ],
      )
  }),
)

it.effect('lowers weakened source-witness loans across operators and exclusive branches', () =>
  Effect.gen(function* () {
    const weakened = yield* analyzed(
      'bound-operation-witness/weaker-operator-access',
      `interface Combined { operator + fn add(left: &mut Self, right: &mut Self) -> Self }
struct Cell { code: i32 }
fn cellAdd(left: &Cell, right: &Cell) -> Cell {
  return Cell { code: left.code + right.code }
}
impl Combined for Cell { add: Cell.cellAdd }
fn combine<T: Combined>(left: T, right: T) -> T {
  let mut ownedLeft = move left
  let mut ownedRight = move right
  return (&mut ownedLeft) + (&mut ownedRight)
}
pub fn main() -> i32 {
  let out = combine<Cell>(Cell { code: 20 }, Cell { code: 22 })
  return out.code
}`,
    )
    assert.deepEqual(Analysis.diagnostics(weakened), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(weakened)), [])
    assert.include(
      Analysis.instancesOf(weakened).instances.map((instance) => instance.key.declaration.name),
      'cellAdd',
    )

    const replayed = yield* analyzed(
      'bound-operation-witness/replayed-source-operand',
      `service Counter { effect fn read(number: i32) -> i32 ? &Counter }
struct Fixed {}
effect fn read(self: &Fixed, number: i32) -> i32 { return number }
impl Counter for Fixed { read: Fixed.read }
interface Combined { operator + fn add(left: &mut Self, right: &mut Self) -> i32 }
struct Cell { code: i32 }
fn cellAdd(left: &Cell, right: &Cell) -> i32 { return left.code + right.code }
impl Combined for Cell { add: Cell.cellAdd }
effect<'env> fn branch<T: Combined + 'env, 'env>(flag: bool, left: T, right: T) -> i32 {
  let fixed = Fixed {}
  let mut ownedLeft = move left
  let mut ownedRight = move right
  let number = (&mut ownedLeft) + (&mut ownedRight)
  let pending = Intrinsic.bindRequirement<Counter>(Counter.read(number), &fixed)
  if flag { return run move pending }
  return run move pending
}
pub fn main() -> i32 {
  return (run branch<Cell>(true, Cell { code: 20 }, Cell { code: 22 }))
    + (run branch<Cell>(false, Cell { code: 19 }, Cell { code: 23 }))
}`,
    )
    assert.deepEqual(Analysis.diagnostics(replayed), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(replayed)), [])
    assert.isAtLeast(
      Analysis.loweredMir(replayed)
        .functions.flatMap(MirVerification.operations)
        .filter((operation) => operation._tag === 'EndLoan').length,
      2,
    )
  }),
)
