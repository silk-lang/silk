import type * as Document from './Document.js'
import type * as Project from './Project.js'

export interface ManifestEntry {
  readonly module: string
  readonly namespace: string
}

export interface File {
  readonly path: string
  readonly contents: string
}

export interface Reference {
  readonly files: ReadonlyArray<File>
}

export interface Collision {
  readonly _tag: 'Collision'
  readonly kind: 'ModulePath' | 'DeclarationAnchor'
  readonly value: string
  readonly identities: ReadonlyArray<string>
}

export interface MissingModule {
  readonly _tag: 'MissingModule'
  readonly module: string
}

export type Error = Collision | MissingModule

export type Result =
  | { readonly _tag: 'Success'; readonly reference: Reference }
  | { readonly _tag: 'Failure'; readonly errors: ReadonlyArray<Error> }

interface Target {
  readonly module: string
  readonly file: string
  readonly anchor: string
}

const exhaustiveInline = (value: never): never => {
  throw new RangeError(`Unknown documentation inline node: ${String(value)}`)
}

const slug = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLocaleLowerCase()

const encoder = new TextEncoder()

/** The deterministic Markdown file name for one canonical module identity. */
export const moduleFile = (module: string): string => {
  const leaf = module.split('/').at(-1) ?? module
  return `${slug(leaf)}.md`
}

/** The deterministic in-page anchor for one canonical documentation identity. */
export const declarationAnchor = (identity: string): string =>
  `declaration-${[...encoder.encode(identity)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`

const escapeText = (value: string): string =>
  value.replaceAll('\\', '\\\\').replace(/([`*_[\]<>])/g, '\\$1')

const inlineMarkdown = (
  values: ReadonlyArray<Document.Inline>,
  currentFile: string,
  targets: ReadonlyMap<string, Target>,
): string =>
  values
    .map((value) => {
      switch (value._tag) {
        case 'Text':
          return escapeText(value.value)
        case 'InlineCode':
          return `\`${value.value}\``
        case 'SymbolLink': {
          const target = value.target === undefined ? undefined : targets.get(value.target.id)
          if (target === undefined) return `\`${value.spelling}\``
          const destination =
            target.file === currentFile ? `#${target.anchor}` : `./${target.file}#${target.anchor}`
          return `[\`${value.spelling}\`](${destination})`
        }
        case 'Emphasis':
          return `*${inlineMarkdown(value.children, currentFile, targets)}*`
        case 'Strong':
          return `**${inlineMarkdown(value.children, currentFile, targets)}**`
        case 'Link':
          return `[${inlineMarkdown(value.children, currentFile, targets)}](${value.destination}${value.title === undefined ? '' : ` "${value.title}"`})`
        case 'Break':
          return '  \n'
      }
      return exhaustiveInline(value)
    })
    .join('')

const codeFence = (value: string): string => {
  const runs = [...value.matchAll(/`+/g)].map((match) => match[0].length)
  return '`'.repeat(Math.max(3, (runs.length === 0 ? 0 : Math.max(...runs)) + 1))
}

const blockMarkdown = (
  block: Document.Block,
  headingOffset: number,
  currentFile: string,
  targets: ReadonlyMap<string, Target>,
): string => {
  switch (block._tag) {
    case 'Paragraph':
      return inlineMarkdown(block.children, currentFile, targets)
    case 'Heading':
      return `${'#'.repeat(Math.min(6, block.depth + headingOffset))} ${inlineMarkdown(block.children, currentFile, targets)}`
    case 'CodeBlock': {
      const fence = codeFence(block.value)
      return `${fence}${block.language ?? ''}\n${block.value}\n${fence}`
    }
    case 'BlockQuote':
      return block.children
        .map((child) => blockMarkdown(child, headingOffset, currentFile, targets))
        .join('\n\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'List':
      return block.items
        .map((item, index) => {
          const marker = block.ordered ? `${(block.start ?? 1) + index}.` : '-'
          const body = item
            .map((child) => blockMarkdown(child, headingOffset, currentFile, targets))
            .join('\n\n')
            .replaceAll('\n', '\n  ')
          return `${marker} ${body}`
        })
        .join('\n')
    case 'ThematicBreak':
      return '---'
  }
}

const documentMarkdown = (
  documentation: Document.Document | undefined,
  headingOffset: number,
  currentFile: string,
  targets: ReadonlyMap<string, Target>,
): ReadonlyArray<string> =>
  documentation === undefined
    ? []
    : [
        documentation.blocks
          .map((block) => blockMarkdown(block, headingOffset, currentFile, targets))
          .join('\n\n'),
      ]

const summary = (documentation: Document.Document | undefined): string => {
  const block = documentation?.blocks.at(0)
  return block?._tag === 'Paragraph'
    ? block.children
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
              return value.children
                .map((child) =>
                  child._tag === 'Text' || child._tag === 'InlineCode' ? child.value : '',
                )
                .join('')
            case 'Break':
              return ' '
          }
          return exhaustiveInline(value)
        })
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
    : ''
}

