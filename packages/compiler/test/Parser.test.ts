import { assert, it } from '@effect/vitest'
import * as Option from 'effect/Option'
import * as ImportPath from '../src/ImportPath.js'
import { syntaxNode } from '../src/internal/ParseState.js'
import * as Lexer from '../src/Lexer.js'
import * as ExpressionNesting from '../src/Parser/ExpressionNesting.js'
import * as Parser from '../src/Parser.js'
import * as SourceFile from '../src/SourceFile.js'
import type * as SyntaxFile from '../src/SyntaxFile.js'
import * as SyntaxTree from '../src/SyntaxTree.js'
import type * as Token from '../src/Token.js'
import {
  acceptedShape,
  acceptedSource,
  damagedCallBeforeNextFunctionSource,
  damagedNestedBeforeNextFunctionSource,
  damagedNestedSiblingSource,
  damagedStructSource,
  denseTriviaSource,
  type ExpectedNodeShape,
  emptySource,
  identifierCallArgumentSource,
  identitySource,
  interFunctionPunctuationSource,
  invalidUtf8Source,
  malformedArgumentSource,
  missingCallCalleeSource,
  missingCallRightParenthesisSource,
  missingFirstRightBraceSource,
  missingNameSource,
  missingNestedRightParenthesisSource,
  missingParameterCommaSource,
  missingParameterTypeSource,
  missingRightBraceSource,
  nestedCallSource,
  nestedSiblingCallSource,
  threeFunctionSource,
  trailingTriviaSource,
  triviaCallSource,
  twoFunctionSource,
  twoParameterSource,
  unexpectedPunctuationSource,
  validCallSource,
  validStructSource,
  valueCallArgumentSource,
  whollyUnrelatedSource,
} from './fixtures/BootstrapParserFixture.js'
import { raise } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const parseBytes = (id: string, bytes: Uint8Array): SyntaxFile.SyntaxFile =>
  Parser.parse(Lexer.lex(SourceFile.make(id, bytes)))

const parseText = (id: string, source: string): SyntaxFile.SyntaxFile =>
  parseBytes(id, ascii(source))

it('recovers without stalling on an unsupported anonymous Effect environment', () => {
  const source =
    "fn main() -> () { let use = effect<'call> fn() -> () {} }\nfn next() -> i32 { return 42 }"
  const parsed = parseText('unsupported-anonymous-environment', source)
  assert.isNotEmpty(parsed.parserDiagnostics)
  assertOriginalTokenTraversal(parsed)
  assert.include(
    directFunctionDeclarations(parsed.root).map((node) =>
      directTokenText(parsed, node, 'Identifier'),
    ),
    'next',
  )
})

const nodeShape = (node: SyntaxTree.Node): ExpectedNodeShape => ({
  kind: node.kind,
  children: node.children.map((child): string | ExpectedNodeShape => {
    if (SyntaxTree.isNode(child)) return nodeShape(child)
    if (SyntaxTree.isToken(child)) return child.kind
    return `Missing(${child.expected})`
  }),
})

const descendants = (node: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Element> =>
  node.children.flatMap((child): ReadonlyArray<SyntaxTree.Element> =>
    SyntaxTree.isNode(child) ? [child, ...descendants(child)] : [child],
  )

const missingLeaves = (node: SyntaxTree.Node): ReadonlyArray<SyntaxTree.MissingToken> =>
  descendants(node).filter(SyntaxTree.isMissingToken)

const errorNodes = (node: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> =>
  descendants(node).filter(
    (element): element is SyntaxTree.Node => SyntaxTree.isNode(element) && element.kind === 'Error',
  )

const directFunctionDeclarations = (node: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> =>
  node.children.filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'FunctionDeclaration',
  )

const directServiceDeclarations = (node: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> =>
  node.children.filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'ServiceDeclaration',
  )

const directTokenText = (
  result: SyntaxFile.SyntaxFile,
  node: SyntaxTree.Node,
  kind: Token.TokenKind,
): string | undefined => {
  const token = node.children.find(
    (element): element is Token.Token => SyntaxTree.isToken(element) && element.kind === kind,
  )
  if (token === undefined) return undefined
  return Array.from(Option.getOrThrow(SourceFile.slice(result.source, token.span)), (byte) =>
    String.fromCharCode(byte),
  ).join('')
}

const assertOriginalTokenTraversal = (result: SyntaxFile.SyntaxFile): void => {
  const flattened = SyntaxTree.tokens(result.root)
  assert.strictEqual(flattened.length, result.tokens.length)
  for (const [index, token] of flattened.entries()) {
    assert.strictEqual(token, result.tokens.at(index))
  }
}

it('preserves signed exponent literals and malformed exponent recovery losslessly', () => {
  const wellFormed = parseText(
    'memory://float-parser.silk',
    'fn value() -> f64 { return -1.25e-3 }',
  )
  const literal = descendants(wellFormed.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'FloatingLiteralExpression',
  )
  assert.isDefined(literal)
  assert.strictEqual(
    literal === undefined ? undefined : directTokenText(wellFormed, literal, 'DecimalFloat'),
    '1.25e-3',
  )
  assert.deepEqual(reconstructedBytes(wellFormed), ascii('fn value() -> f64 { return -1.25e-3 }'))

  // An exponent with no digits is one invalid token, so no float literal node forms, and the
  // parser still reconstructs the source byte for byte.
  const damagedText = 'fn damaged() -> f64 { return 1.25e- }'
  const damaged = parseText('memory://float-parser-damaged.silk', damagedText)
  assert.isUndefined(
    descendants(damaged.root).find(
      (element): element is SyntaxTree.Node =>
        SyntaxTree.isNode(element) && element.kind === 'FloatingLiteralExpression',
    ),
  )
  assert.include(
    SyntaxTree.tokens(damaged.root).map((token) => token.kind),
    'Invalid',
  )
  assert.deepEqual(reconstructedBytes(damaged), ascii(damagedText))
})

const reconstructedBytes = (result: SyntaxFile.SyntaxFile): Uint8Array => {
  const bytes = SyntaxTree.tokens(result.root)
    .filter((token) => token.kind !== 'EndOfFile')
    .flatMap((token) => Array.from(Option.getOrThrow(SourceFile.slice(result.source, token.span))))
  return Uint8Array.from(bytes)
}

const diagnosticView = (result: SyntaxFile.SyntaxFile) =>
  result.parserDiagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    start: diagnostic.span.start,
    end: diagnostic.span.end,
    reason: diagnostic.reason,
  }))

it('retains distinct lifetime binders, arguments, borrowed types and callable environment syntax', () => {
  const source = `struct Holder<'a: 'b + 'c, 'b, 'c, T: Copy + 'a> {
  value: &'a T
  values: &'b mut [T]
  text: string<'c>
}
effect<'env> fn use<'env, T>(value: &'env mut Holder<'env, 'static, 'env, T>, callback: for<'call> once fn<'env>(&'call T) -> &'call T, pending: Effect<'env; T ! Error ? &Clock>) -> () {
  drop identity<'env, T>(value)
}
service Store<'a, T: 'a> { effect fn save(value: T) -> () }
effect fn requiring<'a, T>() -> () ? &Store<'a, T> { return () }
fn refine(value: Choice, place: i32) -> i32 {
  drop value.field
  return match place value { Choice.Some { field } if true => field Choice.None => match place { i32 n => n } }
}`
  const syntax = parseText('memory://lifetime-syntax.silk', source)
  assert.deepEqual(syntax.lexicalDiagnostics, [])
  assert.deepEqual(syntax.parserDiagnostics, [])
  assert.deepEqual(reconstructedBytes(syntax), ascii(source))
  const nodes = descendants(syntax.root).filter(SyntaxTree.isNode)
  const parameters = nodes.filter((node) => node.kind === 'LifetimeParameter')
  assert.deepEqual(
    parameters.map((node) => directTokenText(syntax, node, 'Lifetime')),
    ["'a", "'b", "'c", "'env", "'call", "'a", "'a"],
  )
  const borrowed = nodes.filter(
    (node) => node.kind === 'ReferenceType' || node.kind === 'SliceType',
  )
  assert.deepEqual(
    borrowed.map((node) => [node.kind, directTokenText(syntax, node, 'Lifetime')]),
    [
      ['ReferenceType', "'a"],
      ['SliceType', "'b"],
      ['ReferenceType', "'env"],
      ['ReferenceType', "'call"],
      ['ReferenceType', "'call"],
    ],
  )
  const environment =
    nodes.find(
      (node) =>
        node.kind === 'EffectEnvironment' &&
        SyntaxTree.directToken(node, 'Semicolon') !== undefined,
    ) ?? raise('missing environment')
  const declarationEnvironment = nodes.find(
    (node) =>
      node.kind === 'EffectEnvironment' && SyntaxTree.directToken(node, 'Less') !== undefined,
  )
  assert.strictEqual(
    declarationEnvironment === undefined
      ? undefined
      : directTokenText(syntax, declarationEnvironment, 'Lifetime'),
    "'env",
  )
  assert.strictEqual(directTokenText(syntax, environment, 'Lifetime'), "'env")
  assert.strictEqual(directTokenText(syntax, environment, 'Semicolon'), ';')
  const callableEnvironment =
    nodes.find((node) => node.kind === 'CallableEnvironment') ??
    raise('missing callable environment')
  assert.strictEqual(directTokenText(syntax, callableEnvironment, 'Lifetime'), "'env")
  const accesses = nodes.filter((node) => node.kind === 'MatchAccess')
  assert.deepEqual(
    accesses.map((node) => directTokenText(syntax, node, 'Identifier')),
    ['place', undefined],
  )
  const callable = nodes.find((node) => node.kind === 'CallableType') ?? raise('missing callable')
  assert.strictEqual(
    SyntaxTree.directNode(callable, 'LifetimeBinderList')?.kind,
    'LifetimeBinderList',
  )
  const call =
    nodes.find((node) => node.kind === 'CallTypeArgumentList') ?? raise('missing call arguments')
  assert.strictEqual(SyntaxTree.directNode(call, 'LifetimeType')?.kind, 'LifetimeType')
})

it('recovers malformed lifetime types and rejects lifetime annotations on value borrows', () => {
  for (const declaration of [
    "fn damaged<'a>(value: &'a, next: i32) -> () {}",
    'fn damaged(value: Effect<; i32>) -> () {}',
    'fn damaged(value: fn<>(i32) -> i32) -> () {}',
    "fn damaged(value: for<'a> i32) -> () {}",
    "fn damaged(value: for<'a fn(&'a i32) -> &'a i32) -> () {}",
    "fn damaged(value: i32) -> () { drop &'a value }",
  ]) {
    const source = `${declaration}\nfn later() -> () {}`
    const syntax = parseText('memory://damaged-lifetime.silk', source)
    assert.deepEqual(syntax.lexicalDiagnostics, [])
    assert.isAbove(syntax.parserDiagnostics.length, 0, declaration)
    assert.deepEqual(reconstructedBytes(syntax), ascii(source))
    assert.strictEqual(directFunctionDeclarations(syntax.root).length, 2, declaration)
  }
})

it('derives expression child depths without consuming the shared parent depth', () => {
  const parent = ExpressionNesting.root
  const firstSibling = ExpressionNesting.child(parent)
  const secondSibling = ExpressionNesting.child(parent)

  assert.strictEqual(parent, 0)
  assert.strictEqual(firstSibling, 1)
  assert.strictEqual(secondSibling, 1)
  assert.strictEqual(ExpressionNesting.limit, 256)
  assert.isFalse(ExpressionNesting.exceedsLimit(ExpressionNesting.limit))
  assert.isTrue(ExpressionNesting.exceedsLimit(ExpressionNesting.child(ExpressionNesting.limit)))
})

const groupedExpression = (depth: number, leaf = '1'): string =>
  `${'('.repeat(depth)}${leaf}${')'.repeat(depth)}`

const arrayExpression = (depth: number): string => `${'['.repeat(depth)}1${']'.repeat(depth)}`

const callExpression = (depth: number): string => `${'f('.repeat(depth)}1${')'.repeat(depth)}`

const prefixExpression = (depth: number): string => `${'!'.repeat(depth)}true`

const expressionFunction = (name: string, expression: string, following = ''): string =>
  `fn ${name.replaceAll('-', '_')}() -> i32 { return ${expression}${following} }`

const nestingDiagnostics = (result: SyntaxFile.SyntaxFile) =>
  result.parserDiagnostics.filter((diagnostic) => diagnostic.code === 'PAR0005')

const nestingGolden = (result: SyntaxFile.SyntaxFile) => ({
  diagnostics: diagnosticView(result).filter((diagnostic) => diagnostic.code === 'PAR0005'),
  errors: errorNodes(result.root).map((node) => ({
    kind: node.kind,
    start: node.span.start,
    end: node.span.end,
  })),
})

it('accepts expression depths 255 and 256 and diagnoses the first token at depth 257', () => {
  for (const depth of [ExpressionNesting.limit - 1, ExpressionNesting.limit]) {
    const source = expressionFunction('boundary', groupedExpression(depth))
    const result = parseText(`memory://expression-depth-${depth}.silk`, source)
    assert.deepEqual(nestingDiagnostics(result), [])
    assert.strictEqual(
      descendants(result.root).filter(
        (element) => SyntaxTree.isNode(element) && element.kind === 'GroupedExpression',
      ).length,
      depth,
    )
    assertOriginalTokenTraversal(result)
    assert.deepEqual(reconstructedBytes(result), ascii(source))
  }

  const overDepth = ExpressionNesting.child(ExpressionNesting.limit)
  const source = expressionFunction('over', groupedExpression(overDepth, '  1'))
  const result = parseText('memory://expression-depth-over.silk', source)
  const diagnostic = nestingDiagnostics(result)
  const decisiveOffset = source.indexOf('1')

  assert.strictEqual(diagnostic.length, 1)
  assert.deepEqual(diagnostic.at(0)?.reason, {
    _tag: 'ExpressionNestingLimitExceeded',
    limit: ExpressionNesting.limit,
    attemptedDepth: overDepth,
  })
  assert.deepEqual(
    diagnostic.map((item) => [item.span.start, item.span.end]),
    [[decisiveOffset, decisiveOffset + 1]],
  )
  assert.deepEqual(nestingGolden(result), {
    diagnostics: [
      {
        code: 'PAR0005',
        start: decisiveOffset,
        end: decisiveOffset + 1,
        reason: {
          _tag: 'ExpressionNestingLimitExceeded',
          limit: 256,
          attemptedDepth: 257,
        },
      },
    ],
    errors: [{ kind: 'Error', start: decisiveOffset - 2, end: decisiveOffset + 1 }],
  })
  assert.strictEqual(errorNodes(result.root).length, 1)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers substantially deep grouping, arrays, calls, and direct prefixes deterministically', () => {
  const deep = 2_000
  const cases = [
    ['grouped', groupedExpression(deep)],
    ['array', arrayExpression(deep)],
    ['call', callExpression(deep)],
    ['prefix', prefixExpression(deep)],
  ] as const

  for (const [name, expression] of cases) {
    const source = expressionFunction(name, expression, ' let recovered = 2 return recovered')
    const first = parseText(`memory://deep-${name}.silk`, source)
    const second = parseText(`memory://deep-${name}.silk`, source)

    assert.strictEqual(nestingDiagnostics(first).length, 1)
    assert.strictEqual(errorNodes(first.root).length, 1)
    assert.strictEqual(
      descendants(first.root).filter(
        (element) => SyntaxTree.isNode(element) && element.kind === 'BindingStatement',
      ).length,
      1,
    )
    assert.deepEqual(nestingGolden(first), nestingGolden(second))
    assertOriginalTokenTraversal(first)
    assert.deepEqual(reconstructedBytes(first), ascii(source))
  }
})

it('counts every structurally distinct child-expression edge', () => {
  const atBoundary = groupedExpression(ExpressionNesting.limit)
  const cases = [
    ['operator', `0 + ${atBoundary}`],
    ['pipeline', `0 |> ${atBoundary}`],
    ['index', `items[${atBoundary}]`],
    ['argument', `f(${atBoundary})`],
    ['array', `[${atBoundary}]`],
    ['aggregate', `Point { value: ${atBoundary} }`],
    ['match-scrutinee', `match ${atBoundary} { _ => 0 }`],
    ['match-block-statement', `match value { _ => { drop ${atBoundary} } }`],
    ['match-result', `match value { _ => ${atBoundary} }`],
  ] as const

  for (const [name, expression] of cases) {
    const source = expressionFunction(name, expression)
    const result = parseText(`memory://child-depth-${name}.silk`, source)
    assert.strictEqual(nestingDiagnostics(result).length, 1, name)
    assert.strictEqual(errorNodes(result.root).length, 1, name)
    assertOriginalTokenTraversal(result)
    assert.deepEqual(reconstructedBytes(result), ascii(source))
  }
})

