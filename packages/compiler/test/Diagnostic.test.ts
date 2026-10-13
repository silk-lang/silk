import { assert, it } from '@effect/vitest'
import * as Option from 'effect/Option'
import * as Diagnostic from '../src/Diagnostic.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceSpan from '../src/SourceSpan.js'
import { raise } from './support/raise.js'

const source = SourceFile.make('memory://diagnostic.silk', new Uint8Array(64))

const spanAt = (start: number, end: number): SourceSpan.SourceSpan =>
  Option.getOrThrow(SourceSpan.make(source, start, end))

const build = () => {
  const lexical = [Diagnostic.unsupportedBytes(spanAt(10, 12))]
  const parser = [
    Diagnostic.missingToken('RightParenthesis', spanAt(4, 4)),
    Diagnostic.unexpectedTokens(['Invalid'], 'syntax', ['identifier'], spanAt(10, 12)),
  ]
  const semantic = [
    Diagnostic.unknownType('Bogus', spanAt(2, 7)),
    Diagnostic.unknownFunction('missing', spanAt(10, 12)),
  ]
  return { lexical, parser, semantic }
}

it('distinguishes non-alias cycles and unit-variant payload patterns with exact spans', () => {
  const cycle = Diagnostic.nonAliasResolutionCycle(spanAt(2, 7))
  const pattern = Diagnostic.unitVariantPayloadPattern('Option<i32>.None', spanAt(10, 24))
  assert.deepEqual(
    [cycle, pattern].map(({ code, reason, span }) => ({
      code,
      reason,
      span: [span.start, span.end],
    })),
    [
      { code: 'SEM0223', reason: { _tag: 'NonAliasResolutionCycle' }, span: [2, 7] },
      {
        code: 'SEM0224',
        reason: { _tag: 'UnitVariantPayloadPattern', variant: 'Option<i32>.None' },
        span: [10, 24],
      },
    ],
  )
})

it('publishes structured duration diagnostics with focused spans', () => {
  const diagnostics = [
    Diagnostic.invalidDurationAmount(spanAt(0, 3)),
    Diagnostic.unknownDurationUnit('sec', spanAt(4, 7)),
    Diagnostic.repeatedDurationUnit('h', spanAt(9, 10)),
    Diagnostic.outOfOrderDurationUnit('h', 'm', spanAt(12, 13)),
    Diagnostic.subordinateDurationOutOfRange('m', 60n, 59n, spanAt(14, 17)),
    Diagnostic.durationOutOfRange('18446744073709551616ns', spanAt(18, 40)),
  ]

  assert.deepEqual(
    diagnostics.map(({ code, reason, span }) => ({
      code,
      reason,
      span: [span.start, span.end],
    })),
    [
      { code: 'LEX0008', reason: { _tag: 'InvalidDurationAmount' }, span: [0, 3] },
      {
        code: 'LEX0009',
        reason: { _tag: 'UnknownDurationUnit', spelling: 'sec' },
        span: [4, 7],
      },
      {
        code: 'LEX0010',
        reason: { _tag: 'RepeatedDurationUnit', unit: 'h' },
        span: [9, 10],
      },
      {
        code: 'LEX0011',
        reason: { _tag: 'OutOfOrderDurationUnit', unit: 'h', previous: 'm' },
        span: [12, 13],
      },
      {
        code: 'LEX0012',
        reason: {
          _tag: 'SubordinateDurationOutOfRange',
          unit: 'm',
          amount: '60',
          maximum: '59',
        },
        span: [14, 17],
      },
      {
        code: 'SEM0170',
        reason: {
          _tag: 'DurationOutOfRange',
          spelling: '18446744073709551616ns',
          maximum: '18446744073709551615',
        },
        span: [18, 40],
      },
    ],
  )
})

