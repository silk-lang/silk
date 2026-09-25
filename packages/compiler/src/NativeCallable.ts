import * as Emitter from '@silklang/llvm/Emitter'
import * as NativeStorage from './NativeStorage.js'
import type * as NativeArgument from './NativeArgument.js'
import type * as NativeValue from './NativeValue.js'
import type * as Value from '@silklang/llvm/Value'
import * as Tir from './Tir.js'
import * as Layout from './Layout.js'
import * as NativePlace from './NativePlace.js'
import type * as Mir from './Mir.js'
import * as NativeLanePointer from './NativeLanePointer.js'
import * as NativeType from './NativeType.js'

export interface Context {
  readonly body: Emitter.Body
  readonly program: Mir.Module
  readonly types: NativeType.LoweringContext
  readonly lanePointers: NativeLanePointer.Context
}

/** Restores positional capture groups using the target's ordinary internal calling convention. */
export const capturedArguments = (
  context: Context,
  type: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>,
  values: ReadonlyArray<Value.Input>,
  tag: string,
) => {
  const groups: Array<{
    readonly parameterOrdinal: number
    readonly values: ReadonlyArray<Value.Input>
  }> = []
  const borrowed =
    type.target?._tag === 'DeclarationCallableTarget' &&
    Tir.isAnonymousCallableId(type.target.declaration)
  let cursor = 0
  for (const field of type.environment?.fields ?? []) {
    const lanes = Layout.callableFieldLanes(context.program.layout, field)
    if (field.representation !== 'Borrow') {
      groups.push({
        parameterOrdinal: field.parameterOrdinal,
        values: values.slice(cursor, cursor + lanes.length),
      })
      cursor += lanes.length
      continue
    }
    const base = values.at(cursor++)
    if (base === undefined) throw new RangeError('Callable borrowed environment lost its pointer')
    if (borrowed) {
      groups.push({ parameterOrdinal: field.parameterOrdinal, values: [base] })
      continue
    }
    const captured = NativePlace.loadLanes(
      NativePlace.stored(context.program.layout, field.type, base),
      context,
      `${tag}_capture${field.ordinal}`,
    )
    groups.push({ parameterOrdinal: field.parameterOrdinal, values: captured })
  }
  return groups
}

/** Keeps captured values in their canonical places until the selected callee needs ABI lanes. */
export const capturedValues = (
  context: Context & { readonly storage: NativeStorage.Context },
  type: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>,
  local: Mir.LocalId,
  parameters: ReadonlyArray<NativeArgument.Parameter>,
  tag: string,
) => {
  const source = NativeStorage.readLocal(context.storage, local)
  const groups: Array<{
    readonly parameterOrdinal: number
    readonly value: NativeValue.NativeValue
  }> = []
  if ((type.environment?.fields.length ?? 0) === 0) return groups
  if (source._tag === 'Empty')
    return (type.environment?.fields ?? []).map((field) => ({
      parameterOrdinal: field.parameterOrdinal,
      value: source,
    }))
  if (source._tag !== 'NativePlace')
    throw new RangeError('Callable captures lost their canonical storage')
  let cursor = 0
  for (const field of type.environment?.fields ?? []) {
    const parameter = parameters.at(field.parameterOrdinal)
    if (parameter === undefined) throw new RangeError('Callable capture lost its parameter')
    let value: NativeValue.NativeValue
    if (field.representation === 'Borrow') {
      const base = NativePlace.loadLane(source, context, cursor, `${tag}_borrow${field.ordinal}`)
      value =
        parameter.type._tag === 'EnvironmentBorrow'
          ? { _tag: 'Direct', values: [base] }
          : NativePlace.make(context.program.layout, parameter.type, base)
    } else
      value = NativePlace.project(
        source,
        context,
        parameter.type,
        field.offset,
        `${tag}_capture${field.ordinal}`,
      )
    groups.push({ parameterOrdinal: field.parameterOrdinal, value })
    cursor += Layout.callableFieldLanes(context.program.layout, field).length
  }
  return groups
}