const sourceOrder = (items: ReadonlyArray<Project.Item>): ReadonlyArray<Project.Item> =>
  items
    .filter(
      (item) =>
        item.visibility !== 'Private' &&
        ((item.kind !== 'Parameter' && item.kind !== 'TypeParameter') ||
          item.documentation !== undefined),
    )
    .toSorted(
      (left, right) =>
        left.source.start - right.source.start ||
        left.source.end - right.source.end ||
        left.id.localeCompare(right.id),
    )

const itemLabel = (item: Project.Item): string => {
  switch (item.kind) {
    case 'Parameter':
      return `Parameter \`${item.name}\``
    case 'TypeParameter':
      return `Type parameter \`${item.name}\``
    case 'Field':
      return `Field \`${item.name}\``
    case 'Operation':
      return `Operation \`${item.name}\``
    case 'Implementation':
      return `Implementation \`${item.name}\``
    case 'Method':
      return `Method \`${item.name}\``
    case 'AssociatedFunction':
      return `Associated function \`${item.name}\``
    default:
      return `\`${item.name}\``
  }
}

const renderItem = (
  item: Project.Item,
  depth: number,
  currentFile: string,
  targets: ReadonlyMap<string, Target>,
): ReadonlyArray<string> => {
  const anchor = targets.get(item.id)?.anchor ?? declarationAnchor(item.id)
  const lines = [
    `<a id="${anchor}"></a>`,
    '',
    `${'#'.repeat(depth)} ${itemLabel(item)}`,
    '',
    '```silk',
    item.signature.text,
    '```',
  ]
  const prose = documentMarkdown(item.documentation, depth, currentFile, targets)
  if (prose.length > 0) lines.push('', ...prose)
  for (const child of sourceOrder(item.children))
    lines.push('', ...renderItem(child, Math.min(6, depth + 1), currentFile, targets))
  return lines
}

const descendants = (items: ReadonlyArray<Project.Item>): ReadonlyArray<Project.Item> =>
  sourceOrder(items).flatMap((item) => [item, ...descendants(item.children)])

const collisions = (
  manifest: ReadonlyArray<ManifestEntry>,
  modules: ReadonlyArray<Project.Module>,
): ReadonlyArray<Error> => {
  const result: Array<Error> = []
  const paths = new Map<string, Array<string>>()
  for (const entry of manifest) {
    const file = moduleFile(entry.module)
    paths.set(file, [...(paths.get(file) ?? []), entry.module])
  }
  for (const [value, identities] of paths)
    if (identities.length > 1)
      result.push(
        Object.freeze({
          _tag: 'Collision',
          kind: 'ModulePath',
          value,
          identities: Object.freeze(identities),
        }),
      )
  for (const module of modules) {
    const anchors = new Map<string, Array<string>>()
    for (const item of descendants(module.items)) {
      const anchor = declarationAnchor(item.id)
      anchors.set(anchor, [...(anchors.get(anchor) ?? []), item.id])
    }
    for (const [value, identities] of anchors)
      if (identities.length > 1)
        result.push(
          Object.freeze({
            _tag: 'Collision',
            kind: 'DeclarationAnchor',
            value,
            identities: Object.freeze(identities),
          }),
        )
  }
  return Object.freeze(result)
}

