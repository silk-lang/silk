import { generated } from './CleanupEmission.js'
import * as CleanupPlan from './CleanupPlan.js'
import * as ConformanceProof from './ConformanceProof.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type { LoweredExpression } from './EffectLowering.js'
import type {} from './EntryAssembly.js'
import type {} from './Forwarding.js'
import type { FunctionLowering } from './FunctionLowering.js'
import * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import type * as Intrinsic from './Intrinsic.js'
import * as TypeInference from './internal/TypeInference.js'
import { borrowKey } from './Lower.js'
import type {} from './LowerExpression.js'
import { captureCallOperand, lowerExpression } from './LowerExpression.js'
import * as Mir from './Mir.js'
import * as Scalar from './Scalar.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'
import { baseRunnerKey, effectValueAtSite, generatedRunner } from './ValueType.js'

export const emitWitnessDispatch = (
  fn: FunctionLowering,
  target: ConformanceProof.InterfaceWitnessTarget,
  argumentLocals: ReadonlyArray<Mir.LocalId>,
  operandTypes: ReadonlyArray<Mir.Type>,
  resultType: Mir.Type,
  call: Tir.NodeRef,
  span: SourceSpan.SourceSpan,
): Mir.LocalId | undefined => {
  const borrows: Array<{ readonly borrow: Tir.BorrowId; readonly local: Mir.LocalId }> = []
  const arguments_: Array<Mir.LocalId> = []
  for (const [ordinal, argument] of argumentLocals.entries()) {
    const operand = operandTypes.at(ordinal)
    const source = fn.localTypes.at(argument.ordinal)
    if (operand === undefined || source === undefined) return undefined
    if (operand._tag !== 'Reference') {
      arguments_.push(argument)
      continue
    }
    const borrow = fn.beginRecipeBorrow({
      _tag: 'BorrowId' as const,
      call,
      ordinal,
    })
    const destination = fn.alloc(operand)
    fn.emit({
      _tag: 'BeginLoan',
      borrow,
      destination,
      root: argument,
      selectors: [],
      sourceType: source,
      type: operand,
      access: operand.type.access,
      reborrow: false,
      suspendsParent: false,
      provenance: generated(span),
    })
    borrows.push({ borrow, local: destination })
    arguments_.push(destination)
  }
  const witnessArguments = sourceWitnessArguments(fn, target, arguments_, call, span)
  if (witnessArguments === undefined) return undefined
  const destination = fn.alloc(resultType)
  fn.emit({
    _tag: 'Call',
    destination,
    target: target.implementation,
    // A conditional witness is one generic function per header, so the direct target carries the
    // arguments this specialization proved. Nothing else travels: a requirement's own witness is
    // reached through its own instance, never through a value handed to this call.
    typeArguments: target.typeArguments,
    arguments: witnessArguments.arguments,
    type: resultType,
    provenance: generated(span),
  })
  endWitnessReborrows(fn, witnessArguments.reborrows, span)
  for (const entry of borrows)
    fn.emit({
      _tag: 'EndLoan',
      borrow: entry.borrow,
      slice: entry.local,
      provenance: generated(span),
    })
  return destination
}

export const lowerInterfaceWitnessCall = (
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' }>,
  argumentLocals: ReadonlyArray<Mir.LocalId>,
): Mir.LocalId | undefined => {
  const bound = expression.interfaceOperation
  if (bound === undefined) return undefined
  const provider = fn.semantic(bound.provider)
  const capability = fn.semantic(bound.capability)
  if (!Type.isNominal(capability)) return undefined
  const target = ConformanceProof.interfaceWitnessTarget(
    fn.index,
    provider,
    capability,
    bound.operation,
    bound.contract,
    fn.substitution,
  )
  const resultType = fn.type(expression.type)
  const operandTypes = bound.contract.operands.flatMap((operand) => {
    if (operand.type._tag !== 'Resolved') return []
    const type = fn.type(fn.semantic(operand.type.type))
    return type === undefined ? [] : [type]
  })
  if (
    target === undefined ||
    resultType === undefined ||
    operandTypes.length !== bound.contract.operands.length
  )
    return undefined
  return emitWitnessDispatch(
    fn,
    target,
    argumentLocals,
    operandTypes,
    resultType,
    Tir.nodeReference(fn.owner.view.artifact, expression),
    expression.span,
  )
}

