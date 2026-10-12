import * as AnalysisFixture from './support/AnalysisFixture.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Tir from '../src/Tir.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as MirVerification from '../src/MirVerification.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Target from '../src/Target.js'
import * as MirGolden from './support/MirGolden.js'
const encoder = new TextEncoder()

const pipelineSource = 'import silk.i32\npub fn main() -> i32 { return 2 + 3 * 4 |> i32.add(1) }'

const golden = (name: string): string =>
  readFileSync(new URL(`./goldens/operator.${name}`, import.meta.url), 'utf8')

it('normalizes MIR source spans while retaining operations and provenance', () => {
  const mir =
    'usize-literal 20 bits=64 available [35266, 35268)\n' +
    'fn sample.main params=0 locals=4 -> i32 entry=r0\n' +
    '  r0 operation:\n' +
    '    %3 = multiply %1, %2 : i32 [50, 55) generated\n' +
    '    return %3 [50, 55)\n'
  const expected = MirGolden.normalizeSourceSpans(mir)

  assert.strictEqual(
    MirGolden.normalizeSourceSpans(
      mir.replace('[35266, 35268)', '[37266, 37268)').replaceAll('[50, 55)', '[70, 75)'),
    ),
    expected,
  )
  assert.notStrictEqual(MirGolden.normalizeSourceSpans(mir.replace('multiply', 'add')), expected)
  assert.notStrictEqual(MirGolden.normalizeSourceSpans(mir.replace('%1, %2', '%1, %0')), expected)
  assert.notStrictEqual(
    MirGolden.normalizeSourceSpans(mir.replace('entry=r0', 'entry=r1')),
    expected,
  )
  assert.notStrictEqual(
    MirGolden.normalizeSourceSpans(mir.replace('return %3', 'return %2')),
    expected,
  )
  assert.notStrictEqual(MirGolden.normalizeSourceSpans(mir.replace(' generated', '')), expected)
  assert.notStrictEqual(MirGolden.normalizeSourceSpans(mir.replace('bits=64', 'bits=32')), expected)
})

it.effect('lowers negation to generated zero plus source-authored trapping subtraction', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'golden/negation',
      encoder.encode('pub fn main() -> i32 { let value = 42 return -value }'),
      'aarch64-apple-darwin',
    )
    const fn = Analysis.loweredMir(snapshot).functions.at(0)
    const operations = fn === undefined ? [] : MirVerification.operations(fn)
    const zero = operations.find(
      (operation) => operation._tag === 'Literal' && operation.value === 0n,
    )
    const subtraction = operations.find(
      (operation) => operation._tag === 'Binary' && operation.operator === 'Subtract',
    )

    assert.strictEqual(zero?._tag, 'Literal')
    assert.strictEqual(zero?.provenance.generated, true)
    assert.strictEqual(subtraction?._tag, 'Binary')
    assert.strictEqual(subtraction?.provenance.generated, false)
  }),
)

it.effect('pins one operator pipeline through canonical TIR, MIR, and LLVM', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'golden/operator',
      encoder.encode(pipelineSource),
      'aarch64-apple-darwin',
    )
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })

    assert.strictEqual(Tir.encode(Analysis.rootAnalysis(snapshot).tir), golden('tir.txt'))
    assert.strictEqual(
      MirGolden.normalizeSourceSpans(MirEncoding.encode(Analysis.loweredMir(snapshot))),
      golden('mir.txt'),
    )
    assert.strictEqual(artifact.ir, golden('ll.txt'))
    assert.strictEqual(
      `${createHash('sha256').update(artifact.bitcode).digest('hex')}\n`,
      golden('bc.sha256'),
    )
  }),
)

const pipedSectionViolations = Effect.fnUntraced(function* (name: string, source: string) {
  const frontend = yield* AnalysisFixture.retainingMain(
    name,
    encoder.encode(source),
    Target.wasm32UnknownUnknown.id,
  )
  const snapshot = yield* Analysis.realize(
    frontend,
    AnalysisFixture.configuration(frontend.closure.rootModule, Target.wasm32UnknownUnknown.id),
    { normalizeMir: false },
  ).pipe(Effect.provide(SourceResolver.empty))
  assert.deepEqual(Analysis.diagnostics(snapshot), [])
  return yield* MirVerification.verify(Analysis.loweredMir(snapshot))
})

it.effect('pipes into a section of an ordinary function whose capture carries a lifetime', () =>
  Effect.gen(function* () {
    const found = yield* pipedSectionViolations(
      'pipe/section-owned',
      `import silk.option { Option }
pub fn main() -> i32 {
  let present = Option<string>.some("Silk")
  let name = move present |> Option<string>.unwrapOr("")
  drop name
  return 0
}`,
    )
    assert.deepEqual(found, [])
  }),
)

it.effect('pipes a chained accessor pipeline ending in a section without splitting it', () =>
  Effect.gen(function* () {
    const found = yield* pipedSectionViolations(
      'pipe/section-chained',
      `import silk.option { Option }
fn label<'a>(value: i32) -> string<'a> { return "leaf" }
pub fn main() -> i32 {
  let text = Option<i32>.some(7)
    |> Option<i32>.map<string>(label)
    |> Option<string>.unwrapOr("")
  drop text
  return 0
}`,
    )
    assert.deepEqual(found, [])
  }),
)

it.effect('pipes a borrow-returning accessor into a section', () =>
  Effect.gen(function* () {
    const found = yield* pipedSectionViolations(
      'pipe/section-borrow',
      `import silk.option { Option }
struct Doc { value: i32 }
fn field<'a>(doc: &'a Doc, key: string) -> Option<&'a Doc> { return Option<&'a Doc>.some(doc) }
fn fieldAt<'a>(self: Option<&'a Doc>, key: string) -> Option<&'a Doc> { return move self }
pub fn main() -> i32 {
  let doc = Doc { value: 1 }
  let out = field(&doc, "k") |> fieldAt("child")
  drop out
  return 0
}`,
    )
    assert.deepEqual(found, [])
  }),
)

it.effect('pipes a section over a recursive type', () =>
  Effect.gen(function* () {
    const found = yield* pipedSectionViolations(
      'pipe/section-recursive',
      `import silk.option { Option }
import silk.box { Box }
struct Node { label: string<'static> next: Option<Box<Node>> }
fn named<'a>(node: &Node, fallback: string<'a>) -> string<'a> { return fallback }
pub fn main() -> i32 {
  let node = Node { label: "head", next: Option<Box<Node>>.none() }
  let name = &node |> named("anonymous")
  drop name
  drop node
  return 0
}`,
    )
    assert.deepEqual(found, [])
  }),
)
