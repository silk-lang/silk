import type * as CompilationProfile from './CompilationProfile.js'
import * as CompilerTrace from './CompilerTrace.js'
import type * as AuthoredHir from './AuthoredHir.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import * as Diagnostic from './Diagnostic.js'
import type * as Elaboration from './Elaboration.js'
import * as FloatingPoint from './FloatingPoint.js'
import * as Location from './Location.js'
import * as Provenance from './Provenance.js'
import type * as Match from './Match.js'
import * as Lifetime from './Lifetime.js'
import * as Tir from './Tir.js'
import * as Canonical from './internal/Canonical.js'
import * as TypeInference from './internal/TypeInference.js'
import * as Scalar from './Scalar.js'
import * as StaticValue from './StaticValue.js'
import type * as SemanticContext from './SemanticContext.js'
import type * as Target from './Target.js'
import * as Type from './Type.js'
import type * as TestDiscovery from './TestDiscovery.js'

/** The closed target facts visible to one static-evaluation session. */
export interface TargetEnvironment {
  readonly _tag: 'StaticTargetEnvironment'
  readonly target: Target.Id
  readonly sourceIdentity: string
  readonly compilation: CompilationProfile.Initial | CompilationProfile.CompilationProfile
  readonly kind: 'Native' | 'WebAssembly'
  readonly pointerBits: 32 | 64
  readonly endianness: 'little'
}

/** Exposes immutable profile facts to the private bootstrap or completed evaluation session. */
export const targetEnvironment = (
  compilation: CompilationProfile.Initial | CompilationProfile.CompilationProfile,
  sourceIdentity = '',
): TargetEnvironment => ({
  _tag: 'StaticTargetEnvironment',
  sourceIdentity,
  target: compilation.target.id,
  compilation,
  kind: compilation.target.kind,
  pointerBits: compilation.target.pointerSize === 4 ? 32 : 64,
  endianness: compilation.target.endianness,
})

/** Compiler-owned deterministic limits for one complete static-evaluation session. */
export interface Limits {
  readonly steps: number
  readonly callDepth: number
  readonly retainedValueBytes: number
  readonly residualNodes: number
}

/** Initial policy values; callers may supply smaller explicit limits for bounded verification. */
export const defaultLimits: Limits = {
  steps: 100_000,
  callDepth: 128,
  retainedValueBytes: 4 * 1024 * 1024,
  residualNodes: 100_000,
}

const validLimit = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

/** Validates and freezes one explicit deterministic limit policy. */
export const limits = (input: Limits): Limits => {
  if (
    !validLimit(input.steps) ||
    !validLimit(input.callDepth) ||
    !validLimit(input.retainedValueBytes) ||
    !validLimit(input.residualNodes)
  )
    throw new RangeError('Static evaluation limits must be non-negative safe integers')
  return { ...input }
}

/** One concrete static application before syntax evaluation or residualization. */
export interface Application {
  readonly declaration: DeclarationFacts.CanonicalId
  /** Canonical generic-argument encodings in declared order. */
  readonly typeArguments: ReadonlyArray<string>
  /** Canonical selected-evidence encodings in declared order. */
  readonly evidence: ReadonlyArray<string>
  readonly contractRow: ReadonlyArray<string>
  readonly staticArguments: ReadonlyArray<StaticValue.Value>
  readonly span: Location.Location
}

/** One source-level frame retained without a host stack or runtime identity. */
export type TraceFrame =
  | ApplicationFrame
  | SelectedArmFrame
  | StaticIterationFrame
  | StaticTextFrame

export interface ApplicationFrame {
  readonly _tag: 'StaticApplicationFrame'
  readonly declaration: DeclarationFacts.CanonicalId
  readonly target: Target.Id
  readonly staticArguments: ReadonlyArray<string>
  readonly span: Location.Location
}

export interface SelectedArmFrame {
  readonly _tag: 'SelectedStaticArmFrame'
  readonly selected: 'Taken' | 'Otherwise'
  readonly span: Location.Location
}

export interface StaticIterationFrame {
  readonly _tag: 'StaticIterationFrame'
  readonly ordinal: number
  readonly value: string
  readonly span: Location.Location
}

export interface StaticTextFrame {
  readonly _tag: 'StaticTextFrame'
  readonly literal: Location.Location
  readonly byteOffset: number
}

export type Trace = ReadonlyArray<TraceFrame>

/** Source-independent provenance for one static text result. */
export type TextOrigin = StaticValue.TextOrigin

/** Creates provenance for one decoded source text value of `byteLength` bytes. */
export const sourceTextOrigin = (at: AuthoredHir.Anchor, byteLength: number): TextOrigin =>
  Provenance.literal(at, byteLength)

/** Creates caller-relative provenance for one static text parameter. */
export const parameterTextOrigin = (
  ordinal: number,
  byteLength: number,
  scope?: string,
): TextOrigin => {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0)
    throw new RangeError('Static text parameter lengths must be non-negative safe integers')
  return Provenance.parameter(ordinal, byteLength, scope)
}

/** Composes one half-open byte slice into existing text provenance. */
export const sliceTextOrigin = (
  origin: TextOrigin,
  start: number,
  end: number,
): TextOrigin | undefined =>
  !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end
    ? undefined
    : Provenance.slice(origin, start, end)

/** Joins the provenance of two texts; a side that was computed contributes no segment. */
export const concatTextOrigin = (
  left: TextOrigin | undefined,
  leftLength: number,
  right: TextOrigin | undefined,
): TextOrigin | undefined =>
  left === undefined && right === undefined
    ? undefined
    : Provenance.concat(left ?? [], leftLength, right ?? [])

/**
 * The location of the written bytes behind static text provenance: every part, in value order.
 *
 * A parameter part has no position until a call site substitutes what it passed, so a location
 * that keeps one is shared between the calls that select it. `fallback` is the node reported when
 * no part resolves.
 */
export const textOriginLocation = (
  origin: TextOrigin,
  fallback: AuthoredHir.Anchor,
): Location.Location | undefined =>
  origin.length === 0
    ? undefined
    : Location.within(
        origin.map((segment) => segment.from),
        fallback,
      )

/** Retains one selected static arm in the logical trace. */
export const selectedArmFrame = (
  selected: SelectedArmFrame['selected'],
  span: Location.Location,
): SelectedArmFrame => ({ _tag: 'SelectedStaticArmFrame', selected, span })

/** Retains one canonical element selected by an authored static iteration. */
export const staticIterationFrame = (
  ordinal: number,
  value: StaticValue.Value,
  span: Location.Location,
): StaticIterationFrame => {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0)
    throw new RangeError('Static iteration ordinals must be non-negative safe integers')
  return {
    _tag: 'StaticIterationFrame',
    ordinal,
    value: StaticValue.presentation(value),
    span,
  }
}

/** Retains one validated byte position in a source static-text literal. */
export const staticTextFrame = (
  literal: Location.Location,
  byteOffset: number,
): StaticTextFrame => {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0)
    throw new RangeError('Static text byte offsets must be non-negative safe integers')
  return { _tag: 'StaticTextFrame', literal, byteOffset }
}

/** Appends logical frames without exposing or mutating evaluation storage. */
export const appendTrace = (self: Trace, ...frames: ReadonlyArray<TraceFrame>): Trace => [
  ...self,
  ...frames,
]

interface FailureBase {
  readonly span: Location.Location
  readonly trace: Trace
}

export interface CompileError extends FailureBase {
  readonly _tag: 'CompileError'
  readonly message: string
  /** Text provenance retained relative to static parameters until the call boundary. */
  readonly origin?: TextOrigin
}

export interface PhaseViolation extends FailureBase {
  readonly _tag: 'PhaseViolation'
  readonly operation: string
  readonly detail: string
}

export interface Cycle extends FailureBase {
  readonly _tag: 'Cycle'
  readonly declaration: DeclarationFacts.CanonicalId
}

interface LimitFailureBase extends FailureBase {
  readonly limit: number
  readonly attempted: number
}

export interface StepLimit extends LimitFailureBase {
  readonly _tag: 'StepLimit'
}

export interface CallDepthLimit extends LimitFailureBase {
  readonly _tag: 'CallDepthLimit'
}

export interface RetainedValueLimit extends LimitFailureBase {
  readonly _tag: 'RetainedValueLimit'
}

export interface ResidualGrowthLimit extends LimitFailureBase {
  readonly _tag: 'ResidualGrowthLimit'
}

/** Every expected deterministic failure of the static-evaluation coordinator. */
export type StaticFailure =
  | CompileError
  | PhaseViolation
  | Cycle
  | StepLimit
  | CallDepthLimit
  | RetainedValueLimit
  | ResidualGrowthLimit

const diagnosticTrace = (
  trace: Trace,
): ReadonlyArray<Diagnostic.StaticTraceFrame<Location.Location>> =>
  trace.flatMap((frame): ReadonlyArray<Diagnostic.StaticTraceFrame<Location.Location>> => {
    if (frame._tag === 'StaticTextFrame')
      return [
        {
          kind: 'StaticText',
          label: `static text byte ${frame.byteOffset}`,
          arguments: [`byteOffset=${frame.byteOffset}`],
          span: frame.literal,
        },
      ]
    if (frame._tag === 'StaticApplicationFrame')
      return [
        {
          kind: 'Call',
          label: `${frame.declaration.module}.${frame.declaration.name}`,
          arguments: frame.staticArguments,
          span: frame.span,
        },
      ]
    if (frame._tag === 'StaticIterationFrame')
      return [
        {
          kind: 'SelectedArm',
          label: `static for element ${frame.ordinal}`,
          arguments: [frame.value],
          span: frame.span,
        },
      ]
    return [
      {
        kind: 'SelectedArm',
        label: frame.selected === 'Taken' ? 'selected static if arm' : 'selected static else arm',
        arguments: [],
        span: frame.span,
      },
    ]
  })

/** Converts one static-evaluation failure into its stable public semantic diagnostic. */
export const diagnostic = (failure: StaticFailure, target: string): Diagnostic.Located => {
  const trace = diagnosticTrace(failure.trace)
  if (failure._tag === 'CompileError')
    return Diagnostic.selectedCompileError(failure.message, target, trace, failure.span)
  if (failure._tag === 'PhaseViolation')
    return Diagnostic.staticPhaseViolation(failure.operation, target, trace, failure.span)
  if (failure._tag === 'Cycle')
    return Diagnostic.staticEvaluationCycle(
      `${failure.declaration.module}.${failure.declaration.name}`,
      target,
      trace,
      failure.span,
    )
  let factory = Diagnostic.staticResidualGrowthLimit
  if (failure._tag === 'StepLimit') factory = Diagnostic.staticStepLimit
  else if (failure._tag === 'CallDepthLimit') factory = Diagnostic.staticCallDepthLimit
  else if (failure._tag === 'RetainedValueLimit') factory = Diagnostic.staticRetainedValueLimit
  return factory(failure.limit, target, trace, failure.span)
}

const frozenTrace = (trace: Trace): Trace => [...trace]

/** Creates one source-requested compile failure for the selected specialization. */
export const compileError = (
  message: string,
  span: Location.Location,
  trace: Trace,
  origin?: TextOrigin,
): CompileError => ({
  _tag: 'CompileError',
  message,
  span,
  trace: frozenTrace(trace),
  ...(origin === undefined ? {} : { origin }),
})

/** Creates one rejected crossing from static work into an unavailable phase. */
export const phaseViolation = (
  operation: string,
  detail: string,
  span: Location.Location,
  trace: Trace,
): PhaseViolation => ({
  _tag: 'PhaseViolation',
  operation,
  detail,
  span,
  trace: frozenTrace(trace),
})

/** The contextual type supplied while evaluating one ordinary literal syntax node. */
export type LiteralExpectation =
  | 'unit'
  | 'bool'
  | 'char'
  | 'string'
  | Scalar.IntegerSpelling
  | Scalar.FloatSpelling

