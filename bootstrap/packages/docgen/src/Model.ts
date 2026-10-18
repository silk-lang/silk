/**
 * The renderer's independent view of the current documentation JSON DTO.
 *
 * These shapes deliberately are not imported from the emitter. The decoder below is the package
 * boundary: it accepts exactly the current formatter-neutral JSON shape and rejects the whole
 * document when any required field, child, or tagged node is invalid.
 */

export interface SourceRange {
  readonly sourceId: string
  readonly start: number
  readonly end: number
}

export interface LinkTarget {
  readonly id: string
  readonly module: string
  readonly name: string
  readonly kind:
    | 'Function'
    | 'Struct'
    | 'Enum'
    | 'EnumMember'
    | 'Union'
    | 'UnionVariant'
    | 'Service'
    | 'Interface'
    | 'Constant'
    | 'Role'
    | 'Alias'
}

export type Inline =
  | { readonly _tag: 'Text'; readonly value: string; readonly source: SourceRange }
  | { readonly _tag: 'InlineCode'; readonly value: string; readonly source: SourceRange }
  | {
      readonly _tag: 'Emphasis'
      readonly children: ReadonlyArray<Inline>
      readonly source: SourceRange
    }
  | {
      readonly _tag: 'Strong'
      readonly children: ReadonlyArray<Inline>
      readonly source: SourceRange
    }
  | {
      readonly _tag: 'Link'
      readonly destination: string
      readonly title?: string
      readonly children: ReadonlyArray<Inline>
      readonly source: SourceRange
    }
  | {
      readonly _tag: 'SymbolLink'
      readonly spelling: string
      readonly target?: LinkTarget
      readonly source: SourceRange
    }
  | { readonly _tag: 'Break'; readonly source: SourceRange }

export type Block =
  | {
      readonly _tag: 'Paragraph'
      readonly children: ReadonlyArray<Inline>
      readonly source: SourceRange
    }
  | {
      readonly _tag: 'Heading'
      readonly depth: 1 | 2 | 3 | 4 | 5 | 6
      readonly children: ReadonlyArray<Inline>
      readonly source: SourceRange
    }
  | {
      readonly _tag: 'CodeBlock'
      readonly language?: string
      readonly value: string
      readonly example: boolean
      readonly source: SourceRange
    }
  | {
      readonly _tag: 'BlockQuote'
      readonly children: ReadonlyArray<Block>
      readonly source: SourceRange
    }
  | {
      readonly _tag: 'List'
      readonly ordered: boolean
      readonly start?: number
      readonly items: ReadonlyArray<ReadonlyArray<Block>>
      readonly source: SourceRange
    }
  | { readonly _tag: 'ThematicBreak'; readonly source: SourceRange }

export interface Example {
  readonly language?: string
  readonly code: string
  readonly source: SourceRange
}

export interface Document {
  readonly _tag: 'Document'
  readonly source: SourceRange
  readonly markdown: string
  readonly blocks: ReadonlyArray<Block>
  readonly examples: ReadonlyArray<Example>
  readonly fallback: boolean
}

export type ItemKind =
  | 'Function'
  | 'Struct'
  | 'Enum'
  | 'EnumMember'
  | 'Union'
  | 'UnionVariant'
  | 'Service'
  | 'Interface'
  | 'Constant'
  | 'Role'
  | 'Alias'
  | 'Parameter'
  | 'TypeParameter'
  | 'Field'
  | 'Implementation'
  | 'Operation'
  | 'Method'
  | 'AssociatedFunction'

export type Visibility = 'Public' | 'Private' | 'Inherited'

export interface Item {
  readonly id: string
  readonly kind: ItemKind
  readonly name: string
  readonly visibility: Visibility
  readonly signature: string
  readonly source: SourceRange
  readonly documentation?: Document
  readonly children: ReadonlyArray<Item>
}

export interface Module {
  readonly name: string
  readonly sourceId: string
  readonly documentation?: Document
  readonly items: ReadonlyArray<Item>
}

/** The marker the emitter writes so a consumer can tell this file from any other JSON. */
export const schemaName = 'silk-documentation'

export interface Documentation {
  readonly schema: typeof schemaName
  readonly experimental: true
  readonly profile?: { readonly identity: string; readonly target: string }
  readonly modules: ReadonlyArray<Module>
}

