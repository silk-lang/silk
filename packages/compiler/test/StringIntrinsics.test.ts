import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Tir from '../src/Tir.js'
import * as Intrinsic from '../src/Intrinsic.js'
import * as Lifetime from '../src/Lifetime.js'
import * as Type from '../src/Type.js'
import * as Projections from './support/projections.js'

const closedBuiltinResult = (operation: Intrinsic.Operation): Type.Type => {
  if (operation.rule._tag !== 'BuiltinRule' || operation.rule.result._tag !== 'ClosedResult')
    throw new Error('String builtins require closed result contracts')
  return operation.rule.result.type
}

const encoder = new TextEncoder()

const source = `fn view(bytes: &[u8]) -> string {
  unsafe { return Intrinsic.stringFromUtf8Unchecked(bytes) }
  return ""
}
pub fn compare(bytes: &[u8], expected: string) -> bool {
  let actual = view(bytes)
  let raw = Intrinsic.stringUtf8Bytes(actual)
  let length = Intrinsic.stringByteLength(actual)
  return Intrinsic.stringEqualsExact(actual, expected)
}`

it('publishes the minimal portable string intrinsic catalog with exact signatures', () => {
  const operations = [
    'stringFromUtf8Unchecked',
    'stringUtf8Bytes',
    'stringByteLength',
    'stringEqualsExact',
  ].map((name) => Intrinsic.findOperation('Intrinsic', name))
  assert.isTrue(operations.every((operation) => operation !== undefined))
  assert.deepEqual(
    operations.map((operation) =>
      operation === undefined
        ? undefined
        : {
            signature: Intrinsic.signature(operation),
            unsafe: operation.unsafe,
            targets: operation.targets,
            retainedInputs:
              operation.rule._tag !== 'BuiltinRule'
                ? []
                : operation.rule.parameters.flatMap((parameter, ordinal) =>
                    Type.storageLifetimes(parameter).some((input) =>
                      Type.storageLifetimes(closedBuiltinResult(operation)).some((output) =>
                        Lifetime.equals(input, output),
                      ),
                    )
                      ? [ordinal]
                      : [],
                  ),
          },
    ),
    [
      {
        signature: 'unsafe fn Intrinsic.stringFromUtf8Unchecked(bytes: &[u8]) -> string',
        unsafe: true,
        targets: Intrinsic.runtimeTargets,
        retainedInputs: [0],
      },
      {
        signature: 'fn Intrinsic.stringUtf8Bytes(value: string) -> &[u8]',
        unsafe: false,
        targets: Intrinsic.runtimeTargets,
        retainedInputs: [0],
      },
      {
        signature: 'fn Intrinsic.stringByteLength(value: string) -> usize',
        unsafe: false,
        targets: Intrinsic.runtimeTargets,
        retainedInputs: [],
      },
      {
        signature: 'fn Intrinsic.stringEqualsExact(left: string, right: string) -> bool',
        unsafe: false,
        targets: Intrinsic.runtimeTargets,
        retainedInputs: [],
      },
    ],
  )
  const inventory = Intrinsic.inventory().filter((entry) =>
    entry.operation.startsWith('Intrinsic.string'),
  )
  assert.deepEqual(
    inventory.map((entry) => entry.operation),
    [
      'Intrinsic.stringFromUtf8Unchecked',
      'Intrinsic.stringUtf8Bytes',
      'Intrinsic.stringByteLength',
      'Intrinsic.stringEqualsExact',
    ],
  )
  assert.isTrue(
    inventory.every(
      (entry) =>
        entry.admission === 'Representation' &&
        entry.consumer.startsWith('silk/string.') &&
        !/alloc|normal|travers|grapheme|owned|stringString/i.test(entry.operation),
    ),
  )
})

it.effect('retains runtime string identity and provenance in TIR', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource('string/intrinsics', encoder.encode(source))
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const tir = Projections.tirOf(snapshot, 'string/intrinsics')
    assert.isDefined(tir)
    if (tir === undefined) return

    const expressions = tir.functions.flatMap((fn) =>
      fn.statements.flatMap(Tir.statementExpressions).flatMap(Tir.expressionTree),
    )
    const runtimeView = expressions.find((expression) => expression._tag === 'RuntimeStringView')
    assert.strictEqual(runtimeView?._tag, 'RuntimeStringView')
    if (runtimeView?._tag === 'RuntimeStringView') {
      assert.isTrue(Type.isString(runtimeView.type))
      assert.strictEqual(runtimeView.source._tag, 'ParameterReference')
      assert.deepEqual(runtimeView.heldLoans, [])
    }
    assert.deepEqual(
      expressions.flatMap((expression) =>
        expression._tag === 'BuiltinCall' &&
        (expression.operation === 'StringUtf8Bytes' || expression.operation === 'StringByteLength')
          ? [expression.operation]
          : [],
      ),
      ['StringUtf8Bytes', 'StringByteLength'],
    )
    assert.isTrue(
      expressions.some((expression) => expression._tag === 'StringEquality' && !expression.negated),
    )
    assert.include(Tir.encode(tir), 'runtime-string-view loans=none : string')
    assert.deepEqual(Tir.verify(tir), [])
  }),
)