it('publishes structured scalar enum diagnostics with exact related spans', () => {
  const declaration = spanAt(0, 12)
  const first = spanAt(16, 21)
  const duplicate = spanAt(24, 29)
  const literal = spanAt(32, 35)
  const diagnostics = [
    Diagnostic.emptyEnum('Empty', declaration),
    Diagnostic.unsupportedEnumRepresentation('usize', ['u8', 'i8'], literal),
    Diagnostic.duplicateEnumMemberName('Ready', first, duplicate),
    Diagnostic.duplicateEnumDiscriminant(3n, first, duplicate),
    Diagnostic.enumDiscriminantOutOfRange('i8', 128n, -128n, 127n, literal),
    Diagnostic.enumImplicitDiscriminantOverflow('u8', 255n, 255n, duplicate),
    Diagnostic.unsignedEnumNegativeDiscriminant('u8', -1n, literal),
    Diagnostic.unknownEnumMember('Status', 'Missing', duplicate),
    Diagnostic.wrongEnumMember('Status', 'Other', duplicate),
    Diagnostic.enumIntegerMismatch('Status', 'u8', 'IntegerToEnum', literal),
    Diagnostic.enumIntegerMismatch('Status', 'u8', 'EnumToInteger', literal),
    Diagnostic.crossEnumEquality('Status', 'Other', duplicate),
    Diagnostic.enumOrdering('Status', '<', duplicate),
  ]

  assert.deepEqual(
    diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      reason: diagnostic.reason,
      span: [diagnostic.span.start, diagnostic.span.end],
      related: diagnostic.relatedSpans?.map((related) => [related.span.start, related.span.end]),
    })),
    [
      {
        code: 'SEM0146',
        reason: { _tag: 'EmptyEnum', enum: 'Empty' },
        span: [0, 12],
        related: undefined,
      },
      {
        code: 'SEM0147',
        reason: {
          _tag: 'UnsupportedEnumRepresentation',
          spelling: 'usize',
          allowed: ['u8', 'i8'],
        },
        span: [32, 35],
        related: undefined,
      },
      {
        code: 'SEM0148',
        reason: { _tag: 'DuplicateEnumMemberName', spelling: 'Ready', originalSpan: first },
        span: [24, 29],
        related: [[16, 21]],
      },
      {
        code: 'SEM0149',
        reason: { _tag: 'DuplicateEnumDiscriminant', value: '3', originalSpan: first },
        span: [24, 29],
        related: [[16, 21]],
      },
      {
        code: 'SEM0150',
        reason: {
          _tag: 'EnumDiscriminantOutOfRange',
          representation: 'i8',
          value: '128',
          minimum: '-128',
          maximum: '127',
        },
        span: [32, 35],
        related: undefined,
      },
      {
        code: 'SEM0151',
        reason: {
          _tag: 'EnumImplicitDiscriminantOverflow',
          representation: 'u8',
          predecessor: '255',
          maximum: '255',
        },
        span: [24, 29],
        related: undefined,
      },
      {
        code: 'SEM0152',
        reason: {
          _tag: 'UnsignedEnumNegativeDiscriminant',
          representation: 'u8',
          value: '-1',
        },
        span: [32, 35],
        related: undefined,
      },
      {
        code: 'SEM0153',
        reason: { _tag: 'UnknownEnumMember', enum: 'Status', member: 'Missing' },
        span: [24, 29],
        related: undefined,
      },
      {
        code: 'SEM0154',
        reason: { _tag: 'WrongEnumMember', expected: 'Status', actual: 'Other' },
        span: [24, 29],
        related: undefined,
      },
      {
        code: 'SEM0155',
        reason: {
          _tag: 'EnumIntegerMismatch',
          enum: 'Status',
          integer: 'u8',
          direction: 'IntegerToEnum',
        },
        span: [32, 35],
        related: undefined,
      },
      {
        code: 'SEM0155',
        reason: {
          _tag: 'EnumIntegerMismatch',
          enum: 'Status',
          integer: 'u8',
          direction: 'EnumToInteger',
        },
        span: [32, 35],
        related: undefined,
      },
      {
        code: 'SEM0156',
        reason: { _tag: 'CrossEnumEquality', left: 'Status', right: 'Other' },
        span: [24, 29],
        related: undefined,
      },
      {
        code: 'SEM0157',
        reason: { _tag: 'EnumOrdering', enum: 'Status', operator: '<' },
        span: [24, 29],
        related: undefined,
      },
    ],
  )
})

