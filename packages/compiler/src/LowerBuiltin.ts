import * as ConcreteCleanup from './ConcreteCleanup.js'
import { lowerCallOperand } from './LowerExpression.js'
import { authored, cleanupForLocal, generated } from './CleanupEmission.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type { LoweredExpression } from './EffectLowering.js'
import type {} from './EntryAssembly.js'
import * as ExecutionPackage from './ExecutionPackage.js'
import type {} from './Forwarding.js'
import type { FunctionLowering } from './FunctionLowering.js'
import * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import * as Intrinsic from './Intrinsic.js'
import * as Layout from './Layout.js'
import * as LocalSharedAllocationProvenance from './LocalSharedAllocationProvenance.js'
import * as LocalSharedControlBlock from './LocalSharedControlBlock.js'
import { borrowKey, usize } from './Lower.js'
import * as Mir from './Mir.js'
import * as Scalar from './Scalar.js'
import * as Type from './Type.js'
import { baseRunnerKey, effectValueAtSite, generatedRunner } from './ValueType.js'
import {
  lowerBuiltinArguments,
  lowerInterfaceWitnessCall,
  lowerWitnessEffect,
} from './WitnessLowering.js'

const representedExecutionArgument = (
  fn: FunctionLowering,
  argument: Type.GenericArgument,
): Type.Represented | undefined =>
  Type.representedType(
    Instances.concreteEffectRepresentationArgument(fn.owner.function, fn.owner.key, argument),
  )

export const lowerBuiltinExpression = (
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' }>,
): LoweredExpression | undefined => {
  if (expression.operation === 'NativeAssembly') {
    const assembly = expression.assembly
    const tuple = expression.arguments[6]
    const type = fn.type(expression.type)
    if (assembly === undefined || tuple === undefined || type === undefined) return undefined
    const operands = tuple._tag === 'Construct' ? tuple.fields.map((field) => field.value) : []
    if (tuple._tag !== 'Construct' && tuple._tag !== 'UnitLiteral') return undefined
    const arguments_: Array<Mir.LocalId> = []
    for (const operand of operands) {
      const lowered = lowerCallOperand(fn, operand)
      if (lowered === undefined || lowered === 'Transferred') return lowered
      arguments_.push(lowered.result)
    }
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'NativeAssembly',
      assembly,
      destination,
      arguments: arguments_,
      type,
      provenance: authored(expression.span),
    })
    return assembly.noReturn ? 'Transferred' : { result: destination }
  }
  if (expression.witnessEffectSite !== undefined) return lowerWitnessEffect(fn, expression)
  const intrinsic = Intrinsic.findOperationById(expression.intrinsic)
  if (intrinsic === undefined || !Intrinsic.isBuiltinOperation(intrinsic)) return undefined
  const semanticType = fn.semantic(expression.type)
  if (Type.isEffect(semanticType)) {
    const site = Tir.builtinEffectSite(
      Tir.nodeReference(fn.owner.view.artifact, expression),
      fn.owner.key.declaration,
      fn.owner.function.declaration.id.ordinal,
    )
    const type = effectValueAtSite(fn.layout, fn.owner.key, site, semanticType)
    if (type === undefined) return undefined
    const captures = lowerBuiltinArguments(fn, expression, intrinsic)
    if (captures === 'Transferred') return captures
    if (captures === undefined || captures.length !== type.environment.fields.length)
      return undefined
    const destination = fn.alloc(type)
    const runner = Tir.effectRunnerId(fn.owner.key.declaration, site)
    fn.emit({
      _tag: 'MakeEffect',
      destination,
      runner,
      runnerTypeArguments: fn.owner.key.typeArguments,
      captures: captures.map((source, ordinal) => ({
        source,
        access: type.environment.fields.at(ordinal)?.access ?? ('Take' as const),
      })),
      type,
      provenance: generated(expression.span),
    })
    const key = baseRunnerKey(fn.owner.key, site, type.type)
    if (generatedRunner(fn.generatedRunners, key) === undefined)
      fn.generatedRunners.push({
        _tag: 'BuiltinEffectRunner',
        id: runner,
        owner: fn.owner,
        expression,
        type,
        specializationKey: key,
        providedRequirements: [],
      })
    return { result: destination }
  }
  const argumentLocals = lowerBuiltinArguments(fn, expression, intrinsic)
  if (argumentLocals === 'Transferred') return argumentLocals
  if (argumentLocals === undefined) return undefined
  return lowerBuiltinOperation(fn, expression, argumentLocals)
}

/**
 * Lowers one builtin operation over already-lowered operands. Kept apart from the operand walk so
 * the recursion through nested operands only stacks the small dispatch frames, not this one.
 */
