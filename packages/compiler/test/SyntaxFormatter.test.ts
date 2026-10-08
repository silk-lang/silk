import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as FormattedDocument from '../src/FormattedDocument.js'
import * as Lexer from '../src/Lexer.js'
import * as LiteralForm from '../src/LiteralForm.js'
import * as Parser from '../src/Parser.js'
import * as SourceFile from '../src/SourceFile.js'
import * as StaticText from '../src/StaticText.js'
import type * as SyntaxFile from '../src/SyntaxFile.js'
import * as SyntaxFormatter from '../src/SyntaxFormatter.js'
import * as SyntaxTree from '../src/SyntaxTree.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const parse = (id: string, source: string): SyntaxFile.SyntaxFile =>
  Parser.parse(Lexer.lex(SourceFile.make(id, encoder.encode(source))))

const formattedText = (document: FormattedDocument.FormattedDocument): string =>
  decoder.decode(FormattedDocument.toUint8Array(document))

interface NormalizedNode {
  readonly kind: SyntaxTree.NodeKind
  readonly children: ReadonlyArray<NormalizedNode | string>
}

const normalized = (syntax: SyntaxFile.SyntaxFile, node: SyntaxTree.Node): NormalizedNode => ({
  kind: node.kind,
  children: node.children.flatMap((child): ReadonlyArray<NormalizedNode | string> => {
    if (SyntaxTree.isNode(child)) return [normalized(syntax, child)]
    if (SyntaxTree.isMissingToken(child)) return [`missing:${child.expected}`]
    if (
      child.kind === 'Whitespace' ||
      child.kind === 'LineComment' ||
      child.kind === 'DocComment' ||
      child.kind === 'ModuleDocComment' ||
      child.kind === 'Comma' ||
      child.kind === 'EndOfFile'
    ) {
      return []
    }
    return [
      `${child.kind}:${decoder.decode(Option.getOrThrow(SourceFile.slice(syntax.source, child.span)))}`,
    ]
  }),
})

const comments = (syntax: SyntaxFile.SyntaxFile): ReadonlyArray<string> =>
  syntax.tokens
    .filter(
      (token) =>
        token.kind === 'LineComment' ||
        token.kind === 'DocComment' ||
        token.kind === 'ModuleDocComment',
    )
    .map((token) => decoder.decode(Option.getOrThrow(SourceFile.slice(syntax.source, token.span))))

const staticValues = (syntax: SyntaxFile.SyntaxFile): ReadonlyArray<ReadonlyArray<number>> =>
  syntax.tokens.flatMap((token) => {
    if (token.kind !== 'TextLiteral' && token.kind !== 'ByteStringLiteral') return []
    const spelling = Option.getOrThrow(SourceFile.slice(syntax.source, token.span))
    const form = LiteralForm.recognize(spelling)
    if (form === undefined) throw new Error('literal token has no recognized form')
    const result = StaticText.decode(Array.from(spelling), form)
    if (result._tag === 'Invalid') throw new Error(result.detail)
    return [result.data.bytes]
  })

const nodeKinds = (node: SyntaxTree.Node): ReadonlyArray<SyntaxTree.NodeKind> => [
  node.kind,
  ...node.children.flatMap((child): ReadonlyArray<SyntaxTree.NodeKind> =>
    SyntaxTree.isNode(child) ? nodeKinds(child) : [],
  ),
]

const completeNodeKinds: ReadonlyArray<SyntaxTree.NodeKind> = Object.freeze([
  'AppliedType',
  'ArgumentList',
  'ArrayLiteralExpression',
  'AnonymousCallableExpression',
  'AssignmentStatement',
  'BindingPattern',
  'BindingStatement',
  'PatternBindingStatement',
  'Block',
  'BooleanLiteralExpression',
  'BorrowExpression',
  'BreakStatement',
  'CallExpression',
  'CallTypeArgumentList',
  'ConditionalStatement',
  'StaticConditionalStatement',
  'StaticConditionalDeclaration',
  'DeclarationGroup',
  'StaticForStatement',
  'PatternConditionalStatement',
  'ContinueStatement',
  'ConstantDeclaration',
  'CompileErrorExpression',
  'DropStatement',
  'DurationLiteralExpression',
  'EffectExpression',
  'EnumDeclaration',
  'EnumMember',
  'UnionDeclaration',
  'UnionVariant',
  'UnionVariantField',
  'AppliedMemberSelector',
  'AppliedMemberExpression',
  'UnionVariantPattern',
  'FieldProjectionExpression',
  'ReferentProjectionExpression',
  'FailStatement',
  'FailureRow',
  'FixedArrayType',
  'FunctionDeclaration',
  'ForeignFunctionDeclaration',
  'ForeignStaticDeclaration',
  'ExportStaticDeclaration',
  'GroupedExpression',
  'IdentifierExpression',
  'ImportAlias',
  'ImportDeclaration',
  'ImportMember',
  'ImportMemberList',
  'ImportPath',
  'IndexProjectionExpression',
  'InfixExpression',
  'IntegerLiteralExpression',
  'MatchAccess',
  'MatchArm',
  'MatchExpression',
  'MoveExpression',
  'NominalPattern',
  'ParameterDeclaration',
  'ParameterList',
  'ParenthesizedType',
  'PipelineExpression',
  'PointerType',
  'PointerQualifier',
  'CallableType',
  'ForeignFunctionType',
  'ExactRepresentationType',
  'ExpressionStatement',
  'PrefixExpression',
  'ReferenceType',
  'Requirement',
  'RequirementRow',
  'RequirementSelector',
  'RoleDeclaration',
  'PatternField',
  'ReturnStatement',
  'RunExpression',
  'ReturnType',
  'RestPattern',
  'SliceType',
  'SourceFile',
  'StructDeclaration',
  'TupleDeclaration',
  'StructField',
  'StructFieldInitializer',
  'StructLiteralExpression',
  'TupleLiteralExpression',
  'TypeAliasDeclaration',
  'ContextualRecordLiteralExpression',
  'OrdinalProjectionExpression',
  'TypeArgumentList',
  'TypeParameter',
  'TypeParameterList',
  'TypePath',
  'UnionType',
  'UnitExpression',
  'UnsafeExpression',
  'UniversalPattern',
  'WhileStatement',
])