/** The primitive operations admitted before static calls and control flow are implemented. */
export type PrimitiveOperation =
  | 'Add'
  | 'Subtract'
  | 'Multiply'
  | 'Divide'
  | 'Remainder'
  | 'Negate'
  | 'Equals'
  | 'NotEquals'
  | 'LessThan'
  | 'LessOrEqual'
  | 'GreaterThan'
  | 'GreaterOrEqual'
  | 'Not'

const primitiveFailure = (
  operation: string,
  detail: string,
  span: Location.Location,
  trace: Trace,
): Outcome<StaticValue.Value> => failed(phaseViolation(operation, detail, span, trace))

const admittedValue = (
  environment: TargetEnvironment,
  candidate: unknown,
  operation: string,
  span: Location.Location,
  trace: Trace,
): Outcome<StaticValue.Value> => {
  const admission = StaticValue.admit(candidate, { pointerBits: environment.pointerBits })
  return admission._tag === 'Admitted'
    ? complete(admission.value)
    : primitiveFailure(operation, `${admission.reason}: ${admission.detail}`, span, trace)
}

const expectedLiteral = (
  expected: LiteralExpectation | undefined,
  actual: LiteralExpectation,
  span: Location.Location,
  trace: Trace,
): Outcome<StaticValue.Value> | undefined =>
  expected === undefined || expected === actual
    ? undefined
    : primitiveFailure(
        'Evaluation.evaluateLiteral',
        `expected ${expected}, received ${actual} literal`,
        span,
        trace,
      )

/**
 * Evaluates one authored literal under an optional contextual primitive type.
 *
 * Authored literals already carry their exact decoded payload, so nothing is re-lexed here: the
 * operation only selects the primitive type and admits the value for the target environment.
 */
export const evaluateLiteral = (
  environment: TargetEnvironment,
  context: SemanticContext.SemanticContext,
  node: AuthoredHir.Literal,
  expected?: LiteralExpectation,
  trace: Trace = [],
): Outcome<StaticValue.Value> => {
  const span = Location.at(node.anchor)
  const mismatch = (actual: LiteralExpectation): Outcome<StaticValue.Value> | undefined =>
    expectedLiteral(expected, actual, span, trace)
  if (node._tag === 'UnitLiteral') return mismatch('unit') ?? complete(StaticValue.unit())
  if (node._tag === 'BooleanLiteral')
    return mismatch('bool') ?? complete(StaticValue.boolean(node.value))
  if (node._tag === 'IntegerLiteral') {
    const selected = expected === undefined ? Scalar.defaultInteger.spelling : expected
    if (!Scalar.isIntegerSpelling(selected))
      return primitiveFailure(
        'Evaluation.evaluateLiteral',
        `expected ${selected}, received integer literal`,
        span,
        trace,
      )
    return admittedValue(
      environment,
      { _tag: 'IntegerValue', type: selected, value: node.value },
      'Evaluation.evaluateLiteral',
      span,
      trace,
    )
  }
  if (node._tag === 'FloatingLiteral') {
    const selected = expected === undefined ? Scalar.defaultFloat.spelling : expected
    if (!Scalar.isFloatSpelling(selected))
      return primitiveFailure(
        'Evaluation.evaluateLiteral',
        `expected ${selected}, received floating literal`,
        span,
        trace,
      )
    const sign = node.sign === 'Negative' ? '-' : ''
    const encoded = FloatingPoint.fromDecimal(
      `${sign}${node.coefficient}e${node.exponent}`,
      selected === 'f32' ? 32 : 64,
    )
    return encoded === undefined
      ? primitiveFailure(
          'Evaluation.evaluateLiteral',
          'floating literal cannot be encoded',
          span,
          trace,
        )
      : admittedValue(
          environment,
          { _tag: 'FloatValue', type: selected, bits: encoded.bits },
          'Evaluation.evaluateLiteral',
          span,
          trace,
        )
  }
  if (node._tag === 'CharacterLiteral') {
    const selected = expected ?? 'char'
    const wrong = Scalar.isIntegerSpelling(selected) ? undefined : mismatch('char')
    if (wrong !== undefined) return wrong
    return admittedValue(
      environment,
      Scalar.isIntegerSpelling(selected)
        ? { _tag: 'IntegerValue', type: selected, value: BigInt(node.scalar) }
        : { _tag: 'CharacterValue', value: node.scalar },
      'Evaluation.evaluateLiteral',
      span,
      trace,
    )
  }
  if (node._tag === 'TextLiteral') {
    const wrong = mismatch('string')
    if (wrong !== undefined) return wrong
    return admittedValue(
      environment,
      {
        _tag: 'TextValue',
        bytes: [...new TextEncoder().encode(context.textOf(node.value))],
      },
      'Evaluation.evaluateLiteral',
      span,
      trace,
    )
  }
  return primitiveFailure(
    'Evaluation.evaluateLiteral',
    `${node._tag} is not a static literal`,
    span,
    trace,
  )
}

const samePrimitiveType = (left: StaticValue.Value, right: StaticValue.Value): boolean => {
  if (left._tag !== right._tag) return false
  if (left._tag === 'IntegerValue' && right._tag === 'IntegerValue') return left.type === right.type
  if (left._tag === 'FloatValue' && right._tag === 'FloatValue') return left.type === right.type
  return true
}

/** Evaluates checked scalar equality and arithmetic without consulting a runtime engine. */
export const evaluatePrimitive = (
  environment: TargetEnvironment,
  operation: PrimitiveOperation,
  operands: ReadonlyArray<StaticValue.Value>,
  span: Location.Location,
  trace: Trace = [],
): Outcome<StaticValue.Value> => {
  const left = operands.at(0)
  const right = operands.at(1)
  const arity = operation === 'Negate' || operation === 'Not' ? 1 : 2
  if (operands.length !== arity || left === undefined)
    return primitiveFailure(
      'Evaluation.evaluatePrimitive',
      `${operation} expects ${arity} operand${arity === 1 ? '' : 's'}`,
      span,
      trace,
    )
  if ((operation === 'Equals' || operation === 'NotEquals') && right !== undefined) {
    if (!samePrimitiveType(left, right))
      return primitiveFailure(
        'Evaluation.evaluatePrimitive',
        'equality operands must have the same primitive type',
        span,
        trace,
      )
    if (
      (left._tag === 'BooleanValue' && right._tag === 'BooleanValue') ||
      (left._tag === 'CharacterValue' && right._tag === 'CharacterValue') ||
      (left._tag === 'IntegerValue' && right._tag === 'IntegerValue')
    ) {
      const equal = left.value === right.value
      return complete(StaticValue.boolean(operation === 'Equals' ? equal : !equal))
    }
    if (
      (left._tag === 'UnitValue' && right._tag === 'UnitValue') ||
      (left._tag === 'TextValue' && right._tag === 'TextValue')
    ) {
      const equal = StaticValue.equals(left, right)
      return complete(StaticValue.boolean(operation === 'Equals' ? equal : !equal))
    }
    if (left._tag === 'FloatValue' && right._tag === 'FloatValue') {
      const width = left.type === 'f32' ? 32 : 64
      const equal =
        FloatingPoint.toNumber({ width, bits: left.bits }) ===
        FloatingPoint.toNumber({ width, bits: right.bits })
      return complete(StaticValue.boolean(operation === 'Equals' ? equal : !equal))
    }
    return primitiveFailure(
      'Evaluation.evaluatePrimitive',
      `${left._tag} does not expose primitive equality`,
      span,
      trace,
    )
  }
  const comparison =
    operation === 'LessThan' ||
    operation === 'LessOrEqual' ||
    operation === 'GreaterThan' ||
    operation === 'GreaterOrEqual'
  if (comparison && right !== undefined) {
    if (!samePrimitiveType(left, right))
      return primitiveFailure(
        'Evaluation.evaluatePrimitive',
        'comparison operands must have the same primitive type',
        span,
        trace,
      )
    let order: number | undefined
    if (left._tag === 'IntegerValue' && right._tag === 'IntegerValue') {
      if (left.value < right.value) order = -1
      else if (left.value > right.value) order = 1
      else order = 0
    } else if (left._tag === 'FloatValue' && right._tag === 'FloatValue') {
      const width = left.type === 'f32' ? 32 : 64
      const leftNumber = FloatingPoint.toNumber({ width, bits: left.bits })
      const rightNumber = FloatingPoint.toNumber({ width, bits: right.bits })
      if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
        if (leftNumber < rightNumber) order = -1
        else if (leftNumber > rightNumber) order = 1
        else order = 0
      }
    }
    if (order === undefined) return complete(StaticValue.boolean(false))
    let result = order >= 0
    if (operation === 'LessThan') result = order < 0
    else if (operation === 'LessOrEqual') result = order <= 0
    else if (operation === 'GreaterThan') result = order > 0
    return complete(StaticValue.boolean(result))
  }
  if (operation === 'Not' && left._tag === 'BooleanValue')
    return complete(StaticValue.boolean(!left.value))
  if (left._tag === 'IntegerValue') {
    if (operation === 'Negate') {
      const scalar = Scalar.find(left.type)
      if (scalar?.category !== 'Integer' || scalar.signedness !== 'Signed')
        return primitiveFailure(
          'Evaluation.evaluatePrimitive',
          `Negate is unavailable for ${left.type}`,
          span,
          trace,
        )
      return admittedValue(
        environment,
        { _tag: 'IntegerValue', type: left.type, value: -left.value },
        'Evaluation.evaluatePrimitive',
        span,
        trace,
      )
    }
    if (right?._tag !== 'IntegerValue' || right.type !== left.type)
      return primitiveFailure(
        'Evaluation.evaluatePrimitive',
        'integer arithmetic operands must have the same type',
        span,
        trace,
      )
    if ((operation === 'Divide' || operation === 'Remainder') && right.value === 0n)
      return primitiveFailure('Evaluation.evaluatePrimitive', 'division by zero', span, trace)
    const scalar = Scalar.find(left.type)
    if (scalar?.category !== 'Integer')
      return primitiveFailure(
        'Evaluation.evaluatePrimitive',
        `unknown integer scalar ${left.type}`,
        span,
        trace,
      )
    const range = Scalar.range(scalar, environment.pointerBits)
    if (
      operation === 'Remainder' &&
      scalar.signedness === 'Signed' &&
      left.value === range.minimum &&
      right.value === -1n
    )
      return primitiveFailure('Evaluation.evaluatePrimitive', 'arithmetic overflow', span, trace)
    let value: bigint
    switch (operation) {
      case 'Add':
        value = left.value + right.value
        break
      case 'Subtract':
        value = left.value - right.value
        break
      case 'Multiply':
        value = left.value * right.value
        break
      case 'Divide':
        value = left.value / right.value
        break
      case 'Remainder':
        value = left.value % right.value
        break
      default:
        return primitiveFailure(
          'Evaluation.evaluatePrimitive',
          `${operation} is unavailable for ${left.type}`,
          span,
          trace,
        )
    }
    return admittedValue(
      environment,
      { _tag: 'IntegerValue', type: left.type, value },
      'Evaluation.evaluatePrimitive',
      span,
      trace,
    )
  }
  if (left._tag === 'FloatValue') {
    const width = left.type === 'f32' ? 32 : 64
    const leftNumber = FloatingPoint.toNumber({ width, bits: left.bits })
    let value: number
    if (operation === 'Negate') value = -leftNumber
    else {
      if (right?._tag !== 'FloatValue' || right.type !== left.type)
        return primitiveFailure(
          'Evaluation.evaluatePrimitive',
          'floating arithmetic operands must have the same type',
          span,
          trace,
        )
      const rightNumber = FloatingPoint.toNumber({ width, bits: right.bits })
      switch (operation) {
        case 'Add':
          value = leftNumber + rightNumber
          break
        case 'Subtract':
          value = leftNumber - rightNumber
          break
        case 'Multiply':
          value = leftNumber * rightNumber
          break
        case 'Divide':
          value = leftNumber / rightNumber
          break
        case 'Remainder':
          value = leftNumber % rightNumber
          break
        default:
          return primitiveFailure(
            'Evaluation.evaluatePrimitive',
            `${operation} is unavailable for ${left.type}`,
            span,
            trace,
          )
      }
    }
    const encoded = FloatingPoint.fromNumber(value, width)
    return admittedValue(
      environment,
      { _tag: 'FloatValue', type: left.type, bits: encoded.bits },
      'Evaluation.evaluatePrimitive',
      span,
      trace,
    )
  }
  return primitiveFailure(
    'Evaluation.evaluatePrimitive',
    `${operation} is unavailable for ${left._tag}`,
    span,
    trace,
  )
}

