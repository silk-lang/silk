import { records } from './support/records.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Mir from '../src/Mir.js'
import * as MirLinearization from '../src/MirLinearization.js'
import * as MirVerification from '../src/MirVerification.js'
import * as NativeFunction from '../src/NativeFunction.js'
import * as Tir from '../src/Tir.js'
import * as Lexer from '../src/Lexer.js'
import * as Match from '../src/Match.js'
import * as OwnershipEncoding from '../src/OwnershipEncoding.js'
import * as Parser from '../src/Parser.js'
import * as StatementAnalysis from '../src/StatementAnalysis.js'
import * as SemanticContext from '../src/SemanticContext.js'
import * as SourceFile from '../src/SourceFile.js'
import * as Type from '../src/Type.js'
import { elaborate, ownership, type Elaborated } from './support/elaborate.js'
import { raise } from './support/raise.js'

const parse = (id: string, source: string) =>
  Parser.parse(Lexer.lex(SourceFile.make(id, new TextEncoder().encode(source))))

const analyze = (id: string, source: string): Elaborated => elaborate(parse(id, source))

/** The elaboration's own span source: presentation spans of the authored module it consumed. */
const spansOf = (result: Elaborated): SemanticContext.SemanticContext =>
  SemanticContext.make(result.authored)

const returnedMatch = (result: Elaborated): Extract<Tir.Expression, { readonly _tag: 'Match' }> => {
  const returned = result.functions.at(0)?.returnedExpression
  if (returned?._tag === 'Match') return returned
  const fn = result.tir.functions.at(0)
  const retained =
    fn === undefined
      ? undefined
      : Tir.nodesOf(fn).find(
          (node): node is Tir.PublishedNode & Extract<Tir.Expression, { readonly _tag: 'Match' }> =>
            '_tag' in node && node._tag === 'Match',
        )
  return retained ?? raise('expected returned match fact')
}

const statementTree = (statements: ReadonlyArray<Tir.Statement>): ReadonlyArray<Tir.Statement> => {
  const visited = new Set<Tir.Statement>()
  const visitStatements = (body: ReadonlyArray<Tir.Statement>): ReadonlyArray<Tir.Statement> =>
    body.flatMap((statement): ReadonlyArray<Tir.Statement> => {
      if (visited.has(statement)) return []
      visited.add(statement)
      const expressionStatements = Tir.statementExpressions(statement).flatMap((expression) =>
        Tir.expressionTree(expression).flatMap((nested): ReadonlyArray<Tir.Statement> =>
          nested._tag === 'Match'
            ? nested.arms.flatMap((arm) =>
                arm.body._tag === 'Block' ? visitStatements(arm.body.statements) : [],
              )
            : [],
        ),
      )
      if (statement._tag === 'Unsafe') return [statement, ...visitStatements(statement.statements)]
      if (statement._tag === 'If' || statement._tag === 'IfLet')
        return [
          statement,
          ...expressionStatements,
          ...visitStatements(statement.taken),
          ...visitStatements(statement.otherwise),
        ]
      if (statement._tag === 'While')
        return [statement, ...expressionStatements, ...visitStatements(statement.body)]
      return [statement, ...expressionStatements]
    })
  return visitStatements(statements)
}

it('publishes guarded source-order coverage, narrowed bindings, and acyclic TIR', () => {
  const result = analyze(
    'main',
    `pub struct Token { kind: i32 }
pub struct End {}
pub fn inspect(event: Token | End) -> i32 {
  return match &event {
    Token { kind } if false => kind
    Token { kind: fallback } => fallback
    End {} => 0
  }
}`,
  )
  const match = returnedMatch(result)

  assert.deepEqual(result.diagnostics, [])
  assert.strictEqual(match.access, 'Shared')
  assert.deepEqual(match.members.map(Match.encodeIdentity), ['main.End', 'main.Token'])
  assert.deepEqual(
    match.arms.map((arm) => ({
      member: arm.member === undefined ? '_' : Match.encodeIdentity(arm.member),
      before: arm.before.map(Match.encodeIdentity),
      after: arm.after.map(Match.encodeIdentity),
      reachable: arm.reachable,
    })),
    [
      {
        member: 'main.Token',
        before: ['main.End', 'main.Token'],
        after: ['main.End', 'main.Token'],
        reachable: true,
      },
      {
        member: 'main.Token',
        before: ['main.End', 'main.Token'],
        after: ['main.End'],
        reachable: true,
      },
      { member: 'main.End', before: ['main.End'], after: [], reachable: true },
    ],
  )
  assert.strictEqual(Type.encode(match.type), 'i32')
  assert.strictEqual(match.arms[0]?.bindings[0]?.name, 'kind')
  const body = match.arms[1]?.body
  assert.strictEqual(body?._tag, 'Expression')
  if (body?._tag === 'Expression') {
    assert.strictEqual(body.expression._tag, 'PatternBindingReference')
  }
  const tir = result.tir.functions.at(0)?.statements.at(-1)
  assert.strictEqual(tir?._tag, 'Return')
  if (tir?._tag !== 'Return') return
  assert.strictEqual(tir.expression._tag, 'Match')
  assert.strictEqual(
    Tir.expressionTree(tir.expression).filter((item) => item._tag === 'Match').length,
    1,
  )
  assert.include(Tir.encode(result.tir), 'match shared members=main.End,main.Token : i32')
})

