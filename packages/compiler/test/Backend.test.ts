import * as MirVerification from '../src/MirVerification.js'
import * as Result from 'effect/Result'
import * as LlvmBackend from '../src/LlvmBackend.js'
import * as Option from 'effect/Option'
import * as Tracer from 'effect/Tracer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { selectedForeignDollarSource } from './support/foreignDollarSymbol.js'
import * as ForeignContract from '../src/ForeignContract.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Backend from '../src/Backend.js'
import { unreachable } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const nestedSource = `pub fn identity(value: i32) -> i32 { return value }
pub fn main() -> i32 { return identity(identity(42)) }`

const scalarEnumNativeWidths = `enum(i8) Code8 { Selected = -1, Other = 1 }
enum(i16) Code16 { Selected = -300, Other = 2 }
enum(i32) Code32 { Selected = 70000, Other = 3 }
enum(i64) Code64 { Selected = 4294967297, Other = 4 }
fn identity8(value: Code8) -> Code8 { return value }
fn identity16(value: Code16) -> Code16 { return value }
fn identity32(value: Code32) -> Code32 { return value }
fn identity64(value: Code64) -> Code64 { return value }
pub fn main() -> i32 {
  let code8 = identity8(Code8.Selected)
  let unequal8 = code8 != Code8.Other
  let raw8 = Code8.value(code8)
  drop unequal8
  drop raw8
  let code16 = identity16(Code16.Selected)
  let unequal16 = code16 != Code16.Other
  let raw16 = Code16.value(code16)
  drop unequal16
  drop raw16
  let code32 = identity32(Code32.Selected)
  let unequal32 = code32 != Code32.Other
  let raw32 = Code32.value(code32)
  drop unequal32
  drop raw32
  let selected = identity64(Code64.Selected)
  let equal64 = selected == Code64.Selected
  let raw64 = Code64.value(selected)
  drop equal64
  drop raw64
  return match selected {
    Code64.Selected => 42
    Code64.Other => 5
  }
}`

const emit = Effect.fnUntraced(function* (text: string, request: Backend.CodegenRequest) {
  const snapshot = yield* AnalysisFixture.retainingMain(
    'golden/program',
    ascii(text),
    'aarch64-apple-darwin',
  )
  return yield* Analysis.codegen(snapshot, { ...request, verifyMir: true })
})

const golden = (name: string): string =>
  readFileSync(new URL(`./goldens/${name}`, import.meta.url), 'utf8')

it.effect('traces discovery, lowering, and optional verification separately from emission', () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.Span> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const snapshot = yield* AnalysisFixture.retainingMain(
      'trace/program',
      ascii(nestedSource),
      'aarch64-apple-darwin',
    ).pipe(Effect.withTracer(tracer))
    const program = Analysis.loweredMir(snapshot)
    const artifact = yield* Backend.emit(LlvmBackend.LlvmBackend, program, {
      mode: 'release',
    }).pipe(Effect.withTracer(tracer))
    assert.isFalse(spans.some((span) => span.name.startsWith('MirVerification.')))
    const ordinary = yield* Analysis.codegen(snapshot, { mode: 'release' }).pipe(
      Effect.withTracer(tracer),
    )
    assert.isFalse(spans.some((span) => span.name.startsWith('MirVerification.')))
    const verified = yield* Analysis.codegen(snapshot, { mode: 'release', verifyMir: true }).pipe(
      Effect.withTracer(tracer),
    )
    assert.deepEqual(artifact.bitcode, ordinary.bitcode)
    assert.deepEqual(artifact.bitcode, verified.bitcode)
    const rejected = yield* Effect.result(MirVerification.check({ ...program, functions: [] }))
    assert.isTrue(Result.isFailure(rejected))
    if (Result.isFailure(rejected)) {
      assert.strictEqual(rejected.failure._tag, 'MirVerificationError')
      assert.isTrue(
        rejected.failure.violations.some((violation) => violation.rule === 'InvalidArtifactRoot'),
      )
    }
    const span = (name: string) =>
      (name === 'Analysis.codegen'
        ? spans.findLast((item) => item.name === name)
        : spans.find((item) => item.name === name)) ?? unreachable(name)
    for (const [child, parent] of [
      ['Instances.residualize', 'Instances.expandWorklist'],
      ['Layout.planValueStorage', 'Layout.computeRuntime'],
      ['Lower.lowerInstance', 'Lower.lowerInstances'],
      ['Layout.planCallingShapes', 'Layout.computeRuntime'],
      ['Layout.planCallingShape', 'Layout.planCallingShapes'],
      ['MirVerification.check', 'Analysis.codegen'],
      ['MirVerification.verify', 'MirVerification.check'],
      ['MirVerification.verifyFunction', 'MirVerification.verify'],
      ['MirVerification.verifyModule', 'MirVerification.verify'],
      ['MirVerification.verifyNormalization', 'MirVerification.verify'],
      ['MirVerification.verifyInitialization', 'MirVerification.verifyFunction'],
      ['LayoutVerify.verifyEntries', 'LayoutVerify.verify'],
      ['ForeignAvailability.select', 'Backend.selectForeign'],
    ] as const) {
      assert.strictEqual(
        Option.getOrUndefined(span(child).parent)?.spanId,
        span(parent).spanId,
        child,
      )
    }
    assert.strictEqual(
      span('MirVerification.verifyFunction').attributes.get('function.module'),
      'trace/program',
    )
    for (const item of spans) assert.strictEqual(item.status._tag, 'Ended', item.name)
  }),
)