it.effect('routes string equality operators through exact equality only', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'string/operators',
      encoder.encode(`fn equal(left: string, right: string) -> bool { return left == right }
fn different(left: string, right: string) -> bool { return left != right }
fn scalar() -> bool { return 1 == 1 }
pub fn main() -> i32 { return 0 }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const tir = Projections.tirOf(snapshot, 'string/operators')
    assert.isDefined(tir)
    if (tir !== undefined) {
      const expressions = tir.functions.flatMap((fn) =>
        fn.statements.flatMap(Tir.statementExpressions).flatMap(Tir.expressionTree),
      )
      const equality = expressions.filter((expression) => expression._tag === 'StringEquality')
      assert.deepEqual(
        equality.map((expression) => expression.negated),
        [false, true],
      )
      assert.isTrue(
        equality.every(
          (expression) =>
            Intrinsic.operationText(expression.intrinsic) === 'Intrinsic.stringEqualsExact',
        ),
      )
      assert.isTrue(
        expressions.some(
          (expression) => expression._tag === 'BuiltinCall' && expression.operation === 'Equals',
        ),
      )
      assert.include(Tir.encode(tir), 'string-not-equals intrinsic=Intrinsic.stringEqualsExact')
      assert.deepEqual(Tir.verify(tir), [])
    }

    const mixed = yield* Analysis.ofSource(
      'string/mixed-operator',
      encoder.encode('fn mixed(left: string, right: &[u8]) -> bool { return left == right }'),
    )
    assert.deepEqual(
      Analysis.diagnostics(mixed).map((diagnostic) => diagnostic.code),
      ['SEM0012'],
    )
  }),
)

it.effect('rejects unchecked UTF-8 formation outside an unsafe boundary', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'string/unsafe',
      encoder.encode(
        'fn view(bytes: &[u8]) -> string { return Intrinsic.stringFromUtf8Unchecked(bytes) }',
      ),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        reason: diagnostic.reason._tag,
      })),
      [{ code: 'SEM0082', reason: 'MissingUnsafeBoundary' }],
    )
  }),
)

it('publishes a safe runtime shared subrange retaining only its source lifetime', () => {
  const operation = Intrinsic.findOperation('Intrinsic', 'sliceView')
  assert.isDefined(operation)
  if (operation === undefined || operation.rule._tag !== 'BuiltinRule') return
  assert.strictEqual(
    Intrinsic.signature(operation),
    'fn Intrinsic.sliceView<T>(values: &[T], offset: usize, length: usize) -> &[T]',
  )
  assert.isFalse(operation.unsafe)
  assert.deepEqual(operation.targets, Intrinsic.runtimeTargets)
  const parameter = operation.rule.parameters.at(0)
  assert.isDefined(parameter)
  if (parameter === undefined) return
  assert.deepEqual(
    Type.storageLifetimes(parameter),
    Type.storageLifetimes(closedBuiltinResult(operation)),
  )
})

it.effect('rejects escaping a subrange of local backing storage', () =>
  Effect.gen(function* () {
    const source = `pub fn escape(input: &[u8]) -> &[u8] {
  let bytes: [u8; 2] = [1, 2]
  return Intrinsic.sliceView(&bytes, 1, 1)
}`
    const snapshot = yield* Analysis.ofSource('slice/escape', encoder.encode(source))
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.deepEqual(
      diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'OWN0019', span: 'Intrinsic.sliceView(&bytes, 1, 1)' },
        { code: 'OWN0019', span: 'Intrinsic.sliceView(&bytes, 1, 1)' },
        { code: 'SEM0212', span: '&bytes' },
      ],
    )
  }),
)

it.effect('rejects borrowed URI escape and mutation of its live backing bytes', () =>
  Effect.gen(function* () {
    const source = `import silk.uri { Uri }
import silk.uri_reference { ParseError }
import silk.result { Result }
import silk.string { String }
fn escape<'a>(input: string<'a>) -> Result<Uri<'a>, ParseError> {
  let bytes: [u8; 3] = [120, 58, 97]
  let text = unsafe String.fromUtf8Unchecked(&bytes)
  return Uri.parse(text)
}
fn forwarded<'a>(input: string<'a>) -> Result<Uri<'a>, ParseError> {
  return Uri.parse(input)
}
fn inspect<'a>(parsed: Result<Uri<'a>, ParseError>) -> bool {
  return match move parsed {
    Result<Uri<'a>, ParseError>.Success { value } => Uri.path(&value) == "a"
    Result<Uri<'a>, ParseError>.Failure { error } => false
  }
}
fn conflict() -> bool {
  let mut bytes: [u8; 3] = [120, 58, 97]
  unsafe {
    let parsed = Uri.parse(String.fromUtf8Unchecked(&bytes))
    bytes[2] = 98
    return inspect(move parsed)
  }
  return false
}`
    const snapshot = yield* Analysis.ofSource('uri/borrowed-ownership', encoder.encode(source))
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'SEM0212', span: '&bytes' },
        { code: 'OWN0019', span: 'Uri.parse(text)' },
        { code: 'OWN0019', span: 'Uri.parse(text)' },
        { code: 'OWN0011', span: 'bytes[2]' },
        { code: 'OWN0019', span: 'move parsed' },
        { code: 'OWN0019', span: 'parsed' },
      ],
    )
  }),
)