it('covers scalar enums by canonical member identity without payload bindings', () => {
  const result = analyze(
    'enum-coverage',
    `enum Status { Unknown, Ready }
fn inspect(value: Status) -> i32 {
  return match value {
    Status.Unknown if false => 9
    Status.Unknown => 0
    Status.Ready => 1
  }
}`,
  )
  const match = returnedMatch(result)

  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(match.members.map(Match.encodeIdentity), [
    'enum-coverage.Status.Unknown',
    'enum-coverage.Status.Ready',
  ])
  assert.deepEqual(
    match.arms.map((arm) => ({
      pattern: arm.member?._tag,
      bindings: arm.bindings.length,
      before: arm.before.map(Match.encodeIdentity),
      after: arm.after.map(Match.encodeIdentity),
      reachable: arm.reachable,
    })),
    [
      {
        pattern: 'EnumMember',
        bindings: 0,
        before: ['enum-coverage.Status.Unknown', 'enum-coverage.Status.Ready'],
        after: ['enum-coverage.Status.Unknown', 'enum-coverage.Status.Ready'],
        reachable: true,
      },
      {
        pattern: 'EnumMember',
        bindings: 0,
        before: ['enum-coverage.Status.Unknown', 'enum-coverage.Status.Ready'],
        after: ['enum-coverage.Status.Ready'],
        reachable: true,
      },
      {
        pattern: 'EnumMember',
        bindings: 0,
        before: ['enum-coverage.Status.Ready'],
        after: [],
        reachable: true,
      },
    ],
  )
  assert.strictEqual(Type.encode(match.type), 'i32')
  if (match.scrutinee._tag !== 'Unavailable')
    assert.strictEqual(Type.encode(match.scrutinee.type), 'enum-coverage.Status')
  const returned = result.tir.functions.at(0)?.statements.at(-1)
  assert.strictEqual(returned?._tag, 'Return')
  if (returned?._tag !== 'Return' || returned.expression._tag !== 'Match') return
  assert.strictEqual(returned.expression.arms[0]?.member?._tag, 'EnumMember')
  assert.deepEqual(Tir.verify(result.tir), [])
  assert.include(
    Tir.encode(result.tir),
    'match copy members=enum-coverage.Status.Unknown,enum-coverage.Status.Ready : i32',
  )
})

it('reports scalar enum coverage diagnostics with stable codes and exact spans', () => {
  const missingSource = `enum Status { Unknown, Ready }
fn inspect(value: Status) -> i32 {
  return match value { Status.Unknown if false => 0 Status.Ready => 1 }
}`
  const missing = analyze('enum-missing', missingSource)
  assert.deepEqual(
    missing.diagnostics.map((diagnostic) => ({ code: diagnostic.code, reason: diagnostic.reason })),
    [
      {
        code: 'SEM0158',
        reason: {
          _tag: 'IncompleteEnumMatch',
          enum: 'enum-missing.Status',
          missing: ['enum-missing.Status.Unknown'],
        },
      },
    ],
  )
  const missingMatchStart = missingSource.indexOf('match value')
  const functionEnd = missingSource.lastIndexOf('}')
  const missingMatchEnd = missingSource.lastIndexOf('}', functionEnd - 1) + 1
  assert.deepEqual(
    missing.diagnostics.map((diagnostic) => [diagnostic.span.start, diagnostic.span.end]),
    [[missingMatchStart, missingMatchEnd]],
  )

  const duplicateSource = `enum Status { Unknown, Ready }
fn inspect(value: Status) -> i32 {
  return match value { Status.Unknown => 0 Status.Unknown => 1 Status.Ready => 2 }
}`
  const duplicate = analyze('enum-duplicate', duplicateSource)
  const firstMember = duplicateSource.indexOf('Status.Unknown')
  const secondMember = duplicateSource.indexOf('Status.Unknown', firstMember + 1)
  assert.deepEqual(
    duplicate.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      span: [diagnostic.span.start, diagnostic.span.end],
      related: diagnostic.relatedSpans?.map((related) => [related.span.start, related.span.end]),
    })),
    [
      {
        code: 'SEM0159',
        span: [secondMember, secondMember + 'Status.Unknown'.length],
        related: [[firstMember, firstMember + 'Status.Unknown'.length]],
      },
    ],
  )

  const wildcardSource = `enum Status { Unknown, Ready }
fn inspect(value: Status) -> i32 {
  return match value { _ => 0 Status.Ready => 1 }
}`
  const wildcard = analyze('enum-wildcard', wildcardSource)
  const wildcardStart = wildcardSource.indexOf('_ => 0')
  const laterArm = wildcardSource.indexOf('Status.Ready')
  assert.deepEqual(
    wildcard.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      span: [diagnostic.span.start, diagnostic.span.end],
      related: diagnostic.relatedSpans?.map((related) => [related.span.start, related.span.end]),
    })),
    [
      {
        code: 'SEM0160',
        span: [laterArm, laterArm + 'Status.Ready => 1'.length],
        related: [[wildcardStart, wildcardStart + '_ => 0'.length]],
      },
    ],
  )

  const invalidSource = `enum Status { Ready }
enum Other { Ready }
fn foreign(value: Status) -> i32 { return match value { Other.Ready => 0 _ => 1 } }
fn integer(value: Status) -> i32 { return match value { 0 => 0 _ => 1 } }`
  const invalid = analyze('enum-invalid-patterns', invalidSource)
  const foreignStart = invalidSource.indexOf('Other.Ready')
  const integerStart = invalidSource.indexOf('0 => 0')
  assert.deepEqual(
    invalid.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      span: [diagnostic.span.start, diagnostic.span.end],
    })),
    [
      { code: 'SEM0161', span: [foreignStart, foreignStart + 'Other.Ready'.length] },
      { code: 'SEM0162', span: [integerStart, integerStart + 1] },
    ],
  )
})

it('diagnoses incomplete, unreachable, foreign-member, guard, field, and result failures', () => {
  const incomplete = analyze(
    'incomplete',
    `pub struct Token { kind: i32 other: i32 }
pub struct End {}
pub struct Other {}
pub fn inspect(event: Token | End) -> i32 {
  return match event {
    Token { kind } if 1 => kind
    Other {} => 0
  }
}`,
  )
  assert.deepEqual(
    incomplete.diagnostics.map((diagnostic) => diagnostic.code),
    ['SEM0044', 'SEM0046', 'SEM0045', 'SEM0042'],
  )
  assert.strictEqual(incomplete.functions.at(0)?.returnedExpression._tag, 'Match')

  const unreachable = analyze(
    'unreachable',
    `pub struct Token {}
pub fn inspect(event: Token) -> i32 {
  return match event { _ => 0 Token {} => 1 }
}`,
  )
  assert.deepEqual(
    unreachable.diagnostics.map((diagnostic) => diagnostic.code),
    ['SEM0043'],
  )
  assert.strictEqual(unreachable.functions.at(0)?.returnedExpression._tag, 'Match')

  const incompatible = analyze(
    'incompatible',
    `pub struct Token {}
pub struct End {}
pub fn inspect(event: Token | End) -> i32 {
  return match event { Token {} => 0 End {} => false }
}`,
  )
  assert.deepEqual(
    incompatible.diagnostics.map((diagnostic) => diagnostic.code),
    ['SEM0040'],
  )
  assert.strictEqual(incompatible.functions.at(0)?.returnedExpression._tag, 'Unavailable')
})

