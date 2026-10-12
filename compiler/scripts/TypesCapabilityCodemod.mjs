#!/usr/bin/env node
// Threads the `Types` service (compiler/src/semantic/Types.silk) through the compiler sources
// (incremental v2 slice 0, hash-consed types, step 1).
//
// 1. Every `Shared<Type>.make(` outside Types.silk becomes `Types.intern(`, so all type nodes are
//    built through one table.
// 2. The compiler is then asked, build by build, where a requirement is now unhandled. A test
//    function or `main` provides a `TypeTable` next to its allocator; any other function declares
//    `| &mut Types` in its requirement row. Missing imports are added. This repeats until the
//    compiler reports no such site.
//
// The rewrite is idempotent. After merging selfhost into a branch, run it from the repository root
// with a working native compiler:
//   SILKC=<native silkc> SILKC_CLANG=<clang> node compiler/scripts/TypesCapabilityCodemod.mjs
// `--check` only reports `Shared<Type>.make(` sites outside Types.silk and exits nonzero if any
// remain; it needs no compiler, which is what CI runs.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const compiler = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(compiler, 'src')
const stdlib = join(compiler, '../packages/compiler/stdlib')
const check = process.argv.includes('--check')
const typesModule = 'semantic/Types.silk'

const sources = (directory) =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.silk') ? [path] : []
  })

// Step 1: construction goes through the table.
const direct = /Shared<Type>\.make\(/g
let constructions = 0
for (const path of sources(src)) {
  if (relative(src, path) === typesModule) continue
  const text = readFileSync(path, 'utf8')
  const count = (text.match(direct) ?? []).length
  if (count === 0) continue
  constructions += count
  if (check) {
    console.error(`${relative(src, path)}: ${count} Shared<Type>.make( sites`)
    continue
  }
  writeFileSync(path, ensureImport(text.replace(direct, 'Types.intern('), 'Types'))
}
if (check) {
  if (constructions > 0) process.exit(1)
  process.exit(0)
}

function ensureImport(text, name) {
  const existing = /^import semantic\.Types \{([^}]*)\}$/m.exec(text)
  if (existing !== null) {
    const names = existing[1].split(',').map((entry) => entry.trim()).filter(Boolean)
    if (names.includes(name)) return text
    names.push(name)
    names.sort()
    return text.replace(existing[0], `import semantic.Types {${names.join(', ')}}`)
  }
  const lines = text.split('\n')
  let at = 0
  while (at < lines.length && (lines[at].startsWith('//') || lines[at].trim() === '')) at += 1
  lines.splice(at, 0, `import semantic.Types {${name}}`)
  return lines.join('\n')
}

