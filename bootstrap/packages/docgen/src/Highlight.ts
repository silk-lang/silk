import * as Lexer from '@silklang/compiler/Lexer'
import * as Scalar from '@silklang/compiler/Scalar'
import * as SourceFile from '@silklang/compiler/SourceFile'
import type * as Token from '@silklang/compiler/Token'

export interface Range {
  readonly from: number
  readonly to: number
  readonly category: string
}

const encoder = new TextEncoder()

const byteToCharacter = (value: string): Uint32Array => {
  const bytes = encoder.encode(value)
  const map = new Uint32Array(bytes.length + 1)
  let byte = 0
  let character = 0
  for (const symbol of value) {
    const width = encoder.encode(symbol).length
    for (let index = 0; index < width; index += 1) map[byte + index] = character
    byte += width
    character += symbol.length
  }
  map[byte] = character
  return map
}

const silkCategory = (kind: Token.TokenKind, spelling: string): string | undefined => {
  if (kind.endsWith('Keyword')) return 'doc-code-keyword'
  switch (kind) {
    case 'Identifier':
      return /^[A-Z]/.test(spelling) || Scalar.find(spelling) !== undefined || spelling === 'never'
        ? 'doc-code-type'
        : 'doc-code-identifier'
    case 'DecimalInteger':
      return 'doc-code-number'
    case 'LineComment':
    case 'DocComment':
    case 'ModuleDocComment':
      return 'doc-code-comment'
    case 'Whitespace':
    case 'EndOfFile':
      return undefined
    case 'LeftParenthesis':
    case 'RightParenthesis':
    case 'LeftBrace':
    case 'RightBrace':
    case 'LeftBracket':
    case 'RightBracket':
    case 'Colon':
    case 'Semicolon':
    case 'Comma':
    case 'Dot':
    case 'DotDot':
      return 'doc-code-punctuation'
    case 'Invalid':
      return 'doc-code-invalid'
    default:
      return 'doc-code-operator'
  }
}

const nestedSilk = (value: string, start: number): ReadonlyArray<Range> => {
  const bytes = encoder.encode(value)
  const map = bytes.length === value.length ? undefined : byteToCharacter(value)
  return Lexer.lex(SourceFile.make('documentation-highlight', bytes)).tokens.flatMap(
    (token): ReadonlyArray<Range> => {
      const from = start + (map === undefined ? token.span.start : (map[token.span.start] ?? 0))
      const to = start + (map === undefined ? token.span.end : (map[token.span.end] ?? 0))
      const category = silkCategory(token.kind, value.slice(from - start, to - start))
      return category === undefined || from === to ? [] : [{ from, to, category }]
    },
  )
}

const markup = (value: string, start: number): ReadonlyArray<Range> => {
  const ranges: Array<Range> = []
  const heading = /^\s*(#{1,6})(?=\s|$)/.exec(value)
  if (heading?.index !== undefined && heading[1] !== undefined) {
    const from = start + heading.index + heading[0].indexOf(heading[1])
    ranges.push({ from, to: from + heading[1].length, category: 'doc-heading-marker' })
  }
  for (const match of value.matchAll(/\[`([^`\]\r\n]+)`\]/g)) {
    const spelling = match[1]
    if (spelling === undefined) continue
    const from = start + match.index
    ranges.push({ from, to: from + 2, category: 'doc-link-punctuation' })
    ranges.push({ from: from + 2, to: from + 2 + spelling.length, category: 'doc-link-target' })
    ranges.push({
      from: from + 2 + spelling.length,
      to: from + match[0].length,
      category: 'doc-link-punctuation',
    })
  }
  for (const match of value.matchAll(/(`+)([^`\r\n]+)\1/g)) {
    const marker = match[1]
    const body = match[2]
    if (marker === undefined || body === undefined) continue
    const from = start + match.index
    ranges.push({ from, to: from + marker.length, category: 'doc-code-marker' })
    ranges.push({
      from: from + marker.length,
      to: from + marker.length + body.length,
      category: 'doc-code',
    })
    ranges.push({
      from: from + marker.length + body.length,
      to: from + match[0].length,
      category: 'doc-code-marker',
    })
  }
  for (const match of value.matchAll(/\*\*|__|(?<!\*)\*(?!\*)|(?<!_)_(?!_)/g))
    ranges.push({
      from: start + match.index,
      to: start + match.index + match[0].length,
      category: match[0].length === 2 ? 'doc-strong-marker' : 'doc-emphasis-marker',
    })
  return Object.freeze(ranges)
}

/**
 * Highlights documentation markers and Markdown only. Ordinary Silk source remains owned by the
 * compiler-driven editor adapter; fenced `silk` examples are lexed independently and lazily.
 */
export const ranges = (source: string): ReadonlyArray<Range> => {
  const result: Array<Range> = []
  let offset = 0
  let fence: { readonly marker: string; readonly silk: boolean } | undefined
  for (const lineWithBreak of source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    const line = lineWithBreak[0].replace(/[\r\n]+$/, '')
    if (line.length === 0 && lineWithBreak[0].length === 0) break
    const match = /^(\s*)(\/\/\/(?!\/)|\/\/!)(.*)$/.exec(line)
    if (match !== null) {
      const indentation = match[1] ?? ''
      const marker = match[2] ?? ''
      const content = match[3] ?? ''
      const markerStart = offset + indentation.length
      const contentStart = markerStart + marker.length
      result.push({
        from: markerStart,
        to: contentStart,
        category: marker === '//!' ? 'module-doc-comment-marker' : 'doc-comment-marker',
      })
      if (content.length > 0)
        result.push({
          from: contentStart,
          to: contentStart + content.length,
          category: marker === '//!' ? 'module-doc-comment' : 'doc-comment',
        })
      const normalized = content.startsWith(' ') ? content.slice(1) : content
      const normalizedStart = contentStart + (content.startsWith(' ') ? 1 : 0)
      const fenceMatch = /^\s*(`{3,}|~{3,})([^\s`]*)/.exec(normalized)
      if (fenceMatch !== null && fenceMatch[1] !== undefined) {
        const fenceStart =
          normalizedStart + (fenceMatch.index ?? 0) + fenceMatch[0].indexOf(fenceMatch[1])
        result.push({
          from: fenceStart,
          to: fenceStart + fenceMatch[1].length,
          category: 'doc-code-fence',
        })
        const language = fenceMatch[2] ?? ''
        if (language.length > 0)
          result.push({
            from: fenceStart + fenceMatch[1].length,
            to: fenceStart + fenceMatch[1].length + language.length,
            category: 'doc-code-language',
          })
        fence =
          fence === undefined ? { marker: fenceMatch[1], silk: language === 'silk' } : undefined
      } else if (fence?.silk === true) result.push(...nestedSilk(normalized, normalizedStart))
      else if (fence === undefined) result.push(...markup(normalized, normalizedStart))
    }
    offset += lineWithBreak[0].length
  }
  return Object.freeze(result.sort((left, right) => left.from - right.from || left.to - right.to))
}