it('publishes structured scalar enum match diagnostics with exact related spans', () => {
  const match = spanAt(0, 40)
  const first = spanAt(4, 16)
  const duplicate = spanAt(20, 32)
  const wildcard = spanAt(2, 8)
  const arm = spanAt(10, 20)
  const diagnostics = [
    Diagnostic.incompleteEnumMatch('Status', ['Status.Unknown'], match),
    Diagnostic.duplicateEnumMatchArm('Status.Ready', first, duplicate),
    Diagnostic.enumMatchArmAfterWildcard(wildcard, arm),
    Diagnostic.foreignEnumPattern('Status', 'Other', duplicate),
    Diagnostic.integerPatternAgainstEnum('Status', 1n, arm),
  ]

  assert.deepEqual(
    diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      reason: diagnostic.reason,
      span: [diagnostic.span.start, diagnostic.span.end],
      related: diagnostic.relatedSpans?.map((related) => [related.span.start, related.span.end]),
    })),
    [
      {
        code: 'SEM0158',
        reason: { _tag: 'IncompleteEnumMatch', enum: 'Status', missing: ['Status.Unknown'] },
        span: [0, 40],
        related: undefined,
      },
      {
        code: 'SEM0159',
        reason: { _tag: 'DuplicateEnumMatchArm', member: 'Status.Ready', originalSpan: first },
        span: [20, 32],
        related: [[4, 16]],
      },
      {
        code: 'SEM0160',
        reason: { _tag: 'EnumMatchArmAfterWildcard', wildcardSpan: wildcard },
        span: [10, 20],
        related: [[2, 8]],
      },
      {
        code: 'SEM0161',
        reason: { _tag: 'ForeignEnumPattern', expected: 'Status', actual: 'Other' },
        span: [20, 32],
        related: undefined,
      },
      {
        code: 'SEM0162',
        reason: { _tag: 'IntegerPatternAgainstEnum', enum: 'Status', value: '1' },
        span: [10, 20],
        related: undefined,
      },
    ],
  )
})

it('merges phase collections into one deterministic driver order', () => {
  const { lexical, parser, semantic } = build()
  const merged = Diagnostic.merge(lexical, parser, semantic)

  assert.deepEqual(
    merged.map((diagnostic) => ({
      phase: diagnostic.phase,
      code: diagnostic.code,
      start: diagnostic.span.start,
      end: diagnostic.span.end,
    })),
    [
      { phase: 'semantic', code: 'SEM0001', start: 2, end: 7 },
      { phase: 'parser', code: 'PAR0001', start: 4, end: 4 },
      { phase: 'lexical', code: 'LEX0001', start: 10, end: 12 },
      { phase: 'parser', code: 'PAR0002', start: 10, end: 12 },
      { phase: 'semantic', code: 'SEM0004', start: 10, end: 12 },
    ],
  )
})

it('produces an identical merged sequence across repeated fresh constructions', () => {
  const first = build()
  const second = build()

  assert.deepEqual(
    Diagnostic.merge(first.lexical, first.parser, first.semantic),
    Diagnostic.merge(second.lexical, second.parser, second.semantic),
  )
})

it('orders same-span same-phase diagnostics by stable code', () => {
  const span = spanAt(3, 5)
  const merged = Diagnostic.merge([
    Diagnostic.unexpectedTokens(['Invalid'], 'syntax', ['identifier'], span),
    Diagnostic.missingToken('Identifier', span),
  ])

  assert.deepEqual(
    merged.map((diagnostic) => diagnostic.code),
    ['PAR0001', 'PAR0002'],
  )
})