it('retains nested canonical field paths and rejects pattern binding conflicts', () => {
  const result = analyze(
    'nested',
    `pub struct Span { start: i32 end: i32 }
pub struct Token { span: Span }
pub fn inspect(event: Token, offset: i32) -> i32 {
  return match event { Token { span: Span { start: offset, .. } } => offset }
}`,
  )
  assert.include(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    'SEM0048',
  )
  assert.strictEqual(result.functions.at(0)?.returnedExpression._tag, 'Match')
})

it('joins nominal arm results and records explicit MatchArm widening in TIR', () => {
  const result = analyze(
    'joining',
    `pub struct Left {}
pub struct Right {}
pub struct HasLeft { value: Left }
pub struct HasRight { value: Right }
pub fn select(input: HasLeft | HasRight) -> Left | Right {
  return match move input {
    HasLeft { value } => value
    HasRight { value } => value
  }
}`,
  )
  const match = returnedMatch(result)
  const returned = result.tir.functions.at(0)?.statements.at(-1)

  assert.deepEqual(result.diagnostics, [])
  assert.strictEqual(Type.encode(match.type), 'joining.Left | joining.Right')
  assert.strictEqual(returned?._tag, 'Return')
  if (returned?._tag !== 'Return' || returned.expression._tag !== 'Match') return
  assert.deepEqual(
    returned.expression.arms.map((arm) =>
      arm.body._tag === 'Expression' && arm.body.expression._tag === 'UnionConvert'
        ? { context: arm.body.expression.context, target: Type.encode(arm.body.expression.target) }
        : arm.body._tag,
    ),
    [
      { context: 'MatchArm', target: 'joining.Left | joining.Right' },
      { context: 'MatchArm', target: 'joining.Left | joining.Right' },
    ],
  )
  assert.deepEqual(Tir.verify(result.tir), [])
  const fn = result.tir.functions.at(0) ?? raise('expected joining TIR function')
  const reversedMatch = Object.freeze({
    ...returned.expression,
    arms: Object.freeze([...returned.expression.arms].reverse()),
  })
  const invalidModule: Tir.Module = Object.freeze({
    ...result.tir,
    functions: Object.freeze([
      Object.freeze({
        ...fn,
        statements: Object.freeze([Object.freeze({ ...returned, expression: reversedMatch })]),
      }),
    ]),
  })
  assert.include(
    Tir.verify(invalidModule).map((issue) => issue._tag),
    'InvalidMatchArmOrder',
  )
})

it('selects exact non-nominal members with whole-value bindings', () => {
  const result = analyze(
    'ordinary-members',
    `pub fn inspect(value: i32 | string) -> i32 {
  return match value {
    i32 number => number
    string text => 0
  }
}`,
  )
  const match = returnedMatch(result)

  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(match.members.map(Match.encodeIdentity), ['i32', "string<'life0>"])
  assert.deepEqual(
    match.arms.map((arm) => (arm.member === undefined ? '_' : Match.encodeIdentity(arm.member))),
    ['i32', "string<'life0>"],
  )
  assert.deepEqual(
    match.arms.map((arm) =>
      arm.bindings[0] === undefined ? 'unavailable' : Type.encode(arm.bindings[0].type),
    ),
    ['i32', "string<'life0>"],
  )
})

it('rejects refutable let and wildcard discard while accepting scoped if-let bindings', () => {
  const result = analyze(
    'statement-pattern-diagnostics',
    `pub struct Point { x: i32 y: i32 }
pub fn inspect(value: Point | i32) -> i32 {
  let Point { x, .. } = move value
  let _ = x
  if let i32 number = value { return number } else { return 0 }
}`,
  )

  assert.include(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    'SEM0133',
  )
  assert.include(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    'SEM0087',
  )
  const statement = result.functions
    .at(0)
    ?.statements.find((candidate) => candidate._tag === 'IfLet')
  assert.strictEqual(statement?._tag, 'IfLet')
  if (statement?._tag !== 'IfLet') return
  assert.strictEqual(statement.selection.bindings[0]?.name, 'number')
  assert.strictEqual(statement.taken[0]?._tag, 'Return')
})

it('keeps statement-pattern loans scoped and move selection consumed on both outcomes', () => {
  const shared = analyze(
    'shared-pattern-loan',
    `pub struct Point { x: i32 y: i32 }
pub fn inspect(point: Point) -> i32 {
  let Point { x, .. } = &point
  let y = point.y
  return x + y
}`,
  )
  assert.deepEqual(shared.diagnostics, [])
  assert.deepEqual(ownership(shared).diagnostics, [])

  const exclusive = analyze(
    'exclusive-pattern-loan',
    `pub struct Point { x: i32 y: i32 }
pub fn inspect(point: Point) -> i32 {
  let mut owned = move point
  if let Point { x, .. } = &mut owned { let invalid = owned.y } else {}
  return owned.y
}`,
  )
  assert.include(
    ownership(exclusive).diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0011',
  )

  const moved = analyze(
    'moved-pattern-selection',
    `pub struct Point { x: i32 }
fn consume(value: Point | i32) -> i32 { return 0 }
pub fn inspect(value: Point | i32) -> i32 {
  if let Point { x } = move value { let selected = x } else {}
  return consume(move value)
}`,
  )
  assert.include(
    ownership(moved).diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0001',
  )
})

it('keeps borrowed owners live, consumes move matches, and requires mutable exclusive roots', () => {
  const shared = analyze(
    'shared-owner',
    `pub struct Token { kind: i32 }
pub struct End {}
fn finish(event: Token | End) -> i32 { return 0 }
pub fn inspect(event: Token | End) -> i32 {
  let code = match &event { Token { kind } => kind End {} => 0 }
  return finish(move event)
}`,
  )
  assert.deepEqual(ownership(shared).diagnostics, [])

  const consumed = analyze(
    'consumed-owner',
    `pub struct Token { kind: i32 }
pub struct End {}
fn finish(event: Token | End) -> i32 { return 0 }
pub fn inspect(event: Token | End) -> i32 {
  let code = match move event { Token { kind } => kind End {} => 0 }
  return finish(move event)
}`,
  )
  assert.include(
    ownership(consumed).diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0001',
  )

  const bare = analyze(
    'bare-owner',
    `pub struct Token { kind: i32 }
pub fn inspect(event: Token) -> i32 { return match event { Token { kind } => kind } }`,
  )
  assert.include(
    ownership(bare).diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0003',
  )

  const exclusive = analyze(
    'exclusive-owner',
    `pub struct Token { kind: i32 }
pub fn inspect(event: Token) -> i32 { return match &mut event { Token { kind } => kind } }`,
  )
  assert.include(
    ownership(exclusive).diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0007',
  )
})