it.effect(
  'formats lifetime bounds and environments without losing comments or elaborating omissions',
  () =>
    Effect.gen(function* () {
      const source = `struct Holder < 'a : 'b + 'c, 'b, 'c, T : Copy + 'a > {
  value: & 'a T
  values: & 'b mut [T]
  text: string < 'c >
  omitted: &T
}
effect < 'env & 'other > fn apply <'env,'other,T>(callback: for < 'call > once fn < 'env > (& 'call T)-> & 'call T, pending: Effect < 'env & 'other ; // environment
T ! Error ? &Clock >) -> () {drop pending}
fn inspect(value: Choice)->i32{return match place value {Choice.Some{field}=>field Choice.None=>0}}`
      const original = parse('memory://format-lifetimes.silk', source)
      assert.deepEqual(original.lexicalDiagnostics, [])
      assert.deepEqual(original.parserDiagnostics, [])
      const first = yield* SyntaxFormatter.format(original)
      const text = formattedText(first)
      assert.include(text, "Holder<'a: 'b + 'c, 'b, 'c, T: Copy + 'a>")
      assert.include(text, "value: &'a T")
      assert.include(text, "values: &'b mut [T]")
      assert.include(text, "text: string<'c>")
      assert.include(text, 'omitted: &T')
      assert.include(text, "for<'call> once fn<'env>(&'call T) -> &'call T")
      assert.include(text, "Effect<'env & 'other;")
      assert.include(text, 'match place value')
      assert.include(text, "effect<'env & 'other> fn apply<'env, 'other, T>")
      const reparsed = parse('memory://format-lifetimes.silk', text)
      assert.deepEqual(reparsed.parserDiagnostics, [])
      assert.deepEqual(normalized(reparsed, reparsed.root), normalized(original, original.root))
      assert.deepEqual(comments(reparsed), comments(original))
      const second = yield* SyntaxFormatter.format(reparsed)
      assert.strictEqual(formattedText(second), text)
    }),
)