it('describes reserved template syntax with a stable parser diagnostic', () => {
  const diagnostic = Diagnostic.reservedTemplateSyntax(spanAt(8, 18))

  assert.deepEqual(
    {
      phase: diagnostic.phase,
      code: diagnostic.code,
      reason: diagnostic.reason,
    },
    {
      phase: 'parser',
      code: 'PAR0003',
      reason: { _tag: 'ReservedTemplateSyntax' },
    },
  )
})

it('describes excessive expression nesting with structured depths and an exact token span', () => {
  const diagnostic = Diagnostic.expressionNestingLimitExceeded(256, 257, spanAt(11, 12))

  assert.deepEqual(
    {
      phase: diagnostic.phase,
      code: diagnostic.code,
      severity: diagnostic.severity,
      reason: diagnostic.reason,
      span: [diagnostic.span.start, diagnostic.span.end],
    },
    {
      phase: 'parser',
      code: 'PAR0005',
      severity: 'error',
      reason: { _tag: 'ExpressionNestingLimitExceeded', limit: 256, attemptedDepth: 257 },
      span: [11, 12],
    },
  )
})

it('publishes stable lexical identities for modifier and delimiter failures', () => {
  const span = spanAt(8, 24)
  const diagnostics = [
    Diagnostic.unknownLiteralModifier('future', span),
    Diagnostic.unterminatedStaticLiteral('b', 3, span),
  ]
  assert.deepEqual(
    diagnostics.map(({ phase, code, reason }) => ({ phase, code, reason })),
    [
      {
        phase: 'lexical',
        code: 'LEX0002',
        reason: { _tag: 'UnknownLiteralModifier', modifier: 'future' },
      },
      {
        phase: 'lexical',
        code: 'LEX0003',
        reason: {
          _tag: 'UnterminatedStaticLiteral',
          modifier: 'b',
          delimiter: '"',
          delimiterWidth: 3,
        },
      },
    ],
  )
  assert.deepEqual(
    Diagnostic.merge(diagnostics).map((diagnostic) => diagnostic.code),
    ['LEX0002', 'LEX0003'],
  )
})

it('describes missing tokens with source-language spelling', () => {
  const keyword = Diagnostic.missingToken('ReturnKeyword', spanAt(4, 4))
  const punctuation = Diagnostic.missingToken('Equals', spanAt(8, 8))

  assert.deepEqual(
    [keyword, punctuation].map((diagnostic) => ({
      message: diagnostic.message,
      reason: diagnostic.reason,
    })),
    [
      {
        message: 'Expected `return`',
        reason: { _tag: 'MissingToken', expected: 'ReturnKeyword' },
      },
      { message: 'Expected `=`', reason: { _tag: 'MissingToken', expected: 'Equals' } },
    ],
  )
})

it('describes unexpected syntax with the encountered token and parser context', () => {
  const diagnostic = Diagnostic.unexpectedTokens(
    ['Semicolon'],
    'statement',
    ['`let`', '`return`', 'an expression', '`}`'],
    spanAt(4, 5),
  )

  assert.deepEqual(
    {
      message: diagnostic.message,
      reason: diagnostic.reason,
      notes: diagnostic.notes,
    },
    {
      message: 'Unexpected `;` while parsing a statement',
      reason: {
        _tag: 'UnexpectedTokens',
        unexpected: ['Semicolon'],
        context: 'statement',
        expected: ['`let`', '`return`', 'an expression', '`}`'],
      },
      notes: ['Expected one of: `let`, `return`, an expression, `}`'],
    },
  )
})

it('describes return contract failures with stable semantic diagnostics', () => {
  const missing = Diagnostic.missingReturn('i32', spanAt(12, 12))
  const mismatch = Diagnostic.returnTypeMismatch('i32', 'Effect<i32>', spanAt(20, 31))

  assert.deepEqual(
    [missing, mismatch].map((diagnostic) => ({
      phase: diagnostic.phase,
      code: diagnostic.code,
      reason: diagnostic.reason,
    })),
    [
      {
        phase: 'semantic',
        code: 'SEM0130',
        reason: { _tag: 'MissingReturn', expected: 'i32' },
      },
      {
        phase: 'semantic',
        code: 'SEM0129',
        reason: { _tag: 'ReturnTypeMismatch', expected: 'i32', actual: 'Effect<i32>' },
      },
    ],
  )
})