it('recovers one maximal region per independent expression and preserves following declarations', () => {
  const rejected = groupedExpression(2_000)
  const firstFunction = expressionFunction(
    'first',
    rejected,
    ' let firstRecovered = 1 return firstRecovered',
  )
  const secondFunction = expressionFunction(
    'second',
    rejected,
    ' let secondRecovered = 2 return secondRecovered',
  )
  const source = `${firstFunction}\n${secondFunction}\nconst after: i32 = 3`
  const result = parseText('memory://independent-expression-depth.silk', source)
  const diagnostics = nestingDiagnostics(result)

  assert.strictEqual(diagnostics.length, 2)
  assert.strictEqual(errorNodes(result.root).length, 2)
  assert.strictEqual(directFunctionDeclarations(result.root).length, 2)
  assert.strictEqual(
    result.root.children.filter(
      (element) => SyntaxTree.isNode(element) && element.kind === 'ConstantDeclaration',
    ).length,
    1,
  )
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.span.start),
    [
      firstFunction.indexOf(rejected) + ExpressionNesting.limit + 1,
      firstFunction.length + 1 + secondFunction.indexOf(rejected) + ExpressionNesting.limit + 1,
    ],
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('keeps parser ordering invariant failures outside expression-depth recovery as defects', () => {
  const lexical = Lexer.lex(SourceFile.make('memory://parser-invariant.silk', ascii('a b')))
  const first = lexical.tokens.at(0) ?? raise('expected first token')
  const second = lexical.tokens.at(2) ?? raise('expected second token')
  const state = Object.freeze({
    lexical,
    index: 0,
    diagnostics: Object.freeze([]),
    recovering: false,
  })

  assert.throws(() => syntaxNode(state, 'Error', [second, first]), RangeError)
})

it('parses effect declarations, failure rows, delayed run, and consuming fail losslessly', () => {
  const result = parseText(
    'memory://effect.silk',
    `struct Problem { code: i32 }
effect fn work(problem: Problem) -> i32 ! Problem | Problem {
  if true { fail move problem }
  return 42
}
fn main() -> i32 { let pending = work(Problem { code: 1 }) return run pending }`,
  )
  const effect = directFunctionDeclarations(result.root).at(0)
  assert.strictEqual(
    SyntaxTree.directToken(effect ?? result.root, 'EffectKeyword')?.kind,
    'EffectKeyword',
  )
  assert.strictEqual(SyntaxTree.directNode(effect ?? result.root, 'FailureRow')?.kind, 'FailureRow')
  assert.include(
    descendants(result.root)
      .filter(SyntaxTree.isNode)
      .map((node) => node.kind),
    'FailStatement',
  )
  assert.include(
    descendants(result.root)
      .filter(SyntaxTree.isNode)
      .map((node) => node.kind),
    'RunExpression',
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assert.deepEqual(reconstructedBytes(result), result.source.bytes)
})

it('parses source service contracts with complete operation rows losslessly', () => {
  const source = `/// A portable logging contract.
pub service Logger<T> {
  effect fn log(message: &[u8], value: T) -> () ! WriteFailure ? &mut Logger<T> with Intrinsic.nonParking()
  fn enabled() -> bool
}
fn after() -> i32 { return 1 }`
  const result = parseText('memory://service.silk', source)
  const service = directServiceDeclarations(result.root).at(0)

  assert.strictEqual(service?.kind, 'ServiceDeclaration')
  assert.strictEqual(
    SyntaxTree.directToken(service ?? result.root, 'PubKeyword')?.kind,
    'PubKeyword',
  )
  assert.strictEqual(
    SyntaxTree.directToken(service ?? result.root, 'ServiceKeyword')?.kind,
    'ServiceKeyword',
  )
  const operations =
    service === undefined ? [] : SyntaxTree.directNodes(service, 'ServiceOperation')
  assert.strictEqual(operations.length, 2)
  assert.strictEqual(
    SyntaxTree.directNode(operations[0] ?? result.root, 'FailureRow')?.kind,
    'FailureRow',
  )
  assert.strictEqual(
    SyntaxTree.directNode(operations[0] ?? result.root, 'RequirementRow')?.kind,
    'RequirementRow',
  )
  assert.strictEqual(
    SyntaxTree.directNodes(operations[0] ?? result.root, 'FunctionPropertyClause').length,
    1,
  )
  assert.strictEqual(directFunctionDeclarations(result.root).length, 1)
  assert.deepEqual(result.parserDiagnostics, [])
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses ordinary static interfaces separately from services', () => {
  const source = `pub interface Integer<T> {
  fn add(left: T, right: T) -> T
}
fn after() -> i32 { return 1 }`
  const result = parseText('memory://interface.silk', source)
  const interface_ = SyntaxTree.directNodes(result.root, 'InterfaceDeclaration').at(0)

  assert.strictEqual(interface_?.kind, 'InterfaceDeclaration')
  assert.strictEqual(
    SyntaxTree.directToken(interface_ ?? result.root, 'InterfaceKeyword')?.kind,
    'InterfaceKeyword',
  )
  assert.strictEqual(
    interface_ === undefined ? 0 : SyntaxTree.directNodes(interface_, 'ServiceOperation').length,
    1,
  )
  assert.strictEqual(directFunctionDeclarations(result.root).length, 1)
  assert.deepEqual(result.parserDiagnostics, [])
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers a damaged service operation before the following operation and declaration', () => {
  const source = `service Logger {
  effect fn broken(message: &[u8] -> ()
  fn enabled() -> bool
}
fn after() -> i32 { return 1 }`
  const result = parseText('memory://damaged-service.silk', source)
  const service = directServiceDeclarations(result.root).at(0)
  const operations =
    service === undefined ? [] : SyntaxTree.directNodes(service, 'ServiceOperation')

  assert.strictEqual(operations.length, 2)
  assert.strictEqual(directFunctionDeclarations(result.root).length, 1)
  assert.include(
    missingLeaves(result.root).map((token) => token.expected),
    'RightParenthesis',
  )
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('contains invalid service storage without consuming a valid following operation', () => {
  const source = `service Broken {
  state: i32
  fn enabled() -> bool
}`
  const result = parseText('memory://service-storage.silk', source)
  const service = directServiceDeclarations(result.root).at(0)

  assert.strictEqual(
    service === undefined ? 0 : SyntaxTree.directNodes(service, 'ServiceInvalidMember').length,
    1,
  )
  assert.strictEqual(
    service === undefined ? 0 : SyntaxTree.directNodes(service, 'ServiceOperation').length,
    1,
  )
  assert.isAbove(result.parserDiagnostics.length, 0)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers a missing failure-row member without consuming the effect body or next function', () => {
  const result = parseText(
    'memory://damaged-effect.silk',
    'effect fn work() -> i32 ! { return 1 } fn after() -> i32 { return 2 }',
  )
  assert.strictEqual(directFunctionDeclarations(result.root).length, 2)
  const first = directFunctionDeclarations(result.root).at(0)
  const row = first === undefined ? undefined : SyntaxTree.directNode(first, 'FailureRow')
  assert.strictEqual(row?.kind, 'FailureRow')
  assert.include(
    missingLeaves(result.root).map((token) => token.expected),
    'Identifier',
  )
})

it('parses an effect block as a primary lazy expression and retains Copy fail syntax', () => {
  const result = parseText(
    'memory://effect-expression.silk',
    'fn later() -> i32 { let pending = effect { fail Problem { code: 1 } } return 0 }',
  )
  const kinds = descendants(result.root)
    .filter(SyntaxTree.isNode)
    .map((node) => node.kind)
  assert.include(kinds, 'EffectExpression')
  const failed = descendants(result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'FailStatement',
  )
  assert.strictEqual(
    failed === undefined ? undefined : SyntaxTree.directToken(failed, 'MoveKeyword'),
    undefined,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assert.deepEqual(reconstructedBytes(result), result.source.bytes)
})

it('parses ordinary and effectful anonymous callables distinctly and losslessly', () => {
  const source = `fn make() -> () {
  let ordinary = fn(value: i32) -> i32 { return value }
  let effectful = effect fn(error: Failure) -> i32 ! Failure ? &Logger { return 42 }
  let pending = effect { return 1 }
}`
  const result = parseText('memory://anonymous-callables.silk', source)
  const nodes = descendants(result.root).filter(SyntaxTree.isNode)
  const callables = nodes.filter((node) => node.kind === 'AnonymousCallableExpression')

  assert.strictEqual(callables.length, 2)
  assert.strictEqual(
    SyntaxTree.directToken(callables[0] ?? result.root, 'EffectKeyword'),
    undefined,
  )
  assert.notStrictEqual(
    SyntaxTree.directToken(callables[1] ?? result.root, 'EffectKeyword'),
    undefined,
  )
  assert.notStrictEqual(SyntaxTree.directNode(callables[1] ?? result.root, 'FailureRow'), undefined)
  assert.notStrictEqual(
    SyntaxTree.directNode(callables[1] ?? result.root, 'RequirementRow'),
    undefined,
  )
  assert.strictEqual(nodes.filter((node) => node.kind === 'EffectExpression').length, 1)
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('bounds anonymous callable recovery and keeps modifiers outside the callable node', () => {
  const damaged = [
    {
      source: 'fn make() -> i32 { return accept(fn -> i32 { return 1 }, 42) }',
      diagnostic: { code: 'PAR0001', start: 36, end: 36 },
    },
    {
      source: 'fn make() -> i32 { return accept(fn(value:) -> i32 { return 1 }, 42) }',
      diagnostic: { code: 'PAR0001', start: 42, end: 42 },
    },
    {
      source: 'fn make() -> i32 { return accept(fn() { return 1 }, 42) }',
      diagnostic: { code: 'PAR0001', start: 38, end: 38 },
    },
    {
      source: 'fn make() -> i32 { return accept(fn() ->, 42) }',
      diagnostic: { code: 'PAR0001', start: 40, end: 40 },
    },
    {
      source: 'fn make() -> i32 { return accept(fn(), 42) }',
      diagnostic: { code: 'PAR0001', start: 37, end: 37 },
    },
    {
      source: 'fn make() -> i32 { return accept(effect fn() -> i32 ! { return 1 }, 42) }',
      diagnostic: { code: 'PAR0001', start: 54, end: 54 },
    },
    {
      source: 'fn make() -> i32 { return accept(fn() -> i32, 42) }',
      diagnostic: { code: 'PAR0001', start: 44, end: 44 },
    },
  ] as const

  for (const [ordinal, { source, diagnostic }] of damaged.entries()) {
    const result = parseText(`memory://damaged-anonymous-${ordinal}.silk`, source)
    const callables = descendants(result.root).filter(
      (element): element is SyntaxTree.Node =>
        SyntaxTree.isNode(element) && element.kind === 'AnonymousCallableExpression',
    )
    assert.strictEqual(callables.length, 1, source)
    assert.deepEqual(
      result.parserDiagnostics.map((item) => ({
        code: item.code,
        start: item.span.start,
        end: item.span.end,
      })),
      [diagnostic],
    )
    assert.strictEqual(
      result.tokens.some(
        (token) => token.kind === 'DecimalInteger' && token.span.start === source.indexOf('42'),
      ),
      true,
    )
    assertOriginalTokenTraversal(result)
    assert.deepEqual(reconstructedBytes(result), ascii(source))
  }

  const modifiedSource =
    'fn make() -> () { let invalid = mut fn(value: i32) -> i32 { return value } }'
  const modified = parseText('memory://modified-anonymous.silk', modifiedSource)
  const callable = descendants(modified.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'AnonymousCallableExpression',
  )
  assert.notStrictEqual(callable, undefined)
  assert.strictEqual(
    callable === undefined ? undefined : SyntaxTree.directToken(callable, 'MutKeyword'),
    undefined,
  )
  assert.deepEqual(
    modified.parserDiagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      start: diagnostic.span.start,
      end: diagnostic.span.end,
    })),
    [{ code: 'PAR0002', start: 32, end: 36 }],
  )
  assertOriginalTokenTraversal(modified)
  assert.deepEqual(reconstructedBytes(modified), ascii(modifiedSource))

  const declarationSource =
    'fn make() -> () { let handler = fn() -> () } fn after() -> i32 { return 42 }'
  const beforeDeclaration = parseText(
    'memory://anonymous-before-declaration.silk',
    declarationSource,
  )
  assert.strictEqual(directFunctionDeclarations(beforeDeclaration.root).length, 2)
  assert.strictEqual(
    descendants(beforeDeclaration.root).filter(
      (element) => SyntaxTree.isNode(element) && element.kind === 'AnonymousCallableExpression',
    ).length,
    1,
  )
  assertOriginalTokenTraversal(beforeDeclaration)
  assert.deepEqual(reconstructedBytes(beforeDeclaration), ascii(declarationSource))
})

it('bounds damaged effect-block recovery before the following declaration', () => {
  const result = parseText(
    'memory://damaged-effect-expression.silk',
    'fn make() -> i32 { let pending = effect { return broken( } return 0 } fn after() -> i32 { return 2 }',
  )
  assert.strictEqual(directFunctionDeclarations(result.root).length, 2)
  assert.include(
    descendants(result.root)
      .filter(SyntaxTree.isNode)
      .map((node) => node.kind),
    'EffectExpression',
  )
})

it('parses Effect.retry in direct and pipeline insertion forms', () => {
  const result = parseText(
    'memory://effect-retry.silk',
    `import silk.effect { Effect }
fn main() -> i32 {
  let direct = Effect.retry(work(), policy)
  let piped = work() |> Effect.retry(policy)
  return 0
}`,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  const identifiers = descendants(result.root)
    .filter(SyntaxTree.isToken)
    .filter((token) => token.kind === 'Identifier')
    .map((token) => directTokenText(result, result.root, token.kind))
  assert.isAtLeast(identifiers.length, 1)
  assert.include(
    descendants(result.root)
      .filter(SyntaxTree.isNode)
      .map((node) => node.kind),
    'PipelineExpression',
  )
})

it('rejects the removed bare role-selector argument without retaining role syntax', () => {
  const source = `import silk.effect { Effect }
fn main() -> i32 {
  let selected = work() |> Effect.provideMut(&mut provider, @Audit)
  return 0
}
fn after() -> i32 { return 42 }`
  const result = parseText('memory://removed-role-selector.silk', source)
  const errors = errorNodes(result.root)

  assert.isAbove(result.parserDiagnostics.length, 0)
  assert.isTrue(
    errors.some((error) => SyntaxTree.tokens(error).some((token) => token.kind === 'At')),
  )
  assert.strictEqual(directFunctionDeclarations(result.root).length, 2)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses explicit drop as a statement without making the block terminal', () => {
  const result = parseText(
    'memory://drop-statement.silk',
    'struct Token { value: i32 } fn main() -> i32 { let token = Token { value: 1 } drop token return 42 }',
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assert.include(
    descendants(result.root)
      .filter(SyntaxTree.isNode)
      .map((node) => node.kind),
    'DropStatement',
  )
})

it('parses unsafe blocks and allocator and Drop conformances losslessly', () => {
  const source = `import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.layout { Layout }
struct Guard<T> { value: T }
impl Allocator for SystemAllocator { allocate: SystemAllocator.allocate }
impl Drop for Guard<Token> {
  fn drop(self: &mut Guard<Token>) -> () { unsafe { drop self.value } return () }
}
fn main() -> i32 { unsafe { let allocation = Allocator.allocate(Layout.make(4, 4)) drop allocation } return 42 }`
  const result = parseText('memory://unsafe-conformance.silk', source)
  assert.deepEqual(result.parserDiagnostics, [])
  const kinds = descendants(result.root)
    .filter(SyntaxTree.isNode)
    .map((node) => node.kind)
  assert.strictEqual(kinds.filter((kind) => kind === 'ImplDeclaration').length, 2)
  assert.include(kinds, 'ImplOperation')
  assert.strictEqual(kinds.filter((kind) => kind === 'UnsafeStatement').length, 2)
  assert.deepEqual(reconstructedBytes(result), result.source.bytes)
})

it('parses a parametric conformance losslessly', () => {
  const source = `struct Vector<T> { count: usize }
impl<T> Drop for Vector<T> {
  fn drop(self: &mut Vector<T>) -> () { return () }
}
fn main() -> i32 { return 42 }`
  const result = parseText('memory://parametric-conformance.silk', source)
  assert.deepEqual(result.parserDiagnostics, [])
  const impl = descendants(result.root)
    .filter(SyntaxTree.isNode)
    .find((node) => node.kind === 'ImplDeclaration')
  assert.isDefined(impl)
  const implKinds = descendants(impl ?? result.root)
    .filter(SyntaxTree.isNode)
    .map((node) => node.kind)
  assert.include(implKinds, 'TypeParameterList')
  assert.include(implKinds, 'TypeParameter')
  assert.deepEqual(reconstructedBytes(result), result.source.bytes)
})

it('retains qualified enum-member and signed integer patterns losslessly', () => {
  const source = `enum(i8) Status { Unknown = -1, Ready = 1 }
fn inspect(value: Status) -> i32 {
  return match value {
    -1 => 1
    Status.Unknown => 0
    Status.Ready => 2
  }
}`
  const result = parseText('memory://enum-patterns.silk', source)
  const patterns = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) &&
      (element.kind === 'EnumMemberPattern' || element.kind === 'IntegerPattern'),
  )

  assert.deepEqual(result.parserDiagnostics, [])
  assert.deepEqual(
    patterns.map((pattern) => ({
      kind: pattern.kind,
      text: source.slice(pattern.span.start, pattern.span.end).trim(),
    })),
    [
      { kind: 'IntegerPattern', text: '-1' },
      { kind: 'EnumMemberPattern', text: 'Status.Unknown' },
      { kind: 'EnumMemberPattern', text: 'Status.Ready' },
    ],
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('keeps qualified generic nominal patterns distinct from enum members', () => {
  const source = `fn inspect(value: Result.Result<i32, Problem>) -> i32 {
  return match move value {
    Result.Result<i32, Problem> {value} => value
  }
}`
  const result = parseText('memory://qualified-generic-pattern.silk', source)
  const patterns = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) &&
      (element.kind === 'NominalPattern' || element.kind === 'EnumMemberPattern'),
  )

  assert.deepEqual(result.parserDiagnostics, [])
  assert.deepEqual(
    patterns.map((pattern) => pattern.kind),
    ['NominalPattern'],
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses whole-member binding patterns losslessly', () => {
  const source = `struct Empty {}
struct Full { value: i32 }
fn take(state: Empty | Full) -> i32 {
  return match move state {
    Empty nothing => 0
    Full full => 1
  }
}`
  const result = parseText('memory://binding-pattern.silk', source)
  assert.deepEqual(result.parserDiagnostics, [])
  const kinds = descendants(result.root)
    .filter(SyntaxTree.isNode)
    .map((node) => node.kind)
  assert.strictEqual(kinds.filter((kind) => kind === 'BindingPattern').length, 2)
  assert.deepEqual(reconstructedBytes(result), result.source.bytes)
})

it('recovers from a malformed impl type-parameter list inside the declaration', () => {
  const source =
    'import silk.vector { Vector }\nimpl<T Drop for Vector<T> { fn drop(self: &mut Vector<T>) -> () { return () } } fn after() -> i32 { return 7 }'
  const result = parseText('memory://damaged-parametric-conformance.silk', source)
  assert.isAbove(result.parserDiagnostics.length, 0)
  assert.strictEqual(directFunctionDeclarations(result.root).length, 1)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers from a malformed bounded impl type-parameter list inside the declaration', () => {
  // The bound's own applied type closes, but the parameter list never does, so recovery has to
  // decide the header ends without swallowing the declaration that follows it.
  const source =
    'impl<S: Decoder<S> Decoder<MappedSchema<S>> for MappedSchema<S> { decode: MappedSchema.mappedDecode } fn after() -> i32 { return 7 }'
  const result = parseText('memory://damaged-conditional-conformance.silk', source)
  assert.isAbove(result.parserDiagnostics.length, 0)
  assert.strictEqual(
    result.root.children.filter(
      (element): element is SyntaxTree.Node =>
        SyntaxTree.isNode(element) && element.kind === 'ImplDeclaration',
    ).length,
    1,
  )
  assert.strictEqual(directFunctionDeclarations(result.root).length, 1)
  assert.deepEqual(missingLeaves(directFunctionDeclarations(result.root).at(0) ?? result.root), [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('bounds damaged conformance recovery before the following declaration', () => {
  const result = parseText(
    'memory://damaged-conformance.silk',
    'import silk.allocator { Allocator }\nimpl Allocator for Broken fn after() -> i32 { return 42 }',
  )
  assert.strictEqual(directFunctionDeclarations(result.root).length, 1)
  assert.include(
    missingLeaves(result.root).map((token) => token.expected),
    'LeftBrace',
  )
  assert.include(
    missingLeaves(result.root).map((token) => token.expected),
    'RightBrace',
  )
})

it('bounds a damaged unsafe call before the following statement and declaration', () => {
  const source =
    'import silk.slot { Slot }\nfn main() -> i32 { unsafe { let value = Slot.take( return 42 } } fn after() -> i32 { return 7 }'
  const result = parseText('memory://damaged-unsafe-call.silk', source)
  const functions = directFunctionDeclarations(result.root)

  assert.strictEqual(functions.length, 2)
  assert.include(
    missingLeaves(functions.at(0) ?? result.root).map((token) => token.expected),
    'RightParenthesis',
  )
  assert.deepEqual(missingLeaves(functions.at(1) ?? result.root), [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses an explicit selected requirement row in a provision pipeline', () => {
  const result = parseText(
    'memory://provider-role.silk',
    'import silk.effect { Effect }\nfn main() -> i32 { let recipe = work() |> Effect.provide<Clock at Scratch>(&clock) return 0 }',
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assert.include(
    descendants(result.root)
      .filter(SyntaxTree.isNode)
      .map((node) => node.kind),
    'RequirementSelector',
  )
})

it('parses explicit Effect contracts and declaration requirement rows', () => {
  const result = parseText(
    'memory://effect-contract-rows.silk',
    `import silk.allocator { Allocator }
import silk.filesystem { FileSystem }
fn later() -> Effect<i32 ! Problem ? &FileSystem | &mut Allocator at Scratch> {
  return effect { return 1 }
}
effect fn work() -> i32 ! Problem ? &FileSystem | &mut Allocator at Scratch { return 1 }`,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  const kinds = descendants(result.root)
    .filter(SyntaxTree.isNode)
    .map((node) => node.kind)
  assert.strictEqual(kinds.filter((kind) => kind === 'FailureRow').length, 2)
  assert.strictEqual(kinds.filter((kind) => kind === 'RequirementRow').length, 2)
  assert.strictEqual(kinds.filter((kind) => kind === 'Requirement').length, 4)
})

it('parses the accepted function into the exact first concrete node shape', () => {
  const lexical = Lexer.lex(SourceFile.make('fixture://accepted.silk', ascii(acceptedSource)))
  const result = Parser.parse(lexical)

  assert.deepEqual(nodeShape(result.root), acceptedShape)
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(acceptedSource))
  assert.strictEqual(result.source, lexical.source)
  assert.strictEqual(result.tokens, lexical.tokens)
})

it('parses dense whitespace and line-comment trivia without changing the grammar nodes', () => {
  const result = parseText('fixture://dense-trivia.silk', denseTriviaSource)
  const kinds = descendants(result.root)
    .filter(SyntaxTree.isNode)
    .map((node) => node.kind)

  assert.deepEqual(kinds, [
    'FunctionDeclaration',
    'ParameterList',
    'ReturnType',
    'TypePath',
    'Block',
    'ReturnStatement',
    'IntegerLiteralExpression',
  ])
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(denseTriviaSource))
})

it('parses two declarations as separate direct branches in source order', () => {
  const result = parseText('fixture://two-functions.silk', twoFunctionSource)
  const declarations = directFunctionDeclarations(result.root)

  assert.strictEqual(declarations.length, 2)
  assert.deepEqual(
    declarations.map((declaration) => directTokenText(result, declaration, 'Identifier')),
    ['answer', 'main'],
  )
  const secondLeading = declarations.at(1)?.children.at(0)
  assert.strictEqual(
    secondLeading === undefined ? undefined : SyntaxTree.isToken(secondLeading),
    true,
  )
  if (secondLeading === undefined || !SyntaxTree.isToken(secondLeading)) return
  assert.strictEqual(secondLeading.kind, 'Whitespace')
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(twoFunctionSource))
})

it('parses three declarations without imposing a temporary source-file limit', () => {
  const result = parseText('fixture://three-functions.silk', threeFunctionSource)

  assert.deepEqual(
    directFunctionDeclarations(result.root).map((declaration) =>
      directTokenText(result, declaration, 'Identifier'),
    ),
    ['one', 'two', 'three'],
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(threeFunctionSource))
})

it('parses a zero-argument call as one lossless concrete expression', () => {
  const result = parseText('fixture://valid-call.silk', validCallSource)
  const calls = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CallExpression',
  )
  const call = calls.at(0)

  assert.strictEqual(calls.length, 1)
  assert.notStrictEqual(call, undefined)
  if (call === undefined) return
  assert.deepEqual(nodeShape(call), {
    kind: 'CallExpression',
    children: [
      {
        kind: 'IdentifierExpression',
        children: ['Whitespace', 'Identifier'],
      },
      { kind: 'ArgumentList', children: ['LeftParenthesis', 'RightParenthesis'] },
    ],
  })
  const callee = SyntaxTree.directNode(call, 'IdentifierExpression')
  assert.strictEqual(
    callee === undefined ? undefined : directTokenText(result, callee, 'Identifier'),
    'answer',
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(validCallSource))
})

it('retains trivia between every concrete call element', () => {
  const result = parseText('fixture://trivia-call.silk', triviaCallSource)
  const call = descendants(result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CallExpression',
  )

  assert.notStrictEqual(call, undefined)
  if (call === undefined) return
  const argumentsList = call.children.find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'ArgumentList',
  )
  assert.notStrictEqual(argumentsList, undefined)
  if (argumentsList === undefined) return
  assert.deepEqual(
    argumentsList.children.map((element) => {
      if (SyntaxTree.isNode(element) || SyntaxTree.isToken(element)) return element.kind
      return `Missing(${element.expected})`
    }),
    [
      'Whitespace',
      'LineComment',
      'Whitespace',
      'LeftParenthesis',
      'Whitespace',
      'LineComment',
      'Whitespace',
      'LineComment',
      'Whitespace',
      'RightParenthesis',
    ],
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(triviaCallSource))
})

it('parses empty parentheses as the unit value', () => {
  const result = parseText('fixture://missing-call-callee.silk', missingCallCalleeSource)
  const unit = descendants(result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'UnitExpression',
  )

  assert.notStrictEqual(unit, undefined)
  assert.deepEqual(
    SyntaxTree.tokens(unit ?? result.root).map((token) => token.kind),
    ['Whitespace', 'LeftParenthesis', 'RightParenthesis'],
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('inserts a missing call parenthesis without consuming the block brace', () => {
  const result = parseText(
    'fixture://missing-call-right-parenthesis.silk',
    missingCallRightParenthesisSource,
  )
  const call = descendants(result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CallExpression',
  )
  const block = descendants(result.root).find(
    (element): element is SyntaxTree.Node => SyntaxTree.isNode(element) && element.kind === 'Block',
  )

  assert.notStrictEqual(call, undefined)
  assert.notStrictEqual(block, undefined)
  if (call === undefined || block === undefined) return
  assert.deepEqual(
    missingLeaves(call).map((leaf) => leaf.expected),
    ['RightParenthesis'],
  )
  assert.strictEqual(
    block.children.some((element) => SyntaxTree.isToken(element) && element.kind === 'RightBrace'),
    true,
  )
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assertOriginalTokenTraversal(result)
})

it('parses decimal and identifier call arguments as ordered concrete expressions', () => {
  const literal = parseText('fixture://value-call-argument.silk', valueCallArgumentSource)
  const identifier = parseText(
    'fixture://identifier-call-argument.silk',
    identifierCallArgumentSource,
  )
  const literalArguments = descendants(literal.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'ArgumentList',
  )
  const identifierArguments = descendants(identifier.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'ArgumentList',
  )

  assert.deepEqual(nodeShape(literalArguments.at(0) ?? literal.root), {
    kind: 'ArgumentList',
    children: [
      'LeftParenthesis',
      { kind: 'IntegerLiteralExpression', children: ['DecimalInteger'] },
      'RightParenthesis',
    ],
  })
  assert.deepEqual(nodeShape(identifierArguments.at(0) ?? identifier.root), {
    kind: 'ArgumentList',
    children: [
      'LeftParenthesis',
      { kind: 'IdentifierExpression', children: ['Identifier'] },
      'RightParenthesis',
    ],
  })
  assert.deepEqual(literal.parserDiagnostics, [])
  assert.deepEqual(identifier.parserDiagnostics, [])
  assertOriginalTokenTraversal(literal)
  assertOriginalTokenTraversal(identifier)
})

it('parses valid and invalid duration tokens as lossless duration expressions', () => {
  const validSource =
    'fn sleep(value: u64) -> u64 { return value }\nfn main() -> u64 { return sleep(01h05m00s) }'
  const valid = parseText('fixture://duration-expression.silk', validSource)
  const durations = descendants(valid.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'DurationLiteralExpression',
  )

  assert.deepEqual(nodeShape(durations.at(0) ?? valid.root), {
    kind: 'DurationLiteralExpression',
    children: ['DurationLiteral'],
  })
  assert.deepEqual(valid.lexicalDiagnostics, [])
  assert.deepEqual(valid.parserDiagnostics, [])
  assertOriginalTokenTraversal(valid)
  assert.deepEqual(reconstructedBytes(valid), ascii(validSource))

  const invalidSource = 'fn main() -> u64 { return 1h60m }'
  const invalid = parseText('fixture://invalid-duration-expression.silk', invalidSource)
  const invalidDuration = descendants(invalid.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'DurationLiteralExpression',
  )
  assert.deepEqual(nodeShape(invalidDuration ?? invalid.root), {
    kind: 'DurationLiteralExpression',
    children: ['Whitespace', 'InvalidDurationLiteral'],
  })
  assert.deepEqual(
    invalid.lexicalDiagnostics.map((diagnostic) => diagnostic.code),
    ['LEX0012'],
  )
  assert.deepEqual(invalid.parserDiagnostics, [])
  assertOriginalTokenTraversal(invalid)
  assert.deepEqual(reconstructedBytes(invalid), ascii(invalidSource))
})

it('parses nested calls as lossless argument expressions', () => {
  const result = parseText('fixture://nested-call.silk', nestedCallSource)
  const calls = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CallExpression',
  )
  const outer = calls.at(0)
  const inner = calls.at(1)

  assert.strictEqual(calls.length, 2)
  assert.notStrictEqual(outer, undefined)
  assert.notStrictEqual(inner, undefined)
  if (outer === undefined || inner === undefined) return
  assert.deepEqual(nodeShape(outer), {
    kind: 'CallExpression',
    children: [
      {
        kind: 'IdentifierExpression',
        children: ['Whitespace', 'Identifier'],
      },
      {
        kind: 'ArgumentList',
        children: [
          'LeftParenthesis',
          {
            kind: 'CallExpression',
            children: [
              { kind: 'IdentifierExpression', children: ['Identifier'] },
              {
                kind: 'ArgumentList',
                children: [
                  'LeftParenthesis',
                  { kind: 'IntegerLiteralExpression', children: ['DecimalInteger'] },
                  'RightParenthesis',
                ],
              },
            ],
          },
          'RightParenthesis',
        ],
      },
    ],
  })
  assert.strictEqual(inner.span.start, nestedCallSource.lastIndexOf('identity(42)'))
  assert.strictEqual(inner.span.end, nestedCallSource.lastIndexOf('identity(42)') + 12)
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(nestedCallSource))
})

it('preserves sibling nested calls and their outer comma', () => {
  const result = parseText('fixture://nested-siblings.silk', nestedSiblingCallSource)
  const calls = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CallExpression',
  )
  const outerArguments = calls
    .at(0)
    ?.children.find(
      (element): element is SyntaxTree.Node =>
        SyntaxTree.isNode(element) && element.kind === 'ArgumentList',
    )

  assert.strictEqual(calls.length, 3)
  assert.notStrictEqual(outerArguments, undefined)
  if (outerArguments === undefined) return
  assert.deepEqual(
    outerArguments.children.map((element) => {
      if (SyntaxTree.isNode(element) || SyntaxTree.isToken(element)) return element.kind
      return `Missing(${element.expected})`
    }),
    ['LeftParenthesis', 'CallExpression', 'Comma', 'CallExpression', 'RightParenthesis'],
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(nestedSiblingCallSource))
})

it('reserves the outer closing parenthesis when the inner call is damaged', () => {
  const result = parseText(
    'fixture://missing-nested-right-parenthesis.silk',
    missingNestedRightParenthesisSource,
  )
  const calls = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CallExpression',
  )
  const outer = calls.at(0)
  const inner = calls.at(1)

  assert.notStrictEqual(outer, undefined)
  assert.notStrictEqual(inner, undefined)
  if (outer === undefined || inner === undefined) return
  assert.deepEqual(
    missingLeaves(inner).map((leaf) => leaf.expected),
    ['RightParenthesis'],
  )
  assert.deepEqual(
    missingLeaves(outer).map((leaf) => leaf.expected),
    ['RightParenthesis'],
  )
  assert.strictEqual(
    outer.children
      .flatMap((element) => (SyntaxTree.isNode(element) ? element.children : []))
      .some((element) => SyntaxTree.isToken(element) && element.kind === 'RightParenthesis'),
    true,
  )
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(missingNestedRightParenthesisSource))
})

it('keeps a sibling argument after damaged nested syntax', () => {
  const result = parseText('fixture://damaged-nested-sibling.silk', damagedNestedSiblingSource)
  const calls = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CallExpression',
  )
  const outerArguments = calls
    .at(0)
    ?.children.find(
      (element): element is SyntaxTree.Node =>
        SyntaxTree.isNode(element) && element.kind === 'ArgumentList',
    )

  assert.strictEqual(calls.length, 3)
  assert.notStrictEqual(outerArguments, undefined)
  if (outerArguments === undefined) return
  assert.strictEqual(
    outerArguments.children.filter(
      (element) => SyntaxTree.isNode(element) && element.kind === 'CallExpression',
    ).length,
    2,
  )
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      reason: diagnostic.reason,
    })),
    [
      {
        code: 'PAR0002',
        message: 'Unexpected `:`; expected identifier',
        reason: {
          _tag: 'UnexpectedTokens',
          unexpected: ['Colon'],
          context: 'syntax',
          expected: ['identifier'],
        },
      },
    ],
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(damagedNestedSiblingSource))
})

it('bounds nested recovery before the following declaration', () => {
  const result = parseText(
    'fixture://damaged-nested-before-next-function.silk',
    damagedNestedBeforeNextFunctionSource,
  )
  const declarations = directFunctionDeclarations(result.root)
  const after = declarations.at(2)

  assert.strictEqual(declarations.length, 3)
  assert.notStrictEqual(after, undefined)
  if (after === undefined) return
  assert.deepEqual(missingLeaves(after), [])
  assert.strictEqual(directTokenText(result, after, 'Identifier'), 'after')
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(damagedNestedBeforeNextFunctionSource))
})

it('parses representative deep nested calls deterministically', () => {
  const depth = 64
  const expression = `${'identity('.repeat(depth)}42${')'.repeat(depth)}`
  const source = `pub fn identity(value: i32) -> i32 { return value }\npub fn main() -> i32 { return ${expression} }`
  const first = parseText('fixture://deep-nested-call.silk', source)
  const second = parseText('fixture://deep-nested-call.silk', source)

  assert.strictEqual(
    descendants(first.root).filter(
      (element) => SyntaxTree.isNode(element) && element.kind === 'CallExpression',
    ).length,
    depth,
  )
  assert.deepEqual(nodeShape(first.root), nodeShape(second.root))
  assert.deepEqual(diagnosticView(first), diagnosticView(second))
  assertOriginalTokenTraversal(first)
  assert.deepEqual(reconstructedBytes(first), ascii(source))
})

it('parses typed parameters and bare identifier return expressions', () => {
  const identity = parseText('fixture://identity.silk', identitySource)
  const multiple = parseText('fixture://two-parameters.silk', twoParameterSource)
  const identityParameters = descendants(identity.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'ParameterDeclaration',
  )
  const multipleParameters = descendants(multiple.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'ParameterDeclaration',
  )

  assert.strictEqual(identityParameters.length, 1)
  assert.strictEqual(multipleParameters.length, 2)
  assert.deepEqual(nodeShape(identityParameters.at(0) ?? identity.root), {
    kind: 'ParameterDeclaration',
    children: ['Identifier', 'Colon', { kind: 'TypePath', children: ['Whitespace', 'Identifier'] }],
  })
  assert.strictEqual(
    descendants(identity.root).some(
      (element) => SyntaxTree.isNode(element) && element.kind === 'IdentifierExpression',
    ),
    true,
  )
  assert.deepEqual(identity.parserDiagnostics, [])
  assert.deepEqual(multiple.parserDiagnostics, [])
  assertOriginalTokenTraversal(identity)
  assertOriginalTokenTraversal(multiple)
})

it('parses mutable owned parameters losslessly', () => {
  const result = parseText(
    'fixture://mutable-parameters.silk',
    'fn update(mut counter: Counter, mut amount: i32) -> Counter { return move counter }',
  )
  const parameters = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'ParameterDeclaration',
  )

  assert.deepEqual(result.parserDiagnostics, [])
  assert.deepEqual(parameters.map(nodeShape), [
    {
      kind: 'ParameterDeclaration',
      children: [
        'MutKeyword',
        'Whitespace',
        'Identifier',
        'Colon',
        { kind: 'TypePath', children: ['Whitespace', 'Identifier'] },
      ],
    },
    {
      kind: 'ParameterDeclaration',
      children: [
        'Whitespace',
        'MutKeyword',
        'Whitespace',
        'Identifier',
        'Colon',
        { kind: 'TypePath', children: ['Whitespace', 'Identifier'] },
      ],
    },
  ])
  assertOriginalTokenTraversal(result)
})