it.effect('reads match tags and proven variant fields without decoding unrelated payloads', () =>
  Effect.gen(function* () {
    const artifact = yield* emit(
      `struct Span { start: i32 end: i32 }
union Token {
  First { span: Span },
  Second { padding: i64, span: Span },
  Third { span: Span, extra: i32 },
}
fn kind(token: Token) -> i32 {
  return match move token {
    Token.First { .. } => 1
    Token.Second { .. } => 2
    Token.Third { .. } => 3
  }
}
fn start(token: Token) -> i32 {
  return match move token {
    Token.First { span: Span { start, .. } } => start
    Token.Second { span: Span { start, .. }, .. } => start
    Token.Third { span: Span { start, .. }, .. } => start
  }
}
fn makeToken(choice: i32) -> Token {
  if choice == 0 { return Token.First { span: Span { start: 1, end: 2 } } }
  if choice == 1 { return Token.Second { padding: 9, span: Span { start: 41, end: 42 } } }
  return Token.Third { span: Span { start: 3, end: 4 }, extra: 5 }
}
fn constructors() -> i32 {
  return kind(Token.First { span: Span { start: 1, end: 2 } }) +
    start(Token.Second { padding: 9, span: Span { start: 41, end: 42 } })
}
pub fn main() -> i32 { return constructors() + start(makeToken(1)) }`,
      { mode: 'release' },
    )
    for (const name of ['kind', 'start']) {
      const body =
        artifact.ir
          .match(new RegExp(`define hidden [^\\n]+@silk_golden_program_${name}__[^]*?\\n}`))
          ?.at(0) ?? unreachable(`expected ${name} definition`)
      // Match tests branch on scalar tags. Decoding a union payload here would introduce
      // additional switches across variants that the match has already distinguished.
      let block = ''
      for (const line of body.split('\n')) {
        if (/^\S+:$/.test(line)) block = line.slice(0, -1)
        // An incoming ABI payload may be stored once in entry. Match arms must not
        // decode the union again to read its tag or a field whose variant is proven.
        if (/^\s+switch /.test(line)) assert.strictEqual(block, 'entry')
      }
      assert.match(body, /icmp eq i32/)
    }
    const constructors =
      artifact.ir.match(/define hidden [^\n]+@silk_golden_program_constructors__[^]*?\n}/)?.at(0) ??
      unreachable('expected constructors definition')
    // The constructors know their variant; only later ABI reads may need a dispatch.
    assert.notMatch(constructors, /switch i32 %place\d+_store/)
    const returned =
      artifact.ir.match(/define hidden [^\n]+@silk_golden_program_makeToken__[^]*?\n}/)?.at(0) ??
      unreachable('expected union-returning function')
    // Private returns write directly into caller-owned storage; no carrier decoding occurs.
    assert.match(returned, /^define hidden void [^\n]+\(i32 %v0, ptr %v1\)/)
    assert.match(returned, /call void @llvm.memmove[^\n]+%v1,/)
    assert.notMatch(returned, /switch i32|insertvalue|extractvalue/)
    assert.match(returned, /completion:\n\s+ret void/)
  }),
)

it.effect('uses addressable storage as the mutable local backing store', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'golden/program',
      ascii(`fn update(value: &mut i32) { value.* = 42 }
pub fn main() -> i32 {
  let mut value = 0
  update(&mut value)
  if value == 42 { return value }
  return 1
}`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
    const address = artifact.ir.match(/%addr(\d+) = alloca/)
    const root = address?.at(1) ?? unreachable('expected address-taken local storage')
    assert.notMatch(artifact.ir, new RegExp(`%mut${root}_\\d+ = alloca`))
    assert.match(artifact.ir, new RegExp(`load i32, ptr %addr${root}_lane0`))
  }),
)

