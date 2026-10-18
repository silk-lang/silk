/**
 * The small amount of HTML this renderer needs, and the escaping it owes every value it did not
 * write itself.
 *
 * Documentation text is author-controlled prose that reaches the renderer as data. It is written
 * into markup here, so escaping is not a nicety: a `///` comment mentioning a generic type reads
 * `Vector<T>`, and unescaped that opens an element.
 */

const escapes: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
])

/** Escapes text for element content and for a double-quoted attribute value alike. */
export const escapeText = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => escapes.get(character) ?? character)

/**
 * Serializes a value as JSON that is safe to embed in a `<script>` element.
 *
 * HTML escaping is wrong inside a script — the parser does not decode entities there — so the two
 * sequences that matter are neutralized instead: `</` could end the element early, and the Unicode
 * line separators terminate a JavaScript string literal though not a JSON one.
 */
export const json = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll('</', '<\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')

/**
 * Turns any identity into a file-name-safe slug.
 *
 * Slugs are not required to be unique on their own — `unique` below settles collisions in the
 * caller's order, so the same input always produces the same output.
 */
export const slug = (value: string): string => {
  const cleaned = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'item' : cleaned
}

/** Makes a slug unique against the ones already taken, deterministically and in order. */
export const unique = (taken: Set<string>, candidate: string): string => {
  if (!taken.has(candidate)) {
    taken.add(candidate)
    return candidate
  }
  for (let ordinal = 2; ; ordinal += 1) {
    const next = `${candidate}-${ordinal}`
    if (!taken.has(next)) {
      taken.add(next)
      return next
    }
  }
}

/** One rendered file of the site. */
export interface File {
  readonly path: string
  readonly contents: string
}

export const file = (path: string, contents: string): File => Object.freeze({ path, contents })
