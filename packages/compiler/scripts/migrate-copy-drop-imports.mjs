#!/usr/bin/env node
// Imports `Copy` and `Drop` from `silk.ownership` wherever source spells them bare (INTR-006).
//
//   node scripts/migrate-copy-drop-imports.mjs [--write | --check] <file or directory>...
//
// Without --write it only reports. With --check it exits nonzero while any unit still spells a bare
// `Copy` or `Drop` without importing it, so a migrated tree prints `no sites` and exits zero.
//
// The unit of migration is one Silk program: a `.silk` file, a `silk` fence in a `.md` file or in a
// `//!` or `///` documentation comment, or a TypeScript string or template literal that holds
// top-level Silk declarations. A use is the identifier `Copy` or `Drop` outside comments and string
// literals, not qualified by an owner (`Intrinsic.Copy`, `ownership.Drop`) and not itself an owner.
// Each unit gains `import silk.ownership { ... }` naming exactly the properties it uses, inside its
// first import block or, without one, before its first declaration. An existing
// `import silk.ownership { ... }` is extended instead. A unit that declares, binds or imports its
// own `Copy` or `Drop`, or that carries a `// bare:` comment because it tests the unimported
// spelling, is left alone and reported. A template interpolation `${...}` is kept as
// written; a fragment interpolated into another program is migrated like any unit and the program
// that embeds it must be checked by its tests. The script is idempotent.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const properties = ['Copy', 'Drop']
const declarers = new Set(['struct', 'enum', 'union', 'interface', 'type', 'fn', 'service', 'let'])
const ownershipImport = /import\s+silk\.ownership\s*\{([^}]*)\}/

// Splits Silk source into identifier and punctuation tokens, skipping comments and literals.
const tokens = (text) => {
  const found = []
  let at = 0
  while (at < text.length) {
    const character = text[at]
    if (/\s/.test(character)) at += 1
    else if (text.startsWith('//', at)) {
      const end = text.indexOf('\n', at)
      const escaped = text.indexOf('\\n', at)
      const stops = [end, escaped].filter((stop) => stop >= 0)
      at = stops.length === 0 ? text.length : Math.min(...stops)
    } else if (character === '"') {
      at += 1
      while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1
      at += 1
    } else if (character === "'") {
      const literal = /^'(\\.|[^\\'\n])'/.exec(text.slice(at))
      at += literal === null ? 1 : literal[0].length
    } else if (/[A-Za-z_]/.test(character)) {
      const word = /^[A-Za-z_]\w*/.exec(text.slice(at))[0]
      found.push({ text: word, start: at })
      at += word.length
    } else {
      found.push({ text: character, start: at })
      at += 1
    }
  }
  return found
}

const closers = { '>': '<', '}': '{', ')': '(', ']': '[' }

// The nearest bracket still open before one token, with its token index.
const enclosing = (all, index) => {
  const pending = []
  for (let at = index - 1; at >= 0; at -= 1) {
    const text = all[at].text
    if (text in closers) pending.push(closers[text])
    else if (Object.values(closers).includes(text)) {
      if (pending.at(-1) === text) pending.pop()
      else if (pending.length === 0) return { text, index: at }
    }
  }
  return undefined
}

// The first token of the statement that contains one token: the token after the previous `}` or
// line-level boundary, approximated by walking back over identifiers, dots and spaces.
const statementStart = (all, index) => {
  let at = index - 1
  while (at > 0 && /^[\w.]+$/.test(all[at - 1].text)) at -= 1
  return at
}

// The properties one unit uses bare, or the reason the unit owns one of the spellings.
const classify = (text) => {
  if (/\/\/ bare:/.test(text)) return { conflict: 'is marked `// bare:`' }
  const blanked = text.replace(ownershipImport, (whole) => ' '.repeat(whole.length))
  const all = tokens(blanked)
  const used = new Set()
  for (const [index, token] of all.entries()) {
    if (!properties.includes(token.text)) continue
    const previous = all[index - 1]?.text
    const next = all[index + 1]?.text
    if (previous === '.' || next === '.') continue
    if (previous !== undefined && declarers.has(previous))
      return { conflict: `declares ${token.text}` }
    if (previous === '<' || previous === ',' || previous === '{' || previous === '(') {
      const opener = enclosing(all, index)
      if (opener?.text === '<') return { conflict: `binds ${token.text}` }
      if (opener?.text === '{' && all[statementStart(all, opener.index)]?.text === 'import')
        return { conflict: `imports ${token.text}` }
      // An enum variant or a pattern spells its own name, not the property.
      if (opener?.text === '{' || opener?.text === '(') continue
    }
    used.add(token.text)
  }
  return { used }
}

