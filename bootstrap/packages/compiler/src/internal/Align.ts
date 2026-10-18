/** Rounds an offset up to the nearest multiple of the given alignment. */
export const alignUp = (offset: number, alignment: number): number =>
  Math.ceil(offset / alignment) * alignment
