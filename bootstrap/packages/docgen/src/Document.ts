import type * as CompilerDocBlock from '@silklang/compiler/DocBlock'
import type * as SourceFile from '@silklang/compiler/SourceFile'
import * as Result from 'effect/Result'
import type {
  BlockContent,
  ListItem as MarkdownListItem,
  PhrasingContent,
  RootContent,
} from 'mdast'
import * as CommonMark from './internal/CommonMark.js'

/** A JSON-safe half-open byte range in the original Silk source. */
export interface SourceRange {
  readonly sourceId: string
  readonly start: number
  readonly end: number
}

/** A declaration target resolved from a Rust-style intra-documentation link. */
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

/** A package-owned, formatter-neutral documentation tree. */
export interface Document {
  readonly _tag: 'Document'
  readonly source: SourceRange
  readonly markdown: string
  readonly blocks: ReadonlyArray<Block>
  readonly examples: ReadonlyArray<Example>
  readonly fallback: boolean
}

const sourceRange = (
  block: CompilerDocBlock.DocBlock,
  normalized: CommonMark.Normalized,
  position: RootContent['position'],
): SourceRange => CommonMark.sourceRange(block, normalized, position)

const splitSymbolLinks = (value: string, source: SourceRange): ReadonlyArray<Inline> => {
  const result: Array<Inline> = []
  const pattern = /\[`([^`\]\r\n]+)`\]/g
  let offset = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index
    const spelling = match[1]
    if (index > offset)
      result.push(Object.freeze({ _tag: 'Text', value: value.slice(offset, index), source }))
    if (spelling !== undefined) result.push(Object.freeze({ _tag: 'SymbolLink', spelling, source }))
    offset = index + match[0].length
  }
  if (offset < value.length)
    result.push(Object.freeze({ _tag: 'Text', value: value.slice(offset), source }))
  return Object.freeze(result)
}

const inlineChildren = (
  nodes: ReadonlyArray<PhrasingContent>,
  block: CompilerDocBlock.DocBlock,
  normalized: CommonMark.Normalized,
): ReadonlyArray<Inline> => {
  const raw = nodes.flatMap((node) => inline(node, block, normalized))
  const result: Array<Inline> = []
  let index = 0
  while (index < raw.length) {
    const before = result.at(-1)
    const code = raw[index]
    const after = raw[index + 1]
    if (
      before?._tag === 'Text' &&
      before.value.endsWith('[') &&
      code?._tag === 'InlineCode' &&
      after?._tag === 'Text' &&
      after.value.startsWith(']')
    ) {
      result.pop()
      result.push(...splitSymbolLinks(before.value.slice(0, -1), before.source))
      result.push(
        Object.freeze({
          _tag: 'SymbolLink',
          spelling: code.value,
          source: Object.freeze({
            sourceId: code.source.sourceId,
            start: Math.min(before.source.end, code.source.start),
            end: Math.max(code.source.end, after.source.start),
          }),
        }),
      )
      result.push(...splitSymbolLinks(after.value.slice(1), after.source))
      index += 2
      continue
    }
    if (code !== undefined) result.push(code)
    index += 1
  }
  return Object.freeze(result)
}

const inline = (
  node: PhrasingContent,
  block: CompilerDocBlock.DocBlock,
  normalized: CommonMark.Normalized,
): ReadonlyArray<Inline> => {
  const source = sourceRange(block, normalized, node.position)
  switch (node.type) {
    case 'text':
      return splitSymbolLinks(node.value, source)
    case 'inlineCode':
      return Object.freeze([Object.freeze({ _tag: 'InlineCode', value: node.value, source })])
    case 'emphasis':
      return Object.freeze([
        Object.freeze({
          _tag: 'Emphasis',
          children: inlineChildren(node.children, block, normalized),
          source,
        }),
      ])
    case 'strong':
      return Object.freeze([
        Object.freeze({
          _tag: 'Strong',
          children: inlineChildren(node.children, block, normalized),
          source,
        }),
      ])
    case 'link': {
      const title = node.title ?? undefined
      return Object.freeze([
        Object.freeze({
          _tag: 'Link',
          destination: node.url,
          ...(title === undefined ? {} : { title }),
          children: inlineChildren(node.children, block, normalized),
          source,
        }),
      ])
    }
    case 'linkReference':
      if (
        node.children.length === 1 &&
        node.children[0]?.type === 'inlineCode' &&
        node.children[0].value === node.identifier
      )
        return Object.freeze([
          Object.freeze({ _tag: 'SymbolLink', spelling: node.identifier, source }),
        ])
      return inlineChildren(node.children, block, normalized)
    case 'image': {
      const title = node.title ?? undefined
      const children: ReadonlyArray<Inline> = Object.freeze([
        Object.freeze({ _tag: 'Text', value: node.alt ?? '', source }),
      ])
      return Object.freeze([
        Object.freeze({
          _tag: 'Link',
          destination: node.url,
          ...(title === undefined ? {} : { title }),
          children,
          source,
        }),
      ])
    }
    case 'imageReference':
      return Object.freeze([{ _tag: 'Text', value: node.alt ?? '', source }])
    case 'break':
      return Object.freeze([Object.freeze({ _tag: 'Break', source })])
    case 'html':
      return Object.freeze([{ _tag: 'Text', value: node.value, source }])
    case 'delete':
      return inlineChildren(node.children, block, normalized)
    default:
      return Object.freeze([])
  }
}

const listItem = (
  node: MarkdownListItem,
  block: CompilerDocBlock.DocBlock,
  normalized: CommonMark.Normalized,
): ReadonlyArray<Block> =>
  Object.freeze(node.children.flatMap((child) => blocks(child, block, normalized)))

const blocks = (
  node: RootContent | BlockContent,
  block: CompilerDocBlock.DocBlock,
  normalized: CommonMark.Normalized,
): ReadonlyArray<Block> => {
  const source = sourceRange(block, normalized, node.position)
  switch (node.type) {
    case 'paragraph':
      return Object.freeze([
        Object.freeze({
          _tag: 'Paragraph',
          children: inlineChildren(node.children, block, normalized),
          source,
        }),
      ])
    case 'heading':
      return Object.freeze([
        Object.freeze({
          _tag: 'Heading',
          depth: node.depth,
          children: inlineChildren(node.children, block, normalized),
          source,
        }),
      ])
    case 'code': {
      const language = node.lang ?? undefined
      return Object.freeze([
        Object.freeze({
          _tag: 'CodeBlock',
          ...(language === undefined ? {} : { language }),
          value: node.value,
          example: false,
          source,
        }),
      ])
    }
    case 'blockquote':
      return Object.freeze([
        Object.freeze({
          _tag: 'BlockQuote',
          children: Object.freeze(
            node.children.flatMap((child) => blocks(child, block, normalized)),
          ),
          source,
        }),
      ])
    case 'list':
      return Object.freeze([
        Object.freeze({
          _tag: 'List',
          ordered: node.ordered ?? false,
          ...(node.start === null || node.start === undefined ? {} : { start: node.start }),
          items: Object.freeze(node.children.map((item) => listItem(item, block, normalized))),
          source,
        }),
      ])
    case 'thematicBreak':
      return Object.freeze([Object.freeze({ _tag: 'ThematicBreak', source })])
    case 'html':
      return Object.freeze([
        Object.freeze({
          _tag: 'Paragraph',
          children: Object.freeze<ReadonlyArray<Inline>>([
            Object.freeze({ _tag: 'Text', value: node.value, source }),
          ]),
          source,
        }),
      ])
    case 'definition':
      return Object.freeze([])
    default: {
      const children: ReadonlyArray<Inline> = Object.freeze([
        Object.freeze({ _tag: 'Text', value: normalized.markdown, source }),
      ])
      return Object.freeze([
        Object.freeze({
          _tag: 'Paragraph',
          children,
          source,
        }),
      ])
    }
  }
}

const plainInline = (values: ReadonlyArray<Inline>): string =>
  values
    .map((value) => {
      switch (value._tag) {
        case 'Text':
        case 'InlineCode':
          return value.value
        case 'SymbolLink':
          return value.spelling
        case 'Emphasis':
        case 'Strong':
        case 'Link':
          return plainInline(value.children)
        case 'Break':
          return '\n'
      }
      return exhaustiveInline(value)
    })
    .join('')

const markExamples = (input: ReadonlyArray<Block>): ReadonlyArray<Block> => {
  const result: Array<Block> = []
  let examplesDepth: number | undefined
  for (const block of input) {
    if (block._tag === 'Heading') {
      if (examplesDepth !== undefined && block.depth <= examplesDepth) examplesDepth = undefined
      if (plainInline(block.children).trim().toLocaleLowerCase() === 'examples')
        examplesDepth = block.depth
      result.push(block)
    } else if (block._tag === 'CodeBlock' && examplesDepth !== undefined)
      result.push(Object.freeze({ ...block, example: true }))
    else result.push(block)
  }
  return Object.freeze(result)
}

const fallback = (
  block: CompilerDocBlock.DocBlock,
  normalized: CommonMark.Normalized,
): Document => {
  const source = Object.freeze({
    sourceId: block.span.sourceId,
    start: block.span.start,
    end: block.span.end,
  })
  const text: Inline = Object.freeze({ _tag: 'Text', value: normalized.markdown, source })
  const paragraph: Block = Object.freeze({
    _tag: 'Paragraph',
    children: Object.freeze([text]),
    source,
  })
  return Object.freeze({
    _tag: 'Document',
    source,
    markdown: normalized.markdown,
    blocks: Object.freeze([paragraph]),
    examples: Object.freeze([]),
    fallback: true,
  })
}

/**
 * Interprets one raw compiler-owned documentation block. Markdown parser failures are deliberately
 * converted into a plain-text document because documentation must never fail compilation or tools.
 */
export const parse = (
  sourceFile: SourceFile.SourceFile,
  block: CompilerDocBlock.DocBlock,
): Document => {
  const normalizedResult = CommonMark.normalize(sourceFile, block)
  if (Result.isFailure(normalizedResult)) {
    const normalized: CommonMark.Normalized = Object.freeze({
      markdown: '',
      offsets: Object.freeze([]),
      lines: Object.freeze([]),
    })
    return fallback(block, normalized)
  }
  const normalized = normalizedResult.success
  const rootResult = CommonMark.parse(normalized)
  if (Result.isSuccess(rootResult)) {
    const root = rootResult.success
    const parsed = markExamples(
      Object.freeze(root.children.flatMap((child) => blocks(child, block, normalized))),
    )
    const examples = parsed.flatMap((value): ReadonlyArray<Example> =>
      value._tag === 'CodeBlock' && value.example
        ? [
            Object.freeze({
              ...(value.language === undefined ? {} : { language: value.language }),
              code: value.value,
              source: value.source,
            }),
          ]
        : [],
    )
    return Object.freeze({
      _tag: 'Document',
      source: Object.freeze({
        sourceId: block.span.sourceId,
        start: block.span.start,
        end: block.span.end,
      }),
      markdown: normalized.markdown,
      blocks: parsed,
      examples: Object.freeze(examples),
      fallback: false,
    })
  }
  return fallback(block, normalized)
}

export type Resolver = (spelling: string) => LinkTarget | undefined

const resolveInline = (value: Inline, resolver: Resolver): Inline => {
  switch (value._tag) {
    case 'SymbolLink': {
      const target = resolver(value.spelling)
      return target === undefined
        ? value
        : Object.freeze({ ...value, target: Object.freeze(target) })
    }
    case 'Emphasis':
    case 'Strong':
    case 'Link':
      return Object.freeze({
        ...value,
        children: Object.freeze(value.children.map((child) => resolveInline(child, resolver))),
      })
    default:
      return value
  }
}

const resolveBlock = (value: Block, resolver: Resolver): Block => {
  switch (value._tag) {
    case 'Paragraph':
    case 'Heading':
      return Object.freeze({
        ...value,
        children: Object.freeze(value.children.map((child) => resolveInline(child, resolver))),
      })
    case 'BlockQuote':
      return Object.freeze({
        ...value,
        children: Object.freeze(value.children.map((child) => resolveBlock(child, resolver))),
      })
    case 'List':
      return Object.freeze({
        ...value,
        items: Object.freeze(
          value.items.map((item) =>
            Object.freeze(item.map((child) => resolveBlock(child, resolver))),
          ),
        ),
      })
    default:
      return value
  }
}

/** Resolves best-effort symbol links while preserving unresolved links as inline code. */
export const resolve = (self: Document, resolver: Resolver): Document =>
  Object.freeze({
    ...self,
    blocks: Object.freeze(self.blocks.map((block) => resolveBlock(block, resolver))),
  })

const escapeText = (value: string): string =>
  value.replaceAll('\\', '\\\\').replace(/([`*_[\]<>])/g, '\\$1')