it.effect('limits borrowed-local refreshes to their referenced lifetime within a block', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'golden/program',
      ascii(`fn update(value: &mut i32) { value.* = 21 }
fn finish(saved: i32, ignored: ()) -> i32 { return saved }
pub fn main() -> i32 {
  let mut first = 0
  update(&mut first)
  let mut second = 0
  let saved = finish(first + 0, update(&mut second))
  return saved + second
}`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
    const root =
      artifact.ir.match(/%addr(\d+) = alloca/)?.at(1) ??
      unreachable('expected the first borrowed local')
    const calls = [...artifact.ir.matchAll(/call void @silk_golden_program_update[^\n]+/g)]
    const lastCall = calls.at(-1) ?? unreachable('expected update calls')
    const before = artifact.ir.slice(0, lastCall.index)
    const after = artifact.ir.slice(lastCall.index)
    assert.match(before, new RegExp(`load i32, ptr %addr${root}_lane0`))
    assert.notMatch(after, new RegExp(`load i32, ptr %addr${root}_lane0`))
    const second =
      [...artifact.ir.matchAll(/%addr(\d+) = alloca/g)].at(1)?.at(1) ??
      unreachable('expected the second borrowed local')
    assert.notMatch(
      artifact.ir,
      new RegExp(`load i32, ptr %addr${second}_lane0\\n\\s*store i32 0, ptr %addr${second}_lane0`),
    )
  }),
)

it.effect('joins return payloads before releasing diagnostic outcomes', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'golden/program',
      ascii(`import silk.effect { Effect }
struct Problem {}
fn observing<'env, S, A, ?R, F: fn<'static>(&mut S, u8, usize, usize, string<'static>, string<'static>) -> usize + Intrinsic.NonParking>(state: S, observer: F, body: once Effect<'env; A ? R>) -> once Effect<'env; A ? R> {
  return Intrinsic.observeDiagnostics<S, A, R, F>(move state, move observer, move body)
}
fn observer(state: &mut (), event: u8, first: usize, second: usize, identity: string<'static>, origin: string<'static>) -> usize { return 0 }
effect fn risky() -> i32 ! Problem { fail Problem {} }
effect fn recover(error: Problem) -> i32 { return 42 }
effect fn choose(flag: bool) -> i32 ! Problem {
  let value = run risky()
  if flag { return value }
  return 7
}
pub fn main() -> i32 { return run observing((), observer, Effect.catchAll(choose(false), recover)) }`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
    const choose =
      artifact.ir.match(/define hidden [^\n]+@silk_golden_program_choose_effect[^]*?\n}/)?.at(0) ??
      unreachable('expected effect runner')
    assert.match(choose, /completion:\n\s+%completion_lane0 = phi/)
    const stored =
      choose.match(/store i32 7, ptr (%effect_outcome\w+)/)?.at(1) ??
      unreachable('expected the return payload in canonical storage')
    const address =
      choose.match(new RegExp(`${stored} = getelementptr i8, ptr (%addr\\d+), i32 (\\d+)`)) ??
      unreachable('expected a planned payload offset')
    const resultAddress =
      choose.match(/^define hidden void [^\n]+, ptr (%v\d+)\)/)?.at(1) ??
      unreachable('expected caller-owned result storage')
    assert.match(
      choose,
      new RegExp(`call void @llvm.memmove[^\\n]+${resultAddress},[^\\n]+${address.at(1)},`),
    )
    assert.notMatch(choose, /phi i32[^\n]+%completion_exit/)
    assert.notMatch(choose, /completion_value|completion_storage/)
    assert.match(choose, /^define hidden void /)
    assert.match(choose, /store \{[^\n]+\} %completion_lane0, ptr %completion_diagnostic_ptr/)
    assert.match(
      choose,
      /%completion_diagnostic_ptr = getelementptr \{[^\n]+\}, ptr %[^,]+, i32 0, i32 1/,
    )
    assert.notMatch(choose, /insertvalue [^\n]+%completion_lane/)
  }),
)