it('assigns identity ordinals among equal phase, code, and span', () => {
  const span = spanAt(0, 1)
  const equal = Diagnostic.unknownFunction('twice', span)
  const other = Diagnostic.unknownType('Other', spanAt(2, 3))
  const identities = Diagnostic.identify([equal, other, equal])
  const first = identities.at(0) ?? raise('expected first diagnostic identity')
  const repeated = identities.at(2) ?? raise('expected repeated diagnostic identity')

  assert.deepEqual(
    identities.map((identity) => identity.ordinal),
    [0, 0, 1],
  )
  assert.strictEqual(Diagnostic.identityEquals(first, Diagnostic.identity(equal)), true)
  assert.strictEqual(Diagnostic.identityEquals(first, repeated), false)
  assert.isBelow(Diagnostic.compareIdentity(first, repeated), 0)
})

it('merges ownership diagnostics after the semantic phase at the same span', () => {
  const span = spanAt(10, 12)
  const merged = Diagnostic.merge(
    [Diagnostic.useAfterMove('value', spanAt(2, 7), span)],
    [Diagnostic.unknownFunction('missing', span)],
  )

  assert.deepEqual(
    merged.map((diagnostic) => ({ phase: diagnostic.phase, code: diagnostic.code })),
    [
      { phase: 'ownership', code: 'OWN0001' },
      { phase: 'semantic', code: 'SEM0004' },
    ],
  )
  const ownership = merged.at(0)
  assert.strictEqual(ownership?.relatedSpans?.at(0)?.label, 'moved here')
  assert.strictEqual(ownership?.reason._tag, 'UseAfterMove')
})

it('carries the original declaration span on a rebinding diagnostic', () => {
  const diagnostic = Diagnostic.rebindingName('value', spanAt(2, 7), spanAt(10, 15))

  assert.strictEqual(diagnostic.phase, 'semantic')
  assert.strictEqual(diagnostic.code, 'SEM0008')
  assert.strictEqual(diagnostic.relatedSpans?.at(0)?.label, 'first declared here')
  assert.strictEqual(diagnostic.relatedSpans?.at(0)?.span.start, 2)
})