const targetMap = (modules: ReadonlyArray<Project.Module>): ReadonlyMap<string, Target> => {
  const result = new Map<string, Target>()
  for (const module of modules) {
    const file = moduleFile(module.name)
    for (const item of descendants(module.items))
      result.set(
        item.id,
        Object.freeze({ module: module.name, file, anchor: declarationAnchor(item.id) }),
      )
  }
  return result
}

const primitiveNamespaces = new Set([
  'bool',
  'char',
  'f32',
  'f64',
  'i8',
  'i16',
  'i32',
  'i64',
  'isize',
  'u8',
  'u16',
  'u32',
  'u64',
  'usize',
])

const importStatement = (entry: ManifestEntry, module: Project.Module): string => {
  const path = module.name.replaceAll('/', '.')
  if (primitiveNamespaces.has(entry.namespace)) return `import ${path}`
  const declaration = module.items.some(
    (item) => item.visibility === 'Public' && item.name === entry.namespace,
  )
  return declaration
    ? `import ${path} { ${entry.namespace} }`
    : `import ${path} as ${entry.namespace}`
}

const renderModule = (
  entry: ManifestEntry,
  module: Project.Module,
  targets: ReadonlyMap<string, Target>,
  file = moduleFile(module.name),
  availability: ReadonlyArray<string> = [],
): File => {
  const items = sourceOrder(module.items)
  const publicDeclarations = items.filter((item) => item.visibility === 'Public').length
  const lines = [
    `# \`${module.name}\``,
    '',
    '<!-- Generated by packages/compiler/scripts/generate-documentation.mjs. Do not edit by hand. -->',
    '',
    ...(availability.length === 0
      ? []
      : [`Profiles: ${availability.map((name) => `\`${name}\``).join(', ')}.`, '']),
    ...documentMarkdown(module.documentation, 1, file, targets),
    '',
    ...(publicDeclarations === 0
      ? []
      : [`Import as \`${entry.namespace}\` with \`${importStatement(entry, module)}\`.`, '']),
    '',
    `Public declarations: ${publicDeclarations}.`,
  ]
  if (items.length === 0) lines.push('', 'This module declares no public items.')
  for (const item of items) lines.push('', ...renderItem(item, 2, file, targets))
  lines.push('')
  return Object.freeze({ path: file, contents: lines.join('\n') })
}

const renderIndex = (
  manifest: ReadonlyArray<ManifestEntry>,
  modules: ReadonlyMap<string, Project.Module>,
): File => {
  const lines = [
    '# Silk standard library',
    '',
    'The compiler-shipped modules and their complete public documentation.',
    '',
    '<!-- Generated by packages/compiler/scripts/generate-documentation.mjs. Do not edit by hand. -->',
    '',
    '| Module | Import namespace | Public declarations | Summary |',
    '| --- | --- | ---: | --- |',
  ]
  for (const entry of manifest) {
    const module = modules.get(entry.module)
    if (module === undefined) continue
    const count = sourceOrder(module.items).filter((item) => item.visibility === 'Public').length
    lines.push(
      `| [\`${entry.module}\`](./${moduleFile(entry.module)}) | \`${entry.namespace}\` | ${count} | ${summary(module.documentation).replaceAll('|', '\\|')} |`,
    )
  }
  lines.push(
    '',
    '## See also',
    '',
    '- [Tutorial](../tutorial.md)',
    '- [Language reference](../../reference/)',
    '- [Diagnostic index](../diagnostics.md)',
    '',
  )
  return Object.freeze({ path: 'index.md', contents: lines.join('\n') })
}