it.effect('lowers scalar enums to exact native integer lanes and declared discriminants', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'golden/program',
      ascii(scalarEnumNativeWidths),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })

    assert.match(artifact.ir, /define hidden i8 @silk_.*identity8.*\(i8/)
    assert.match(artifact.ir, /define hidden i16 @silk_.*identity16.*\(i16/)
    assert.match(artifact.ir, /define hidden i32 @silk_.*identity32.*\(i32/)
    assert.match(artifact.ir, /define hidden i64 @silk_.*identity64.*\(i64/)
    assert.match(artifact.ir, /i8 -1/)
    assert.match(artifact.ir, /i16 -300/)
    assert.match(artifact.ir, /i32 70000/)
    assert.match(artifact.ir, /i64 4294967297/)
    assert.match(artifact.ir, /icmp ne i8/)
    assert.match(artifact.ir, /icmp ne i16/)
    assert.match(artifact.ir, /icmp ne i32/)
    assert.match(artifact.ir, /icmp eq i64/)
    assert.notInclude(artifact.ir, 'enum_tag')
  }),
)

it.effect('emits one artifact per program with deterministic symbols', () =>
  Effect.gen(function* () {
    const artifact = yield* emit(nestedSource, { mode: 'release' })

    assert.strictEqual(artifact.module, 'golden/program')
    assert.deepEqual(
      artifact.symbols.map((entry) => entry.symbol),
      [
        'silk_golden_program_main__14_676f6c64656e2f70726f6772616d_4_6d61696e_18_726573756c743a6275696c74696e3a693332',
        'silk_golden_program_identity__14_676f6c64656e2f70726f6772616d_8_6964656e74697479_11_6275696c74696e3a693332_18_726573756c743a6275696c74696e3a693332',
      ],
    )
    assert.strictEqual(artifact.symbols.at(0)?.declaration.name, 'main')
  }),
)

it.effect('matches the IR golden and the bitcode digest golden', () =>
  Effect.gen(function* () {
    const artifact = yield* emit(nestedSource, { mode: 'release' })

    assert.strictEqual(artifact.ir, golden('program.ll.txt'))
    assert.strictEqual(
      `${createHash('sha256').update(artifact.bitcode).digest('hex')}\n`,
      golden('program.bc.sha256'),
    )
  }),
)

it.effect('emits byte-identical bitcode across repeated fresh runs', () =>
  Effect.gen(function* () {
    const first = yield* emit(nestedSource, { mode: 'release' })
    const second = yield* emit(nestedSource, { mode: 'release' })

    assert.deepEqual(first.bitcode, second.bitcode)
    assert.strictEqual(first.ir, second.ir)
  }),
)

it.effect(
  'emits target-correct LLVM bitcode for wasm32 while retaining its ordinary source root',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'golden/llvm-wasm',
        ascii(
          'pub fn main() -> i32 { return 42 }\nexport "C" fn enter() -> i32 as "main" { return main() }',
        ),
        'wasm32-unknown-unknown',
      )
      const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
      assert.strictEqual(artifact._tag, 'LlvmBitcodeArtifact')
      assert.strictEqual(artifact.backend, 'llvm')
      assert.strictEqual(artifact.target.id, 'wasm32-unknown-unknown')
      assert.include(artifact.ir, 'target triple = "wasm32-unknown-unknown"')
      assert.strictEqual(artifact.symbols.at(0)?.declaration.name, 'main')
      assert.notInclude(artifact.ir, '@silk_main')
      assert.include(artifact.ir, '@"\\01main"()')
      assert.notInclude(artifact.ir, '@main(')
    }),
)

it.effect('refuses diagnosed trap bodies before backend emission', () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      emit('pub fn main() -> i32 { return missing() }', { mode: 'release' }),
    )
    assert.strictEqual(result._tag, 'Failure')
    if (result._tag === 'Failure') assert.strictEqual(result.failure._tag, 'CodegenUnavailable')
  }),
)

it.effect('emits native debug metadata only for debug requests', () =>
  Effect.gen(function* () {
    const debug = yield* emit(nestedSource, {
      mode: 'debug',
      sources: new Map([['golden/program', ascii(nestedSource)]]),
    })
    const release = yield* emit(nestedSource, { mode: 'release' })

    assert.include(debug.ir, '!DICompileUnit(')
    assert.include(debug.ir, '!DISubprogram(')
    assert.include(debug.ir, '!dbg')
    assert.notInclude(release.ir, 'DICompileUnit')
    assert.notInclude(release.ir, '!dbg')
  }),
)

it.effect('keeps string identity in deterministic LLVM debug metadata only', () =>
  Effect.gen(function* () {
    const source = `fn pass(value: string) -> string { return value }
fn byteCount(value: &[u8]) -> usize { return value.length }
pub fn main() -> i32 {
  let text = pass("caf\\u{e9}")
  if byteCount(Intrinsic.stringUtf8Bytes(text)) == 5 { return 42 }
  return 0
}`
    const request = {
      mode: 'debug' as const,
      sources: new Map([['golden/program', ascii(source)]]),
    }
    const first = yield* emit(source, request)
    const second = yield* emit(source, request)
    const release = yield* emit(source, { mode: 'release' })

    assert.include(first.ir, '!DIStringType(name: "string"')
    assert.include(first.ir, 'encoding: DW_ATE_UTF')
    assert.match(first.ir, /name: "&'[^" ]+ \[u8\]"/)
    assert.notInclude(release.ir, 'DIStringType')
    assert.notInclude(release.ir, 'DW_ATE_UTF')
    assert.strictEqual(first.ir, second.ir)
    assert.deepEqual(first.bitcode, second.bitcode)
  }),
)

