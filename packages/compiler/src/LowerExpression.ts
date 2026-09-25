import * as ConcreteCleanup from './ConcreteCleanup.js'
import {
  authored,
  lowerBorrowedWritePlace,
  generated,
  emitReleases,
  emitInitializationTransition,
  initializeBinding,
  matchCleanupKey,
  ownerFields,
  lowerBorrowPlace,
  lowerWriteSelectors,
  lowerOwnershipPath,
  ownershipLocal,
  propagationLoanEnds,
  propagationReleases,
  specializedCleanup,
  transitionAt,
} from './CleanupEmission.js'
import * as CAbi from './CAbi.js'
import * as CleanupPlan from './CleanupPlan.js'
import * as ConformanceProof from './ConformanceProof.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type { LoweredExpression, LoweredValue } from './EffectLowering.js'
import * as ExecutableOrigin from './ExecutableOrigin.js'
import {
  borrowedWriteRoot,
  endLoans,
  endReturnedViewLoans,
  endRunLoans,
  lowerCatchEffectValue,
  lowerEffectCatch,
  lowerEffectExecution,
  lowerFinalizedEffect,
  lowerUseReleaseNonParking,
  lowerPlace,
  lowerPlacePath,
  lowerRunEffectComposite,
  lowerRunEffectValue,
  lowerServiceEffectValue,
  ownedWriteRoot,
  patternPlace,
} from './EffectLowering.js'
import type {} from './EntryAssembly.js'
import type {} from './Forwarding.js'
import {
  callableRecipe,
  delayedEffectState,
  effectRecipe,
  inlineForwardedRequirement,
  restoreDelayedEffectState,
} from './Forwarding.js'
import type { FunctionLowering } from './FunctionLowering.js'
import * as Tir from './Tir.js'
import * as BodyView from './BodyView.js'
import * as Instances from './Instances.js'
import * as Layout from './Layout.js'
import type { DelayedEffectState, ProvidedRequirement } from './Lower.js'
import {
  bool,
  borrowKey,
  character,
  patternKey,
  spanKey,
  specializedWitnessEffectTargets,
  usize,
} from './Lower.js'
import { lowerSequence } from './LowerStatements.js'
import { lowerBuiltinExpression } from './LowerBuiltin.js'
import * as Match from './Match.js'
import * as Mir from './Mir.js'
import * as Ownership from './Ownership.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Scalar from './Scalar.js'
import * as Type from './Type.js'
import * as TypeCompatibility from './TypeCompatibility.js'
import {
  baseRunnerKey,
  callableValueByIdentity,
  callableValueType,
  directCallableSectionValueType,
  stagedCallableValueType,
  effectCompositeShape,
  effectValueByIdentity,
  effectValueForCall,
  effectValueType,
  ensureEffectRunner,
  functionItemValueType,
  instanceText,
  providerBindings,
  requirementsFor,
  resultCallableValueType,
  runtimeRequirementArguments,
  storedCallableValueType,
  storedEffectValueType,
} from './ValueType.js'
import { lowerStaticInterfaceWitnessCall, lowerWitnessEffect } from './WitnessLowering.js'

/** Packs one exact Effect alternative into the finite composite that joins it. */
const packEffectComposite = (
  fn: FunctionLowering,
  lowered: LoweredValue,
  composite: Extract<Mir.Type, { readonly _tag: 'EffectComposite' }>,
  span: SourceSpan.SourceSpan,
): LoweredValue | undefined => {
  const selectedType = fn.localTypes.at(lowered.result.ordinal)
  if (selectedType?._tag !== 'EffectValue') return undefined
  const selectedIdentity = Instances.effectIdentity(
    selectedType.environment.instance,
    selectedType.site,
  )
  const alternative = composite.alternatives.findIndex(
    (candidate) =>
      Instances.effectIdentity(candidate.environment.instance, candidate.site) === selectedIdentity,
  )
  if (alternative < 0) return undefined
  const packed = fn.alloc(composite)
  fn.emit({
    _tag: 'PackEffectComposite',
    destination: packed,
    source: lowered.result,
    alternative,
    type: composite,
    provenance: authored(span),
  })
  return { result: packed }
}

/**
 * A service operation constructed as a value (`Effect.provideMut(Writer.writeAll(b), &mut w)`,
 * or its pipe form) dispatches on the provider that the enclosing forwarding wrapper binds, so
 * that provider must exist before the operation's Effect value is built. The provider operand is
 * lowered first and its local serves both the requirement the operation resolves against and the
 * wrapper's own provider argument; the operand form recognized here is a pure borrow, so the
 * earlier evaluation observes nothing.
 */
const forwardedServiceProvision = (
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'EffectConstruct' | 'CallableApply' }>,
  availableRequirements: ReadonlyArray<ProvidedRequirement>,
):
  | {
      readonly provider: Tir.Expression
      readonly local: Mir.LocalId
      readonly protected: Tir.Expression
      readonly requirements: ReadonlyArray<ProvidedRequirement>
    }
  | 'Transferred'
  | undefined => {
  const forwarded = inlineForwardedRequirement(fn, expression)
  if (
    forwarded === undefined ||
    forwarded.selection.access === 'Take' ||
    forwarded.provider._tag !== 'ValueBorrow' ||
    forwarded.binding.protected._tag !== 'ServiceEffectConstruct' ||
    availableRequirements.some(
      (requirement) =>
        requirement.role === forwarded.selection.role &&
        Type.equals(requirement.capability, forwarded.selection.capability),
    )
  )
    return undefined
  const provider = lowerExpression(fn, forwarded.provider, availableRequirements)
  if (provider === 'Transferred') return provider
  if (provider === undefined) return undefined
  return {
    provider: forwarded.provider,
    local: provider.result,
    protected: forwarded.binding.protected,
    requirements: [...availableRequirements, { ...forwarded.selection, local: provider.result }],
  }
}

const lowerOperandWithProvision = (
  fn: FunctionLowering,
  provision: Exclude<ReturnType<typeof forwardedServiceProvision>, 'Transferred'>,
  operand: Tir.Expression,
  availableRequirements: ReadonlyArray<ProvidedRequirement>,
): LoweredExpression | undefined => {
  if (provision === undefined) return lowerExpression(fn, operand, availableRequirements)
  if (operand === provision.provider) return { result: provision.local }
  return lowerExpression(
    fn,
    operand,
    operand === provision.protected ? provision.requirements : availableRequirements,
  )
}

const lowerTransferredPlace = (
  fn: FunctionLowering,
  transition: Ownership.PlaceTransition,
  semanticType: DeclarationFacts.SemanticType,
  span: SourceSpan.SourceSpan,
): LoweredExpression | undefined => {
  const root = ownershipLocal(fn, transition.root)
  if (root === undefined) return undefined
  if (transition.path.length === 0) return { result: root }
  const type = fn.type(semanticType)
  const selectors = lowerOwnershipPath(fn, root, transition.path, span)
  if (type === undefined || selectors === undefined) return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'ReadPlace',
    destination,
    root,
    selectors,
    type,
    consume: true,
    ownershipPath: transition.path,
    provenance: authored(span),
  })
  return { result: destination }
}

export function lowerExpression(
  fn: FunctionLowering,
  expression: Tir.Expression,
  availableRequirements = fn.activeRequirements ?? fn.providedRequirements,
): LoweredExpression | undefined {
  const lower = (): LoweredExpression | undefined => {
    // Generated wrappers can share the source place's span. Only the place itself extracts
    // ownership; a match or conversion must still lower its computation and result type.
    const consuming =
      expression._tag === 'ParameterReference' ||
      expression._tag === 'BindingReference' ||
      expression._tag === 'PatternBindingReference' ||
      expression._tag === 'Project' ||
      expression._tag === 'ReferentPlace' ||
      expression._tag === 'IndexPlace' ||
      expression._tag === 'SliceIndexPlace'
        ? transitionAt(fn, expression.span, 'Move', Ownership.placeOf(expression)?.root)
        : undefined
    let lowered: LoweredExpression | undefined
    if (consuming !== undefined && consuming.path.length > 0 && expression._tag !== 'Unavailable') {
      lowered = lowerTransferredPlace(fn, consuming, expression.type, expression.span)
    } else lowered = lowerExpressionInner(fn, expression, availableRequirements)
    if (lowered === 'Transferred') return lowered
    if (lowered !== undefined) {
      fn.expressionLocals.set(spanKey(expression.span), lowered.result)
      if (consuming !== undefined) emitInitializationTransition(fn, consuming)
    }
    endReturnedViewLoans(fn, expression.span)
    return lowered
  }
  // The replay substitution must remain live through the wrapper's automatic loan endings, not
  // only through the Run case itself: a returned view can share the Run span with the replayed
  // protected recipe.
  const previousRequirements = fn.activeRequirements
  fn.activeRequirements = availableRequirements
  const result = expression._tag === 'Run' ? fn.withRecipeReplay(lower) : lower()
  fn.activeRequirements = previousRequirements
  if (result === undefined) fn.recordLoweringFailure('Expression', expression._tag, expression.span)
  return result
}

/** Captures a selected eager computation, preserving ordinary return and loop exits. */
export const lowerExecution = (
  fn: FunctionLowering,
  span: SourceSpan.SourceSpan,
  body: () => LoweredExpression | undefined,
): Mir.Execution | undefined =>
  fn.captureExecution(() => {
    const entry = fn.reserve()
    const [lowered, operations] = fn.capture(body)
    if (lowered === undefined) return undefined
    fn.publish({
      _tag: 'OperationRegion',
      id: entry,
      ...ownerFields(fn.ownerLoop),
      operations,
      outcome:
        lowered === 'Transferred'
          ? {
              _tag: 'Trap',
              reason: 'unreachable expression continuation',
              provenance: generated(span),
            }
          : { _tag: 'Complete', provenance: generated(span) },
    })
    return lowered === 'Transferred' ? { entry } : { entry, result: lowered.result }
  })