const lowerBuiltinOperation = (
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' }>,
  argumentLocals: ReadonlyArray<Mir.LocalId>,
): LoweredExpression | undefined => {
  const finishBuiltin = (result: Mir.LocalId): { readonly result: Mir.LocalId } => {
    const slot = argumentLocals.at(0)
    let inherited: ReadonlyArray<Tir.BorrowId> = []
    if (
      slot !== undefined &&
      (expression.operation === 'SlotWrite' ||
        expression.operation === 'SlotTake' ||
        expression.operation === 'SlotCopy' ||
        expression.operation === 'SlotDrop')
    ) {
      inherited = fn.slotLoans.get(slot.ordinal) ?? []
    }
    const endings = new Map(
      [...expression.loanEnds, ...inherited].map((authored) => {
        const borrow = fn.recipeBorrow(authored)
        return [borrowKey(borrow), borrow] as const
      }),
    )
    for (const borrow of endings.values()) {
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
    if (slot !== undefined && inherited.length > 0) fn.slotLoans.delete(slot.ordinal)
    return { result }
  }
  const witnessCall = lowerInterfaceWitnessCall(fn, expression, argumentLocals)
  if (witnessCall !== undefined) return finishBuiltin(witnessCall)
  if (
    expression.operation === 'LayoutOf' ||
    expression.operation === 'SharedLayout' ||
    expression.operation === 'ExecutionLayout'
  ) {
    const raw = expression.typeArguments.at(0)
    const semanticRaw = raw === undefined ? undefined : fn.semanticArgument(raw)
    const element =
      semanticRaw !== undefined && Type.isTypeArgument(semanticRaw) ? semanticRaw : undefined
    const elementLayout = element === undefined ? undefined : Layout.entry(fn.layout, element)
    const sharedBlock =
      expression.operation === 'SharedLayout' &&
      element !== undefined &&
      elementLayout !== undefined
        ? LocalSharedControlBlock.plan(fn.layout.target, element, elementLayout)
        : undefined
    const executionArguments = expression.typeArguments.map((argument) =>
      fn.semanticArgument(argument),
    )
    const executionBody = executionArguments.at(1)
    const executionEndpoint = executionArguments.at(2)
    const executionCallback = executionArguments.at(3)
    const executionSpecialization =
      expression.operation !== 'ExecutionLayout' ||
      element === undefined ||
      executionBody === undefined ||
      executionEndpoint === undefined ||
      executionCallback === undefined ||
      !Type.isTypeArgument(executionEndpoint)
        ? undefined
        : (() => {
            const body = representedExecutionArgument(fn, executionBody)
            const callback = Type.representedType(executionCallback)
            if (body === undefined || callback === undefined) return undefined
            return fn.layout.executionPackages.plans.find(
              (candidate) =>
                ExecutionPackage.specializationKey(candidate.specialization) ===
                ExecutionPackage.specializationKey({
                  result: element,
                  body,
                  endpoint: executionEndpoint,
                  callback,
                  suspension: candidate.specialization.suspension,
                }),
            )
          })()
    const layoutEntry = Layout.entry(fn.layout, Type.layout)
    const type = fn.type(Type.layout)
    if (
      elementLayout === undefined ||
      (expression.operation === 'ExecutionLayout' && executionSpecialization === undefined) ||
      (sharedBlock !== undefined && sharedBlock._tag !== 'LocalSharedControlBlockPlan') ||
      layoutEntry?.representation._tag !== 'Aggregate' ||
      type?._tag !== 'Nominal'
    )
      return undefined
    const fields: Array<{
      readonly field: DeclarationFacts.FieldId
      readonly value: Mir.LocalId
    }> = []
    for (const field of layoutEntry.representation.fields) {
      const value = fn.alloc(usize)
      fn.emit({
        _tag: 'Literal' as const,
        destination: value,
        type: usize,
        value: BigInt(
          field.name === 'bytes'
            ? (executionSpecialization?.size ?? sharedBlock?.size ?? elementLayout.size)
            : (executionSpecialization?.alignment ??
                sharedBlock?.alignment ??
                elementLayout.alignment),
        ),
        provenance: generated(expression.span),
      })
      fields.push({ field: field.id, value })
    }
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'Construct' as const,
      destination,
      type,
      fields: fields,
      provenance: generated(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (
    expression.operation === 'EffectSuspend' ||
    expression.operation === 'EffectFinalize' ||
    expression.operation === 'EffectFinalizeNonParking' ||
    expression.operation === 'EffectUseReleaseNonParking' ||
    expression.operation === 'EffectObserveDiagnostics' ||
    expression.operation === 'StorageAcquire'
  )
    return undefined
  if (expression.operation === 'EffectObserveUnhandled') {
    const destination = fn.alloc(usize)
    fn.emit({
      _tag: 'DiagnosticUnhandled',
      destination,
      type: usize,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'RawBufferFrom') {
    const [allocation, count] = argumentLocals
    const type = fn.type(expression.type)
    const raw = Type.isRawBuffer(expression.type)
      ? Type.typeArgumentAt(expression.type, 0)
      : undefined
    const element = raw === undefined ? undefined : fn.semantic(raw)
    const elementLayout = element === undefined ? undefined : Layout.entry(fn.layout, element)
    if (
      allocation === undefined ||
      count === undefined ||
      type?._tag !== 'Nominal' ||
      !Type.isRawBuffer(type.type) ||
      element === undefined ||
      elementLayout === undefined
    )
      return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'RawBufferFrom' as const,
      destination,
      allocation,
      count,
      element,
      stride: Math.ceil(elementLayout.size / elementLayout.alignment) * elementLayout.alignment,
      elementAlignment: elementLayout.alignment,
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'SharedFromAllocation') {
    const [allocation, value] = argumentLocals
    const type = fn.type(expression.type)
    const raw = Type.isSharedCore(expression.type)
      ? Type.typeArgumentAt(expression.type, 0)
      : undefined
    const element = raw === undefined ? undefined : fn.semantic(raw)
    const elementLayout = element === undefined ? undefined : Layout.entry(fn.layout, element)
    const block =
      element === undefined || elementLayout === undefined
        ? undefined
        : LocalSharedControlBlock.plan(fn.layout.target, element, elementLayout)
    const allocationProvenance = LocalSharedAllocationProvenance.find(
      fn.layout.localSharedAllocationProvenance,
      fn.owner.key,
      expression,
    )
    const allocationElementLayout =
      allocationProvenance === undefined
        ? undefined
        : Layout.entry(fn.layout, allocationProvenance.element)
    const allocationFact =
      allocationProvenance === undefined
        ? -1
        : fn.layout.localSharedAllocationProvenance.facts.indexOf(allocationProvenance)
    const allocationBlock =
      allocationProvenance === undefined || allocationElementLayout === undefined
        ? undefined
        : LocalSharedControlBlock.plan(
            fn.layout.target,
            allocationProvenance.element,
            allocationElementLayout,
          )
    if (
      allocation === undefined ||
      value === undefined ||
      type?._tag !== 'Nominal' ||
      !Type.isSharedCore(type.type) ||
      element === undefined ||
      allocationProvenance === undefined ||
      allocationFact < 0 ||
      block?._tag !== 'LocalSharedControlBlockPlan' ||
      allocationBlock?._tag !== 'LocalSharedControlBlockPlan'
    )
      return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'SharedFromAllocation' as const,
      destination,
      allocation,
      value,
      element,
      block,
      allocationBlock,
      allocationFact,
      allocationProvenance: allocationProvenance.span,
      allocationAccess: 'Take',
      valueAccess: 'Take',
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'ExecutionFromAllocation') {
    const [allocation, body, endpoint, callback] = argumentLocals
    const type = fn.type(expression.type)
    const arguments_ = expression.typeArguments.map((argument) => fn.semanticArgument(argument))
    const result = arguments_.at(0)
    const bodyArgument = arguments_.at(1)
    const endpointArgument = arguments_.at(2)
    const callbackArgument = arguments_.at(3)
    const bodyType =
      bodyArgument === undefined ? undefined : representedExecutionArgument(fn, bodyArgument)
    const callbackType =
      callbackArgument === undefined ? undefined : Type.representedType(callbackArgument)
    const plan =
      result === undefined ||
      !Type.isTypeArgument(result) ||
      bodyType === undefined ||
      endpointArgument === undefined ||
      !Type.isTypeArgument(endpointArgument) ||
      callbackType === undefined
        ? undefined
        : fn.layout.executionPackages.plans.find(
            (candidate) =>
              Type.equals(candidate.specialization.result, result) &&
              Type.equals(candidate.specialization.body, bodyType) &&
              Type.equals(candidate.specialization.endpoint, endpointArgument) &&
              Type.equals(candidate.specialization.callback, callbackType),
          )
    const allocationProvenance = LocalSharedAllocationProvenance.findExecution(
      fn.layout.localSharedAllocationProvenance,
      fn.owner.key,
      expression,
    )
    const allocationFact =
      allocationProvenance === undefined
        ? -1
        : fn.layout.localSharedAllocationProvenance.executionFacts.indexOf(allocationProvenance)
    const concreteArguments = arguments_.map((argument) =>
      Instances.concreteEffectRepresentationArgument(fn.owner.function, fn.owner.key, argument),
    )
    if (
      allocation === undefined ||
      body === undefined ||
      endpoint === undefined ||
      callback === undefined ||
      type?._tag !== 'Nominal' ||
      !Type.isExecution(type.type) ||
      plan === undefined ||
      allocationProvenance === undefined ||
      allocationFact < 0 ||
      allocationProvenance.arguments.length !== concreteArguments.length ||
      !allocationProvenance.arguments.every((argument, ordinal) => {
        const expected = concreteArguments.at(ordinal)
        return (
          expected !== undefined &&
          Type.genericArgumentKey(argument) === Type.genericArgumentKey(expected)
        )
      })
    )
      return undefined
    const bodyLocalType = fn.localTypes.at(body.ordinal)
    const endpointLocalType = fn.localTypes.at(endpoint.ordinal)
    const callbackLocalType = fn.localTypes.at(callback.ordinal)
    if (
      bodyLocalType === undefined ||
      endpointLocalType === undefined ||
      callbackLocalType === undefined
    )
      return undefined
    const destination = fn.alloc(type)
    const bodyCleanup = cleanupForLocal(
      fn,
      plan.cleanup?.body ?? ConcreteCleanup.forType(fn, plan.specialization.body),
      bodyLocalType,
    )
    const endpointCleanup = cleanupForLocal(
      fn,
      plan.cleanup?.endpoint ?? ConcreteCleanup.forType(fn, plan.specialization.endpoint),
      endpointLocalType,
    )
    const callbackCleanup = cleanupForLocal(
      fn,
      plan.cleanup?.callback ?? ConcreteCleanup.forType(fn, plan.specialization.callback),
      callbackLocalType,
    )
    fn.emit({
      _tag: 'ExecutionFromAllocation' as const,
      destination,
      allocation,
      body,
      endpoint,
      callback,
      plan,
      bodyCleanup,
      endpointCleanup,
      callbackCleanup,
      allocationFact,
      allocationProvenance: allocationProvenance.span,
      allocationAccess: 'Take' as const,
      bodyAccess: 'Take' as const,
      endpointAccess: 'Take' as const,
      callbackAccess: 'Take' as const,
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'SharedClone') {
    const [self] = argumentLocals
    const type = fn.type(expression.type)
    const raw = Type.isSharedCore(expression.type)
      ? Type.typeArgumentAt(expression.type, 0)
      : undefined
    const element = raw === undefined ? undefined : fn.semantic(raw)
    const elementLayout = element === undefined ? undefined : Layout.entry(fn.layout, element)
    const block =
      element === undefined || elementLayout === undefined
        ? undefined
        : LocalSharedControlBlock.plan(fn.layout.target, element, elementLayout)
    if (
      self === undefined ||
      type?._tag !== 'Nominal' ||
      !Type.isSharedCore(type.type) ||
      element === undefined ||
      block?._tag !== 'LocalSharedControlBlockPlan'
    )
      return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'SharedClone' as const,
      destination,
      self,
      element,
      block,
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'SharedWithMut') {
    const [self, use, onConflict] = argumentLocals
    const selfType = self === undefined ? undefined : fn.localTypes.at(self.ordinal)
    const useType = use === undefined ? undefined : fn.localTypes.at(use.ordinal)
    const conflictType = onConflict === undefined ? undefined : fn.localTypes.at(onConflict.ordinal)
    const type = fn.type(expression.type)
    const core =
      selfType?._tag === 'Reference' && Type.isSharedCore(selfType.type.target)
        ? selfType.type.target
        : undefined
    const raw = core === undefined ? undefined : Type.typeArgumentAt(core, 0)
    const element = raw === undefined ? undefined : fn.semantic(raw)
    const elementLayout = element === undefined ? undefined : Layout.entry(fn.layout, element)
    const block =
      element === undefined || elementLayout === undefined
        ? undefined
        : LocalSharedControlBlock.plan(fn.layout.target, element, elementLayout)
    if (
      self === undefined ||
      use === undefined ||
      onConflict === undefined ||
      useType?._tag !== 'CallableValue' ||
      conflictType?._tag !== 'CallableValue' ||
      type === undefined ||
      element === undefined ||
      block?._tag !== 'LocalSharedControlBlockPlan'
    )
      return undefined
    const payloadContract = useType.type.parameters.at(0)
    if (payloadContract === undefined || !Type.isReference(payloadContract)) return undefined
    const payloadType = fn.type(payloadContract)
    if (payloadType?._tag !== 'Reference') return undefined
    const payload = fn.alloc(payloadType)
    const destination = fn.alloc(type)
    const loan = fn.freshSyntheticBorrow(Tir.nodeReference(fn.owner.view.artifact, expression))
    const useContract = Type.callable(
      [payloadContract],
      Mir.semanticType(type),
      useType.type,
      'Take',
    )
    const conflictContract = Type.callable([], Mir.semanticType(type), conflictType.type, 'Take')
    fn.emit({
      _tag: 'SharedWithMut' as const,
      destination,
      payload,
      self,
      use,
      onConflict,
      element,
      block,
      useType: useContract,
      conflictType: conflictContract,
      useCleanup: cleanupForLocal(fn, ConcreteCleanup.forType(fn, useType.type), useType),
      conflictCleanup: cleanupForLocal(
        fn,
        ConcreteCleanup.forType(fn, conflictType.type),
        conflictType,
      ),
      loan,
      retainedLoans: [],
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'RawBufferCount') {
    const [buffer] = argumentLocals
    if (buffer === undefined) return undefined
    const destination = fn.alloc(usize)
    fn.emit({
      _tag: 'RawBufferCount' as const,
      destination,
      buffer,
      type: usize,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'RawBufferRead') {
    const [buffer, index] = argumentLocals
    const type = fn.type(expression.type)
    if (buffer === undefined || index === undefined || type === undefined) return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'RawBufferRead' as const,
      destination,
      buffer,
      index,
      element: fn.semantic(expression.type),
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'SliceView') {
    const [slice, offset, length] = argumentLocals
    const type = fn.type(expression.type)
    const element = Type.isSlice(expression.type) ? expression.type.element : undefined
    const semanticElement = element === undefined ? undefined : fn.semantic(element)
    const elementLayout =
      semanticElement === undefined ? undefined : Layout.entry(fn.layout, semanticElement)
    if (
      slice === undefined ||
      offset === undefined ||
      length === undefined ||
      type?._tag !== 'Slice' ||
      semanticElement === undefined ||
      elementLayout === undefined
    ) {
      return undefined
    }
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'SliceView' as const,
      destination,
      slice,
      offset,
      length,
      element: semanticElement,
      stride: Math.ceil(elementLayout.size / elementLayout.alignment) * elementLayout.alignment,
      heldLoans: expression.heldLoans,
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'RawBufferView' || expression.operation === 'RawBufferViewMut') {
    const [buffer, offset, length] = argumentLocals
    const type = fn.type(expression.type)
    const element = Type.isSlice(expression.type) ? expression.type.element : undefined
    const semanticElement = element === undefined ? undefined : fn.semantic(element)
    const elementLayout =
      semanticElement === undefined ? undefined : Layout.entry(fn.layout, semanticElement)
    if (
      buffer === undefined ||
      offset === undefined ||
      length === undefined ||
      type?._tag !== 'Slice' ||
      semanticElement === undefined ||
      elementLayout === undefined
    ) {
      return undefined
    }
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'RawBufferView' as const,
      destination,
      buffer,
      offset,
      length,
      element: semanticElement,
      stride: Math.ceil(elementLayout.size / elementLayout.alignment) * elementLayout.alignment,
      access: expression.operation === 'RawBufferView' ? 'Shared' : 'Exclusive',
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'RawBufferSlot') {
    const [buffer, index] = argumentLocals
    const type = fn.type(expression.type)
    const element = Type.isSlot(expression.type)
      ? Type.typeArgumentAt(expression.type, 1)
      : undefined
    if (
      buffer === undefined ||
      index === undefined ||
      type?._tag !== 'Nominal' ||
      !Type.isSlot(type.type) ||
      element === undefined
    )
      return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'RawBufferSlot' as const,
      destination,
      buffer,
      index,
      element: fn.semantic(element),
      type,
      provenance: authored(expression.span),
    })
    fn.slotLoans.set(destination.ordinal, expression.heldLoans)
    return finishBuiltin(destination)
  }
  if (expression.operation === 'RawBufferCopy') {
    const [buffer, offset, source, length] = argumentLocals
    const sourceArgument = expression.arguments.at(2)
    const sourceType = sourceArgument?._tag === 'Unavailable' ? undefined : sourceArgument?.type
    const element =
      sourceType !== undefined && Type.isSlice(sourceType) ? sourceType.element : undefined
    const semanticElement = element === undefined ? undefined : fn.semantic(element)
    const elementLayout =
      semanticElement === undefined ? undefined : Layout.entry(fn.layout, semanticElement)
    const type = fn.type(expression.type)
    if (
      buffer === undefined ||
      offset === undefined ||
      source === undefined ||
      length === undefined ||
      semanticElement === undefined ||
      elementLayout === undefined ||
      type?._tag !== 'Nominal' ||
      !Type.equals(type.type, Type.unit)
    )
      return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'RawBufferCopy' as const,
      destination,
      buffer,
      offset,
      source,
      length,
      element: semanticElement,
      stride: Math.ceil(elementLayout.size / elementLayout.alignment) * elementLayout.alignment,
      retainsSource: Mir.isCopy(fn.layout, semanticElement),
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'RawBufferFill') {
    const [buffer, offset, length, value] = argumentLocals
    const type = fn.type(expression.type)
    if (
      buffer === undefined ||
      offset === undefined ||
      length === undefined ||
      value === undefined ||
      type?._tag !== 'Nominal' ||
      !Type.equals(type.type, Type.unit)
    )
      return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'RawBufferFill' as const,
      destination,
      buffer,
      offset,
      length,
      value,
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'PointerNull') {
    const type = fn.type(expression.type)
    if (type?._tag !== 'Pointer') return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'PointerNull' as const,
      destination,
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'PointerIsNull') {
    const [pointer] = argumentLocals
    if (pointer === undefined) return undefined
    const destination = fn.alloc({ _tag: 'bool' as const })
    fn.emit({
      _tag: 'PointerIsNull' as const,
      destination,
      pointer,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'PointerAddress') {
    const [pointer] = argumentLocals
    if (pointer === undefined) return undefined
    const destination = fn.alloc({ _tag: 'usize' as const })
    fn.emit({
      _tag: 'PointerAddress' as const,
      destination,
      pointer,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (
    expression.operation === 'PointerReinterpret' ||
    expression.operation === 'PointerRequalify' ||
    expression.operation === 'PointerBytes' ||
    expression.operation === 'SlotAddress' ||
    expression.operation === 'PointerFromRef' ||
    expression.operation === 'PointerFromMutRef' ||
    expression.operation === 'PointerFromSlice' ||
    expression.operation === 'PointerFromMutSlice'
  ) {
    const [source] = argumentLocals
    const type = fn.type(expression.type)
    if (source === undefined || type?._tag !== 'Pointer') return undefined
    const destination = fn.alloc(type)
    const tag =
      expression.operation === 'PointerReinterpret' ||
      expression.operation === 'PointerRequalify' ||
      expression.operation === 'PointerBytes'
        ? expression.operation
        : 'PointerFromStorage'
    fn.emit({
      _tag: tag,
      destination,
      source,
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'PointerAt' || expression.operation === 'PointerAtMut') {
    const [pointer, count] = argumentLocals
    const type = fn.type(expression.type)
    if (pointer === undefined || count === undefined || type?._tag !== 'Pointer') return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'PointerAt' as const,
      destination,
      pointer,
      count,
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'PointerRead' || expression.operation === 'PointerReadUnaligned') {
    const [pointer] = argumentLocals
    const type = fn.type(expression.type)
    if (pointer === undefined || type === undefined) return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'PointerRead' as const,
      destination,
      pointer,
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'PointerWrite' || expression.operation === 'PointerWriteUnaligned') {
    const [pointer, value] = argumentLocals
    const type = fn.type(expression.type)
    if (
      pointer === undefined ||
      value === undefined ||
      type?._tag !== 'Nominal' ||
      !Type.equals(type.type, Type.unit)
    )
      return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'PointerWrite' as const,
      destination,
      pointer,
      value,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'SlotWrite') {
    const [slot, value] = argumentLocals
    const slotArgument = expression.arguments.at(0)
    const slotType = slotArgument?._tag === 'Unavailable' ? undefined : slotArgument?.type
    const slotElement =
      slotType !== undefined && Type.isSlot(slotType) ? Type.typeArgumentAt(slotType, 1) : undefined
    const type = fn.type(expression.type)
    if (
      slot === undefined ||
      value === undefined ||
      slotElement === undefined ||
      type?._tag !== 'Nominal' ||
      !Type.equals(type.type, Type.unit)
    )
      return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'SlotWrite' as const,
      destination,
      slot,
      value,
      element: fn.semantic(slotElement),
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'SlotTake') {
    const [slot] = argumentLocals
    const type = fn.type(expression.type)
    if (slot === undefined || type === undefined) return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'SlotTake' as const,
      destination,
      slot,
      element: fn.semantic(expression.type),
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'SlotCopy') {
    const [slot] = argumentLocals
    const type = fn.type(expression.type)
    if (slot === undefined || type === undefined) return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'SlotCopy' as const,
      destination,
      slot,
      element: fn.semantic(expression.type),
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'SlotDrop') {
    const [slot] = argumentLocals
    const slotArgument = expression.arguments.at(0)
    const slotType = slotArgument?._tag === 'Unavailable' ? undefined : slotArgument?.type
    const element =
      slotType !== undefined && Type.isSlot(slotType) ? Type.typeArgumentAt(slotType, 1) : undefined
    const type = fn.type(expression.type)
    if (
      slot === undefined ||
      element === undefined ||
      type?._tag !== 'Nominal' ||
      !Type.equals(type.type, Type.unit)
    )
      return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'SlotDrop' as const,
      destination,
      slot,
      element: fn.semantic(element),
      cleanup: ConcreteCleanup.forType(fn, fn.semantic(element)),
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'StringFromUtf8Unchecked') return undefined
  if (expression.operation === 'StringUtf8Bytes') {
    const [string] = argumentLocals
    const stringType = string === undefined ? undefined : fn.localTypes.at(string.ordinal)
    const type = fn.type(expression.type)
    if (string === undefined || stringType?._tag !== 'String' || type?._tag !== 'Slice')
      return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'StringUtf8Bytes',
      destination,
      string,
      heldLoans: expression.heldLoans,
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'StringByteLength') {
    const [string] = argumentLocals
    const stringType = string === undefined ? undefined : fn.localTypes.at(string.ordinal)
    if (string === undefined || stringType?._tag !== 'String') return undefined
    const destination = fn.alloc(usize)
    fn.emit({
      _tag: 'StringByteLength',
      destination,
      string,
      type: usize,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'ExecutionRefOf') {
    const [execution] = argumentLocals
    const executionType = execution === undefined ? undefined : fn.localTypes.at(execution.ordinal)
    const type = fn.type(expression.type)
    if (
      execution === undefined ||
      executionType?._tag !== 'Reference' ||
      !Type.isExecution(executionType.type.target) ||
      type?._tag !== 'Nominal' ||
      !Type.isExecutionRef(type.type)
    )
      return undefined
    const destination = fn.alloc(type)
    fn.emit({
      _tag: 'ExecutionRefOf' as const,
      destination,
      execution,
      executionAccess: 'Shared' as const,
      type,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (
    expression.operation === 'ExecutionLoad' ||
    expression.operation === 'ExecutionStore' ||
    expression.operation === 'ExecutionNotify' ||
    expression.operation === 'ExecutionLive'
  ) {
    const [reference, word, value] = argumentLocals
    const referenceType = reference === undefined ? undefined : fn.localTypes.at(reference.ordinal)
    const type = fn.type(expression.type)
    if (
      reference === undefined ||
      referenceType?._tag !== 'Reference' ||
      !Type.isExecutionRef(referenceType.type.target) ||
      type === undefined
    )
      return undefined
    const destination = fn.alloc(type)
    const provenance = authored(expression.span)
    if (expression.operation === 'ExecutionLoad') {
      if (word === undefined || type._tag !== 'usize') return undefined
      fn.emit({
        _tag: 'ExecutionLoad' as const,
        destination,
        reference,
        word,
        referenceAccess: 'Shared' as const,
        type,
        provenance,
      })
    } else if (expression.operation === 'ExecutionLive') {
      if (type._tag !== 'bool') return undefined
      fn.emit({
        _tag: 'ExecutionLive' as const,
        destination,
        reference,
        referenceAccess: 'Shared' as const,
        type,
        provenance,
      })
    } else {
      if (type._tag !== 'Nominal' || !Type.equals(type.type, Type.unit)) return undefined
      if (expression.operation === 'ExecutionNotify')
        fn.emit({
          _tag: 'ExecutionNotify' as const,
          destination,
          reference,
          referenceAccess: 'Shared' as const,
          type,
          provenance,
        })
      else {
        if (word === undefined || value === undefined) return undefined
        fn.emit({
          _tag: 'ExecutionStore' as const,
          destination,
          reference,
          word,
          value,
          referenceAccess: 'Shared' as const,
          type,
          provenance,
        })
      }
    }
    return finishBuiltin(destination)
  }
  if (
    expression.operation === 'ExecutionDrive' ||
    expression.operation === 'ExecutionRelinquish' ||
    expression.operation === 'ExecutionCurrent'
  )
    return undefined
  if (expression.operation === 'StringEqualsExact' || expression.operation === 'NativeAssembly')
    return undefined
  const conversionTarget = Scalar.conversionTarget(expression.operation)
  if (Scalar.isCheckedOperation(expression.operation)) {
    const arity = expression.operation.startsWith('CheckedConvertTo') ? 1 : 2
    const operands = argumentLocals.slice(0, arity)
    const present = argumentLocals.at(arity)
    const absent = argumentLocals.at(arity + 1)
    const presentType = present === undefined ? undefined : fn.localTypes.at(present.ordinal)
    const absentType = absent === undefined ? undefined : fn.localTypes.at(absent.ordinal)
    const [first] = operands
    const sourceType = first === undefined ? undefined : fn.localTypes.at(first.ordinal)
    const semanticSource = sourceType === undefined ? undefined : Mir.semanticType(sourceType)
    const sourceScalar =
      typeof semanticSource === 'string' ? Scalar.find(semanticSource) : undefined
    const valueScalar =
      expression.operation === 'CheckedConvertToChar'
        ? Scalar.character
        : (conversionTarget ?? sourceScalar)
    const targetType = fn.type(expression.type)
    if (
      first === undefined ||
      present === undefined ||
      absent === undefined ||
      presentType?._tag !== 'CallableValue' ||
      absentType?._tag !== 'CallableValue' ||
      sourceScalar?.category !== 'Integer' ||
      (valueScalar?.category !== 'Integer' && valueScalar?.category !== 'Character') ||
      sourceType?._tag !== sourceScalar.spelling ||
      targetType === undefined ||
      operands.some((local) => fn.localTypes.at(local.ordinal)?._tag !== sourceType._tag)
    )
      return undefined
    const valid = fn.alloc({ _tag: 'bool' as const })
    const value = fn.alloc({ _tag: valueScalar.spelling })
    const destination = fn.alloc(targetType)
    fn.emit({
      _tag: 'CheckedScalar' as const,
      operation: expression.operation,
      destination,
      valid,
      value,
      operands,
      present,
      absent,
      presentCleanup: ConcreteCleanup.forCallable(fn, presentType),
      absentCleanup: ConcreteCleanup.forCallable(fn, absentType),
      sourceType,
      valueType: { _tag: valueScalar.spelling },
      type: targetType,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (conversionTarget !== undefined) {
    const [source] = argumentLocals
    const sourceType = source === undefined ? undefined : fn.localTypes.at(source.ordinal)
    const semanticSource = sourceType === undefined ? undefined : Mir.semanticType(sourceType)
    const sourceScalar =
      typeof semanticSource === 'string' ? Scalar.find(semanticSource) : undefined
    const targetType = fn.type(expression.type)
    if (
      source === undefined ||
      sourceScalar === undefined ||
      sourceScalar?.category === 'Boolean' ||
      sourceType?._tag !== sourceScalar.spelling ||
      targetType?._tag !== conversionTarget.spelling
    )
      return undefined
    const destination = fn.alloc(targetType)
    fn.emit({
      _tag:
        sourceScalar.category === 'Integer'
          ? ('ConvertInteger' as const)
          : ('ConvertScalar' as const),
      destination,
      source,
      sourceType,
      type: targetType,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  const floatConversionTarget = Scalar.floatConversionTarget(expression.operation)
  if (floatConversionTarget !== undefined) {
    const [source] = argumentLocals
    const sourceType = source === undefined ? undefined : fn.localTypes.at(source.ordinal)
    const semanticSource = sourceType === undefined ? undefined : Mir.semanticType(sourceType)
    const sourceScalar =
      typeof semanticSource === 'string' ? Scalar.find(semanticSource) : undefined
    const targetType = fn.type(expression.type)
    if (
      source === undefined ||
      sourceScalar === undefined ||
      sourceScalar.category === 'Boolean' ||
      sourceType?._tag !== sourceScalar.spelling ||
      targetType?._tag !== floatConversionTarget.spelling
    )
      return undefined
    const destination = fn.alloc(targetType)
    fn.emit({
      _tag: 'ConvertScalar' as const,
      destination,
      source,
      sourceType,
      type: targetType,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'ToBits' || expression.operation === 'FromBits') {
    const [source] = argumentLocals
    const sourceType = source === undefined ? undefined : fn.localTypes.at(source.ordinal)
    const targetType = fn.type(expression.type)
    if (source === undefined || sourceType === undefined || targetType === undefined)
      return undefined
    const destination = fn.alloc(targetType)
    fn.emit({
      _tag: 'ReinterpretScalar' as const,
      destination,
      source,
      sourceType: sourceType as Mir.ScalarType,
      type: targetType as Mir.ScalarType,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (expression.operation === 'Sin' || expression.operation === 'Cos') {
    const [source] = argumentLocals
    const sourceType = source === undefined ? undefined : fn.localTypes.at(source.ordinal)
    const targetType = fn.type(expression.type)
    if (source === undefined || sourceType === undefined || targetType === undefined)
      return undefined
    const destination = fn.alloc(targetType)
    fn.emit({
      _tag: 'FloatTranscendental' as const,
      operation: expression.operation,
      destination,
      source,
      sourceType: sourceType as Mir.ScalarType,
      type: targetType as Mir.ScalarType,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (
    expression.operation === 'IsNaN' ||
    expression.operation === 'IsInfinite' ||
    expression.operation === 'IsFinite' ||
    expression.operation === 'IsNormal' ||
    expression.operation === 'IsSubnormal' ||
    expression.operation === 'IsSignNegative' ||
    expression.operation === 'Sqrt' ||
    (expression.operation === 'Negate' &&
      argumentLocals.some((local) => {
        const type = fn.localTypes.at(local.ordinal)
        const semantic = type === undefined ? undefined : Mir.semanticType(type)
        return typeof semantic === 'string' && Scalar.find(semantic)?.category === 'Floating'
      }))
  ) {
    const [source] = argumentLocals
    const sourceType = source === undefined ? undefined : fn.localTypes.at(source.ordinal)
    const targetType = fn.type(expression.type)
    if (source === undefined || sourceType === undefined || targetType === undefined)
      return undefined
    const destination = fn.alloc(targetType)
    fn.emit({
      _tag: 'FloatUnary' as const,
      operation: expression.operation,
      destination,
      source,
      sourceType: sourceType as Mir.ScalarType,
      type: targetType as Mir.ScalarType,
      provenance: authored(expression.span),
    })
    return finishBuiltin(destination)
  }
  if (
    expression.operation === 'Not' ||
    expression.operation === 'Negate' ||
    expression.operation === 'BitNot' ||
    expression.operation === 'WrappingNegate' ||
    expression.operation === 'SaturatingNegate'
  ) {
    const [subject] = argumentLocals
    if (subject === undefined) return undefined
    const operandType = fn.localTypes.at(subject.ordinal)
    if (operandType === undefined) return undefined
    const semanticOperand = Mir.semanticType(operandType)
    const scalar = typeof semanticOperand === 'string' ? Scalar.find(semanticOperand) : undefined
    if (expression.operation !== 'Not' && scalar?.category !== 'Integer') return undefined
    const pointerBits = fn.layout.target.pointerSize === 4 ? 32 : 64
    let constant = 0n
    if (expression.operation === 'BitNot' && scalar?.category === 'Integer') {
      constant = scalar.signedness === 'Signed' ? -1n : Scalar.range(scalar, pointerBits).maximum
    }
    const zero = fn.alloc(operandType)
    fn.emit({
      _tag: 'Literal',
      destination: zero,
      type: operandType,
      value: constant,
      provenance: { span: expression.span, generated: true },
    })
    const destination = fn.alloc(operandType)
    let operator: Mir.BinaryOperator = 'Subtract'
    if (expression.operation === 'Not') operator = 'Equals'
    else if (expression.operation === 'BitNot') operator = 'BitXor'
    else if (expression.operation === 'WrappingNegate') operator = 'WrappingSubtract'
    else if (expression.operation === 'SaturatingNegate') operator = 'SaturatingSubtract'
    fn.emit({
      _tag: 'Binary',
      operator,
      destination,
      left: expression.operation === 'Not' ? subject : zero,
      right: expression.operation === 'Not' ? zero : subject,
      type: operandType,
      provenance: { span: expression.span, generated: false },
    })
    return finishBuiltin(destination)
  }
  if (!Mir.isBinaryOperator(expression.operation)) return undefined
  const [left, right] = argumentLocals
  if (left === undefined || right === undefined) return undefined
  const type = fn.type(expression.type)
  if (type === undefined) return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'Binary',
    operator: expression.operation,
    destination,
    left,
    right,
    type,
    provenance: { span: expression.span, generated: false },
  })
  return finishBuiltin(destination)
}
