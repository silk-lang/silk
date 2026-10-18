import * as Html from './Html.js'
import * as Model from './Model.js'
import * as Prose from './Prose.js'
import * as Search from './Search.js'

/**
 * Renders a whole documentation site from one documentation JSON value.
 *
 * Rendering is a pure function of the JSON to a list of files. Nothing here touches a filesystem,
 * a clock, or a random source, so the same input produces byte-identical output across fresh
 * processes — the same determinism the JSON itself is required to have, carried forward rather than
 * lost at the last step.
 */

export interface Site {
  readonly files: ReadonlyArray<Html.File>
}

export interface Options {
  /** Shown in the page title and the index heading. */
  readonly title?: string
  /**
   * Contents of the self-registering `<silk-snippet>` element script. When present it is shipped
   * as `silk-snippet.js` and every page loads it relatively, so Silk fences come alive; rendering
   * stays a pure function of its inputs either way.
   */
  readonly snippetBundle?: string
}

export const defaultTitle = 'Silk documentation'

/** The page and anchor each module and declaration was placed at. */
interface Layout {
  readonly pages: ReadonlyMap<string, string>
  readonly anchors: ReadonlyMap<string, string>
}

/**
 * Joins the two halves of a composite map key.
 *
 * A module identity and a declaration name are both spelled from source, and neither can contain
 * a NUL, so the joined key cannot be produced by two different pairs.
 */
const separator = '\u0000'

const anchorKey = (module: string, item: Model.Item): string => `${module}${separator}${item.id}`

/**
 * Decides every URL up front.
 *
 * Slug collisions are settled in the JSON's own order rather than by rejecting a name, so two
 * modules that slug alike still both get a page. Prose asks this layout for a link target instead
 * of recomputing a slug, which is what keeps a cross-reference pointing at the page that exists.
 */
const layoutOf = (documentation: Model.Documentation): Layout => {
  const pages = new Map<string, string>()
  const anchors = new Map<string, string>()
  const takenPages = new Set<string>(['index', 'style', 'search-index'])
  for (const module of documentation.modules) {
    pages.set(module.name, `${Html.unique(takenPages, Html.slug(module.name))}.html`)
    const takenAnchors = new Set<string>()
    const walk = (items: ReadonlyArray<Model.Item>): void => {
      for (const item of items) {
        anchors.set(
          anchorKey(module.name, item),
          Html.unique(takenAnchors, Html.slug(item.id === '' ? item.name : item.id)),
        )
        walk(item.children)
      }
    }
    walk(module.items)
  }
  return Object.freeze({ pages, anchors })
}

/**
 * Finds where a declaration is shown, given only the module and the name a symbol link carries.
 *
 * The emitter's link targets name a module and a declaration, not an item id, so the lookup is by
 * name against the module's own top-level declarations.
 */
const linksOf = (documentation: Model.Documentation, layout: Layout): Prose.Links => {
  const byName = new Map<string, string>()
  for (const module of documentation.modules) {
    const page = layout.pages.get(module.name)
    if (page === undefined) continue
    for (const item of module.items) {
      const anchor = layout.anchors.get(anchorKey(module.name, item))
      const key = `${module.name}${separator}${item.name}`
      if (anchor !== undefined && !byName.has(key)) byName.set(key, `${page}#${anchor}`)
    }
  }
  return (module, name) => byName.get(`${module}${separator}${name}`)
}

const style = `:root {
  color-scheme: light dark;
  --ink: #16181d;
  --paper: #ffffff;
  --muted: #5c6370;
  --line: #e2e5ea;
  --accent: #2f5bd0;
  --code: #f5f6f8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e6e8ec;
    --paper: #14161a;
    --muted: #9aa1ad;
    --line: #2a2e36;
    --accent: #8fb0ff;
    --code: #1c1f25;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  padding: 2rem 1.25rem 6rem;
  max-width: 52rem;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
}
a { color: var(--accent); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
pre {
  background: var(--code);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.75rem 1rem;
  overflow-x: auto;
}
code { background: var(--code); border-radius: 4px; padding: 0.1em 0.3em; }
pre code { background: none; padding: 0; }
header { border-bottom: 1px solid var(--line); margin-bottom: 2rem; padding-bottom: 1rem; }
header nav { color: var(--muted); font-size: 0.9rem; }
.search { margin-top: 0.75rem; position: relative; }
.search input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper);
  color: inherit;
  font: inherit;
}
.results {
  list-style: none;
  margin: 0.25rem 0 0;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper);
  max-height: 20rem;
  overflow-y: auto;
}
.results[hidden] { display: none; }
.results li { border-bottom: 1px solid var(--line); padding: 0.4rem 0.75rem; }
.results li:last-child { border-bottom: none; }
.results .where { color: var(--muted); float: right; font-size: 0.85em; }
.results .empty { color: var(--muted); }
.declaration { border-top: 1px solid var(--line); padding-top: 1.25rem; margin-top: 2rem; }
.declaration h2 { margin-bottom: 0.25rem; }
.badge {
  color: var(--muted);
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.members { border-collapse: collapse; width: 100%; }
.members td { border-top: 1px solid var(--line); padding: 0.4rem 0.5rem; vertical-align: top; }
.members td:first-child { white-space: nowrap; }
.summary { color: var(--muted); }
.modules { list-style: none; padding: 0; }
.modules li { border-top: 1px solid var(--line); padding: 0.6rem 0; }
/* A snippet element that never upgrades — no JavaScript, or no element script — still reads as a
   code block. Once defined, its shadow styles take over and this fallback withdraws. */
silk-snippet:not(:defined) {
  display: block;
  background: var(--code);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.75rem 1rem;
  overflow-x: auto;
  white-space: pre;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
}
silk-snippet { margin: 1em 0; }
`