export function lowerExpressionInner(
  fn: FunctionLowering,
  expression: Tir.Expression,
  availableRequirements = fn.activeRequirements ?? fn.providedRequirements,
): LoweredExpression | undefined {
  switch (expression._tag) {
    case 'ForeignFunctionAddress': {
      const type = fn.type(expression.type)
      if (type === undefined || type._tag !== 'ForeignFunction') return undefined
      const destination = fn.alloc(type)
      fn.emit({
        _tag: 'ForeignFunctionAddress',
        destination,
        target: expression.target,
        symbol: expression.symbol,
        type,
        provenance: authored(expression.span),
      })
      return { result: destination }
    }
    case 'ForeignStaticLoad': {
      const type = fn.type(expression.type)
      if (type === undefined) return undefined
      const destination = fn.alloc(type)
      fn.emit({
        _tag: 'ForeignStaticLoad',
        destination,
        declaration: expression.declaration,
        direction: expression.direction,
        symbol: expression.symbol,
        type,
        provenance: authored(expression.span),
      })
      return { result: destination }
    }
    case 'IntegerLiteral':
      return lowerIntegerLiteralExpression(fn, expression)
    case 'FloatingLiteral':
      return lowerFloatingLiteralExpression(fn, expression)
    case 'EnumMember':
      return lowerEnumMemberExpression(fn, expression)
    case 'EnumValue':
      return lowerEnumValueExpression(fn, expression, availableRequirements)
    case 'EnumEquality':
      return lowerEnumEqualityExpression(fn, expression, availableRequirements)
    case 'StaticStringLiteral':
      return lowerStaticStringLiteralExpression(fn, expression)
    case 'RuntimeStringView':
      return lowerRuntimeStringViewExpression(fn, expression, availableRequirements)
    case 'StringEquality':
      return lowerStringEqualityExpression(fn, expression, availableRequirements)
    case 'StaticByteViewLiteral':
      return lowerStaticByteViewLiteralExpression(fn, expression)
    case 'UnitLiteral':
      return lowerUnitLiteralExpression(fn, expression)
    case 'BooleanLiteral':
      return lowerBooleanLiteralExpression(fn, expression)
    case 'CharacterLiteral':
      return lowerCharacterLiteralExpression(fn, expression)
    case 'ParameterReference': {
      const parameter = fn.parameterLocals.get(expression.parameter.ordinal)
      return parameter === undefined ? undefined : { result: parameter }
    }
    case 'BindingReference': {
      const bound = fn.bindingLocals.get(expression.binding.ordinal)
      if (bound === undefined) return undefined
      return { result: bound }
    }
    case 'PatternBindingReference': {
      const binding = Ownership.allBindings(fn.ownership).find(
        (binding) =>
          binding.site._tag === 'Pattern' &&
          patternKey(binding.site.binding) === patternKey(expression.binding),
      )
      if (binding?.place !== undefined) {
        const root = ownershipLocal(fn, binding.place.root)
        const type = fn.type(expression.type)
        if (root === undefined || type === undefined) return undefined
        const selectors = lowerOwnershipPath(fn, root, binding.place.path, expression.span)
        if (selectors === undefined) return undefined
        if (selectors.length === 0) return { result: root }
        const destination = fn.alloc(type)
        fn.emit({
          _tag: 'ReadPlace',
          destination,
          root,
          selectors,
          type,
          provenance: authored(expression.span),
        })
        return { result: destination }
      }
      const bound = fn.patternLocals.get(patternKey(expression.binding))
      if (bound === undefined) return undefined
      return { result: bound }
    }
    case 'Move': {
      const transition = transitionAt(
        fn,
        expression.span,
        'Move',
        Ownership.placeOf(expression.subject)?.root,
      )
      if (transition === undefined)
        return lowerExpression(fn, expression.subject, availableRequirements)
      const lowered =
        expression.subject._tag === 'Unavailable'
          ? undefined
          : lowerTransferredPlace(fn, transition, expression.subject.type, expression.span)
      if (lowered !== undefined) emitInitializationTransition(fn, transition)
      return lowered
    }
    case 'Replace':
      return lowerReplaceExpression(fn, expression, availableRequirements)
    case 'FunctionItem':
      return lowerFunctionItemExpression(fn, expression)
    case 'CallableSection':
      return lowerCallableSectionExpression(fn, expression, availableRequirements)
    case 'ForeignApply': {
      const arguments_: Array<Mir.LocalId> = []
      let callee: Mir.LocalId | undefined
      for (const child of Tir.expressionChildren(expression)) {
        const value = lowerExpression(fn, child, availableRequirements)
        if (value === 'Transferred' || value === undefined) return value
        if (child === expression.callee) callee = value.result
        else arguments_.push(value.result)
      }
      const type = fn.type(expression.type)
      if (type === undefined || callee === undefined) return undefined
      const destination = fn.alloc(type)
      const contract = expression.contract
      fn.emit({
        _tag: 'ForeignIndirectCall',
        destination,
        callee,
        arguments: arguments_,
        signature: CAbi.signature(
          contract.parameters.map((parameter) => fn.semantic(parameter)),
          fn.semantic(contract.result),
          fn.layout.target,
          contract.contract,
        ),
        type,
        provenance: authored(expression.span),
      })
      endLoans(fn, expression.loanEnds, expression.span)
      return { result: destination }
    }
    case 'CallableApply':
      return lowerCallableApplyExpression(fn, expression, availableRequirements)
    case 'EffectConstruct':
      return lowerEffectConstructExpression(fn, expression, availableRequirements)
    case 'ServiceEffectConstruct':
      return lowerServiceEffectValue(fn, expression, availableRequirements)
    case 'EffectBlock':
      return lowerEffectBlockExpression(fn, expression)
    case 'EffectCatch':
      return lowerCatchEffectValue(fn, expression, availableRequirements)
    case 'Run':
      return lowerRunExpression(fn, expression, availableRequirements)
    case 'UnionConvert':
      return lowerUnionConvertExpression(fn, expression, availableRequirements)
    case 'ShortCircuit':
      return lowerShortCircuitExpression(fn, expression, availableRequirements)
    case 'Match':
      return lowerMatchExpression(fn, expression, availableRequirements)
    case 'Construct':
      return lowerConstructExpression(fn, expression, availableRequirements)
    case 'ConstructUnionVariant':
      return lowerConstructUnionVariantExpression(fn, expression, availableRequirements)
    case 'ArrayConstruct':
      return lowerArrayConstructExpression(fn, expression, availableRequirements)
    case 'Project': {
      return lowerPlace(fn, expression, availableRequirements)
    }
    case 'ReferentPlace': {
      return lowerPlace(fn, expression, availableRequirements)
    }
    case 'IndexPlace': {
      return lowerPlace(fn, expression, availableRequirements)
    }
    case 'SliceBorrow':
      return lowerSliceBorrowExpression(fn, expression, availableRequirements)
    case 'ValueBorrow':
      return lowerValueBorrowExpression(fn, expression, availableRequirements)
    case 'SliceLength':
      return lowerSliceLengthExpression(fn, expression, availableRequirements)
    case 'SliceIndexPlace': {
      return lowerPlace(fn, expression, availableRequirements)
    }
    case 'Call':
      return lowerCallExpression(fn, expression, availableRequirements)
    case 'InterfaceOperationCall':
      return lowerInterfaceOperationCallExpression(fn, expression, availableRequirements)
    case 'BuiltinCall':
      return lowerBuiltinExpression(fn, expression)
    case 'Unavailable':
      return undefined
  }
}

function lowerIntegerLiteralExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'IntegerLiteral' }>,
): LoweredExpression | undefined {
  const type = fn.type(expression.type)
  if (type === undefined || !Type.isBuiltin(Mir.semanticType(type))) return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'Literal',
    destination,
    type,
    value: expression.value,
    provenance: { span: expression.span, generated: false },
  })
  return { result: destination }
}

function lowerFloatingLiteralExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'FloatingLiteral' }>,
): LoweredExpression | undefined {
  const type = fn.type(expression.type)
  if (type?._tag !== expression.type) return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'Literal',
    destination,
    type,
    value: expression.bits,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerEnumMemberExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'EnumMember' }>,
): LoweredExpression | undefined {
  const type = fn.type(expression.type)
  if (
    type?._tag !== 'Enum' ||
    type.representation.enum.module !== expression.enum.module ||
    type.representation.enum.name !== expression.enum.name
  )
    return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'EnumConstant',
    destination,
    enum: expression.enum,
    member: expression.member,
    discriminant: expression.discriminant,
    representation: type.representation,
    type,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerEnumValueExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'EnumValue' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const value = lowerExpression(fn, expression.value, availableRequirements)
  if (value === 'Transferred') return value
  const sourceType = value === undefined ? undefined : fn.localTypes.at(value.result.ordinal)
  const type = fn.type(expression.type)
  if (
    value === undefined ||
    sourceType?._tag !== 'Enum' ||
    type?._tag !== expression.type ||
    sourceType.representation.enum.module !== expression.enum.module ||
    sourceType.representation.enum.name !== expression.enum.name ||
    sourceType.representation.scalar !== expression.type
  )
    return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'EnumValue',
    destination,
    source: value.result,
    enum: expression.enum,
    representation: sourceType.representation,
    type,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerEnumEqualityExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'EnumEquality' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const left = lowerExpression(fn, expression.left, availableRequirements)
  if (left === 'Transferred') return left
  const right = lowerExpression(fn, expression.right, availableRequirements)
  if (right === 'Transferred') return right
  const leftType = left === undefined ? undefined : fn.localTypes.at(left.result.ordinal)
  const rightType = right === undefined ? undefined : fn.localTypes.at(right.result.ordinal)
  if (
    left === undefined ||
    right === undefined ||
    leftType?._tag !== 'Enum' ||
    rightType?._tag !== 'Enum' ||
    leftType.representation.enum.module !== expression.enum.module ||
    leftType.representation.enum.name !== expression.enum.name ||
    rightType.representation.enum.module !== expression.enum.module ||
    rightType.representation.enum.name !== expression.enum.name
  )
    return undefined
  const destination = fn.alloc(bool)
  fn.emit({
    _tag: 'EnumEquality',
    destination,
    left: left.result,
    right: right.result,
    enum: expression.enum,
    negated: expression.negated,
    representation: leftType.representation,
    type: bool,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerStaticStringLiteralExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'StaticStringLiteral' }>,
): LoweredExpression | undefined {
  const type = fn.type(expression.type)
  if (type?._tag !== 'String') return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'StaticString',
    destination,
    data: expression.data.id,
    byteLength: expression.data.bytes.length,
    type,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerRuntimeStringViewExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'RuntimeStringView' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const source = lowerExpression(fn, expression.source, availableRequirements)
  if (source === 'Transferred') return source
  const sourceType = source === undefined ? undefined : fn.localTypes.at(source.result.ordinal)
  const type = fn.type(expression.type)
  if (
    source === undefined ||
    sourceType?._tag !== 'Slice' ||
    sourceType.type.access !== 'Shared' ||
    sourceType.type.element !== 'u8' ||
    type?._tag !== 'String'
  )
    return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'StringFromUtf8Unchecked',
    destination,
    bytes: source.result,
    heldLoans: expression.heldLoans,
    authorization: 'Unsafe',
    type,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerStringEqualityExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'StringEquality' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const left = lowerExpression(fn, expression.left, availableRequirements)
  if (left === 'Transferred') return left
  const right = lowerExpression(fn, expression.right, availableRequirements)
  if (right === 'Transferred') return right
  const leftType = left === undefined ? undefined : fn.localTypes.at(left.result.ordinal)
  const rightType = right === undefined ? undefined : fn.localTypes.at(right.result.ordinal)
  if (
    left === undefined ||
    right === undefined ||
    leftType?._tag !== 'String' ||
    rightType?._tag !== 'String'
  )
    return undefined
  const destination = fn.alloc(bool)
  fn.emit({
    _tag: 'StringEqualsExact',
    destination,
    left: left.result,
    right: right.result,
    negated: expression.negated,
    type: bool,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerStaticByteViewLiteralExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'StaticByteViewLiteral' }>,
): LoweredExpression | undefined {
  const type = fn.type(expression.type)
  if (type?._tag !== 'Slice') return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'StaticView',
    destination,
    data: expression.data.id,
    length: expression.data.bytes.length,
    type,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerUnitLiteralExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'UnitLiteral' }>,
): LoweredExpression | undefined {
  const type = fn.type(expression.type)
  if (type?._tag !== 'Nominal' || !Type.equals(type.type, Type.unit)) return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'Construct',
    destination,
    type,
    fields: [],
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerBooleanLiteralExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'BooleanLiteral' }>,
): LoweredExpression | undefined {
  const destination = fn.alloc(bool)
  fn.emit({
    _tag: 'Literal',
    destination,
    type: bool,
    value: expression.value ? 1 : 0,
    provenance: { span: expression.span, generated: false },
  })
  return { result: destination }
}

function lowerCharacterLiteralExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'CharacterLiteral' }>,
): LoweredExpression | undefined {
  const destination = fn.alloc(character)
  fn.emit({
    _tag: 'Literal',
    destination,
    type: character,
    value: expression.value,
    provenance: { span: expression.span, generated: false },
  })
  return { result: destination }
}

function lowerReplaceExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'Replace' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  // Swap one writable place: the old value reads out before the replacement commits, and
  // both halves ride the existing checked place operations.
  const place = expression.place
  let root =
    place._tag === 'BorrowedWritePlace'
      ? borrowedWriteRoot(fn, place.root)
      : ownedWriteRoot(fn, place.root)
  let rootType = root === undefined ? undefined : fn.localTypes.at(root.ordinal)
  const type = fn.type(place.type)
  if (root === undefined || rootType === undefined || type === undefined) return undefined
  let selectors: ReadonlyArray<Mir.PlaceSelector>
  if (place._tag === 'BorrowedWritePlace') {
    const lowered = lowerBorrowedWritePlace(fn, root, place.selectors, place.type, place.span)
    if (lowered === undefined || lowered === 'Transferred') return lowered
    root = lowered.root
    selectors = lowered.selectors
  } else {
    const selected = lowerWriteSelectors(fn, place.selectors)
    if (selected === undefined || selected === 'Transferred') return selected
    const alias =
      place.root._tag === 'PatternWriteRoot'
        ? patternPlace(fn, place.root.binding, place.span)
        : undefined
    selectors = [...(alias?.selectors ?? []), ...selected]
  }
  rootType = fn.localTypes.at(root.ordinal)
  if (rootType === undefined) return undefined
  fn.emit({
    _tag: 'CheckPlace',
    root,
    selectors,
    type,
    provenance: authored(place.span),
  })
  const value = lowerExpression(fn, expression.value, availableRequirements)
  if (value === 'Transferred') return value
  if (value === undefined) return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'ReadPlace',
    destination,
    root,
    selectors,
    type,
    consume: true,
    provenance: authored(expression.span),
  })
  fn.emit({
    _tag: 'WritePlace',
    root,
    selectors,
    source: value.result,
    rootType,
    type,
    mutable: true,
    replacement: 'Copy',
    commit: 'AfterCleanup',
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerFunctionItemExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'FunctionItem' }>,
): LoweredExpression | undefined {
  const type = functionItemValueType(fn, expression)
  if (type === undefined) return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'MakeCallable',
    destination,
    target: expression.target,
    typeArguments: expression.typeArguments.map((argument) => fn.semanticArgument(argument)),
    captures: [],
    type,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerCallableSectionExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'CallableSection' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const type = callableValueType(fn, expression)
  if (type === undefined) return undefined
  const captures: Array<{
    readonly ordinal: number
    readonly parameterOrdinal: number
    readonly source: Mir.LocalId
    readonly access: Type.CaptureAccess
  }> = []
  for (const capture of expression.captures) {
    const lowered = lowerExpression(fn, capture.value, availableRequirements)
    if (lowered === 'Transferred') return lowered
    if (lowered === undefined) return undefined
    captures.push({
      ordinal: capture.ordinal,
      parameterOrdinal: capture.parameterOrdinal,
      source: lowered.result,
      access: capture.access,
    })
  }
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'MakeCallable',
    destination,
    target: expression.target,
    typeArguments:
      type.environment === undefined
        ? (type.typeArguments ?? [])
        : [...Layout.callableTargetArguments(type.environment)],
    captures: captures,
    type,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

/**
 * A staged application builds a new callable value: the callee's environment is spliced ahead of
 * the argument captures and the callee's target is kept, so no engine needs a thunk.
 */
function lowerStagedCallableApply(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'CallableApply' }>,
  site: Tir.CallableSiteId,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const type = stagedCallableValueType(fn, expression, site)
  const environment = type?.environment
  if (type === undefined || environment === undefined) return undefined
  let base: Mir.LocalId | undefined
  const sources: Array<Mir.LocalId> = []
  const lowerCallee = (): boolean | 'Transferred' => {
    const lowered = lowerExpression(fn, expression.callee, availableRequirements)
    if (lowered === 'Transferred') return lowered
    if (lowered === undefined || fn.localTypes.at(lowered.result.ordinal)?._tag !== 'CallableValue')
      return false
    base = lowered.result
    return true
  }
  const lowerArguments = (): boolean | 'Transferred' => {
    for (const argument of expression.arguments) {
      const lowered = lowerExpression(fn, argument, availableRequirements)
      if (lowered === 'Transferred') return lowered
      if (lowered === undefined) return false
      sources.push(lowered.result)
    }
    return true
  }
  const first = expression.evaluation === 'LeftThenCallable' ? lowerArguments() : lowerCallee()
  if (first === 'Transferred') return first
  if (!first) return undefined
  const lowered = expression.evaluation === 'LeftThenCallable' ? lowerCallee() : lowerArguments()
  if (lowered === 'Transferred') return lowered
  if (!lowered || base === undefined) return undefined
  const baseCount = environment.fields.length - sources.length
  const captures: Array<{
    readonly ordinal: number
    readonly parameterOrdinal: number
    readonly source: Mir.LocalId
    readonly access: Type.CaptureAccess
  }> = []
  for (const [ordinal, source] of sources.entries()) {
    const field = environment.fields.find((candidate) => candidate.ordinal === baseCount + ordinal)
    if (field === undefined) return undefined
    captures.push({
      ordinal: field.ordinal,
      parameterOrdinal: field.parameterOrdinal,
      source,
      access: field.access,
    })
  }
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'MakeCallable',
    destination,
    target: type.target,
    typeArguments: [...Layout.callableTargetArguments(environment)],
    base,
    captures: captures,
    type,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerCallableApplyExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'CallableApply' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  if (expression.staged !== undefined)
    return lowerStagedCallableApply(fn, expression, expression.staged.site, availableRequirements)
  const directSection =
    expression.realization === 'DirectErasedSection' && expression.callee._tag === 'CallableSection'
      ? expression.callee
      : undefined
  const directItem = expression.callee._tag === 'FunctionItem' ? expression.callee : undefined
  const call = fn.call(expression)
  let directType: ReturnType<typeof directCallableSectionValueType>
  if (directSection !== undefined) {
    directType = directCallableSectionValueType(fn, directSection, expression.substitution)
  } else if (directItem !== undefined) {
    directType = functionItemValueType(fn, directItem, expression.substitution)
  }
  const arguments_: Array<Mir.LocalId> = []
  const captures: Array<{
    readonly ordinal: number
    readonly parameterOrdinal: number
    readonly source: Mir.LocalId
    readonly access: Type.CaptureAccess
  }> = []
  let callable: Mir.LocalId | undefined
  let callableType: Type.Callable | undefined
  let target: Tir.CallableTarget | undefined
  let typeArguments: ReadonlyArray<Type.GenericArgument> = []
  const provision = forwardedServiceProvision(fn, expression, availableRequirements)
  if (provision === 'Transferred') return provision
  const lowerArguments = (): boolean | 'Transferred' => {
    for (const argument of expression.arguments) {
      const lowered = lowerOperandWithProvision(fn, provision, argument, availableRequirements)
      if (lowered === 'Transferred') return lowered
      if (lowered === undefined) return false
      arguments_.push(lowered.result)
    }
    return true
  }
  const lowerCallee = (): boolean | 'Transferred' => {
    if (directSection !== undefined || directItem !== undefined) {
      if (directType === undefined) return false
      callableType = directType.type
      target = directType.target
      typeArguments =
        call?.target.typeArguments ??
        directType.environment?.callable.typeArguments ??
        [...expression.substitution.values()].map((argument) => fn.semanticArgument(argument))
      if (directSection !== undefined) {
        for (const capture of directSection.captures) {
          const lowered = lowerOperandWithProvision(
            fn,
            provision,
            capture.value,
            availableRequirements,
          )
          if (lowered === 'Transferred') return lowered
          if (lowered === undefined) return false
          captures.push({
            ordinal: capture.ordinal,
            parameterOrdinal: capture.parameterOrdinal,
            source: lowered.result,
            access: capture.access,
          })
        }
      }
      return true
    }
    const lowered = lowerExpression(fn, expression.callee, availableRequirements)
    if (lowered === 'Transferred') return lowered
    const loweredType = lowered === undefined ? undefined : fn.localTypes.at(lowered.result.ordinal)
    if (lowered === undefined || loweredType?._tag !== 'CallableValue') return false
    callable = lowered.result
    callableType = loweredType.type
    // A realized environment names its hidden instance by its type arguments plus the
    // identities of the callables it captured, exactly as its construction registered it.
    typeArguments =
      loweredType.environment === undefined
        ? (loweredType.storage?.realization.targetArguments ?? loweredType.typeArguments ?? [])
        : [...Layout.callableTargetArguments(loweredType.environment)]
    return true
  }
  const first = expression.evaluation === 'LeftThenCallable' ? lowerArguments() : lowerCallee()
  if (first === 'Transferred') return first
  if (!first) return undefined
  const lowered = expression.evaluation === 'LeftThenCallable' ? lowerCallee() : lowerArguments()
  if (lowered === 'Transferred') return lowered
  const definition =
    callable === undefined ? undefined : fn.callableDefinitions.get(callable.ordinal)
  const realizedTarget = target ?? definition?.target
  const declaredEffectValue = (() => {
    if (call !== undefined) return fn.effectResults.get(Instances.keyText(call.target))
    if (realizedTarget?._tag === 'DeclarationCallableTarget')
      return fn.effectResults.get(instanceText(realizedTarget.declaration, typeArguments))
    return undefined
  })()
  const semanticType = fn.semantic(expression.type)
  const type =
    (call === undefined || !Type.isEffect(semanticType)
      ? undefined
      : effectValueForCall(
          fn.layout,
          call,
          semanticType,
          provision === undefined ? availableRequirements : provision.requirements,
        )) ??
    declaredEffectValue ??
    fn.type(expression.type) ??
    (realizedTarget?._tag === 'DeclarationCallableTarget'
      ? resultCallableValueType(
          fn.layout,
          fn.instances,
          realizedTarget.declaration,
          typeArguments,
          semanticType,
        )
      : undefined)
  if (!lowered || type === undefined || callableType === undefined) return undefined
  if (
    realizedTarget?._tag === 'BuiltinCallableTarget' &&
    Scalar.isCheckedOperation(realizedTarget.operation)
  ) {
    const actorScalar = Scalar.find(realizedTarget.actor)
    const scalarOperation = actorScalar?.operations.find(
      (operation) => operation.code === realizedTarget.operation,
    )
    const sourceScalar = Scalar.find(
      scalarOperation?.parameters?.at(0) ?? actorScalar?.spelling ?? '',
    )
    const valueScalar =
      realizedTarget.operation === 'CheckedConvertToChar'
        ? actorScalar
        : (Scalar.conversionTarget(realizedTarget.operation) ?? actorScalar)
    const realizedCaptures = definition?.captures ?? captures
    const ordered: Array<Mir.LocalId | undefined> = Array.from({
      length: (scalarOperation?.arity ?? 0) + 2,
    })
    for (const capture of realizedCaptures) ordered[capture.parameterOrdinal] = capture.source
    for (const argument of arguments_) {
      const empty = ordered.indexOf(undefined)
      if (empty >= 0) ordered[empty] = argument
    }
    const operands = ordered
      .slice(0, scalarOperation?.arity ?? 0)
      .filter((operand): operand is Mir.LocalId => operand !== undefined)
    const present = ordered.at(scalarOperation?.arity ?? -1)
    const absent = ordered.at((scalarOperation?.arity ?? -1) + 1)
    const first = operands.at(0)
    const sourceType = first === undefined ? undefined : fn.localTypes.at(first.ordinal)
    const presentType = present === undefined ? undefined : fn.localTypes.at(present.ordinal)
    const absentType = absent === undefined ? undefined : fn.localTypes.at(absent.ordinal)
    if (
      sourceScalar?.category !== 'Integer' ||
      (valueScalar?.category !== 'Integer' && valueScalar?.category !== 'Character') ||
      scalarOperation === undefined ||
      present === undefined ||
      absent === undefined ||
      presentType?._tag !== 'CallableValue' ||
      absentType?._tag !== 'CallableValue' ||
      operands.length !== scalarOperation.arity ||
      sourceType?._tag !== sourceScalar.spelling ||
      operands.some((operand) => fn.localTypes.at(operand.ordinal)?._tag !== sourceType._tag)
    )
      return undefined
    const valid = fn.alloc({ _tag: 'bool' as const })
    const value = fn.alloc({ _tag: valueScalar.spelling })
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'CheckedScalar' as const,
      operation: scalarOperation.code,
      destination,
      valid,
      value,
      operands: operands,
      present,
      absent,
      presentCleanup: ConcreteCleanup.forCallable(fn, presentType),
      absentCleanup: ConcreteCleanup.forCallable(fn, absentType),
      sourceType,
      valueType: { _tag: valueScalar.spelling },
      type,
      provenance: authored(expression.span),
    })
    return { result: destination }
  }
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'ApplyCallable',
    destination,
    ...(callable === undefined ? {} : { callable }),
    ...(target === undefined ? {} : { target }),
    typeArguments,
    captures: captures,
    arguments: arguments_,
    callableType,
    access: callableType.mode,
    evaluation: expression.evaluation,
    realization: callable === undefined ? 'DirectErasedSection' : expression.realization,
    type,
    provenance: authored(expression.span),
  })
  for (const authored of expression.loanEnds) {
    const borrow = fn.recipeBorrow(authored)
    const loan = fn.loanLocals.get(borrowKey(borrow))
    if (loan === undefined) return undefined
    fn.emit({
      _tag: 'EndLoan',
      borrow,
      slice: loan,
      provenance: generated(expression.span),
    })
    fn.loanLocals.delete(borrowKey(borrow))
  }
  for (const capture of directSection?.captures ?? []) {
    if (capture.value._tag !== 'SliceBorrow' && capture.value._tag !== 'ValueBorrow') continue
    const borrow = fn.recipeBorrow(capture.value.borrow)
    if (
      expression.heldLoans.some((held) => borrowKey(fn.recipeBorrow(held)) === borrowKey(borrow))
    ) {
      continue
    }
    const held = fn.loanLocals.get(borrowKey(borrow))
    if (held === undefined) return undefined
    fn.emit({
      _tag: 'EndLoan',
      borrow,
      slice: held,
      provenance: generated(expression.span),
    })
    fn.loanLocals.delete(borrowKey(borrow))
  }
  return { result: destination }
}

function lowerEffectConstructExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'EffectConstruct' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const authoredTypeArguments = expression.typeArguments.map((argument) =>
    fn.semanticArgument(argument),
  )
  const call = fn.call(
    expression,
    undefined,
    authoredTypeArguments,
    expression.staticArguments,
    availableRequirements,
  )
  const typeArguments = call?.target.typeArguments ?? authoredTypeArguments
  const staticArguments = call?.target.staticArguments ?? expression.staticArguments
  const semanticType = fn.semantic(expression.type)
  const provision = forwardedServiceProvision(fn, expression, availableRequirements)
  if (provision === 'Transferred') return provision
  const resultType =
    (call === undefined || !Type.isEffect(semanticType)
      ? undefined
      : effectValueForCall(
          fn.layout,
          call,
          semanticType,
          provision === undefined ? availableRequirements : provision.requirements,
        )) ??
    fn.effectResults.get(
      call === undefined
        ? instanceText(expression.target, typeArguments, staticArguments)
        : Instances.keyText(call.target),
    )
  if (resultType === undefined) return undefined
  const arguments_: Array<Mir.LocalId> = []
  for (const argument of expression.arguments) {
    const lowered = lowerOperandWithProvision(fn, provision, argument, availableRequirements)
    if (lowered === 'Transferred') return lowered
    if (lowered === undefined) return undefined
    arguments_.push(lowered.result)
  }
  const destination = fn.alloc(resultType)
  fn.emit({
    _tag: 'Call',
    destination,
    target: expression.target,
    typeArguments: typeArguments,
    ...(staticArguments.length === 0 ? {} : { staticArguments }),
    arguments: arguments_,
    type: resultType,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerEffectBlockExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'EffectBlock' }>,
): LoweredExpression | undefined {
  const semanticType = fn.semantic(expression.type)
  const type = Type.isEffect(semanticType)
    ? effectValueType(fn.layout, fn.owner.key, expression, semanticType)
    : undefined
  if (type === undefined) return undefined
  const captures: Array<{
    readonly source: Mir.LocalId
    readonly access: Type.CaptureAccess
  }> = []
  for (const [ordinal, capture] of expression.captures.entries()) {
    let source: Mir.LocalId | undefined
    if (capture.binding !== undefined) {
      source = fn.bindingLocals.get(capture.binding.ordinal)
    } else if (capture.parameter !== undefined) {
      source = fn.parameterLocals.get(capture.parameter.ordinal)
    } else if (capture.pattern !== undefined) {
      source = fn.patternLocals.get(patternKey(capture.pattern))
    }
    if (source === undefined) return undefined
    const access = type.environment.fields.at(ordinal)?.access
    if (access === undefined) return undefined
    captures.push({ source, access })
  }
  const destination = fn.alloc(type)
  const runner = Tir.effectRunnerId(fn.owner.key.declaration, expression.site)
  fn.emit({
    _tag: 'MakeEffect',
    destination,
    runner,
    runnerTypeArguments: fn.owner.key.typeArguments,
    captures: captures,
    type,
    provenance: authored(expression.span),
  })
  const specializationKey = baseRunnerKey(fn.owner.key, expression.site, type.type)
  if (!fn.generatedRunners.some((candidate) => candidate.specializationKey === specializationKey)) {
    fn.generatedRunners.push({
      _tag: 'BlockEffectRunner',
      id: runner,
      owner: fn.owner,
      block: expression,
      type,
      specializationKey,
      providedRequirements: [],
      witnessTargets: specializedWitnessEffectTargets(fn.index, fn.owner, expression),
    })
  }
  return { result: destination }
}

function lowerRunExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'Run' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  return fn.withRecipeReplay(() => {
    const resultRecipe = effectRecipe(fn, expression.subject)
    if (resultRecipe?._tag === 'EffectCatch')
      return lowerEffectCatch(fn, resultRecipe, expression.span, undefined, availableRequirements)
    if (resultRecipe !== undefined && inlineForwardedRequirement(fn, resultRecipe) !== undefined) {
      return lowerEffectExecution(
        fn,
        resultRecipe,
        expression.type,
        expression.span,
        availableRequirements,
      )
    }
    if (
      resultRecipe?._tag === 'CallableApply' &&
      !Type.isEffect(fn.semantic(expression.type)) &&
      callableRecipe(fn, resultRecipe.callee) !== undefined
    )
      return lowerEffectExecution(
        fn,
        resultRecipe,
        expression.type,
        expression.span,
        availableRequirements,
      )
    if (resultRecipe?._tag === 'ServiceEffectConstruct')
      return lowerEffectExecution(
        fn,
        resultRecipe,
        expression.type,
        expression.span,
        availableRequirements,
      )
    const recipe = resultRecipe
    // Compiler-backed effects lower directly from their recipe. Lowering the effect expression
    // first would form every borrowed argument twice before the dedicated operation is emitted.
    const loweredSubject =
      recipe?._tag === 'BuiltinCall' &&
      recipe.witnessEffectSite === undefined &&
      (recipe.operation !== 'EffectSuspend' || fn.builtinEffectRunner)
        ? undefined
        : lowerExpression(
            fn,
            recipe?._tag === 'Match' ? recipe : expression.subject,
            availableRequirements,
          )
    if (loweredSubject === 'Transferred') return loweredSubject
    const effectValueType =
      loweredSubject === undefined ? undefined : fn.localTypes.at(loweredSubject.result.ordinal)
    if (loweredSubject !== undefined && effectValueType?._tag === 'EffectValue') {
      const outcomeType: Extract<Mir.Type, { readonly _tag: 'EffectOutcome' }> = {
        _tag: 'EffectOutcome',
        type: effectValueType.type,
      }
      const structuralSuccess = fn.semantic(expression.type)
      const successType = Type.isEffect(structuralSuccess)
        ? effectValueByIdentity(
            fn.layout,
            effectValueType.environment.successEffectIdentity ?? '',
            structuralSuccess,
          )
        : fn.type(expression.type)
      if (successType === undefined || successType._tag === 'EffectOutcome') return undefined
      const outcome = fn.alloc(outcomeType)
      const destination = fn.alloc(successType)
      const propagationType =
        Type.failureMembers(effectValueType.type).length === 0 || fn.effectOutcome === undefined
          ? undefined
          : fn.type(fn.effectOutcome)
      if (propagationType !== undefined && propagationType._tag !== 'EffectOutcome')
        return undefined
      const tagMappings = Type.failureMembers(effectValueType.type).flatMap((failure, source) => {
        const target =
          propagationType === undefined
            ? undefined
            : Type.failureMembers(propagationType.type).findIndex(
                (candidate) => Type.runtimeKey(candidate) === Type.runtimeKey(failure),
              )
        return target === undefined || target < 0
          ? []
          : [{ source: source + 1, target: target + 1 }]
      })
      if (tagMappings.length !== Type.failureMembers(effectValueType.type).length) return undefined
      const propagationShape =
        propagationType === undefined
          ? undefined
          : Layout.callingShape(fn.layout, propagationType.type)
      const releases = propagationReleases(fn, expression.span)
      const failureEnds = propagationLoanEnds(fn, expression.span)
      const provided = requirementsFor(fn.providedRequirements, effectValueType.type)
      const runner =
        provided === undefined ? undefined : ensureEffectRunner(fn, effectValueType, provided)
      if (provided === undefined || runner === undefined) return undefined
      const baseRunner =
        effectValueType.storage?.realization.runner ??
        Tir.effectRunnerId(effectValueType.environment.instance.declaration, effectValueType.site)
      const runnerInstance =
        effectValueType.storage?.realization.runnerInstance ?? effectValueType.environment.instance
      const baseRunnerTypeArguments =
        effectValueType.storage?.realization.runnerArguments ??
        effectValueType.environment.instance.typeArguments
      fn.emit({
        _tag: 'RunEffectValue',
        destination,
        outcome,
        effect: loweredSubject.result,
        runner,
        runnerTypeArguments: baseRunnerTypeArguments,
        ...(runnerInstance.staticArguments.length === 0
          ? {}
          : {
              runnerStaticArguments: runnerInstance.staticArguments,
            }),
        ...(provided.length === 0
          ? {}
          : {
              runnerBase: {
                declaration: baseRunner,
                typeArguments: baseRunnerTypeArguments,
                ...(runnerInstance.staticArguments.length === 0
                  ? {}
                  : { staticArguments: runnerInstance.staticArguments }),
              },
            }),
        providers: providerBindings(provided),
        arguments: runtimeRequirementArguments(provided),
        outcomeType,
        ...(propagationType === undefined ? {} : { propagationType }),
        tagMappings: tagMappings,
        propagationLaneCount: propagationShape?.laneCount ?? 0,
        ...(Type.failureMembers(effectValueType.type).length === 0 || failureEnds.length === 0
          ? {}
          : { failureLoanEnds: failureEnds }),
        ...(propagationType === undefined || releases.length === 0 ? {} : { releases }),
        type: successType,
        provenance: authored(expression.span),
      })
      endRunLoans(fn, expression.span)
      let storedBinding: number | undefined
      if (expression.subject._tag === 'BindingReference') {
        storedBinding = expression.subject.binding.ordinal
      } else if (
        expression.subject._tag === 'Move' &&
        expression.subject.subject._tag === 'BindingReference'
      ) {
        storedBinding = expression.subject.subject.binding.ordinal
      }
      if (storedBinding !== undefined) {
        endLoans(fn, fn.effectLoanEnds.get(storedBinding) ?? [], expression.span)
        fn.effectLoanEnds.delete(storedBinding)
      }
      if (
        expression.subject._tag === 'EffectConstruct' ||
        ((expression.subject._tag === 'BuiltinCall' ||
          expression.subject._tag === 'InterfaceOperationCall') &&
          expression.subject.witnessEffectSite !== undefined)
      )
        endLoans(fn, expression.subject.loanEnds, expression.span)
      return { result: destination }
    }
    if (loweredSubject !== undefined && effectValueType?._tag === 'EffectComposite') {
      const result = lowerRunEffectComposite(
        fn,
        loweredSubject.result,
        effectValueType,
        expression.type,
        expression.span,
        availableRequirements,
      )
      if (result === 'Transferred') return result
      if (result !== undefined) endRunLoans(fn, expression.span)
      return result
    }
    if (recipe?._tag === 'EffectBindRequirement') {
      return lowerEffectExecution(
        fn,
        recipe,
        expression.type,
        expression.span,
        availableRequirements,
      )
    }
    if (recipe?._tag === 'BuiltinCall' && recipe.operation === 'EffectSuspend') {
      const deferred = recipe.arguments.at(0)
      return deferred === undefined
        ? undefined
        : lowerEffectExecution(
            fn,
            deferred,
            expression.type,
            expression.span,
            availableRequirements,
          )
    }
    if (
      recipe?._tag === 'BuiltinCall' &&
      (recipe.operation === 'EffectFinalize' || recipe.operation === 'EffectFinalizeNonParking')
    ) {
      const [protectedExpression, finalizerExpression] = recipe.arguments
      if (protectedExpression === undefined || finalizerExpression === undefined) return undefined
      const protectedValue = lowerExpression(fn, protectedExpression, availableRequirements)
      if (protectedValue === undefined || protectedValue === 'Transferred') return protectedValue
      const finalizer = lowerExpression(fn, finalizerExpression, availableRequirements)
      if (finalizer === undefined || finalizer === 'Transferred') return finalizer
      const protectedType = fn.localTypes.at(protectedValue.result.ordinal)
      const finalizerType = fn.localTypes.at(finalizer.result.ordinal)
      if (
        (protectedType?._tag !== 'EffectValue' && protectedType?._tag !== 'EffectComposite') ||
        (finalizerType?._tag !== 'EffectValue' && finalizerType?._tag !== 'EffectComposite')
      )
        return undefined
      return lowerFinalizedEffect(
        fn,
        protectedValue.result,
        protectedType,
        finalizer.result,
        finalizerType,
        expression.span,
        protectedExpression.span,
        finalizerExpression.span,
        availableRequirements,
        recipe.operation === 'EffectFinalizeNonParking',
      )
    }
    if (recipe?._tag === 'BuiltinCall' && recipe.operation === 'EffectUseReleaseNonParking') {
      const [resource, use, release] = recipe.arguments
      if (resource === undefined || use === undefined || release === undefined) return undefined
      return lowerUseReleaseNonParking(
        fn,
        resource,
        use,
        release,
        expression.span,
        availableRequirements,
      )
    }
    if (recipe?._tag === 'BuiltinCall' && recipe.operation === 'EffectObserveDiagnostics') {
      const [stateExpression, observerExpression, protectedExpression] = recipe.arguments
      if (
        stateExpression === undefined ||
        observerExpression === undefined ||
        protectedExpression === undefined
      )
        return undefined
      const state = lowerExpression(fn, stateExpression, availableRequirements)
      if (state === undefined || state === 'Transferred') return state
      const observer = lowerExpression(fn, observerExpression, availableRequirements)
      if (observer === undefined || observer === 'Transferred') return observer
      const protected_ = lowerExpression(fn, protectedExpression, availableRequirements)
      if (protected_ === undefined || protected_ === 'Transferred') return protected_
      const protectedType = fn.localTypes.at(protected_.result.ordinal)
      const observerType = fn.localTypes.at(observer.result.ordinal)
      const type = fn.type(expression.type)
      const resultShape = Layout.callingShape(fn.layout, fn.semantic(expression.type))
      if (
        observerType?._tag !== 'CallableValue' ||
        type === undefined ||
        type._tag === 'EffectOutcome' ||
        resultShape === undefined ||
        stateExpression._tag === 'Unavailable' ||
        (protectedType?._tag !== 'EffectValue' && protectedType?._tag !== 'EffectComposite')
      )
        return undefined
      const body = lowerExecution(fn, expression.span, () =>
        protectedType._tag === 'EffectValue'
          ? lowerRunEffectValue(
              fn,
              protected_.result,
              protectedType,
              expression.type,
              expression.span,
              availableRequirements,
            )
          : lowerRunEffectComposite(
              fn,
              protected_.result,
              protectedType,
              expression.type,
              expression.span,
              availableRequirements,
            ),
      )
      if (body === undefined) return undefined
      const destination = fn.alloc(type)
      fn.emit({
        _tag: 'DiagnosticScope',
        destination,
        state: state.result,
        observer: observer.result,
        body,
        stateCleanup: ConcreteCleanup.forType(fn, stateExpression.type),
        observerCleanup: ConcreteCleanup.forCallable(fn, observerType),
        type,
        resultShape,
        provenance: generated(expression.span),
      })
      return body.result === undefined ? 'Transferred' : { result: destination }
    }
    if (recipe?._tag === 'BuiltinCall' && recipe.operation === 'ExecutionDrive') {
      const [executionExpression, branchExpression, completeExpression, suspendExpression] =
        recipe.arguments
      if (
        executionExpression === undefined ||
        branchExpression === undefined ||
        completeExpression === undefined ||
        suspendExpression === undefined
      )
        return undefined
      const execution = lowerExpression(fn, executionExpression, availableRequirements)
      if (execution === 'Transferred') return execution
      const branch = lowerExpression(fn, branchExpression, availableRequirements)
      if (branch === 'Transferred') return branch
      const onComplete = lowerExpression(fn, completeExpression, availableRequirements)
      if (onComplete === 'Transferred') return onComplete
      const onSuspend = lowerExpression(fn, suspendExpression, availableRequirements)
      if (onSuspend === 'Transferred') return onSuspend
      const type = fn.type(expression.type)
      const executionType =
        execution === undefined ? undefined : fn.localTypes.at(execution.result.ordinal)
      if (
        execution === undefined ||
        branch === undefined ||
        onComplete === undefined ||
        onSuspend === undefined ||
        executionType?._tag !== 'Nominal' ||
        !Type.isExecution(executionType.type) ||
        type?._tag !== 'Nominal' ||
        !Type.equals(type.type, Type.unit)
      )
        return undefined
      const destination = fn.alloc(type)
      const drivenResult = Type.typeArgumentAt(executionType.type, 0)
      const result = drivenResult === undefined ? undefined : fn.type(drivenResult)
      if (result === undefined || result._tag === 'EffectOutcome') return undefined
      const resultLocal = fn.alloc(result)
      const representedArguments = recipe.typeArguments.map((argument) =>
        fn.semanticArgument(argument),
      )
      const callableTypeArguments = (ordinal: number): ReadonlyArray<Type.GenericArgument> => {
        const argument = representedArguments.at(ordinal)
        return argument !== undefined &&
          Type.isExactRepresentationArgument(argument) &&
          Type.isCallableIdentityArgument(argument.identity)
          ? argument.identity.typeArguments
          : []
      }
      const callbackCleanup = (local: Mir.LocalId): CleanupPlan.CleanupPlan => {
        const localType = fn.localTypes.at(local.ordinal)
        return localType?._tag === 'CallableValue'
          ? ConcreteCleanup.forCallable(fn, localType)
          : ConcreteCleanup.forType(
              fn,
              localType === undefined ? Type.unit : Mir.semanticType(localType),
            )
      }
      fn.emit({
        _tag: 'ExecutionDrive' as const,
        destination,
        result: resultLocal,
        execution: execution.result,
        branch: branch.result,
        onComplete: onComplete.result,
        onSuspend: onSuspend.result,
        executionAccess: 'Take' as const,
        branchAccess: 'Take' as const,
        completionAccess: 'Take' as const,
        suspensionAccess: 'Take' as const,
        completionCleanup: callbackCleanup(onComplete.result),
        suspensionCleanup: callbackCleanup(onSuspend.result),
        completionTypeArguments: callableTypeArguments(2),
        suspensionTypeArguments: callableTypeArguments(3),
        type,
        provenance: authored(expression.span),
      })
      return { result: destination }
    }
    if (recipe?._tag === 'BuiltinCall' && recipe.operation === 'ExecutionPark') {
      const [registerExpression] = recipe.arguments
      if (registerExpression === undefined) return undefined
      const register = lowerExpression(fn, registerExpression, availableRequirements)
      if (register === 'Transferred') return register
      const type = fn.type(expression.type)
      const guardArgument = recipe.typeArguments.at(0)
      const semanticGuard =
        guardArgument === undefined ? undefined : fn.semanticArgument(guardArgument)
      const representation = recipe.typeArguments.at(1)
      const semanticRepresentation =
        representation === undefined ? undefined : fn.semanticArgument(representation)
      const guardType =
        semanticGuard !== undefined &&
        (Type.isTypeArgument(semanticGuard) ||
          (typeof semanticGuard !== 'string' && semanticGuard._tag === 'RepresentedType'))
          ? semanticGuard
          : undefined
      const registrationIdentity =
        semanticRepresentation !== undefined &&
        Type.isExactRepresentationArgument(semanticRepresentation) &&
        Type.isCallableIdentityArgument(semanticRepresentation.identity)
          ? semanticRepresentation.identity
          : undefined
      const registrationTarget = registrationIdentity?.target
      const registrationArguments = registrationIdentity?.typeArguments ?? []
      const resultCallableCandidates =
        registrationTarget?._tag === 'Declaration'
          ? fn.instances.flatMap((candidate) => {
              if (
                candidate.key.declaration.module !== registrationTarget.module ||
                candidate.key.declaration.name !== registrationTarget.name ||
                !registrationArguments.every((argument, ordinal) => {
                  const candidateArgument = candidate.key.typeArguments.at(ordinal)
                  return (
                    candidateArgument !== undefined &&
                    Type.equalsGenericArgument(argument, candidateArgument)
                  )
                }) ||
                candidate.resultCallable === undefined
              )
                return []
              return [candidate.resultCallable]
            })
          : []
      const resultCallable = resultCallableCandidates.at(0)
      const unambiguousResultCallable =
        resultCallable !== undefined &&
        resultCallableCandidates.every((candidate) =>
          Type.equalsGenericArgument(resultCallable, candidate),
        )
          ? resultCallable
          : undefined
      const guard =
        guardType === undefined
          ? undefined
          : (fn.type(guardType) ??
            (Type.isCallable(guardType) && unambiguousResultCallable !== undefined
              ? (() => {
                  const realized = callableValueByIdentity(
                    fn.layout,
                    unambiguousResultCallable,
                    guardType,
                  )
                  return realized === undefined ? undefined : { ...realized, type: guardType }
                })()
              : undefined))
      const registerType =
        register === undefined ? undefined : fn.localTypes.at(register.result.ordinal)
      if (
        register === undefined ||
        registerType?._tag !== 'CallableValue' ||
        guard === undefined ||
        guard._tag === 'EffectOutcome' ||
        type?._tag !== 'Nominal' ||
        !Type.equals(type.type, Type.unit)
      )
        return undefined
      const destination = fn.alloc(type)
      const guardLocal = fn.alloc(guard)
      const registrationTypeArguments =
        semanticRepresentation !== undefined &&
        Type.isExactRepresentationArgument(semanticRepresentation) &&
        Type.isCallableIdentityArgument(semanticRepresentation.identity)
          ? semanticRepresentation.identity.typeArguments
          : []
      fn.emit({
        _tag: 'ExecutionPark' as const,
        destination,
        guard: guardLocal,
        register: register.result,
        registerAccess: 'Take' as const,
        guardCleanup:
          guard._tag === 'CallableValue'
            ? ConcreteCleanup.forCallable(fn, guard)
            : ConcreteCleanup.forType(fn, Mir.semanticType(guard)),
        registerCleanup: ConcreteCleanup.forCallable(fn, registerType),
        registrationTypeArguments,
        type,
        provenance: authored(expression.span),
      })
      return { result: destination }
    }
    if (recipe?._tag === 'BuiltinCall' && recipe.operation === 'StorageAcquire') {
      const [layoutExpression] = recipe.arguments
      if (layoutExpression === undefined || fn.effectOutcome === undefined) return undefined
      const loweredLayout = lowerExpression(fn, layoutExpression, availableRequirements)
      if (loweredLayout === 'Transferred') return loweredLayout
      const type = fn.type(expression.type)
      const propagationType = fn.type(fn.effectOutcome)
      const failureTag = Type.failureMembers(fn.effectOutcome).findIndex((failure) =>
        Type.equals(failure, Type.storageFailure),
      )
      if (
        loweredLayout === undefined ||
        type?._tag !== 'Nominal' ||
        !Type.equals(type.type, Type.allocation) ||
        propagationType?._tag !== 'EffectOutcome' ||
        failureTag < 0
      )
        return undefined
      const destination = fn.alloc(type)
      fn.emit({
        _tag: 'Allocate' as const,
        destination,
        layout: loweredLayout.result,
        type,
        failure: Type.storageFailure,
        propagationType,
        failureTag: failureTag + 1,
        provenance: authored(expression.span),
      })
      return { result: destination }
    }
    if (recipe?._tag !== 'EffectConstruct') return undefined
    const authoredTypeArguments = recipe.typeArguments.map((argument) =>
      fn.semanticArgument(argument),
    )
    const call = fn.call(
      recipe,
      undefined,
      authoredTypeArguments,
      recipe.staticArguments,
      availableRequirements,
    )
    // Every Effect constructor carries a hidden executable identity. Never emit an authored-only
    // target when discovery could not select its complete callable/Effect specialization.
    if (call === undefined) return undefined
    const typeArguments = call.target.typeArguments
    const staticArguments = call.target.staticArguments
    const arguments_: Array<Mir.LocalId> = []
    for (const argument of recipe.arguments) {
      const lowered = lowerExpression(fn, argument, availableRequirements)
      if (lowered === 'Transferred') return lowered
      if (lowered === undefined) return undefined
      arguments_.push(lowered.result)
    }
    const outcomeType = fn.type(recipe.type)
    const successType = fn.type(expression.type)
    if (
      outcomeType?._tag !== 'EffectOutcome' ||
      successType === undefined ||
      successType._tag === 'EffectOutcome'
    )
      return undefined
    const outcome = fn.alloc(outcomeType)
    const destination = fn.alloc(successType)
    if (Type.failureMembers(recipe.type).length > 0) {
      const propagationType = fn.effectOutcome === undefined ? undefined : fn.type(fn.effectOutcome)
      const propagationShape =
        fn.effectOutcome === undefined
          ? undefined
          : Layout.callingShape(fn.layout, fn.effectOutcome)
      if (propagationType?._tag !== 'EffectOutcome' || propagationShape === undefined)
        return undefined
      const tagMappings = Type.failureMembers(recipe.type).flatMap((failure, source) => {
        const target = Type.failureMembers(propagationType.type).findIndex(
          (candidate) => Type.runtimeKey(candidate) === Type.runtimeKey(failure),
        )
        return target < 0 ? [] : [{ source: source + 1, target: target + 1 }]
      })
      if (tagMappings.length !== Type.failureMembers(recipe.type).length) return undefined
      const failureEnds = propagationLoanEnds(fn, expression.span)
      const releases = propagationReleases(fn, expression.span)
      fn.emit({
        _tag: 'RunEffect',
        destination,
        outcome,
        target: recipe.target,
        typeArguments,
        ...(staticArguments.length === 0 ? {} : { staticArguments }),
        arguments: arguments_,
        outcomeType,
        propagationType,
        ...(failureEnds.length === 0 ? {} : { failureLoanEnds: failureEnds }),
        ...(releases.length === 0 ? {} : { releases }),
        tagMappings: tagMappings,
        propagationLaneCount: propagationShape.laneCount,
        type: successType,
        provenance: authored(expression.span),
      })
      // The effect held its argument borrows for exactly this run; end them here.
      endLoans(fn, recipe.loanEnds, expression.span)
      return { result: destination }
    }
    fn.emit({
      _tag: 'Call',
      destination: outcome,
      target: recipe.target,
      typeArguments,
      ...(staticArguments.length === 0 ? {} : { staticArguments }),
      arguments: arguments_,
      type: outcomeType,
      provenance: authored(expression.span),
    })
    endLoans(fn, recipe.loanEnds, expression.span)
    fn.emit({
      _tag: 'UnpackEffectSuccess',
      destination,
      source: outcome,
      type: successType,
      provenance: authored(expression.span),
    })
    return { result: destination }
  })
}

function lowerUnionConvertExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'UnionConvert' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const source = lowerExpression(fn, expression.source, availableRequirements)
  if (source === 'Transferred') return source
  // Effect access is a semantic ownership coercion. Hidden construction identity has already
  // selected one concrete EffectValue layout, so the runtime representation is unchanged.
  if (expression.conversion === 'EffectAccess') return source
  if (expression.conversion === 'EffectJoin') {
    const composite = fn.type(expression.type)
    return source === undefined || composite?._tag !== 'EffectComposite'
      ? undefined
      : packEffectComposite(fn, source, composite, expression.span)
  }
  const sourceType = fn.type(expression.sourceType)
  const targetType = fn.type(expression.target)
  const substituted = TypeCompatibility.check(
    fn.semantic(expression.sourceType),
    fn.semantic(expression.target),
  )
  // An open `A | B` conversion may disappear when both parameters specialize to the same
  // concrete type. The specialized program then carries no runtime union tag at this site.
  if (substituted._tag === 'Exact' || substituted._tag === 'Bottom') return source
  const sourceShape = Layout.callingShape(fn.layout, fn.semantic(expression.sourceType))
  const targetShape = Layout.callingShape(fn.layout, fn.semantic(expression.target))
  if (
    source === undefined ||
    sourceShape === undefined ||
    targetShape === undefined ||
    sourceType === undefined ||
    sourceType._tag === 'EffectOutcome' ||
    targetType?._tag !== 'Union'
  ) {
    return undefined
  }
  const destination = fn.alloc(targetType)
  // Canonical union member order can change under substitution (parameter keys sort
  // differently from concrete keys), so the mapping recomputes at the instantiation.
  const mappings =
    substituted._tag === 'Inject' || substituted._tag === 'Widen'
      ? substituted.mappings
      : expression.mappings
  fn.emit({
    _tag: 'ConvertUnion',
    destination,
    source: source.result,
    sourceType,
    sourceSemantic: fn.semantic(expression.sourceType),
    targetType,
    conversion: expression.conversion,
    mappings,
    sourceShape,
    targetShape,
    access: expression.access,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerShortCircuitExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'ShortCircuit' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const type = fn.type(expression.type)
  if (type?._tag !== 'bool') return undefined
  const left = lowerExpression(fn, expression.left, availableRequirements)
  if (left === 'Transferred') return left
  if (left === undefined) return undefined
  // The right operand's operations stay nested so that the engines can emit them under the
  // branch instead of before it. It is pure by elaboration, so nothing there needs releasing
  // on the path that skips it.
  const right = lowerExecution(fn, expression.right.span, () =>
    lowerExpression(fn, expression.right, availableRequirements),
  )
  if (right === undefined) return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'ShortCircuit',
    operator: expression.operator,
    destination,
    left: left.result,
    right,
    type,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

/** Retains checked nested discriminants before selected payload bindings. */
export const lowerPatternTests = (
  fn: FunctionLowering,
  root: Type.Type,
  member: Match.CoverageIdentity | undefined,
  authoredTests: ReadonlyArray<Match.PatternTest>,
  selectors: ReadonlyArray<Mir.PlaceSelector>,
  specializeMember: (member: Match.CoverageIdentity) => Match.CoverageIdentity,
): NonNullable<Mir.MatchArm['tests']> | undefined => {
  const tests: Array<NonNullable<Mir.MatchArm['tests']>[number]> = []
  for (const test of authoredTests) {
    if (member === undefined) return undefined
    const resolved = Layout.coveragePath(fn.layout, root, member, test.path)
    const shape = resolved === undefined ? undefined : Layout.callingShape(fn.layout, resolved.type)
    if (resolved === undefined || shape === undefined) return undefined
    const provenance = authored(test.span)
    tests.push({
      ...test,
      member: specializeMember(test.member),
      domain: test.domain.map(specializeMember),
      shape,
      selectors: [
        ...selectors,
        ...resolved.selectors.map((selector): Mir.PlaceSelector =>
          selector._tag === 'Variant'
            ? { _tag: 'VariantSelector', ordinal: selector.ordinal, provenance }
            : { _tag: 'FieldSelector', field: selector.field, provenance },
        ),
      ],
    })
  }
  return tests
}

function lowerMatchExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'Match' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  if (expression.scrutinee._tag === 'Unavailable') return undefined
  let scrutinee: LoweredExpression | undefined
  let selectors: ReadonlyArray<Mir.PlaceSelector> | undefined
  if (expression.access === 'Shared' || expression.access === 'Exclusive') {
    const place = lowerPlacePath(fn, expression.scrutinee, availableRequirements)
    if (place === undefined || place === 'Transferred') return place
    scrutinee = { result: place.root }
    selectors = place.selectors
  } else if (expression.access === 'Place') {
    const source = Ownership.placeOf(expression.scrutinee)
    if (source === undefined) return undefined
    const alias = Ownership.allBindings(fn.ownership).find(
      (binding) => Ownership.siteKey(binding.site) === Ownership.siteKey(source.root),
    )?.place
    const root = ownershipLocal(fn, alias?.root ?? source.root)
    if (root === undefined) return undefined
    selectors = lowerOwnershipPath(
      fn,
      root,
      [...(alias?.path ?? []), ...source.path],
      expression.scrutinee.span,
    )
    if (selectors === undefined) return undefined
    scrutinee = { result: root }
  } else {
    const transition =
      expression.access === 'Move'
        ? transitionAt(fn, expression.span, 'Move', Ownership.placeOf(expression.scrutinee)?.root)
        : undefined
    if (transition === undefined)
      scrutinee = lowerExpression(fn, expression.scrutinee, availableRequirements)
    else {
      scrutinee = lowerTransferredPlace(
        fn,
        transition,
        expression.scrutinee.type,
        expression.scrutinee.span,
      )
      if (scrutinee !== undefined) emitInitializationTransition(fn, transition)
    }
  }
  if (scrutinee === 'Transferred') return scrutinee
  const scrutineeType = fn.type(expression.scrutinee.type)
  const resultType = fn.type(expression.type)
  const scrutineeShape = Layout.callingShape(fn.layout, fn.semantic(expression.scrutinee.type))
  const resultShape =
    resultType?._tag === 'EffectComposite'
      ? effectCompositeShape(fn.layout, resultType)
      : Layout.callingShape(fn.layout, fn.semantic(expression.type))
  if (
    scrutinee === undefined ||
    scrutineeType === undefined ||
    resultType === undefined ||
    scrutineeShape === undefined ||
    resultShape === undefined
  ) {
    return undefined
  }
  const ownership = fn.ownership?.matches.find((candidate) =>
    Tir.nodeRefEquals(candidate.id.node, expression.match.node),
  )
  const specializeMember = (member: Match.CoverageIdentity): Match.CoverageIdentity => {
    if (member._tag === 'StructuralTypeMember')
      return Match.structuralMember(fn.semantic(member.type))
    if (member._tag !== 'NominalUnionVariant') return member
    const type = fn.semantic(member.type)
    return Type.isNominal(type)
      ? Match.nominalUnionVariant(
          fn.semantic(member.root),
          type,
          member.variant,
          member.variantOrdinal,
        )
      : member
  }
  const specializedMembers = expression.members.map(specializeMember)
  const members =
    scrutineeType._tag === 'Enum'
      ? specializedMembers.filter(
          (member, ordinal) =>
            specializedMembers.findIndex((candidate) =>
              Match.identityEquals(candidate, member, 'Runtime'),
            ) === ordinal,
        )
      : Layout.coverageMembers(scrutineeShape)
  const specializedCoverage = Match.cover(
    members,
    expression.arms.map((arm) => ({
      ...(arm.member === undefined ? {} : { member: specializeMember(arm.member) }),
      universal: arm.universal,
      guarded: arm.guard !== undefined,
      tests: (arm.tests ?? []).map((test) => ({
        ...test,
        member: specializeMember(test.member),
        domain: test.domain.map(specializeMember),
      })),
    })),
    'Runtime',
  )
  const arms: Array<Mir.MatchArm> = []
  const armStates = new Map<number, DelayedEffectState>()
  const branchState = delayedEffectState(fn)
  let pendingMembers = [...members]
  for (const [armOrdinal, arm] of expression.arms.entries()) {
    const transition = specializedCoverage.transitions.at(armOrdinal)
    if (!arm.reachable || transition?.reachable !== true) continue
    restoreDelayedEffectState(fn, branchState)
    const member = arm.member === undefined ? undefined : specializeMember(arm.member)
    const selectedMembers = pendingMembers.filter(
      (candidate) =>
        arm.universal || (member !== undefined && Match.selects(member, candidate, 'Runtime')),
    )
    const executes = selectedMembers.length > 0
    const tests = lowerPatternTests(
      fn,
      fn.semantic(expression.scrutinee.type),
      member,
      arm.tests ?? [],
      selectors ?? [],
      specializeMember,
    )
    if (tests === undefined) return undefined
    const before = transition.before
    const after = transition.after
    const bindings: Array<Mir.MatchBinding> = []
    for (const binding of executes && expression.access !== 'Place' ? arm.bindings : []) {
      const type =
        binding.access === 'Shared' || binding.access === 'Exclusive'
          ? {
              _tag: 'EnvironmentBorrow' as const,
              type: fn.semantic(binding.type),
              access: binding.access,
            }
          : fn.type(binding.type)
      if (type === undefined) return undefined
      const destination = fn.alloc(type)
      fn.patternLocals.set(patternKey(binding.id), destination)
      bindings.push({
        id: binding.id,
        destination,
        path: binding.path,
        type,
        access: binding.access,
        provenance: authored(binding.span),
      })
    }
    const ownedArm = executes
      ? ownership?.arms.find((candidate) => candidate.id.ordinal === arm.id.ordinal)
      : undefined
    const cleanupBindings: Array<Mir.MatchArm['cleanupBindings'][number]> = []
    const cleanup: Array<Mir.MatchArm['selected']['cleanup'][number]> = []
    const transferCleanup = (executes ? (fn.ownership?.exits ?? []) : []).flatMap((exit) =>
      exit.matches
        .filter(
          (selected) =>
            Tir.nodeRefEquals(selected.id.node, expression.match.node) &&
            selected.arm.ordinal === arm.id.ordinal,
        )
        .flatMap((selected) => selected.cleanup),
    )
    for (const release of [...(ownedArm?.cleanup ?? []), ...transferCleanup]) {
      const key = matchCleanupKey(arm.id, release.path)
      if (fn.matchCleanupLocals.has(key)) continue
      const plan = specializedCleanup(fn, release.cleanup)
      if (plan._tag === 'NoCleanup') continue
      const type = fn.type(plan.type)
      if (type === undefined) return undefined
      const destination = fn.alloc(type)
      fn.matchCleanupLocals.set(key, destination)
      cleanupBindings.push({ destination, path: release.path, type })
    }
    for (const release of ownedArm?.cleanup ?? []) {
      const plan = specializedCleanup(fn, release.cleanup)
      if (plan._tag === 'NoCleanup') continue
      const destination = fn.matchCleanupLocals.get(matchCleanupKey(arm.id, release.path))
      if (destination === undefined) return undefined
      cleanup.push({ destination, path: release.path, cleanup: plan })
    }
    const [, initialization] = fn.capture(() => {
      for (const binding of bindings)
        initializeBinding(fn, { _tag: 'Pattern', binding: binding.id }, arm.span)
    })
    const guardExpression = arm.guard
    const guardExecution =
      guardExpression === undefined
        ? undefined
        : lowerExecution(fn, guardExpression.span, () =>
            executes ? lowerExpression(fn, guardExpression, availableRequirements) : 'Transferred',
          )
    if (guardExpression !== undefined && guardExecution === undefined) return undefined
    // Coverage records source syntax. Runtime selection also stops on a transferring guard,
    // since it produces no Boolean that could reject this candidate and reach the next arm.
    pendingMembers = pendingMembers.filter((candidate) =>
      after.some((remaining) => Match.identityEquals(candidate, remaining, 'Runtime')),
    )
    if (
      guardExecution !== undefined &&
      guardExecution.result === undefined &&
      (arm.tests?.length ?? 0) === 0
    )
      pendingMembers = pendingMembers.filter((candidate) => !selectedMembers.includes(candidate))
    const guard = guardExecution === undefined ? undefined : { execution: guardExecution }
    const armExit = fn.exits.armEnds.get(`${spanKey(arm.span)}:Taken`)
    const body = arm.body
    let execution: Mir.Execution | undefined
    if (!executes || (guardExecution !== undefined && guardExecution.result === undefined))
      execution = lowerExecution(fn, body.span, () => 'Transferred')
    else if (body._tag === 'Expression')
      execution = lowerExecution(fn, body.span, () => {
        for (const operation of initialization) fn.emit(operation)
        const lowered = lowerExpression(fn, body.expression, availableRequirements)
        if (lowered === 'Transferred') return lowered
        if (lowered === undefined) return lowered
        const result =
          resultType._tag === 'EffectComposite'
            ? packEffectComposite(fn, lowered, resultType, body.span)
            : lowered
        if (result === undefined) return result
        emitReleases(fn, armExit)
        return result
      })
    else
      execution = fn.captureExecution(() => {
        const finish = body.completion.fallsThrough ? fn.reserve() : undefined
        const bodyEntry = lowerSequence(
          fn,
          body.statements,
          fn.exits,
          fn.ownerLoop,
          finish === undefined
            ? {
                _tag: 'Trap',
                reason: 'unreachable arm continuation',
                provenance: generated(body.span),
              }
            : {
                _tag: 'Forward',
                target: finish,
                provenance: generated(body.span),
              },
          undefined,
          armExit,
        )
        if (bodyEntry === undefined) return undefined
        const entry = initialization.length === 0 ? bodyEntry : fn.reserve()
        if (initialization.length > 0)
          fn.publish({
            _tag: 'OperationRegion',
            id: entry,
            ...ownerFields(fn.ownerLoop),
            operations: initialization,
            outcome: { _tag: 'Forward', target: bodyEntry, provenance: generated(arm.span) },
          })
        if (finish === undefined) return { entry }
        const [unit, operations] = fn.capture(() =>
          lowerUnitLiteralExpression(fn, {
            _tag: 'UnitLiteral',
            type: Type.unit,
            span: body.span,
            origin: body.origin,
          }),
        )
        if (unit === undefined || unit === 'Transferred') return undefined
        fn.publish({
          _tag: 'OperationRegion',
          id: finish,
          ...ownerFields(fn.ownerLoop),
          operations,
          outcome: { _tag: 'Complete', provenance: generated(body.span) },
        })
        return { entry, result: unit.result }
      })
    if (execution === undefined) return undefined
    if (execution.result !== undefined) armStates.set(arm.id.ordinal, delayedEffectState(fn))
    arms.push({
      id: arm.id,
      tests,
      ...(member === undefined ? {} : { member }),
      universal: arm.universal,
      before: before,
      after: after,
      bindings: bindings,
      cleanupBindings: cleanupBindings,
      ...(guard === undefined ? {} : { guard }),
      selected: {
        access: expression.access,
        execution,
        cleanup: cleanup,
        endBorrow: expression.access === 'Shared' || expression.access === 'Exclusive',
      },
      provenance: authored(arm.span),
    })
    for (const binding of arm.bindings) fn.patternLocals.delete(patternKey(binding.id))
    for (const release of [...(ownedArm?.cleanup ?? []), ...transferCleanup])
      fn.matchCleanupLocals.delete(matchCleanupKey(arm.id, release.path))
  }
  restoreDelayedEffectState(fn, branchState)
  const destination = arms.some(
    (arm) =>
      arm.selected.execution.result !== undefined &&
      (arm.guard === undefined || arm.guard.execution.result !== undefined),
  )
    ? fn.alloc(resultType)
    : undefined
  // Contextual typing can retain an expected result even when every selected arm transfers.
  // MIR records the actual join: a transferring match has no result storage or calling lanes.
  const joinType: Mir.Type =
    destination === undefined ? { _tag: 'Bottom', type: 'never' } : resultType
  const joinShape =
    destination === undefined ? Layout.callingShape(fn.layout, 'never') : resultShape
  if (joinShape === undefined) return undefined
  const decisions = members.map((member) => ({
    member,
    candidates: arms
      .filter(
        (arm) =>
          arm.universal ||
          (arm.member !== undefined && Match.selects(arm.member, member, 'Runtime')),
      )
      .map((arm) => arm.id),
  }))
  for (const key of branchState.loanLocals.keys()) {
    const endedOnEveryPath = decisions.every((decision) => {
      const candidates = decision.candidates.flatMap((candidate) => {
        const arm = arms.find((entry) => entry.id.ordinal === candidate.ordinal)
        const armState = armStates.get(candidate.ordinal)
        return arm === undefined ? [] : [{ arm, armState }]
      })
      return (
        candidates.length === decision.candidates.length &&
        candidates.some(({ arm }) => arm.guard === undefined) &&
        // Transferring arms never reach the join; their exit already releases its loans.
        candidates.every(({ armState }) => armState === undefined || !armState.loanLocals.has(key))
      )
    })
    if (endedOnEveryPath) fn.loanLocals.delete(key)
  }
  const mirDecisions = decisions.map((decision) => ({
    member: decision.member,
    candidates: decision.candidates,
  }))
  fn.emit({
    _tag: 'Match',
    id: expression.match,
    ...(destination === undefined ? {} : { destination }),
    scrutinee: scrutinee.result,
    ...(selectors === undefined ? {} : { selectors }),
    scrutineeType,
    scrutineeShape,
    access: expression.access,
    retainsBindings: false,
    members: members,
    decisions: mirDecisions,
    arms: arms,
    type: joinType,
    resultShape: joinShape,
    provenance: authored(expression.span),
  })
  return destination === undefined ? 'Transferred' : { result: destination }
}

function lowerConstructExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'Construct' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const type = fn.type(expression.type)
  if (type?._tag !== 'Nominal') return undefined
  const representation = Layout.entry(fn.layout, type.type)?.representation
  const canonicalFields = new Map(
    expression.fields.map((field) => [field.field.ordinal, field] as const),
  )
  const loweredFields = new Map<number, Mir.LocalId>()
  for (const fieldId of expression.evaluationOrder) {
    const field = canonicalFields.get(fieldId.ordinal)
    if (field === undefined) return undefined
    const lowered = lowerExpression(fn, field.value, availableRequirements)
    if (lowered === 'Transferred') return lowered
    if (lowered === undefined) return undefined
    loweredFields.set(field.field.ordinal, lowered.result)
  }
  const fields = expression.fields.flatMap((field) => {
    const value = loweredFields.get(field.field.ordinal)
    const declared =
      representation?._tag === 'Aggregate'
        ? representation.fields.find((candidate) =>
            DeclarationFacts.sameFieldId(candidate.id, field.field),
          )
        : undefined
    const stored =
      declared === undefined
        ? undefined
        : (storedCallableValueType(fn.layout, declared.type)?.storage ??
          storedEffectValueType(fn.layout, declared.type)?.storage)
    return value === undefined
      ? []
      : [
          {
            field: field.field,
            value,
            ...(stored === undefined ? {} : { stored }),
          },
        ]
  })
  if (fields.length !== expression.fields.length) return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'Construct',
    destination,
    type,
    fields: fields,
    provenance: { span: expression.span, generated: false },
  })
  return { result: destination }
}

function lowerConstructUnionVariantExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'ConstructUnionVariant' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const type = fn.type(expression.type)
  if (type?._tag !== 'Nominal') return undefined
  const representation = Layout.entry(fn.layout, type.type)?.representation
  if (representation?._tag !== 'NominalUnion') return undefined
  const variant = representation.variants.find(
    (candidate) =>
      candidate.ordinal === expression.variantOrdinal &&
      candidate.variant.union.module === expression.variant.union.module &&
      candidate.variant.union.name === expression.variant.union.name &&
      candidate.variant.name === expression.variant.name,
  )
  if (variant === undefined) return undefined
  const canonicalFields = new Map(
    expression.fields.map((field) => [DeclarationFacts.fieldIdKey(field.field), field] as const),
  )
  const loweredFields = new Map<string, Mir.LocalId>()
  for (const fieldId of expression.evaluationOrder) {
    const field = canonicalFields.get(DeclarationFacts.fieldIdKey(fieldId))
    if (field === undefined) return undefined
    const lowered = lowerExpression(fn, field.value, availableRequirements)
    if (lowered === 'Transferred') return lowered
    if (lowered === undefined) return undefined
    loweredFields.set(DeclarationFacts.fieldIdKey(field.field), lowered.result)
  }
  const fields = expression.fields.flatMap((field) => {
    const value = loweredFields.get(DeclarationFacts.fieldIdKey(field.field))
    const declared = variant.fields.find((candidate) =>
      DeclarationFacts.sameFieldId(candidate.id, field.field),
    )
    const stored =
      declared === undefined
        ? undefined
        : (storedCallableValueType(fn.layout, declared.type)?.storage ??
          storedEffectValueType(fn.layout, declared.type)?.storage)
    return value === undefined
      ? []
      : [
          {
            field: field.field,
            value,
            ...(stored === undefined ? {} : { stored }),
          },
        ]
  })
  if (fields.length !== expression.fields.length) return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'ConstructUnionVariant',
    destination,
    type,
    variant: expression.variant,
    variantOrdinal: expression.variantOrdinal,
    fields: fields,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerArrayConstructExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'ArrayConstruct' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const type = fn.type(expression.type)
  if (type?._tag !== 'FixedArray') return undefined
  const elements: Array<Mir.LocalId> = []
  for (const element of expression.elements) {
    const lowered = lowerExpression(fn, element, availableRequirements)
    if (lowered === 'Transferred') return lowered
    if (lowered === undefined) return undefined
    elements.push(lowered.result)
  }
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'ConstructArray',
    destination,
    type,
    elements: elements,
    provenance: { span: expression.span, generated: false },
  })
  return { result: destination }
}

function lowerSliceBorrowExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'SliceBorrow' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const temporary =
    expression.root._tag === 'TemporarySliceRoot'
      ? lowerExpression(fn, expression.root.value, availableRequirements)
      : undefined
  if (temporary === 'Transferred') return temporary
  const alias =
    expression.root._tag === 'PatternSliceRoot'
      ? patternPlace(fn, expression.root.binding, expression.span)
      : undefined
  let root: Mir.LocalId | undefined
  switch (expression.root._tag) {
    case 'BindingSliceRoot':
      root = fn.bindingLocals.get(expression.root.binding.ordinal)
      break
    case 'ParameterSliceRoot':
      root = fn.parameterLocals.get(expression.root.parameter.ordinal)
      break
    case 'PatternSliceRoot':
      root = alias?.root ?? fn.patternLocals.get(patternKey(expression.root.binding))
      break
    case 'TemporarySliceRoot':
      root = temporary?.result
      break
  }
  const sourceType = fn.type(expression.source)
  const type = fn.type(expression.type)
  if (
    root === undefined ||
    (sourceType?._tag !== 'FixedArray' && sourceType?._tag !== 'Slice') ||
    type?._tag !== 'Slice'
  ) {
    return undefined
  }
  const destination = fn.alloc(type)
  const borrow = fn.beginRecipeBorrow(expression.borrow)
  const place = lowerBorrowPlace(fn, root, expression.selectors, alias?.selectors)
  if (place === undefined || place === 'Transferred') return place
  fn.emit({
    _tag: 'BeginLoan',
    borrow,
    destination,
    root: place.root,
    selectors: place.selectors,
    sourceType,
    type,
    access: expression.access,
    reborrow: expression.reborrow,
    suspendsParent: expression.suspendsParent,
    provenance: authored(expression.span),
  })
  if (expression.root._tag === 'TemporarySliceRoot') {
    const owner = BodyView.node(fn.owner.view, expression.root.owner.node)
    if (owner === undefined) return undefined
    fn.temporaryBorrowOwners.set(borrowKey(borrow), {
      local: root,
      cleanup: CleanupPlan.cleanupPlan(fn.index, fn.semantic(expression.source)),
      span: owner.span,
    })
  }
  fn.loanLocals.set(borrowKey(borrow), destination)
  return { result: destination }
}

function lowerValueBorrowExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'ValueBorrow' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const temporary =
    expression.root._tag === 'TemporarySliceRoot'
      ? lowerExpression(fn, expression.root.value, availableRequirements)
      : undefined
  if (temporary === 'Transferred') return temporary
  const alias =
    expression.root._tag === 'PatternSliceRoot'
      ? patternPlace(fn, expression.root.binding, expression.span)
      : undefined
  let root: Mir.LocalId | undefined
  switch (expression.root._tag) {
    case 'BindingSliceRoot':
      root = fn.bindingLocals.get(expression.root.binding.ordinal)
      break
    case 'ParameterSliceRoot':
      root = fn.parameterLocals.get(expression.root.parameter.ordinal)
      break
    case 'PatternSliceRoot':
      root = alias?.root ?? fn.patternLocals.get(patternKey(expression.root.binding))
      break
    case 'TemporarySliceRoot':
      root = temporary?.result
      break
  }
  const sourceType = fn.type(expression.source)
  const type = fn.type(expression.type)
  if (root === undefined || sourceType === undefined || type?._tag !== 'Reference') {
    return undefined
  }
  const destination = fn.alloc(type)
  const borrow = fn.beginRecipeBorrow(expression.borrow)
  const place = lowerBorrowPlace(fn, root, expression.selectors, alias?.selectors)
  if (place === undefined || place === 'Transferred') return place
  fn.emit({
    _tag: 'BeginLoan',
    borrow,
    destination,
    root: place.root,
    selectors: place.selectors,
    sourceType,
    type,
    access: expression.access,
    reborrow: expression.reborrow,
    suspendsParent: expression.suspendsParent,
    provenance: authored(expression.span),
  })
  if (expression.root._tag === 'TemporarySliceRoot') {
    const owner = BodyView.node(fn.owner.view, expression.root.owner.node)
    if (owner === undefined) return undefined
    fn.temporaryBorrowOwners.set(borrowKey(borrow), {
      local: root,
      cleanup: CleanupPlan.cleanupPlan(fn.index, fn.semantic(expression.source)),
      span: owner.span,
    })
  }
  fn.loanLocals.set(borrowKey(borrow), destination)
  return { result: destination }
}

function lowerSliceLengthExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'SliceLength' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const slice = lowerExpression(fn, expression.slice, availableRequirements)
  if (slice === 'Transferred') return slice
  const sliceType = slice === undefined ? undefined : fn.localTypes.at(slice.result.ordinal)
  if (
    slice === undefined ||
    sliceType === undefined ||
    !Type.isSlice(Mir.semanticType(sliceType))
  ) {
    return undefined
  }
  const destination = fn.alloc(usize)
  fn.emit({
    _tag: 'SliceLength',
    destination,
    slice: slice.result,
    type: usize,
    provenance: authored(expression.span),
  })
  return { result: destination }
}

function lowerCallExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'Call' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  const argumentLocals: Array<Mir.LocalId> = []
  for (const argument of expression.arguments) {
    const lowered = lowerExpression(fn, argument, availableRequirements)
    if (lowered === 'Transferred') return lowered
    if (lowered === undefined) return undefined
    argumentLocals.push(lowered.result)
  }
  // A foreign header has no instance: the call names a native symbol under its C signature.
  const foreign = ExecutableOrigin.foreignFact(fn.index, expression.target)
  let destination: Mir.LocalId
  if (foreign?.foreign !== undefined) {
    const variadicArguments: Array<CAbi.VariadicArgument> = []
    for (const argument of argumentLocals.slice(foreign.parameters.length)) {
      const actual = fn.localTypes.at(argument.ordinal)
      const promoted =
        actual === undefined
          ? undefined
          : CAbi.promoteVariadic(Mir.semanticType(actual), fn.layout.target)
      if (promoted === undefined) return undefined
      variadicArguments.push(promoted)
    }
    const type = fn.type(expression.type)
    if (type === undefined) return undefined
    destination = fn.alloc(type)
    fn.emit({
      _tag: 'ForeignCall',
      variadicArguments: variadicArguments,
      destination,
      symbol: foreign.foreign.symbol,
      abi: 'C',
      signature: ExecutableOrigin.foreignSignature(foreign, fn.layout.target),
      arguments: argumentLocals,
      type,
      provenance: { span: expression.span, generated: false },
    })
  } else {
    const authoredTypeArguments = expression.typeArguments.map((argument) =>
      fn.semanticArgument(argument),
    )
    const call = fn.call(
      expression,
      undefined,
      authoredTypeArguments,
      expression.staticArguments,
      availableRequirements,
    )
    const typeArguments = call?.target.typeArguments ?? authoredTypeArguments
    const staticArguments = call?.target.staticArguments ?? expression.staticArguments
    const semanticType = fn.semantic(expression.type)
    const type =
      (call === undefined || !Type.isEffect(semanticType)
        ? undefined
        : effectValueForCall(fn.layout, call, semanticType, availableRequirements)) ??
      fn.effectResults.get(
        call === undefined
          ? instanceText(expression.target, typeArguments, staticArguments)
          : Instances.keyText(call.target),
      ) ??
      fn.type(expression.type) ??
      resultCallableValueType(
        fn.layout,
        fn.instances,
        expression.target,
        typeArguments,
        semanticType,
      )
    if (type === undefined) return undefined
    destination = fn.alloc(type)
    fn.emit({
      _tag: 'Call',
      destination,
      target: expression.target,
      typeArguments,
      ...(staticArguments.length === 0 ? {} : { staticArguments }),
      arguments: argumentLocals,
      type,
      provenance: { span: expression.span, generated: false },
    })
  }
  for (const authored of expression.loanEnds) {
    const borrow = fn.recipeBorrow(authored)
    const slice = fn.loanLocals.get(borrowKey(borrow))
    if (slice === undefined) return undefined
    fn.emit({
      _tag: 'EndLoan',
      borrow,
      slice,
      provenance: generated(expression.span),
    })
    fn.loanLocals.delete(borrowKey(borrow))
  }
  return { result: destination }
}

function lowerInterfaceOperationCallExpression(
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'InterfaceOperationCall' }>,
  availableRequirements: FunctionLowering['providedRequirements'],
): LoweredExpression | undefined {
  if (expression.witnessEffectSite !== undefined) return lowerWitnessEffect(fn, expression)
  // The static interface application names the operation and provider; specialization makes
  // that conformance evidence concrete. Only here can the conformance say which compiler-known
  // operation the call runs — two providers of one interface may answer one operation with two
  // unrelated instructions, and an operator's width-neutral lowering cannot stand in for that.
  const capability = fn.semantic(expression.capability)
  const provider = fn.semantic(expression.provider)
  if (!Type.isNominal(capability)) return undefined
  const selected = ConformanceProof.interfaceOperationIntrinsic(
    fn.index,
    provider,
    capability,
    expression.operation,
  )
  // A witness names either a sealed intrinsic or a function of the provider's own actor, and
  // which one it names is the conformance's business rather than the call's. The operator path
  // has always read both; this call reads the second one here.
  if (selected?.rule._tag !== 'BuiltinRule') {
    const argumentLocals: Array<Mir.LocalId> = []
    for (const argument of expression.arguments) {
      const lowered = lowerExpression(fn, argument, availableRequirements)
      if (lowered === 'Transferred') return lowered
      if (lowered === undefined) return undefined
      argumentLocals.push(lowered.result)
    }
    const result = lowerStaticInterfaceWitnessCall(
      fn,
      expression,
      provider,
      capability,
      argumentLocals,
    )
    if (result === undefined) return undefined
    for (const authored of expression.loanEnds) {
      const borrow = fn.recipeBorrow(authored)
      const loan = fn.loanLocals.get(borrowKey(borrow))
      if (loan === undefined) continue
      fn.emit({
        _tag: 'EndLoan' as const,
        borrow,
        slice: loan,
        provenance: generated(expression.span),
      })
      fn.loanLocals.delete(borrowKey(borrow))
    }
    return { result }
  }
  // The call the witness names, at this call's own span: the enclosing `lowerExpression` ends
  // this span's returned-view loans once, after the operation it selected has been lowered.
  return lowerExpressionInner(fn, {
    _tag: 'BuiltinCall',
    operation: selected.rule.operation,
    intrinsic: selected.id,
    typeArguments: [],
    arguments: expression.arguments,
    loanEnds: expression.loanEnds,
    heldLoans: [],
    type: expression.type,
    span: expression.span,
    origin: expression.origin,
  })
}
