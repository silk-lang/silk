/**
 * Turns the module-relative byte offset the documentation JSON carries into a line an author can
 * open.
 *
 * The JSON deliberately carries neither line numbers nor absolute paths, so this is where the two
 * are recovered. Which bytes belong to a source identity is the caller's policy, not this module's:
 * the standard library answers from the compiler's shipped manifest and a project answers from its
 * own source root, and neither answer is baked in here.
 */

/** Supplies the exact bytes of one source identity, or nothing when it cannot be found. */
export type Lookup = (sourceId: string) => Uint8Array | undefined

/** A lookup that finds nothing. Positions are reported as unavailable rather than guessed. */
export const empty: Lookup = () => undefined

/** Composes lookups, taking the first that answers. */
export const firstOf =
  (...lookups: ReadonlyArray<Lookup>): Lookup =>
  (sourceId) => {
    for (const lookup of lookups) {
      const bytes = lookup(sourceId)
      if (bytes !== undefined) return bytes
    }
    return undefined
  }

const lineFeed = 0x0a

/**
 * Counts newlines before one byte offset, giving a one-based line.
 *
 * An offset past the end of the source counts the whole source rather than failing: a stale offset
 * should still name the file it came from instead of losing the report.
 */
export const lineAt = (bytes: Uint8Array, offset: number): number => {
  const limit = Math.max(0, Math.min(offset, bytes.length))
  let line = 1
  for (let index = 0; index < limit; index += 1) if (bytes[index] === lineFeed) line += 1
  return line
}

/** Resolves one source identity to a one-based line, or nothing when its bytes are unavailable. */
export const lineOf = (lookup: Lookup, sourceId: string, offset: number): number | undefined => {
  const bytes = lookup(sourceId)
  return bytes === undefined ? undefined : lineAt(bytes, offset)
}