// Step 2: the compiler names each unhandled site.
const silkc = process.env.SILKC
if (silkc === undefined) throw new Error('set SILKC to a native silkc')
// The entries CI builds and its test shards' roots, read from the workflow so the lists cannot
// drift apart.
const workflow = readFileSync(join(compiler, '../.github/workflows/selfhost.yml'), 'utf8')
const entries = new Set(['src/main.silk'])
for (const match of workflow.matchAll(/"\$SILKC" build "[^"]*\/compiler\/(src\/[\w/]+\.silk)"/g)) entries.add(match[1])
const testRoots = [...workflow.matchAll(/roots: >-\n((?:[ \t]+src\/\S.*\n)+)/g)].flatMap((match) => match[1].trim().split(/\s+/))
const roots = [...[...entries].map((root) => ({ kind: 'build', root })), ...testRoots.map((root) => ({ kind: 'test', root }))]

// Build outputs go to a scratch directory, removed on exit.
const scratch = mkdtempSync(join(tmpdir(), 'types-codemod-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const diagnostics = (target) => {
  const output = join(scratch, 'output')
  const args =
    target.kind === 'build'
      ? ['build', join(compiler, target.root), '-o', output, '--emit', 'llvm-ir', '--stdlib', stdlib]
      : ['test', join(compiler, target.root), '-o', output, '--stdlib', stdlib, '--no-cache']
  let text
  try {
    text = execFileSync(silkc, args, { cwd: join(compiler, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
  } catch (failure) {
    text = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  }
  return [...text.matchAll(/SILK_BUILD_ERROR=(\{.*\})/g)].map((match) => JSON.parse(match[1]))
}

// Named functions and closure literals: `pub`, `test`, `effect` and `effect<...>` prefixes.
const header = /(pub )?(test )?(effect(?:<[^>]*>)? )?fn( \w+|\()/g

// The offset of the `{` that opens the body of the header at `start`, and of its matching `}`.
const bodyOf = (text, start) => {
  let depth = 0
  let open = -1
  for (let at = start; at < text.length; at += 1) {
    const c = text[at]
    if (open === -1) {
      if (c === '(' || c === '<' || c === '[') depth += 1
      else if (c === ')' || c === '>' || c === ']') depth = Math.max(0, depth - 1)
      else if (c === '{' && depth === 0) { open = at; depth = 1 }
      continue
    }
    if (text.startsWith('"""', at)) { const end = text.indexOf('"""', at + 3); at = end === -1 ? text.length : end + 2 }
    else if (c === '"') { at += 1; while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1 }
    else if (c === '{') depth += 1
    else if (c === '}') { depth -= 1; if (depth === 0) return { open, close: at } }
  }
  return undefined
}

// The [start, end) ranges of the string literals and line comments in `text`.
const literals = (text) => {
  const ranges = []
  for (let at = 0; at < text.length; at += 1) {
    const start = at
    // A quote character literal, `'"'`, opens no string.
    if (text.startsWith(`'"'`, at)) { at += 2; continue }
    if (text.startsWith('//', at)) { const end = text.indexOf('\n', at); at = end === -1 ? text.length : end }
    else if (text.startsWith('"""', at)) { const end = text.indexOf('"""', at + 3); at = end === -1 ? text.length : end + 2 }
    else if (text[at] === '"') { at += 1; while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1 }
    else continue
    ranges.push([start, at + 1])
  }
  return ranges
}

// The innermost function or closure literal whose body contains `offset`: its header start, name
// (empty for a closure), whether it is a test, and the offset of the `{` that opens its body.
const enclosing = (text, offset) => {
  // Headers inside string literals, such as embedded test programs, are not functions here.
  const embedded = literals(text)
  let found
  for (const match of text.matchAll(header)) {
    if (match.index > offset) break
    if (embedded.some(([from, to]) => match.index >= from && match.index < to)) continue
    // An anonymous `fn(` is a closure literal only with `effect`; otherwise it is a type, and a pure
    // closure cannot need a requirement.
    if (match[4] === '(' && match[3] === undefined) continue
    const extent = bodyOf(text, match.index)
    if (extent === undefined || extent.open > offset || extent.close < offset) continue
    const name = match[4].startsWith(' ') ? match[4].trim() : ''
    found = { start: match.index, name, test: match[2] !== undefined, body: extent.open }
  }
  return found
}

// The edit declaring `| &mut Types` in the row of `fn`, or none when it is already declared.
const declaration = (text, fn) => {
  const head = text.slice(fn.start, fn.body)
  if (/&mut Types\b/.test(head)) return undefined
  const trimmed = head.replace(/\s+$/, '')
  return { at: fn.start + trimmed.length, text: head.lastIndexOf('?') > head.lastIndexOf('->') ? ' | &mut Types' : ' ? &mut Types', key: `row:${fn.start}` }
}

// The edits providing `fn`'s table to the run expression at `offset`: the provider beside its
// allocator provider, and the table itself beside the allocator.
const provision = (text, fn, offset) => {
  // The allocator provider of the statement holding `offset`, before the next statement starts.
  const allocatorAt = text.indexOf('|> Effect.provideMut<Allocator>(', offset)
  const next = /\n[ \t]*(let |return |run |if |while |\}(?![)\]]))/g
  next.lastIndex = offset
  const statement = next.exec(text)
  const statementEnd = statement === null ? text.length : statement.index
  if (allocatorAt === -1 || allocatorAt > statementEnd) {
    // A statement providing no allocator: the provider closes the statement.
    const end = offset + text.slice(offset, statementEnd).replace(/\s+$/, '').length
    return [{ at: end, text: ' |> Effect.provideMut<Types>(&mut typeTable)', key: `provide:${end}` }, ...tableDeclaration(text, fn)]
  }
  return [{ at: allocatorAt, text: '|> Effect.provideMut<Types>(&mut typeTable) ', key: `provide:${allocatorAt}` }, ...tableDeclaration(text, fn)]
}

// The edit declaring `fn`'s table beside its allocator, or none when it is declared.
const tableDeclaration = (text, fn) => {
  const edits = []
  const extent = bodyOf(text, fn.start)
  const body = text.slice(fn.body, extent === undefined ? text.length : extent.close)
  if (!/let mut typeTable = TypeTable\.make\(\)/.test(body)) {
    const allocator = /\n([ \t]*)let mut allocator = Allocator\.systemAllocatorProvider\(\)\n/.exec(body)
    if (allocator === null) edits.push({ at: fn.body + 1, text: '\n  let mut typeTable = TypeTable.make()', key: `table:${fn.start}` })
    else edits.push({ at: fn.body + allocator.index + allocator[0].length, text: `${allocator[1]}let mut typeTable = TypeTable.make()\n`, key: `table:${fn.start}` })
  }
  return edits
}

for (const target of roots) {
  for (let round = 1; ; round += 1) {
    const found = diagnostics(target)
    const actionable = found.filter((error) =>
      error.code === 'UnhandledRequirement' || error.code === 'UnknownName' || error.code === 'MissingProvidedKey')
    const other = found.filter((error) => !actionable.includes(error))
    console.log(`${target.root} round ${round}: ${actionable.length} sites, ${other.length} other errors`)
    if (actionable.length === 0) {
      if (other.length > 0) {
        for (const error of other) console.error(JSON.stringify(error))
        process.exit(1)
      }
      break
    }
    const byModule = new Map()
    for (const error of actionable) {
      if (!byModule.has(error.module)) byModule.set(error.module, [])
      byModule.get(error.module).push(error)
    }
    let changed = false
    for (const [module, errors] of byModule) {
      const path = join(src, module)
      const before = readFileSync(path, 'utf8')
      // Diagnostic spans are UTF-8 byte offsets; the edits index the decoded text.
      const bytes = Buffer.from(before, 'utf8')
      const character = (offset) => bytes.subarray(0, offset).toString('utf8').length
      for (const error of errors) error.span = { start: character(error.span.start), end: character(error.span.end) }
      const edits = new Map()
      const imports = new Set()
      for (const error of errors) {
        if (error.code === 'UnknownName') {
          const name = before.slice(error.span.start, error.span.end)
          if (name.startsWith('TypeTable')) imports.add('TypeTable')
          else if (name.startsWith('Types')) imports.add('Types')
          else if (name === 'typeTable') {
            // A provider whose table declaration is missing: declare it beside the allocator.
            const fn = enclosing(before, error.span.start)
            if (fn === undefined) throw new Error(`${module}:${error.span.start}: no enclosing function`)
            for (const edit of tableDeclaration(before, fn)) edits.set(edit.key, edit)
            imports.add('TypeTable')
          }
          continue
        }
        const fn = enclosing(before, error.span.start)
        if (fn === undefined) throw new Error(`${module}:${error.span.start}: no enclosing function`)
        if (fn.test || fn.name === 'main') {
          const provided = provision(before, fn, error.span.start)
          for (const edit of provided) edits.set(edit.key, edit)
          imports.add('TypeTable')
        } else {
          const declared = declaration(before, fn)
          if (declared !== undefined) edits.set(declared.key, declared)
          imports.add('Types')
        }
      }
      let text = before
      for (const edit of [...edits.values()].sort((a, b) => b.at - a.at)) text = text.slice(0, edit.at) + edit.text + text.slice(edit.at)
      for (const name of imports) text = ensureImport(text, name)
      if (text !== before) {
        writeFileSync(path, text)
        changed = true
      }
    }
    if (!changed) {
      for (const error of actionable) console.error(JSON.stringify(error))
      throw new Error(`${target.root}: no progress`)
    }
  }
}
console.log('Types threaded')
