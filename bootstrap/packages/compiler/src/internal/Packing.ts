import { alignUp } from './Align.js'

/** Physical placement shared by every aggregate and hidden-environment field. */
export interface PlacedField {
  readonly offset: number
  readonly size: number
  readonly alignment: number
  readonly padding: number
}

export interface Input<A> {
  readonly value: A
  readonly size: number
  readonly alignment: number
}

export interface Field<A> extends PlacedField {
  readonly value: A
}

export interface Packed<A> {
  readonly fields: ReadonlyArray<Field<A>>
  readonly size: number
  readonly alignment: number
  readonly tailPadding: number
}

/** Places fields once using the target ABI's ordinary aligned aggregate rule. */
export const pack = <A>(fields: ReadonlyArray<Input<A>>): Packed<A> => {
  let cursor = 0
  let alignment = 1
  const placed = fields.map((field) => {
    const offset = alignUp(cursor, field.alignment)
    const result = {
      value: field.value,
      offset,
      size: field.size,
      alignment: field.alignment,
      padding: offset - cursor,
    }
    cursor = offset + field.size
    alignment = Math.max(alignment, field.alignment)
    return result
  })
  const size = alignUp(cursor, alignment)
  return {
    fields: placed,
    size,
    alignment,
    tailPadding: size - cursor,
  }
}