const arithmeticSource =
  'import silk.i32\npub fn main() -> i32 { return i32.subtract(i32.multiply(6, 7), 0) }'

const matchSource = `import silk.i32
pub struct Left { value: i32 }
pub struct Right { value: i32 }
pub fn inspect(input: Left | Right) -> i32 {
  return match &input {
    Left { value } if false => 0
    Left { value: answer } => i32.add(answer, 1)
    Right { value } => value
  }
}
pub fn main() -> i32 { return inspect(Left { value: 41 }) }`

it.effect('emits checked arithmetic through overflow intrinsics and guarded division', () =>
  Effect.gen(function* () {
    const artifact = yield* emit(arithmeticSource, { mode: 'release' })
    const division = yield* emit(
      'import silk.i32\npub fn main() -> i32 { return i32.divide(1, 0) }',
      {
        mode: 'release',
      },
    )

    assert.include(artifact.ir, 'llvm.smul.with.overflow')
    assert.include(artifact.ir, 'llvm.ssub.with.overflow')
    assert.include(artifact.ir, 'trap_site')
    assert.notInclude(artifact.ir, '@silk_trap_report_v1')
    assert.include(division.ir, 'sdiv')
    assert.include(division.ir, 'icmp eq')
    assert.include(division.ir, '@llvm.trap()')
  }),
)

it.effect('matches the arithmetic IR golden and stays deterministic', () =>
  Effect.gen(function* () {
    const first = yield* emit(arithmeticSource, { mode: 'release' })
    const second = yield* emit(arithmeticSource, { mode: 'release' })

    assert.strictEqual(first.ir, golden('arithmetic.ll.txt'))
    assert.deepEqual(first.bitcode, second.bitcode)
  }),
)

it.effect('emits comparisons as icmp with zero-extension and branches natively', () =>
  Effect.gen(function* () {
    const artifact = yield* emit(
      'import silk.i32\npub fn main() -> i32 { if i32.lessThan(1, 2) { return 42 } return 0 }',
      {
        mode: 'release',
      },
    )

    assert.include(artifact.ir, 'icmp slt')
    assert.include(artifact.ir, 'zext')
    assert.include(artifact.ir, 'br i1')
  }),
)

it.effect('privately flattens structured match regions with deterministic member branches', () =>
  Effect.gen(function* () {
    const first = yield* emit(matchSource, { mode: 'release' })
    const second = yield* emit(matchSource, { mode: 'release' })

    assert.include(first.ir, 'match')
    assert.include(first.ir, 'icmp eq')
    assert.include(first.ir, 'br i1')
    assert.strictEqual(first.ir, second.ir)
    assert.deepEqual(first.bitcode, second.bitcode)
  }),
)

it.effect('projects a checked array element before loading only its selected field', () =>
  Effect.gen(function* () {
    const source = `struct Pair { left: i32 right: i32 }
fn choose(values: [Pair; 2], index: usize) -> i32 { return values[index].left }
pub fn main() -> i32 { return choose([Pair { left: 10, right: 11 }, Pair { left: 42, right: 43 }], 1) }`
    const first = yield* emit(source, { mode: 'release' })
    const second = yield* emit(source, { mode: 'release' })

    assert.include(first.ir, 'icmp ult')
    assert.notInclude(first.ir, 'select i1')
    assert.match(first.ir, /%owned_read\d+_stride0 = mul i64 %\w+, 8/)
    assert.match(first.ir, /getelementptr i8, ptr %addr0, i64 %owned_read\d+_stride0/)
    assert.match(first.ir, /%project\w+ = load i32, ptr %owned_read\d+_field/)
    assert.include(first.ir, '@llvm.trap()')
    assert.deepEqual(first.bitcode, second.bitcode)
    assert.strictEqual(first.ir, second.ir)
  }),
)

it.effect('orders checked array reads before private match blocks', () =>
  Effect.gen(function* () {
    const artifact = yield* emit(
      `import silk.usize
struct A {}
struct B {}
fn decode(code: i32) -> A | B { if code == 1 { return A {} } return B {} }
pub fn main() -> i32 {
  let codes = [1, 2]
  let index = usize.add(0, 0)
  let candidate = decode(codes[index])
  return match move candidate { A {} => 42 B {} => 0 }
}`,
      { mode: 'release' },
    )

    assert.match(artifact.ir, /index\d+_0_ok/)
    assert.include(artifact.ir, 'match')
  }),
)