const searchWidget = `<div class="search">
      <input type="search" data-search-field placeholder="Search declarations" aria-label="Search declarations">
      <ul class="results" data-search-results hidden></ul>
    </div>`

const snippetScriptPath = 'silk-snippet.js'

const page = (title: string, heading: string, body: string, snippetScript: boolean): string =>
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${Html.escapeText(title)}</title>
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <header>
      <nav>${heading}</nav>
      ${searchWidget}
    </header>
${body}
    <script src="search-index.js"></script>
    <script>${Search.script()}</script>${
      snippetScript ? `\n    <script type="module" src="${snippetScriptPath}"></script>` : ''
    }
  </body>
</html>
`

const memberRows = (
  module: Model.Module,
  items: ReadonlyArray<Model.Item>,
  layout: Layout,
  links: Prose.Links,
): string => {
  const described = items.filter((item) => item.name !== '')
  if (described.length === 0) return ''
  // Every row carries the anchor the search index and cross-references point at, so a member
  // reached by name lands on its own row rather than on the owner's heading.
  const rows = described
    .map((item) => {
      const anchor = layout.anchors.get(anchorKey(module.name, item))
      const id = anchor === undefined ? '' : ` id="${Html.escapeText(anchor)}"`
      return `<tr${id}><td><code>${Html.escapeText(item.signature === '' ? item.name : item.signature)}</code></td><td>${Prose.document(item.documentation?.blocks, links)}</td></tr>`
    })
    .join('\n        ')
  return `<table class="members">
        ${rows}
      </table>`
}

const declaration = (
  module: Model.Module,
  item: Model.Item,
  layout: Layout,
  links: Prose.Links,
): string => {
  const anchor = layout.anchors.get(anchorKey(module.name, item)) ?? Html.slug(item.name)
  const documentation = Prose.document(item.documentation?.blocks, links)
  return `    <section class="declaration" id="${Html.escapeText(anchor)}">
      <h2><code>${Html.escapeText(item.name)}</code></h2>
      <p class="badge">${Html.escapeText(item.visibility)} ${Html.escapeText(item.kind)}</p>
      <pre><code class="language-silk">${Html.escapeText(item.signature)}</code></pre>
      ${documentation}
      ${memberRows(module, item.children, layout, links)}
    </section>`
}

const modulePage = (
  module: Model.Module,
  layout: Layout,
  links: Prose.Links,
  options: Options,
): Html.File => {
  const path = layout.pages.get(module.name) ?? `${Html.slug(module.name)}.html`
  const contents = page(
    `${module.name} — ${options.title ?? defaultTitle}`,
    `<a href="index.html">${Html.escapeText(options.title ?? defaultTitle)}</a> / ${Html.escapeText(module.name)}`,
    `    <h1><code>${Html.escapeText(module.name)}</code></h1>
    ${Prose.document(module.documentation?.blocks, links)}
${
  module.items.length === 0
    ? '    <p class="summary">This module declares nothing.</p>'
    : module.items.map((item) => declaration(module, item, layout, links)).join('\n')
}`,
    options.snippetBundle !== undefined,
  )
  return Html.file(path, contents)
}

const indexPage = (
  documentation: Model.Documentation,
  layout: Layout,
  _links: Prose.Links,
  options: Options,
): Html.File => {
  const title = options.title ?? defaultTitle
  const rows = documentation.modules
    .map((module) => {
      const href = layout.pages.get(module.name) ?? `${Html.slug(module.name)}.html`
      const count = module.items.length
      const summary = Model.summary(module.documentation)
      return `      <li>
        <a href="${Html.escapeText(href)}"><code>${Html.escapeText(module.name)}</code></a>
        <span class="badge">${count} ${count === 1 ? 'declaration' : 'declarations'}</span>${
          summary === '' ? '' : `\n        <div class="summary">${Html.escapeText(summary)}</div>`
        }
      </li>`
    })
    .join('\n')
  return Html.file(
    'index.html',
    page(
      title,
      Html.escapeText(title),
      `    <h1>${Html.escapeText(title)}</h1>
    <p class="summary">${documentation.modules.length} ${documentation.modules.length === 1 ? 'module' : 'modules'}, rendered from the documentation JSON <code>silk doc</code> emits.</p>
    <ul class="modules">
${rows}
    </ul>`,
      options.snippetBundle !== undefined,
    ),
  )
}

/** Renders the index page, one page per module, the stylesheet, and the search index. */
export const render = (documentation: Model.Documentation, options: Options = {}): Site => {
  const layout = layoutOf(documentation)
  const links = linksOf(documentation, layout)
  const entries = Search.build(documentation, (module, item) => {
    const href = layout.pages.get(module.name) ?? `${Html.slug(module.name)}.html`
    const anchor = layout.anchors.get(anchorKey(module.name, item))
    return anchor === undefined ? href : `${href}#${anchor}`
  })
  return Object.freeze({
    files: Object.freeze([
      indexPage(documentation, layout, links, options),
      ...documentation.modules.map((module) => modulePage(module, layout, links, options)),
      Html.file('style.css', style),
      Search.indexFile(entries),
      ...(options.snippetBundle === undefined
        ? []
        : [Html.file(snippetScriptPath, options.snippetBundle)]),
    ]),
  })
}