export type Decoded =
  | { readonly _tag: 'Decoded'; readonly documentation: Documentation }
  | { readonly _tag: 'NotDocumentation'; readonly message: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Object.keys(value).every((key) => keys.includes(key))

const arrayOf = <A>(
  value: unknown,
  decode: (value: unknown) => A | undefined,
): ReadonlyArray<A> | undefined => {
  if (!Array.isArray(value)) return undefined
  const decoded: Array<A> = []
  for (const element of value) {
    const item = decode(element)
    if (item === undefined) return undefined
    decoded.push(item)
  }
  return Object.freeze(decoded)
}

const optionalString = (
  value: Record<string, unknown>,
  key: string,
): { readonly present: false } | { readonly present: true; readonly value: string } | undefined => {
  if (!Object.hasOwn(value, key)) return Object.freeze({ present: false })
  const found = value[key]
  return typeof found === 'string' ? Object.freeze({ present: true, value: found }) : undefined
}

const rangeOf = (value: unknown): SourceRange | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sourceId', 'start', 'end'])) return undefined
  const { sourceId, start, end } = value
  return typeof sourceId === 'string' &&
    typeof start === 'number' &&
    Number.isSafeInteger(start) &&
    start >= 0 &&
    typeof end === 'number' &&
    Number.isSafeInteger(end) &&
    end >= start
    ? Object.freeze({ sourceId, start, end })
    : undefined
}

const linkKindOf = (value: unknown): LinkTarget['kind'] | undefined => {
  switch (value) {
    case 'Function':
    case 'Struct':
    case 'Enum':
    case 'EnumMember':
    case 'Union':
    case 'UnionVariant':
    case 'Service':
    case 'Interface':
    case 'Constant':
    case 'Role':
    case 'Alias':
      return value
    default:
      return undefined
  }
}

const linkTargetOf = (value: unknown): LinkTarget | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'module', 'name', 'kind'])) return undefined
  const { id, module, name } = value
  const kind = linkKindOf(value.kind)
  return typeof id === 'string' &&
    typeof module === 'string' &&
    typeof name === 'string' &&
    kind !== undefined
    ? Object.freeze({ id, module, name, kind })
    : undefined
}

const inlineOf = (value: unknown): Inline | undefined => {
  if (!isRecord(value)) return undefined
  const source = rangeOf(value.source)
  if (source === undefined) return undefined
  switch (value._tag) {
    case 'Text':
    case 'InlineCode':
      return hasOnlyKeys(value, ['_tag', 'value', 'source']) && typeof value.value === 'string'
        ? Object.freeze({ _tag: value._tag, value: value.value, source })
        : undefined
    case 'Emphasis':
    case 'Strong': {
      const children = arrayOf(value.children, inlineOf)
      return hasOnlyKeys(value, ['_tag', 'children', 'source']) && children !== undefined
        ? Object.freeze({ _tag: value._tag, children, source })
        : undefined
    }
    case 'Link': {
      const title = optionalString(value, 'title')
      const children = arrayOf(value.children, inlineOf)
      if (
        !hasOnlyKeys(value, ['_tag', 'destination', 'title', 'children', 'source']) ||
        typeof value.destination !== 'string' ||
        title === undefined ||
        children === undefined
      )
        return undefined
      return Object.freeze({
        _tag: 'Link',
        destination: value.destination,
        ...(title.present ? { title: title.value } : {}),
        children,
        source,
      })
    }
    case 'SymbolLink': {
      const hasTarget = Object.hasOwn(value, 'target')
      const target = hasTarget ? linkTargetOf(value.target) : undefined
      if (
        !hasOnlyKeys(value, ['_tag', 'spelling', 'target', 'source']) ||
        typeof value.spelling !== 'string' ||
        (hasTarget && target === undefined)
      )
        return undefined
      return Object.freeze({
        _tag: 'SymbolLink',
        spelling: value.spelling,
        ...(target === undefined ? {} : { target }),
        source,
      })
    }
    case 'Break':
      return hasOnlyKeys(value, ['_tag', 'source'])
        ? Object.freeze({ _tag: 'Break', source })
        : undefined
    default:
      return undefined
  }
}