it('requires move for a bare by-value use of a consuming pattern owner', () => {
  const source = `pub struct Payload { value: i32 }
pub struct Box { payload: Payload }
pub union Slot { Full { payload: Payload }, Empty }
fn arm(input: Box) -> Payload { return match move input { Box { payload } => payload } }
fn early(input: Box) -> Payload { match move input { Box { payload } => { return payload } } }
fn assign(input: Slot, cell: &mut Payload) -> i32 {
  if let Slot.Full { payload } = move input { cell.* = payload }
  return 0
}
fn consume(payload: Payload) -> i32 { return payload.value }
fn argument(input: Box) -> i32 { return match move input { Box { payload } => consume(payload) } }
fn moved(input: Box) -> Payload { return match move input { Box { payload } => move payload } }`
  const result = analyze('consuming-pattern-move', source)
  // Each bare use, including a by-value call argument, needs `move`; the explicit form stays accepted.
  const uses = [
    source.indexOf('=> payload') + '=> '.length,
    source.indexOf('return payload') + 'return '.length,
    source.indexOf('= payload') + '= '.length,
    source.indexOf('consume(payload)') + 'consume('.length,
  ]
  assert.deepEqual(
    ownership(result).diagnostics.map(({ code, span }) => ({
      code,
      start: span.start,
      end: span.end,
    })),
    uses.map((start) => ({ code: 'OWN0003', start, end: start + 'payload'.length })),
  )
})

it('keeps guard bindings provisional and rejects borrowed payload escape', () => {
  const guarded = analyze(
    'guard-owner',
    `pub struct Payload {}
pub struct Box { value: Payload }
fn accept(value: Payload) -> bool { return true }
pub fn inspect(input: Box) -> i32 {
  return match move input {
    Box { value } if accept(move value) => 1
    Box { value: fallback } => 0
  }
}`,
  )
  assert.include(
    ownership(guarded).diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0008',
  )

  const borrowed = analyze(
    'borrowed-owner',
    `pub struct Payload {}
pub struct Box { value: Payload }
pub fn inspect(input: Box) -> Payload {
  return match &input { Box { value } => value }
}`,
  )
  assert.include(
    ownership(borrowed).diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0006',
  )

  const consumedBorrowSource = `pub struct Payload {}
pub struct Box { value: Payload code: i32 }
pub fn consumed(input: Box) -> i32 {
  return match &input { Box { value, code } => match move value { _ => 0 } }
}
pub fn inspected(input: Box) -> i32 {
  return match &input { Box { value, code } => match &value { _ => match move code { _ => 0 } } }
}`
  const consumedBorrow = analyze('borrowed-owner-match-move', consumedBorrowSource)
  const consumedStart = consumedBorrowSource.indexOf('value { _ => 0 }')
  assert.deepEqual(
    [...consumedBorrow.diagnostics, ...ownership(consumedBorrow).diagnostics].map((diagnostic) => ({
      code: diagnostic.code,
      span: [diagnostic.span.start, diagnostic.span.end],
    })),
    [{ code: 'OWN0006', span: [consumedStart, consumedStart + 'value'.length] }],
  )

  const copiedOwnerSource = `pub struct Payload {}
pub struct Box { value: Payload }
pub fn inspect(input: Box) -> i32 {
  if let Box { value } = &input {
    let held = value
    drop held
  }
  return 0
}`
  const copiedOwner = analyze('borrowed-owner-let', copiedOwnerSource)
  const heldStart = copiedOwnerSource.indexOf('value\n    drop')
  assert.deepEqual(
    [...copiedOwner.diagnostics, ...ownership(copiedOwner).diagnostics].map((diagnostic) => ({
      code: diagnostic.code,
      span: [diagnostic.span.start, diagnostic.span.end],
    })),
    [{ code: 'OWN0006', span: [heldStart, heldStart + 'value'.length] }],
  )

  const escapedViewSource = `pub struct Inner { values: [u8; 4] }
pub union Maybe { Held { value: Inner }, Empty }
fn whole(inner: &Inner) -> &[u8] { return &inner.values }
pub fn escaped(spelled: Maybe) -> usize {
  let mut selected = b"i32"
  if let Maybe.Held {value} = &spelled { selected = whole(&value) }
  return selected.length
}
pub fn contained(spelled: Maybe) -> usize {
  if let Maybe.Held {value} = &spelled { let view = whole(&value) return view.length }
  return 0
}
pub fn referenced(spelled: &Maybe) -> &[u8] {
  if let Maybe.Held {value} = &spelled.* { return whole(&value) }
  return b"i32"
}`
  const escapedView = analyze('borrowed-owner-if-let-view', escapedViewSource)
  const escapedUse = escapedViewSource.indexOf('selected.length')
  assert.deepEqual(
    [
      ...new Set(
        [...escapedView.diagnostics, ...ownership(escapedView).diagnostics].map((diagnostic) =>
          JSON.stringify([diagnostic.code, diagnostic.span.start, diagnostic.span.end]),
        ),
      ),
    ],
    [JSON.stringify(['OWN0019', escapedUse, escapedUse + 'selected'.length])],
  )
})

it('plans selected-arm cleanup for omitted and unreturned moved fields', () => {
  const result = analyze(
    'cleanup-owner',
    `pub struct Payload {}
pub struct Box { payload: Payload code: i32 }
pub fn inspect(input: Box) -> i32 {
  return match move input { Box { code, .. } => code }
}`,
  )
  const ownershipFacts = ownership(result)
  const match = ownershipFacts.functions.at(0)?.matches.at(0)

  assert.deepEqual(ownershipFacts.diagnostics, [])
  assert.strictEqual(match?.access, 'Move')
  assert.deepEqual(
    match?.arms.at(0)?.cleanup.map((entry) => ({
      path: entry.path.map((field) => field.ordinal),
      cleanup: entry.cleanup._tag,
    })),
    [{ path: [0], cleanup: 'StructCleanup' }],
  )
  assert.include(
    OwnershipEncoding.encode(ownershipFacts),
    'cleanup=#0(struct:cleanup-owner.Payload fields=)',
  )
})

