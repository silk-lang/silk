import * as Analysis from '@silklang/compiler/Analysis'
import type * as Document from './Document.js'
import type * as Project from './Project.js'

export type Code =
  | 'MissingDocumentation'
  | 'MissingSummary'
  | 'SummaryShape'
  | 'SummaryTooLong'
  | 'UnknownSection'
  | 'DuplicateSection'
  | 'EmptySection'
  | 'SectionOrder'
  | 'ParameterPlacement'
  | 'ExamplePlacement'
  | 'ExampleTitle'
  | 'FenceAttributes'
  | 'UnresolvedLink'

/** One maintained-documentation policy failure. */
export interface Violation {
  readonly code: Code
  readonly identity: string
  readonly message: string
  readonly source: Document.SourceRange
}

const sectionNames = ['When to use', 'Details', 'Gotchas', 'Examples', 'See also'] as const
const sectionOrder: ReadonlyMap<string, number> = new Map(
  sectionNames.map((name, index) => [name, index]),
)

const decoder = new TextDecoder()

const exhaustiveInline = (value: never): never => {
  throw new RangeError(`Unknown documentation inline node: ${String(value)}`)
}

const plainInline = (values: ReadonlyArray<Document.Inline>): string =>
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
          return ' '
      }
      return exhaustiveInline(value)
    })
    .join('')

const violation = (
  code: Code,
  identity: string,
  source: Document.SourceRange,
  message: string,
): Violation => Object.freeze({ code, identity, source, message })

const itemIds = (items: ReadonlyArray<Project.Item>): ReadonlyArray<string> =>
  items.flatMap((item) => [item.id, ...itemIds(item.children)])

const includedTargets = (project: Project.Project): ReadonlySet<string> =>
  new Set(project.modules.flatMap((module) => itemIds(module.items)))

const visitInline = (
  value: Document.Inline,
  identity: string,
  targets: ReadonlySet<string>,
  result: Array<Violation>,
): void => {
  switch (value._tag) {
    case 'SymbolLink':
      if (value.target === undefined || !targets.has(value.target.id))
        result.push(
          violation(
            'UnresolvedLink',
            identity,
            value.source,
            `Documentation link [\`${value.spelling}\`] does not resolve to an included public declaration.`,
          ),
        )
      return
    case 'Emphasis':
    case 'Strong':
    case 'Link':
      for (const child of value.children) visitInline(child, identity, targets, result)
      return
    case 'Text':
    case 'InlineCode':
    case 'Break':
      return
  }
}

const visitLinks = (
  block: Document.Block,
  identity: string,
  targets: ReadonlySet<string>,
  result: Array<Violation>,
): void => {
  switch (block._tag) {
    case 'Paragraph':
    case 'Heading':
      for (const child of block.children) visitInline(child, identity, targets, result)
      return
    case 'BlockQuote':
      for (const child of block.children) visitLinks(child, identity, targets, result)
      return
    case 'List':
      for (const item of block.items)
        for (const child of item) visitLinks(child, identity, targets, result)
      return
    case 'CodeBlock':
    case 'ThematicBreak':
      return
  }
}

const fenceInfo = (
  snapshot: Analysis.FrontendSnapshot,
  module: Project.Module,
  block: Extract<Document.Block, { readonly _tag: 'CodeBlock' }>,
): string | undefined => {
  const source = snapshot.closure.sources.get(module.name)
  if (source === undefined || source.id !== block.source.sourceId) return block.language
  const authored = decoder.decode(source.bytes.slice(block.source.start, block.source.end))
  const match = /(`{3,}|~{3,})([^\r\n]*)/.exec(authored)
  return match?.[2]?.trim() ?? block.language
}

const validateExamples = (
  snapshot: Analysis.FrontendSnapshot,
  module: Project.Module,
  identity: string,
  documentation: Document.Document,
  result: Array<Violation>,
): void => {
  let section: string | undefined
  let title: string | undefined
  const titles = new Set<string>()
  const usedTitles = new Set<string>()
  for (const block of documentation.blocks) {
    if (block._tag === 'Heading') {
      const text = plainInline(block.children).trim()
      if (block.depth === 1) {
        section = text
        title = undefined
      } else if (block.depth === 2 && section === 'Examples') {
        title = text
        if (text.length === 0 || titles.has(text))
          result.push(
            violation(
              'ExampleTitle',
              identity,
              block.source,
              text.length === 0
                ? 'Every example needs a non-empty scenario title.'
                : `Example title “${text}” is duplicated in this document.`,
            ),
          )
        titles.add(text)
      }
      continue
    }
    if (block._tag !== 'CodeBlock') continue
    const info = fenceInfo(snapshot, module, block)
    const language = info?.split(/[\s,]/, 1).at(0)?.toLocaleLowerCase()
    if (language !== 'silk') continue
    if (info !== 'silk' && info !== 'silk,ignore')
      result.push(
        violation(
          'FenceAttributes',
          identity,
          block.source,
          `Silk fence attributes must be exactly \`silk\` or \`silk,ignore\`; found \`${info}\`.`,
        ),
      )
    if (section !== 'Examples' || !block.example)
      result.push(
        violation(
          'ExamplePlacement',
          identity,
          block.source,
          'A Silk example must appear below the Examples section.',
        ),
      )
    if (title === undefined || title.length === 0 || usedTitles.has(title))
      result.push(
        violation(
          'ExampleTitle',
          identity,
          block.source,
          title === undefined || title.length === 0
            ? 'A Silk example must follow a distinct level-two scenario title.'
            : `Scenario “${title}” already owns another Silk example.`,
        ),
      )
    else usedTitles.add(title)
  }
}

