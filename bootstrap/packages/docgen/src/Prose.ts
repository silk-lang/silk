import * as Html from './Html.js'
import type * as Model from './Model.js'

/** Resolves a declaration the emitter linked to into a page location. */
export type Links = (module: string, name: string) => string | undefined

/** Resolves nothing. Every symbol link renders as inline code. */
export const noLinks: Links = () => undefined

const symbolLink = (
  node: Extract<Model.Inline, { readonly _tag: 'SymbolLink' }>,
  links: Links,
): string => {
  const spelling = `<code>${Html.escapeText(node.spelling)}</code>`
  if (node.target === undefined) return spelling
  const location = links(node.target.module, node.target.name)
  return location === undefined
    ? spelling
    : `<a class="symbol" href="${Html.escapeText(location)}">${spelling}</a>`
}

const inlineNode = (node: Model.Inline, links: Links): string => {
  switch (node._tag) {
    case 'Text':
      return Html.escapeText(node.value)
    case 'InlineCode':
      return `<code>${Html.escapeText(node.value)}</code>`
    case 'Emphasis':
      return `<em>${inline(node.children, links)}</em>`
    case 'Strong':
      return `<strong>${inline(node.children, links)}</strong>`
    case 'Link':
      return `<a href="${Html.escapeText(node.destination)}">${inline(node.children, links)}</a>`
    case 'SymbolLink':
      return symbolLink(node, links)
    case 'Break':
      return '<br>'
  }
}

/** Renders a validated inline sequence. */
export const inline = (nodes: ReadonlyArray<Model.Inline>, links: Links = noLinks): string =>
  nodes.map((node) => inlineNode(node, links)).join('')

const blockSequence = (nodes: ReadonlyArray<Model.Block>, links: Links): string =>
  nodes.map((node) => block(node, links)).join('')

/**
 * Renders one Silk fence as the live snippet element.
 *
 * The fence's language token carries its comma-delimited attributes exactly as authored
 * (`silk,ignore`). A plain `silk` fence gets diagnostics and hover; a fence with any attribute —
 * `ignore` foremost — degrades to a highlight-only element whose content is never compiled in the
 * reader's browser. The leading newline is the element's authoring convenience and is trimmed on
 * upgrade; without JavaScript the element shows its text as-is.
 */
const silkSnippet = (language: string, value: string): string | undefined => {
  const parts = language.split(',').map((part) => part.trim())
  if (parts.at(0)?.toLocaleLowerCase() !== 'silk') return undefined
  const attributes = parts.slice(1).filter((part) => part !== '')
  const flags = attributes.length === 0 ? ' diagnostics hover' : ''
  return `<silk-snippet${flags}>\n${Html.escapeText(value)}</silk-snippet>`
}

/** Renders one validated block node. */
export const block = (node: Model.Block, links: Links = noLinks): string => {
  switch (node._tag) {
    case 'Paragraph':
      return `<p>${inline(node.children, links)}</p>`
    case 'Heading': {
      // A documentation heading sits inside a declaration's section, so it starts below the page's
      // own headings rather than competing with them.
      const level = Math.min(6, node.depth + 2)
      return `<h${level}>${inline(node.children, links)}</h${level}>`
    }
    case 'CodeBlock': {
      const snippet =
        node.language === undefined ? undefined : silkSnippet(node.language, node.value)
      if (snippet !== undefined) return snippet
      const attribute =
        node.language === undefined
          ? ''
          : ` class="language-${Html.escapeText(Html.slug(node.language))}"`
      return `<pre><code${attribute}>${Html.escapeText(node.value)}</code></pre>`
    }
    case 'BlockQuote':
      return `<blockquote>${blockSequence(node.children, links)}</blockquote>`
    case 'List': {
      const attribute =
        node.ordered && node.start !== undefined && node.start !== 1
          ? ` start="${Html.escapeText(String(node.start))}"`
          : ''
      const items = node.items.map((item) => `<li>${blockSequence(item, links)}</li>`).join('')
      return node.ordered ? `<ol${attribute}>${items}</ol>` : `<ul>${items}</ul>`
    }
    case 'ThematicBreak':
      return '<hr>'
  }
}

/** Renders a whole validated document body. */
export const document = (
  blocks: ReadonlyArray<Model.Block> | undefined,
  links: Links = noLinks,
): string => (blocks === undefined ? '' : blocks.map((node) => block(node, links)).join('\n'))