it('retains ordinary arm bodies and computes unit and never from structured statement flow', () => {
  const result = analyze(
    'ordinary-completion',
    `enum Choice { First, Last }
fn unit(value: Choice) { match value { Choice.First => {} Choice.Last => () } }
fn mixed(value: Choice) -> i32 { return match value { Choice.First => { return 7 } Choice.Last => 9 } }
fn total(value: Choice, flag: bool) -> i32 {
  match value { Choice.First => { if flag { return 1 } else { return 2 } } Choice.Last => { return 3 } }
}
fn inner(value: Choice) {
  match value { Choice.First => { while true { break } drop 42 } Choice.Last => {} }
}`,
  )
  assert.deepEqual(result.diagnostics, [])
  const matches: Array<Extract<Tir.Expression, { readonly _tag: 'Match' }>> = []
  for (const fn of result.tir.functions)
    for (const expression of fn.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree))
      if (expression._tag === 'Match') matches.push(expression)
  assert.deepEqual(
    matches.map((match) => Type.encode(match.type)),
    ['()', 'i32', 'never', '()'],
  )
  assert.deepEqual(
    matches.map((match) =>
      match.arms.map((arm) =>
        arm.body._tag === 'Block' ? arm.body.completion.fallsThrough : 'expression',
      ),
    ),
    [
      [true, 'expression'],
      [false, 'expression'],
      [false, false],
      [true, true],
    ],
  )
  assert.deepEqual(Tir.verify(result.tir), [])
  for (const fn of result.tir.functions)
    for (const root of fn.statements.flatMap(Tir.statementExpressions)) {
      for (const match of Tir.expressionTree(root).filter(
        (expression) => expression._tag === 'Match',
      )) {
        assert.isTrue(
          match.arms.every(
            (arm) => arm.body.span.start >= arm.span.start && arm.body.span.end <= arm.span.end,
          ),
        )
      }
    }
})

it('checks ordinary arm statements and partial completion without contextual unit coercion', () => {
  const source = `enum Choice { First, Last }
fn scalar(value: Choice) -> i32 { return match value { Choice.First => {} Choice.Last => 1 } }
fn partial(value: Choice, flag: bool) -> i32 { return match value { Choice.First => { if flag { return 2 } } Choice.Last => 1 } }
fn bare(value: Choice) { match value { Choice.First => { 42 } Choice.Last => {} } }
fn outside(value: Choice) { match value { Choice.First => { break } Choice.Last => { continue } } }
fn scope(value: Choice) { match value { Choice.First => { let inner = 1 drop inner } Choice.Last => {} } drop inner }
`
  const scalarMatch = 'match value { Choice.First => {} Choice.Last => 1 }'
  const partialMatch = 'match value { Choice.First => { if flag { return 2 } } Choice.Last => 1 }'
  const partialStart = source.indexOf(partialMatch)
  const syntax = parse('ordinary-errors', source)
  const result = elaborate(syntax)
  assert.deepEqual([...syntax.lexicalDiagnostics, ...syntax.parserDiagnostics], [])
  const selected = result.diagnostics.filter((diagnostic) =>
    ['SEM0049', 'SEM0087', 'SEM0038'].includes(diagnostic.code),
  )
  const matches: Array<Extract<Tir.Expression, { readonly _tag: 'Match' }>> = []
  for (const fn of result.functions)
    for (const expression of fn.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree))
      if (expression._tag === 'Match') matches.push(expression)
  assert.deepEqual(
    selected.map((diagnostic) => [diagnostic.code, diagnostic.span.start, diagnostic.span.end]),
    [
      ['SEM0049', source.indexOf(scalarMatch), source.indexOf(scalarMatch) + scalarMatch.length],
      ['SEM0049', partialStart, partialStart + partialMatch.length],
      ['SEM0087', source.indexOf('42'), source.indexOf('42') + 2],
      ['SEM0038', source.indexOf('break'), source.indexOf('break') + 5],
      ['SEM0038', source.indexOf('continue'), source.indexOf('continue') + 8],
    ],
  )
  assert.isTrue(
    result.diagnostics.some((diagnostic) => diagnostic.span.start === source.lastIndexOf('inner')),
  )
})

it('discovers enclosing returns through arguments and guards and suppresses an abandoned outer return', () => {
  const source = `enum Choice { First, Last }
fn use(value: i32) -> i32 { return value }
fn argument(value: Choice) -> i32 { return use(match value { Choice.First => { return true } Choice.Last => 1 }) }
fn operand(value: Choice) -> i32 { return match value { Choice.First => { return 2 } Choice.Last => { return 3 } } }
fn guarded(value: Choice) -> i32 { return match value { Choice.First if match value { Choice.First => { return 4 } Choice.Last => { return 5 } } => 8 Choice.First => 1 Choice.Last => 2 } }
fn borrowed(values: &[i32], value: Choice) -> &[i32] { return match value { Choice.First => { return values } Choice.Last => values } }
fn invalidBorrow(values: &[i32], value: Choice) -> &[i32] { return match value { Choice.First => { let local = [1] return &local } Choice.Last => values } }
`
  const syntax = parse('ordinary-returns', source)
  const result = elaborate(syntax)
  assert.deepEqual([...syntax.lexicalDiagnostics, ...syntax.parserDiagnostics], [])
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.span.start,
      diagnostic.span.end,
    ]),
    [
      ['SEM0129', source.indexOf('true'), source.indexOf('true') + 4],
      ['OWN0019', source.lastIndexOf('match value'), source.lastIndexOf('} }') + 1],
      ['OWN0019', source.indexOf('&local'), source.indexOf('&local') + 6],
      ['SEM0212', source.indexOf('&local'), source.indexOf('&local') + 6],
      ['OWN0019', source.lastIndexOf('values'), source.lastIndexOf('values') + 6],
    ],
  )
  const operand =
    result.functions.find(
      (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'operand',
    ) ?? raise('expected operand function')
  const flow = StatementAnalysis.returnFlowOf(operand.statements)
  assert.strictEqual(flow.fallsThrough, false)
  assert.deepEqual(
    flow.returns.map((returned) => {
      const span = returned.expression.span
      return source.slice(span.start, span.end)
    }),
    // Presentation spans are trivia-free: the returned literals no longer carry a leading space.
    ['2', '3'],
  )
  const guarded =
    result.tir.functions.find(
      (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'guarded',
    ) ?? raise('expected guarded function')
  assert.deepEqual(Tir.verify({ ...result.tir, functions: [guarded] }), [])
})