it('recovers duplicate and misplaced parameter mutability locally', () => {
  const duplicate = parseText(
    'fixture://duplicate-parameter-mut.silk',
    'fn update(mut mut counter: Counter, amount: i32) -> Counter { return move counter }',
  )
  const misplaced = parseText(
    'fixture://misplaced-parameter-mut.silk',
    'fn update(counter mut: Counter, amount: i32) -> Counter { return move counter }',
  )
  const parameters = (result: SyntaxFile.SyntaxFile): ReadonlyArray<SyntaxTree.Node> =>
    descendants(result.root).filter(
      (element): element is SyntaxTree.Node =>
        SyntaxTree.isNode(element) && element.kind === 'ParameterDeclaration',
    )

  assert.deepEqual(
    duplicate.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0002'],
  )
  assert.deepEqual(
    misplaced.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0002'],
  )
  assert.strictEqual(parameters(duplicate).length, 2)
  assert.strictEqual(parameters(misplaced).length, 2)
  assert.deepEqual(
    errorNodes(parameters(duplicate).at(0) ?? duplicate.root)
      .flatMap((node) => SyntaxTree.tokens(node))
      .filter((token) => token.kind !== 'Whitespace')
      .map((token) => token.kind),
    ['MutKeyword'],
  )
  assert.deepEqual(
    errorNodes(parameters(misplaced).at(0) ?? misplaced.root)
      .flatMap((node) => SyntaxTree.tokens(node))
      .filter((token) => token.kind !== 'Whitespace')
      .map((token) => token.kind),
    ['MutKeyword'],
  )
  assertOriginalTokenTraversal(duplicate)
  assertOriginalTokenTraversal(misplaced)
})

it('keeps mutable parameter recovery local to the damaged parameter', () => {
  const missingName = parseText(
    'fixture://mutable-parameter-missing-name.silk',
    'fn damaged(mut : i32, tail: i32) -> i32 { return tail }',
  )
  const missingColon = parseText(
    'fixture://mutable-parameter-missing-colon.silk',
    'fn damaged(mut value i32, tail: i32) -> i32 { return tail }',
  )
  const missingType = parseText(
    'fixture://mutable-parameter-missing-type.silk',
    'fn damaged(mut value:, tail: i32) -> i32 { return tail }',
  )

  assert.deepEqual(
    missingLeaves(missingName.root).map((leaf) => leaf.expected),
    ['Identifier'],
  )
  assert.deepEqual(
    missingLeaves(missingColon.root).map((leaf) => leaf.expected),
    ['Colon'],
  )
  assert.deepEqual(
    missingLeaves(missingType.root).map((leaf) => leaf.expected),
    ['Identifier'],
  )
  for (const result of [missingName, missingColon, missingType]) {
    assert.strictEqual(
      descendants(result.root).filter(
        (element) => SyntaxTree.isNode(element) && element.kind === 'ParameterDeclaration',
      ).length,
      2,
    )
    assertOriginalTokenTraversal(result)
  }
})

it('recovers missing parameter types and commas without losing later syntax', () => {
  const missingType = parseText('fixture://missing-parameter-type.silk', missingParameterTypeSource)
  const missingComma = parseText(
    'fixture://missing-parameter-comma.silk',
    missingParameterCommaSource,
  )

  assert.deepEqual(
    missingLeaves(missingType.root).map((leaf) => leaf.expected),
    ['Identifier'],
  )
  assert.deepEqual(
    missingLeaves(missingComma.root).map((leaf) => leaf.expected),
    ['Comma'],
  )
  assert.strictEqual(
    descendants(missingComma.root).filter(
      (element) => SyntaxTree.isNode(element) && element.kind === 'ParameterDeclaration',
    ).length,
    2,
  )
  assertOriginalTokenTraversal(missingType)
  assertOriginalTokenTraversal(missingComma)
})

it('keeps malformed arguments explicit and resumes at the next comma', () => {
  const result = parseText('fixture://malformed-call-argument.silk', malformedArgumentSource)
  const call = descendants(result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CallExpression',
  )

  assert.notStrictEqual(call, undefined)
  if (call === undefined) return
  assert.deepEqual(
    errorNodes(call)
      .flatMap((node) => SyntaxTree.tokens(node))
      .map((token) => token.kind),
    ['Colon'],
  )
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0002'],
  )
  assert.strictEqual(
    descendants(call).filter(
      (element) => SyntaxTree.isNode(element) && element.kind === 'IdentifierExpression',
    ).length,
    3,
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(malformedArgumentSource))
})