const headingDepthOf = (value: unknown): 1 | 2 | 3 | 4 | 5 | 6 | undefined => {
  switch (value) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
      return value
    default:
      return undefined
  }
}

const blockOf = (value: unknown): Block | undefined => {
  if (!isRecord(value)) return undefined
  const source = rangeOf(value.source)
  if (source === undefined) return undefined
  switch (value._tag) {
    case 'Paragraph': {
      const children = arrayOf(value.children, inlineOf)
      return hasOnlyKeys(value, ['_tag', 'children', 'source']) && children !== undefined
        ? Object.freeze({ _tag: 'Paragraph', children, source })
        : undefined
    }
    case 'Heading': {
      const depth = headingDepthOf(value.depth)
      const children = arrayOf(value.children, inlineOf)
      return hasOnlyKeys(value, ['_tag', 'depth', 'children', 'source']) &&
        depth !== undefined &&
        children !== undefined
        ? Object.freeze({ _tag: 'Heading', depth, children, source })
        : undefined
    }
    case 'CodeBlock': {
      const language = optionalString(value, 'language')
      if (
        !hasOnlyKeys(value, ['_tag', 'language', 'value', 'example', 'source']) ||
        language === undefined ||
        typeof value.value !== 'string' ||
        typeof value.example !== 'boolean'
      )
        return undefined
      return Object.freeze({
        _tag: 'CodeBlock',
        ...(language.present ? { language: language.value } : {}),
        value: value.value,
        example: value.example,
        source,
      })
    }
    case 'BlockQuote': {
      const children = arrayOf(value.children, blockOf)
      return hasOnlyKeys(value, ['_tag', 'children', 'source']) && children !== undefined
        ? Object.freeze({ _tag: 'BlockQuote', children, source })
        : undefined
    }
    case 'List': {
      const start = Object.hasOwn(value, 'start') ? value.start : undefined
      const items = arrayOf(value.items, (item) => arrayOf(item, blockOf))
      if (
        !hasOnlyKeys(value, ['_tag', 'ordered', 'start', 'items', 'source']) ||
        typeof value.ordered !== 'boolean' ||
        (Object.hasOwn(value, 'start') &&
          (typeof start !== 'number' || !Number.isSafeInteger(start))) ||
        items === undefined
      )
        return undefined
      return Object.freeze({
        _tag: 'List',
        ordered: value.ordered,
        ...(typeof start === 'number' ? { start } : {}),
        items,
        source,
      })
    }
    case 'ThematicBreak':
      return hasOnlyKeys(value, ['_tag', 'source'])
        ? Object.freeze({ _tag: 'ThematicBreak', source })
        : undefined
    default:
      return undefined
  }
}

const exampleOf = (value: unknown): Example | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['language', 'code', 'source'])) return undefined
  const language = optionalString(value, 'language')
  const source = rangeOf(value.source)
  return language !== undefined && typeof value.code === 'string' && source !== undefined
    ? Object.freeze({
        ...(language.present ? { language: language.value } : {}),
        code: value.code,
        source,
      })
    : undefined
}

const documentOf = (value: unknown): Document | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['_tag', 'source', 'markdown', 'blocks', 'examples', 'fallback']) ||
    value._tag !== 'Document' ||
    typeof value.markdown !== 'string' ||
    typeof value.fallback !== 'boolean'
  )
    return undefined
  const source = rangeOf(value.source)
  const blocks = arrayOf(value.blocks, blockOf)
  const examples = arrayOf(value.examples, exampleOf)
  return source !== undefined && blocks !== undefined && examples !== undefined
    ? Object.freeze({
        _tag: 'Document',
        source,
        markdown: value.markdown,
        blocks,
        examples,
        fallback: value.fallback,
      })
    : undefined
}

const signatureOf = (value: unknown): string | undefined =>
  isRecord(value) && hasOnlyKeys(value, ['text']) && typeof value.text === 'string'
    ? value.text
    : undefined