const importPath = (line) => /^\s*import\s+([\w.]+)/.exec(line)?.[1]

// Adds the import one unit needs. `separator` is the unit's line break as written in its container.
const migrateUnit = (text, separator, spacing) => {
  const result = classify(text)
  if (result.conflict !== undefined) return { text, conflict: result.conflict, sites: 0 }
  const existing = ownershipImport.exec(text)
  const already = new Set(
    existing === null
      ? []
      : existing[1]
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
  )
  const missing = [...result.used].filter((name) => !already.has(name))
  if (missing.length === 0) return { text, sites: 0 }
  const names = [...new Set([...already, ...missing])].sort((left, right) =>
    left.localeCompare(right),
  )
  // A unit that already spaces its braced imports keeps that style; the canonical form is tight.
  const list = /import\s+[\w.]+\s*\{ /.test(text)
    ? `{ ${names.join(', ')} }`
    : `{${names.join(', ')}}`
  if (existing !== null)
    return {
      text: text.replace(ownershipImport, `import silk.ownership ${list}`),
      sites: missing.length,
    }
  const lines = text.split(separator)
  const statement = (indent) => `${indent}import silk.ownership ${list}`
  // Import statements as [first line, last line]; a braced list may span several lines.
  const statements = []
  for (let at = 0; at < lines.length; at += 1) {
    if (importPath(lines[at]) === undefined) continue
    let end = at
    if (lines[at].includes('{') && !lines[at].includes('}'))
      while (end + 1 < lines.length && !lines[end].includes('}')) end += 1
    statements.push([at, end])
    at = end
  }
  if (statements.length > 0) {
    // The first block is the run of statements with nothing but statements between them.
    let last = 0
    while (last + 1 < statements.length && statements[last + 1][0] === statements[last][1] + 1)
      last += 1
    const block = statements.slice(0, last + 1)
    const before = block.find(([start]) => importPath(lines[start]) > 'silk.ownership')
    const at = before === undefined ? block[last][1] + 1 : before[0]
    const indent = /^\s*/.exec(lines[block[0][0]])[0]
    lines.splice(at, 0, statement(indent))
    return { text: lines.join(separator), sites: missing.length }
  }
  const first = lines.findIndex((line) => line.trim() !== '' && !line.trim().startsWith('//!'))
  if (first < 0) return { text, sites: 0 }
  const indent = /^\s*/.exec(lines[first])[0]
  const inserted = spacing ? [statement(indent), ''] : [statement(indent)]
  // A unit that starts on its container's opening line keeps that line's leading text.
  const leading = lines[first].length - lines[first].trimStart().length
  if (first === 0 && leading === 0 && !spacing && text.length > 0) {
    lines[0] = `${statement('')}${separator}${lines[0]}`
    return { text: lines.join(separator), sites: missing.length }
  }
  lines.splice(first, 0, ...inserted)
  return { text: lines.join(separator), sites: missing.length }
}

// Migrates each `silk` fence of a Markdown file or of one documentation-comment family.
const migrateFences = (text, prefix, report) => {
  const lines = text.split('\n')
  const output = []
  let at = 0
  while (at < lines.length) {
    const line = lines[at]
    const opening = new RegExp(`^(\\s*${prefix})(\`{3,})silk\\b`).exec(line)
    output.push(line)
    at += 1
    if (opening === null) continue
    const [, lead, fence] = opening
    const closing = new RegExp(`^\\s*${prefix.trim()}\\s*${fence}\\s*$`)
    const body = []
    while (at < lines.length && !closing.test(lines[at])) {
      body.push(lines[at])
      at += 1
    }
    const bare = body.map((content) =>
      content.startsWith(lead)
        ? content.slice(lead.length)
        : content.trimStart().slice(prefix.trim().length).replace(/^ /, ''),
    )
    const migrated = migrateUnit(bare.join('\n'), '\n', true)
    report(migrated, `${prefix.trim() || 'fence'} at line ${at - body.length}`)
    const rewritten =
      migrated.sites === 0
        ? body
        : migrated.text
            .split('\n')
            .map((content) => (content === '' ? lead.trimEnd() : `${lead}${content}`))
    output.push(...rewritten)
  }
  return output.join('\n')
}

const declarationLine =
  /(^|\n|\\n)\s*(pub\s+)?(fn|struct|impl|enum|interface|union|type|effect|test|service|import)[\s<]/

// Finds the content span of every TypeScript string and template literal, skipping comments. A
// template is one span, interpolations included, so a program assembled around `${...}` stays one
// unit. Regular-expression literals are not recognized; none in the migrated files holds a quote.
const literals = (text) => {
  const found = []
  const scan = (at, closer) => {
    let depth = 0
    while (at < text.length) {
      const character = text[at]
      if (closer !== undefined && character === '}' && depth === 0) return at + 1
      if (character === '{') depth += 1
      else if (character === '}') depth -= 1
      if (text.startsWith('//', at)) {
        const end = text.indexOf('\n', at)
        at = end < 0 ? text.length : end
      } else if (text.startsWith('/*', at)) {
        const end = text.indexOf('*/', at + 2)
        at = end < 0 ? text.length : end + 2
      } else if (character === "'" || character === '"') {
        let end = at + 1
        while (end < text.length && text[end] !== character) end += text[end] === '\\' ? 2 : 1
        found.push({ start: at + 1, end })
        at = end + 1
      } else if (character === '`') {
        let end = at + 1
        while (end < text.length && text[end] !== '`') {
          if (text[end] === '\\') end += 2
          else if (text.startsWith('${', end)) end = scan(end + 2, '}')
          else end += 1
        }
        found.push({ start: at + 1, end })
        at = end + 1
      } else at += 1
    }
    return at
  }
  scan(0, undefined)
  return found
}

// Migrates each TypeScript string or template literal that holds a Silk program.
const migrateTypeScript = (text, report) => {
  const edits = []
  for (const { start, end } of literals(text)) {
    const raw = text.slice(start, end)
    if (!declarationLine.test(raw)) continue
    const separator = raw.includes('\n') ? '\n' : '\\n'
    // A one-line literal is often one line of a program assembled elsewhere, so it is reported.
    if (!raw.includes(separator)) {
      const single = migrateUnit(raw, separator, false)
      if (single.sites > 0)
        report(
          { conflict: 'is one line; migrate its program by hand', sites: 0 },
          `literal at line ${text.slice(0, start).split('\n').length}`,
        )
      continue
    }
    const migrated = migrateUnit(raw, separator, false)
    report(migrated, `literal at line ${text.slice(0, start).split('\n').length}`)
    if (migrated.sites > 0) edits.push({ start, end, text: migrated.text })
  }
  return edits
    .filter(
      (edit) =>
        !edits.some(
          (outer) => outer !== edit && outer.start <= edit.start && edit.end <= outer.end,
        ),
    )
    .sort((left, right) => right.start - left.start)
    .reduce(
      (current, edit) => current.slice(0, edit.start) + edit.text + current.slice(edit.end),
      text,
    )
}

// Syntax-only suites format or highlight source without resolving names, so they need no import.
const syntaxOnly = ['SyntaxFormatter.test.ts', 'CodeMirror.test.ts', 'parser-cases.mjs']

const kindOf = (path) =>
  ['silk', 'md'].find((kind) => path.endsWith(`.${kind}`)) ??
  (/\.(ts|tsx|mts|mjs)$/.test(path) ? 'ts' : undefined)

const files = (path) => {
  if (statSync(path).isDirectory())
    return readdirSync(path)
      .filter((name) => name !== 'node_modules' && name !== 'dist' && !name.startsWith('.'))
      .flatMap((name) => files(join(path, name)))
  return kindOf(path) === undefined ||
    path.endsWith('.generated.ts') ||
    path.endsWith('migrate-copy-drop-imports.mjs') ||
    syntaxOnly.some((name) => path.endsWith(name))
    ? []
    : [path]
}

const flags = new Set(process.argv.slice(2).filter((argument) => argument.startsWith('--')))
const paths = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
let sites = 0
for (const path of paths.flatMap(files)) {
  const name = relative(process.cwd(), path)
  const report = (migrated, where) => {
    if (migrated.conflict !== undefined)
      process.stdout.write(`${name}: ${where} left alone, ${migrated.conflict}\n`)
    sites += migrated.sites
    if (migrated.sites > 0) process.stdout.write(`${name}: ${where} imports ${migrated.sites}\n`)
  }
  const before = readFileSync(path, 'utf8')
  const kind = kindOf(path)
  let after = before
  if (kind === 'md') after = migrateFences(before, '', report)
  else if (kind === 'ts') after = migrateTypeScript(before, report)
  else {
    after = migrateFences(migrateFences(before, '//! ', report), '/// ', report)
    const migrated = migrateUnit(after, '\n', true)
    report(migrated, 'file')
    after = migrated.text
  }
  if (flags.has('--write') && after !== before) writeFileSync(path, after)
}
process.stdout.write(sites === 0 ? 'no sites\n' : `${sites} sites\n`)
if (flags.has('--check') && sites > 0) process.exitCode = 1