it('bounds unsupported anonymous effect function recovery inside call arguments', () => {
  const source = `fn outer() -> () {
  f(once effect fn (error: E) -> () {
    return ()
  })
}`
  const result = parseText('fixture://unsupported-anonymous-effect-function.silk', source)

  assert.isAbove(result.parserDiagnostics.length, 0)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('advances past a malformed effect expression inside call arguments', () => {
  const source = 'fn outer() -> () { f(effect nope) }'
  const result = parseText('fixture://malformed-effect-call-argument.silk', source)

  assert.isAbove(result.parserDiagnostics.length, 0)
  assert.include(
    errorNodes(result.root)
      .flatMap((node) => SyntaxTree.tokens(node))
      .map((token) => token.kind),
    'EffectKeyword',
  )
  assert.strictEqual(directFunctionDeclarations(result.root).length, 1)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('keeps a valid effect block as a call argument', () => {
  const source = 'fn outer() -> () { f(effect { return () }) }'
  const result = parseText('fixture://effect-block-call-argument.silk', source)

  assert.deepEqual(result.parserDiagnostics, [])
  assert.include(
    descendants(result.root)
      .filter(SyntaxTree.isNode)
      .map((node) => node.kind),
    'EffectExpression',
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('bounds damaged call recovery before the following function', () => {
  const result = parseText(
    'fixture://damaged-call-before-next-function.silk',
    damagedCallBeforeNextFunctionSource,
  )
  const declarations = directFunctionDeclarations(result.root)
  const first = declarations.at(0)
  const second = declarations.at(1)

  assert.notStrictEqual(first, undefined)
  assert.notStrictEqual(second, undefined)
  if (first === undefined || second === undefined) return
  assert.deepEqual(
    missingLeaves(first).map((leaf) => leaf.expected),
    ['RightParenthesis', 'RightBrace'],
  )
  assert.deepEqual(missingLeaves(second), [])
  assert.strictEqual(directTokenText(result, second, 'Identifier'), 'after')
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(damagedCallBeforeNextFunctionSource))
})

it('keeps trailing trivia with the end-of-file expectation', () => {
  const result = parseText('fixture://trailing-trivia.silk', trailingTriviaSource)
  const directTokens = result.root.children.filter(SyntaxTree.isToken)

  assert.deepEqual(
    directTokens.map((token) => token.kind),
    ['Whitespace', 'LineComment', 'Whitespace', 'EndOfFile'],
  )
  assert.strictEqual(directFunctionDeclarations(result.root).length, 1)
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(trailingTriviaSource))
})

it('inserts a missing first brace without consuming the second declaration', () => {
  const result = parseText('fixture://missing-first-brace.silk', missingFirstRightBraceSource)
  const declarations = directFunctionDeclarations(result.root)
  const first = declarations.at(0)
  const second = declarations.at(1)

  assert.notStrictEqual(first, undefined)
  assert.notStrictEqual(second, undefined)
  if (first === undefined || second === undefined) return
  assert.deepEqual(
    missingLeaves(first).map((leaf) => ({
      expected: leaf.expected,
      start: leaf.span.start,
      end: leaf.span.end,
    })),
    [
      {
        expected: 'RightBrace',
        start: missingFirstRightBraceSource.indexOf('pub fn main'),
        end: missingFirstRightBraceSource.indexOf('pub fn main'),
      },
    ],
  )
  assert.deepEqual(missingLeaves(second), [])
  assert.strictEqual(directTokenText(result, second, 'Identifier'), 'main')
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(missingFirstRightBraceSource))
})

it('retains unexpected punctuation at a function boundary and parses the next declaration', () => {
  const result = parseText(
    'fixture://inter-function-punctuation.silk',
    interFunctionPunctuationSource,
  )
  const declarations = directFunctionDeclarations(result.root)
  const boundaryErrors = errorNodes(result.root)
  const second = declarations.at(1)

  assert.strictEqual(declarations.length, 2)
  assert.notStrictEqual(second, undefined)
  if (second === undefined) return
  assert.strictEqual(directTokenText(result, second, 'Identifier'), 'main')
  assert.deepEqual(missingLeaves(second), [])
  assert.strictEqual(boundaryErrors.length, 1)
  assert.deepEqual(
    boundaryErrors.flatMap((node) => SyntaxTree.tokens(node)).map((token) => token.kind),
    ['Invalid', 'Whitespace'],
  )
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0002'],
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(interFunctionPunctuationSource))
})

it('inserts a missing function name before the opening parenthesis', () => {
  const result = parseText('fixture://missing-name.silk', missingNameSource)
  const missing = missingLeaves(result.root)

  assert.deepEqual(
    missing.map((leaf) => ({
      expected: leaf.expected,
      start: leaf.span.start,
      end: leaf.span.end,
    })),
    [{ expected: 'Identifier', start: 7, end: 7 }],
  )
  assert.deepEqual(diagnosticView(result), [
    {
      code: 'PAR0001',
      start: 7,
      end: 7,
      reason: { _tag: 'MissingToken', expected: 'Identifier' },
    },
  ])
  assertOriginalTokenTraversal(result)
})

it('inserts a missing right brace at end-of-file', () => {
  const result = parseText('fixture://missing-brace.silk', missingRightBraceSource)
  const missing = missingLeaves(result.root)

  assert.deepEqual(
    missing.map((leaf) => ({
      expected: leaf.expected,
      start: leaf.span.start,
      end: leaf.span.end,
    })),
    [
      {
        expected: 'RightBrace',
        start: missingRightBraceSource.length,
        end: missingRightBraceSource.length,
      },
    ],
  )
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assertOriginalTokenTraversal(result)
})

it('groups unexpected punctuation and following trivia before the function name', () => {
  const result = parseText('fixture://unexpected.silk', unexpectedPunctuationSource)
  const errors = errorNodes(result.root)

  assert.strictEqual(errors.length, 1)
  const error = errors.at(0)
  assert.notStrictEqual(error, undefined)
  if (error === undefined) return
  assert.deepEqual(
    SyntaxTree.tokens(error).map((token) => token.kind),
    ['Invalid', 'Whitespace'],
  )
  assert.deepEqual(diagnosticView(result), [
    {
      code: 'PAR0002',
      start: 7,
      end: 9,
      reason: {
        _tag: 'UnexpectedTokens',
        unexpected: ['Invalid', 'Whitespace'],
        context: 'syntax',
        expected: ['identifier'],
      },
    },
  ])
  assert.deepEqual(
    result.lexicalDiagnostics.map((diagnostic) => diagnostic.code),
    ['LEX0001'],
  )
  assertOriginalTokenTraversal(result)
})

it('parses empty input as a module containing only end-of-file', () => {
  const result = parseBytes('fixture://empty.silk', emptySource)

  assert.deepEqual(
    result.root.children.map((element) => element._tag),
    ['Token'],
  )
  assert.strictEqual(SyntaxTree.directNodes(result.root, 'FunctionDeclaration').length, 0)
  assert.deepEqual(missingLeaves(result.root), [])
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('reports one diagnostic for an incomplete declaration prefix at end-of-file', () => {
  const result = parseText('fixture://incomplete-pub.silk', 'pub')

  assert.deepEqual(
    missingLeaves(result.root).map((leaf) => leaf.expected),
    ['FnKeyword', 'Identifier', 'LeftParenthesis', 'RightParenthesis', 'LeftBrace', 'RightBrace'],
  )
  assert.deepEqual(
    result.parserDiagnostics.map(({ code, message }) => ({ code, message })),
    [{ code: 'PAR0001', message: 'Expected `fn`' }],
  )
  assertOriginalTokenTraversal(result)
})

it('reports a later independent mistake after consuming a recovery anchor', () => {
  const result = parseText('fixture://synchronized-recovery.silk', 'pub () -> i32 { return }')

  assert.deepEqual(
    missingLeaves(result.root).map((leaf) => leaf.expected),
    ['FnKeyword', 'Identifier'],
  )
  assert.deepEqual(
    result.parserDiagnostics.map(({ code, message }) => ({ code, message })),
    [{ code: 'PAR0001', message: 'Expected `fn`' }],
  )
  assertOriginalTokenTraversal(result)
})

it('terminates on wholly unrelated input and retains it in one error region', () => {
  const result = parseText('fixture://unrelated.silk', whollyUnrelatedSource)
  const errors = errorNodes(result.root)

  assert.strictEqual(errors.length, 1)
  assert.strictEqual(errors.at(0)?.span.start, 0)
  assert.strictEqual(errors.at(0)?.span.end, whollyUnrelatedSource.length)
  assert.strictEqual(missingLeaves(result.root).length, 6)
  assert.strictEqual(result.parserDiagnostics.at(0)?.code, 'PAR0002')
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(whollyUnrelatedSource))
})

it('retains invalid UTF-8 bytes and lexical diagnostics inside concrete recovery', () => {
  const result = parseBytes('fixture://invalid-utf8.silk', invalidUtf8Source)
  const errors = errorNodes(result.root)

  assert.deepEqual(
    result.lexicalDiagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      start: diagnostic.span.start,
      end: diagnostic.span.end,
    })),
    [{ code: 'LEX0001', start: 7, end: 9 }],
  )
  assert.deepEqual(
    errors.flatMap((node) => SyntaxTree.tokens(node)).map((token: Token.Token) => token.kind),
    ['Invalid', 'Whitespace'],
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), invalidUtf8Source)
})

it('is deterministic across repeated fresh lexical results', () => {
  const first = parseText('fixture://deterministic.silk', interFunctionPunctuationSource)
  const second = parseText('fixture://deterministic.silk', interFunctionPunctuationSource)

  assert.deepEqual(nodeShape(first.root), nodeShape(second.root))
  assert.deepEqual(diagnosticView(first), diagnosticView(second))
  assert.deepEqual(first.lexicalDiagnostics, second.lexicalDiagnostics)
  assert.deepEqual(reconstructedBytes(first), reconstructedBytes(second))
})

it('parses import declarations before functions as separate lossless branches', () => {
  const result = parseText(
    'fixture://imports.silk',
    'import math\nimport io\npub fn main() -> i32 { return 42 }',
  )
  const kinds = result.root.children.flatMap((element) =>
    SyntaxTree.isNode(element) ? [element.kind] : [],
  )

  assert.deepEqual(kinds, ['ImportDeclaration', 'ImportDeclaration', 'FunctionDeclaration'])
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(
    reconstructedBytes(result),
    ascii('import math\nimport io\npub fn main() -> i32 { return 42 }'),
  )
})

it('recovers a missing import name and keeps the following function parseable', () => {
  const result = parseText(
    'fixture://missing-import-name.silk',
    'import\npub fn main() -> i32 { return 42 }',
  )
  const importNode = result.root.children.find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'ImportDeclaration',
  )
  const functionNode = result.root.children.find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'FunctionDeclaration',
  )

  assert.notStrictEqual(importNode, undefined)
  assert.notStrictEqual(functionNode, undefined)
  assert.strictEqual(
    SyntaxTree.directNode(importNode ?? result.root, 'ImportPath')?.children.some(
      (element) => SyntaxTree.isMissingToken(element) && element.expected === 'Identifier',
    ),
    true,
  )
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assertOriginalTokenTraversal(result)
})

it('keeps import as a keyword only when spelled completely', () => {
  const lexical = Lexer.lex(
    SourceFile.make('fixture://import-keyword.silk', ascii('import importer')),
  )

  assert.deepEqual(
    lexical.tokens.filter((token) => token.kind !== 'Whitespace').map((token) => token.kind),
    ['ImportKeyword', 'Identifier', 'EndOfFile'],
  )
})