/** Constructs one scalar enum member after validating its fixed-width representation. */
export const constructEnum = (
  environment: TargetEnvironment,
  type: DeclarationFacts.CanonicalId,
  member: string,
  representation: Scalar.EnumRepresentationSpelling,
  discriminant: bigint,
  span: Location.Location,
  trace: Trace = [],
): Outcome<StaticValue.Value> =>
  admittedValue(
    environment,
    { _tag: 'EnumValue', type, member, representation, discriminant },
    'Evaluation.constructEnum',
    span,
    trace,
  )

/** Evaluates nominal scalar-enum equality after semantic typing has selected one enum. */
export const evaluateEnumEquality = (
  operation: 'Equals' | 'NotEquals',
  left: StaticValue.EnumValue,
  right: StaticValue.EnumValue,
  span: Location.Location,
  trace: Trace = [],
): Outcome<StaticValue.Value> => {
  if (left.type.module !== right.type.module || left.type.name !== right.type.name)
    return primitiveFailure(
      'Evaluation.evaluateEnumEquality',
      'enum equality operands must have the same nominal type',
      span,
      trace,
    )
  const equal = left.member === right.member && left.discriminant === right.discriminant
  return complete(StaticValue.boolean(operation === 'Equals' ? equal : !equal))
}

const staticTextFailure = (
  detail: string,
  literal: Location.Location,
  byteOffset: bigint,
  trace: Trace,
): Outcome<StaticValue.Value> => {
  const offset =
    byteOffset >= 0n && byteOffset <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(byteOffset) : 0
  return primitiveFailure(
    'Evaluation.inspectStaticText',
    detail,
    literal,
    appendTrace(trace, staticTextFrame(literal, offset)),
  )
}

/** Returns the UTF-8 byte length of one admitted static text as target-sized `usize`. */
export const staticTextByteLength = (
  environment: TargetEnvironment,
  text: StaticValue.TextValue,
  literal: Location.Location,
  trace: Trace = [],
): Outcome<StaticValue.Value> =>
  admittedValue(
    environment,
    { _tag: 'IntegerValue', type: 'usize', value: BigInt(text.bytes.length) },
    'Evaluation.inspectStaticText',
    literal,
    trace,
  )

/** Returns one UTF-8 byte from admitted static text as `u8`. */
export const staticTextByteAt = (
  environment: TargetEnvironment,
  text: StaticValue.TextValue,
  byteOffset: bigint,
  literal: Location.Location,
  trace: Trace = [],
): Outcome<StaticValue.Value> => {
  if (byteOffset < 0n || byteOffset >= BigInt(text.bytes.length))
    return staticTextFailure(
      `byte offset ${byteOffset.toString()} is outside length ${text.bytes.length}`,
      literal,
      byteOffset,
      trace,
    )
  const byte = text.bytes.at(Number(byteOffset))
  return byte === undefined
    ? staticTextFailure('static text byte is unavailable', literal, byteOffset, trace)
    : admittedValue(
        environment,
        { _tag: 'IntegerValue', type: 'u8', value: BigInt(byte) },
        'Evaluation.inspectStaticText',
        literal,
        trace,
      )
}

/** Concatenates two admitted static texts; each side keeps the provenance of its own bytes. */
export const staticTextConcat = (
  environment: TargetEnvironment,
  left: StaticValue.TextValue,
  right: StaticValue.TextValue,
  literal: Location.Location,
  trace: Trace = [],
): Outcome<StaticValue.Value> =>
  admittedValue(
    environment,
    {
      _tag: 'TextValue',
      bytes: [...left.bytes, ...right.bytes],
      ...(left.origin === undefined && right.origin === undefined
        ? {}
        : { origin: concatTextOrigin(left.origin, left.bytes.length, right.origin) }),
    },
    'Evaluation.staticTextConcat',
    literal,
    trace,
  )

/** Returns the half-open UTF-8 byte slice when both offsets lie on scalar boundaries. */
export const staticTextSlice = (
  environment: TargetEnvironment,
  text: StaticValue.TextValue,
  start: bigint,
  end: bigint,
  literal: Location.Location,
  trace: Trace = [],
): Outcome<StaticValue.Value> => {
  if (start < 0n || end < start || end > BigInt(text.bytes.length))
    return staticTextFailure(
      `byte range ${start.toString()}..${end.toString()} is outside length ${text.bytes.length}`,
      literal,
      start,
      trace,
    )
  return admittedValue(
    environment,
    {
      _tag: 'TextValue',
      bytes: text.bytes.slice(Number(start), Number(end)),
      ...(text.origin === undefined
        ? {}
        : { origin: sliceTextOrigin(text.origin, Number(start), Number(end)) }),
    },
    'Evaluation.inspectStaticText',
    literal,
    appendTrace(trace, staticTextFrame(literal, Number(start))),
  )
}

/** Constructs a recursively pure aggregate through the sole static-value admission boundary. */
export const constructAggregate = (
  environment: TargetEnvironment,
  identity: StaticValue.AggregateIdentity,
  fields: ReadonlyArray<StaticValue.AggregateField>,
  span: Location.Location,
  trace: Trace = [],
  runtimeFields?: ReadonlyArray<{
    readonly id: DeclarationFacts.FieldId
    readonly type: Type.Type
  }>,
): Outcome<StaticValue.Value> => {
  const outcome = admittedValue(
    environment,
    { _tag: 'AggregateValue', identity, fields },
    'Evaluation.constructAggregate',
    span,
    trace,
  )
  return outcome._tag === 'Complete' && outcome.value._tag === 'AggregateValue'
    ? complete({
        ...outcome.value,
        ...(runtimeFields === undefined
          ? {}
          : {
              runtimeFields: runtimeFields.map((field) => ({ ...field })),
            }),
      })
    : outcome
}

/** Reads one closed logical fact; selectors never interpret arbitrary compiler state. */
export const profileFact = (
  environment: TargetEnvironment,
  operation: string,
  arguments_: ReadonlyArray<StaticValue.Value>,
  span: Location.Location,
  trace: Trace = [],
): Outcome<StaticValue.Value> | undefined => {
  const profile = environment.compilation
  const target = profile.target
  const text = (value: string): Outcome<StaticValue.Value> =>
    complete({
      _tag: 'TextValue',
      bytes: [...new TextEncoder().encode(value)],
    })
  const integer = (value: number): Outcome<StaticValue.Value> =>
    complete({ _tag: 'IntegerValue', type: 'u32', value: BigInt(value) })
  switch (operation) {
    case 'targetArchitecture':
      return text(target.architecture)
    case 'targetOperatingSystem':
      return text(target.operatingSystem)
    case 'targetAbi':
      return text(target.abi)
    case 'targetObjectFormat':
      return text(target.objectFormat)
    case 'targetEndianness':
      return text(target.endianness)
    case 'targetPointerBits':
      return integer(environment.pointerBits)
    case 'targetPointerAlignment':
      return integer(target.pointerAlignment)
  }
  if (operation !== 'profileText' && operation !== 'profileFlag' && operation !== 'profileContains')
    return undefined
  const keyValue = arguments_[0]
  const key =
    keyValue?._tag === 'TextValue'
      ? new TextDecoder().decode(Uint8Array.from(keyValue.bytes))
      : undefined
  if (operation === 'profileText') {
    switch (key) {
      case 'cpu':
        return text(profile.cpu.model)
      case 'deployment':
        return text(profile.deployment ?? '')
      case 'libc':
        return text(profile.libc)
      case 'artifact':
        return text(profile.artifact)
      case 'entry-kind':
        return text(profile.entry.kind)
      case 'entry-name':
        return text(profile.entry.kind === 'named' ? profile.entry.name : '')
      case 'link':
        return text(profile.link)
      case 'code-model':
        return text(profile.codeModel)
      case 'relocation':
        return text(profile.relocation)
      case 'optimization':
        return text(profile.optimization)
      case 'safety':
        return text(profile.safety)
      case 'threading':
        return text(profile.threading)
      case 'unwind':
        return text(profile.unwind)
      case 'runtime-kind':
        return text(profile.runtime.kind)
      case 'runtime-name':
        return text(profile.runtime.kind === 'named' ? profile.runtime.name : '')
    }
  }
  if (operation === 'profileFlag' && key === 'debug')
    return complete(StaticValue.boolean(profile.debug))
  if (operation === 'profileContains') {
    const member = arguments_[1]
    let values: ReadonlyArray<string> | undefined
    if (key === 'cpu-features') values = profile.cpu.features
    if (key === 'sanitizers') values = profile.sanitizers
    if (values !== undefined && member?._tag === 'TextValue') {
      const value = new TextDecoder().decode(Uint8Array.from(member.bytes))
      return complete(StaticValue.boolean(values.some((candidate) => candidate === value)))
    }
  }
  return failed(
    phaseViolation('Evaluation.profileFact', 'unknown profile fact selector', span, trace),
  )
}

/** Stable environment key for one source parameter or local binding. */
const idKey = (id: {
  readonly function: DeclarationFacts.DeclarationId
  readonly ordinal: number
}) => `${id.function.sourceId}:${id.function.ordinal}:${id.ordinal}`

/** The key of a parameter's value in an evaluation environment. */
export const parameterKey = (id: DeclarationFacts.ParameterId): string => `parameter:${idKey(id)}`

/** The key of a `let` binding's value in an evaluation environment. */
export const bindingKey = (id: Tir.BindingId): string => `binding:${idKey(id)}`

/** The key of a pattern binding's value in an evaluation environment. */
export const patternKey = (id: Match.BindingId): string =>
  `pattern:${Tir.nodeRefKey(id.arm.match.node)}:${id.arm.ordinal}:${id.ordinal}`

/** The value key of one published TIR local. */
export const tirLocalKey = (id: Tir.LocalId): string => `local:${id.ordinal}`

export const localValueKey = (
  value:
    | DeclarationFacts.ParameterFact
    | Elaboration.BindingDeclarationFact
    | Elaboration.PatternBindingFact,
): string => {
  if (value._tag === 'PatternBinding') return patternKey(value.id)
  return value._tag === 'ParameterDeclaration' ? parameterKey(value.id) : bindingKey(value.id)
}

/**
 * What the evaluator reads besides the nodes it interprets.
 *
 * Nodes name declarations by id. `lookup` answers the header behind an id; it is the evaluator's
 * whole view of the program outside the body in hand.
 */
