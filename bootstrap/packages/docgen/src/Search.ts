import * as Html from './Html.js'
import * as Model from './Model.js'

/**
 * The static search index, and the matcher the rendered pages run over it.
 *
 * The index is data, not a search engine: each entry names a declaration and where to find it, and
 * the ranking lives in `query` below. A prebuilt inverted index or a scoring model would freeze a
 * retrieval decision into a build artifact that the site cannot change without regenerating every
 * page, and at roughly a thousand declarations a linear scan in the browser is not the bottleneck.
 *
 * `query` is also the function the pages themselves run — `script` serializes this exact function
 * into the page rather than restating it — so a test that exercises the matcher is exercising what
 * the site does, not a copy of it that can drift.
 */

export interface Entry {
  readonly name: string
  readonly module: string
  readonly kind: string
  readonly signature: string
  /** The page location that shows this declaration, relative to the site root. */
  readonly href: string
  /** A one-line summary drawn from the declaration's documentation. */
  readonly summary: string
}

/** Where one declaration is shown, as the site's own layout decided. */
export interface Location {
  readonly module: string
  readonly href: string
}

/**
 * Ranks entries against a query.
 *
 * Exact name beats prefix beats substring beats a match found only in the summary, and ties keep
 * the index's own order, so results are stable rather than dependent on a sort's stability.
 */
const rankEntry = (entry: Entry, needle: string): number => {
  const name = entry.name.toLowerCase()
  if (name === needle) return 0
  if (name.startsWith(needle)) return 1
  if (name.includes(needle)) return 2
  if (entry.module.toLowerCase().includes(needle)) return 3
  if (entry.summary.toLowerCase().includes(needle)) return 4
  return -1
}

export const query = (
  entries: ReadonlyArray<Entry>,
  text: string,
  limit = 50,
): ReadonlyArray<Entry> => {
  const needle = text.trim().toLowerCase()
  if (needle === '') return []
  const ranked: Array<{ rank: number; index: number; entry: Entry }> = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === undefined) continue
    const rank = rankEntry(entry, needle)
    if (rank >= 0) ranked.push({ rank, index, entry })
  }
  ranked.sort((left, right) => left.rank - right.rank || left.index - right.index)
  return ranked.slice(0, limit).map((scored) => scored.entry)
}

const entryOf = (
  module: Model.Module,
  item: Model.Item,
  locate: (item: Model.Item) => string,
): Entry =>
  Object.freeze({
    name: item.name,
    module: module.name,
    kind: item.kind,
    signature: item.signature,
    href: locate(item),
    summary: Model.summary(item.documentation),
  })

/**
 * Kinds that are part of a signature rather than a name a reader looks up.
 *
 * A parameter is read on the declaration that owns it and is never searched for on its own, and the
 * standard library alone has 1775 of them against 1351 everything else — indexing them would more
 * than double what every page downloads to find worse results.
 */
const unsearchable: ReadonlySet<string> = new Set(['Parameter', 'TypeParameter'])

/**
 * Builds the index from declaration names and documentation text.
 *
 * Nested children are indexed too, minus the kinds above: a struct field and a service operation are
 * names a reader searches for, and each is exactly as findable in the JSON as its parent.
 */
export const build = (
  documentation: Model.Documentation,
  locate: (module: Model.Module, item: Model.Item) => string,
): ReadonlyArray<Entry> => {
  const entries: Array<Entry> = []
  const walk = (module: Model.Module, items: ReadonlyArray<Model.Item>): void => {
    for (const item of items) {
      if (item.name !== '' && !unsearchable.has(item.kind))
        entries.push(entryOf(module, item, (value) => locate(module, value)))
      walk(module, item.children)
    }
  }
  for (const module of documentation.modules) walk(module, module.items)
  return Object.freeze(entries)
}

/** The global the index file assigns, and the pages read. */
export const globalName = '__silkDocumentationIndex'

/**
 * The index file.
 *
 * It is JavaScript rather than JSON so the site works when its pages are opened straight off disk:
 * a hosted site is explicitly out of scope here, `fetch` refuses a `file://` URL, and a search that
 * only works behind a server is not a search this site can promise. The payload is still one JSON
 * literal, so anything that wants the raw data can read it.
 */
export const indexFile = (entries: ReadonlyArray<Entry>): Html.File =>
  Html.file('search-index.js', `globalThis.${globalName} = ${Html.json(entries)}\n`)

/**
 * The page's search behavior, built around this module's own `query`.
 *
 * Serializing the function keeps one implementation. A hand-written copy in a template string would
 * be a second matcher that no test covers, which is how a search box silently stops agreeing with
 * the thing that was verified.
 */
export const script = (): string => `
const silkQuery = ${query.toString()}
const silkEntries = globalThis.${globalName} ?? []
const silkField = document.querySelector('[data-search-field]')
const silkResults = document.querySelector('[data-search-results]')
if (silkField && silkResults) {
  silkField.addEventListener('input', () => {
    const found = silkQuery(silkEntries, silkField.value, 20)
    if (silkField.value.trim() === '') {
      silkResults.hidden = true
      silkResults.replaceChildren()
      return
    }
    silkResults.hidden = false
    silkResults.replaceChildren(
      ...(found.length === 0
        ? [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No declaration matches.' })]
        : found.map((entry) => {
            const item = document.createElement('li')
            const link = document.createElement('a')
            link.href = entry.href
            link.textContent = entry.name
            const where = document.createElement('span')
            where.className = 'where'
            where.textContent = entry.module
            item.append(link, where)
            return item
          })),
    )
  })
}
`
