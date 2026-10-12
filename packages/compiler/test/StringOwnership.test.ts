import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Tir from '../src/Tir.js'
import * as OwnershipEncoding from '../src/OwnershipEncoding.js'
import * as Projections from './support/projections.js'

const encoder = new TextEncoder()

const snapshot = (source: string) => Analysis.ofSource('string/ownership', encoder.encode(source))

it.effect('retains a runtime string backing loan through its last use', () =>
  Effect.gen(function* () {
    const source = `import silk.u8
fn conflict() -> usize {
  let mut bytes = [u8.toU8(104), u8.toU8(195), u8.toU8(169)]
  unsafe {
    let text = Intrinsic.stringFromUtf8Unchecked(&bytes)
    bytes[0] = u8.toU8(72)
    return Intrinsic.stringByteLength(text)
  }
  return 0
}
fn restored() -> usize {
  let mut bytes = [u8.toU8(104), u8.toU8(195), u8.toU8(169)]
  unsafe {
    let text = Intrinsic.stringFromUtf8Unchecked(&bytes)
    let length = Intrinsic.stringByteLength(text)
    bytes[0] = u8.toU8(72)
    return length
  }
  return 0
}
pub fn main() -> i32 { return 0 }`
    const self = yield* snapshot(source)

    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => ({
        code: diagnostic.code,
        span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'OWN0011', span: 'bytes[0]' },
        { code: 'OWN0019', span: 'text' },
      ],
    )
    const conflict = Analysis.ownershipOf(self, 'string/ownership')?.functions.at(0)
    const restored = Analysis.ownershipOf(self, 'string/ownership')?.functions.at(1)
    assert.strictEqual(conflict?.loans.at(0)?.origin, 'ReturnedView')
    assert.strictEqual(conflict?.loans.at(0)?.access, 'Shared')
    assert.isAbove(
      (conflict?.loans.at(0)?.endSpan.end ?? 0) - (conflict?.loans.at(0)?.startSpan.end ?? 0),
      0,
    )
    assert.strictEqual(restored?.loans.at(0)?.origin, 'ReturnedView')
    assert.isTrue(
      conflict?.exits.some((exit) => exit.kind === 'Return' && exit.loanEnds.length === 1),
    )
    const moduleOwnership = Analysis.ownershipOf(self, 'string/ownership')
    assert.isDefined(moduleOwnership)
    if (moduleOwnership !== undefined) {
      assert.include(OwnershipEncoding.encode(moduleOwnership), 'returned-view')
    }

    const tir = Projections.tirOf(self, 'string/ownership')
    assert.isDefined(tir)
    if (tir !== undefined) {
      const views = tir.functions.flatMap((fn) =>
        fn.statements
          .flatMap(Tir.statementExpressions)
          .flatMap(Tir.expressionTree)
          .filter((expression) => expression._tag === 'RuntimeStringView'),
      )
      assert.strictEqual(views.length, 2)
      assert.isTrue(views.every((view) => view.heldLoans.length === 1))
      assert.deepEqual(Tir.verify(tir), [])
    }
  }),
)

it.effect('propagates string loans through returned views and ordinary calls', () =>
  Effect.gen(function* () {
    const source = `import silk.u8
fn view(bytes: &[u8]) -> string {
  unsafe { return Intrinsic.stringFromUtf8Unchecked(bytes) }
}
fn length(text: string) -> usize { return Intrinsic.stringByteLength(text) }
fn conflict() -> usize {
  let mut bytes = [u8.toU8(104), u8.toU8(195), u8.toU8(169)]
  let text = view(&bytes)
  bytes[0] = u8.toU8(72)
  return length(text)
}
fn restored() -> usize {
  let mut bytes = [u8.toU8(104), u8.toU8(195), u8.toU8(169)]
  let text = view(&bytes)
  let result = length(text)
  bytes[0] = u8.toU8(72)
  return result
}
pub fn main() -> i32 { return 0 }`
    const self = yield* snapshot(source)

    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => ({
        code: diagnostic.code,
        span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'OWN0011', span: 'bytes[0]' },
        { code: 'OWN0019', span: 'text' },
      ],
    )
    const conflict = Analysis.ownershipOf(self, 'string/ownership')?.functions.at(2)
    const restored = Analysis.ownershipOf(self, 'string/ownership')?.functions.at(3)
    assert.strictEqual(conflict?.loans.at(0)?.origin, 'ReturnedView')
    assert.strictEqual(restored?.loans.at(0)?.origin, 'ReturnedView')
  }),
)

it.effect('preserves loans nested inside generic result data', () =>
  Effect.gen(function* () {
    const source = `import silk.u8
import silk.result { Result }
struct InvalidUtf8 { offset: usize }
fn validate(bytes: &[u8], accepted: bool) -> Result<string, InvalidUtf8> {
  if accepted {
    unsafe {
      let text = Intrinsic.stringFromUtf8Unchecked(bytes)
      return Result<string, InvalidUtf8>.succeed(text)
    }
  }
  return Result<string, InvalidUtf8>.failResult(InvalidUtf8 { offset: 0 })
}
fn observe(result: Result<string, InvalidUtf8>) -> usize {
  return match move result {
      Result<string, InvalidUtf8>.Success { value } => Intrinsic.stringByteLength(value)
      Result<string, InvalidUtf8>.Failure { error } => error.offset
  }
}
fn escape(bytes: &[u8]) -> Result<string, InvalidUtf8> { return validate(bytes, true) }
fn conflict() -> usize {
  let mut bytes = [u8.toU8(104), u8.toU8(195), u8.toU8(169)]
  let result = validate(&bytes, true)
  bytes[0] = u8.toU8(72)
  return observe(move result)
}
fn restored() -> usize {
  let mut bytes = [u8.toU8(104), u8.toU8(195), u8.toU8(169)]
  let result = validate(&bytes, true)
  let length = observe(move result)
  bytes[0] = u8.toU8(72)
  return length
}
fn failed() -> usize {
  let mut bytes = [u8.toU8(255)]
  let result = validate(&bytes, false)
  let offset = observe(move result)
  bytes[0] = u8.toU8(0)
  return offset
}
fn dropped() -> usize {
  let bytes = [u8.toU8(104)]
  let result = validate(&bytes, true)
  drop bytes
  return observe(move result)
}
pub fn main() -> i32 { return 0 }`
    const self = yield* snapshot(source)

    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => ({
        code: diagnostic.code,
        span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'OWN0011', span: 'bytes[0]' },
        { code: 'OWN0019', span: 'move result' },
        { code: 'OWN0019', span: 'result' },
        { code: 'OWN0011', span: 'bytes' },
        { code: 'OWN0019', span: 'move result' },
        { code: 'OWN0019', span: 'result' },
      ],
    )
    const functions = Analysis.ownershipOf(self, 'string/ownership')?.functions
    const conflict = functions?.at(3)
    const restored = functions?.at(4)
    const failed = functions?.at(5)
    const dropped = functions?.at(6)
    assert.strictEqual(conflict?.loans.at(0)?.origin, 'ReturnedView')
    assert.strictEqual(restored?.loans.at(0)?.origin, 'ReturnedView')
    assert.strictEqual(failed?.loans.at(0)?.origin, 'ReturnedView')
    assert.strictEqual(dropped?.loans.at(0)?.origin, 'ReturnedView')
  }),
)