const validateSections = (
  identity: string,
  documentation: Document.Document,
  result: Array<Violation>,
): void => {
  const firstHeading = documentation.blocks.findIndex((block) => block._tag === 'Heading')
  const summaryBlocks = documentation.blocks.slice(
    0,
    firstHeading === -1 ? documentation.blocks.length : firstHeading,
  )
  const summary = summaryBlocks.at(0)
  if (
    summary?._tag !== 'Paragraph' ||
    plainInline(summary.children).replace(/\s+/g, ' ').trim().length === 0
  )
    result.push(
      violation(
        'MissingSummary',
        identity,
        documentation.source,
        'Documentation must begin with one non-empty summary paragraph.',
      ),
    )
  else {
    const text = plainInline(summary.children).replace(/\s+/g, ' ').trim()
    if (text.length > 200)
      result.push(
        violation(
          'SummaryTooLong',
          identity,
          summary.source,
          `The summary is ${text.length} characters; keep it at or below 200.`,
        ),
      )
  }
  if (summaryBlocks.length !== 1)
    result.push(
      violation(
        'SummaryShape',
        identity,
        summaryBlocks.at(1)?.source ?? documentation.source,
        'Documentation must contain exactly one summary paragraph before its first section.',
      ),
    )

  const sections: Array<{
    readonly name: string
    readonly index: number
    readonly source: Document.SourceRange
  }> = []
  for (const [index, block] of documentation.blocks.entries()) {
    if (block._tag !== 'Heading') continue
    const name = plainInline(block.children).trim()
    if (block.depth === 1) sections.push({ name, index, source: block.source })
    else if (!(block.depth === 2 && sections.at(-1)?.name === 'Examples'))
      result.push(
        violation(
          'UnknownSection',
          identity,
          block.source,
          'Only level-one teaching sections and level-two example titles are supported.',
        ),
      )
  }
  const seen = new Set<string>()
  let previous = -1
  for (const [sectionIndex, section] of sections.entries()) {
    const order = sectionOrder.get(section.name)
    if (order === undefined)
      result.push(
        violation(
          'UnknownSection',
          identity,
          section.source,
          `Unknown documentation section “${section.name}”.`,
        ),
      )
    else {
      if (seen.has(section.name))
        result.push(
          violation(
            'DuplicateSection',
            identity,
            section.source,
            `Documentation section “${section.name}” appears more than once.`,
          ),
        )
      if (order < previous)
        result.push(
          violation(
            'SectionOrder',
            identity,
            section.source,
            `Documentation section “${section.name}” is out of teaching order.`,
          ),
        )
      seen.add(section.name)
      previous = Math.max(previous, order)
    }
    const next = sections[sectionIndex + 1]?.index ?? documentation.blocks.length
    if (next === section.index + 1)
      result.push(
        violation(
          'EmptySection',
          identity,
          section.source,
          `Documentation section “${section.name}” is empty.`,
        ),
      )
  }
}

const validateDocument = (
  snapshot: Analysis.FrontendSnapshot,
  module: Project.Module,
  identity: string,
  documentation: Document.Document,
  targets: ReadonlySet<string>,
  result: Array<Violation>,
): void => {
  validateSections(identity, documentation, result)
  if (/(?:^|\n)\s*(?:@param\b|parameters?\s*:)/i.test(documentation.markdown))
    result.push(
      violation(
        'ParameterPlacement',
        identity,
        documentation.source,
        'Parameter contracts belong on the parameter declaration, not in the owning document.',
      ),
    )
  validateExamples(snapshot, module, identity, documentation, result)
  for (const block of documentation.blocks) visitLinks(block, identity, targets, result)
}

const needsDocumentation = (item: Project.Item, parent: Project.Item | undefined): boolean =>
  item.visibility === 'Public' ||
  (item.kind === 'Operation' && (parent?.kind === 'Service' || parent?.kind === 'Interface'))

const visitItem = (
  snapshot: Analysis.FrontendSnapshot,
  module: Project.Module,
  item: Project.Item,
  parent: Project.Item | undefined,
  targets: ReadonlySet<string>,
  result: Array<Violation>,
): void => {
  if (item.visibility === 'Private') return
  if (needsDocumentation(item, parent) && item.documentation === undefined)
    result.push(
      violation(
        'MissingDocumentation',
        item.id,
        item.source,
        `${item.kind} ${item.id} requires a standalone semantic summary.`,
      ),
    )
  if (item.documentation !== undefined)
    validateDocument(snapshot, module, item.id, item.documentation, targets, result)
  for (const child of item.children) visitItem(snapshot, module, child, item, targets, result)
}

/** Checks one maintained module without adding failures to ordinary compiler diagnostics. */
export const check = (
  module: Project.Module,
  snapshot: Analysis.FrontendSnapshot,
  project: Project.Project,
): ReadonlyArray<Violation> => {
  const result: Array<Violation> = []
  const targets = includedTargets(project)
  if (module.documentation === undefined)
    result.push(
      violation(
        'MissingDocumentation',
        module.name,
        Object.freeze({ sourceId: module.sourceId, start: 0, end: 0 }),
        `Module ${module.name} requires leading module documentation.`,
      ),
    )
  else validateDocument(snapshot, module, module.name, module.documentation, targets, result)
  for (const item of module.items) visitItem(snapshot, module, item, undefined, targets, result)
  return Object.freeze(result)
}