export interface NodeContext {
  readonly environment: TargetEnvironment
  /** Concrete declaration arguments retained while interpreting a generic static body. */
  readonly typeSubstitution?: Type.Substitution
  readonly lookup: (id: DeclarationFacts.CanonicalId) => DeclarationFacts.MemberFact | undefined
  readonly values: ReadonlyMap<string, StaticValue.Value>
  /** Source provenance retained separately from canonical value identity. */
  readonly valueSpans: ReadonlyMap<string, Location.Location>
  readonly valueOrigins: ReadonlyMap<string, TextOrigin>
  /** Per-node provenance retained outside canonical value identity. */
  readonly expressionSpans: Map<Tir.Expression, Location.Location>
  readonly expressionOrigins: Map<Tir.Expression, TextOrigin>
  /** Exact resolved semantic inputs read by nodes that static evaluation actually interprets. */
  readonly observeResolved?: (provenance: ResolvedProvenance) => void
  /** Return provenance written by one static-function statement evaluation. */
  readonly returnedTextSpan?: { value: Location.Location | undefined }
  readonly returnedTextOrigin?: { value: TextOrigin | undefined }
  readonly trace: Trace
  readonly reflect: (
    owner: Type.Type,
    kind: 'Type' | 'Fields',
    span: Location.Location,
    trace: Trace,
    lookup: NodeContext['lookup'],
  ) => Outcome<StaticValue.Value>
  readonly call: (
    declaration: DeclarationFacts.DeclarationFact,
    arguments_: ReadonlyArray<StaticValue.Value>,
    argumentSpans: ReadonlyArray<Location.Location | undefined>,
    argumentOrigins: ReadonlyArray<TextOrigin | undefined>,
    span: Location.Location,
    trace: Trace,
    identity: {
      readonly typeArguments: ReadonlyArray<Type.GenericArgument>
      readonly evidence: ReadonlyArray<string>
      readonly contractRow: ReadonlyArray<string>
    },
    lookup: NodeContext['lookup'],
  ) => CallResult
  readonly constant?: (
    declaration: DeclarationFacts.ConstantFact,
    span: Location.Location,
    trace: Trace,
  ) => Outcome<StaticValue.Value>
  readonly step?: (span: Location.Location, trace: Trace) => StaticFailure | undefined
  /** Present only after a valid discovery root has been selected and sealed. */
  readonly testCatalog?: TestDiscovery.Catalog
}

/** Resolved declarations and types retained independently from a folded static value. */
export interface ResolvedProvenance {
  readonly constants: ReadonlyArray<DeclarationFacts.CanonicalId>
  readonly types: ReadonlyArray<Type.Type>
}

export interface CallResult {
  readonly outcome: Outcome<StaticValue.Value>
  readonly textSpan?: Location.Location
  readonly textOrigin?: TextOrigin
}

/** Where a node reports: the authored position it was made for. */
const at = (node: { readonly origin: Tir.Origin }): Location.Location =>
  Location.at(node.origin.anchor)

const unavailable = (
  node: { readonly origin: Tir.Origin },
  context: NodeContext,
  detail: string,
): Outcome<StaticValue.Value> =>
  primitiveFailure('Evaluation.evaluate', detail, at(node), context.trace)

const evaluateAll = (
  nodes: ReadonlyArray<Tir.Expression>,
  context: NodeContext,
): ExecutionOutcome<ReadonlyArray<StaticValue.Value>> => {
  const values: Array<StaticValue.Value> = []
  for (const node of nodes) {
    const evaluated = evaluateExpression(node, context)
    if (evaluated._tag !== 'Complete') return evaluated
    values.push(evaluated.value)
  }
  return complete(values)
}

const typeArgumentAt = (
  node: Extract<Tir.Expression, { readonly _tag: 'StaticIntrinsic' }>,
  ordinal: number,
  substitution: Type.Substitution = new Map(),
): Type.Type | undefined => {
  const argument = node.typeArguments.at(ordinal)
  if (argument === undefined) return undefined
  const specialized = Type.substituteGenericArgument(argument, substitution)
  return Type.isTypeArgument(specialized) ? specialized : undefined
}

const reflectedAggregateKindCode = (kind: StaticValue.AggregateKind): bigint => {
  switch (kind) {
    case 'Named':
      return 0n
    case 'Positional':
      return 1n
    case 'AnonymousNamed':
      return 2n
    case 'AnonymousPositional':
      return 3n
  }
}

/** A conversion or a move changes how a value is held, never which text it is. */
const transparent = (node: Tir.Expression): Tir.Expression | undefined => {
  if (node._tag === 'Move') return node.subject
  if (node._tag === 'UnionConvert') return node.source
  return undefined
}

const localKeyOf = (node: Tir.Expression): string | undefined => {
  if (node._tag === 'ParameterReference') return tirLocalKey(node.parameter)
  if (node._tag === 'BindingReference' || node._tag === 'PatternBindingReference')
    return tirLocalKey(node.binding)
  return undefined
}

const isTextOperation = (node: Tir.Expression): boolean =>
  node._tag === 'StaticIntrinsic' &&
  (node.operation === 'staticTextSlice' || node.operation === 'staticTextConcat')

/** The literal a static text value was written as, when one expression still names it. */
const staticTextSpan = (
  node: Tir.Expression,
  context: NodeContext,
): Location.Location | undefined => {
  const evaluated = context.expressionSpans.get(node)
  if (evaluated !== undefined) return evaluated
  if (node._tag === 'StaticCall' && node.text !== undefined) return node.text
  if (node._tag === 'StaticStringLiteral') return at(node)
  const inner = transparent(node)
  if (inner !== undefined) return staticTextSpan(inner, context)
  const local = localKeyOf(node)
  if (local !== undefined) return context.valueSpans.get(local)
  if (node._tag === 'StaticIntrinsic' && isTextOperation(node)) {
    const subject = node.arguments.at(0)
    return subject === undefined ? undefined : staticTextSpan(subject, context)
  }
  return undefined
}

/** Resolves static-text provenance for one node without changing value identity. */
export interface TextOriginContext {
  readonly valueOrigins: ReadonlyMap<string, TextOrigin>
  readonly expressionOrigins: ReadonlyMap<Tir.Expression, TextOrigin>
}

export const staticTextOrigin = (
  node: Tir.Expression,
  context: TextOriginContext,
): TextOrigin | undefined => {
  const evaluated = context.expressionOrigins.get(node)
  if (evaluated !== undefined) return evaluated
  if (node._tag === 'StaticCall' && node.textOrigin !== undefined) return node.textOrigin
  if (node._tag === 'StaticStringLiteral')
    return node.textOrigin ?? sourceTextOrigin(node.origin.anchor, node.data.bytes.length)
  const inner = transparent(node)
  if (inner !== undefined) return staticTextOrigin(inner, context)
  const local = localKeyOf(node)
  if (local !== undefined) return context.valueOrigins.get(local)
  if (node._tag === 'StaticIntrinsic' && isTextOperation(node)) {
    const subject = node.arguments.at(0)
    return subject === undefined ? undefined : staticTextOrigin(subject, context)
  }
  return undefined
}

const valueHasType = (value: StaticValue.Value, type: Type.Type): boolean => {
  if (value._tag === 'UnitValue') return Type.equals(type, Type.unit)
  if (Type.isNominal(type)) {
    if (value._tag === 'EnumValue')
      return value.type.module === type.module && value.type.name === type.name
    return (
      value._tag === 'AggregateValue' &&
      value.identity._tag === 'NominalAggregateIdentity' &&
      value.identity.declaration.module === type.module &&
      value.identity.declaration.name === type.name &&
      value.identity.typeArguments.length === type.arguments.length &&
      value.identity.typeArguments.every((argument, ordinal) => {
        const expected = type.arguments.at(ordinal)
        return expected !== undefined && argument === Type.genericArgumentKey(expected)
      })
    )
  }
  switch (value._tag) {
    case 'IntegerValue':
    case 'FloatValue':
      return type === value.type
    case 'BooleanValue':
      return type === 'bool'
    case 'CharacterValue':
      return type === 'char'
    default:
      return false
  }
}

/** Whether a value is the inhabitant one coverage member names. */
const inhabits = (
  value: StaticValue.Value,
  member: Match.CoverageIdentity,
  context: NodeContext,
): boolean => {
  const substitution = context.typeSubstitution ?? new Map()
  if (member._tag === 'EnumMember')
    return (
      value._tag === 'EnumValue' &&
      value.type.module === member.enum.module &&
      value.type.name === member.enum.name &&
      value.member === member.member.name
    )
  if (member._tag === 'NominalUnionVariant')
    return (
      valueHasType(value, Type.substitute(member.type, substitution)) &&
      value._tag === 'AggregateValue' &&
      value.identity._tag === 'NominalAggregateIdentity' &&
      value.identity.variant?.ordinal === member.variantOrdinal
    )
  return valueHasType(value, Type.substitute(member.type, substitution))
}

const valueAt = (
  value: StaticValue.Value,
  path: ReadonlyArray<DeclarationFacts.FieldId>,
): StaticValue.Value | undefined => {
  let current: StaticValue.Value | undefined = value
  for (const field of path)
    current =
      current?._tag === 'AggregateValue'
        ? current.fields.find((candidate) => candidate.ordinal === field.ordinal)?.value
        : undefined
  return current
}

interface Selection {
  readonly member?: Match.CoverageIdentity
  readonly integer?: bigint
  readonly universal: boolean
  readonly tests?: ReadonlyArray<Match.PatternTest>
}

/** Whether one arm or `let` pattern selects a value: its member, then every nested test. */
const selects = (selection: Selection, value: StaticValue.Value, context: NodeContext): boolean => {
  if (selection.integer !== undefined)
    return value._tag === 'IntegerValue' && value.value === selection.integer
  if (!selection.universal) {
    if (selection.member === undefined || !inhabits(value, selection.member, context)) return false
  }
  return (selection.tests ?? []).every((test) => {
    const nested = valueAt(value, test.path)
    return nested !== undefined && inhabits(nested, test.member, context)
  })
}

/** Pattern ids are lexical, so adding provisional values cannot shadow another arm's bindings. */
const bindPattern = (
  bindings: ReadonlyArray<Tir.PatternBinding>,
  scrutinee: StaticValue.Value,
  context: NodeContext,
): Outcome<NodeContext> => {
  const values = context.values instanceof Map ? context.values : new Map(context.values)
  for (const binding of bindings) {
    const value = valueAt(scrutinee, binding.path)
    if (value === undefined)
      return failed(
        phaseViolation(
          'Evaluation.bindPattern',
          'selected pattern binding has no static payload',
          at(binding),
          context.trace,
        ),
      )
    values.set(tirLocalKey(binding.id), value)
  }
  return complete({ ...context, values })
}

/** Evaluates a node at a static application boundary, where no lexical transfer may escape. */
export const evaluateNode = (
  node: Tir.Expression,
  context: NodeContext,
): Outcome<StaticValue.Value> => {
  const result = evaluateExpression(node, context)
  return result._tag === 'Transfer'
    ? unavailable(node, context, 'control transfer has no enclosing static statement context')
    : result
}

const primitiveOf = (operation: string): PrimitiveOperation | undefined => {
  const name = operation.slice(operation.lastIndexOf('.') + 1)
  switch (name) {
    case 'Add':
    case 'Subtract':
    case 'Multiply':
    case 'Divide':
    case 'Remainder':
    case 'Negate':
    case 'Equals':
    case 'NotEquals':
    case 'LessThan':
    case 'LessOrEqual':
    case 'GreaterThan':
    case 'GreaterOrEqual':
    case 'Not':
      return name
    default:
      return undefined
  }
}

const runtimeFieldsOf = (
  fields: ReadonlyArray<DeclarationFacts.FieldFact>,
  parameters: ReadonlyArray<DeclarationFacts.TypeParameterFact>,
  arguments_: ReadonlyArray<Type.GenericArgument>,
) => {
  const substitution =
    TypeInference.substitution(
      parameters.map((parameter) => parameter.type),
      arguments_,
    ) ?? new Map<string, Type.GenericArgument>()
  return fields.flatMap((field) =>
    field.declaredType._tag === 'Resolved'
      ? [
          {
            id: field.id,
            type: Type.substitute(field.declaredType.type, substitution),
          },
        ]
      : [],
  )
}

