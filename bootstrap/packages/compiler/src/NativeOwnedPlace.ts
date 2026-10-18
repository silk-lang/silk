import type * as Value from '@silklang/llvm/Value'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as Layout from './Layout.js'
import * as Match from './Match.js'
import type * as Mir from './Mir.js'
import * as NativeArith from './NativeArith.js'
import * as Type from './Type.js'

/** A checked constant owned projection, retaining its original physical lane locations. */
export interface NativeOwnedPlace {
  readonly source: Layout.CallingShape
  readonly target: Layout.CallingShape
  readonly type: Type.Type
  readonly slots: ReadonlyArray<number>
}

/** One constant lane projection guarded by the runtime indices that select it. */
export interface Candidate {
  readonly place: NativeOwnedPlace
  readonly indices: ReadonlyArray<{ readonly local: Mir.LocalId; readonly value: number }>
}

/** Expands runtime array choices using the same checked layout projection as constant paths. */
export const candidates = (
  layout: Layout.Plan,
  root: Type.Type,
  selectors: ReadonlyArray<Mir.PlaceSelector>,
): ReadonlyArray<Candidate> => {
  const result: Array<Candidate> = []
  const visit = (
    ordinal: number,
    path: ReadonlyArray<Mir.PlaceSelector>,
    indices: Candidate['indices'],
  ): void => {
    const selector = selectors.at(ordinal)
    if (selector === undefined) {
      const place = make(layout, root, path)
      if (place === undefined) throw new RangeError('Owned place lost its verified projection')
      result.push({ place, indices })
      return
    }
    if (selector._tag === 'ElementSelector' && selector.index._tag === 'Runtime') {
      for (let value = 0; value < selector.length; value += 1)
        visit(
          ordinal + 1,
          [...path, { ...selector, index: { _tag: 'Proven', value } }],
          [...indices, { local: selector.index.local, value }],
        )
    } else visit(ordinal + 1, [...path, selector], indices)
  }
  visit(0, [], [])
  return result
}

/** Resolves fields, known elements and a previously refined variant without reading payloads. */
export const make = (
  layout: Layout.Plan,
  root: Type.Type,
  selectors: ReadonlyArray<Mir.PlaceSelector>,
): NativeOwnedPlace | undefined => {
  const source = Layout.callingShape(layout, root)
  if (source === undefined) return undefined
  let current = root
  let slots: ReadonlyArray<number> = source.lanes.map((_, ordinal) => ordinal)
  let variant:
    | Extract<Layout.Representation, { readonly _tag: 'NominalUnion' }>['variants'][number]
    | undefined
  for (const selector of selectors) {
    const shape = Layout.callingShape(layout, current)
    const representation = Layout.entry(layout, current)?.representation
    if (shape === undefined) return undefined
    let selected: ReadonlyArray<number> | undefined
    if (selector._tag === 'VariantSelector') {
      if (Type.isUnion(current)) {
        const member = current.members.at(selector.ordinal)
        if (member === undefined) return undefined
        selected = Layout.memberFieldSlots(shape, member, [])
        current = member
      } else if (Type.isNominal(current) && representation?._tag === 'NominalUnion') {
        variant = representation.variants.find(
          (candidate) => candidate.ordinal === selector.ordinal,
        )
        if (variant === undefined) return undefined
        continue
      } else return undefined
    } else if (selector._tag === 'FieldSelector') {
      if (variant !== undefined && Type.isNominal(current)) {
        const field = variant.fields.find((candidate) =>
          DeclarationFacts.sameFieldId(candidate.id, selector.field),
        )
        if (field === undefined) return undefined
        selected = Layout.coverageFieldSlots(
          shape,
          Match.nominalUnionVariant(current, current, variant.variant, variant.ordinal),
          [selector.field],
        )
        current = field.type
        variant = undefined
      } else if (representation?._tag === 'Aggregate') {
        const field = representation.fields.find((candidate) =>
          DeclarationFacts.sameFieldId(candidate.id, selector.field),
        )
        if (field === undefined) return undefined
        selected = shape.lanes.flatMap((lane, ordinal) => {
          const first = lane.path.at(0)
          return first?._tag === 'FieldId' && DeclarationFacts.sameFieldId(first, selector.field)
            ? [ordinal]
            : []
        })
        current = field.type
      } else return undefined
    } else if (
      selector._tag === 'ElementSelector' &&
      selector.index._tag === 'Proven' &&
      Type.isFixedArray(current)
    ) {
      const index = selector.index.value
      if (index < 0 || index >= current.length) return undefined
      selected = shape.lanes.flatMap((lane, ordinal) => {
        const first = lane.path.at(0)
        return first?._tag === 'ElementSelector' && first.index === index ? [ordinal] : []
      })
      current = current.element
    } else return undefined
    if (selected === undefined) return undefined
    const mapped = selected.flatMap((ordinal) => {
      const original = slots.at(ordinal)
      return original === undefined ? [] : [original]
    })
    if (mapped.length !== selected.length) return undefined
    slots = mapped
  }
  const target = Layout.callingShape(layout, current)
  if (target === undefined || target.lanes.length !== slots.length) return undefined
  return { source, target, type: current, slots }
}

/** Loads only the selected flattened lanes; a partial owner is never rebuilt as a complete value. */
export const read = (
  self: NativeOwnedPlace,
  context: NativeArith.LaneContext,
  read: (ordinal: number) => Value.Input,
  tag: string,
  ordinals: ReadonlyArray<number> = self.slots.map((_, ordinal) => ordinal),
): ReadonlyArray<Value.Input> => {
  const selected: Array<Value.Input> = []
  for (const ordinal of ordinals) {
    const slot = self.slots.at(ordinal)
    if (slot === undefined) throw new RangeError('Owned place lost a selected lane')
    const value = read(slot)
    const source = self.source.lanes.at(slot)
    const target = self.target.lanes.at(ordinal)
    if (value === undefined || source === undefined || target === undefined)
      throw new RangeError('Owned place lost a verified physical lane')
    selected.push(NativeArith.coerceLane(context, value, source, target, `${tag}_${ordinal}`))
  }
  return selected
}

/** Commits selected lanes into original storage, preserving every initialized sibling and tag. */
export const write = (
  self: NativeOwnedPlace,
  context: NativeArith.LaneContext,
  read: (ordinal: number) => Value.Input,
  write: (ordinal: number, value: Value.Input) => void,
  tag: string,
): void => {
  for (const [ordinal, slot] of self.slots.entries()) {
    const value = read(ordinal)
    const target = self.source.lanes.at(slot)
    const source = self.target.lanes.at(ordinal)
    if (value === undefined || source === undefined || target === undefined)
      throw new RangeError('Owned place write lost a verified physical lane')
    const stored = NativeArith.coerceLane(context, value, source, target, `${tag}_${ordinal}`)
    write(slot, stored)
  }
}
