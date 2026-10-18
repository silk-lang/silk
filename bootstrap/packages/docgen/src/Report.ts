import type * as Doctest from './Doctest.js'
import * as Example from './Example.js'

/**
 * Renders a doctest run as text an author can act on.
 *
 * Every failure names its file, its one-based line, and the declaration whose documentation carries
 * it, because a doctest report that only says "an example failed" sends the author looking through
 * a thousand declarations for it.
 */

/** `silk/filesystem:630` — or the bare source when its bytes could not be read. */
export const position = (self: Doctest.Result): string =>
  self.line === undefined
    ? `${self.example.source.sourceId}:<line unavailable>`
    : `${self.example.source.sourceId}:${self.line}`

const owner = (self: Doctest.Result): string =>
  self.example.owner.declaration === undefined
    ? `module ${self.example.owner.module}`
    : `${self.example.owner.module}::${self.example.owner.declaration}`

/**
 * The line an author who used the prose documents' fence form needs to read.
 *
 * Inside a `///` comment ```` ```silk ignore ```` is not an opt-out: CommonMark splits the info
 * string and the documentation model records only its first word, so that fence reaches the JSON
 * indistinguishable from a bare ```` ```silk ````. Rather than let the author conclude the workflow
 * ignored their marker, every compiled failure says which form does survive.
 */
const optOutHint = `To document a form that is not meant to compile, fence it \`\`\`${Example.languageName},${Example.ignoreAttribute} — the attribute must follow a comma, because a space-separated attribute is not carried by the documentation JSON.`

const failure = (self: Doctest.Result): ReadonlyArray<string> => {
  if (self.outcome._tag !== 'Failed') return []
  const heading = `${position(self)}: example in ${owner(self)} failed`
  if (self.outcome.reason._tag === 'UnknownAttribute')
    return [
      heading,
      `  unknown fence attribute: ${self.outcome.reason.attributes.join(', ')}`,
      `  the fence reads \`\`\`${self.example.language}`,
      `  ${optOutHint}`,
    ]
  return [
    heading,
    ...self.outcome.reason.diagnostics.map((diagnostic) => `  ${diagnostic}`),
    ...self.example.code.split('\n').map((line) => `  | ${line}`),
    `  ${optOutHint}`,
  ]
}

/** One line summarizing what the run did, whatever the outcome. */
export const summary = (self: Doctest.Report): string =>
  self.collected === 0
    ? 'Doctests: no fenced Silk examples were collected.'
    : `Doctests: ${self.collected} collected, ${self.passed} passed, ${self.skipped} skipped, ${self.failed} failed.`

/** Renders every failure, then the summary. */
export const render = (self: Doctest.Report): string =>
  [...self.results.flatMap(failure), summary(self)].join('\n')
