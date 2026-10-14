// Reads the bootstrap's diagnostic catalog out of packages/compiler/src/Diagnostic.ts: each stable
// code with its constant name, doc comment and every complete message template its factory can
// produce. While the TypeScript bootstrap exists it is the authoritative wording, and
// compiler/src/diagnostic/Catalog.silk must match it template for template.
//
// Message expressions are walked character by character with string, template and bracket state,
// because a regular expression cannot see where a template hole or a conditional branch ends once
// literals nest inside interpolations. The scanners follow
// packages/compiler/scripts/generate-documentation.mjs, which renders the same templates into the
// generated diagnostics page.

/** Index just past the string or template literal opening at `index`. */
const literalEnd = (text, index) => {
  const quote = text[index]
  let cursor = index + 1
  while (cursor < text.length) {
    const character = text[cursor]
    if (character === '\\') cursor += 2
    else if (character === quote) return cursor + 1
    else if (quote === '`' && character === '$' && text[cursor + 1] === '{')
      cursor = expressionEnd(text, cursor + 2, '}') + 1
    else cursor += 1
  }
  return cursor
}

/** Index of the first occurrence of `terminator` at bracket depth zero, outside literals. */
const expressionEnd = (text, index, terminator) => {
  let depth = 0
  let cursor = index
  while (cursor < text.length) {
    const character = text[cursor]
    if (character === "'" || character === '"' || character === '`') {
      cursor = literalEnd(text, cursor)
      continue
    }
    if (depth === 0 && character === terminator) return cursor
    if (character === '(' || character === '[' || character === '{') depth += 1
    else if (character === ')' || character === ']' || character === '}') depth -= 1
    cursor += 1
  }
  return cursor
}

/** Index where a `return` expression ends in the semicolon-free house style. */
const statementEnd = (text, index) => {
  let depth = 0
  let cursor = index
  while (cursor < text.length) {
    const character = text[cursor]
    if (character === "'" || character === '"' || character === '`') {
      cursor = literalEnd(text, cursor)
      continue
    }
    if (character === '(' || character === '[' || character === '{') depth += 1
    else if (character === ')' || character === ']' || character === '}') {
      if (depth === 0) return cursor
      depth -= 1
    } else if (character === '\n' && depth === 0) {
      if (!/^\s*(?:[?:.]|\|\||&&|\?\?)/.test(text.slice(cursor + 1, cursor + 12))) return cursor
    }
    cursor += 1
  }
  return cursor
}

/** The character each supported escape sequence denotes. */
export const escapes = { n: '\n', t: '\t' }

/** A doubled brace and the literal brace it spells. */
const braces = { '{{': '{', '}}': '}' }

/** The name a hole takes in the native catalog: the leading value the expression reads. */
const holeName = (expression) => {
  const identifiers = expression.match(/[A-Za-z_]\w*/g) ?? ['value']
  const owner = ['problem', 'self', 'diagnostic', 'error', 'range']
  const first = identifiers[0] ?? 'value'
  const name = owner.includes(first) && identifiers.length > 1 ? (identifiers[1] ?? first) : first
  // A conditional hole chooses wording from its value, such as a plural suffix.
  return /\?(?![?.])/.test(expression.replace(/\?\?/g, '')) ? `${name}Word` : name
}

/**
 * A template as a sequence of literal text and holes. Literal braces are doubled so a native
 * template can spell them; holes are `{name}`.
 */
const templateOf = (content) => {
  const parts = []
  let literal = ''
  let cursor = 0
  while (cursor < content.length) {
    if (content[cursor] === '\\' && cursor + 1 < content.length) {
      const escaped = content[cursor + 1]
      literal += escapes[escaped] ?? escaped
      cursor += 2
    } else if (content[cursor] === '$' && content[cursor + 1] === '{') {
      const end = expressionEnd(content, cursor + 2, '}')
      parts.push({ _tag: 'Text', text: literal })
      literal = ''
      parts.push({ _tag: 'Hole', name: holeName(content.slice(cursor + 2, end)) })
      cursor = end + 1
    } else {
      literal += content[cursor]
      cursor += 1
    }
  }
  parts.push({ _tag: 'Text', text: literal })
  return parts.filter((part) => part._tag === 'Hole' || part.text.length > 0)
}

/** The two branches of the expression's outermost conditional, or undefined without one. */
const branchesOf = (text) => {
  let depth = 0
  let question = -1
  let pending = 0
  let cursor = 0
  while (cursor < text.length) {
    const character = text[cursor]
    if (character === "'" || character === '"' || character === '`') {
      cursor = literalEnd(text, cursor)
      continue
    }
    if (character === '(' || character === '[' || character === '{') depth += 1
    else if (character === ')' || character === ']' || character === '}') depth -= 1
    else if (
      depth === 0 &&
      character === '?' &&
      text[cursor + 1] !== '?' &&
      text[cursor + 1] !== '.' &&
      text[cursor - 1] !== '?'
    ) {
      if (question === -1) question = cursor
      else pending += 1
    } else if (depth === 0 && character === ':' && question !== -1) {
      if (pending === 0) return [text.slice(question + 1, cursor), text.slice(cursor + 1)]
      pending -= 1
    }
    cursor += 1
  }
  return undefined
}