it.effect('publishes native branch provenance back to canonical loop regions', () =>
  Effect.gen(function* () {
    const artifact = yield* emit(
      'pub fn main() -> i32 { let mut value = 0 while value < 2 { value = value + 1 } return value }',
      { mode: 'release' },
    )
    assert.strictEqual(
      artifact.control.every((entry) => entry.backend === 'LLVM'),
      true,
    )
    assert.strictEqual(
      artifact.control.some((entry) => entry.construct === 'LlvmBranch'),
      true,
    )
    assert.strictEqual(
      artifact.control.some(
        (entry) =>
          entry.construct === 'LlvmJump' &&
          entry.targets.some((target) => target.ordinal <= entry.region.ordinal),
      ),
      true,
    )
  }),
)

it.effect('does not reload unrelated mutable locals at a later control-flow join', () =>
  Effect.gen(function* () {
    const artifact = yield* emit(
      `pub fn main() -> i32 {
      let mut discarded = 17
      discarded = discarded + 1
      drop discarded
      let mut result = 0
      while result < 2 { result = result + 1 }
      return result
    }`,
      { mode: 'release' },
    )
    const discardedStorage =
      artifact.ir.match(/store i32 17, ptr (%mut\d+_0)/)?.[1] ??
      unreachable('expected discarded local storage')
    const resultStorage =
      artifact.ir.match(/store i32 0, ptr (%mut\d+_0)/)?.[1] ??
      unreachable('expected result storage')
    const returnBlock =
      artifact.ir.split(/\n(?=[\w.]+:)/).find((block) => /ret i32 %/.test(block)) ??
      unreachable('expected a return block')
    assert.notInclude(returnBlock, `ptr ${discardedStorage}`)
    assert.include(returnBlock, `load i32, ptr ${resultStorage}`)
  }),
)

