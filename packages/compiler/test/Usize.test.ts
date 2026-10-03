import { unreachable } from './support/raise.js'
import { nativeCorpus } from './support/corpus.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Layout from '../src/Layout.js'
import * as LayoutVerify from '../src/LayoutVerify.js'
import type * as Mir from '../src/Mir.js'
import * as MirVerification from '../src/MirVerification.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const source = (text: string, target: string) =>
  Analysis.ofSourceRealized('usize/program', ascii(text), target)

const nativeExact =
  nativeCorpus.find((program) => program.name === 'usize-exact-native-i64-call')?.source ??
  unreachable('expected the usize-exact-native-i64-call native corpus case')

const sharedUnsigned = `import silk.usize
fn maximum() -> usize { return 4294967293 |> usize.add(2) }
pub fn main() -> i32 {
  if maximum() > 2147483647 { return 42 }
  return 0
}`

it.effect('retains exact contextual magnitudes and target-owned usize layout facts', () =>
  Effect.gen(function* () {
    const snapshot = yield* source(nativeExact, 'aarch64-apple-darwin')
    assert.deepEqual(snapshot.diagnostics, [])

    const integers = Analysis.expressionsOf(snapshot, 'usize/program').flatMap((expression) =>
      expression._tag === 'IntegerLiteral' ? [expression] : [],
    )
    assert.include(
      integers.map((integer) => integer.value),
      9007199254740993n,
    )
    const plan = Analysis.layoutOf(snapshot)
    assert.strictEqual(plan._tag, 'Available')
    if (plan._tag !== 'Available') return
    const usize = Layout.entry(plan.value, 'usize')
    assert.deepEqual(usize?.representation, { _tag: 'UnsignedInteger', bits: 64 })
    // The program's own three usize literals. Reached library modules contribute their own
    // verdicts — silk/usize's shared ZERO and ONE among them — so the count names this module.
    assert.strictEqual(
      plan.value.literalVerdicts.filter((verdict) => verdict.span.sourceId === 'usize/program')
        .length,
      3,
    )
    assert.strictEqual(
      plan.value.literalVerdicts.every((verdict) => verdict._tag === 'AvailableWordLiteral'),
      true,
    )
  }),
)

it.effect('rejects an exact usize magnitude outside the selected target before MIR', () =>
  Effect.gen(function* () {
    const snapshot = yield* source(
      'fn wide() -> usize { return 4294967296 } pub fn main() -> i32 { if wide() == 0 { return 1 } return 0 }',
      'wasm32-unknown-unknown',
    )

    assert.deepEqual(
      snapshot.diagnostics.map((diagnostic) => diagnostic.code),
      ['LAY0001'],
    )
    const diagnostic = snapshot.diagnostics.at(0)
    assert.strictEqual(diagnostic?.reason._tag, 'WordLiteralOutOfRange')
    if (diagnostic?.reason._tag === 'WordLiteralOutOfRange') {
      assert.strictEqual(diagnostic.reason.type, 'usize')
      assert.strictEqual(diagnostic.reason.spelling, '4294967296')
      assert.strictEqual(diagnostic.reason.bits, 32)
      assert.strictEqual(diagnostic.reason.target, 'wasm32-unknown-unknown')
    }
    assert.strictEqual(Analysis.mirOf(snapshot)._tag, 'Unavailable')
  }),
)

it.effect('lowers native usize lanes and operations as unsigned i64', () =>
  Effect.gen(function* () {
    const snapshot = yield* source(nativeExact, 'aarch64-apple-darwin')
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })

    assert.include(artifact.ir, 'i64 9007199254740993')
    assert.include(artifact.ir, 'llvm.uadd.with.overflow.i64')
    assert.include(artifact.ir, 'icmp eq i64')
  }),
)

it.effect('lowers WebAssembly usize lanes and comparisons as unsigned i32 through LLVM', () =>
  Effect.gen(function* () {
    const snapshot = yield* source(sharedUnsigned, 'wasm32-unknown-unknown')
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })

    assert.strictEqual(artifact.target.id, 'wasm32-unknown-unknown')
    assert.include(artifact.ir, 'llvm.uadd.with.overflow.i32')
    assert.include(artifact.ir, 'icmp ugt i32')
  }),
)