/** The unnested string and template literals of the expression. */
const literalsOf = (text) => {
  const literals = []
  let depth = 0
  let cursor = 0
  while (cursor < text.length) {
    const character = text[cursor]
    if (character === "'" || character === '"' || character === '`') {
      const end = literalEnd(text, cursor)
      if (depth === 0) literals.push(templateOf(text.slice(cursor + 1, end - 1)))
      cursor = end
      continue
    }
    if (character === '(' || character === '[' || character === '{') depth += 1
    else if (character === ')' || character === ']' || character === '}') depth -= 1
    cursor += 1
  }
  return literals
}

/** Return expressions in a helper body, excluding `return` text inside literals and comments. */
const returnedExpressionsOf = (body) => {
  const expressions = []
  let cursor = 0
  while (cursor < body.length) {
    const character = body[cursor]
    if (character === "'" || character === '"' || character === '`') {
      cursor = literalEnd(body, cursor)
      continue
    }
    if (character === '/' && body[cursor + 1] === '/') {
      const end = body.indexOf('\n', cursor + 2)
      cursor = end === -1 ? body.length : end + 1
      continue
    }
    if (character === '/' && body[cursor + 1] === '*') {
      const end = body.indexOf('*/', cursor + 2)
      cursor = end === -1 ? body.length : end + 2
      continue
    }
    if (
      body.startsWith('return', cursor) &&
      !/[A-Za-z0-9_$]/.test(body[cursor - 1] ?? '') &&
      !/[A-Za-z0-9_$]/.test(body[cursor + 'return'.length] ?? '')
    ) {
      const start = cursor + 'return'.length
      const end = statementEnd(body, start)
      expressions.push(body.slice(start, end))
      cursor = end
      continue
    }
    cursor += 1
  }
  return expressions
}

/** Every complete template the message expression can produce, in source order. */
const templatesOf = (source, expression) => {
  const text = expression.trim()
  const branches = branchesOf(text)
  if (branches !== undefined)
    return [...templatesOf(source, branches[0]), ...templatesOf(source, branches[1])]
  const literals = literalsOf(text)
  if (literals.length > 0) return literals
  const call = /^(\w+)\(/.exec(text)
  if (call === null) return []
  const opening = source.indexOf(`const ${call[1]} = `)
  if (opening === -1) return []
  const body = source.slice(source.indexOf('=> {', opening), statementEnd(source, opening))
  return returnedExpressionsOf(body).flatMap((returned) => templatesOf(source, returned))
}

/** A template in native catalog spelling: literal braces doubled, holes as `{name}`. */
export const spell = (parts) =>
  parts
    .map((part) =>
      part._tag === 'Hole' ? `{${part.name}}` : part.text.replace(/\{/g, '{{').replace(/\}/g, '}}'),
    )
    .join('')

/**
 * The comparable shape of a spelled template: its literal text with every hole reduced to one
 * marker. Hole names are native choices; literal wording and hole positions are the contract.
 */
export const shape = (spelled) =>
  spelled.replace(/\{\{|\}\}|\{\w+\}/g, (token) => braces[token] ?? '\u0000')

/**
 * Every catalog code of the bootstrap source, ordered by code: the constant's name without its
 * `Code` suffix, its doc comment as one line, and its message templates in source order.
 */
export const read = (source) => {
  const codes = new Map()
  const declaration =
    /(?:\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*)?export const (\w+)Code = '([A-Z]{3}[0-9]{4})' as const/g
  for (const match of source.matchAll(declaration)) {
    const meaning = (match[1] ?? '')
      .replace(/^\s*\*\s?/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
    codes.set(match[2], { name: match[2], code: match[3], meaning, templates: [] })
  }
  const seen = new Set()
  for (const match of source.matchAll(/code: (\w+)Code,[\s\S]{0,400}?\bmessage:/g)) {
    if (seen.has(match[1])) continue
    const entry = codes.get(match[1])
    if (entry === undefined) continue
    const start = (match.index ?? 0) + match[0].length
    const templates = templatesOf(source, source.slice(start, expressionEnd(source, start, ',')))
    if (templates.length === 0) continue
    seen.add(match[1])
    entry.templates = [...new Set(templates.map(spell))]
  }
  return [...codes.values()].sort((left, right) => left.code.localeCompare(right.code))
}