it.effect(
  'preserves aggregate storage across callable arguments, captures, and Effect results',
  () =>
    Effect.gen(function* () {
      const artifact = yield* emit(
        `struct Payload {
  first: i32
  second: i32
  third: i32
  fourth: i32
}
fn identity(value: Payload) -> Payload { return move value }
fn apply(value: Payload) -> Payload {
  let callback = identity
  return callback(move value)
}
fn capture(value: Payload) -> Payload {
  let callback = fn() -> Payload { return move value }
  return callback()
}
effect fn produce(value: Payload) -> Payload { return capture(apply(move value)) }
effect fn inspect(value: Payload) -> i32 {
  let result = run produce(move value)
  return result.third
}
pub effect fn main() -> i32 {
  return run inspect(Payload { first: 1, second: 2, third: 42, fourth: 4 })
}`,
        { mode: 'release' },
      )
      const runner =
        artifact.ir.match(/define hidden [^\n]+@silk_golden_program_inspect_effect[^]*?\n}/)?.[0] ??
        unreachable('expected the aggregate Effect runner')
      assert.match(runner, /@silk_golden_program_inspect_effect[^\n(]*\(ptr /)
      assert.include(runner, '@llvm.memmove')
      for (const name of ['identity', 'apply', 'capture', 'produce_effect']) {
        const body =
          artifact.ir
            .match(new RegExp(`define hidden [^\\n]+@silk_golden_program_${name}[^]*?\\n}`))
            ?.at(0) ?? unreachable(`expected ${name} definition`)
        assert.match(body, /^define hidden void [^\n]+\(ptr %v0, ptr %v1\)/)
        assert.include(body, '@llvm.memmove')
        assert.notMatch(body, /extractvalue|insertvalue|switch i32/)
        assert.match(body, /completion:\n\s+ret void/)
      }
    }),
)

it.effect('avoids redundant failure payload selections and duplicate Effect result reloads', () =>
  Effect.gen(function* () {
    const artifact = yield* emit(
      `pub struct Problem {}
struct Payload {
  first: i32
  second: i32
  third: i32
}
effect fn attempt(flag: bool) -> Payload ! Problem {
  if flag { fail Problem {} }
  return Payload { first: 1, second: 2, third: 3 }
}
effect fn forward(flag: bool) -> Payload ! Problem {
  return run attempt(flag)
}
pub effect fn main() -> () ! Problem {
  let payload = run forward(false)
  drop payload
}`,
      { mode: 'release' },
    )
    assert.include(artifact.ir, 'icmp eq i32')
    assert.notMatch(artifact.ir, /select i1 %[^,]+, i32 0, i32 0/)
    const joins = artifact.ir
      .split(/\n(?=[\w.]+:)/)
      .filter((block) => /^effect_value\d+_following:/.test(block))
    assert.isNotEmpty(joins)
    for (const join of joins) {
      assert.notMatch(join, /%effect_value\d+_\d+ = load /)
      assert.notMatch(join, /%mut\d+_\d+_load_/)
    }
  }),
)

it.effect('passes a released shared payload to its cleanup helper by address', () =>
  Effect.gen(function* () {
    const artifact = yield* emit(
      `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
struct Payload {
  first: i32
  second: i32
  third: i32
  fourth: i32
}
pub effect fn main() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let shared = run (Shared.make<Payload>(Payload { first: 1, second: 2, third: 3, fourth: 4 })
    |> Effect.provideMut<Allocator>(&mut allocator))
  drop shared
  return 1
}`,
      { mode: 'release' },
    )
    const releases = artifact.ir
      .split(/\n(?=[\w.]+:)/)
      .filter((block) => /^[\w.]+_last:/.test(block) && block.includes('payloadCleanup'))
    assert.isNotEmpty(releases)
    for (const release of releases) {
      assert.match(release, /call [^\n]+payloadCleanup[^\n]*\(ptr %[\w.]+_value[,)]/)
      assert.notMatch(release, /= load i32|_argument = alloca/)
    }
  }),
)

it.effect('declares each reachable foreign symbol once and calls through its unwind guard', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'backend/foreign-native',
      ascii(`import silk.i32
import silk.usize
unsafe extern "C" fn silk_test_add(a: i32, b: i32) -> i32
unsafe extern "C" fn silk_test_scale(count: usize) -> usize
unsafe extern "C" fn abs(value: i32) -> i32
fn first() -> i32 { return unsafe silk_test_add(1, 2) }
fn second() -> i32 { return unsafe silk_test_add(3, 4) }
pub fn main() -> i32 {
  let scaled = unsafe silk_test_scale(i32.toUsize(5))
  return first() + second() + unsafe abs(-1) + usize.toI32(scaled)
}`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
    assert.strictEqual(artifact._tag, 'LlvmBitcodeArtifact')
    if (artifact._tag !== 'LlvmBitcodeArtifact') return
    const lines = artifact.ir.split('\n')
    // Convention 0 renders without a `ccc`/`cc <n>` marker.
    assert.deepEqual(
      lines.filter((line) => line.startsWith('declare') && line.includes('@silk_test_add')),
      ['declare i32 @silk_test_add(i32, i32)'],
    )
    assert.strictEqual(lines.filter((line) => /invoke i32 @silk_test_add\(/.test(line)).length, 1)
    assert.strictEqual(
      lines.filter((line) => /call i32 @__silk_foreign_guard\.1\(/.test(line)).length,
      2,
    )
    assert.deepEqual(
      lines.filter((line) => line.startsWith('declare') && line.includes('@silk_test_scale')),
      ['declare i64 @silk_test_scale(i64)'],
    )
    assert.strictEqual(
      lines.filter((line) => /invoke i64 @silk_test_scale\(i64 /.test(line)).length,
      1,
    )
    assert.deepEqual(artifact.foreignImports, [
      {
        variadic: false,
        symbol: 'abs',
        parameters: ['i32'],
        result: 'i32',
        contract: ForeignContract.conservative,
      },
      {
        variadic: false,
        symbol: 'silk_test_add',
        parameters: ['i32', 'i32'],
        result: 'i32',
        contract: ForeignContract.conservative,
      },
      {
        variadic: false,
        symbol: 'silk_test_scale',
        parameters: ['u64'],
        result: 'u64',
        contract: ForeignContract.conservative,
      },
    ])

    const plain = yield* emit(nestedSource, { mode: 'release' })
    assert.deepEqual(plain.foreignImports, [])
  }),
)

it.effect('preserves selected dollar-bearing symbols and excludes inactive imports', () =>
  Effect.gen(function* () {
    for (const [target, expected] of [
      ['aarch64-apple-darwin', ['close$NOCANCEL', 'helper$version']],
      ['x86_64-unknown-linux-gnu', ['helper$version']],
      ['wasm32-unknown-unknown', []],
    ] as const) {
      const snapshot = yield* AnalysisFixture.retainingMain(
        `backend/foreign-dollar-${target}`,
        ascii(selectedForeignDollarSource),
        target,
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [], target)
      const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
      assert.deepEqual(
        artifact.foreignImports.map((entry) => entry.symbol),
        [...expected],
        target,
      )
      for (const symbol of expected) assert.include(artifact.ir, `@${symbol}`, target)
      for (const symbol of ['close$NOCANCEL', 'helper$version']) {
        if (!expected.some((candidate) => candidate === symbol))
          assert.notInclude(artifact.ir, symbol, target)
      }
    }
  }),
)

it.effect('rejects a foreign declaration of a symbol the native backend declares itself', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'backend/foreign-malloc',
      ascii(`import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
unsafe extern "C" fn malloc(size: i32) -> i32
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[i32; 2]>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let allocation = run recipe
  drop allocation
  return unsafe malloc(8)
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const failure = yield* Effect.flip(Analysis.codegen(snapshot, { mode: 'release' }))
    assert.strictEqual(failure._tag, 'BackendError')
    if (failure._tag !== 'BackendError') return
    assert.deepEqual(failure.reason, { _tag: 'ForeignSymbolConflict', symbol: 'malloc' })
  }),
)

it.effect('defines one C thunk per export that forwards to the private implementation', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'backend/foreign-export',
      ascii(`export "C" fn silk_test_double_v1(value: i32) -> i32 { return value * 2 }
pub fn main() -> i32 { return 0 }`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const first = yield* Analysis.codegen(snapshot, { mode: 'release' })
    assert.strictEqual(first._tag, 'LlvmBitcodeArtifact')
    if (first._tag !== 'LlvmBitcodeArtifact') return
    const lines = first.ir.split('\n')
    // Convention 0 renders without a `ccc`/`cc <n>` marker; the export is emitted even though
    // `main` never calls it.
    const start = lines.findIndex((line) => line.startsWith('define i32 @silk_test_double_v1(i32'))
    assert.notStrictEqual(start, -1, first.ir)
    const body = lines.slice(start + 1, lines.indexOf('}', start))
    const calls = body.filter((line) => line.includes(' invoke '))
    assert.strictEqual(calls.length, 1, body.join('\n'))
    assert.match(calls.at(0) ?? '', /invoke i32 @silk_[^(\s]+__[^(\s]+\(i32 /)
    assert.isFalse((calls.at(0) ?? '').includes('@silk_test_double_v1('))
    assert.strictEqual(body.filter((line) => /^\s*ret /.test(line)).length, 1, body.join('\n'))
    assert.include(body.join('\n'), 'call void @llvm.trap()')
    assert.include(body.join('\n'), 'landingpad')
    assert.deepEqual(first.foreignExports, [
      {
        variadic: false,
        symbol: 'silk_test_double_v1',
        parameters: ['i32'],
        result: 'i32',
        contract: ForeignContract.conservative,
      },
    ])
    const plain = yield* emit(nestedSource, { mode: 'release' })
    assert.deepEqual(plain.foreignExports, [])
  }),
)

it.effect('reloads a pointed-to local from its storage after a foreign call', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'backend/pointer-reload',
      ascii(`import silk.pointer { Pointer }
unsafe extern "C" fn touch(pointer: *mut i32) -> ()
pub fn main() -> i32 {
  let mut value = 1
  let pointer = Pointer.fromMutRef(&mut value)
  let touched = unsafe touch(pointer)
  return value
}`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
    assert.strictEqual(artifact._tag, 'LlvmBitcodeArtifact')
    if (artifact._tag !== 'LlvmBitcodeArtifact') return
    const lines = artifact.ir.split('\n')
    assert.include(lines, 'declare void @touch(ptr)')
    const call = lines.findIndex((line) => /call void @__silk_foreign_guard\.0\(ptr %/.test(line))
    assert.notStrictEqual(call, -1, artifact.ir)
    const reload = lines.findIndex(
      (line, index) => index > call && / = load i32, ptr %addr\d+_lane0/.test(line),
    )
    assert.notStrictEqual(reload, -1, artifact.ir)
    const loaded = lines.at(reload)?.trim().split(' = ')[0]
    assert.include(lines.slice(reload + 1), `  ret i32 ${loaded}`)
    assert.deepEqual(artifact.foreignImports, [
      {
        variadic: false,
        symbol: 'touch',
        parameters: [
          'pointer<mut;7%3APointer28%3ASingle%3Amut%3Anonnull%3ANatural%3A011%3Abuiltin%3Ai32>',
        ],
        result: 'void',
        contract: ForeignContract.conservative,
      },
    ])
  }),
)

it.effect('declares a foreign pointer signature with the LLVM pointer type', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'backend/pointer-malloc',
      ascii(`import silk.pointer { Pointer }
import silk.i32
unsafe extern "C" fn malloc(size: usize) -> *mut u8
pub fn main() -> i32 {
  let bytes = unsafe malloc(i32.toUsize(8))
  if Pointer.isNull(bytes) {
    return 1
  }
  return 0
}`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
    assert.strictEqual(artifact._tag, 'LlvmBitcodeArtifact')
    if (artifact._tag !== 'LlvmBitcodeArtifact') return
    assert.include(artifact.ir.split('\n'), 'declare ptr @malloc(i64)')
    assert.match(artifact.ir, /invoke ptr @malloc\(i64 %/)
    assert.deepEqual(artifact.foreignImports, [
      {
        variadic: false,
        symbol: 'malloc',
        contract: ForeignContract.conservative,
        parameters: ['u64'],
        result:
          'pointer<mut;7%3APointer28%3ASingle%3Amut%3Anonnull%3ANatural%3A010%3Abuiltin%3Au8>',
      },
    ])
  }),
)