it('shares lexical loop destinations and enclosing failure contracts without crossing explicit boundaries', () => {
  const source = `enum Choice { First, Last }
struct Problem {}
effect fn step() -> () ! Problem { return () }
effect fn eager(value: Choice) -> () ! Problem {
  match value { Choice.First => { run step() run step() } Choice.Last => { fail Problem {} } }
}
fn loops(value: Choice) {
  while true {
    match value { Choice.First => { while true { break } continue } Choice.Last => { break } }
  }
}
fn boundary(value: Choice) {
  while true {
    match value { Choice.First => { let pending = effect { break } drop pending } Choice.Last => { break } }
  }
}
fn illegal(value: Choice) { match value { Choice.First => { fail Problem {} } Choice.Last => {} } }
struct Holder { item: i32 }
fn conflict(value: Holder) { match value { Holder { item } => { let item = 1 drop item } } }
`
  const syntax = parse('ordinary-boundaries', source)
  const result = elaborate(syntax)
  const spans = spansOf(result)
  assert.deepEqual([...syntax.lexicalDiagnostics, ...syntax.parserDiagnostics], [])
  const loops =
    result.functions.find(
      (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'loops',
    ) ?? raise('expected loops')
  const transfers = statementTree(loops.statements).filter(
    (statement): statement is Extract<Tir.Statement, { readonly _tag: 'Break' | 'Continue' }> =>
      statement._tag === 'Break' || statement._tag === 'Continue',
  )
  assert.deepEqual(
    transfers.map((statement) => [statement._tag, statement.target?.ordinal]),
    [
      ['Break', 1],
      ['Continue', 0],
      ['Break', 0],
    ],
  )
  const boundaryBreak = source.indexOf('break', source.indexOf('effect {'))
  assert.deepEqual(
    result.diagnostics
      .filter((diagnostic) => diagnostic.code === 'SEM0038')
      .map((diagnostic) => [diagnostic.span.start, diagnostic.span.end]),
    [[boundaryBreak, boundaryBreak + 5]],
  )
  const eager =
    result.functions.find(
      (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'eager',
    ) ?? raise('expected eager')
  const eagerSpan = spans.spanOf(eager.declaration.anchor)
  assert.deepEqual(
    result.diagnostics.filter(
      (diagnostic) =>
        diagnostic.span.start >= eagerSpan.start && diagnostic.span.end <= eagerSpan.end,
    ),
    [],
  )
  assert.isTrue(
    result.diagnostics.some((diagnostic) => diagnostic.span.start >= source.indexOf('fn illegal')),
  )
})

it.effect('borrows exclusive match payloads from the original projected owner', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'borrowed-match-payload',
      new TextEncoder().encode(`struct Counter { value: i32 }
struct Empty {}
struct Guard { provider: Counter | Empty }
struct Guards { values: [Guard; 1] }
fn increment(counter: &mut Counter) -> () { counter.value = counter.value + 1 }
fn readWhole(provider: &(Counter | Empty)) -> i32 {
  return match &provider.* {
    Counter {value} => value
    Empty {} => 0
  }
}
fn update(guard: &mut Guard) -> () {
  match &mut guard.provider {
    Counter counter => { increment(&mut counter) }
    Empty {} => {}
  }
}
fn readSlice(guards: &[Guard], index: usize) -> i32 {
  return match &guards[index].provider {
    Counter {value} => value
    Empty {} => 0
  }
}
fn own(input: Guard) -> i32 {
  let mut guard = move input
  match &mut guard.provider {
    Counter counter => { increment(&mut counter) }
    Empty {} => {}
  }
  return match move guard.provider { Counter {value} => value Empty {} => 0 }
}
union Inner { Closed {operation: i32}, Open {operation: i32} }
union Outer { Io {error: Inner}, Other }
fn nested(input: &Outer) -> i32 {
  return match &input.* {
    Outer.Io {error: Inner.Closed {operation}} if false => 99
    Outer.Io {error: Inner.Closed {operation}} => operation
    Outer.Io {error: Inner.Open {operation}} => 0
    Outer.Other => 0
  }
}
fn fallback(input: Outer | Empty) -> i32 {
  return match move input { Empty {} => 0 _ => 42 }
}
fn copyBinding(provider: &(Counter | Empty)) -> i32 {
  if let Counter {value} = &provider.* {
    let mut held = value
    held = held + 1
    return held
  }
  return 0
}
pub fn main() -> i32 {
  let fallbackValue = fallback(Outer.Other)
  drop fallbackValue
  let nestedOwner = Outer.Io {error: Inner.Open {operation: 17}}
  let nestedValue = nested(&nestedOwner)
  drop nestedValue
  let mut guard = Guard {provider: Counter {value: 41}}
  update(&mut guard)
  let whole = readWhole(&guard.provider)
  drop whole
  let heldValue = copyBinding(&guard.provider)
  drop heldValue
  let mut guards = Guards {values: [Guard {provider: Counter {value: 1}}]}
  let copied = readSlice(&guards.values, 0)
  drop copied
  return own(move guard)
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const program = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const nestedFn =
      program.functions.find((candidate) => candidate.id.name === 'nested') ??
      raise('expected nested MIR')
    const nestedMatch =
      MirVerification.operations(nestedFn).find((operation) => operation._tag === 'Match') ??
      raise('expected nested match')
    assert.deepEqual(
      nestedMatch.arms.map((arm) => arm.tests?.length ?? 0),
      [1, 1, 1, 0],
    )
    assert.deepEqual(nestedMatch.arms.at(-1)?.after, [])
    const nestedBlocks = MirLinearization.linearize(nestedFn)
    const nestedBranches = nestedBlocks.filter(
      (block) =>
        block.terminator._tag === 'MatchBranch' && (block.terminator.selectors?.length ?? 0) > 0,
    )
    assert.isTrue(nestedBranches.length > 0)
    assert.isTrue(
      nestedBranches.every((block) =>
        block.operations.every((operation) => operation._tag !== 'BindMatch'),
      ),
    )
    const fn =
      program.functions.find((candidate) => candidate.id.name === 'update') ??
      raise('expected update MIR')
    const operations = MirVerification.operations(fn)
    const match =
      operations.find((operation) => operation._tag === 'Match') ?? raise('expected borrowed match')
    const loan =
      operations.find((operation) => operation._tag === 'BeginLoan') ??
      raise('expected payload loan')
    const binding =
      match.arms.flatMap((arm) => arm.bindings).at(0) ?? raise('expected borrowed payload')
    assert.strictEqual(binding.type._tag, 'EnvironmentBorrow')
    assert.deepEqual(loan.root, binding.destination)
    assert.strictEqual(match.scrutinee.ordinal, 0)
    assert.deepEqual(
      match.selectors?.map((selector) => selector._tag),
      ['FieldSelector'],
    )
    const copyFn =
      program.functions.find((candidate) => candidate.id.name === 'copyBinding') ??
      raise('expected copied binding MIR')
    const copyOperations = MirVerification.operations(copyFn)
    const copyMatch =
      copyOperations.find((operation) => operation._tag === 'Match') ??
      raise('expected statement pattern match')
    const borrowedValue =
      copyMatch.arms.flatMap((arm) => arm.bindings).at(0) ?? raise('expected borrowed binding')
    assert.strictEqual(borrowedValue.type._tag, 'EnvironmentBorrow')
    const copiedBinding =
      copyOperations.find(
        (operation) =>
          operation._tag === 'Move' &&
          operation.source.ordinal === borrowedValue.destination.ordinal,
      ) ?? raise('expected the binding copy')
    if (copiedBinding._tag !== 'Move') return raise('expected move operation')
    assert.notStrictEqual(
      copyFn.localTypes.at(copiedBinding.destination.ordinal)?._tag,
      'EnvironmentBorrow',
    )
    const indexed =
      program.functions.find((candidate) => candidate.id.name === 'readSlice') ??
      raise('expected indexed match')
    const indexedMatch =
      MirVerification.operations(indexed).find((operation) => operation._tag === 'Match') ??
      raise('expected match')
    assert.isTrue(
      indexedMatch.selectors?.some((candidate) => candidate._tag === 'SliceElementSelector'),
    )
    assert.strictEqual(
      indexedMatch.arms.flatMap((arm) => arm.bindings).at(0)?.type._tag,
      'EnvironmentBorrow',
    )
    const whole =
      program.functions.find((candidate) => candidate.id.name === 'readWhole') ??
      raise('expected whole reference match')
    const wholeMatch =
      MirVerification.operations(whole).find((operation) => operation._tag === 'Match') ??
      raise('expected match')
    assert.strictEqual(wholeMatch.scrutinee.ordinal, 0)
    assert.deepEqual(wholeMatch.selectors ?? [], [])
    const owned =
      program.functions.find((candidate) => candidate.id.name === 'own') ??
      raise('expected owned match')
    const ownedMatch =
      MirVerification.operations(owned).find(
        (operation) => operation._tag === 'Match' && operation.access === 'Exclusive',
      ) ?? raise('expected exclusive owned match')
    if (ownedMatch._tag !== 'Match') return raise('expected match operation')
    assert.isTrue(
      NativeFunction.discoverRoots(owned, MirLinearization.linearize(owned)).address.has(
        ownedMatch.scrutinee.ordinal,
      ),
    )
  }),
)

it.effect(
  'lowers an all-transferring argument without its outer call or a match result local',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'ordinary-mir-argument',
        new TextEncoder().encode(`enum Choice { First, Last }
fn first(value: i32) -> i32 { return value }
fn later(value: i32) -> i32 { return value }
fn consume(left: i32, right: i32, last: i32) -> i32 { return left + right + last }
fn argument(value: Choice) -> i32 {
  return consume(first(1), match value { Choice.First => { return 7 } Choice.Last => { return 8 } }, later(99))
}
struct DeferredValue { value: i32 }
struct DeferredEmpty {}
fn deferred(input: DeferredValue | DeferredEmpty) -> Effect<'static; i32> {
  match &input {
    DeferredValue { value } => { return effect { return run effect { return value } } }
    DeferredEmpty {} => { return effect { match move (DeferredValue { value: 8 }) { DeferredValue { value } => { return value } } } }
  }
}
pub fn main() -> i32 { let deferredValue = run deferred(DeferredValue { value: 7 }) return argument(Choice.First) + deferredValue }`),
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const program = Analysis.loweredMir(snapshot)
      assert.deepEqual(yield* MirVerification.verify(program), [])
      const fn =
        program.functions.find((candidate) => candidate.id.name === 'argument') ??
        raise('expected argument MIR')
      const operations = MirVerification.operations(fn)
      const match =
        operations.find((operation) => operation._tag === 'Match') ?? raise('expected match MIR')
      assert.isUndefined(match.destination)
      assert.isTrue(match.arms.every((arm) => arm.selected.execution.result === undefined))
      assert.isFalse(fn.localTypes.some((type) => type._tag === 'Bottom'))
      assert.deepEqual(
        operations
          .filter((operation) => operation._tag === 'Call')
          .map((operation) => operation.target.name),
        ['first'],
      )
      const blocks = MirLinearization.linearize(fn)
      assert.isTrue(blocks.some((block) => block.terminator._tag === 'Return'))
      assert.isFalse(
        blocks.some((block) =>
          block.operations.some(
            (operation) => operation._tag === 'Call' && operation.target.name !== 'first',
          ),
        ),
      )
      const deferredFact =
        records(Analysis.rootAnalysis(snapshot)).functions.find(
          (candidate) =>
            candidate.declaration.name._tag === 'Present' &&
            candidate.declaration.name.spelling === 'deferred',
        ) ?? raise('expected deferred function fact')
      const captureReferences: Array<ReadonlyArray<string>> = []
      for (const expression of deferredFact.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)) {
        if (expression._tag === 'EffectBlock')
          captureReferences.push(
            expression.captures.map((capture) => {
              if (capture.pattern !== undefined) return 'PatternBinding'
              return capture.binding === undefined ? 'Parameter' : 'Binding'
            }),
          )
      }
      assert.deepEqual(captureReferences, [['PatternBinding'], ['PatternBinding'], []])
      const deferred =
        program.functions.find((candidate) => candidate.id.name === 'deferred') ??
        raise('expected deferred MIR')
      assert.strictEqual(deferred.result._tag, 'EffectComposite')
      assert.deepEqual(
        MirVerification.operations(deferred)
          .filter((operation) => operation._tag === 'PackEffectComposite')
          .map((operation) => operation.alternative)
          .sort((left, right) => left - right),
        [0, 1],
      )
      for (const region of Mir.regionsTree(deferred.regions)) {
        if (!('outcome' in region) || region.outcome._tag !== 'Return') continue
        assert.deepEqual(deferred.localTypes.at(region.outcome.value.ordinal), deferred.result)
      }
    }),
)

it.effect(
  'keeps unit completion and a partial enclosing return on distinct match region paths',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'ordinary-mir-partial',
        new TextEncoder().encode(`enum Choice { First, Last }
fn partial(value: Choice, stop: bool) -> i32 {
  let mut total = 0
  let completed = match value { Choice.First => { if stop { return 7 } total = 3 } Choice.Last => { total = 4 } }
  drop completed
  return total
}
pub fn main() -> i32 { return partial(Choice.First, false) }`),
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const program = Analysis.loweredMir(snapshot)
      assert.deepEqual(yield* MirVerification.verify(program), [])
      const fn =
        program.functions.find((candidate) => candidate.id.name === 'partial') ??
        raise('expected partial MIR')
      const match =
        MirVerification.operations(fn).find((operation) => operation._tag === 'Match') ??
        raise('expected match MIR')
      const destination = match.destination ?? raise('expected normal unit destination')
      const selected =
        match.arms.at(0)?.selected.execution ?? raise('expected selected region graph')
      assert.isDefined(selected.result)
      assert.isTrue(
        selected.regions.some((region) => 'outcome' in region && region.outcome._tag === 'Return'),
      )
      assert.isTrue(
        selected.regions.some(
          (region) => 'outcome' in region && region.outcome._tag === 'Complete',
        ),
      )
      const blocks = MirLinearization.linearize(fn)
      assert.isTrue(
        blocks.some((block) =>
          block.operations.some(
            (operation) =>
              operation._tag === 'Move' && operation.destination.ordinal === destination.ordinal,
          ),
        ),
      )
      for (const block of blocks.filter((block) => block.terminator._tag === 'Return'))
        assert.isFalse(
          block.operations.some(
            (operation) =>
              operation._tag === 'Move' && operation.destination.ordinal === destination.ordinal,
          ),
        )
    }),
)

it.effect('lowers transferring guards and preserves inner and enclosing loop destinations', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'ordinary-mir-guard-loop',
      new TextEncoder().encode(`enum Choice { First, Last }
fn guarded(value: Choice) -> i32 {
  return match value { Choice.First if match value { Choice.First => { return 4 } Choice.Last => { return 5 } } => 999 Choice.First => 1 Choice.Last => 2 }
}
fn stoppedGuard() -> i32 { match 0 { _ if match 0 { _ => { return 42 } } => {} _ => {} } }
fn loops(value: Choice) -> i32 {
  let mut total = 0
  while total < 2 {
    total = total + 1
    match value { Choice.First => { while true { break } continue } Choice.Last => { break } }
  }
  return total
}
pub fn main() -> i32 { return guarded(Choice.First) + loops(Choice.Last) + stoppedGuard() }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const program = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const stoppedGuardFact =
      records(snapshot.results.get('ordinary-mir-guard-loop'))?.functions.find(
        (fn) =>
          fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'stoppedGuard',
      ) ?? raise('expected stopped guard function fact')
    const stoppedMatches = stoppedGuardFact.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
      .filter(
        (expression): expression is Extract<Tir.Expression, { readonly _tag: 'Match' }> =>
          expression._tag === 'Match',
      )
    assert.deepEqual(
      stoppedMatches.map((match) => Type.encode(match.type)),
      ['never', 'never'],
    )
    const stoppedGuard =
      program.functions.find((fn) => fn.id.name === 'stoppedGuard') ??
      raise('expected stopped guard MIR')
    const stoppedOperations = MirVerification.operations(stoppedGuard)
    for (const match of stoppedOperations.filter((operation) => operation._tag === 'Match'))
      assert.isUndefined(match.destination)
    assert.isFalse(
      stoppedGuard.localTypes.some(
        (type) => type._tag === 'Bottom' || Type.equals(Mir.semanticType(type), Type.unit),
      ),
    )
    assert.doesNotThrow(() => MirLinearization.linearize(stoppedGuard))
    const guarded =
      program.functions.find((candidate) => candidate.id.name === 'guarded') ??
      raise('expected guarded MIR')
    const match =
      MirVerification.operations(guarded).find((operation) => operation._tag === 'Match') ??
      raise('expected guarded selection')
    assert.isUndefined(match.arms.at(0)?.guard?.execution.result)
    assert.isFalse(
      MirVerification.operations(guarded).some(
        (operation) => operation._tag === 'Literal' && operation.value === 999,
      ),
    )
    const loops =
      program.functions.find((candidate) => candidate.id.name === 'loops') ??
      raise('expected loop MIR')
    const outcomes = Mir.regionsTree(loops.regions).flatMap((region) =>
      'outcome' in region ? [region.outcome] : [],
    )
    assert.isTrue(outcomes.some((outcome) => outcome._tag === 'Exit' && outcome.loop.ordinal === 1))
    assert.isTrue(
      outcomes.some((outcome) => outcome._tag === 'Repeat' && outcome.loop.ordinal === 0),
    )
    assert.isTrue(outcomes.some((outcome) => outcome._tag === 'Exit' && outcome.loop.ordinal === 0))
    assert.doesNotThrow(() => MirLinearization.linearize(guarded))
    assert.doesNotThrow(() => MirLinearization.linearize(loops))
  }),
)