export interface WitnessArguments {
  readonly arguments: ReadonlyArray<Mir.LocalId>
  readonly reborrows: ReadonlyArray<{ readonly borrow: Tir.BorrowId; readonly local: Mir.LocalId }>
}

export interface InterfaceOperands {
  readonly arguments: ReadonlyArray<Mir.LocalId>
  readonly borrows: ReadonlyArray<{ readonly borrow: Tir.BorrowId; readonly local: Mir.LocalId }>
}

export interface InterfaceOperandLoweringFailure {
  readonly _tag: 'InterfaceOperandLoweringFailure'
  readonly reason:
    | 'Arity'
    | 'Argument'
    | 'Contract'
    | 'ExpectedType'
    | 'ActualType'
    | 'Incompatible'
  readonly ordinal?: number
}

export const lowerInterfaceOperands = (
  fn: FunctionLowering,
  arguments_: ReadonlyArray<Tir.Expression>,
  operands: ReadonlyArray<DeclarationFacts.InterfaceOperandFact>,
  call: Tir.NodeRef,
  span: SourceSpan.SourceSpan,
): InterfaceOperands | InterfaceOperandLoweringFailure | 'Transferred' => {
  if (arguments_.length !== operands.length)
    return { _tag: 'InterfaceOperandLoweringFailure', reason: 'Arity' }
  const lowered: Array<Mir.LocalId> = []
  const borrows: Array<{ readonly borrow: Tir.BorrowId; readonly local: Mir.LocalId }> = []
  for (const [ordinal, argument] of arguments_.entries()) {
    const value = lowerExpression(fn, argument)
    if (value === 'Transferred') return value
    const operand = operands.at(ordinal)
    if (value === undefined)
      return {
        _tag: 'InterfaceOperandLoweringFailure',
        reason: 'Argument',
        ordinal,
      }
    if (operand?.type._tag !== 'Resolved')
      return {
        _tag: 'InterfaceOperandLoweringFailure',
        reason: 'Contract',
        ordinal,
      }
    const expected = fn.type(fn.semantic(operand.type.type))
    const actual = fn.localTypes.at(value.result.ordinal)
    if (expected === undefined)
      return {
        _tag: 'InterfaceOperandLoweringFailure',
        reason: 'ExpectedType',
        ordinal,
      }
    if (actual === undefined)
      return {
        _tag: 'InterfaceOperandLoweringFailure',
        reason: 'ActualType',
        ordinal,
      }
    if (Type.runtimeKey(Mir.semanticType(actual)) === Type.runtimeKey(Mir.semanticType(expected))) {
      const captured = captureCallOperand(fn, value.result, argument.span)
      if (captured === undefined)
        return { _tag: 'InterfaceOperandLoweringFailure', reason: 'Argument', ordinal }
      lowered.push(captured)
      continue
    }
    if (
      expected._tag !== 'Reference' ||
      !Type.equals(Mir.semanticType(actual), expected.type.target)
    )
      return {
        _tag: 'InterfaceOperandLoweringFailure',
        reason: 'Incompatible',
        ordinal,
      }
    const borrow = fn.beginRecipeBorrow({
      _tag: 'BorrowId' as const,
      call,
      ordinal,
    })
    const destination = fn.alloc(expected)
    fn.emit({
      _tag: 'BeginLoan',
      borrow,
      destination,
      root: value.result,
      selectors: [],
      sourceType: actual,
      type: expected,
      access: expected.type.access,
      reborrow: false,
      suspendsParent: false,
      provenance: generated(span),
    })
    fn.loanLocals.set(borrowKey(borrow), destination)
    lowered.push(destination)
    borrows.push({ borrow, local: destination })
  }
  return { arguments: lowered, borrows: borrows }
}

export const sourceWitnessParameterTypes = (
  fn: FunctionLowering,
  target: ConformanceProof.InterfaceWitnessTarget,
): ReadonlyArray<Mir.Type> | undefined => {
  const declaration = DeclarationFacts.byCanonical(fn.index, target.implementation)
  if (declaration?._tag !== 'FunctionDeclaration') return undefined
  const binders = declaration.typeParameters
    .filter((parameter) => parameter.duplicateOf === undefined)
    .map((parameter) => parameter.type)
  const substitution = TypeInference.substitution(binders, target.typeArguments)
  if (substitution === undefined) return undefined
  const parameters = declaration.parameters.flatMap((parameter) => {
    if (parameter.declaredType._tag !== 'Resolved') return []
    const type = fn.type(Type.substitute(parameter.declaredType.type, substitution))
    return type === undefined ? [] : [type]
  })
  return parameters.length === declaration.parameters.length ? parameters : undefined
}

