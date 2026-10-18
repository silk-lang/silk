import * as Emitter from '@silklang/llvm/Emitter'
import type * as Target from './Target.js'
import * as Mir from './Mir.js'
import * as NativeAssembly from './NativeAssembly.js'
import type { Context } from './NativeOperationContext.js'
import * as NativeStorage from './NativeStorage.js'
import * as Type from './Type.js'

/** Lowers validated assembly using existing LLVM constants and checked call construction. */
export const emit = (
  context: Context,
  operation: Extract<Mir.Operation, { readonly _tag: 'NativeAssembly' }>,
) => {
  const { builder, body, storage, program } = context
  const word = Emitter.integerType(builder, 64)
  const pointer = context.pointer
  const result = Mir.semanticType(operation.type)
  let resultType = Type.isPointer(result) ? pointer : word
  if (Type.equals(result, Type.unit)) resultType = Emitter.voidType(builder)
  const parameters = operation.arguments.map((argument) => {
    const type = storage.fn.localTypes[argument.ordinal]
    if (type === undefined) throw new RangeError('Assembly argument lost its type')
    return Type.isPointer(Mir.semanticType(type)) ? pointer : word
  })
  const memory = { none: 0, read: 1, write: 2, readwrite: 3 }[operation.assembly.memory]
  // Observable machine effects use LLVM's inaccessible-memory lane, even with no data access.
  const effects = operation.assembly.sideEffects ? (memory * 21) | 12 : memory * 21
  const properties = [Emitter.integerAttribute(builder, 'memory', effects)]
  if (operation.assembly.noReturn) properties.push(Emitter.flagAttribute(builder, 'noreturn'))
  const value = Emitter.callAssembly(
    body,
    Emitter.functionType(builder, resultType, parameters),
    operation.assembly.template,
    NativeAssembly.llvmConstraints(operation.assembly, program.layout.target),
    Array.from(operation.arguments, (argument) => NativeStorage.readScalar(storage, argument)),
    Type.equals(result, Type.unit) ? undefined : `assembly${operation.destination.ordinal}`,
    { sideEffect: operation.assembly.sideEffects, alignStack: false, canThrow: false },
    {
      attributes: Emitter.functionAttributes(builder, {
        functionAttributes: Emitter.attributeSet(builder, properties),
      }),
    },
  )
  if (!operation.assembly.noReturn && operation.assembly.memory !== 'none')
    for (const root of [...storage.addressRoots].sort((a, b) => a - b))
      NativeStorage.reloadAddressRoot(storage, root)
  if (!Type.equals(result, Type.unit) && value === undefined)
    throw new RangeError('Assembly result was not emitted')
  NativeStorage.writeLocal(
    storage,
    operation.destination.ordinal,
    value === undefined ? [] : [value],
  )
}

/** Emits the admitted naked body in one LLVM block, with no compiler-created control edges. */
export const emitNaked = (
  builder: Emitter.Module,
  body: Emitter.Body,
  fn: Mir.MirFunction,
  target: Target.Target,
) => {
  const operation = fn.regions.flatMap(Mir.operationsOf)[0]
  if (operation?._tag !== 'NativeAssembly')
    throw new RangeError('Naked MIR lost its assembly operation')
  Emitter.block(body, 'entry')
  Emitter.callAssembly(
    body,
    Emitter.functionType(builder, Emitter.voidType(builder), []),
    operation.assembly.template,
    NativeAssembly.llvmConstraints(operation.assembly, target),
    [],
    undefined,
    { sideEffect: true, alignStack: false, canThrow: false },
    {
      attributes: Emitter.functionAttributes(builder, {
        functionAttributes: Emitter.attributeSet(builder, [
          Emitter.flagAttribute(builder, 'noreturn'),
        ]),
      }),
    },
  )
  Emitter.unreachable(body)
}