it('parses namespace, selective, member-alias, and hybrid imports losslessly', () => {
  const source = `import compiler.Syntax
import compiler.Tree as Ast
import compiler.Parse { Node, parse, encode as encodeSyntax }
import compiler.Tir as Ir { lower, inspect as show }
pub fn main() -> i32 { return 42 }`
  const result = parseText('fixture://full-imports.silk', source)
  const imports = SyntaxTree.directNodes(result.root, 'ImportDeclaration')
  assert.strictEqual(imports.length, 4)
  assert.deepEqual(
    imports.map((node) => {
      const list = SyntaxTree.directNode(node, 'ImportMemberList')
      return list === undefined ? 0 : SyntaxTree.directNodes(list, 'ImportMember').length
    }),
    [0, 0, 3, 2],
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('parses reserved import-path segments without changing their token kinds', () => {
  const source = `import silk.effect { Effect }
import toolkit.effect.helpers as Helpers
import silk.effect { Effect }
import app.type as Types
fn main() -> i32 { return 42 }`
  const result = parseText('fixture://reserved-import-paths.silk', source)
  const paths = SyntaxTree.directNodes(result.root, 'ImportDeclaration').map((declaration) =>
    SyntaxTree.directNode(declaration, 'ImportPath'),
  )
  assert.deepEqual(
    paths.map((path) =>
      path === undefined ? [] : ImportPath.segments(path).map((token) => token.kind),
    ),
    [
      ['Identifier', 'EffectKeyword'],
      ['Identifier', 'EffectKeyword', 'Identifier'],
      ['Identifier', 'EffectKeyword'],
      ['Identifier', 'TypeKeyword'],
    ],
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('diagnoses a reserved final import segment without a usable binding form', () => {
  const source = 'import silk.effect\nfn main() -> i32 { return 42 }'
  const result = parseText('fixture://reserved-import-binding.silk', source)
  assert.strictEqual(SyntaxTree.directNodes(result.root, 'ImportDeclaration').length, 1)
  assert.strictEqual(SyntaxTree.directNodes(result.root, 'FunctionDeclaration').length, 1)
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      reason: diagnostic.reason,
    })),
    [
      {
        code: 'PAR0004',
        reason: { _tag: 'ReservedImportBinding', spelling: 'effect' },
      },
    ],
  )
  assertOriginalTokenTraversal(result)
})

it('keeps reserved-word token classification outside contextual import paths', () => {
  const result = Lexer.lex(SourceFile.make('fixture://reserved-binding-name.silk', ascii('effect')))
  assert.deepEqual(
    result.tokens.map((token) => token.kind),
    ['EffectKeyword', 'EndOfFile'],
  )
})

it('parses private functions without fabricating a public modifier', () => {
  const result = parseText('fixture://private.silk', 'fn helper() -> i32 { return 42 }')
  const declaration = SyntaxTree.directNode(result.root, 'FunctionDeclaration')
  assert.notStrictEqual(declaration, undefined)
  assert.strictEqual(
    declaration === undefined ? undefined : SyntaxTree.directToken(declaration, 'PubKeyword'),
    undefined,
  )
  assert.deepEqual(result.parserDiagnostics, [])
})

it('bounds import recovery and preserves the following declaration', () => {
  const cases = [
    'import compiler. as Tree\nfn helper() -> i32 { return 1 }',
    'import compiler.Syntax as\nfn helper() -> i32 { return 1 }',
    'import compiler.Syntax { Node, , parse }\nfn helper() -> i32 { return 1 }',
    'import compiler.Syntax { Node parse }\nfn helper() -> i32 { return 1 }',
    'import compiler.Syntax { Node\nfn helper() -> i32 { return 1 }',
  ]
  for (const [ordinal, source] of cases.entries()) {
    const result = parseText(`fixture://damaged-import-${ordinal}.silk`, source)
    assert.strictEqual(SyntaxTree.directNodes(result.root, 'ImportDeclaration').length, 1)
    assert.strictEqual(SyntaxTree.directNodes(result.root, 'FunctionDeclaration').length, 1)
    assert.isAtLeast(result.parserDiagnostics.length, 1)
    assertOriginalTokenTraversal(result)
  }
})

it('parses a binding sequence as ordered statement branches', () => {
  const result = parseText(
    'fixture://bindings.silk',
    'pub fn main() -> i32 { let value = 42 return value }',
  )
  const fn = directFunctionDeclarations(result.root).at(0)
  const block = fn === undefined ? undefined : SyntaxTree.directNode(fn, 'Block')
  assert.notStrictEqual(block, undefined)
  if (block === undefined) return

  const statements = block.children.filter(SyntaxTree.isNode).map((node) => node.kind)
  assert.deepEqual(statements, ['BindingStatement', 'ReturnStatement'])
  const binding = SyntaxTree.directNode(block, 'BindingStatement')
  assert.notStrictEqual(binding, undefined)
  if (binding === undefined) return
  assert.strictEqual(directTokenText(result, binding, 'Identifier'), 'value')
  assert.notStrictEqual(SyntaxTree.directToken(binding, 'Equals'), undefined)
  assert.notStrictEqual(SyntaxTree.directNode(binding, 'IntegerLiteralExpression'), undefined)
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(
    reconstructedBytes(result),
    ascii('pub fn main() -> i32 { let value = 42 return value }'),
  )
})

it('parses standalone expressions as ordered statements without phantom declarations', () => {
  const source = `pub effect fn first() -> () { return () }
pub effect fn second() -> () { return () }
pub effect fn main() -> () {
  run first()
  run second()
  return ()
}`
  const result = parseText('memory/expression-statements', source)
  const declarations = directFunctionDeclarations(result.root)
  const main = declarations.at(2)
  const block = main === undefined ? undefined : SyntaxTree.directNode(main, 'Block')

  assert.strictEqual(declarations.length, 3)
  assert.notStrictEqual(block, undefined)
  assert.deepEqual(
    (block?.children ?? []).filter(SyntaxTree.isNode).map((node) => node.kind),
    ['ExpressionStatement', 'ExpressionStatement', 'ReturnStatement'],
  )
  assert.strictEqual(
    (block === undefined ? [] : SyntaxTree.directNodes(block, 'ExpressionStatement')).every(
      (statement) => SyntaxTree.directNode(statement, 'RunExpression') !== undefined,
    ),
    true,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('keeps assignment dispatch ahead of identifier-led expression statements', () => {
  const source = `fn observe(value: i32) -> () { return () }
fn main() -> () {
  let mut value = 0
  value = 1
  observe(value)
}`
  const result = parseText('memory/expression-statement-assignment', source)
  const main = directFunctionDeclarations(result.root).at(1)
  const block = main === undefined ? undefined : SyntaxTree.directNode(main, 'Block')

  assert.deepEqual(
    (block?.children ?? []).filter(SyntaxTree.isNode).map((node) => node.kind),
    ['BindingStatement', 'AssignmentStatement', 'ExpressionStatement', 'ReturnStatement'],
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('keeps a valid return inside its block after a damaged run expression', () => {
  const source = `pub effect fn main() -> () {
  run )
  return ()
}`
  const result = parseText('memory/damaged-expression-statement', source)
  const declarations = directFunctionDeclarations(result.root)
  const block = SyntaxTree.directNode(declarations[0] ?? result.root, 'Block')

  assert.strictEqual(declarations.length, 1)
  assert.deepEqual(
    (block?.children ?? []).filter(SyntaxTree.isNode).map((node) => node.kind),
    ['ExpressionStatement', 'ErrorStatement', 'ReturnStatement'],
  )
  assert.strictEqual(result.parserDiagnostics.length, 1)
  assertOriginalTokenTraversal(result)
})

it('recovers unexpected statement punctuation at the next statement and owning brace', () => {
  const source = `pub fn main() -> () {
  ;
  return ()
}`
  const result = parseText('memory/unexpected-statement-punctuation', source)
  const declarations = directFunctionDeclarations(result.root)
  const block = SyntaxTree.directNode(declarations[0] ?? result.root, 'Block')

  assert.strictEqual(declarations.length, 1)
  assert.deepEqual(
    (block?.children ?? []).filter(SyntaxTree.isNode).map((node) => node.kind),
    ['ErrorStatement', 'ReturnStatement'],
  )
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0002'],
  )
  assertOriginalTokenTraversal(result)
})

it('parses a move operand with its keyword and name', () => {
  const result = parseText(
    'fixture://move.silk',
    'pub fn main() -> i32 { let value = 42 return move value }',
  )
  const fn = directFunctionDeclarations(result.root).at(0)
  const block = fn === undefined ? undefined : SyntaxTree.directNode(fn, 'Block')
  const returnStatement =
    block === undefined ? undefined : SyntaxTree.directNode(block, 'ReturnStatement')
  const move =
    returnStatement === undefined
      ? undefined
      : SyntaxTree.directNode(returnStatement, 'MoveExpression')

  assert.notStrictEqual(move, undefined)
  if (move === undefined) return
  assert.notStrictEqual(SyntaxTree.directToken(move, 'MoveKeyword'), undefined)
  const subject = SyntaxTree.directNode(move, 'IdentifierExpression')
  assert.notStrictEqual(subject, undefined)
  if (subject === undefined) return
  assert.strictEqual(directTokenText(result, subject, 'Identifier'), 'value')
  assert.deepEqual(result.parserDiagnostics, [])
})

it('recovers a missing initializer at the return boundary', () => {
  const result = parseText(
    'fixture://missing-initializer.silk',
    'pub fn main() -> i32 { let value = return 42 }',
  )
  const fn = directFunctionDeclarations(result.root).at(0)
  const block = fn === undefined ? undefined : SyntaxTree.directNode(fn, 'Block')
  const binding = block === undefined ? undefined : SyntaxTree.directNode(block, 'BindingStatement')

  assert.notStrictEqual(binding, undefined)
  if (binding === undefined) return
  assert.strictEqual(missingLeaves(binding).length, 1)
  const returnStatement =
    block === undefined ? undefined : SyntaxTree.directNode(block, 'ReturnStatement')
  assert.notStrictEqual(returnStatement, undefined)
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assertOriginalTokenTraversal(result)
})

it('recovers a missing binding name before the equals token', () => {
  const result = parseText(
    'fixture://missing-binding-name.silk',
    'pub fn main() -> i32 { let = 42 return 0 }',
  )
  const fn = directFunctionDeclarations(result.root).at(0)
  const block = fn === undefined ? undefined : SyntaxTree.directNode(fn, 'Block')
  const binding = block === undefined ? undefined : SyntaxTree.directNode(block, 'BindingStatement')

  assert.notStrictEqual(binding, undefined)
  if (binding === undefined) return
  assert.strictEqual(
    binding.children.some(
      (element) => SyntaxTree.isMissingToken(element) && element.expected === 'Identifier',
    ),
    true,
  )
  const statements = (block?.children ?? []).filter(SyntaxTree.isNode).map((node) => node.kind)
  assert.deepEqual(statements, ['BindingStatement', 'ReturnStatement'])
  assertOriginalTokenTraversal(result)
})

it('preserves non-unit fallthrough as an implicit unit completion for semantic checking', () => {
  const result = parseText(
    'fixture://missing-return.silk',
    'pub fn main() -> i32 { let value = 42 }',
  )
  const fn = directFunctionDeclarations(result.root).at(0)
  const block = fn === undefined ? undefined : SyntaxTree.directNode(fn, 'Block')

  assert.notStrictEqual(block, undefined)
  if (block === undefined) return
  const statements = block.children.filter(SyntaxTree.isNode).map((node) => node.kind)
  assert.deepEqual(statements, ['BindingStatement', 'ReturnStatement'])
  const returnStatement = SyntaxTree.directNode(block, 'ReturnStatement')
  assert.notStrictEqual(returnStatement, undefined)
  assert.notStrictEqual(
    returnStatement === undefined
      ? undefined
      : SyntaxTree.directNode(returnStatement, 'UnitExpression'),
    undefined,
  )
  assert.deepEqual(missingLeaves(returnStatement ?? block), [])
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('keeps a final identifier as an expression statement before implicit completion', () => {
  const result = parseText('fixture://missing-return-keyword.silk', 'pub fn main() -> i32 { foo }')
  const declaration = directFunctionDeclarations(result.root).at(0)
  const block = declaration === undefined ? undefined : SyntaxTree.directNode(declaration, 'Block')
  const returned = block === undefined ? undefined : SyntaxTree.directNode(block, 'ReturnStatement')
  const expression =
    block === undefined ? undefined : SyntaxTree.directNode(block, 'ExpressionStatement')

  assert.notStrictEqual(returned, undefined)
  assert.notStrictEqual(expression, undefined)
  if (returned === undefined || expression === undefined) return
  assert.strictEqual(SyntaxTree.directNode(block ?? result.root, 'AssignmentStatement'), undefined)
  assert.notStrictEqual(SyntaxTree.directNode(expression, 'IdentifierExpression'), undefined)
  assert.notStrictEqual(SyntaxTree.directNode(returned, 'UnitExpression'), undefined)
  assert.deepEqual(missingLeaves(returned), [])
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('recovers a bare move with a missing identifier', () => {
  const result = parseText(
    'fixture://bare-move.silk',
    'pub fn main() -> i32 { let value = move return 0 }',
  )
  const fn = directFunctionDeclarations(result.root).at(0)
  const block = fn === undefined ? undefined : SyntaxTree.directNode(fn, 'Block')
  const binding = block === undefined ? undefined : SyntaxTree.directNode(block, 'BindingStatement')
  const move = binding === undefined ? undefined : SyntaxTree.directNode(binding, 'MoveExpression')

  assert.notStrictEqual(move, undefined)
  if (move === undefined) return
  assert.strictEqual(
    missingLeaves(move).some((element) => element.expected === 'Identifier'),
    true,
  )
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assertOriginalTokenTraversal(result)
})

it('keeps statements after the return statement as concrete branches', () => {
  const result = parseText(
    'fixture://trailing-statement.silk',
    'pub fn main() -> i32 { return 0 let late = 1 }',
  )
  const fn = directFunctionDeclarations(result.root).at(0)
  const block = fn === undefined ? undefined : SyntaxTree.directNode(fn, 'Block')

  assert.notStrictEqual(block, undefined)
  if (block === undefined) return
  const statements = block.children.filter(SyntaxTree.isNode).map((node) => node.kind)
  assert.deepEqual(statements, ['ReturnStatement', 'BindingStatement'])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(
    reconstructedBytes(result),
    ascii('pub fn main() -> i32 { return 0 let late = 1 }'),
  )
})

it('parses signed literals and qualified callees', () => {
  const result = parseText(
    'fixture://arith.silk',
    'import silk.i32\npub fn main() -> i32 { return i32.add(-8, 50) }',
  )
  const fn = directFunctionDeclarations(result.root).at(0)
  const block = fn === undefined ? undefined : SyntaxTree.directNode(fn, 'Block')
  const returnStatement =
    block === undefined ? undefined : SyntaxTree.directNode(block, 'ReturnStatement')
  const call =
    returnStatement === undefined
      ? undefined
      : SyntaxTree.directNode(returnStatement, 'CallExpression')

  assert.notStrictEqual(call, undefined)
  if (call === undefined) return
  const callee = SyntaxTree.directNode(call, 'FieldProjectionExpression')
  assert.notStrictEqual(callee, undefined)
  if (callee === undefined) return
  assert.notStrictEqual(SyntaxTree.directToken(callee, 'Dot'), undefined)
  assert.strictEqual(
    SyntaxTree.tokens(callee).filter((token) => token.kind === 'Identifier').length,
    2,
  )
  const argumentList = SyntaxTree.directNode(call, 'ArgumentList')
  const firstArgument =
    argumentList === undefined
      ? undefined
      : SyntaxTree.directNode(argumentList, 'IntegerLiteralExpression')
  assert.notStrictEqual(firstArgument, undefined)
  if (firstArgument === undefined) return
  assert.notStrictEqual(SyntaxTree.directToken(firstArgument, 'Minus'), undefined)
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('recovers a missing operation name after the dot', () => {
  const result = parseText(
    'fixture://missing-operation.silk',
    'import silk.i32\npub fn main() -> i32 { return i32.(1, 2) }',
  )

  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assertOriginalTokenTraversal(result)
})

it('parses referent projection as a postfix projection distinct from multiplication', () => {
  const result = parseText(
    'fixture://referent-projection.silk',
    'pub fn read(value: &u32) -> u32 { return value.* }\npub fn multiply(left: u32, right: u32) -> u32 { return left * right }',
  )
  const [read, multiply] = directFunctionDeclarations(result.root)
  const readBlock = read === undefined ? undefined : SyntaxTree.directNode(read, 'Block')
  const readReturn =
    readBlock === undefined ? undefined : SyntaxTree.directNode(readBlock, 'ReturnStatement')
  const referent =
    readReturn === undefined
      ? undefined
      : SyntaxTree.directNode(readReturn, 'ReferentProjectionExpression')
  const multiplyBlock =
    multiply === undefined ? undefined : SyntaxTree.directNode(multiply, 'Block')
  const multiplyReturn =
    multiplyBlock === undefined
      ? undefined
      : SyntaxTree.directNode(multiplyBlock, 'ReturnStatement')

  assert.notStrictEqual(referent, undefined)
  assert.notStrictEqual(
    referent === undefined ? undefined : SyntaxTree.directToken(referent, 'Dot'),
    undefined,
  )
  assert.notStrictEqual(
    referent === undefined ? undefined : SyntaxTree.directToken(referent, 'Star'),
    undefined,
  )
  assert.notStrictEqual(
    multiplyReturn === undefined
      ? undefined
      : SyntaxTree.directNode(multiplyReturn, 'InfixExpression'),
    undefined,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('recovers a dangling minus before the closing brace', () => {
  const result = parseText('fixture://dangling-minus.silk', 'pub fn main() -> i32 { return - }')

  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assertOriginalTokenTraversal(result)
})

it('parses conditionals with both arms and boolean literals', () => {
  const result = parseText(
    'fixture://conditional.silk',
    'pub fn main() -> i32 { if flag { return 1 } else { return 2 } return 0 }',
  )
  const fn = directFunctionDeclarations(result.root).at(0)
  const block = fn === undefined ? undefined : SyntaxTree.directNode(fn, 'Block')
  const conditional =
    block === undefined ? undefined : SyntaxTree.directNode(block, 'ConditionalStatement')

  assert.notStrictEqual(conditional, undefined)
  if (conditional === undefined) return
  assert.notStrictEqual(SyntaxTree.directToken(conditional, 'IfKeyword'), undefined)
  assert.notStrictEqual(SyntaxTree.directToken(conditional, 'ElseKeyword'), undefined)
  assert.strictEqual(SyntaxTree.directNodes(conditional, 'Block').length, 2)
  assert.notStrictEqual(SyntaxTree.directNode(conditional, 'IdentifierExpression'), undefined)
  const statements = (block?.children ?? []).filter(SyntaxTree.isNode).map((node) => node.kind)
  assert.deepEqual(statements, ['ConditionalStatement', 'ReturnStatement'])
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)

  const booleans = parseText(
    'fixture://booleans.silk',
    'pub fn main() -> i32 { let flag = false return true }',
  )
  const boolFn = directFunctionDeclarations(booleans.root).at(0)
  const boolBlock = boolFn === undefined ? undefined : SyntaxTree.directNode(boolFn, 'Block')
  const binding =
    boolBlock === undefined ? undefined : SyntaxTree.directNode(boolBlock, 'BindingStatement')
  assert.notStrictEqual(
    binding === undefined ? undefined : SyntaxTree.directNode(binding, 'BooleanLiteralExpression'),
    undefined,
  )
  assert.deepEqual(booleans.parserDiagnostics, [])
})

it('parses a chain of three conditions as nested conditional statements', () => {
  const result = parseText(
    'fixture://else-if-chain.silk',
    'pub fn main() -> i32 { if first { return 1 } else if second { return 2 } else if third { return 3 } else { return 4 } return 0 }',
  )
  const fn = directFunctionDeclarations(result.root).at(0)
  const block = fn === undefined ? undefined : SyntaxTree.directNode(fn, 'Block')
  const outer =
    block === undefined ? undefined : SyntaxTree.directNode(block, 'ConditionalStatement')

  assert.notStrictEqual(outer, undefined)
  if (outer === undefined) return
  const statements = (block?.children ?? []).filter(SyntaxTree.isNode).map((node) => node.kind)
  assert.deepEqual(statements, ['ConditionalStatement', 'ReturnStatement'])

  // Each chained arm is the same node kind nested one level deeper, so no new
  // node kind carries the chain and the tree stays lossless.
  const middle = SyntaxTree.directNode(outer, 'ConditionalStatement')
  assert.notStrictEqual(middle, undefined)
  if (middle === undefined) return
  const inner = SyntaxTree.directNode(middle, 'ConditionalStatement')
  assert.notStrictEqual(inner, undefined)
  if (inner === undefined) return
  assert.strictEqual(SyntaxTree.directNode(inner, 'ConditionalStatement'), undefined)

  for (const conditional of [outer, middle, inner]) {
    assert.notStrictEqual(SyntaxTree.directToken(conditional, 'IfKeyword'), undefined)
    assert.notStrictEqual(SyntaxTree.directToken(conditional, 'ElseKeyword'), undefined)
    assert.notStrictEqual(SyntaxTree.directNode(conditional, 'IdentifierExpression'), undefined)
  }

  // A chained arm keeps only its taken block; the final arm keeps both blocks.
  assert.strictEqual(SyntaxTree.directNodes(outer, 'Block').length, 1)
  assert.strictEqual(SyntaxTree.directNodes(middle, 'Block').length, 1)
  assert.strictEqual(SyntaxTree.directNodes(inner, 'Block').length, 2)

  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('keeps an else arm that is not a chained if anchored to its brace', () => {
  const result = parseText(
    'fixture://else-not-if.silk',
    'pub fn main() -> i32 { if first { return 1 } else while second { } return 0 }',
  )

  assert.include(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    'PAR0001',
  )
  assertOriginalTokenTraversal(result)
})

it('recovers a missing condition before the arm brace', () => {
  const result = parseText(
    'fixture://missing-condition.silk',
    'pub fn main() -> i32 { if { return 1 } return 0 }',
  )

  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assertOriginalTokenTraversal(result)
})

it('recovers an arm missing its closing brace before the trailing return', () => {
  const result = parseText(
    'fixture://missing-arm-brace.silk',
    'pub fn main() -> i32 { if flag { return 1 return 0 }',
  )

  assert.strictEqual(
    result.parserDiagnostics.every((diagnostic) => diagnostic.code === 'PAR0001'),
    true,
  )
  assertOriginalTokenTraversal(result)
})

it('parses arithmetic and equality by the closed precedence table', () => {
  const source = 'pub fn main() -> bool { return 1 + 2 * 3 == 7 }'
  const result = parseText('memory/operators-precedence', source)
  const expressions = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'InfixExpression',
  )
  const [equality, addition, multiplication] = expressions

  assert.strictEqual(expressions.length, 3)
  assert.notStrictEqual(equality, undefined)
  assert.notStrictEqual(addition, undefined)
  assert.notStrictEqual(multiplication, undefined)
  if (equality === undefined || addition === undefined || multiplication === undefined) return
  assert.notStrictEqual(SyntaxTree.directToken(equality, 'EqualEqual'), undefined)
  assert.notStrictEqual(SyntaxTree.directToken(addition, 'Plus'), undefined)
  assert.notStrictEqual(SyntaxTree.directToken(multiplication, 'Star'), undefined)
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('reserves template element and fragment starts without consuming following syntax', () => {
  const source =
    'pub fn element() -> i32 { return <Button /> return 1 }\n' +
    'pub fn fragment() -> i32 { return <> return 2 }\n' +
    'pub fn after() -> i32 { return 3 }'
  const result = parseText('memory/reserved-template-starts', source)
  const declarations = directFunctionDeclarations(result.root)

  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      reason: diagnostic.reason,
    })),
    [
      { code: 'PAR0003', reason: { _tag: 'ReservedTemplateSyntax' } },
      { code: 'PAR0003', reason: { _tag: 'ReservedTemplateSyntax' } },
    ],
  )
  assert.strictEqual(declarations.length, 3)
  assert.deepEqual(
    declarations.map((declaration) => directTokenText(result, declaration, 'Identifier')),
    ['element', 'fragment', 'after'],
  )
  assert.deepEqual(missingLeaves(declarations.at(-1) ?? result.root), [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('preserves every relational operator after an existing left operand', () => {
  const source =
    'fn less() -> bool { return 1 < 2 }\n' +
    'fn lessEqual() -> bool { return 1 <= 2 }\n' +
    'fn greater() -> bool { return 2 > 1 }\n' +
    'fn greaterEqual() -> bool { return 2 >= 1 }'
  const result = parseText('memory/relational-reservation-boundary', source)
  const expressions = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'InfixExpression',
  )
  const relationalKinds: ReadonlyArray<Token.TokenKind> = [
    'Less',
    'LessEqual',
    'Greater',
    'GreaterEqual',
  ]

  assert.deepEqual(
    expressions.flatMap((expression) =>
      relationalKinds.filter((kind) => SyntaxTree.directToken(expression, kind) !== undefined),
    ),
    ['Less', 'LessEqual', 'Greater', 'GreaterEqual'],
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('parses grouping and right-associative prefix expressions losslessly', () => {
  const source = 'pub fn main(value: i32) -> i32 { return -(-(value + 1)) }'
  const result = parseText('memory/operator-prefix', source)
  const prefixes = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'PrefixExpression',
  )
  const groups = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'GroupedExpression',
  )

  assert.strictEqual(prefixes.length, 2)
  assert.strictEqual(groups.length, 2)
  assert.strictEqual(
    prefixes.every((node) => SyntaxTree.directToken(node, 'Minus') !== undefined),
    true,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses complete callable pipelines left-to-right', () => {
  const source =
    'import silk.i32\npub fn main() -> i32 { return 2 |> i32.add(3) |> i32.multiply(4) }\n' +
    'import silk.bool\npub fn flag() -> bool { return true |> bool.not }\n' +
    'import silk.effect { Effect }\npub fn recover() -> i32 { return risky() |> Effect.catchAll(handler) }'
  const result = parseText('memory/operator-pipelines', source)
  const pipelines = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'PipelineExpression',
  )
  const targets = pipelines.map((pipeline) =>
    pipeline.children
      .filter((element): element is SyntaxTree.Node => SyntaxTree.isNode(element))
      .at(1),
  )

  assert.strictEqual(pipelines.length, 4)
  assert.strictEqual(targets.length, 4)
  assert.deepEqual(
    targets.map((target) =>
      target === undefined ? 0 : SyntaxTree.directNodes(target, 'ArgumentList').length,
    ),
    [1, 1, 0, 1],
  )
  assert.deepEqual(
    targets.map((target) =>
      target === undefined ? 0 : SyntaxTree.directNodes(target, 'CallTypeArgumentList').length,
    ),
    [0, 0, 0, 0],
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('keeps applied owner arguments distinct in direct and pipeline operation forms', () => {
  const source = `pub fn direct(age: &Age) -> u32 {
  return Encodable<u32>.encode<bool>(age)
}
pub fn piped(age: &Age) -> u32 {
  return age |> Encodable<u32>.encode
}`
  const result = parseText('memory/applied-interface-operation', source)
  const appliedMembers = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'AppliedMemberExpression',
  )
  const ownerArguments = appliedMembers.flatMap((member) =>
    SyntaxTree.directNodes(member, 'AppliedMemberSelector').flatMap((selector) =>
      SyntaxTree.directNodes(selector, 'AppliedType').flatMap((owner) =>
        SyntaxTree.directNodes(owner, 'TypeArgumentList'),
      ),
    ),
  )
  const operationArguments = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CallTypeArgumentList',
  )

  assert.strictEqual(appliedMembers.length, 2)
  assert.strictEqual(ownerArguments.length, 2)
  assert.strictEqual(operationArguments.length, 1)
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('keeps a generic union member followed by relational less-than out of call parsing', () => {
  const source = `fn compare(value: Option<i32>) -> bool {
  return Option<i32>.None < value
}`
  const result = parseText('memory/applied-union-relational-less-than', source)
  const appliedMembers = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'AppliedMemberExpression',
  )
  const operationArguments = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CallTypeArgumentList',
  )
  const comparisons = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'InfixExpression',
  )

  assert.strictEqual(appliedMembers.length, 1)
  assert.strictEqual(operationArguments.length, 0)
  assert.strictEqual(comparisons.length, 1)
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers a missing applied operation name before the following statement', () => {
  const source = `pub fn broken(age: &Age) -> i32 {
  let value = Encodable<u32>.(&age)
  return 42
}`
  const result = parseText('memory/damaged-applied-interface-operation', source)
  const applied = descendants(result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'AppliedMemberExpression',
  )
  const followingReturn = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'ReturnStatement',
  )

  assert.notStrictEqual(applied, undefined)
  assert.isTrue(
    applied === undefined ||
      missingLeaves(applied).some(
        (element) => element._tag === 'MissingToken' && element.expected === 'Identifier',
      ),
  )
  assert.strictEqual(followingReturn.length, 1)
  assert.isTrue(result.parserDiagnostics.length > 0)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers a missing applied qualifier delimiter before the following statement', () => {
  const directSource = `pub fn broken(age: &Age) -> i32 {
  let value = Encodable<u32.encode(&age)
  return 42
}`
  const pipelineSource = `pub fn broken(age: &Age) -> i32 {
  let value = age |> Encodable<u32.encode
  return 42
}`
  for (const [name, source] of [
    ['direct', directSource],
    ['pipeline', pipelineSource],
  ] as const) {
    const result = parseText(`memory/damaged-applied-interface-delimiter-${name}`, source)
    const applied = descendants(result.root).find(
      (element): element is SyntaxTree.Node =>
        SyntaxTree.isNode(element) && element.kind === 'AppliedMemberExpression',
    )
    const followingReturn = descendants(result.root).filter(
      (element): element is SyntaxTree.Node =>
        SyntaxTree.isNode(element) && element.kind === 'ReturnStatement',
    )

    assert.notStrictEqual(applied, undefined)
    assert.isTrue(
      applied === undefined ||
        missingLeaves(applied).some(
          (element) => element._tag === 'MissingToken' && element.expected === 'Greater',
        ),
    )
    assert.strictEqual(followingReturn.length, 1)
    assert.isTrue(result.parserDiagnostics.length > 0)
    assertOriginalTokenTraversal(result)
    assert.deepEqual(reconstructedBytes(result), ascii(source))
  }
})

it('parses callable contracts with ordered parameters and all invocation modes', () => {
  const source =
    'fn use(shared: fn(i32, bool) -> i32, exclusive: mut fn(i32) -> bool, consuming: once fn() -> i32) -> i32 { return 0 }'
  const result = parseText('memory/callable-types', source)
  const callableTypes = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CallableType',
  )

  assert.strictEqual(callableTypes.length, 3)
  assert.deepEqual(
    callableTypes.map((type) => ({
      mut: SyntaxTree.directToken(type, 'MutKeyword') !== undefined,
      once: SyntaxTree.directToken(type, 'OnceKeyword') !== undefined,
      parameters: type.children.filter((element) => SyntaxTree.isNode(element)).length - 1,
    })),
    [
      { mut: false, once: false, parameters: 2 },
      { mut: true, once: false, parameters: 1 },
      { mut: false, once: true, parameters: 0 },
    ],
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('parses C function-pointer types as a distinct lossless type form', () => {
  const source = 'fn sort(compare: extern "C" fn(*const i32, *const i32) -> i32) {}'
  const result = parseText('memory/foreign-function-type', source)
  const type = descendants(result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'ForeignFunctionType',
  )

  assert.notStrictEqual(type, undefined)
  assert.strictEqual(
    type?.children.filter((element) => SyntaxTree.isNode(element) && element.kind === 'PointerType')
      .length,
    2,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('retains unsupported and missing callback ABIs inside the foreign type form', () => {
  const source = 'fn use(first: extern "system" fn(i32) -> i32, second: extern fn(i32) -> i32) {}'
  const result = parseText('memory/foreign-function-type-recovery', source)
  assert.strictEqual(
    descendants(result.root).filter(
      (element) => SyntaxTree.isNode(element) && element.kind === 'ForeignFunctionType',
    ).length,
    2,
  )
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses reusable, exclusive, and take-capable Effect access bounds', () => {
  const source =
    'fn use(shared: Effect<i32>, exclusive: mut Effect<i32>, any: once Effect<i32>) -> i32 { return 0 }'
  const result = parseText('memory/effect-access-bounds', source)
  const effects = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'AppliedType',
  )

  assert.deepEqual(
    effects.map((effect) => ({
      mut: SyntaxTree.directToken(effect, 'MutKeyword') !== undefined,
      once: SyntaxTree.directToken(effect, 'OnceKeyword') !== undefined,
    })),
    [
      { mut: false, once: false },
      { mut: true, once: false },
      { mut: false, once: true },
    ],
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('recovers every callable type boundary without crossing the next declaration', () => {
  const cases = [
    ['mut (i32) -> i32', 'FnKeyword'],
    ['once fn i32) -> i32', 'LeftParenthesis'],
    ['fn(i32 -> i32', 'RightParenthesis'],
    ['fn(i32) i32', 'Arrow'],
    ['fn(i32) ->', 'Identifier'],
  ] as const

  for (const [damaged, expected] of cases) {
    const source = `fn damaged(callback: ${damaged}) -> i32 { return 0 } fn after() -> i32 { return 1 }`
    const result = parseText(`memory/callable-recovery-${expected}`, source)
    const first = directFunctionDeclarations(result.root).at(0)
    const second = directFunctionDeclarations(result.root).at(1)
    assert.notStrictEqual(first, undefined)
    assert.notStrictEqual(second, undefined)
    assert.strictEqual(
      first === undefined ? false : missingLeaves(first).some((leaf) => leaf.expected === expected),
      true,
    )
    assert.strictEqual(
      second === undefined ? undefined : SyntaxTree.isAvailableSyntax(second),
      true,
    )
    assertOriginalTokenTraversal(result)
  }
})

it('parses repeated postfix application over every callable-producing expression', () => {
  const source = `import silk.i32
fn use(operation: fn(i32) -> i32, value: i32) -> i32 {
  let bound = i32.add(2)
  let named = operation(value)
  let qualified = i32.add(2)(value)
  let grouped = (operation)(value)
  return choose(true)(value)
}`
  const result = parseText('memory/postfix-callables', source)
  const calls = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CallExpression',
  )

  assert.strictEqual(calls.length, 7)
  assert.strictEqual(
    calls.some((call) => SyntaxTree.directNode(call, 'CallExpression') !== undefined),
    true,
  )
  assert.strictEqual(
    calls.some((call) => SyntaxTree.directNode(call, 'GroupedExpression') !== undefined),
    true,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('gives pipelines a complete callable expression and run the complete following expression', () => {
  const source = `import silk.effect { Effect }
fn use(attempt: Effect<i32>, operation: fn(i32) -> i32) -> i32 {
  let a = 1 |> operation
  let b = 2 |> (operation)
  let c = 3 |> choose(true)
  let d = run attempt |> Effect.retry(2)
  let e = (run attempt) |> operation
  return run run nested
}`
  const result = parseText('memory/callable-pipe-run', source)
  const bindings = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'BindingStatement',
  )
  const d = bindings.at(3)
  const e = bindings.at(4)
  const dRun = d === undefined ? undefined : SyntaxTree.directNode(d, 'RunExpression')
  const ePipeline = e === undefined ? undefined : SyntaxTree.directNode(e, 'PipelineExpression')

  assert.notStrictEqual(dRun, undefined)
  assert.notStrictEqual(
    dRun === undefined ? undefined : SyntaxTree.directNode(dRun, 'PipelineExpression'),
    undefined,
  )
  assert.notStrictEqual(ePipeline, undefined)
  assert.notStrictEqual(
    ePipeline === undefined ? undefined : SyntaxTree.directNode(ePipeline, 'GroupedExpression'),
    undefined,
  )
  assert.strictEqual(
    descendants(result.root).filter(
      (element) => SyntaxTree.isNode(element) && element.kind === 'RunExpression',
    ).length,
    4,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('bounds run at commas, delimiters, blocks, and following statements', () => {
  const source = `fn comma(first: Effect<i32>, second: i32) -> i32 { return pair(run first, second) }
fn delimiter(first: Effect<i32>) -> i32 { return (run first) }
fn block(first: Effect<i32>) -> i32 { if true { return run first } return 0 }
fn statement(first: Effect<i32>) -> i32 { let value = run first return value }`
  const result = parseText('memory/run-boundaries', source)

  assert.strictEqual(directFunctionDeclarations(result.root).length, 4)
  assert.strictEqual(
    descendants(result.root).filter(
      (element) => SyntaxTree.isNode(element) && element.kind === 'RunExpression',
    ).length,
    4,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
})

it('bounds operator recovery at expression and declaration boundaries', () => {
  const source =
    'pub fn missingOperand() -> i32 { return 1 + }\n' +
    'pub fn missingGroup() -> i32 { return (1 + 2 }\n' +
    'pub fn chained() -> bool { return 1 < 2 < 3 }\n' +
    'pub fn after() -> i32 { return 4 }'
  const result = parseText('memory/operator-recovery', source)
  const declarations = directFunctionDeclarations(result.root)
  const after = declarations.at(-1)

  assert.strictEqual(declarations.length, 4)
  assert.strictEqual(
    missingLeaves(result.root).some((leaf) => leaf.expected === 'DecimalInteger'),
    true,
  )
  assert.strictEqual(
    missingLeaves(result.root).some((leaf) => leaf.expected === 'RightParenthesis'),
    true,
  )
  assert.strictEqual(errorNodes(result.root).length > 0, true)
  assert.notStrictEqual(after, undefined)
  if (after === undefined) return
  assert.strictEqual(directTokenText(result, after, 'Identifier'), 'after')
  assert.deepEqual(missingLeaves(after), [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses nominal struct declarations and qualified field types losslessly', () => {
  const source = validStructSource
  const result = parseText('memory/structs', source)
  const structs = SyntaxTree.directNodes(result.root, 'StructDeclaration')
  const fields = structs.flatMap((struct) => SyntaxTree.directNodes(struct, 'StructField'))

  assert.strictEqual(structs.length, 2)
  assert.strictEqual(fields.length, 2)
  assert.deepEqual(
    fields.map((field) =>
      SyntaxTree.directNode(field, 'TypePath')
        ?.children.filter(SyntaxTree.isToken)
        .map((token) => token.kind),
    ),
    [
      ['Whitespace', 'Identifier'],
      ['Whitespace', 'Identifier', 'Dot', 'Identifier'],
    ],
  )
  assert.notStrictEqual(
    SyntaxTree.directToken(structs.at(0) ?? result.root, 'PubKeyword'),
    undefined,
  )
  assert.strictEqual(SyntaxTree.directNodes(structs.at(1) ?? result.root, 'StructField').length, 0)
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses enums with implicit and explicitly represented integer members losslessly', () => {
  const source = `enum AssertionResult {
  Pass,
  Fail,
  Skip,
}
pub enum(u8) ExitCode {
  Success = 0,
  Failure = 1,
}`
  const result = parseText('memory/enums', source)
  const enums = SyntaxTree.directNodes(result.root, 'EnumDeclaration')
  const implicit = enums.at(0) ?? result.root
  const represented = enums.at(1) ?? result.root
  const implicitMembers = SyntaxTree.directNodes(implicit, 'EnumMember')
  const representedMembers = SyntaxTree.directNodes(represented, 'EnumMember')
  const representation = SyntaxTree.directNode(represented, 'TypePath')

  assert.strictEqual(enums.length, 2)
  assert.deepEqual(
    implicitMembers.map((member) => directTokenText(result, member, 'Identifier')),
    ['Pass', 'Fail', 'Skip'],
  )
  assert.strictEqual(SyntaxTree.directNode(implicit, 'TypePath'), undefined)
  assert.strictEqual(
    representation === undefined
      ? undefined
      : directTokenText(result, representation, 'Identifier'),
    'u8',
  )
  assert.deepEqual(
    representedMembers.map((member) => {
      const discriminant = SyntaxTree.directNode(member, 'IntegerLiteralExpression')
      return discriminant === undefined
        ? undefined
        : directTokenText(result, discriminant, 'DecimalInteger')
    }),
    ['0', '1'],
  )
  assert.notStrictEqual(SyntaxTree.directToken(represented, 'PubKeyword'), undefined)
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses generic nominal unions, applied constructors, and patterns losslessly', () => {
  const source = `pub union Result<A, E> {
  Success { pub value: A },
  Failure { pub error: E },
}
pub fn inspect(result: Result<i32, bool>) -> i32 {
  let fallback = Result<i32, bool>.Failure { error: true }
  return match move result {
    Result<i32, bool>.Success { value } => value
    Result<i32, bool>.Failure { error: _ } => 0
  }
}`
  const result = parseText('memory/nominal-union', source)
  const declaration = SyntaxTree.directNode(result.root, 'UnionDeclaration')
  const variants =
    declaration === undefined ? [] : SyntaxTree.directNodes(declaration, 'UnionVariant')
  const fields = variants.flatMap((variant) => SyntaxTree.directNodes(variant, 'UnionVariantField'))
  const constructors = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'AppliedMemberExpression',
  )
  const patterns = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'UnionVariantPattern',
  )

  assert.strictEqual(variants.length, 2)
  assert.strictEqual(fields.length, 2)
  assert.strictEqual(constructors.length, 1)
  assert.strictEqual(patterns.length, 2)
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('accepts empty field blocks and recovers at sibling variants and declarations', () => {
  const source =
    'union Broken { Empty {}, Good, Bad { value: }, Last { value: i32 } } pub fn after() -> i32 { return 1 }'
  const result = parseText('memory/damaged-nominal-union', source)
  const declaration = SyntaxTree.directNode(result.root, 'UnionDeclaration')
  const variants =
    declaration === undefined ? [] : SyntaxTree.directNodes(declaration, 'UnionVariant')

  assert.deepEqual(
    variants.map((variant) => directTokenText(result, variant, 'Identifier')),
    ['Empty', 'Good', 'Bad', 'Last'],
  )
  assert.deepEqual(missingLeaves(variants[0] ?? result.root), [])
  assert.strictEqual(missingLeaves(variants[2] ?? result.root).length > 0, true)
  assert.deepEqual(missingLeaves(variants[1] ?? result.root), [])
  assert.deepEqual(missingLeaves(variants[3] ?? result.root), [])
  assert.notStrictEqual(SyntaxTree.directNode(result.root, 'FunctionDeclaration'), undefined)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses an empty union variant field block as a braced variant with no fields', () => {
  const source = 'pub union U { Empty {}, A { x: i32 } }'
  const result = parseText('memory/empty-union-variant-fields', source)
  const declaration = SyntaxTree.directNode(result.root, 'UnionDeclaration')
  const variants =
    declaration === undefined ? [] : SyntaxTree.directNodes(declaration, 'UnionVariant')

  assert.deepEqual(
    variants.map((variant) => SyntaxTree.directNodes(variant, 'UnionVariantField').length),
    [0, 1],
  )
  assert.deepEqual(
    variants.map((variant) => SyntaxTree.directToken(variant, 'LeftBrace') !== undefined),
    [true, true],
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assert.deepEqual(missingLeaves(declaration ?? result.root), [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers damaged enum members before the following declaration', () => {
  const source = 'enum Broken { Pass Fail = } pub fn after() -> i32 { return 1 }'
  const result = parseText('memory/damaged-enum', source)
  const declaration = SyntaxTree.directNode(result.root, 'EnumDeclaration')
  const after = SyntaxTree.directNode(result.root, 'FunctionDeclaration')

  assert.deepEqual(
    missingLeaves(declaration ?? result.root).map((leaf) => leaf.expected),
    ['Comma', 'DecimalInteger'],
  )
  assert.notStrictEqual(after, undefined)
  assert.deepEqual(after === undefined ? [] : missingLeaves(after), [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('keeps damaged struct fields and following declarations separate', () => {
  const source = damagedStructSource
  const result = parseText('memory/damaged-structs', source)
  const structs = SyntaxTree.directNodes(result.root, 'StructDeclaration')
  const after = SyntaxTree.directNode(result.root, 'FunctionDeclaration')

  assert.strictEqual(structs.length, 2)
  assert.notStrictEqual(after, undefined)
  assert.deepEqual(
    missingLeaves(structs.at(0) ?? result.root).map((leaf) => leaf.expected),
    ['Identifier', 'Identifier'],
  )
  assert.deepEqual(
    missingLeaves(structs.at(1) ?? result.root).map((leaf) => leaf.expected),
    ['RightBrace'],
  )
  assert.deepEqual(after === undefined ? [] : missingLeaves(after), [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses mode-aware match expressions and nested patterns losslessly', () => {
  const source = `pub struct Span { start: i32 end: i32 }
pub struct Token { kind: i32 span: Span }
pub struct End {}
pub fn inspect(event: Token | End) -> i32 {
  let code = match move event {
    Token { kind, span: Span { start: offset, .. } } if true => offset
    End {} => 0
  }
  return code
}`
  const result = parseText('memory/match-expression', source)
  const match = descendants(result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'MatchExpression',
  )

  assert.notStrictEqual(match, undefined)
  if (match === undefined) return
  assert.strictEqual(SyntaxTree.directNodes(match, 'MatchAccess').length, 1)
  assert.strictEqual(SyntaxTree.directNodes(match, 'MatchArm').length, 2)
  assert.strictEqual(
    descendants(match).filter(
      (element) => SyntaxTree.isNode(element) && element.kind === 'NominalPattern',
    ).length,
    3,
  )
  assert.strictEqual(
    descendants(match).some(
      (element) => SyntaxTree.isNode(element) && element.kind === 'RestPattern',
    ),
    true,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses ordinary arm statements without an implicit return losslessly', () => {
  let condition = 'true'
  for (let depth = 0; depth < 3; depth += 1)
    condition = `match 0 { _ => { u u if ${condition} {} } }`
  const source = `pub fn inspect(value: i32) -> i32 {
  invoke(first(), match value {
    0 => { // empty
    }
    1 => { let next = 2 let u = () u u if true { drop next } while false { break } }
    _ => { return match value { _ => 3 } }
  }, later())
  return 0
}
fn nested() -> () { let u = () if ${condition} {} }`
  const result = parseText('memory/match-arm-blocks', source)
  const arms = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'MatchArm',
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assert.strictEqual(
    arms.filter((arm) => SyntaxTree.directNode(arm, 'Block') !== undefined).length,
    6,
  )
  const empty = SyntaxTree.directNode(arms.at(0) ?? result.root, 'Block') ?? result.root
  assert.strictEqual(empty.children.filter(SyntaxTree.isNode).length, 0)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('retains damaged patterns explicitly in every pattern position', () => {
  const sources = [
    `pub fn inspect(value: i32) -> i32 {
  return match value { [ => 0 }
}`,
    `pub fn inspect(value: i32) -> i32 {
  let [ = value
  return 0
}`,
    `pub fn inspect(value: i32) -> i32 {
  if let [ = value { return 1 }
  return 0
}`,
  ]

  for (const [ordinal, source] of sources.entries()) {
    const result = parseText(`memory/damaged-pattern-${ordinal}`, source)
    assert.strictEqual(
      descendants(result.root).filter(
        (element) => SyntaxTree.isNode(element) && element.kind === 'ErrorPattern',
      ).length,
      1,
    )
    assert.deepEqual(
      result.parserDiagnostics.map((diagnostic) => diagnostic.code),
      ['PAR0002'],
    )
    assertOriginalTokenTraversal(result)
    assert.deepEqual(reconstructedBytes(result), ascii(source))
  }
})

it('parses bare, shared, and exclusive matches in expression positions', () => {
  const source = `import silk.i32
pub struct Token { kind: i32 }
pub fn bare(event: Token) -> i32 { return match event { Token { kind } => kind } }
pub fn shared(event: Token) -> i32 { return i32.add(match &event { Token { kind } => kind }, 1) }
pub fn exclusive(event: Token) -> i32 { let value = match &mut event { _ => 0 } return value }`
  const result = parseText('memory/match-modes', source)
  const matches = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'MatchExpression',
  )

  assert.strictEqual(matches.length, 3)
  assert.deepEqual(
    matches.map((match) =>
      SyntaxTree.directNode(match, 'MatchAccess')
        ?.children.filter(SyntaxTree.isToken)
        .map((token) => token.kind),
    ),
    [[], ['Whitespace', 'Ampersand'], ['Whitespace', 'Ampersand', 'MutKeyword']],
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('reuses the pattern tree for let and if-let statements', () => {
  const source = `pub struct Point { x: i32 y: i32 }
pub fn inspect(value: Point | i32) -> i32 {
  let Point { x, y } = move value
  if let i32 number = value { return number } else { return x }
}`
  const result = parseText('memory/statement-patterns', source)

  assert.strictEqual(
    descendants(result.root).filter(
      (element) => SyntaxTree.isNode(element) && element.kind === 'PatternBindingStatement',
    ).length,
    1,
  )
  assert.strictEqual(
    descendants(result.root).filter(
      (element) => SyntaxTree.isNode(element) && element.kind === 'PatternConditionalStatement',
    ).length,
    1,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('keeps a missing match arm arrow local to its arm', () => {
  const source = `pub struct Token { kind: i32 }
pub struct End {}
pub fn inspect(event: Token | End) -> i32 {
  return match event {
    Token { kind } kind
    End {} => 0
  }
}`
  const result = parseText('memory/damaged-match-arm', source)
  const match = descendants(result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'MatchExpression',
  )

  assert.notStrictEqual(match, undefined)
  if (match === undefined) return
  assert.strictEqual(SyntaxTree.directNodes(match, 'MatchArm').length, 2)
  assert.deepEqual(
    missingLeaves(match).map((leaf) => leaf.expected),
    ['FatArrow'],
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('bounds damaged pattern fields, nesting, braces, and guards at their arm', () => {
  const cases: ReadonlyArray<readonly [string, string, Token.TokenKind, string?]> = [
    [
      'missing-arm-before-nested-guard',
      'Token { .. } => { drop 1',
      'RightBrace',
      'End {} if match 0 { _ => true } => 0',
    ],
    ['missing-arm-block-brace', 'Token { .. } => { drop 1', 'RightBrace'],
    ['missing-pattern-name', '{ kind } => 1', 'Identifier'],
    ['missing-binding-name', 'Token { kind: , .. } => 1', 'Identifier'],
    ['missing-field-comma', 'Token { kind other } => 1', 'Comma'],
    ['missing-nested-colon', 'Token { child Inner {}, .. } => 1', 'Colon'],
    ['missing-pattern-brace', 'Token { kind, .. if true => 1', 'RightBrace'],
    ['missing-guard-expression', 'Token { kind, .. } if => 1', 'Identifier'],
  ]

  for (const [name, damagedArm, expected, followingArm] of cases) {
    const source = `pub struct Inner {}
pub struct Token { kind: i32 other: i32 child: Inner }
pub struct End {}
pub fn inspect(event: Token | End) -> i32 {
  return match event {
    ${damagedArm}
    ${followingArm ?? 'End {} => 0'}
  }
}
pub fn after() -> i32 { return 2 }`
    const result = parseText(`memory/${name}`, source)
    const match = descendants(result.root).find(
      (element): element is SyntaxTree.Node =>
        SyntaxTree.isNode(element) && element.kind === 'MatchExpression',
    )
    const after = directFunctionDeclarations(result.root).at(-1)

    assert.notStrictEqual(match, undefined, name)
    assert.notStrictEqual(after, undefined, name)
    if (match === undefined || after === undefined) continue
    assert.strictEqual(
      missingLeaves(match).some((leaf) => leaf.expected === expected),
      true,
      name,
    )
    assert.strictEqual(SyntaxTree.directNodes(match, 'MatchArm').length, 2, name)
    assert.deepEqual(missingLeaves(after), [], name)
    assertOriginalTokenTraversal(result)
    assert.deepEqual(reconstructedBytes(result), ascii(source), name)
  }
})

it('parses row difference and callable constraints as contextual syntax', () => {
  const source = `effect fn bind<?S, A, P, E, ?R>(
  self: once Effect<A ! E ? R>,
  provider: &mut P
) -> A ! E ? Without<R, S>
where &mut P provides S from R, &P provides S from R, P provides S from R, S in R {
  return run self
}

fn keywords(where: i32, provides: i32, from: i32, in: i32) -> i32 {
  return where + provides + from + in
}`
  const result = parseText('memory/row-constraints', source)
  const kinds = descendants(result.root).flatMap((element) =>
    SyntaxTree.isNode(element) ? [element.kind] : [],
  )

  assert.deepEqual(result.parserDiagnostics, [])
  assert.strictEqual(kinds.filter((kind) => kind === 'RowWithout').length, 1)
  assert.strictEqual(kinds.filter((kind) => kind === 'WhereClause').length, 1)
  assert.strictEqual(kinds.filter((kind) => kind === 'ProviderConstraint').length, 3)
  assert.strictEqual(kinds.filter((kind) => kind === 'MembershipConstraint').length, 1)
  assert.strictEqual(directFunctionDeclarations(result.root).length, 2)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses nested failure and requirement differences with union operands', () => {
  const source = `effect fn transform<S, P, A, E, ?R>(
  self: once Effect<A ! E ? R>,
  provider: &mut P
) -> Effect<A ! Without<E, First | Third> ? Without<R, S>>
where First | Third in E, &mut P provides S from R {
  return self
}`
  const result = parseText('memory/nested-row-constraints', source)
  const kinds = descendants(result.root).flatMap((element) =>
    SyntaxTree.isNode(element) ? [element.kind] : [],
  )

  assert.deepEqual(result.parserDiagnostics, [])
  assert.strictEqual(kinds.filter((kind) => kind === 'RowWithout').length, 2)
  assert.strictEqual(kinds.filter((kind) => kind === 'UnionType').length, 2)
  assert.strictEqual(kinds.filter((kind) => kind === 'ProviderConstraint').length, 1)
  assert.strictEqual(kinds.filter((kind) => kind === 'MembershipConstraint').length, 1)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('bounds a missing provider source at its constraint', () => {
  const source = `effect fn broken<?S, A, P, E, ?R>(
  self: once Effect<A ! E ? R>,
  provider: &mut P
) -> A ! E ? Without<R, S>
where &mut P provides S, S in R {
  return run self
}

fn after() -> i32 { return 1 }`
  const result = parseText('memory/malformed-row-constraint', source)
  const declarations = directFunctionDeclarations(result.root)
  const constraints = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) &&
      (element.kind === 'ProviderConstraint' || element.kind === 'MembershipConstraint'),
  )

  assert.strictEqual(declarations.length, 2)
  assert.deepEqual(
    constraints.map((constraint) => constraint.kind),
    ['ProviderConstraint', 'MembershipConstraint'],
  )
  assert.isTrue(missingLeaves(constraints.at(0) ?? result.root).length > 0)
  assert.deepEqual(missingLeaves(declarations.at(1) ?? result.root), [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('distinguishes tuple and contextual record source forms', () => {
  const source = `tuple Point(i32, i32)
fn use(point: Point) -> i32 {
  let positional = (1, 2)
  let singleton = (1,)
  let record = .{ name: "Silk", count: 2 }
  return point.0
}`
  const result = parseText('memory/aggregate-syntax', source)
  const kinds = descendants(result.root).flatMap((element) =>
    SyntaxTree.isNode(element) ? [element.kind] : [],
  )

  assert.deepEqual(result.parserDiagnostics, [])
  assert.include(kinds, 'TupleDeclaration')
  assert.strictEqual(kinds.filter((kind) => kind === 'TupleLiteralExpression').length, 2)
  assert.include(kinds, 'ContextualRecordLiteralExpression')
  assert.include(kinds, 'OrdinalProjectionExpression')
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('bounds damaged contextual records before following declarations', () => {
  const source = `fn broken() -> i32 {
  let value = .{ first 1, second: 2 }
  return 0
}
fn after() -> i32 { return 1 }`
  const result = parseText('memory/damaged-contextual-record', source)
  const declarations = directFunctionDeclarations(result.root)
  const records = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'ContextualRecordLiteralExpression',
  )

  assert.strictEqual(declarations.length, 2)
  assert.strictEqual(records.length, 1)
  assert.isTrue(missingLeaves(records.at(0) ?? result.root).length > 0)
  assert.deepEqual(missingLeaves(declarations.at(1) ?? result.root), [])
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('bounds damaged tuple and record forms before following syntax', () => {
  const fixtures = [
    `tuple (i32, i32)
fn after() -> i32 { return 1 }`,
    `tuple Broken(i32, , bool)
fn after() -> i32 { return 1 }`,
    `tuple Broken(i32, bool
fn after() -> i32 { return 1 }`,
    `fn broken() -> i32 { return missing(
tuple Kept(i32)
fn after() -> i32 { return 1 }`,
    `fn broken() -> i32 {
  let value = (1, , 2)
  return 0
}
fn after() -> i32 { return 1 }`,
    `fn broken() -> i32 {
  let value = (name: 1, age: 2)
  return 0
}
fn after() -> i32 { return 1 }`,
    `fn broken() -> i32 {
  let value = .{ : 1, age: 2 }
  return 0
}
fn after() -> i32 { return 1 }`,
    `fn broken() -> i32 {
  let value = .{ name:, age: 2 }
  return 0
}
fn after() -> i32 { return 1 }`,
  ]

  for (const [ordinal, source] of fixtures.entries()) {
    const result = parseText(`memory/damaged-aggregate-${ordinal}`, source)
    const declarations = directFunctionDeclarations(result.root)
    const following = declarations.at(-1)
    assert.isTrue(result.parserDiagnostics.length > 0, `fixture ${ordinal}`)
    assert.strictEqual(
      following === undefined ? undefined : missingLeaves(following).length,
      0,
      `fixture ${ordinal}`,
    )
    if (source.includes('tuple Kept')) {
      const tuples = result.root.children.filter(
        (element): element is SyntaxTree.Node =>
          SyntaxTree.isNode(element) && element.kind === 'TupleDeclaration',
      )
      assert.strictEqual(tuples.length, 1, `fixture ${ordinal}`)
      assert.deepEqual(missingLeaves(tuples.at(0) ?? result.root), [], `fixture ${ordinal}`)
    }
    assertOriginalTokenTraversal(result)
    assert.deepEqual(reconstructedBytes(result), ascii(source))
  }
})

it('parses every initial static form losslessly without treating compileError as a call', () => {
  const source = `static fn parse(value: string) -> string { return value }
pub static fn render(static template: string, value: string) -> () {
  let static parsed = template
  static if true {
    compileError(parsed)
  } else {
    compileError("fallback")
  }
}`
  const result = parseText('memory/static-forms', source)
  const declarations = directFunctionDeclarations(result.root)
  const elements = descendants(result.root)
  const compileErrors = elements.filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CompileErrorExpression',
  )

  assert.deepEqual(result.parserDiagnostics, [])
  assert.strictEqual(declarations.length, 2)
  assert.strictEqual(
    SyntaxTree.directToken(declarations.at(0) ?? result.root, 'StaticKeyword')?.kind,
    'StaticKeyword',
  )
  assert.strictEqual(
    SyntaxTree.directToken(declarations.at(1) ?? result.root, 'PubKeyword')?.kind,
    'PubKeyword',
  )
  assert.strictEqual(
    elements.filter(
      (element) => SyntaxTree.isNode(element) && element.kind === 'StaticConditionalStatement',
    ).length,
    1,
  )
  assert.strictEqual(compileErrors.length, 2)
  assert.isTrue(
    compileErrors.every((expression) => expression.children.filter(SyntaxTree.isNode).length === 1),
  )
  assert.isFalse(
    elements.some((element) => SyntaxTree.isNode(element) && element.kind === 'CallExpression'),
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses static iteration losslessly with contextual in and complete spans', () => {
  const source = `fn render() -> () {
  static // phase boundary
  for field // current descriptor
  in Reflect.fields<Args>() {
    display(field)
  }
}`
  const result = parseText('memory/static-for', source)
  const iteration = descendants(result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'StaticForStatement',
  )
  assert.notStrictEqual(iteration, undefined)
  if (iteration === undefined) return

  const directTokens = iteration.children.filter(SyntaxTree.isToken)
  const identifiers = directTokens.filter((token) => token.kind === 'Identifier')
  assert.deepEqual(result.parserDiagnostics, [])
  assert.deepEqual(
    directTokens
      .filter(
        (token) =>
          token.kind !== 'Whitespace' &&
          token.kind !== 'LineComment' &&
          token.kind !== 'DocComment' &&
          token.kind !== 'ModuleDocComment',
      )
      .map((token) => token.kind),
    ['StaticKeyword', 'ForKeyword', 'Identifier', 'Identifier'],
  )
  assert.deepEqual(
    identifiers.map((token) =>
      Array.from(Option.getOrThrow(SourceFile.slice(result.source, token.span)), (byte) =>
        String.fromCharCode(byte),
      ).join(''),
    ),
    ['field', 'in'],
  )
  assert.deepEqual(
    iteration.children.filter(SyntaxTree.isNode).map((node) => node.kind),
    ['CallExpression', 'Block'],
  )
  const staticOffset = source.indexOf('static')
  const forOffset = source.indexOf('for', staticOffset)
  const staticSpan = SyntaxTree.directToken(iteration, 'StaticKeyword')?.span
  const forSpan = SyntaxTree.directToken(iteration, 'ForKeyword')?.span
  assert.strictEqual(staticSpan?.sourceId, result.source.id)
  assert.strictEqual(staticSpan?.start, staticOffset)
  assert.strictEqual(staticSpan?.end, staticOffset + 'static'.length)
  assert.strictEqual(forSpan?.sourceId, result.source.id)
  assert.strictEqual(forSpan?.start, forOffset)
  assert.strictEqual(forSpan?.end, forOffset + 'for'.length)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers damaged static iterations without consuming following statements', () => {
  const fixtures = [
    'static for in fields { display(1) }',
    'static for field fields { display(field) }',
    'static for field in { display(field) }',
    'static for field in fields',
  ]

  for (const [ordinal, damaged] of fixtures.entries()) {
    const source = `fn broken() -> i32 {
  ${damaged}
  return 7
}`
    const result = parseText(`memory/static-for-recovery-${ordinal}`, source)
    const declaration = directFunctionDeclarations(result.root).at(0) ?? result.root
    const body = SyntaxTree.directNode(declaration, 'Block') ?? declaration
    const statements = body.children.filter(SyntaxTree.isNode)
    const iteration = statements.find((statement) => statement.kind === 'StaticForStatement')
    const following = statements.find((statement) => statement.kind === 'ReturnStatement')

    assert.isTrue(result.parserDiagnostics.length > 0, `fixture ${ordinal}`)
    assert.notStrictEqual(iteration, undefined, `fixture ${ordinal}`)
    assert.notStrictEqual(following, undefined, `fixture ${ordinal}`)
    assert.isTrue(missingLeaves(iteration ?? result.root).length > 0, `fixture ${ordinal}`)
    if (ordinal === 3) {
      assert.deepEqual(
        missingLeaves(iteration ?? result.root).map((missing) => missing.expected),
        ['LeftBrace', 'RightBrace'],
      )
    }
    assert.deepEqual(missingLeaves(following ?? result.root), [], `fixture ${ordinal}`)
    assertOriginalTokenTraversal(result)
    assert.deepEqual(reconstructedBytes(result), ascii(source), `fixture ${ordinal}`)
  }
})

it('bounds a missing static-iteration closing brace before the following declaration', () => {
  const source = `fn broken() -> () {
  static for field in fields {
    display(field)
fn kept() -> i32 { return 1 }`
  const result = parseText('memory/static-for-missing-close', source)
  const declarations = directFunctionDeclarations(result.root)
  const kept = declarations.at(-1)
  const iteration = descendants(declarations.at(0) ?? result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'StaticForStatement',
  )

  assert.isTrue(result.parserDiagnostics.length > 0)
  assert.strictEqual(declarations.length, 2)
  assert.isTrue(
    missingLeaves(iteration ?? result.root).some((missing) => missing.expected === 'RightBrace'),
  )
  assert.deepEqual(missingLeaves(kept ?? result.root), [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('rejects unsupported static modifier combinations and compileError arities', () => {
  const fixtures = [
    'static unsafe fn bad() -> () {}',
    'static effect fn bad() -> () {}',
    'static impl Thing for Other {}',
    'static service Bad {}',
    'fn bad(static mut value: i32) -> () {}',
    'fn bad(mut static value: i32) -> () {}',
    'fn bad() -> () { let static mut value = 1 }',
    'fn bad() -> () { let mut static value = 1 }',
    'fn bad() -> () { compileError() }',
    'fn bad() -> () { compileError("bad",) }',
    'fn bad() -> () { compileError("bad", "extra") }',
  ]

  for (const [ordinal, source] of fixtures.entries()) {
    const result = parseText(`memory/static-rejection-${ordinal}`, source)
    assert.isTrue(result.parserDiagnostics.length > 0, `fixture ${ordinal}`)
    assertOriginalTokenTraversal(result)
    assert.deepEqual(reconstructedBytes(result), ascii(source), `fixture ${ordinal}`)
  }
})

it('keeps rejected top-level static iteration bounded before following declarations', () => {
  const fixtures = [
    `pub static if true {
  fn hidden() -> () {}
}`,
    `static for field in fields {
  use(field)
}`,
  ]

  for (const [ordinal, rejected] of fixtures.entries()) {
    const source = `${rejected}
fn kept() -> i32 { return 1 }`
    const result = parseText(`memory/static-declaration-rejection-${ordinal}`, source)
    const declarations = directFunctionDeclarations(result.root)
    const rootErrors = result.root.children.filter(
      (element): element is SyntaxTree.Node =>
        SyntaxTree.isNode(element) && element.kind === 'Error',
    )

    assert.isTrue(result.parserDiagnostics.length > 0)
    assert.strictEqual(rootErrors.length, 1)
    assert.strictEqual(declarations.length, 1)
    assert.deepEqual(missingLeaves(declarations.at(0) ?? result.root), [])
    assert.isFalse(
      descendants(result.root).some(
        (element) =>
          SyntaxTree.isNode(element) &&
          (element.kind === 'StaticConditionalStatement' || element.kind === 'StaticForStatement'),
      ),
    )
    assertOriginalTokenTraversal(result)
    assert.deepEqual(reconstructedBytes(result), ascii(source))
  }
})

it('parses module selection groups and selective publication without losing inactive syntax', () => {
  const source = `static if choose() {
  pub import platform.first { original as selected }
  static if true { pub const answer: i32 = 42 }
} else static if false {
  pub extern "C" fn selected() -> i32
} else {
  import missing.module
  pub fn selected() -> i32 { return 7 }
}
fn kept() -> () {}`
  const result = parseText('selection', source)
  assert.deepEqual(result.parserDiagnostics, [])
  assert.strictEqual(SyntaxTree.directNodes(result.root, 'StaticConditionalDeclaration').length, 1)
  assert.strictEqual(
    descendants(result.root).filter(
      (node) => SyntaxTree.isNode(node) && node.kind === 'DeclarationGroup',
    ).length,
    4,
  )
  assert.strictEqual(directFunctionDeclarations(result.root).length, 1)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('retains malformed declarations in both module selection arms and rejects public namespaces', () => {
  for (const source of [
    'static if true { const broken: = 1 } else { fn good() -> () {} }',
    'static if false { fn good() -> () {} } else { const broken: = 1 }',
    'pub import platform',
  ]) {
    const result = parseText('selection_recovery', source)
    assert.isTrue(result.parserDiagnostics.length > 0)
    assertOriginalTokenTraversal(result)
    assert.deepEqual(reconstructedBytes(result), ascii(source))
  }
})

it('keeps compileError dedicated and non-shadowable in value declarations', () => {
  const source = 'fn invalid() -> () { let value = compileError }'
  const result = parseText('memory/compile-error-value', source)
  const elements = descendants(result.root)
  const bindingSource = 'fn invalid() -> () { let compileError = 1 }'
  const binding = parseText('memory/compile-error-binding', bindingSource)

  assert.isTrue(result.parserDiagnostics.length > 0)
  assert.isTrue(binding.parserDiagnostics.length > 0)
  assert.isTrue(
    elements.some(
      (element) => SyntaxTree.isNode(element) && element.kind === 'CompileErrorExpression',
    ),
  )
  assert.isFalse(
    elements.some(
      (element) =>
        SyntaxTree.isNode(element) &&
        element.kind === 'IdentifierExpression' &&
        SyntaxTree.directToken(element, 'CompileErrorKeyword') !== undefined,
    ),
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
  assertOriginalTokenTraversal(binding)
  assert.deepEqual(reconstructedBytes(binding), ascii(bindingSource))
})

it('parses type alias declarations losslessly', () => {
  const source = `pub type FetchError = HttpError | JsonError
type PointF32 = Point<f32>
pub fn after() -> i32 { return 1 }`
  const result = parseText('memory/type-alias', source)
  const declarations = SyntaxTree.directNodes(result.root, 'TypeAliasDeclaration')
  const [unionAlias, appliedAlias] = declarations
  const union =
    unionAlias === undefined ? undefined : SyntaxTree.directNode(unionAlias, 'UnionType')

  assert.strictEqual(declarations.length, 2)
  assert.notStrictEqual(union, undefined)
  assert.strictEqual(union === undefined ? 0 : SyntaxTree.directNodes(union, 'TypePath').length, 2)
  assert.notStrictEqual(
    appliedAlias === undefined ? undefined : SyntaxTree.directNode(appliedAlias, 'AppliedType'),
    undefined,
  )
  assert.notStrictEqual(SyntaxTree.directNode(result.root, 'FunctionDeclaration'), undefined)
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers a type alias without a target at the next declaration', () => {
  const source = 'type Broken = struct Next {}'
  const result = parseText('memory/damaged-type-alias', source)
  const declaration = SyntaxTree.directNode(result.root, 'TypeAliasDeclaration')

  assert.notStrictEqual(declaration, undefined)
  assert.strictEqual(missingLeaves(declaration ?? result.root).length > 0, true)
  assert.notStrictEqual(SyntaxTree.directNode(result.root, 'StructDeclaration'), undefined)
  assert.notStrictEqual(result.parserDiagnostics.length, 0)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('retains a type alias parameter list for semantic rejection', () => {
  const source = 'type Pair<T> = Point<T>'
  const result = parseText('memory/parameterized-type-alias', source)
  const declaration = SyntaxTree.directNode(result.root, 'TypeAliasDeclaration')

  assert.notStrictEqual(
    declaration === undefined ? undefined : SyntaxTree.directNode(declaration, 'TypeParameterList'),
    undefined,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

const significantShape = (node: SyntaxTree.Node): ReadonlyArray<string> =>
  node.children.flatMap((child) => {
    if (SyntaxTree.isNode(child)) return [`{${child.kind}}`]
    if (SyntaxTree.isToken(child)) return child.kind === 'Whitespace' ? [] : [child.kind]
    return [`Missing(${child.expected})`]
  })

it('parses a public C-layout struct on the existing struct node losslessly', () => {
  const source = 'pub extern "C" struct Timespec { seconds: i64 }'
  const result = parseText('memory/c-layout-struct', source)
  const declaration = SyntaxTree.directNode(result.root, 'StructDeclaration')

  assert.notStrictEqual(declaration, undefined)
  assert.deepEqual(significantShape(declaration ?? result.root), [
    'PubKeyword',
    'ExternKeyword',
    'TextLiteral',
    'StructKeyword',
    'Identifier',
    'LeftBrace',
    '{StructField}',
    'RightBrace',
  ])
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers a C-layout struct without an ABI literal inside its declaration', () => {
  const source = 'extern struct Broken { value: i32 }\npub struct Next {}'
  const result = parseText('memory/c-layout-struct-missing-abi', source)
  const [damaged, next] = SyntaxTree.directNodes(result.root, 'StructDeclaration')

  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assert.deepEqual(
    missingLeaves(damaged ?? result.root).map((missing) => missing.expected),
    ['TextLiteral'],
  )
  assert.strictEqual(SyntaxTree.directNodes(damaged ?? result.root, 'StructField').length, 1)
  assert.notStrictEqual(next, undefined)
  assert.strictEqual(SyntaxTree.isAvailableSyntax(next ?? result.root), true)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses a renamed public foreign function declaration losslessly', () => {
  const source = 'pub unsafe extern "C" fn cAbs(value: i32) -> i32 as "abs"'
  const result = parseText('memory/foreign-function', source)
  const declaration = SyntaxTree.directNode(result.root, 'ForeignFunctionDeclaration')

  assert.notStrictEqual(declaration, undefined)
  assert.deepEqual(significantShape(declaration ?? result.root), [
    'PubKeyword',
    'UnsafeKeyword',
    'ExternKeyword',
    'TextLiteral',
    'FnKeyword',
    'Identifier',
    '{ParameterList}',
    '{ReturnType}',
    'AsKeyword',
    'TextLiteral',
  ])
  assert.strictEqual(
    declaration === undefined
      ? 0
      : SyntaxTree.directNodes(
          SyntaxTree.directNode(declaration, 'ParameterList') ?? declaration,
          'ParameterDeclaration',
        ).length,
    1,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses imported and exported C data symbols losslessly', () => {
  const source =
    'unsafe extern "C" static environment: *mut *mut u8 as "environ"\n' +
    'export "C" static answer: i32 as "silk_answer" = 42'
  const result = parseText('memory/foreign-statics', source)
  const imported = SyntaxTree.directNode(result.root, 'ForeignStaticDeclaration')
  const exported = SyntaxTree.directNode(result.root, 'ExportStaticDeclaration')

  assert.notStrictEqual(imported, undefined)
  assert.notStrictEqual(exported, undefined)
  assert.deepEqual(significantShape(imported ?? result.root), [
    'UnsafeKeyword',
    'ExternKeyword',
    'TextLiteral',
    'StaticKeyword',
    'Identifier',
    'Colon',
    '{PointerType}',
    'AsKeyword',
    'TextLiteral',
  ])
  assert.deepEqual(significantShape(exported ?? result.root), [
    'ExportKeyword',
    'TextLiteral',
    'StaticKeyword',
    'Identifier',
    'Colon',
    '{TypePath}',
    'AsKeyword',
    'TextLiteral',
    'Equals',
    '{IntegerLiteralExpression}',
  ])
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('retains a foreign function body for semantic rejection', () => {
  const source = 'unsafe extern "C" fn f() -> i32 { return 1 }'
  const result = parseText('memory/foreign-function-body', source)
  const declaration = SyntaxTree.directNode(result.root, 'ForeignFunctionDeclaration')

  assert.notStrictEqual(
    declaration === undefined ? undefined : SyntaxTree.directNode(declaration, 'Block'),
    undefined,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers a foreign function without an ABI literal inside the declaration', () => {
  const source = 'unsafe extern fn f() -> i32\nfn next() -> i32 { return 1 }'
  const result = parseText('memory/foreign-function-missing-abi', source)
  const declaration = SyntaxTree.directNode(result.root, 'ForeignFunctionDeclaration')
  const next = SyntaxTree.directNode(result.root, 'FunctionDeclaration')

  assert.notStrictEqual(declaration, undefined)
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  assert.deepEqual(
    missingLeaves(declaration ?? result.root).map((missing) => missing.expected),
    ['TextLiteral'],
  )
  assert.notStrictEqual(next, undefined)
  assert.strictEqual(SyntaxTree.isAvailableSyntax(next ?? result.root), true)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('fixes the foreign modifier order and retains rejected modifiers', () => {
  const source =
    'pub static unsafe extern "C" effect fn g<T>(value: T) -> i32 ! Problem as "g"\n' +
    'extern "C" unsafe fn h() -> i32'
  const result = parseText('memory/foreign-function-modifiers', source)
  const [ordered, disordered] = SyntaxTree.directNodes(result.root, 'ForeignFunctionDeclaration')

  assert.deepEqual(significantShape(ordered ?? result.root), [
    'PubKeyword',
    'StaticKeyword',
    'UnsafeKeyword',
    'ExternKeyword',
    'TextLiteral',
    'EffectKeyword',
    'FnKeyword',
    'Identifier',
    '{TypeParameterList}',
    '{ParameterList}',
    '{ReturnType}',
    '{FailureRow}',
    'AsKeyword',
    'TextLiteral',
  ])
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0002'],
  )
  assert.strictEqual(errorNodes(disordered ?? result.root).length, 1)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('parses a renamed public exported function declaration losslessly', () => {
  const source =
    'pub export "C" fn double(value: i32) -> i32 as "silk_test_double_v1" { return value * 2 }'
  const result = parseText('memory/exported-function', source)
  const declaration = SyntaxTree.directNode(result.root, 'FunctionDeclaration')

  assert.notStrictEqual(declaration, undefined)
  assert.deepEqual(significantShape(declaration ?? result.root), [
    'PubKeyword',
    'ExportKeyword',
    'TextLiteral',
    'FnKeyword',
    'Identifier',
    '{ParameterList}',
    '{ReturnType}',
    'AsKeyword',
    'TextLiteral',
    '{Block}',
  ])
  assert.strictEqual(
    declaration === undefined
      ? 0
      : SyntaxTree.directNodes(
          SyntaxTree.directNode(declaration, 'ParameterList') ?? declaration,
          'ParameterDeclaration',
        ).length,
    1,
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers an exported function without a body at the next declaration', () => {
  const source = 'export "C" fn f() -> i32\nfn next() -> i32 { return 1 }'
  const result = parseText('memory/exported-function-missing-body', source)
  const [exported, next] = SyntaxTree.directNodes(result.root, 'FunctionDeclaration')

  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0001'],
  )
  const [diagnostic] = result.parserDiagnostics
  assert.strictEqual(
    diagnostic !== undefined &&
      exported !== undefined &&
      next !== undefined &&
      diagnostic.span.start >= exported.span.start &&
      diagnostic.span.end <= exported.span.end &&
      diagnostic.span.end <= next.span.start,
    true,
  )
  assert.deepEqual(
    missingLeaves(exported ?? result.root).map((missing) => missing.expected),
    ['LeftBrace'],
  )
  assert.notStrictEqual(next, undefined)
  assert.strictEqual(SyntaxTree.isAvailableSyntax(next ?? result.root), true)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('fixes the export modifier order and retains rejected modifiers', () => {
  const source =
    'pub static unsafe export "C" effect fn g<T>(value: T) -> i32 ! Problem as "g" { return 1 }\n' +
    'export "C" unsafe fn h() -> i32 { return 1 }'
  const result = parseText('memory/exported-function-modifiers', source)
  const [ordered, disordered] = SyntaxTree.directNodes(result.root, 'FunctionDeclaration')

  assert.deepEqual(significantShape(ordered ?? result.root), [
    'PubKeyword',
    'StaticKeyword',
    'UnsafeKeyword',
    'ExportKeyword',
    'TextLiteral',
    'EffectKeyword',
    'FnKeyword',
    'Identifier',
    '{TypeParameterList}',
    '{ParameterList}',
    '{ReturnType}',
    '{FailureRow}',
    'AsKeyword',
    'TextLiteral',
    '{Block}',
  ])
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0002'],
  )
  assert.strictEqual(errorNodes(disordered ?? result.root).length, 1)
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

const pointerTypes = (node: SyntaxTree.Node): ReadonlyArray<SyntaxTree.Node> =>
  descendants(node).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'PointerType',
  )

it('parses pointer types in parameter, return, field, and generic-argument positions', () => {
  const source = `struct Cursor { position: *mut u8 }
fn pointers(cursor: *mut *const u8, count: *const i32) -> *const u8 {
  return identity<*const i32>(count)
}`
  const result = parseText('memory://pointer-types.silk', source)
  const pointers = pointerTypes(result.root)

  assert.strictEqual(pointers.length, 6)
  const field = SyntaxTree.directNode(result.root, 'StructDeclaration')
  assert.strictEqual(
    SyntaxTree.directNode(
      SyntaxTree.directNode(field ?? result.root, 'StructField') ?? result.root,
      'PointerType',
    )?.kind,
    'PointerType',
  )
  const outer = pointers[1] ?? result.root
  const inner = SyntaxTree.directNode(outer, 'PointerType') ?? result.root
  assert.deepEqual(
    [outer, inner].map((pointer) => [
      SyntaxTree.directToken(pointer, 'Star')?.kind,
      SyntaxTree.directToken(pointer, 'MutKeyword')?.kind,
      SyntaxTree.directToken(pointer, 'ConstKeyword')?.kind,
      SyntaxTree.directNode(pointer, 'TypePath')?.kind,
    ]),
    [
      ['Star', 'MutKeyword', undefined, undefined],
      ['Star', undefined, 'ConstKeyword', 'TypePath'],
    ],
  )
  const returnType = descendants(result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'ReturnType',
  )
  assert.strictEqual(
    SyntaxTree.directNode(returnType ?? result.root, 'PointerType')?.kind,
    'PointerType',
  )
  const typeArguments = descendants(result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'CallTypeArgumentList',
  )
  assert.strictEqual(
    SyntaxTree.directNode(typeArguments ?? result.root, 'PointerType')?.kind,
    'PointerType',
  )
  assert.deepEqual(result.parserDiagnostics, [])
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers a bare star pointer type by inserting the missing mutability', () => {
  const source = 'fn bare(value: *u8) -> i32 { return 0 }'
  const result = parseText('memory://bare-pointer.silk', source)
  const pointer = pointerTypes(result.root)[0] ?? result.root

  assert.strictEqual(pointer.kind, 'PointerType')
  assert.deepEqual(
    missingLeaves(pointer).map((leaf) => leaf.expected),
    ['ConstKeyword'],
  )
  assert.strictEqual(SyntaxTree.directNode(pointer, 'TypePath')?.kind, 'TypePath')
  assert.deepEqual(
    diagnosticView(result).map((diagnostic) => [diagnostic.code, diagnostic.reason]),
    [['PAR0001', { _tag: 'MissingToken', expected: 'ConstKeyword' }]],
  )
  assertOriginalTokenTraversal(result)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('keeps a comparison against a star in expression position unchanged', () => {
  const result = parseText(
    'memory://star-comparison.silk',
    'fn compare(a: i32, b: i32) -> bool { return a < *b }',
  )
  const infix = descendants(result.root).find(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'InfixExpression',
  )

  assert.strictEqual(SyntaxTree.directToken(infix ?? result.root, 'Less')?.kind, 'Less')
  assert.deepEqual(pointerTypes(result.root), [])
  assert.deepEqual(
    result.parserDiagnostics.map((diagnostic) => diagnostic.code),
    ['PAR0002'],
  )
  assertOriginalTokenTraversal(result)
})

it('parses inherent impl declarations losslessly beside conformances', () => {
  const source = `pub union Option<T> { None, Some { pub value: T } }
impl<T> Option<T> {
  pub fn none() -> Self { return Option<T>.None }
  pub fn some(value: T) -> Self { return Option.Some { value: move value } }
  fn map<U>(self: Self, transform: once fn(T) -> U) -> Option<U> { return Option<U>.None }
  pub static fn arity() -> i32 { return 2 }
  pub unsafe fn raw(self: &Self) -> i32 { return 0 }
}
impl Counter { }
impl<T> Display for Option<T> { fn display(value: &Self) -> i32 { return 0 } }
fn main() -> i32 { return 42 }`
  const result = parseText('memory://inherent-impl.silk', source)
  assert.deepEqual(result.parserDiagnostics, [])
  const impls = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'ImplDeclaration',
  )
  assert.strictEqual(impls.length, 3)
  const [inherent, empty, conformance] = impls
  assert.isDefined(inherent)
  assert.isDefined(empty)
  assert.isDefined(conformance)
  const forTokens = (node: SyntaxTree.Node | undefined): number =>
    node === undefined
      ? -1
      : SyntaxTree.tokens(node).filter((token) => token.kind === 'ForKeyword').length
  assert.strictEqual(forTokens(inherent), 0)
  assert.strictEqual(forTokens(empty), 0)
  assert.strictEqual(forTokens(conformance), 1)
  const memberKinds = (inherent?.children ?? []).filter(SyntaxTree.isNode).map((node) => node.kind)
  assert.deepEqual(memberKinds, [
    'TypeParameterList',
    'AppliedType',
    'FunctionDeclaration',
    'FunctionDeclaration',
    'FunctionDeclaration',
    'FunctionDeclaration',
    'FunctionDeclaration',
  ])
  assert.deepEqual(reconstructedBytes(result), result.source.bytes)
})

it('recovers inside a malformed inherent impl and keeps parsing the next declaration', () => {
  const unclosed = `impl Counter {
  pub fn value(self: &Self) -> i32 { return 1
}
fn main() -> i32 { return 42 }`
  const unclosedResult = parseText('memory://inherent-unclosed.silk', unclosed)
  assert.notDeepEqual(unclosedResult.parserDiagnostics, [])
  assert.deepEqual(reconstructedBytes(unclosedResult), unclosedResult.source.bytes)
  const binders = `impl<T, Option<T> { fn none() -> Self { return Option<T>.None } }
fn main() -> i32 { return 42 }`
  const bindersResult = parseText('memory://inherent-binders.silk', binders)
  assert.notDeepEqual(bindersResult.parserDiagnostics, [])
  const kinds = descendants(bindersResult.root)
    .filter(SyntaxTree.isNode)
    .map((node) => node.kind)
  assert.include(kinds, 'ImplDeclaration')
  const mainDeclarations = bindersResult.root.children.filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'FunctionDeclaration',
  )
  assert.strictEqual(mainDeclarations.length, 1)
  assert.deepEqual(reconstructedBytes(bindersResult), bindersResult.source.bytes)
})

it('parses package schemas with optional defaults and ordinary validation expressions', () => {
  const source = `pub param enabled: bool = choose()
pub param workers: u32 where workers > 0
param internal: string = "fixed" where internal == "fixed"
static fn choose() -> bool { return true }`
  const syntax = parseText('config', source)
  assert.deepEqual(syntax.parserDiagnostics, [])
  const parameters = syntax.root.children.filter(
    (node): node is SyntaxTree.Node =>
      SyntaxTree.isNode(node) && node.kind === 'PackageParameterDeclaration',
  )
  assert.strictEqual(parameters.length, 3)
  assert.deepEqual(
    parameters.map((node) => SyntaxTree.directToken(node, 'Equals') !== undefined),
    [true, false, true],
  )
  assert.deepEqual(
    parameters.map(
      (node) => SyntaxTree.directNode(node, 'PackageParameterValidation') !== undefined,
    ),
    [false, true, true],
  )
})

it('parses contextual test function qualifiers losslessly through selected branches', () => {
  const source = `test fn plain() {}
pub test effect fn effectful() -> () ! i32 { fail 1 }
static if true { test fn selected() {} } else { test fn inactive() {} }
fn test() {}
fn use(test: i32) -> i32 { return test }`
  const result = parseText('memory://test-qualifier.silk', source)
  assert.deepEqual(result.parserDiagnostics, [])
  const declarations = descendants(result.root).filter(
    (element): element is SyntaxTree.Node =>
      SyntaxTree.isNode(element) && element.kind === 'FunctionDeclaration',
  )
  const names = declarations.map((declaration) => {
    const tokens = declaration.children.filter(SyntaxTree.isToken)
    const fn = tokens.findIndex((token) => token.kind === 'FnKeyword')
    const name = tokens
      .slice(fn + 1)
      .find((token) => token.kind === 'Identifier' || token.kind === 'DropKeyword')
    return name === undefined
      ? undefined
      : Option.getOrUndefined(SourceFile.spelling(result.source, name.span))
  })
  assert.deepEqual(names, ['plain', 'effectful', 'selected', 'inactive', 'test', 'use'])
  assert.deepEqual(
    declarations.map((declaration) =>
      declaration.children.some(
        (element) =>
          SyntaxTree.isToken(element) &&
          element.kind === 'Identifier' &&
          Option.contains(SourceFile.spelling(result.source, element.span), 'test') &&
          element.span.start <
            (SyntaxTree.directToken(declaration, 'FnKeyword')?.span.start ?? element.span.start),
      ),
    ),
    [true, true, true, true, false, false],
  )
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})

it('recovers a damaged test declaration without consuming the next function', () => {
  const source = 'test fn broken( -> () {}\nfn next() {}'
  const result = parseText('memory://damaged-test-qualifier.silk', source)
  assert.isNotEmpty(result.parserDiagnostics)
  assert.strictEqual(directFunctionDeclarations(result.root).length, 2)
  assert.deepEqual(reconstructedBytes(result), ascii(source))
})
