import type * as Value from '@silklang/llvm/Value'
import type * as Layout from './Layout.js'
import type * as Mir from './Mir.js'
import type * as Type from './Type.js'
import * as NativeArith from './NativeArith.js'
import * as NativePlace from './NativePlace.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativeType from './NativeType.js'

/** A selected payload reader, not a cache: every storage read observes its current bytes. */
export type NativePayload =
  | {
      readonly _tag: 'Boundary'
      readonly length: number
      readonly values: ReadonlyArray<Value.Input>
    }
  | { readonly _tag: 'Local'; readonly length: number; readonly local: Mir.LocalId }
  | { readonly _tag: 'Place'; readonly length: number; readonly place: NativePlace.NativePlace }
  | {
      readonly _tag: 'Projection'
      readonly length: number
      readonly source: NativePayload
      readonly slots: ReadonlyArray<number>
      readonly conversion?: {
        readonly source: ReadonlyArray<Layout.CallingLane>
        readonly target: ReadonlyArray<Layout.CallingLane>
      }
    }

export interface Context {
  readonly storage: NativeStorage.Context
  readonly arith: NativeArith.LaneContext
  readonly types: NativeType.LoweringContext
}

/** Admits lanes already materialized by an ABI or transport boundary. */
export const fromValues = (values: ReadonlyArray<Value.Input>): NativePayload => ({
  _tag: 'Boundary',
  length: values.length,
  values,
})

export const local = (context: NativeStorage.Context, local: Mir.LocalId): NativePayload => {
  const type = context.fn.localTypes.at(local.ordinal)
  if (type === undefined) throw new RangeError('Payload lost its local type')
  return { _tag: 'Local', local, length: NativeType.valueLanesFor(context.types, type).length }
}

export const place = (
  context: NativeType.LoweringContext,
  place: NativePlace.NativePlace,
): NativePayload => ({
  _tag: 'Place',
  place,
  length: NativeType.valueLanesFor(context, place.type).length,
})

/** Returns authoritative storage when the payload has not crossed an ABI lane boundary. */
export const storage = (
  self: NativePayload,
  context: Context,
): NativePlace.NativePlace | undefined => {
  if (self._tag === 'Place') return self.place
  if (self._tag !== 'Local') return undefined
  const value = NativeStorage.readLocal(context.storage, self.local)
  return value._tag === 'NativePlace' ? value : undefined
}

/** Preserves a selected canonical subplace; boundary-only values retain their lane projection. */
export const projectStored = (
  self: NativePayload,
  context: Context,
  type: Type.Type,
  offset: number,
  slots: ReadonlyArray<number>,
  tag: string,
  conversion?: Extract<NativePayload, { readonly _tag: 'Projection' }>['conversion'],
  concrete?: Mir.Type,
) => {
  const source = storage(self, context)
  if (source === undefined) return project(self, slots, conversion)
  const model =
    concrete === undefined
      ? NativePlace.stored(context.types.program.layout, type, source.base)
      : NativePlace.make(context.types.program.layout, concrete, source.base)
  return place(
    context.types,
    NativePlace.project(source, context.storage, model.type, offset, tag, model.representation),
  )
}

export const project = (
  source: NativePayload,
  slots: ReadonlyArray<number>,
  conversion?: Extract<NativePayload, { readonly _tag: 'Projection' }>['conversion'],
): NativePayload => ({
  _tag: 'Projection',
  length: slots.length,
  source,
  slots,
  ...(conversion === undefined ? {} : { conversion }),
})

export const slice = (source: NativePayload, start: number, end = source.length): NativePayload =>
  project(
    source,
    Array.from(
      { length: Math.max(0, Math.min(end, source.length) - start) },
      (_, ordinal) => start + ordinal,
    ),
  )

/** Resolves a selected boundary together so nested overlays dispatch once per member. */
const read = (
  self: NativePayload,
  context: Context,
  ordinals: ReadonlyArray<number>,
  tag: string,
): ReadonlyArray<Value.Input> => {
  if (ordinals.some((ordinal) => ordinal < 0 || ordinal >= self.length))
    throw new RangeError('Payload lane is outside its planned extent')
  switch (self._tag) {
    case 'Boundary':
      return ordinals.map((ordinal) => self.values.at(ordinal) ?? missing())
    case 'Local': {
      const value = NativeStorage.readLocal(context.storage, self.local)
      if (value._tag === 'NativePlace')
        return NativePlace.loadSelected(value, context.storage, ordinals, tag)
      if (value._tag === 'Empty') return []
      return ordinals.map((ordinal) => value.values.at(ordinal) ?? missing())
    }
    case 'Place':
      return NativePlace.loadSelected(self.place, context.storage, ordinals, tag)
    case 'Projection': {
      const slots = ordinals.map((ordinal) => self.slots.at(ordinal) ?? missing())
      const values = read(self.source, context, slots, tag)
      if (self.conversion === undefined) return values
      const converted: Array<Value.Input> = []
      for (const [index, ordinal] of ordinals.entries()) {
        const slot = slots.at(index) ?? missing()
        const source = self.conversion.source.at(slot) ?? missing()
        const target = self.conversion.target.at(ordinal) ?? missing()
        converted.push(
          NativeArith.coerceLane(
            context.arith,
            values.at(index) ?? missing(),
            source,
            target,
            `${tag}_${ordinal}_converted`,
          ),
        )
      }
      return converted
    }
  }
}

const missing = (): never => {
  throw new RangeError('Payload projection lost a planned lane')
}

/** Reads one current field after its initialization and active-member guards. */
export const at = (self: NativePayload, context: Context, ordinal: number, tag: string) => {
  return read(self, context, [ordinal], tag).at(0) ?? missing()
}

/** Expands only this selected payload at an explicit call or representation boundary. */
export const materialize = (self: NativePayload, context: Context, tag: string) => {
  return read(
    self,
    context,
    Array.from({ length: self.length }, (_, ordinal) => ordinal),
    tag,
  )
}