/** Renders one deterministic index and one structured Markdown page per manifest module. */
export const make = (manifest: ReadonlyArray<ManifestEntry>, project: Project.Project): Result => {
  const byName = new Map(project.modules.map((module) => [module.name, module]))
  const errors: Array<Error> = manifest.flatMap((entry): ReadonlyArray<Error> =>
    byName.has(entry.module)
      ? []
      : [Object.freeze({ _tag: 'MissingModule', module: entry.module })],
  )
  errors.push(...collisions(manifest, project.modules))
  if (errors.length > 0) return Object.freeze({ _tag: 'Failure', errors: Object.freeze(errors) })
  const modules = manifest.flatMap((entry): ReadonlyArray<Project.Module> => {
    const module = byName.get(entry.module)
    return module === undefined ? [] : [module]
  })
  const targets = targetMap(modules)
  const files = [
    renderIndex(manifest, byName),
    ...manifest.flatMap((entry): ReadonlyArray<File> => {
      const module = byName.get(entry.module)
      return module === undefined ? [] : [renderModule(entry, module, targets)]
    }),
  ]
  return Object.freeze({
    _tag: 'Success',
    reference: Object.freeze({ files: Object.freeze(files) }),
  })
}

/** Renders distinct profile surfaces separately and shares pages only when their contents agree. */
export const makeProfiles = (
  manifest: ReadonlyArray<ManifestEntry>,
  projects: ReadonlyArray<{ readonly name: string; readonly project: Project.Project }>,
): Result => {
  const errors: Array<Error> = []
  const groups = new Map<
    string,
    Array<{ module: Project.Module; names: Array<string>; file: string }>
  >()
  const filesByProfile = new Map<string, Map<string, string>>()
  for (const { name, project } of projects) {
    errors.push(...collisions(manifest, project.modules))
    const byName = new Map(project.modules.map((module) => [module.name, module]))
    const paths = new Map<string, string>()
    for (const entry of manifest) {
      const module = byName.get(entry.module)
      if (module === undefined) {
        errors.push({ _tag: 'MissingModule', module: entry.module })
        continue
      }
      const variants = groups.get(module.name) ?? []
      let group = variants.find(
        (variant) => JSON.stringify(variant.module) === JSON.stringify(module),
      )
      if (group === undefined) {
        const base = moduleFile(module.name)
        group = {
          module,
          names: [],
          file:
            variants.length === 0
              ? base
              : base.replace(/\.md$/, `.profile-${variants.length + 1}.md`),
        }
        variants.push(group)
        groups.set(module.name, variants)
      }
      group.names.push(name)
      paths.set(module.name, group.file)
    }
    filesByProfile.set(name, paths)
  }
  if (errors.length > 0) return { _tag: 'Failure', errors: Object.freeze(errors) }
  const files: Array<File> = []
  const index = [
    '# Silk standard library',
    '',
    '<!-- Generated by packages/compiler/scripts/generate-documentation.mjs. Do not edit by hand. -->',
    '',
    'Each page describes the selected source API for the listed profiles. Distinct surfaces have separate pages.',
    '',
    '| Module | Profiles | Public declarations |',
    '| --- | --- | ---: |',
  ]
  for (const entry of manifest)
    for (const group of groups.get(entry.module) ?? []) {
      const name = group.names[0]
      const project = projects.find((candidate) => candidate.name === name)?.project
      if (project === undefined || name === undefined) continue
      const paths = filesByProfile.get(name)
      const targets = new Map(
        [...targetMap(project.modules)].map(
          ([identity, target]) =>
            [identity, { ...target, file: paths?.get(target.module) ?? target.file }] as const,
        ),
      )
      files.push(renderModule(entry, group.module, targets, group.file, group.names))
      const count = group.module.items.filter((item) => item.visibility === 'Public').length
      index.push(
        `| [\`${entry.module}\`](./${group.file}) | ${group.names.map((profile) => `\`${profile}\``).join(', ')} | ${count} |`,
      )
    }
  index.push(
    '',
    'Profile identities:',
    '',
    ...projects.map(
      ({ name, project }) =>
        `- \`${name}\`: target \`${project.profile?.target ?? '<unavailable>'}\`.`,
    ),
    '',
  )
  files.unshift({ path: 'index.md', contents: index.join('\n') })
  return { _tag: 'Success', reference: { files: Object.freeze(files) } }
}
