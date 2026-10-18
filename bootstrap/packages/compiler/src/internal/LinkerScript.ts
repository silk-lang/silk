import * as Result from 'effect/Result'

export interface Reference {
  readonly kind: 'input' | 'include' | 'search'
  readonly value: string
  readonly start: number
  readonly end: number
}
export interface LinkerScript {
  readonly source: string
  readonly references: ReadonlyArray<Reference>
}

/** Finds input-bearing GNU script directives while preserving the linker's layout/group language. */
export const parse = (source: string): Result.Result<LinkerScript, string> => {
  const tokens = [
    ...source.matchAll(
      /\/\*[\s\S]*?\*\/|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s(),;{}]+|[(),;{}]/g,
    ),
  ].filter((match) => !match[0].startsWith('/*') && !match[0].startsWith('#'))
  const references: Array<Reference> = []
  const unquote = (token: string): string =>
    /^["']/.test(token) ? token.slice(1, -1).replace(/\\([\\"'])/g, '$1') : token
  let inputDepth = 0,
    depth = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    const value = token[0]
    if (['OUTPUT', 'STARTUP', 'TARGET', 'LIB', 'OUTPUT_ARCH'].includes(value)) {
      if (value !== 'OUTPUT_ARCH') return Result.fail(`unsupported input directive ${value}`)
    }
    if (value === 'INCLUDE') {
      const next = tokens[++index]
      if (next === undefined) return Result.fail('missing INCLUDE path')
      references.push({
        kind: 'include',
        value: unquote(next[0]),
        start: next.index,
        end: next.index + next[0].length,
      })
      continue
    }
    if (value === 'SEARCH_DIR') {
      const open = tokens[++index],
        path = tokens[++index],
        close = tokens[++index]
      if (open?.[0] !== '(' || path === undefined || close?.[0] !== ')')
        return Result.fail('invalid SEARCH_DIR')
      references.push({
        kind: 'search',
        value: unquote(path[0]),
        start: path.index,
        end: path.index + path[0].length,
      })
      continue
    }
    if (value === 'INPUT' || value === 'GROUP' || (inputDepth > 0 && value === 'AS_NEEDED')) {
      if (tokens[index + 1]?.[0] !== '(') return Result.fail(`missing ${value} input list`)
      if (inputDepth === 0) inputDepth = depth + 1
      continue
    }
    if (value === '(') {
      depth += 1
      continue
    }
    if (value === ')') {
      if (depth === inputDepth) inputDepth = 0
      depth -= 1
      if (depth < 0) return Result.fail('unbalanced script')
      continue
    }
    if (inputDepth > 0 && value !== ',' && value !== ';') {
      if (value === '{' || value === '}') return Result.fail('unsupported input expression')
      references.push({
        kind: 'input',
        value: unquote(value),
        start: token.index,
        end: token.index + value.length,
      })
    }
  }
  if (depth !== 0) return Result.fail('unbalanced script')
  return Result.succeed({
    source,
    references: references.map((item) => item),
  })
}

/** Substitutes resolved paths without changing layout expressions or archive group semantics. */
export const render = (self: LinkerScript, paths: ReadonlyArray<string>): string => {
  let output = '',
    offset = 0
  for (const [index, reference] of self.references.entries()) {
    output += self.source.slice(offset, reference.start)
    output += JSON.stringify(paths[index] ?? reference.value)
    offset = reference.end
  }
  return output + self.source.slice(offset)
}