const exhaustiveInline = (value: never): never => {
  throw new RangeError(`Unknown documentation inline node: ${String(value)}`)
}

const inlineMarkdown = (values: ReadonlyArray<Inline>): string =>
  values
    .map((value) => {
      switch (value._tag) {
        case 'Text':
          return escapeText(value.value)
        case 'InlineCode':
          return `\`${value.value}\``
        case 'SymbolLink':
          return `\`${value.spelling}\``
        case 'Emphasis':
          return `*${inlineMarkdown(value.children)}*`
        case 'Strong':
          return `**${inlineMarkdown(value.children)}**`
        case 'Link':
          return `[${inlineMarkdown(value.children)}](${value.destination}${value.title === undefined ? '' : ` "${value.title}"`})`
        case 'Break':
          return '  \n'
      }
      return exhaustiveInline(value)
    })
    .join('')

const blockMarkdown = (value: Block): string => {
  switch (value._tag) {
    case 'Paragraph':
      return inlineMarkdown(value.children)
    case 'Heading':
      return `${'#'.repeat(value.depth)} ${inlineMarkdown(value.children)}`
    case 'CodeBlock':
      return `\`\`\`${value.language ?? ''}\n${value.value}\n\`\`\``
    case 'BlockQuote':
      return value.children
        .map(blockMarkdown)
        .join('\n\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'List':
      return value.items
        .map((item, index) => {
          const marker = value.ordered ? `${(value.start ?? 1) + index}.` : '-'
          return `${marker} ${item.map(blockMarkdown).join('\n\n').replaceAll('\n', '\n  ')}`
        })
        .join('\n')
    case 'ThematicBreak':
      return '---'
  }
}

/** Renders the owned model as Markdown suitable for editor hover content. */
export const toMarkdown = (self: Document): string => self.blocks.map(blockMarkdown).join('\n\n')

/** Remaps markdown `# {title}` to `***{title}***`, because headings look giant in doc comments on vscode */
export const toDocCommentMarkdown = (self: Document): string => {
  let result = toMarkdown(self)
  result = result.replaceAll(/^#+ (.+)$/gm, '***\n$1\n***')
  return result
}