const evaluateIntrinsic = (
  node: Extract<Tir.Expression, { readonly _tag: 'StaticIntrinsic' }>,
  arguments_: ReadonlyArray<StaticValue.Value>,
  context: NodeContext,
): Outcome<StaticValue.Value> => {
  const operation = node.operation
  const testEntry = (
    descriptor: StaticValue.TestDescriptorValue,
  ): TestDiscovery.Entry | undefined =>
    context.testCatalog?.identity === descriptor.authorization
      ? context.testCatalog.entries.find(
          (entry) =>
            entry.declaration.canonical._tag === 'Canonical' &&
            entry.declaration.canonical.id.module === descriptor.declaration.module &&
            entry.declaration.canonical.id.name === descriptor.declaration.name &&
            Type.equals(entry.callable, descriptor.callable),
        )
      : undefined
  if (operation === 'tests') {
    if (context.testCatalog === undefined)
      return unavailable(node, context, 'tests requires a sealed discovery context')
    return admittedValue(
      context.environment,
      {
        _tag: 'TestCollectionValue',
        tests: context.testCatalog.entries.flatMap((entry) =>
          entry.declaration.canonical._tag !== 'Canonical'
            ? []
            : [
                {
                  _tag: 'TestDescriptorValue',
                  declaration: entry.declaration.canonical.id,
                  callable: entry.callable,
                  authorization: context.testCatalog?.identity ?? '',
                },
              ],
        ),
      },
      'Evaluation.tests',
      at(node),
      context.trace,
    )
  }
  if (operation === 'testInfo') {
    const descriptor = arguments_.at(0)
    if (descriptor?._tag !== 'TestDescriptorValue')
      return unavailable(node, context, 'testInfo requires one test descriptor')
    const entry = testEntry(descriptor)
    if (entry === undefined)
      return unavailable(node, context, 'testInfo received a descriptor outside this catalog')
    const info = entry.info
    const text = (value: string): StaticValue.TextValue => ({
      _tag: 'TextValue',
      bytes: Array.from(new TextEncoder().encode(value)),
    })
    const values: ReadonlyArray<StaticValue.Value> = [
      text(info.identity),
      text(info.name),
      text(info.module),
      text(info.path),
      { _tag: 'IntegerValue', type: 'usize', value: BigInt(info.line) },
      { _tag: 'IntegerValue', type: 'usize', value: BigInt(info.column) },
      text(info.fingerprint),
    ]
    const ordinal = Type.intrinsicNominalOrdinal(Type.testInfo)
    const declaration: DeclarationFacts.DeclarationId = {
      _tag: 'DeclarationId',
      sourceId: 'Intrinsic',
      ordinal,
    }
    const fieldTypes: ReadonlyArray<Type.Type> = [
      Type.string(Lifetime.staticLifetime),
      Type.string(Lifetime.staticLifetime),
      Type.string(Lifetime.staticLifetime),
      Type.string(Lifetime.staticLifetime),
      'usize',
      'usize',
      Type.string(Lifetime.staticLifetime),
    ]
    return admittedValue(
      context.environment,
      {
        _tag: 'AggregateValue',
        identity: {
          _tag: 'NominalAggregateIdentity',
          declaration: { _tag: 'CanonicalDeclarationId', module: 'Intrinsic', name: 'TestInfo' },
          typeArguments: [],
        },
        fields: values.map((value, field) => ({ ordinal: field, value })),
        runtimeFields: fieldTypes.map((type, field) => ({
          id: {
            _tag: 'FieldId',
            owner: { _tag: 'StructFieldOwnerId', declaration },
            ordinal: field,
          },
          type,
        })),
      },
      'Evaluation.testInfo',
      at(node),
      context.trace,
    )
  }
  const profile = profileFact(context.environment, operation, arguments_, at(node), context.trace)
  if (profile !== undefined) return profile
  const typeArgument = typeArgumentAt(node, 0, context.typeSubstitution)
  if (operation === 'reflectType' || operation === 'reflectFields') {
    if (typeArgument === undefined)
      return unavailable(node, context, `${operation} requires one concrete owner type`)
    return context.reflect(
      typeArgument,
      operation === 'reflectType' ? 'Type' : 'Fields',
      at(node),
      context.trace,
      context.lookup,
    )
  }
  const admit = (value: unknown, name: string) =>
    admittedValue(context.environment, value, `Evaluation.${name}`, at(node), context.trace)
  if (operation === 'reflectTypeKind') {
    const descriptor = arguments_.at(0)
    if (descriptor?._tag !== 'TypeDescriptorValue')
      return unavailable(node, context, `${operation} requires one type descriptor`)
    return admit(
      { _tag: 'IntegerValue', type: 'u8', value: reflectedAggregateKindCode(descriptor.kind) },
      operation,
    )
  }
  if (operation.startsWith('reflectField')) {
    const descriptor = arguments_.at(0)
    if (descriptor?._tag !== 'FieldDescriptorValue')
      return unavailable(node, context, `${operation} requires one field descriptor`)
    if (operation === 'reflectFieldKind')
      return admit(
        {
          _tag: 'IntegerValue',
          type: 'u8',
          value: descriptor.member._tag === 'LabeledField' ? 0n : 1n,
        },
        operation,
      )
    if (operation === 'reflectFieldLabel')
      return descriptor.member._tag === 'LabeledField'
        ? admit(
            {
              _tag: 'TextValue',
              bytes: Array.from(new TextEncoder().encode(descriptor.member.label)),
            },
            operation,
          )
        : unavailable(node, context, `${operation} cannot read a positional field`)
    if (operation === 'reflectFieldOrdinal')
      return descriptor.member._tag === 'PositionalField'
        ? admit(
            { _tag: 'IntegerValue', type: 'usize', value: BigInt(descriptor.member.ordinal) },
            operation,
          )
        : unavailable(node, context, `${operation} cannot read a labeled field`)
    return unavailable(node, context, `${operation} is not admitted reflection metadata`)
  }
  if (operation === 'staticSequenceEmpty') {
    if (typeArgument === undefined)
      return unavailable(node, context, `${operation} requires one concrete element type`)
    return admit(StaticValue.emptySequence(typeArgument), operation)
  }
  if (operation.startsWith('staticSequence')) {
    if (typeArgument === undefined)
      return unavailable(node, context, `${operation} requires one concrete element type`)
    const sequence = arguments_.at(0)
    if (sequence?._tag !== 'StaticSequenceValue')
      return unavailable(node, context, `${operation} requires one static sequence`)
    if (operation === 'staticSequenceLength')
      return admit(
        {
          _tag: 'IntegerValue',
          type: 'usize',
          value: BigInt(StaticValue.sequenceLength(sequence)),
        },
        operation,
      )
    if (operation === 'staticSequenceAppend') {
      const value = arguments_.at(1)
      if (value === undefined)
        return unavailable(node, context, `${operation} requires one static value`)
      const appended = StaticValue.appendSequence(sequence, typeArgument, value)
      return appended === undefined
        ? unavailable(node, context, `${operation} element type does not match`)
        : admit(appended, operation)
    }
    if (operation === 'staticSequenceConcat') {
      const right = arguments_.at(1)
      if (right?._tag !== 'StaticSequenceValue')
        return unavailable(node, context, `${operation} requires two static sequences`)
      const concatenated = StaticValue.concatenateSequences(sequence, right)
      return concatenated === undefined
        ? unavailable(node, context, `${operation} element types do not match`)
        : admit(concatenated, operation)
    }
    if (operation === 'staticSequenceAt') {
      const index = arguments_.at(1)
      if (
        index?._tag !== 'IntegerValue' ||
        index.value < 0n ||
        index.value > BigInt(Number.MAX_SAFE_INTEGER)
      )
        return unavailable(node, context, `${operation} requires one static index`)
      const element = StaticValue.sequenceElement(sequence, Number(index.value))
      return element === undefined
        ? unavailable(node, context, `${operation} index is out of bounds`)
        : complete(element)
    }
    return unavailable(node, context, `${operation} is not an admitted sequence operation`)
  }
  const text = arguments_.at(0)
  const argument = node.arguments.at(0)
  const literal =
    (argument === undefined ? undefined : staticTextSpan(argument, context)) ?? at(node)
  if (text?._tag !== 'TextValue')
    return unavailable(node, context, `${operation} requires static text`)
  if (operation === 'staticTextByteLength')
    return staticTextByteLength(context.environment, text, literal, context.trace)
  if (operation === 'staticTextConcat') {
    const right = arguments_.at(1)
    if (right?._tag !== 'TextValue')
      return unavailable(node, context, `${operation} requires two static texts`)
    const concatenated = staticTextConcat(context.environment, text, right, literal, context.trace)
    if (concatenated._tag === 'Complete') {
      const rightArgument = node.arguments.at(1)
      const origin = concatTextOrigin(
        argument === undefined ? undefined : staticTextOrigin(argument, context),
        text.bytes.length,
        rightArgument === undefined ? undefined : staticTextOrigin(rightArgument, context),
      )
      if (origin !== undefined) context.expressionOrigins.set(node, origin)
      context.expressionSpans.set(node, literal)
      if (origin !== undefined && concatenated.value._tag === 'TextValue')
        return complete({ ...concatenated.value, origin })
    }
    return concatenated
  }
  const first = arguments_.at(1)
  if (first?._tag !== 'IntegerValue')
    return unavailable(node, context, `${operation} requires a static index`)
  if (operation === 'staticTextByteAt')
    return staticTextByteAt(context.environment, text, first.value, literal, context.trace)
  const second = arguments_.at(2)
  if (operation === 'staticTextSlice' && second?._tag === 'IntegerValue') {
    const sliced = staticTextSlice(
      context.environment,
      text,
      first.value,
      second.value,
      literal,
      context.trace,
    )
    if (sliced._tag === 'Complete') {
      const origin = argument === undefined ? undefined : staticTextOrigin(argument, context)
      const slicedOrigin =
        origin === undefined
          ? undefined
          : sliceTextOrigin(origin, Number(first.value), Number(second.value))
      if (slicedOrigin !== undefined) context.expressionOrigins.set(node, slicedOrigin)
      context.expressionSpans.set(node, literal)
      if (slicedOrigin !== undefined && sliced.value._tag === 'TextValue')
        return complete({ ...sliced.value, origin: slicedOrigin })
    }
    return sliced
  }
  return unavailable(node, context, `${operation} is not admitted statically`)
}

