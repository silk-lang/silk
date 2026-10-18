import * as Emitter from '@silklang/llvm/Emitter'
import * as Attribute from '@silklang/llvm/Attribute'
import * as Constant from '@silklang/llvm/Constant'
import * as FunctionActor from '@silklang/llvm/Function'
import * as Value from '@silklang/llvm/Value'
import * as Type from '@silklang/llvm/Type'

/** Per-module fatal personality for the admitted native Itanium unwind ABI. */
export interface NativeForeignGuard {
  readonly personality: Constant.Constant
  readonly trap: FunctionActor.Function
}

/** Defines a personality that terminates in either phase before an exception can cross Silk. */
export const make = (builder: Emitter.Module): NativeForeignGuard => {
  const pointer = Emitter.pointerType(builder)
  const i32 = Emitter.integerType(builder, 32)
  const trap = Emitter.declareFunction(
    builder,
    'llvm.trap',
    Emitter.functionType(builder, Emitter.voidType(builder), []),
  )
  const personality = Emitter.declareFunction(
    builder,
    '__silk_foreign_personality',
    Emitter.functionType(builder, i32, [
      i32,
      i32,
      Emitter.integerType(builder, 64),
      pointer,
      pointer,
    ]),
    {
      linkage: 'internal',
      attributes: Emitter.functionAttributes(builder, {
        functionAttributes: Emitter.attributeSet(builder, [
          Emitter.flagAttribute(builder, 'noinline'),
          Emitter.flagAttribute(builder, 'nounwind'),
          Emitter.flagAttribute(builder, 'noreturn'),
        ]),
      }),
    },
  )
  Emitter.buildBody(builder, personality, (body) => {
    Emitter.block(body, 'entry')
    Emitter.callDirect(body, trap, [])
    Emitter.unreachable(body)
  })
  return {
    personality: Emitter.fromGlobal(builder, Emitter.functionGlobal(builder, personality)),
    trap,
  }
}

/** Wraps one foreign symbol in a non-inlined frame with an enforced fatal unwind path. */
export const wrap = (
  self: NativeForeignGuard,
  builder: Emitter.Module,
  target: FunctionActor.Function,
  ordinal: number,
  parameterTypes: ReadonlyArray<Type.Type>,
  resultType: Type.Type,
): FunctionActor.Function => {
  const properties = Emitter.functionProperties(builder, target)
  const groups =
    properties.attributes === undefined
      ? undefined
      : Emitter.functionAttributeEntries(builder, properties.attributes)
  const functions =
    groups === undefined ? [] : Emitter.attributeEntries(builder, groups.functionAttributes)
  const attributes = Emitter.functionAttributes(builder, {
    ...groups,
    functionAttributes: Emitter.attributeSet(builder, [
      ...functions,
      Emitter.flagAttribute(builder, 'noinline'),
      Emitter.flagAttribute(builder, 'nounwind'),
    ]),
  })
  const guard = Emitter.declareFunction(
    builder,
    `__silk_foreign_guard.${ordinal}`,
    Emitter.functionType(builder, resultType, parameterTypes),
    { linkage: 'internal', personality: self.personality, attributes },
  )
  const callee = Emitter.fromGlobal(builder, Emitter.functionGlobal(builder, target))
  Emitter.buildBody(builder, guard, (body) => {
    Emitter.block(body, 'entry')
    const normal = Emitter.block(body, 'returned')
    const unwind = Emitter.block(body, 'foreign_unwind')
    const args: Array<Value.Input> = []
    for (let index = 0; index < parameterTypes.length; index += 1)
      args.push(Emitter.argument(body, index))
    const result = Emitter.invoke(
      body,
      properties.type,
      callee,
      args,
      normal,
      unwind,
      'result',
      properties.attributes === undefined ? {} : { attributes: properties.attributes },
    )
    Emitter.setInsertionPoint(body, normal)
    if (result === undefined) Emitter.returnVoid(body)
    else Emitter.returnValue(body, result)
    Emitter.setInsertionPoint(body, unwind)
    Emitter.cleanupLandingPad(body, 'exception')
    Emitter.callDirect(body, self.trap, [])
    Emitter.unreachable(body)
  })
  return guard
}

/** Retains a fatal unwind frame around a runtime C address without specializing that address. */
export const indirect = (
  self: NativeForeignGuard,
  builder: Emitter.Module,
  calleeType: Type.Type,
  resultType: Type.Type,
  parameters: ReadonlyArray<Type.Type>,
  attributes: Attribute.FunctionSet | undefined,
  ordinal: number,
): FunctionActor.Function => {
  const groups =
    attributes === undefined ? undefined : Emitter.functionAttributeEntries(builder, attributes)
  const functions =
    groups === undefined ? [] : Emitter.attributeEntries(builder, groups.functionAttributes)
  const guardAttributes = Emitter.functionAttributes(builder, {
    ...groups,
    functionAttributes: Emitter.attributeSet(builder, [
      ...functions,
      Emitter.flagAttribute(builder, 'noinline'),
      Emitter.flagAttribute(builder, 'nounwind'),
    ]),
    parameterAttributes: [
      ...(groups?.parameterAttributes ?? []),
      Emitter.attributeSet(builder, []),
    ],
  })
  const guard = Emitter.declareFunction(
    builder,
    `__silk_foreign_indirect_guard.${ordinal}`,
    Emitter.functionType(builder, resultType, [...parameters, Emitter.pointerType(builder)]),
    { linkage: 'internal', personality: self.personality, attributes: guardAttributes },
  )
  Emitter.buildBody(builder, guard, (body) => {
    Emitter.block(body, 'entry')
    const normal = Emitter.block(body, 'returned')
    const unwind = Emitter.block(body, 'foreign_unwind')
    const arguments_: Array<Value.Input> = []
    for (let index = 0; index < parameters.length; index++)
      arguments_.push(Emitter.argument(body, index))
    const callee = Emitter.argument(body, parameters.length)
    const result = Emitter.invoke(
      body,
      calleeType,
      callee,
      arguments_,
      normal,
      unwind,
      'result',
      attributes === undefined ? {} : { attributes },
    )
    Emitter.setInsertionPoint(body, normal)
    if (result === undefined) Emitter.returnVoid(body)
    else Emitter.returnValue(body, result)
    Emitter.setInsertionPoint(body, unwind)
    Emitter.cleanupLandingPad(body, 'exception')
    Emitter.callDirect(body, self.trap, [])
    Emitter.unreachable(body)
  })
  return guard
}