it('publishes deterministic static-evaluation diagnostics with source traces', () => {
  const callerSource = SourceFile.make('memory://static-caller.silk', new Uint8Array(64))
  const helperSource = SourceFile.make('memory://static-helper.silk', new Uint8Array(64))
  const callerSpan = (start: number, end: number) =>
    Option.getOrThrow(SourceSpan.make(callerSource, start, end))
  const helperSpan = (start: number, end: number) =>
    Option.getOrThrow(SourceSpan.make(helperSource, start, end))
  const trace = [
    {
      kind: 'SelectedArm' as const,
      label: 'selected wasm arm',
      arguments: ['Wasm32'],
      span: callerSpan(2, 8),
    },
    {
      kind: 'Call' as const,
      label: 'parse("{}")',
      arguments: ['"{}"'],
      span: helperSpan(10, 18),
    },
  ]
  const primary = helperSpan(20, 28)
  const diagnostics = [
    Diagnostic.staticPhaseViolation('Effect.log', 'wasm32-unknown-unknown', trace, primary),
    Diagnostic.selectedCompileError('empty template', 'wasm32-unknown-unknown', trace, primary),
    Diagnostic.staticEvaluationCycle('parse("{}")', 'wasm32-unknown-unknown', trace, primary),
    Diagnostic.staticStepLimit(10_000, 'wasm32-unknown-unknown', trace, primary),
    Diagnostic.staticCallDepthLimit(128, 'wasm32-unknown-unknown', trace, primary),
    Diagnostic.staticRetainedValueLimit(1_048_576, 'wasm32-unknown-unknown', trace, primary),
    Diagnostic.staticResidualGrowthLimit(100_000, 'wasm32-unknown-unknown', trace, primary),
  ]
  const staticCodes: ReadonlyArray<Diagnostic.Code> = [
    'SEM0176',
    'SEM0177',
    'SEM0178',
    'SEM0179',
    'SEM0180',
    'SEM0181',
    'SEM0182',
  ]

  assert.deepEqual(
    diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      span: {
        sourceId: diagnostic.span.sourceId,
        start: diagnostic.span.start,
        end: diagnostic.span.end,
      },
      related: diagnostic.relatedSpans?.map((related) => ({
        label: related.label,
        sourceId: related.span.sourceId,
        start: related.span.start,
        end: related.span.end,
      })),
    })),
    staticCodes.map((code) => ({
      code,
      span: { sourceId: 'memory://static-helper.silk', start: 20, end: 28 },
      related: [
        {
          label: 'selected wasm arm',
          sourceId: 'memory://static-caller.silk',
          start: 2,
          end: 8,
        },
        {
          label: 'parse("{}")',
          sourceId: 'memory://static-helper.silk',
          start: 10,
          end: 18,
        },
      ],
    })),
  )

  const reasonDetails = (reason: Diagnostic.Reason) => {
    switch (reason._tag) {
      case 'StaticPhaseViolation':
        return {
          payload: {
            tag: reason._tag,
            operation: reason.operation,
            target: reason.target,
          },
          trace: reason.trace,
        }
      case 'SelectedCompileError':
        return {
          payload: { tag: reason._tag, detail: reason.detail, target: reason.target },
          trace: reason.trace,
        }
      case 'StaticEvaluationCycle':
        return {
          payload: {
            tag: reason._tag,
            application: reason.application,
            target: reason.target,
          },
          trace: reason.trace,
        }
      case 'StaticEvaluationLimit':
        return {
          payload: {
            tag: reason._tag,
            resource: reason.resource,
            limit: reason.limit,
            target: reason.target,
          },
          trace: reason.trace,
        }
      default:
        return raise(`expected a static-evaluation reason, received ${reason._tag}`)
    }
  }

  assert.deepEqual(
    diagnostics.map((diagnostic) => reasonDetails(diagnostic.reason).payload),
    [
      {
        tag: 'StaticPhaseViolation',
        operation: 'Effect.log',
        target: 'wasm32-unknown-unknown',
      },
      {
        tag: 'SelectedCompileError',
        detail: 'empty template',
        target: 'wasm32-unknown-unknown',
      },
      {
        tag: 'StaticEvaluationCycle',
        application: 'parse("{}")',
        target: 'wasm32-unknown-unknown',
      },
      {
        tag: 'StaticEvaluationLimit',
        resource: 'Steps',
        limit: 10_000,
        target: 'wasm32-unknown-unknown',
      },
      {
        tag: 'StaticEvaluationLimit',
        resource: 'CallDepth',
        limit: 128,
        target: 'wasm32-unknown-unknown',
      },
      {
        tag: 'StaticEvaluationLimit',
        resource: 'RetainedValueBytes',
        limit: 1_048_576,
        target: 'wasm32-unknown-unknown',
      },
      {
        tag: 'StaticEvaluationLimit',
        resource: 'ResidualNodes',
        limit: 100_000,
        target: 'wasm32-unknown-unknown',
      },
    ],
  )

  for (const diagnostic of diagnostics)
    assert.deepEqual(
      reasonDetails(diagnostic.reason).trace.map((frame) => ({
        kind: frame.kind,
        label: frame.label,
        arguments: frame.arguments,
        sourceId: frame.span.sourceId,
        start: frame.span.start,
        end: frame.span.end,
      })),
      [
        {
          kind: 'SelectedArm',
          label: 'selected wasm arm',
          arguments: ['Wasm32'],
          sourceId: 'memory://static-caller.silk',
          start: 2,
          end: 8,
        },
        {
          kind: 'Call',
          label: 'parse("{}")',
          arguments: ['"{}"'],
          sourceId: 'memory://static-helper.silk',
          start: 10,
          end: 18,
        },
      ],
    )
})