it.effect('guards wasm32 usize overflow and division by zero in LLVM IR', () =>
  Effect.gen(function* () {
    const compile = Effect.fnUntraced(function* (expression: string) {
      const snapshot = yield* source(
        `fn invalid() -> usize { return ${expression} }
pub fn main() -> i32 { if invalid() == 0 { return 1 } return 0 }`,
        'wasm32-unknown-unknown',
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      return yield* Analysis.codegen(snapshot, { mode: 'release' })
    })
    const overflow = yield* compile('4294967295 + 1')
    const division = yield* compile('1 / 0')

    assert.include(overflow.ir, 'llvm.uadd.with.overflow.i32')
    assert.include(overflow.ir, '@llvm.trap()')
    assert.include(division.ir, 'udiv i32')
    assert.include(division.ir, '@llvm.trap()')
  }),
)

it.effect('rejects the exact native i64 magnitude for the WebAssembly target', () =>
  Effect.gen(function* () {
    const wasm = yield* source(nativeExact, 'wasm32-unknown-unknown')
    assert.include(
      wasm.diagnostics.map((diagnostic) => diagnostic.code),
      'LAY0001',
    )
    assert.strictEqual(Analysis.mirOf(wasm)._tag, 'Unavailable')
  }),
)

it.effect('discovers one generic usize instance independently of literal magnitude', () =>
  Effect.gen(function* () {
    const snapshot = yield* source(
      `fn identity<T>(value: T) -> T { return move value }
pub fn main() -> i32 {
  if identity<usize>(1) + identity<usize>(4294967294) == 4294967295 { return 42 }
  return 0
}`,
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(snapshot.diagnostics, [])
    const identities = Analysis.instancesOf(snapshot).instances.filter(
      (instance) => instance.key.declaration.name === 'identity',
    )
    assert.strictEqual(identities.length, 1)
    assert.deepEqual(identities.at(0)?.key.typeArguments, ['usize'])
  }),
)

it.effect('reads mixed usize and i32 union storage at native and Wasm widths', () =>
  Effect.gen(function* () {
    const program = `struct Wide { value: usize }
struct Narrow { value: i32 }
fn decode(flag: bool) -> Wide | Narrow {
  if flag { return Wide { value: 4294967295 } }
  return Narrow { value: 7 }
}
fn inspect(input: Wide | Narrow) -> i32 {
  return match &input {
    Wide { value } if value > 2147483647 => 42
    Wide { value } => 0
    Narrow { value } => value
  }
}
pub fn main() -> i32 { return inspect(decode(true)) }`
    const native = yield* source(program, 'aarch64-apple-darwin')
    const wasm = yield* source(program, 'wasm32-unknown-unknown')
    assert.deepEqual(native.diagnostics, [])
    assert.deepEqual(wasm.diagnostics, [])

    const nativeArtifact = yield* Analysis.codegen(native, { mode: 'release' })
    const wasmArtifact = yield* Analysis.codegen(wasm, { mode: 'release' })
    const inspectBody = /define[^\n]+@silk_usize_program_inspect__[^\n]+\n([\s\S]*?)\n}/
    const nativeInspect =
      nativeArtifact.ir.match(inspectBody)?.[1] ?? unreachable('expected native inspect')
    const wasmInspect =
      wasmArtifact.ir.match(inspectBody)?.[1] ?? unreachable('expected Wasm inspect')
    // Union values travel by address; each branch reads its selected member's native layout.
    assert.match(nativeInspect, /_payload = getelementptr i8, ptr %\w+, i32 8/)
    assert.match(
      nativeInspect,
      /%(\w+) = load i64, ptr %\w+, align 8\n\s+%\w+ = icmp ugt i64 %\1, 2147483647/,
    )
    assert.match(nativeInspect, /copy\w+ = load i32, ptr %\w+, align 4/)
    assert.match(wasmInspect, /_payload = getelementptr i8, ptr %\w+, i32 4/)
    assert.match(
      wasmInspect,
      /%(\w+) = load i32, ptr %\w+, align 4\n\s+%\w+ = icmp ugt i32 %\1, 2147483647/,
    )
    assert.match(wasmInspect, /copy\w+ = load i32, ptr %\w+, align 4/)
    assert.strictEqual(wasmArtifact.target.id, 'wasm32-unknown-unknown')
  }),
)

it.effect('rejects malformed usize target verdicts and MIR literals as verifier data', () =>
  Effect.gen(function* () {
    const snapshot = yield* source(sharedUnsigned, 'wasm32-unknown-unknown')
    const layout = Analysis.layoutOf(snapshot)
    assert.strictEqual(layout._tag, 'Available')
    if (layout._tag !== 'Available') return
    const first = layout.value.literalVerdicts.at(0)
    if (first === undefined) return assert.fail('expected a usize literal verdict')
    const malformedLayout: Layout.Plan = {
      ...layout.value,
      literalVerdicts: [{ ...first, bits: 64 }],
    }
    assert.include(
      (yield* LayoutVerify.verify(malformedLayout)).map((violation) => violation.rule),
      'InvalidLiteralVerdict',
    )

    const program = Analysis.loweredMir(snapshot)
    const malformed: Mir.Module = {
      ...program,
      functions: program.functions.map((fn) => ({
        ...fn,
        regions: fn.regions.map((region) => {
          if (region._tag !== 'OperationRegion') return region
          return {
            ...region,
            operations: region.operations.map((operation) => {
              if (operation._tag !== 'Literal' || operation.type._tag !== 'usize') return operation
              return { ...operation, value: 4294967296n }
            }),
          }
        }),
      })),
    }
    assert.include(
      (yield* MirVerification.verify(malformed)).map((violation) => violation.rule),
      'InvalidIntegerOperation',
    )
  }),
)