/** Evaluates one typed node without consulting a runtime engine. */
const evaluateExpression = (
  node: Tir.Expression,
  context: NodeContext,
): ExecutionOutcome<StaticValue.Value> => {
  const types: Array<Type.Type> = 'type' in node ? [node.type] : []
  if ('typeArguments' in node)
    for (const argument of node.typeArguments)
      if (Type.isTypeArgument(argument)) types.push(argument)
  const constant =
    node.constant ?? (node._tag === 'ConstantReference' ? node.declaration : undefined)
  if (constant !== undefined || types.length > 0)
    context.observeResolved?.({
      constants: constant === undefined ? [] : [constant],
      types,
    })
  const admit = (value: unknown) =>
    admittedValue(context.environment, value, 'Evaluation.evaluate', at(node), context.trace)
  switch (node._tag) {
    case 'UnitLiteral':
      return complete(StaticValue.unit())
    case 'BooleanLiteral':
      return complete(StaticValue.boolean(node.value))
    case 'CharacterLiteral':
      return admit({ _tag: 'CharacterValue', value: node.value })
    case 'IntegerLiteral':
      return typeof node.type === 'string' && Scalar.isIntegerSpelling(node.type)
        ? admit({ _tag: 'IntegerValue', type: node.type, value: node.value })
        : unavailable(node, context, 'integer value is unavailable')
    case 'FloatingLiteral':
      return admit({ _tag: 'FloatValue', type: node.type, bits: node.bits })
    case 'StaticStringLiteral':
      return admit({
        _tag: 'TextValue',
        bytes: node.data.bytes,
        origin: node.textOrigin ?? sourceTextOrigin(node.origin.anchor, node.data.bytes.length),
      })
    case 'ConstantReference': {
      const declaration = context.lookup(node.declaration)
      return context.constant !== undefined &&
        (declaration?._tag === 'ConstantDeclaration' ||
          declaration?._tag === 'PackageParameterDeclaration')
        ? context.constant(declaration, at(node), context.trace)
        : unavailable(node, context, 'constant has no selected static value')
    }
    case 'Move':
      return evaluateExpression(node.subject, context)
    case 'UnionConvert':
      // A static value of a union is the member value itself; widening changes no value.
      return evaluateExpression(node.source, context)
    case 'Match': {
      const scrutinee = evaluateExpression(node.scrutinee, context)
      if (scrutinee._tag !== 'Complete') return scrutinee
      for (const arm of node.arms) {
        if (!arm.reachable || !selects(arm, scrutinee.value, context)) continue
        const bound = bindPattern(arm.bindings, scrutinee.value, context)
        if (bound._tag === 'Failed') return bound
        if (arm.guard !== undefined) {
          const guard = evaluateExpression(arm.guard, bound.value)
          if (guard._tag !== 'Complete') return guard
          if (guard.value._tag !== 'BooleanValue')
            return unavailable(node, context, 'match guard is not bool')
          if (!guard.value.value) continue
        }
        return arm.body._tag === 'Expression'
          ? evaluateExpression(arm.body.expression, bound.value)
          : evaluateStatementSequence(arm.body.statements, bound.value)
      }
      return unavailable(node, context, 'match has no selected arm')
    }
    case 'Construct':
    case 'ConstructUnionVariant': {
      const fields: Array<StaticValue.AggregateField> = []
      for (const field of node.fields) {
        const value = evaluateExpression(field.value, context)
        if (value._tag !== 'Complete') return value
        fields.push({ ordinal: field.field.ordinal, value: value.value })
      }
      fields.sort((left, right) => left.ordinal - right.ordinal)
      const declaration = context.lookup({
        _tag: 'CanonicalDeclarationId',
        module: node.nominal.module,
        name: node.nominal.name,
      })
      const identity = {
        _tag: 'NominalAggregateIdentity' as const,
        declaration: {
          _tag: 'CanonicalDeclarationId' as const,
          module: node.nominal.module,
          name: node.nominal.name,
        },
        typeArguments: node.nominal.arguments.map(Type.genericArgumentKey),
      }
      if (node._tag === 'Construct') {
        if (declaration?._tag !== 'StructDeclaration')
          return unavailable(node, context, 'struct value is unavailable')
        return constructAggregate(
          context.environment,
          identity,
          fields,
          at(node),
          context.trace,
          runtimeFieldsOf(declaration.fields, declaration.typeParameters, node.nominal.arguments),
        )
      }
      const variant =
        declaration?._tag === 'UnionDeclaration'
          ? declaration.variants.find((candidate) => candidate.id.ordinal === node.variantOrdinal)
          : undefined
      if (declaration?._tag !== 'UnionDeclaration' || variant === undefined)
        return unavailable(node, context, 'union value is unavailable')
      return constructAggregate(
        context.environment,
        {
          ...identity,
          variant: { ordinal: node.variantOrdinal, name: node.variant.name },
        },
        fields,
        at(node),
        context.trace,
        runtimeFieldsOf(variant.fields, declaration.typeParameters, node.nominal.arguments),
      )
    }
    case 'ArrayConstruct': {
      const fields: Array<StaticValue.AggregateField> = []
      for (const [ordinal, element] of node.elements.entries()) {
        const value = evaluateExpression(element, context)
        if (value._tag !== 'Complete') return value
        fields.push({ ordinal, value: value.value })
      }
      return constructAggregate(
        context.environment,
        {
          _tag: 'ArrayAggregateIdentity',
          element: Type.key(node.type.element),
          length: node.type.length,
        },
        fields,
        at(node),
        context.trace,
      )
    }
    case 'Project': {
      const subject = evaluateExpression(node.subject, context)
      if (subject._tag !== 'Complete') return subject
      if (subject.value._tag !== 'AggregateValue')
        return unavailable(node, context, 'field projection depends on runtime storage')
      const field = subject.value.fields.find(
        (candidate) => candidate.ordinal === node.field.ordinal,
      )
      return field === undefined
        ? unavailable(node, context, 'projected static field has no admitted value')
        : complete(field.value)
    }
    case 'IndexPlace': {
      const subject = evaluateExpression(node.subject, context)
      if (subject._tag !== 'Complete') return subject
      const index = evaluateStaticIndex(node.index, node.array, node, context)
      if (index._tag !== 'Complete') return index
      if (
        subject.value._tag !== 'AggregateValue' ||
        subject.value.identity._tag !== 'ArrayAggregateIdentity'
      )
        return unavailable(node, context, 'array projection depends on runtime storage')
      const field = subject.value.fields.find((candidate) => candidate.ordinal === index.value)
      return field === undefined
        ? unavailable(node, context, 'projected static element has no admitted value')
        : complete(field.value)
    }
    case 'ParameterReference':
    case 'BindingReference':
    case 'PatternBindingReference': {
      const key = localKeyOf(node)
      const value = key === undefined ? undefined : context.values.get(key)
      if (value === undefined)
        return unavailable(node, context, 'identifier depends on runtime storage')
      const origin = staticTextOrigin(node, context)
      return value._tag === 'TextValue' && origin !== undefined
        ? complete({ ...value, origin })
        : complete(value)
    }
    case 'EnumMember': {
      const declaration = context.lookup(node.enum)
      if (
        declaration?._tag !== 'EnumDeclaration' ||
        declaration.representation._tag !== 'Available'
      )
        return unavailable(node, context, 'enum member is unavailable')
      return constructEnum(
        context.environment,
        node.enum,
        node.member.name,
        declaration.representation.scalar.spelling,
        node.discriminant,
        at(node),
        context.trace,
      )
    }
    case 'ShortCircuit': {
      const selected = evaluateExpression(node.left, context)
      if (selected._tag !== 'Complete') return selected
      if (selected.value._tag !== 'BooleanValue')
        return unavailable(node, context, 'short-circuit condition is not bool')
      if (node.operator === 'And' && !selected.value.value) return selected
      if (node.operator === 'Or' && selected.value.value) return selected
      return evaluateExpression(node.right, context)
    }
    case 'EnumEquality':
    case 'StringEquality': {
      const operands = evaluateAll([node.left, node.right], context)
      if (operands._tag !== 'Complete') return operands
      const left = operands.value.at(0)
      const right = operands.value.at(1)
      const operator = node.negated ? 'NotEquals' : 'Equals'
      return left?._tag === 'EnumValue' && right?._tag === 'EnumValue'
        ? evaluateEnumEquality(operator, left, right, at(node), context.trace)
        : evaluatePrimitive(context.environment, operator, operands.value, at(node), context.trace)
    }
    case 'BuiltinCall': {
      const operands = evaluateAll(node.arguments, context)
      if (operands._tag !== 'Complete') return operands
      const operator = primitiveOf(node.operation)
      return operator === undefined
        ? unavailable(node, context, `${node.operation} is not admitted statically`)
        : evaluatePrimitive(context.environment, operator, operands.value, at(node), context.trace)
    }
    case 'StaticIntrinsic': {
      const arguments_ = evaluateAll(node.arguments, context)
      if (arguments_._tag !== 'Complete') return arguments_
      return evaluateIntrinsic(node, arguments_.value, context)
    }
    case 'StaticCall': {
      if (node.failure !== undefined) return failed(node.failure)
      const arguments_ = evaluateAll(node.arguments, context)
      if (arguments_._tag !== 'Complete') return arguments_
      const declaration = context.lookup(node.target)
      if (declaration?._tag !== 'FunctionDeclaration')
        return unavailable(node, context, 'static call target is unavailable')
      const called = context.call(
        declaration,
        arguments_.value,
        node.arguments.map((argument) => staticTextSpan(argument, context)),
        node.arguments.map((argument, ordinal) => {
          const value = arguments_.value.at(ordinal)
          return (
            staticTextOrigin(argument, context) ??
            (value?._tag === 'TextValue' ? value.origin : undefined)
          )
        }),
        at(node),
        context.trace,
        {
          typeArguments: node.typeArguments.map((argument) =>
            Type.substituteGenericArgument(argument, context.typeSubstitution ?? new Map()),
          ),
          evidence: node.evidence,
          contractRow: [],
        },
        context.lookup,
      )
      if (called.textSpan !== undefined) context.expressionSpans.set(node, called.textSpan)
      if (called.textOrigin !== undefined) context.expressionOrigins.set(node, called.textOrigin)
      return called.outcome
    }
    case 'Call':
      return unavailable(node, context, 'ordinary calls are runtime operations')
    case 'CompileError': {
      const message = evaluateExpression(node.message, context)
      if (message._tag !== 'Complete') return message
      if (message.value._tag !== 'TextValue')
        return unavailable(node, context, 'compileError message must be static text')
      const origin = staticTextOrigin(node.message, context) ?? message.value.origin
      return failed(
        compileError(
          new TextDecoder().decode(Uint8Array.from(message.value.bytes)),
          (origin === undefined ? undefined : textOriginLocation(origin, node.origin.anchor)) ??
            at(node),
          context.trace,
          origin,
        ),
      )
    }
    default:
      return unavailable(node, context, `${node._tag} is not admitted statically`)
  }
}

type StatementControl =
  | { readonly _tag: 'Return'; readonly value: StaticValue.Value }
  | { readonly _tag: 'Break' | 'Continue'; readonly target: Tir.LoopId | undefined }

export type ExecutionOutcome<A> =
  | Outcome<A>
  | {
      readonly _tag: 'Transfer'
      readonly span: Location.Location
      readonly control: StatementControl
    }

const evaluateStaticIndex = (
  index: Tir.Expression,
  array: Type.FixedArray,
  node: { readonly origin: Tir.Origin },
  context: NodeContext,
): ExecutionOutcome<number> => {
  const evaluated = evaluateExpression(index, context)
  if (evaluated._tag !== 'Complete') return evaluated
  if (
    evaluated.value._tag !== 'IntegerValue' ||
    evaluated.value.value < 0n ||
    evaluated.value.value >= BigInt(array.length)
  )
    return failed(
      phaseViolation(
        'Evaluation.evaluate',
        'array projection requires an in-bounds static index',
        at(node),
        context.trace,
      ),
    )
  return complete(Number(evaluated.value.value))
}

/** Resolves destination selectors before evaluating the incoming value, as ordinary writes do. */
const staticWritePath = (
  place: Tir.OwnedWritePlace,
  context: NodeContext,
): ExecutionOutcome<ReadonlyArray<number>> => {
  const path: Array<number> = []
  for (const selector of place.selectors) {
    if (selector._tag === 'Field') {
      path.push(selector.field.ordinal)
      continue
    }
    const index = evaluateStaticIndex(selector.index, selector.array, place, context)
    if (index._tag !== 'Complete') return index
    path.push(index.value)
  }
  return complete(path)
}