/** Realizes only access weakening already admitted by the compatibility actor. */
export const sourceWitnessArguments = (
  fn: FunctionLowering,
  target: ConformanceProof.InterfaceWitnessTarget,
  arguments_: ReadonlyArray<Mir.LocalId>,
  call: Tir.NodeRef,
  span: SourceSpan.SourceSpan,
): WitnessArguments | undefined => {
  const parameters = sourceWitnessParameterTypes(fn, target)
  if (parameters === undefined || parameters.length !== arguments_.length) return undefined
  const lowered: Array<Mir.LocalId> = []
  const reborrows: Array<{ readonly borrow: Tir.BorrowId; readonly local: Mir.LocalId }> = []
  for (const [ordinal, argument] of arguments_.entries()) {
    const actual = fn.localTypes.at(argument.ordinal)
    const expected = parameters.at(ordinal)
    if (actual === undefined || expected === undefined) return undefined
    if (Type.runtimeKey(Mir.semanticType(actual)) === Type.runtimeKey(Mir.semanticType(expected))) {
      lowered.push(argument)
      continue
    }
    if (
      expected._tag === 'Reference' &&
      actual._tag !== 'Reference' &&
      actual._tag !== 'Slice' &&
      Type.runtimeKey(Mir.semanticType(actual)) === Type.runtimeKey(expected.type.target)
    ) {
      const borrow = fn.beginRecipeBorrow({
        _tag: 'BorrowId',
        call,
        ordinal: arguments_.length + ordinal,
      })
      const destination = fn.alloc(expected)
      fn.emit({
        _tag: 'BeginLoan',
        borrow,
        destination,
        root: argument,
        selectors: [],
        sourceType: actual,
        type: expected,
        access: expected.type.access,
        reborrow: false,
        suspendsParent: false,
        provenance: generated(span),
      })
      fn.temporaryBorrowOwners.set(borrowKey(borrow), {
        local: argument,
        cleanup: CleanupPlan.cleanupPlan(fn.index, Mir.semanticType(actual)),
        span,
      })
      fn.loanLocals.set(borrowKey(borrow), destination)
      lowered.push(destination)
      reborrows.push({ borrow, local: destination })
      continue
    }
    const actualReference = actual._tag === 'Reference' || actual._tag === 'Slice'
    const expectedReference = expected._tag === 'Reference' || expected._tag === 'Slice'
    let sameTarget = false
    if (actual._tag === 'Reference' && expected._tag === 'Reference') {
      sameTarget = Type.runtimeKey(actual.type.target) === Type.runtimeKey(expected.type.target)
    } else if (actual._tag === 'Slice' && expected._tag === 'Slice') {
      sameTarget = Type.runtimeKey(actual.type.element) === Type.runtimeKey(expected.type.element)
    }
    if (
      !actualReference ||
      !expectedReference ||
      !sameTarget ||
      actual.type.access !== 'Exclusive' ||
      expected.type.access !== 'Shared'
    )
      return undefined
    const borrow = fn.beginRecipeBorrow({
      _tag: 'BorrowId' as const,
      call,
      ordinal: arguments_.length + ordinal,
    })
    const destination = fn.alloc(expected)
    fn.emit({
      _tag: 'BeginLoan',
      borrow,
      destination,
      root: argument,
      selectors: [],
      sourceType: actual,
      type: expected,
      access: 'Shared',
      reborrow: true,
      suspendsParent: true,
      provenance: generated(span),
    })
    fn.loanLocals.set(borrowKey(borrow), destination)
    lowered.push(destination)
    reborrows.push({ borrow, local: destination })
  }
  return { arguments: lowered, reborrows: reborrows }
}

export const endWitnessReborrows = (
  fn: FunctionLowering,
  reborrows: WitnessArguments['reborrows'],
  span: SourceSpan.SourceSpan,
): void => {
  for (const reborrow of reborrows)
    if (fn.loanLocals.delete(borrowKey(reborrow.borrow)))
      fn.emit({
        _tag: 'EndLoan',
        borrow: reborrow.borrow,
        slice: reborrow.local,
        provenance: generated(span),
      })
}