it.effect('preserves singleton tuples and joins contextual record punctuation', () =>
  Effect.gen(function* () {
    const first = yield* SyntaxFormatter.format(
      parse(
        'memory://aggregate-format.silk',
        'tuple One(i32) fn one()->One { let value: One=(1,) let record= . {age:32} return value }',
      ),
    )
    const text = formattedText(first)
    assert.include(text, 'tuple One(i32)')
    assert.include(text, 'let value: One = (1,)')
    assert.include(text, 'let record = .{age: 32}')
    const second = yield* SyntaxFormatter.format(parse('memory://aggregate-format-2.silk', text))
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('formats static syntax canonically and idempotently', () =>
  Effect.gen(function* () {
    const first = yield* SyntaxFormatter.format(
      parse(
        'memory://static-format.silk',
        'pub static fn render(static template:string,value:string)->(){let static parsed=template static for part in parts{emit(part)} static if true{compileError(parsed)}else{compileError("fallback")}}',
      ),
    )
    const text = formattedText(first)
    assert.include(text, 'pub static fn render')
    assert.include(text, 'static template: string')
    assert.include(text, 'let static parsed = template')
    assert.include(text, 'static for part in parts {')
    assert.include(text, 'static if true {')
    assert.include(text, 'compileError(parsed)')
    const second = yield* SyntaxFormatter.format(parse('memory://static-format-2.silk', text))
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('formats a generic effect catch pipeline canonically and idempotently', () =>
  Effect.gen(function* () {
    const source =
      'pub fn main()->i32 { let recipe=risky()|>Core.prepare()|>Effect.catchAll(recover) return 0 }'
    const first = yield* SyntaxFormatter.format(
      parse('memory://effect-catch-pipeline.silk', source),
    )
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `pub fn main() -> i32 {
  let recipe = risky()
    |> Core.prepare()
    |> Effect.catchAll(recover)
  return 0
}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://effect-catch-pipeline.silk', text))
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('preserves duration component spelling while formatting surrounding expressions', () =>
  Effect.gen(function* () {
    const source = 'fn main()->u64{return 01h05m00s+1h0m30s+1_000ms}'
    const first = yield* SyntaxFormatter.format(parse('memory://duration-format.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `fn main() -> u64 {
  return 01h05m00s + 1h0m30s + 1_000ms
}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://duration-format.silk', text))
    assert.strictEqual(formattedText(second), text)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats implicit and explicitly represented enums canonically and idempotently', () =>
  Effect.gen(function* () {
    const source =
      'enum AssertionResult{Pass,Fail,Skip} pub enum ( u8 ) ExitCode { Success=0,Failure=1 }'
    const first = yield* SyntaxFormatter.format(parse('memory://enum-format.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `enum AssertionResult {
  Pass,
  Fail,
  Skip,
}

pub enum(u8) ExitCode {
  Success = 0,
  Failure = 1,
}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://enum-format.silk', text))
    assert.strictEqual(formattedText(second), text)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats nominal unions, constructors, and patterns canonically and idempotently', () =>
  Effect.gen(function* () {
    const source =
      'pub union Result<A,E>{Success{pub value:A},Failure{pub error:E}} fn inspect(value:Result<i32,bool>)->i32{return match move value{Result<i32,bool>.Success{value}=>value Result<i32,bool>.Failure{error:_}=>0}}'
    const first = yield* SyntaxFormatter.format(parse('memory://nominal-union-format.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `pub union Result<A, E> {
  Success {pub value: A},
  Failure {pub error: E},
}

fn inspect(value: Result<i32, bool>) -> i32 {
  return match move value {
    Result<i32, bool>.Success {value} => value
    Result<i32, bool>.Failure {error: _} => 0
  }
}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://nominal-union-format.silk', text))
    assert.strictEqual(formattedText(second), text)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('preserves nominal union comments idempotently', () =>
  Effect.gen(function* () {
    const source = `// union docs
pub union Maybe<T> {
  // unit
  None,
  // payload
  Some { pub value: T },
}`
    const first = yield* SyntaxFormatter.format(
      parse('memory://nominal-union-comments.silk', source),
    )
    const text = formattedText(first)
    assert.strictEqual(text.includes('// union docs'), true)
    assert.strictEqual(text.includes('// unit'), true)
    assert.strictEqual(text.includes('// payload'), true)
    const second = yield* SyntaxFormatter.format(
      parse('memory://nominal-union-comments.silk', text),
    )
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('formats type alias declarations canonically and idempotently', () =>
  Effect.gen(function* () {
    const source = `// alias docs
pub   type   FetchError=HttpError|JsonError  |  Timeout
// applied alias
type PointF32 = Point < f32 >`
    const first = yield* SyntaxFormatter.format(parse('memory://type-alias-format.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `// alias docs
pub type FetchError = HttpError | JsonError | Timeout

// applied alias
type PointF32 = Point<f32>
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://type-alias-format.silk', text))
    assert.strictEqual(formattedText(second), text)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats foreign function declarations canonically and idempotently', () =>
  Effect.gen(function* () {
    const source = `// native absolute value
pub   unsafe extern "C"  fn cAbs( value : i32 )->i32 as "abs"
unsafe  extern "C" fn tick( ) with Intrinsic.foreign( memory : "none",noReturn:true )`
    const first = yield* SyntaxFormatter.format(parse('memory://foreign-format.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `// native absolute value
pub unsafe extern "C" fn cAbs(value: i32) -> i32 as "abs"

unsafe extern "C" fn tick() with Intrinsic.foreign(memory: "none", noReturn: true)
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://foreign-format.silk', text))
    assert.strictEqual(formattedText(second), text)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats service operation executable properties canonically and idempotently', () =>
  Effect.gen(function* () {
    const source =
      'service Duplex{effect fn close( )->() ? &mut Duplex with Intrinsic.nonParking( )}'
    const first = yield* SyntaxFormatter.format(parse('memory://service-property.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `service Duplex {
  effect fn close() -> () ? &mut Duplex with Intrinsic.nonParking()
}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://service-property.silk', text))
    assert.strictEqual(formattedText(second), text)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats C-layout struct declarations canonically and idempotently', () =>
  Effect.gen(function* () {
    const source = 'pub   extern  "C"struct Timespec{seconds:i64 nanoseconds:i64}'
    const first = yield* SyntaxFormatter.format(parse('memory://c-layout-struct.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `pub extern "C" struct Timespec {
  seconds: i64
  nanoseconds: i64
}
`,
    )
    const second = yield* SyntaxFormatter.format(
      parse('memory://c-layout-struct-idempotent.silk', text),
    )
    assert.strictEqual(formattedText(second), text)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats retained foreign declaration forms without repair', () =>
  Effect.gen(function* () {
    const source =
      'static unsafe extern "C" effect fn g<T>(value: T) -> i32 ! Problem as "g" { return 1 }'
    const first = yield* SyntaxFormatter.format(parse('memory://foreign-retained.silk', source))
    assert.strictEqual(
      formattedText(first),
      `static unsafe extern "C" effect fn g<T>(value: T) -> i32 ! Problem as "g" {
  return 1
}
`,
    )
  }),
)

it.effect('formats exported function declarations canonically and idempotently', () =>
  Effect.gen(function* () {
    const source = `// exported symbol
pub  export "C"fn double( value:i32 )->i32 as "silk_test_double_v1"{ return value * 2 }
export "C"  fn tick( ) {}`
    const first = yield* SyntaxFormatter.format(parse('memory://export-format.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `// exported symbol
pub export "C" fn double(value: i32) -> i32 as "silk_test_double_v1" {
  return value * 2
}

export "C" fn tick() {}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://export-format.silk', text))
    assert.strictEqual(formattedText(second), text)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('omits semantic fallthrough completion nodes from formatted source', () =>
  Effect.gen(function* () {
    const source = 'fn missing()->i32 { let value=42 } pub fn main()->() {}'
    const first = yield* SyntaxFormatter.format(parse('memory://implicit-returns.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `fn missing() -> i32 {
  let value = 42
}

pub fn main() -> () {}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://implicit-returns.silk', text))
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect(
  'formats callable contracts, postfix calls, pipelines, and run precedence idempotently',
  () =>
    Effect.gen(function* () {
      const source =
        'fn apply(callback:mut fn(i32)->i32,value:i32)->i32{return (callback)(value)} fn main(attempt:Effect<i32>)->i32{return run attempt|>Effect.retry(2)}'
      const first = yield* SyntaxFormatter.format(parse('memory://callable-format.silk', source))
      const text = formattedText(first)
      assert.strictEqual(
        text,
        `fn apply(callback: mut fn(i32) -> i32, value: i32) -> i32 {
  return (callback)(value)
}

fn main(attempt: Effect<i32>) -> i32 {
  return run attempt
    |> Effect.retry(2)
}
`,
      )
      const second = yield* SyntaxFormatter.format(parse('memory://callable-format.silk', text))
      assert.deepEqual(second.bytes, first.bytes)
      assert.strictEqual(second.changed, false)
    }),
)

it.effect('formats applied interface operation calls and pipelines idempotently', () =>
  Effect.gen(function* () {
    const source =
      'fn main(age:&Age)->u32{let direct=run Encodable<u32>.encode(&age) let piped=run &age|>Encodable<u32>.encode return direct}'
    const first = yield* SyntaxFormatter.format(
      parse('memory://applied-interface-operation.silk', source),
    )
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `fn main(age: &Age) -> u32 {
  let direct = run Encodable<u32>.encode(&age)
  let piped = run &age
    |> Encodable<u32>.encode
  return direct
}
`,
    )
    const second = yield* SyntaxFormatter.format(
      parse('memory://applied-interface-operation.silk', text),
    )
    assert.deepEqual(second.bytes, first.bytes)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats relational comparisons after applied union members idempotently', () =>
  Effect.gen(function* () {
    const source = 'fn compare(value:Option<i32>)->bool{return Option<i32>.None<value}'
    const first = yield* SyntaxFormatter.format(
      parse('memory://applied-union-relational-less-than.silk', source),
    )
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `fn compare(value: Option<i32>) -> bool {
  return Option<i32>.None < value
}
`,
    )
    const second = yield* SyntaxFormatter.format(
      parse('memory://applied-union-relational-less-than.silk', text),
    )
    assert.deepEqual(second.bytes, first.bytes)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats mutable owned parameters canonically and idempotently', () =>
  Effect.gen(function* () {
    const source =
      'fn update( mut counter:Counter,mut amount:i32)->Counter { return move counter } effect fn process(mut state:i32)->i32{return state}'
    const first = yield* SyntaxFormatter.format(parse('memory://mutable-parameters.silk', source))
    const text = formattedText(first)

    assert.strictEqual(
      text,
      `fn update(mut counter: Counter, mut amount: i32) -> Counter {
  return move counter
}

effect fn process(mut state: i32) -> i32 {
  return state
}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://mutable-parameters.silk', text))
    assert.deepEqual(second.bytes, first.bytes)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats effect contracts, run, and fail canonically and idempotently', () =>
  Effect.gen(function* () {
    const source = `effect   fn work(problem:Problem)->i32 ! Problem|Other { if true { fail   move problem } return 42 }
fn main()->i32 { let pending=work(Problem { code:1 }) return run   pending }`
    const first = yield* SyntaxFormatter.format(parse('memory://effect-format.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `effect fn work(problem: Problem) -> i32 ! Problem | Other {
  if true {
    fail move problem
  }
  return 42
}

fn main() -> i32 {
  let pending = work(Problem {code: 1})
  return run pending
}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://effect-format.silk', text))
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('formats adjacent expression statements with comments idempotently', () =>
  Effect.gen(function* () {
    const source = `effect fn pulse()->(){return ()}
pub effect fn main()->(){run pulse() // first pulse
// before the second pulse
run pulse() return ()}`
    const original = parse('memory://expression-statements.silk', source)
    const first = yield* SyntaxFormatter.format(original)
    const text = formattedText(first)

    assert.strictEqual(
      text,
      `effect fn pulse() -> () {
  return ()
}

pub effect fn main() -> () {
  run pulse() // first pulse
  // before the second pulse
  run pulse()
  return ()
}
`,
    )

    const reparsed = parse('memory://expression-statements.silk', text)
    assert.deepEqual(reparsed.lexicalDiagnostics, [])
    assert.deepEqual(reparsed.parserDiagnostics, [])
    assert.deepEqual(normalized(reparsed, reparsed.root), normalized(original, original.root))
    assert.deepEqual(comments(reparsed), comments(original))

    const second = yield* SyntaxFormatter.format(reparsed)
    assert.deepEqual(second.bytes, first.bytes)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats explicit drop canonically and idempotently', () =>
  Effect.gen(function* () {
    const first = yield* SyntaxFormatter.format(
      parse(
        'memory://drop-format.silk',
        'struct Token { value:i32 } fn main()->i32 { let token=Token { value:1 } drop   token return 42 }',
      ),
    )
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `struct Token {
  value: i32
}

fn main() -> i32 {
  let token = Token {value: 1}
  drop token
  return 42
}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://drop-format.silk', text))
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('formats a chained else if arm on one line and idempotently', () =>
  Effect.gen(function* () {
    const first = yield* SyntaxFormatter.format(
      parse(
        'memory://else-if-format.silk',
        'pub fn classify(value:i32)->i32 { if value<0 { return 0 } else   if value<10 { return 1 } else if value<100 { return 2 } else { return 3 } return 4 }',
      ),
    )
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `pub fn classify(value: i32) -> i32 {
  if value < 0 {
    return 0
  } else if value < 10 {
    return 1
  } else if value < 100 {
    return 2
  } else {
    return 3
  }
  return 4
}
`,
    )
    // The chained arm never gains a line break, so each condition stays at the
    // indentation of the conditional it continues.
    for (const line of text.split('\n')) {
      if (line.includes('else if')) assert.match(line, /^ {2}} else if .+ \{$/)
    }

    const reparsed = parse('memory://else-if-format.silk', text)
    assert.deepEqual(reparsed.lexicalDiagnostics, [])
    assert.deepEqual(reparsed.parserDiagnostics, [])
    const second = yield* SyntaxFormatter.format(reparsed)
    assert.strictEqual(formattedText(second), text)
    assert.deepEqual(second.bytes, first.bytes)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats the bitwise operators with canonical spacing and idempotently', () =>
  Effect.gen(function* () {
    const first = yield* SyntaxFormatter.format(
      parse(
        'memory://bitwise-format.silk',
        'pub fn checksum(value:u32,mask:u32)->u32 { let masked = value&mask let flipped = ~masked return flipped^mask|masked }',
      ),
    )
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `pub fn checksum(value: u32, mask: u32) -> u32 {
  let masked = value & mask
  let flipped = ~masked
  return flipped ^ mask | masked
}
`,
    )

    const reparsed = parse('memory://bitwise-format.silk', text)
    assert.deepEqual(reparsed.lexicalDiagnostics, [])
    assert.deepEqual(reparsed.parserDiagnostics, [])
    const second = yield* SyntaxFormatter.format(reparsed)
    assert.strictEqual(formattedText(second), text)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats unsafe blocks and conformance declarations canonically and idempotently', () =>
  Effect.gen(function* () {
    const source =
      'impl Allocator for SystemAllocator{allocate:SystemAllocator.allocate} impl Drop for Guard<Token>{fn drop(self:&mut Guard<Token>)->(){unsafe{drop self.value} return ()}}'
    const first = yield* SyntaxFormatter.format(parse('memory://unsafe-format.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `impl Allocator for SystemAllocator {
  allocate: SystemAllocator.allocate
}

impl Drop for Guard<Token> {
  fn drop(self: &mut Guard<Token>) -> () {
    unsafe {
      drop self.value
    }
    return ()
  }
}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://unsafe-format.silk', text))
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('formats whole-member binding patterns canonically and idempotently', () =>
  Effect.gen(function* () {
    const source =
      'fn take(state: Empty | Full) -> i32 { return match move state { Empty   nothing => 0 Full   full => 1 } }'
    const first = yield* SyntaxFormatter.format(
      parse('memory://binding-pattern-format.silk', source),
    )
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `fn take(state: Empty | Full) -> i32 {
  return match move state {
    Empty nothing => 0
    Full full => 1
  }
}
`,
    )
    const second = yield* SyntaxFormatter.format(
      parse('memory://binding-pattern-format.silk', text),
    )
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('formats parametric conformances canonically and idempotently', () =>
  Effect.gen(function* () {
    const source = 'impl < T >Drop for Vector<T>{fn drop(self:&mut Vector<T>)->(){return ()}}'
    const first = yield* SyntaxFormatter.format(parse('memory://parametric-format.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `impl<T> Drop for Vector<T> {
  fn drop(self: &mut Vector<T>) -> () {
    return ()
  }
}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://parametric-format.silk', text))
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('formats bounded conditional conformances canonically and idempotently', () =>
  Effect.gen(function* () {
    const source =
      'impl < S : Decoder<S> >Decoder<MappedSchema<S>>for MappedSchema<S>{decode:MappedSchema.mappedDecode}'
    const first = yield* SyntaxFormatter.format(parse('memory://conditional-format.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `impl<S: Decoder<S>> Decoder<MappedSchema<S>> for MappedSchema<S> {
  decode: MappedSchema.mappedDecode
}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://conditional-format.silk', text))
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('formats explicit Effect and declaration requirement rows', () =>
  Effect.gen(function* () {
    const source = `fn later()->Effect<i32!Problem?&FileSystem|&mut Allocator at Scratch>{return effect{return 1}}
effect fn work()->i32!Problem?&FileSystem|&mut Allocator at Scratch{return 1}`
    const first = yield* SyntaxFormatter.format(
      parse('memory://effect-requirement-format.silk', source),
    )
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `fn later() -> Effect<i32 ! Problem ? &FileSystem | &mut Allocator at Scratch> {
  return effect {
    return 1
  }
}

effect fn work() -> i32 ! Problem ? &FileSystem | &mut Allocator at Scratch {
  return 1
}
`,
    )
    const second = yield* SyntaxFormatter.format(
      parse('memory://effect-requirement-format.silk', text),
    )
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('formats row differences and callable constraints idempotently', () =>
  Effect.gen(function* () {
    const source = `effect fn bind<?S,A,P,E,?R>(self:once Effect<A!E?R>,provider:&mut P)->A!E?Without<R,S> where &mut P provides S from R,S in R{return run self}`
    const first = yield* SyntaxFormatter.format(parse('memory://row-constraints.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `effect fn bind<?S, A, P, E, ?R>(self: once Effect<A ! E ? R>, provider: &mut P) -> A
! E
? Without<R, S>
where &mut P provides S from R, S in R {
  return run self
}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://row-constraints.silk', text))
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('preserves a requirement union that begins with row difference', () =>
  Effect.gen(function* () {
    const source = `effect fn acquire<?S,A,E,F,?R,?Q>(self:once Effect<A!E?R>)->A!F?Without<R,S>|Q where S in R{return run self}`
    const first = yield* SyntaxFormatter.format(parse('memory://row-union-format.silk', source))
    const formatted = formattedText(first)
    assert.include(formatted, '? Without<R, S> | Q')
    const reparsed = parse('memory://row-union-format.silk', formatted)
    assert.deepEqual(reparsed.parserDiagnostics, [])
    const second = yield* SyntaxFormatter.format(reparsed)
    assert.strictEqual(formattedText(second), formatted)
  }),
)

it.effect('preserves nested row-difference precedence and selected-row call prefixes', () =>
  Effect.gen(function* () {
    const source = `effect fn transform<?S,A,P,E,F,?R,?Q>(self:once Effect<A!E|F?R|Q>,provider:&mut P)->A!Without<E|F,First|Third>?Without<R|Q,S> where &mut P provides S from R|Q{return run Intrinsic.bindRequirementMut<Logger at Audit>(move self,provider)}`
    const first = yield* SyntaxFormatter.format(parse('memory://nested-row-format.silk', source))
    const text = formattedText(first)
    assert.include(text, '! Without<E | F, First | Third>')
    assert.include(text, '? Without<R | Q, S>')
    assert.include(text, 'Intrinsic.bindRequirementMut<Logger at Audit>')
    const second = yield* SyntaxFormatter.format(parse('memory://nested-row-format.silk', text))
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('breaks long constraint lists after where with one constraint per line', () =>
  Effect.gen(function* () {
    const source = `effect fn transform<S,P,A,E,?R>(self:once Effect<A!E?R>,provider:&mut P)->A!E?R where SelectedCapability in ExtremelyLongRequirementRowParameter,&mut ExtremelyLongProviderImplementation provides SelectedCapability from ExtremelyLongRequirementRowParameter,&ExtremelyLongSharedProviderImplementation provides SelectedCapability from ExtremelyLongRequirementRowParameter,ExtremelyLongOwnedProviderImplementation provides SelectedCapability from ExtremelyLongRequirementRowParameter,AnotherSelectedCapability in ExtremelyLongRequirementRowParameter{return run self}`
    const first = yield* SyntaxFormatter.format(parse('memory://long-where-format.silk', source))
    const text = formattedText(first)
    assert.include(
      text,
      `where
  SelectedCapability in ExtremelyLongRequirementRowParameter,
  &mut ExtremelyLongProviderImplementation provides SelectedCapability from ExtremelyLongRequirementRowParameter,
  &ExtremelyLongSharedProviderImplementation provides SelectedCapability from ExtremelyLongRequirementRowParameter,
  ExtremelyLongOwnedProviderImplementation provides SelectedCapability from ExtremelyLongRequirementRowParameter,
  AnotherSelectedCapability in ExtremelyLongRequirementRowParameter`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://long-where-format.silk', text))
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('formats effect blocks and Copy failure transfer canonically', () =>
  Effect.gen(function* () {
    const source = 'fn later()->i32 { let pending=effect{fail Problem{code:1}} return 0 }'
    const first = yield* SyntaxFormatter.format(
      parse('memory://effect-expression-format.silk', source),
    )
    const text = formattedText(first)
    assert.include(text, 'let pending = effect {')
    assert.include(text, 'fail Problem {code: 1}')
    const second = yield* SyntaxFormatter.format(
      parse('memory://effect-expression-format.silk', text),
    )
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('formats ordinary and effectful anonymous callables canonically and idempotently', () =>
  Effect.gen(function* () {
    const source =
      'fn main()->(){let ordinary=fn(value:i32)->i32{return value} let recover=effect fn(error:ExtremelyLongFailure,input:ExtremelyLongInput)->ExtremelyLongSuccess!ExtremelyLongFailure?&ExtremelyLongLogger{return 42}}'
    const first = yield* SyntaxFormatter.format(
      parse('memory://anonymous-callable-format.silk', source),
    )
    const text = formattedText(first)
    assert.include(text, 'let ordinary = fn(value: i32) -> i32 {')
    assert.include(text, 'let recover = effect fn(')
    assert.include(text, '! ExtremelyLongFailure')
    assert.include(text, '? &ExtremelyLongLogger {')
    const reparsed = parse('memory://anonymous-callable-format.silk', text)
    assert.deepEqual(reparsed.parserDiagnostics, [])
    const second = yield* SyntaxFormatter.format(reparsed)
    assert.strictEqual(formattedText(second), text)
  }),
)

const golden = (name: string): string =>
  readFileSync(new URL(`./goldens/${name}`, import.meta.url), 'utf8')

it.effect('normalizes physical whitespace and detects canonical source', () =>
  Effect.gen(function* () {
    const source = 'pub\tfn main ( ) -> Mystery {\r\n\treturn  value   \r\n}\r\n\r\n'
    const first = yield* SyntaxFormatter.format(parse('memory://physical.silk', source))
    const canonical = 'pub fn main() -> Mystery {\n  return value\n}\n'

    assert.strictEqual(formattedText(first), canonical)
    assert.strictEqual(first.changed, true)

    const second = yield* SyntaxFormatter.format(parse('memory://physical.silk', canonical))
    assert.strictEqual(formattedText(second), canonical)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('rejects lexical and parser damage without producing formatted bytes', () =>
  Effect.gen(function* () {
    const lexical = yield* Effect.result(
      SyntaxFormatter.format(parse('memory://lexical.silk', '@@@')),
    )
    const parser = yield* Effect.result(
      SyntaxFormatter.format(
        parse('memory://parser.silk', 'pub fn main() -> i32 { match 0 { _ => { drop 42'),
      ),
    )

    assert.strictEqual(Result.isFailure(lexical), true)
    assert.strictEqual(Result.isFailure(parser), true)
    if (Result.isFailure(lexical)) {
      assert.strictEqual(lexical.failure._tag, 'SyntaxFormatterError')
      assert.strictEqual(lexical.failure.reason._tag, 'DamagedSyntax')
      assert.isAbove(lexical.failure.diagnostics.length, 0)
    }
  }),
)

it.effect('formats fixed-array source types with canonical bracketed layout', () =>
  Effect.gen(function* () {
    const source = 'struct Arrays { values: [ [ i32 ;4 ] ;3 ] }'
    const first = yield* SyntaxFormatter.format(parse('memory://fixed-array-format.silk', source))
    const canonical = 'struct Arrays {\n  values: [[i32; 4]; 3]\n}\n'

    assert.strictEqual(formattedText(first), canonical)
    const second = yield* SyntaxFormatter.format(
      parse('memory://fixed-array-format.silk', formattedText(first)),
    )
    assert.deepEqual(second.bytes, first.bytes)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('refuses to repair a missing fixed-array semicolon', () =>
  Effect.gen(function* () {
    const attempted = yield* Effect.result(
      SyntaxFormatter.format(
        parse('memory://fixed-array-damage.silk', 'struct Broken { value: [i32 4] }'),
      ),
    )

    assert.strictEqual(Result.isFailure(attempted), true)
  }),
)

it.effect('formats syntactically complete source without semantic analysis', () =>
  Effect.gen(function* () {
    const document = yield* SyntaxFormatter.format(
      parse(
        'memory://semantic.silk',
        'pub fn identity(value: Missing) -> Missing { return unknown }',
      ),
    )

    assert.strictEqual(
      formattedText(document),
      'pub fn identity(value: Missing) -> Missing {\n  return unknown\n}\n',
    )
  }),
)

it.effect('breaks over-width lists one item per line with a trailing comma', () =>
  Effect.gen(function* () {
    const source =
      'pub fn combine(firstParameterWithALongName: ExtremelyLongTypeName, ' +
      'secondParameterWithALongName: AnotherExtremelyLongTypeName) -> Result { return firstParameterWithALongName }'
    const document = yield* SyntaxFormatter.format(parse('memory://width.silk', source))

    assert.strictEqual(
      formattedText(document),
      [
        'pub fn combine(',
        '  firstParameterWithALongName: ExtremelyLongTypeName,',
        '  secondParameterWithALongName: AnotherExtremelyLongTypeName,',
        ') -> Result {',
        '  return firstParameterWithALongName',
        '}',
        '',
      ].join('\n'),
    )
  }),
)

it.effect('preserves comment text and bounded blank-line attachment', () =>
  Effect.gen(function* () {
    const source = `/// first line
/// second line
pub fn first() -> i32 {
  let value = 1


  // grouped value
  let next = value // retained trailing comment
  return next
}


/// unattached

pub fn second() -> i32 { return 2 }
`
    const document = yield* SyntaxFormatter.format(parse('memory://comments.silk', source))

    assert.strictEqual(
      formattedText(document),
      `/// first line
/// second line
pub fn first() -> i32 {
  let value = 1

  // grouped value
  let next = value // retained trailing comment
  return next
}

/// unattached

pub fn second() -> i32 {
  return 2
}
`,
    )
    assert.include(formattedText(document), '}\n\n/// unattached')
  }),
)

it.effect('keeps nested, delimiter, field-documentation, and end-of-file comments in order', () =>
  Effect.gen(function* () {
    const source = `pub struct Documented {
  /// field documentation
  value: i32
}
pub fn main(
  /// parameter documentation
  value: i32
) -> i32 {
  return helper(
    value, // trailing argument
    2
  ) // trailing call
}
// end of file
`
    const original = parse('memory://comment-boundaries.silk', source)
    const document = yield* SyntaxFormatter.format(original)
    const reparsed = parse('memory://comment-boundaries.silk', formattedText(document))

    assert.deepEqual(comments(reparsed), comments(original))
    assert.strictEqual(
      formattedText(document),
      `pub struct Documented {
  /// field documentation
  value: i32
}

pub fn main(
  /// parameter documentation
  value: i32,
) -> i32 {
  return helper(
    value, // trailing argument
    2,
  ) // trailing call
}
// end of file
`,
    )
  }),
)

it.effect('preserves module and implementation-operation documentation attachment', () =>
  Effect.gen(function* () {
    const source = `//! Allocation module.
//! Owns allocation implementations.
impl Allocator for SystemAllocator {
/// Allocation operation.
allocate: SystemAllocator.allocate
}
`
    const original = parse('memory://module-comments.silk', source)
    const document = yield* SyntaxFormatter.format(original)
    const formatted = formattedText(document)
    const reparsed = parse('memory://module-comments.silk', formatted)

    assert.deepEqual(comments(reparsed), comments(original))
    assert.strictEqual(
      formatted,
      `//! Allocation module.
//! Owns allocation implementations.
impl Allocator for SystemAllocator {
  /// Allocation operation.
  allocate: SystemAllocator.allocate
}
`,
    )
  }),
)

it.effect('removes only terminal horizontal whitespace from comment spellings', () =>
  Effect.gen(function* () {
    const source = '/// documentation  \t\npub fn main() -> i32 { return 1 // value  \t\n}\n'
    const document = yield* SyntaxFormatter.format(
      parse('memory://comment-whitespace.silk', source),
    )

    assert.strictEqual(
      formattedText(document),
      '/// documentation\npub fn main() -> i32 {\n  return 1 // value\n}\n',
    )
  }),
)

it.effect('formats match arms, guards, access modes, and nested patterns idempotently', () =>
  Effect.gen(function* () {
    const source = `pub struct Span { start: i32 end: i32 }
pub struct Token { span: Span }
pub fn inspect(event: Token) -> i32 { return match   & mut event { Token { span: Span { start: offset , .. }, .. } if true=>{ // selected\n let result=offset return result } Token {..} if false=>{} Token {..}=>0 _=>{ // empty
    } } }`
    const first = yield* SyntaxFormatter.format(parse('memory://match-format.silk', source))
    const expected = `pub struct Span {
  start: i32
  end: i32
}

pub struct Token {
  span: Span
}

pub fn inspect(event: Token) -> i32 {
  return match &mut event {
    Token {span: Span {start: offset, ..}, ..} if true => { // selected
      let result = offset
      return result
    }
    Token {..} if false => {}
    Token {..} => 0
    _ => { // empty
    }
  }
}
`

    assert.strictEqual(formattedText(first), expected)
    const second = yield* SyntaxFormatter.format(parse('memory://match-format.silk', expected))
    assert.deepEqual(second.bytes, first.bytes)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('preserves multiline literal bodies while normalizing surrounding source and CRLF', () =>
  Effect.gen(function* () {
    const source = `pub fn main()->i32{
let value="""\r\n  first  \r\n second\n"""
let bytes=b"""left\n    right"""
let indexed="""x\ny"""[0]
return 0
}`
    const original = parse('memory://multiline-format.silk', source)
    assert.deepEqual(original.lexicalDiagnostics, [])
    assert.deepEqual(original.parserDiagnostics, [])
    const first = yield* SyntaxFormatter.format(original)
    const trailingSpaces = '  '
    const expected = `pub fn main() -> i32 {
  let value = """
  first${trailingSpaces}
 second
"""
  let bytes = b"""left
    right"""
  let indexed = """x
y"""[0]
  return 0
}
`
    assert.strictEqual(formattedText(first), expected)
    const reparsed = parse('memory://multiline-format.silk', expected)
    assert.deepEqual(reparsed.lexicalDiagnostics, [])
    assert.deepEqual(reparsed.parserDiagnostics, [])
    assert.deepEqual(staticValues(reparsed), staticValues(original))
    const second = yield* SyntaxFormatter.format(reparsed)
    assert.deepEqual(second.bytes, first.bytes)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('prints and reparses the complete current grammar surface', () =>
  Effect.gen(function* () {
    const source = `import Core.Math { add as plus, subtract }
static if true { pub import first { original as selected } } else static if false { import second } else { pub const selected: i32 = 1 }
pub const limit:i32=2
pub const timeout:u64=01h05m00s
pub struct Pair {
  pub left: [i32; 2]
  right: bool
  choice: Alpha | (Beta | Alpha)
}
pub tuple Point(i32, i32)
pub struct Span { start: i32 end: i32 }
pub struct Token { span: Span }
pub struct End {}
enum AssertionResult { Pass, Fail, Skip }
pub enum(u8) ExitCode { Success = 0, Failure = 1 }
pub union Maybe<T> { None, Some { pub value: T } }
pub type Choice=Alpha|Beta
pub role Clock
static fn staticHelper(static value: i32) -> i32 {
  let static retained = value
  static for field in fields { inspect(field) }
  static if true { return compileError(retained) } else { return retained }
}
fn helper(value: i32, other: i32) -> i32 {
  let mut moved = move value
  let singleton = (1,)
  let record = .{ value: 1 }
  let point = Point(1, 2)
  let first = point.0
  while moved < other {
    if false { break } else { continue }
  }
  moved = moved + 1
  if !false { return (moved + other) } else { return Pair { left: [1, 2], right: true }.left[0] }
  return moved
}
pub unsafe fn unchecked(value: i32) -> i32 { return value }
pub unsafe extern "C" fn cAbs(value:i32)->i32 as "abs"
pub export "C" fn double(value:i32)->i32 as "silk_test_double_v1" { return value * 2 }
unsafe extern "C" static environment:*mut *mut u8 as "environ"
export "C" static answer:i32 as "silk_answer"=42
fn useCallback(callback:extern "C"fn(i32)->i32) {}
fn inspect(event: Token | End) -> i32 {
  return match &mut event { Token { span: Span { start: offset, .. }, .. } if true => offset _ => 0 }
}
fn destructure(pair: Pair, event: Token | End) -> i32 {
  let Pair { left, .. } = move pair
  if let Token whole = &event { return left[0] } else { return 0 }
}
fn scan(values: &[i32], output: &mut [i32]) -> i32 {
  return helper(usize.toI32(values.length), output[0])
}
fn readReferent(value: &i32) -> i32 { return value.* }
fn pointers(cursor: ?[*]mut ?*const align(1) addrspace(0) u8, count: *const i32) -> ?*const u8 { return cursor }
fn callbacks(shared: fn(i32, bool) -> i32, exclusive: mut fn(i32) -> bool, consuming: once fn() -> i32) -> i32 {
  return shared(1, true)
}
effect fn delayed(problem: Token) -> i32 ! Token {
  if false { fail move problem }
  return 1
}
effect fn timed() -> i32 ? &End at Clock { return 1 }
fn execute(problem: Token, borrowed: &End) -> i32 {
  let local = effect { return 2 }
  let ordinary = fn(value:i32)->i32{return value}
  let recover = effect fn(error:Token)->i32!Token{return 42}
  drop local
  let pending = delayed(move problem)
  let timed = timed() |> End.provide<End at Clock>(&local)
  return run pending
}
fn selected() -> typeof(helper) {
  return helper
}
fn selectMaybe(value: Maybe<i32>) -> Maybe<i32> {
  let fallback = Maybe<i32>.None
  return match move value {
    Maybe<i32>.Some { value } => Maybe<i32>.Some { value: value }
    Maybe<i32>.None => move fallback
  }
}
fn borrow(values: [i32; 2], output: [i32; 2]) -> i32 {
  let mut target = move output
  return scan(&values, &mut target)
}
pub fn main() -> i32 { return unsafe unchecked(helper(-1, 2) |> Core.finish()) }
`
    const original = parse('memory://grammar.silk', source)
    assert.deepEqual(original.lexicalDiagnostics, [])
    assert.deepEqual(original.parserDiagnostics, [])

    const first = yield* SyntaxFormatter.format(original)
    const reparsed = parse('memory://grammar.silk', formattedText(first))
    assert.deepEqual(reparsed.lexicalDiagnostics, [])
    assert.deepEqual(reparsed.parserDiagnostics, [])
    assert.strictEqual(SyntaxTree.isAvailableSyntax(reparsed.root), true)
    assert.deepEqual(normalized(reparsed, reparsed.root), normalized(original, original.root))
    assert.deepEqual(comments(reparsed), comments(original))
    assert.deepEqual(
      Array.from(new Set(nodeKinds(original.root))).sort(),
      Array.from(completeNodeKinds).sort(),
    )
    assert.strictEqual(formattedText(first), golden('canonical.silk'))

    const second = yield* SyntaxFormatter.format(reparsed)
    assert.deepEqual(second.bytes, first.bytes)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats pointer types canonically and idempotently', () =>
  Effect.gen(function* () {
    const source = `fn raw(cursor:* mut   u8,nested:*mut *const u8)->*const u8{return cursor}
fn call(f:for<'a> extern "C" fn(&'a i32)->i32 with Intrinsic.foreign(borrow:("0",)))->(){}`
    const original = parse('memory://pointer-types.silk', source)
    const first = yield* SyntaxFormatter.format(original)
    const text = formattedText(first)

    assert.include(
      text,
      `fn raw(cursor: *mut u8, nested: *mut *const u8) -> *const u8 {
  return cursor
}
`,
    )
    const reparsed = parse('memory://pointer-types.silk', text)
    assert.deepEqual(normalized(reparsed, reparsed.root), normalized(original, original.root))
    const second = yield* SyntaxFormatter.format(reparsed)
    assert.deepEqual(second.bytes, first.bytes)
  }),
)

it.effect('formats inherent impl declarations canonically and idempotently', () =>
  Effect.gen(function* () {
    const source =
      'impl<T>   Option<T>{\n/// Absent.\npub fn none()->Self{return Option<T>.None}\n\n\n/// Present.\npub fn some(value:T)->Self{return Option<T>.None}}\nimpl Counter{}'
    const first = yield* SyntaxFormatter.format(parse('memory://inherent-format.silk', source))
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `impl<T> Option<T> {
  /// Absent.
  pub fn none() -> Self {
    return Option<T>.None
  }
  /// Present.
  pub fn some(value: T) -> Self {
    return Option<T>.None
  }
}

impl Counter {}
`,
    )
    const second = yield* SyntaxFormatter.format(parse('memory://inherent-format.silk', text))
    assert.strictEqual(formattedText(second), text)
    assert.strictEqual(second.changed, false)
  }),
)

it.effect('formats package defaults and predicates while preserving syntax and comments', () =>
  Effect.gen(function* () {
    const source = `/// A package choice.
pub param workers:u32=choose() where workers>0
pub param enabled:bool
param message:string="fixed" where message=="fixed"
static fn choose()->u32{return 1}`
    const original = parse('config', source)
    assert.deepEqual(original.parserDiagnostics, [])
    const first = yield* SyntaxFormatter.format(original)
    const text = formattedText(first)
    assert.include(text, 'pub param workers: u32 = choose() where workers > 0')
    assert.include(text, 'pub param enabled: bool')
    const reparsed = parse('config', text)
    assert.deepEqual(reparsed.parserDiagnostics, [])
    assert.deepEqual(normalized(reparsed, reparsed.root), normalized(original, original.root))
    assert.deepEqual(comments(reparsed), comments(original))
    assert.strictEqual(formattedText(yield* SyntaxFormatter.format(reparsed)), text)
  }),
)

it.effect('preserves the C variadic boundary while formatting declarations', () =>
  Effect.gen(function* () {
    const source = 'unsafe extern "C" fn open(path:*const u8,flags:i32,...)->i32'
    const first = yield* SyntaxFormatter.format(parse('memory://variadic.silk', source))
    const text = formattedText(first)
    assert.include(text, 'flags: i32, ...')
    const second = yield* SyntaxFormatter.format(parse('memory://variadic.silk', text))
    assert.strictEqual(formattedText(second), text)
  }),
)

it.effect('formats contextual test qualifiers without changing ordinary test identifiers', () =>
  Effect.gen(function* () {
    const source = `pub   test   effect fn checked( )->(){ }
fn test( )->(){ }
fn use(test:i32)->i32{return test}`
    const original = parse('memory://test-format.silk', source)
    assert.deepEqual(original.parserDiagnostics, [])
    const first = yield* SyntaxFormatter.format(original)
    const text = formattedText(first)
    assert.strictEqual(
      text,
      `pub test effect fn checked() -> () {}

fn test() -> () {}

fn use(test: i32) -> i32 {
  return test
}
`,
    )
    const reparsed = parse('memory://test-format-2.silk', text)
    assert.deepEqual(reparsed.parserDiagnostics, [])
    assert.deepEqual(normalized(reparsed, reparsed.root), normalized(original, original.root))
    assert.strictEqual(formattedText(yield* SyntaxFormatter.format(reparsed)), text)
  }),
)

for (const [name, source, expected] of [
  [
    'three imports and a following declaration',
    'import Core.Math\n\nimport Core.Text\n\n\nimport Core.IO\nfn main() {}',
    'import Core.Math\nimport Core.Text\nimport Core.IO\n\nfn main() {}\n',
  ],
  [
    'both block boundaries without reorganizing imports',
    'const before:i32=1\nimport Zebra\n\nimport Alpha\nconst after:i32=2\nimport Zebra\npub import Zebra {value}',
    'const before: i32 = 1\n\nimport Zebra\nimport Alpha\n\nconst after: i32 = 2\n\nimport Zebra\npub import Zebra {value}\n',
  ],
  [
    'all-import file and final newline',
    'import Zebra\n\nimport Alpha\n\nimport Alpha\n\n\n',
    'import Zebra\nimport Alpha\nimport Alpha\n',
  ],
  [
    'module documentation and comments inside an import block',
    '//! Module documentation\n\nimport Zebra // trailing\n\n// first group\n\n// second group\n\nimport Alpha\n\n// last import\n\npub import Beta {value} // end',
    '//! Module documentation\n\nimport Zebra // trailing\n// first group\n// second group\nimport Alpha\n// last import\npub import Beta {value} // end\n',
  ],
  [
    'trailing and standalone comments at both block boundaries',
    'const before:i32=1 // before\n// imports\nimport Alpha // alpha\nimport Beta // beta\n// function\nfn main() {}',
    'const before: i32 = 1 // before\n\n// imports\nimport Alpha // alpha\nimport Beta // beta\n\n// function\nfn main() {}\n',
  ],
  [
    'trailing comments alone at block boundaries',
    'const before:i32=1 // before\nimport Alpha // alpha\nfn main() {}',
    'const before: i32 = 1 // before\n\nimport Alpha // alpha\n\nfn main() {}\n',
  ],
] satisfies ReadonlyArray<readonly [string, string, string]>) {
  it.effect(`formats ${name} canonically`, () =>
    Effect.gen(function* () {
      const original = parse(`memory://imports-${name}.silk`, source)
      const first = yield* SyntaxFormatter.format(original)
      assert.strictEqual(formattedText(first), expected)
      const reparsed = parse(`memory://imports-${name}-formatted.silk`, expected)
      yield* SyntaxFormatter.validate(reparsed)
      assert.deepEqual(normalized(reparsed, reparsed.root), normalized(original, original.root))
      assert.deepEqual(comments(reparsed), comments(original))
      const second = yield* SyntaxFormatter.format(reparsed)
      assert.strictEqual(formattedText(second), expected)
      assert.isFalse(second.changed)
    }),
  )
}

it.effect(
  'preserves invocation-use designation when formatting and reparsing callable binders',
  () =>
    Effect.gen(function* () {
      const source =
        "fn invoke(callback:for < 'data , use 'call > once fn < 'static > (&'data i32,i32)->i32){}"
      const original = parse('invocation-use-format', source)
      assert.deepEqual(original.parserDiagnostics, [])
      const text = formattedText(yield* SyntaxFormatter.format(original))
      assert.include(text, "for<'data, use 'call> once fn<'static>")
      const reparsed = parse('invocation-use-format', text)
      assert.deepEqual(reparsed.parserDiagnostics, [])
      assert.deepEqual(normalized(reparsed, reparsed.root), normalized(original, original.root))
      assert.strictEqual(formattedText(yield* SyntaxFormatter.format(reparsed)), text)
    }),
)