const replaceStaticPlace = (
  current: StaticValue.Value | undefined,
  path: ReadonlyArray<number>,
  incoming: StaticValue.Value,
  span: Location.Location,
  context: NodeContext,
): Outcome<StaticValue.Value> => {
  const ordinal = path.at(0)
  if (ordinal === undefined) return complete(incoming)
  const field =
    current?._tag === 'AggregateValue'
      ? current.fields.find((candidate) => candidate.ordinal === ordinal)
      : undefined
  if (current?._tag !== 'AggregateValue' || field === undefined)
    return failed(
      phaseViolation(
        'Evaluation.evaluateStatements',
        'assignment projection has no admitted static storage',
        span,
        context.trace,
      ),
    )
  const nested = replaceStaticPlace(field.value, path.slice(1), incoming, span, context)
  if (nested._tag !== 'Complete') return nested
  return constructAggregate(
    context.environment,
    current.identity,
    current.fields.map((candidate) =>
      candidate.ordinal === ordinal ? { ...candidate, value: nested.value } : candidate,
    ),
    span,
    context.trace,
    current.runtimeFields,
  )
}

const sameLoop = (left: Tir.LoopId | undefined, right: Tir.LoopId): boolean =>
  left !== undefined &&
  left.ordinal === right.ordinal &&
  left.function.sourceId === right.function.sourceId &&
  left.function.ordinal === right.function.ordinal

const writeRootKey = (root: Tir.OwnedWriteRoot): string => {
  if (root._tag === 'BindingWriteRoot' || root._tag === 'PatternWriteRoot')
    return tirLocalKey(root.binding)
  return tirLocalKey(root.parameter)
}

/** Interprets a checked statement sequence while retaining its lexical control transfer. */
export const evaluateStatementSequence = (
  statements: ReadonlyArray<Tir.Statement>,
  context: NodeContext,
): ExecutionOutcome<StaticValue.Value> => {
  const values = context.values instanceof Map ? context.values : new Map(context.values)
  const valueSpans =
    context.valueSpans instanceof Map ? context.valueSpans : new Map(context.valueSpans)
  const valueOrigins =
    context.valueOrigins instanceof Map ? context.valueOrigins : new Map(context.valueOrigins)
  const contextual: NodeContext = {
    ...context,
    values,
    valueSpans,
    valueOrigins,
  }
  const remember = (key: string, source: Tir.Expression): void => {
    const span = staticTextSpan(source, contextual)
    if (span === undefined) valueSpans.delete(key)
    else valueSpans.set(key, span)
    const origin = staticTextOrigin(source, contextual)
    if (origin === undefined) valueOrigins.delete(key)
    else valueOrigins.set(key, origin)
  }
  const notBool = (condition: Tir.Expression, what: string) =>
    failed(
      phaseViolation(
        'Evaluation.evaluateStatements',
        `${what} condition is not bool`,
        at(condition),
        context.trace,
      ),
    )
  for (const statement of statements) {
    const exhausted = context.step?.(at(statement), context.trace)
    if (exhausted !== undefined) return failed(exhausted)
    switch (statement._tag) {
      case 'Unsafe': {
        const nested = evaluateStatementSequence(statement.statements, contextual)
        if (nested._tag !== 'Complete') return nested
        continue
      }
      case 'Bind': {
        const value = evaluateExpression(statement.initializer, contextual)
        if (value._tag !== 'Complete') return value
        const key = tirLocalKey(statement.binding)
        values.set(key, value.value)
        remember(key, statement.initializer)
        continue
      }
      case 'Evaluate':
      case 'Drop': {
        const value = evaluateExpression(statement.expression, contextual)
        if (value._tag !== 'Complete') return value
        if (
          statement._tag === 'Evaluate' &&
          statement.staticSelection !== undefined &&
          (value.value._tag !== 'BooleanValue' || value.value.value !== statement.staticSelection)
        )
          return failed(
            phaseViolation(
              'changing a checked static selection inside ordinary control',
              'per-execution static arm elaboration is not implemented',
              at(statement),
              context.trace,
            ),
          )
        continue
      }
      case 'Return': {
        const value = evaluateExpression(statement.expression, contextual)
        if (value._tag !== 'Complete') return value
        if (context.returnedTextSpan !== undefined)
          context.returnedTextSpan.value = staticTextSpan(statement.expression, contextual)
        if (context.returnedTextOrigin !== undefined)
          context.returnedTextOrigin.value = staticTextOrigin(statement.expression, contextual)
        return {
          _tag: 'Transfer',
          span: at(statement),
          control: { _tag: 'Return', value: value.value },
        }
      }
      case 'If': {
        const condition = evaluateExpression(statement.condition, contextual)
        if (condition._tag !== 'Complete') return condition
        if (condition.value._tag !== 'BooleanValue') return notBool(statement.condition, 'if')
        const selected = evaluateStatementSequence(
          condition.value.value ? statement.taken : statement.otherwise,
          contextual,
        )
        if (selected._tag !== 'Complete') return selected
        continue
      }
      case 'While': {
        while (true) {
          const condition = evaluateExpression(statement.condition, contextual)
          if (condition._tag !== 'Complete') return condition
          if (condition.value._tag !== 'BooleanValue') return notBool(statement.condition, 'while')
          if (!condition.value.value) break
          const body = evaluateStatementSequence(statement.body, contextual)
          if (body._tag === 'Failed') return body
          if (body._tag === 'Transfer') {
            if (body.control._tag === 'Return' || !sameLoop(body.control.target, statement.loop))
              return body
            if (body.control._tag === 'Break') break
          }
        }
        continue
      }
      case 'Write': {
        const key =
          statement.place._tag === 'WritePlace' ? writeRootKey(statement.place.root) : undefined
        if (statement.place._tag !== 'WritePlace' || key === undefined || !values.has(key))
          return failed(
            phaseViolation(
              'Evaluation.evaluateStatements',
              'assignment does not replace one static local',
              at(statement),
              context.trace,
            ),
          )
        const path = staticWritePath(statement.place, contextual)
        if (path._tag !== 'Complete') return path
        const value = evaluateExpression(statement.value, contextual)
        if (value._tag !== 'Complete') return value
        const replaced = replaceStaticPlace(
          values.get(key),
          path.value,
          value.value,
          at(statement.place),
          contextual,
        )
        if (replaced._tag !== 'Complete') return replaced
        values.set(key, replaced.value)
        if (path.value.length === 0) remember(key, statement.value)
        continue
      }
      case 'Break':
      case 'Continue':
        return {
          _tag: 'Transfer',
          span: at(statement),
          control: { _tag: statement._tag, target: statement.target },
        }
      default:
        return failed(
          phaseViolation(
            'Evaluation.evaluateStatements',
            `${statement._tag} is not admitted in a static function`,
            at(statement),
            context.trace,
          ),
        )
    }
  }
  return complete(StaticValue.unit())
}

/** Executes one static function body to a complete immutable value. */
export const evaluateStatements = (
  statements: ReadonlyArray<Tir.Statement>,
  context: NodeContext,
): Outcome<StaticValue.Value> => {
  const result = evaluateStatementSequence(statements, context)
  if (result._tag !== 'Transfer') return result
  if (result.control._tag === 'Return') return complete(result.control.value)
  return failed(
    phaseViolation(
      'Evaluation.evaluateStatements',
      'loop transfer escaped its lexical loop',
      result.span,
      context.trace,
    ),
  )
}

/** Immutable deterministic resource counters for one static-evaluation session. */
export interface Budget {
  readonly steps: number
  readonly callDepth: number
  readonly maximumCallDepth: number
  readonly retainedValueBytes: number
  readonly residualNodes: number
}

interface MutableBudget {
  steps: number
  callDepth: number
  maximumCallDepth: number
  retainedValueBytes: number
  residualNodes: number
  failure?: StaticFailure
}

const budgetSnapshot = (budget: MutableBudget): Budget => ({
  steps: budget.steps,
  callDepth: budget.callDepth,
  maximumCallDepth: budget.maximumCallDepth,
  retainedValueBytes: budget.retainedValueBytes,
  residualNodes: budget.residualNodes,
})

export type Outcome<A> =
  | { readonly _tag: 'Complete'; readonly value: A }
  | { readonly _tag: 'Failed'; readonly failure: StaticFailure }

/** Completes one callback evaluation with immutable deterministic output supplied by the caller. */
export const complete = <A>(value: A): Outcome<A> => ({ _tag: 'Complete', value })

/** Stops one callback evaluation without a partial value or residual body. */
export const failed = <A = never>(failure: StaticFailure): Outcome<A> => ({
  _tag: 'Failed',
  failure,
})

/** The explicit state of one target-and-application cache entry. */
export type CacheState<A> = Pending | Complete<A> | Failed

export interface Pending {
  readonly _tag: 'Pending'
  readonly trace: Trace
}

/**
 * What one completed evaluation consumed. Accounting is additive and depth is counted from the
 * evaluation's own entry, so a cost is a function of the evaluation's key alone.
 */
export interface Cost {
  readonly steps: number
  readonly callDepth: number
  readonly retainedValueBytes: number
  readonly residualNodes: number
}

export interface Complete<A> {
  readonly _tag: 'Complete'
  readonly value: A
  readonly cost?: Cost
}

export interface Failed {
  readonly _tag: 'Failed'
  readonly failure: StaticFailure
  readonly cost?: Cost
}

export interface CacheEntry<A> {
  readonly key: string
  readonly state: CacheState<A>
}

interface MutableState<A> {
  readonly cache: Map<string, CacheState<A>>
  readonly budget: MutableBudget
  readonly trace: CompilerTrace.CompilerTrace
}

const stateSymbol: unique symbol = Symbol('Evaluation.state')

/** One target-scoped static-evaluation session with hidden cache and accounting state. */
export interface Evaluation<A> {
  readonly _tag: 'Evaluation'
  readonly environment: TargetEnvironment
  readonly limits: Limits
  readonly [stateSymbol]: MutableState<A>
}

/** Starts one target-scoped static-evaluation session. */
export const make = <A>(
  compilation: CompilationProfile.Initial | CompilationProfile.CompilationProfile,
  policy: Limits = defaultLimits,
  sourceIdentity = '',
  trace: CompilerTrace.CompilerTrace = CompilerTrace.none,
): Evaluation<A> => ({
  _tag: 'Evaluation',
  environment: targetEnvironment(compilation, sourceIdentity),
  limits: limits(policy),
  [stateSymbol]: {
    cache: new Map(),
    trace,
    budget: {
      steps: 0,
      callDepth: 0,
      maximumCallDepth: 0,
      retainedValueBytes: 0,
      residualNodes: 0,
    },
  },
})

/** Returns a frozen observation of deterministic session accounting. */
export const budget = <A>(self: Evaluation<A>): Budget => budgetSnapshot(self[stateSymbol].budget)

/** Returns cache states in canonical key order without exposing the mutable cache map. */
export const cacheEntries = <A>(self: Evaluation<A>): ReadonlyArray<CacheEntry<A>> =>
  [...self[stateSymbol].cache]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, state]) => ({ key, state }))

/** Normalized policy identity required for cross-revision evaluation admission. */
export const policyKey = <A>(self: Evaluation<A>): string =>
  JSON.stringify([
    self.limits.steps,
    self.limits.callDepth,
    self.limits.retainedValueBytes,
    self.limits.residualNodes,
  ])

/** Returns one completed cache entry without exposing the mutable cache. */
export const cacheEntry = <A>(self: Evaluation<A>, key: string): CacheEntry<A> | undefined => {
  const state = self[stateSymbol].cache.get(key)
  return state === undefined || state._tag === 'Pending' ? undefined : { key, state }
}

/** Source-independent semantic identity of one exact specialization. */
export const semanticApplicationKey = (application: Application): string =>
  Canonical.record('SemanticApplication.v1', [
    application.declaration.module,
    application.declaration.name,
    Canonical.array(application.typeArguments),
    Canonical.array(application.evidence),
    Canonical.array(application.contractRow),
    Canonical.array(application.staticArguments.map(StaticValue.key)),
  ])

