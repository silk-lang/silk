import type * as Value from '@silklang/llvm/Value'
import type * as Layout from './Layout.js'
import type * as Mir from './Mir.js'
import * as NativePlace from './NativePlace.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativeValue from './NativeValue.js'

/** One logical parameter's private native transport. Results and suspension payloads are separate. */
export interface Parameter {
  readonly type: Mir.Type
  readonly lanes: ReadonlyArray<Layout.CallingLane>
  readonly indirect: boolean
}

/** Arguments retain canonical places until a call or persistent transport actually needs lanes. */
export type NativeArgument =
  | { readonly _tag: 'Values'; readonly values: ReadonlyArray<NativeValue.NativeValue> }
  | { readonly _tag: 'Materialized'; readonly values: ReadonlyArray<Value.Input> }

export const isIndirect = (layout: Layout.Plan, fn: Mir.MirFunction, type: Mir.Type): boolean =>
  fn.regions.length > 0 &&
  fn.machine === undefined &&
  (fn.suspension === undefined || fn.suspension.classification === 'Synchronous') &&
  NativeValue.classify(layout, type) === 'Place'

/** Synchronous source calls copy aggregate bytes on entry; suspension keeps its persistent ABI. */
export const parameters = (
  layout: Layout.Plan,
  fn: Mir.MirFunction,
  lanesFor: (type: Mir.Type) => ReadonlyArray<Layout.CallingLane>,
): ReadonlyArray<Parameter> => {
  if (fn.regions.length === 0) return []
  return fn.localTypes.slice(0, fn.parameterCount).map((type) => ({
    type,
    lanes: lanesFor(type),
    indirect: isIndirect(layout, fn, type),
  }))
}

/** Admits scalar values already produced by a result, composite, or continuation boundary. */
export const fromValues = (values: ReadonlyArray<Value.Input>): NativeArgument => ({
  _tag: 'Materialized',
  values,
})

export const fromLocals = (
  storage: NativeStorage.Context,
  locals: ReadonlyArray<Mir.LocalId>,
): NativeArgument => ({
  _tag: 'Values',
  values: locals.map((local) => NativeStorage.readLocal(storage, local)),
})

export const materialize = (context: NativePlace.Context, args: NativeArgument, tag: string) => {
  if (args._tag === 'Materialized') return args.values
  const values: Array<Value.Input> = []
  for (const [ordinal, value] of args.values.entries()) {
    if (value._tag === 'Direct') values.push(...value.values)
    else if (value._tag === 'NativePlace')
      values.push(...NativePlace.loadLanes(value, context, `${tag}_${ordinal}`))
  }
  return values
}

/** Lowers one complete logical argument list into the declared physical ABI. */
export const lower = (
  context: NativePlace.Context,
  parameters: ReadonlyArray<Parameter>,
  args: NativeArgument,
  tag: string,
) => {
  const values: Array<NativeValue.NativeValue> = []
  if (args._tag === 'Values') values.push(...args.values)
  else {
    let cursor = 0
    for (const parameter of parameters) {
      values.push({
        _tag: 'Direct',
        values: args.values.slice(cursor, cursor + parameter.lanes.length),
      })
      cursor += parameter.lanes.length
    }
    if (cursor !== args.values.length)
      throw new RangeError('Native argument boundary lost its logical shape')
  }
  if (values.length !== parameters.length)
    throw new RangeError('Native argument count differs from its declaration')
  const output: Array<Value.Input> = []
  for (const [ordinal, parameter] of parameters.entries()) {
    const value = values.at(ordinal)
    if (value === undefined) throw new RangeError('Native argument lost its value')
    if (parameter.indirect) {
      if (value._tag === 'NativePlace') {
        const expected = NativePlace.make(context.types.program.layout, parameter.type, value.base)
        if (value.view === expected.view && value.representation === expected.representation) {
          output.push(NativePlace.base(value, context, `${tag}_${ordinal}_base`))
          continue
        }
      }
      const temporary = NativePlace.allocate(
        context,
        parameter.type,
        `${tag}_${ordinal}_argument`,
        'entry',
      )
      if (value._tag === 'NativePlace') NativePlace.transfer(temporary, context, value)
      else
        NativePlace.storeLanes(
          temporary,
          context,
          value._tag === 'Empty' ? [] : value.values,
          `${tag}_${ordinal}_store`,
        )
      output.push(temporary.base)
    } else if (value._tag === 'NativePlace') {
      output.push(...NativePlace.loadLanes(value, context, `${tag}_${ordinal}_load`))
    } else {
      const lanes = value._tag === 'Empty' ? [] : value.values
      if (lanes.length !== parameter.lanes.length)
        throw new RangeError('Native scalar argument lost its lanes')
      output.push(...lanes)
    }
  }
  return output
}

/** Projects capture-time snapshots, never the original locals from which they were constructed. */
export const captures = (
  storage: NativeStorage.Context,
  parameters: ReadonlyArray<Parameter>,
  effect: Mir.LocalId,
  arguments_: ReadonlyArray<Mir.LocalId>,
) => {
  const type = storage.fn.localTypes.at(effect.ordinal)
  if (type?._tag !== 'EffectValue')
    throw new RangeError('Native Effect arguments lost their capture identity')
  const captured = NativeStorage.readLocal(storage, effect)
  if (type.environment.fields.length === 0) return fromLocals(storage, arguments_)
  if (
    type.storage !== undefined ||
    captured._tag !== 'NativePlace' ||
    type.environment.fields.some((field) => field.representation === 'Borrow')
  ) {
    return fromValues([
      ...NativeStorage.materialize(storage, effect),
      ...NativeStorage.materializeArguments(storage, arguments_).flat(),
    ])
  }
  const values: Array<NativeValue.NativeValue> = []
  for (const [ordinal, field] of type.environment.fields.entries()) {
    const parameter = parameters.at(ordinal)
    if (parameter === undefined) throw new RangeError('Native capture lost its parameter')
    values.push(
      NativePlace.project(
        captured,
        storage,
        parameter.type,
        field.offset,
        `capture_argument${effect.ordinal}_${ordinal}`,
      ),
    )
  }
  values.push(...arguments_.map((local) => NativeStorage.readLocal(storage, local)))
  return { _tag: 'Values', values } satisfies NativeArgument
}
