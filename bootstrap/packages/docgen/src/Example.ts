/**
 * One fenced Silk example collected from documentation JSON, and the walk that finds them.
 *
 * Collection reads the documentation JSON structurally rather than through the emitter's own types,
 * so a value parsed from a file is exactly as acceptable as a value the emitter just built, and
 * neither is trusted to have the shape it claims. The walk descends block kinds it does not model
 * instead of refusing them, because the bootstrap schema is chartered as experimental: a fence
 * nested inside a construct added later is still found.
 */

/** A module-relative byte range, exactly as the documentation JSON carries it. */
export interface SourceRange {
  readonly sourceId: string
  readonly start: number
  readonly end: number
}

/** The declaration whose documentation carries an example, or the module itself. */
export interface Owner {
  readonly module: string
  /** Absent when the example belongs to the module document rather than to a declaration. */
  readonly declaration?: string
}

/** One fenced Silk block, with the fence attributes it declared and where it came from. */
export interface Example {
  readonly owner: Owner
  readonly code: string
  readonly source: SourceRange
  /** The fence's language token, verbatim, including any attributes. */
  readonly language: string
  readonly attributes: ReadonlyArray<string>
  /** True when the fence opted out of compilation. */
  readonly ignored: boolean
  /** Attributes the workflow does not define. A non-empty list fails the example. */
  readonly unknownAttributes: ReadonlyArray<string>
}

/** The language word that marks a fence as Silk. */
export const languageName = 'silk'

/** The one attribute a fence may carry today. */
export const ignoreAttribute = 'ignore'

const known: ReadonlySet<string> = new Set([ignoreAttribute])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const stringAt = (value: Record<string, unknown>, key: string): string | undefined =>
  typeof value[key] === 'string' ? value[key] : undefined

const rangeOf = (value: unknown): SourceRange | undefined => {
  if (!isRecord(value)) return undefined
  const sourceId = stringAt(value, 'sourceId')
  const { start, end } = value
  if (sourceId === undefined || typeof start !== 'number' || typeof end !== 'number')
    return undefined
  return Object.freeze({ sourceId, start, end })
}

/**
 * Splits a fence's language token into its language word and its attributes.
 *
 * Attributes are comma-delimited inside the token because that token is the only part of the info
 * string the documentation JSON records: CommonMark splits the info string on whitespace and the
 * documentation model keeps the first word, so a space-separated attribute never reaches here.
 */
export const parseLanguage = (
  language: string,
): { readonly name: string; readonly attributes: ReadonlyArray<string> } => {
  const parts = language.split(',').map((part) => part.trim())
  return Object.freeze({
    name: (parts.at(0) ?? '').toLocaleLowerCase(),
    attributes: Object.freeze(parts.slice(1).filter((part) => part !== '')),
  })
}

const exampleOf = (
  block: Record<string, unknown>,
  owner: Owner,
  fallback: string,
): Example | undefined => {
  const language = stringAt(block, 'language')
  if (language === undefined) return undefined
  const { name, attributes } = parseLanguage(language)
  if (name !== languageName) return undefined
  return Object.freeze({
    owner: Object.freeze(owner),
    code: stringAt(block, 'value') ?? '',
    source: rangeOf(block.source) ?? Object.freeze({ sourceId: fallback, start: 0, end: 0 }),
    language,
    attributes: Object.freeze(attributes),
    ignored: attributes.includes(ignoreAttribute),
    unknownAttributes: Object.freeze(attributes.filter((attribute) => !known.has(attribute))),
  })
}

/**
 * Descends one block, collecting fenced Silk examples. Unknown block tags are descended rather than
 * refused, so a fence nested inside a construct this walk does not model is still collected.
 */
const fromBlock = (value: unknown, owner: Owner, fallback: string): ReadonlyArray<Example> => {
  if (Array.isArray(value)) return value.flatMap((child) => fromBlock(child, owner, fallback))
  if (!isRecord(value)) return []
  const direct = exampleOf(value, owner, fallback)
  const nested = [
    ...fromBlock(value.children, owner, fallback),
    ...fromBlock(value.items, owner, fallback),
  ]
  return direct === undefined ? nested : [direct, ...nested]
}

const fromDocument = (value: unknown, owner: Owner, fallback: string): ReadonlyArray<Example> =>
  isRecord(value) ? fromBlock(value.blocks, owner, fallback) : []

const fromItem = (value: unknown, module: string, fallback: string): ReadonlyArray<Example> => {
  if (!isRecord(value)) return []
  const name = stringAt(value, 'name')
  const owner: Owner = name === undefined ? { module } : { module, declaration: name }
  const children = Array.isArray(value.children) ? value.children : []
  return [
    ...fromDocument(value.documentation, owner, fallback),
    ...children.flatMap((child) => fromItem(child, module, fallback)),
  ]
}

/**
 * Collects every fenced Silk example of one documentation value, in the value's own source order.
 *
 * The parameter is `unknown` on purpose: the same walk reads a value the emitter just built and a
 * value `JSON.parse` returned, and neither is trusted to have the shape it claims. A value that is
 * not documentation at all yields no examples, which is why an empty collection is a distinct run
 * outcome rather than a pass.
 */
export const collect = (documentation: unknown): ReadonlyArray<Example> => {
  if (!isRecord(documentation)) return []
  const modules = documentation.modules
  if (!Array.isArray(modules)) return []
  return Object.freeze(
    modules.flatMap((module): ReadonlyArray<Example> => {
      if (!isRecord(module)) return []
      const name = stringAt(module, 'name') ?? ''
      const sourceId = stringAt(module, 'sourceId') ?? name
      const items = Array.isArray(module.items) ? module.items : []
      return [
        ...fromDocument(module.documentation, { module: name }, sourceId),
        ...items.flatMap((item) => fromItem(item, name, sourceId)),
      ]
    }),
  )
}