/** Canonical target-and-application identity used only inside static-evaluation coordination. */
export const applicationKey = (environment: TargetEnvironment, application: Application): string =>
  Canonical.record('StaticApplication', [
    environment.compilation.identity,
    environment.sourceIdentity,
    semanticApplicationKey(application),
  ])

const applicationFrame = (
  environment: TargetEnvironment,
  application: Application,
): ApplicationFrame => ({
  _tag: 'StaticApplicationFrame',
  declaration: { ...application.declaration },
  target: environment.target,
  staticArguments: application.staticArguments.map(StaticValue.presentation),
  span: application.span,
})

type LimitTag = 'StepLimit' | 'CallDepthLimit' | 'RetainedValueLimit' | 'ResidualGrowthLimit'

const frameSpan = (frame: TraceFrame): Location.Location =>
  frame._tag === 'StaticTextFrame' ? frame.literal : frame.span

const limitFailure = (
  tag: LimitTag,
  limit: number,
  attempted: number,
  trace: Trace,
): StaticFailure => {
  const lastFrame = trace.at(-1)
  const span = lastFrame === undefined ? undefined : frameSpan(lastFrame)
  if (span === undefined) throw new RangeError('Static limit failure lost its source trace')
  return { _tag: tag, limit, attempted, span, trace: frozenTrace(trace) }
}

const charge = <A>(
  self: Evaluation<A>,
  field: 'steps' | 'retainedValueBytes' | 'residualNodes',
  amount: number,
  tag: Exclude<LimitTag, 'CallDepthLimit'>,
  trace: Trace,
): StaticFailure | undefined => {
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new RangeError('Static budget charges must be non-negative safe integers')
  const state = self[stateSymbol]
  if (state.budget.failure !== undefined) return state.budget.failure
  const attempted = state.budget[field] + amount
  const limit = self.limits[field]
  if (attempted > limit) {
    const failure = limitFailure(tag, limit, attempted, trace)
    state.budget.failure = failure
    return failure
  }
  state.budget[field] = attempted
  return undefined
}

const enterCall = <A>(self: Evaluation<A>, trace: Trace): StaticFailure | undefined => {
  const state = self[stateSymbol]
  if (state.budget.failure !== undefined) return state.budget.failure
  const attempted = state.budget.callDepth + 1
  state.budget.maximumCallDepth = Math.max(state.budget.maximumCallDepth, attempted)
  if (attempted > self.limits.callDepth) {
    const failure = limitFailure('CallDepthLimit', self.limits.callDepth, attempted, trace)
    state.budget.failure = failure
    return failure
  }
  state.budget.callDepth = attempted
  return undefined
}

const leaveCall = <A>(self: Evaluation<A>): void => {
  const state = self[stateSymbol]
  state.budget.callDepth = Math.max(0, state.budget.callDepth - 1)
}

export interface EvaluationContext<A> {
  readonly application: Application
  readonly environment: TargetEnvironment
  readonly limits: Limits
  readonly trace: Trace
  readonly budget: () => Budget
  readonly step: (amount?: number) => StaticFailure | undefined
  readonly stepAt: (trace: Trace, amount?: number) => StaticFailure | undefined
  readonly retain: (value: StaticValue.Value) => StaticFailure | undefined
  readonly growResidual: (nodes?: number) => StaticFailure | undefined
  readonly growResidualAt: (trace: Trace, nodes?: number) => StaticFailure | undefined
  readonly withTrace: (...frames: ReadonlyArray<TraceFrame>) => EvaluationContext<A>
  readonly evaluate: (
    application: Application,
    callback: EvaluationCallback<A>,
  ) => ApplicationResult<A>
}

/** Future syntax residualization plugs into this deterministic callback boundary. */
export type EvaluationCallback<A> = (context: EvaluationContext<A>) => Outcome<A>

export type ApplicationResult<A> =
  | {
      readonly _tag: 'Complete'
      readonly key: string
      readonly cached: boolean
      readonly value: A
      readonly budget: Budget
    }
  | {
      readonly _tag: 'Failed'
      readonly key: string
      readonly cached: boolean
      readonly failure: StaticFailure
      readonly budget: Budget
    }

const resultOf = <A>(
  self: Evaluation<A>,
  key: string,
  state: Complete<A> | Failed,
  cached: boolean,
): ApplicationResult<A> =>
  state._tag === 'Complete'
    ? {
        _tag: 'Complete',
        key,
        cached,
        value: state.value,
        budget: budget(self),
      }
    : {
        _tag: 'Failed',
        key,
        cached,
        failure: state.failure,
        budget: budget(self),
      }

const contextOf = <A>(
  self: Evaluation<A>,
  application: Application,
  trace: Trace,
): EvaluationContext<A> => ({
  application,
  environment: self.environment,
  limits: self.limits,
  trace,
  budget: () => budget(self),
  step: (amount = 1) => charge(self, 'steps', amount, 'StepLimit', trace),
  stepAt: (at: Trace, amount = 1) => charge(self, 'steps', amount, 'StepLimit', at),
  retain: (value: StaticValue.Value) =>
    charge(
      self,
      'retainedValueBytes',
      StaticValue.retainedSize(value),
      'RetainedValueLimit',
      trace,
    ),
  growResidual: (nodes = 1) => charge(self, 'residualNodes', nodes, 'ResidualGrowthLimit', trace),
  growResidualAt: (at: Trace, nodes = 1) =>
    charge(self, 'residualNodes', nodes, 'ResidualGrowthLimit', at),
  withTrace: (...frames: ReadonlyArray<TraceFrame>) =>
    contextOf(self, application, appendTrace(trace, ...frames)),
  evaluate: (nested: Application, callback: EvaluationCallback<A>) =>
    evaluateAt(self, nested, callback, trace),
})

const isLimit = (failure: StaticFailure): boolean =>
  failure._tag === 'StepLimit' ||
  failure._tag === 'CallDepthLimit' ||
  failure._tag === 'RetainedValueLimit' ||
  failure._tag === 'ResidualGrowthLimit'

/** Charges a requester what a recorded evaluation consumed, exactly as executing it would have. */
const chargeCost = <A>(
  self: Evaluation<A>,
  cost: Cost,
  trace: Trace,
): StaticFailure | undefined => {
  const state = self[stateSymbol]
  if (state.budget.failure !== undefined) return state.budget.failure
  const depth = state.budget.callDepth + cost.callDepth
  state.budget.maximumCallDepth = Math.max(state.budget.maximumCallDepth, depth)
  if (depth > self.limits.callDepth) {
    const failure = limitFailure('CallDepthLimit', self.limits.callDepth, depth, trace)
    state.budget.failure = failure
    return failure
  }
  return (
    charge(self, 'steps', cost.steps, 'StepLimit', trace) ??
    charge(self, 'retainedValueBytes', cost.retainedValueBytes, 'RetainedValueLimit', trace) ??
    charge(self, 'residualNodes', cost.residualNodes, 'ResidualGrowthLimit', trace)
  )
}

const evaluateAt = <A>(
  self: Evaluation<A>,
  application: Application,
  callback: EvaluationCallback<A>,
  parentTrace: Trace,
): ApplicationResult<A> => {
  const key = applicationKey(self.environment, application)
  const state = self[stateSymbol]
  const existing = state.cache.get(key)
  let branch: 'reuse' | 'cycle' | 'execute'
  if (existing?._tag === 'Complete' || existing?._tag === 'Failed') branch = 'reuse'
  else if (existing?._tag === 'Pending') branch = 'cycle'
  else branch = 'execute'
  return state.trace(
    'Evaluation.evaluate',
    () => {
      // A request made while nothing is being evaluated is a root: it gets the whole allowance.
      // Everything it asks for draws from what it has left.
      const root = state.budget.callDepth === 0
      if (root) {
        state.budget.steps = 0
        state.budget.maximumCallDepth = 0
        state.budget.retainedValueBytes = 0
        state.budget.residualNodes = 0
        delete state.budget.failure
      }
      const trace = appendTrace(parentTrace, applicationFrame(self.environment, application))
      const cached = state.cache.get(key)
      if (cached?._tag === 'Complete' || cached?._tag === 'Failed') {
        // Cache warmth never changes what is accepted: a hit costs what the evaluation cost.
        const unpaid = cached.cost === undefined ? undefined : chargeCost(self, cached.cost, trace)
        return unpaid === undefined
          ? resultOf(self, key, cached, true)
          : resultOf(self, key, { _tag: 'Failed', failure: unpaid }, false)
      }
      if (cached?._tag === 'Pending') {
        const failure: Cycle = {
          _tag: 'Cycle',
          declaration: { ...application.declaration },
          span: application.span,
          trace: frozenTrace(trace),
        }
        return resultOf(self, key, { _tag: 'Failed', failure }, false)
      }

      state.cache.set(key, { _tag: 'Pending', trace })
      const before = { ...state.budget }
      const depthFailure = enterCall(self, trace)
      let outcome: Outcome<A>
      if (depthFailure === undefined) {
        // Depth is measured from this entry, so the recorded cost does not depend on the caller.
        state.budget.maximumCallDepth = state.budget.callDepth
        try {
          outcome = callback(contextOf(self, application, trace))
        } catch (defect) {
          state.cache.delete(key)
          throw defect
        } finally {
          leaveCall(self)
        }
      } else outcome = failed<A>(depthFailure)
      const finalOutcome =
        state.budget.failure === undefined ? outcome : failed<A>(state.budget.failure)
      const cost: Cost = {
        steps: state.budget.steps - before.steps,
        callDepth: state.budget.maximumCallDepth - before.callDepth,
        retainedValueBytes: state.budget.retainedValueBytes - before.retainedValueBytes,
        residualNodes: state.budget.residualNodes - before.residualNodes,
      }
      state.budget.maximumCallDepth = Math.max(
        before.maximumCallDepth,
        state.budget.maximumCallDepth,
      )
      const completedState: Complete<A> | Failed =
        finalOutcome._tag === 'Complete'
          ? { _tag: 'Complete', value: finalOutcome.value, cost }
          : { _tag: 'Failed', failure: finalOutcome.failure, cost }
      // Running out of a remainder is a fact about what the callers spent, not about this evaluation:
      // nothing is recorded under its key, and the exhaustion surfaces as the root's outcome. A root
      // that exhausts the whole allowance is a fact about its key, which includes the limits.
      if (!root && completedState._tag === 'Failed' && isLimit(completedState.failure))
        state.cache.delete(key)
      else state.cache.set(key, completedState)
      return resultOf(self, key, completedState, false)
    },
    {
      'evaluation.branch': branch,
      'evaluation.reuse': branch === 'reuse',
      module: application.declaration.module,
      declaration: application.declaration.name,
    },
  )
}

/** Evaluates or reuses one canonical target application through the supplied deterministic policy. */
export const evaluate = <A>(
  self: Evaluation<A>,
  application: Application,
  callback: EvaluationCallback<A>,
): ApplicationResult<A> => evaluateAt(self, application, callback, [])

/** Evaluates a nested canonical application while retaining its source-level parent trace. */
export const evaluateFrom = <A>(
  self: Evaluation<A>,
  application: Application,
  parentTrace: Trace,
  callback: EvaluationCallback<A>,
): ApplicationResult<A> => evaluateAt(self, application, callback, parentTrace)

/** Installs one validated completed application and charges its recorded cost exactly once. */
export const admit = <A>(
  self: Evaluation<A>,
  application: Application,
  entry: CacheEntry<A>,
  parentTrace: Trace = [],
): ApplicationResult<A> => {
  const key = applicationKey(self.environment, application)
  if (entry.key !== key || entry.state._tag === 'Pending')
    throw new RangeError('Validated evaluation entry does not match its application')
  self[stateSymbol].cache.set(key, entry.state)
  return evaluateAt(
    self,
    application,
    () => {
      throw new RangeError('Validated evaluation unexpectedly executed')
    },
    parentTrace,
  )
}