export const witnessEffectContract = (
  expression: Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' | 'InterfaceOperationCall' }>,
): DeclarationFacts.InterfaceOperationApplicationFact | undefined =>
  expression._tag === 'InterfaceOperationCall'
    ? expression.contract
    : expression.interfaceOperation?.contract

export const lowerWitnessEffect = (
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' | 'InterfaceOperationCall' }>,
): LoweredExpression | undefined => {
  const site = expression.witnessEffectSite
  const contract = witnessEffectContract(expression)
  const fail = (reason: NonNullable<Parameters<FunctionLowering['recordLoweringFailure']>[3]>) => {
    fn.recordLoweringFailure('Expression', expression._tag, expression.span, reason)
    return undefined
  }
  if (site === undefined) return fail({ _tag: 'WitnessEffectMissingSite' })
  if (contract === undefined) return fail({ _tag: 'WitnessEffectMissingContract' })
  const siteKey = Tir.executableSiteKey(site)
  const capability = fn.semantic(
    expression._tag === 'InterfaceOperationCall'
      ? expression.capability
      : (expression.interfaceOperation?.capability ?? 'never'),
  )
  const provider = fn.semantic(
    expression._tag === 'InterfaceOperationCall'
      ? expression.provider
      : (expression.interfaceOperation?.provider ?? 'never'),
  )
  const inherited = fn.witnessTargets?.find((candidate) =>
    Tir.sameExecutableSite(candidate.site, site),
  )
  if (!Type.isNominal(capability) && inherited === undefined)
    return fail({
      _tag: 'WitnessEffectMissingTarget',
      site: siteKey,
      publishedSites:
        fn.witnessTargets?.map((candidate) => Tir.executableSiteKey(candidate.site)) ?? [],
    })
  let target: ConformanceProof.InterfaceWitnessTarget | undefined
  if (fn.witnessTargets !== undefined) {
    target = inherited?.target
  } else {
    if (!Type.isNominal(capability)) return undefined
    target = ConformanceProof.interfaceWitnessTarget(
      fn.index,
      provider,
      capability,
      expression._tag === 'InterfaceOperationCall'
        ? expression.operation
        : (expression.interfaceOperation?.operation ?? ''),
      contract,
      fn.substitution,
    )
  }
  const intrinsic = Type.isNominal(capability)
    ? ConformanceProof.interfaceOperationIntrinsic(
        fn.index,
        provider,
        capability,
        expression._tag === 'InterfaceOperationCall'
          ? expression.operation
          : (expression.interfaceOperation?.operation ?? ''),
      )
    : undefined
  if (target === undefined && intrinsic?.rule._tag !== 'BuiltinRule')
    return fail({
      _tag: 'WitnessEffectMissingTarget',
      site: siteKey,
      publishedSites:
        fn.witnessTargets?.map((candidate) => Tir.executableSiteKey(candidate.site)) ?? [],
    })
  const semanticType = fn.semantic(expression.type)
  const type = Type.isEffect(semanticType)
    ? effectValueAtSite(fn.layout, fn.owner.key, site, semanticType)
    : undefined
  if (type === undefined)
    return fail({
      _tag: 'WitnessEffectMissingLayout',
      site: siteKey,
      availableSites: fn.layout.effectEnvironments
        .filter(
          (candidate) => Instances.keyText(candidate.instance) === Instances.keyText(fn.owner.key),
        )
        .map((candidate) => Tir.executableSiteKey(candidate.site)),
    })
  const operands = lowerInterfaceOperands(
    fn,
    expression.arguments,
    contract.operands,
    Tir.nodeReference(fn.owner.view.artifact, expression),
    expression.span,
  )
  if (operands === 'Transferred') return operands
  if ('_tag' in operands)
    return fail({
      _tag: 'WitnessEffectOperandLowering',
      site: siteKey,
      failure: operands.reason,
      ...(operands.ordinal === undefined ? {} : { ordinal: operands.ordinal }),
    })
  const destination = fn.alloc(type)
  const runner = Tir.effectRunnerId(fn.owner.key.declaration, site)
  fn.emit({
    _tag: 'MakeEffect',
    destination,
    runner,
    runnerTypeArguments: fn.owner.key.typeArguments,
    captures: operands.arguments.map((source, ordinal) => ({
      source,
      access: type.environment.fields.at(ordinal)?.access ?? ('Take' as const),
    })),
    type,
    provenance: generated(expression.span),
  })
  const key = baseRunnerKey(fn.owner.key, site, type.type)
  if (generatedRunner(fn.generatedRunners, key) === undefined)
    fn.generatedRunners.push({
      _tag: 'WitnessEffectRunner',
      id: runner,
      owner: fn.owner,
      expression,
      ...(target === undefined ? {} : { target }),
      ...(intrinsic?.rule._tag === 'BuiltinRule' ? { intrinsic } : {}),
      type,
      specializationKey: key,
      providedRequirements: [],
    })
  return { result: destination }
}