const itemKindOf = (value: unknown): ItemKind | undefined => {
  switch (value) {
    case 'Function':
    case 'Struct':
    case 'Enum':
    case 'EnumMember':
    case 'Union':
    case 'UnionVariant':
    case 'Service':
    case 'Interface':
    case 'Constant':
    case 'Role':
    case 'Alias':
    case 'Parameter':
    case 'TypeParameter':
    case 'Field':
    case 'Implementation':
    case 'Operation':
    case 'Method':
    case 'AssociatedFunction':
      return value
    default:
      return undefined
  }
}

const visibilityOf = (value: unknown): Visibility | undefined => {
  switch (value) {
    case 'Public':
    case 'Private':
    case 'Inherited':
      return value
    default:
      return undefined
  }
}

const itemOf = (value: unknown): Item | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'id',
      'kind',
      'name',
      'visibility',
      'signature',
      'source',
      'documentation',
      'children',
    ]) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string'
  )
    return undefined
  const kind = itemKindOf(value.kind)
  const visibility = visibilityOf(value.visibility)
  const signature = signatureOf(value.signature)
  const source = rangeOf(value.source)
  const children = arrayOf(value.children, itemOf)
  const hasDocumentation = Object.hasOwn(value, 'documentation')
  const documentation = hasDocumentation ? documentOf(value.documentation) : undefined
  if (
    kind === undefined ||
    visibility === undefined ||
    signature === undefined ||
    source === undefined ||
    children === undefined ||
    (hasDocumentation && documentation === undefined)
  )
    return undefined
  return Object.freeze({
    id: value.id,
    kind,
    name: value.name,
    visibility,
    signature,
    source,
    ...(documentation === undefined ? {} : { documentation }),
    children,
  })
}

const moduleOf = (value: unknown): Module | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['name', 'sourceId', 'documentation', 'items']) ||
    typeof value.name !== 'string' ||
    typeof value.sourceId !== 'string'
  )
    return undefined
  const items = arrayOf(value.items, itemOf)
  const hasDocumentation = Object.hasOwn(value, 'documentation')
  const documentation = hasDocumentation ? documentOf(value.documentation) : undefined
  if (items === undefined || (hasDocumentation && documentation === undefined)) return undefined
  return Object.freeze({
    name: value.name,
    sourceId: value.sourceId,
    ...(documentation === undefined ? {} : { documentation }),
    items,
  })
}

/** Reads a parsed JSON value as exactly the current documentation DTO. */
export const decode = (value: unknown): Decoded => {
  if (!isRecord(value))
    return Object.freeze({
      _tag: 'NotDocumentation',
      message: 'expected a documentation JSON object',
    })
  if (value.schema !== schemaName)
    return Object.freeze({
      _tag: 'NotDocumentation',
      message: `expected a "${schemaName}" schema marker, found ${JSON.stringify(value.schema) ?? 'nothing'}`,
    })
  if (
    !hasOnlyKeys(value, ['schema', 'experimental', 'modules', 'profile']) ||
    value.experimental !== true
  )
    return Object.freeze({
      _tag: 'NotDocumentation',
      message: 'documentation JSON does not match the current schema',
    })
  const suppliedProfile = value.profile
  let profile: Documentation['profile']
  if (suppliedProfile !== undefined) {
    if (
      !isRecord(suppliedProfile) ||
      !hasOnlyKeys(suppliedProfile, ['identity', 'target']) ||
      typeof suppliedProfile.identity !== 'string' ||
      typeof suppliedProfile.target !== 'string'
    )
      return Object.freeze({ _tag: 'NotDocumentation', message: 'Invalid documentation profile' })
    profile = { identity: suppliedProfile.identity, target: suppliedProfile.target }
  }
  const modules = arrayOf(value.modules, moduleOf)
  return modules === undefined
    ? Object.freeze({
        _tag: 'NotDocumentation',
        message: 'documentation JSON does not match the current schema',
      })
    : Object.freeze({
        _tag: 'Decoded',
        documentation: Object.freeze({
          schema: schemaName,
          experimental: true,
          ...(profile === undefined
            ? {}
            : { profile: { identity: profile.identity, target: profile.target } }),
          modules,
        }),
      })
}

/** The first paragraph of a document, collapsed to one line. Used for listings and search. */
export const summary = (self: Document | undefined): string =>
  self === undefined
    ? ''
    : (self.markdown.trim().split('\n\n').at(0) ?? '').replace(/\s+/g, ' ').trim()