/**
 * Redirects one static interface-operation call to the provider's own function, the fallback the
 * operator path reaches through `lowerInterfaceWitnessCall`.
 *
 * Interface calls already elaborated and ownership-checked their arguments against the literal
 * applied contract. A source witness may weaken that owned access to a temporary borrow; the
 * ownership of that operand remains with this adapter until the selected witness completes.
 */
export const lowerStaticInterfaceWitnessCall = (
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'InterfaceOperationCall' }>,
  provider: Type.Type,
  capability: Type.Nominal,
  argumentLocals: ReadonlyArray<Mir.LocalId>,
): Mir.LocalId | undefined => {
  const target = ConformanceProof.interfaceWitnessTarget(
    fn.index,
    provider,
    capability,
    expression.operation,
    expression.contract,
    fn.substitution,
  )
  const resultType = fn.type(expression.type)
  if (target === undefined || resultType === undefined) return undefined
  const witnessArguments = sourceWitnessArguments(
    fn,
    target,
    argumentLocals,
    Tir.nodeReference(fn.owner.view.artifact, expression),
    expression.span,
  )
  if (witnessArguments === undefined) return undefined
  const selected = fn.call(expression, target.implementation, target.typeArguments)
  const destination = fn.alloc(resultType)
  fn.emit({
    _tag: 'Call',
    destination,
    target: target.implementation,
    typeArguments: selected?.target.typeArguments ?? target.typeArguments,
    arguments: witnessArguments.arguments,
    type: resultType,
    provenance: generated(expression.span),
  })
  endWitnessReborrows(fn, witnessArguments.reborrows, expression.span)
  return destination
}

/**
 * Lowers the canonical source-call operands to the target-neutral primitive representation.
 *
 * A shared scalar borrow is an authored source contract, not a witness compatibility case. The
 * primitive consumes the scalar stored at that place, so the representation boundary performs
 * the read for direct calls and sealed witnesses alike.
 */
export const lowerBuiltinArguments = (
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' }>,
  intrinsic: Intrinsic.BuiltinOperation,
): ReadonlyArray<Mir.LocalId> | 'Transferred' | undefined => {
  const loweredArguments: Array<Mir.LocalId> = []
  for (const [ordinal, argument] of expression.arguments.entries()) {
    const lowered = lowerExpression(fn, argument)
    if (lowered === 'Transferred') return lowered
    if (lowered === undefined) return undefined
    const actual = fn.localTypes.at(lowered.result.ordinal)
    const callParameter = intrinsic.callParameters.at(ordinal)
    const primitiveParameter = intrinsic.rule.parameters.at(ordinal)
    const sharedScalarReference =
      actual?._tag === 'Reference' &&
      callParameter !== undefined &&
      primitiveParameter !== undefined &&
      Type.isReference(callParameter) &&
      callParameter.access === 'Shared' &&
      Type.runtimeKey(actual.type) === Type.runtimeKey(callParameter) &&
      Type.equals(callParameter.target, primitiveParameter)
    // A borrowed match field is pointer-shaped in MIR even when this primitive takes its value.
    const borrowedScalarValue =
      actual?._tag === 'EnvironmentBorrow' &&
      typeof actual.type === 'string' &&
      Scalar.find(actual.type) !== undefined &&
      callParameter !== undefined &&
      primitiveParameter !== undefined &&
      Type.equals(actual.type, callParameter) &&
      Type.equals(actual.type, primitiveParameter)
    if (!sharedScalarReference && !borrowedScalarValue) {
      const captured = captureCallOperand(fn, lowered.result, argument.span)
      if (captured === undefined) return undefined
      loweredArguments.push(captured)
      continue
    }
    const type = fn.type(primitiveParameter)
    if (type === undefined) return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'ReadPlace',
      destination,
      root: lowered.result,
      selectors: [],
      type,
      provenance: generated(argument.span),
    })
    loweredArguments.push(destination)
  }
  return loweredArguments
}
