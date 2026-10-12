#!/usr/bin/env node
// Routes every use of `Key.declaration` in `compiler/src/semantic/Semantic.silk` through the two
// accessors that incremental v2 slice 0 needs before the field can hold an interned declaration:
//
// - a read of a key's declaration as a position becomes `declarationPosition(key)`;
// - a `Key { ... }` literal becomes `internDeclaration(Key { ... })`.
//
// Identity uses stay raw, because they compare or copy whatever the field holds: `sameKey`,
// `sameExactKey`, `hashKey`, `dependency`, and a literal whose `declaration` copies another key's.
// In `sameDependency` the same binding names hold dependencies, not keys.
// Both accessors still return positions, so the rewrite changes no behavior.
//
// The rewrite is idempotent. After a conflict in Semantic.silk, take the other side and rerun:
//   node compiler/scripts/DeclarationAccessorCodemod.mjs
// `--check` exits nonzero when a site is not yet rewritten.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const path = join(dirname(fileURLToPath(import.meta.url)), '../src/semantic/Semantic.silk')
const check = process.argv.includes('--check')

// Bindings that hold a `Key` wherever `.declaration` is read from them in Semantic.silk.
const keyBindings = ['key', 'left', 'right', 'parent', 'existing', 'constant', 'context']
const rawFunctions = new Set(['sameKey', 'sameExactKey', 'hashKey', 'dependency', 'sameDependency'])

const accessors = `
// The declaration position a key names. Every read of a key's declaration as a position goes
// through here, so the key can later hold an interned declaration (incremental v2, slice 0).
// Rewritten by compiler/scripts/DeclarationAccessorCodemod.mjs.
fn declarationPosition(key: Key) -> usize {
  return key.declaration
}

// Every key that names a declaration by position is built through here, so the key can later
// intern it. A key that copies another key's declaration does not need it.
fn internDeclaration(key: Key) -> Key {
  return key
}
`
const anchor = 'impl Copy for Key {}\n'

const source = readFileSync(path, 'utf8')
let text = source
if (!text.includes('fn declarationPosition(key: Key)')) {
  if (!text.includes(anchor)) throw new Error('Semantic.silk: `impl Copy for Key {}` not found')
  text = text.replace(anchor, anchor + accessors)
}

// The end of the bracketed form opening at `open`, skipping string literals.
const closing = (value, open) => {
  let depth = 0
  for (let at = open; at < value.length; at += 1) {
    const c = value[at]
    if (c === '"') {
      at += 1
      while (at < value.length && value[at] !== '"') at += value[at] === '\\' ? 2 : 1
    } else if (c === '{' || c === '(' || c === '[') depth += 1
    else if (c === '}' || c === ')' || c === ']') {
      depth -= 1
      if (depth === 0) return at
    }
  }
  throw new Error(`unbalanced form at offset ${open}`)
}

// The value of the top-level `declaration:` field of the literal body `{ ... }`.
const declarationValue = (literal) => {
  let depth = 0
  for (let at = 0; at < literal.length; at += 1) {
    const c = literal[at]
    if (c === '{' || c === '(' || c === '[') depth += 1
    else if (c === '}' || c === ')' || c === ']') depth -= 1
    else if (depth === 1 && literal.startsWith('declaration:', at) && !/\w/.test(literal[at - 1])) {
      let end = at + 'declaration:'.length
      let inner = 0
      while (end < literal.length) {
        const d = literal[end]
        if (d === '{' || d === '(' || d === '[') inner += 1
        else if (d === '}' || d === ')' || d === ']') {
          if (inner === 0) break
          inner -= 1
        } else if (d === ',' && inner === 0) break
        end += 1
      }
      return { start: at + 'declaration:'.length, end, value: literal.slice(at + 'declaration:'.length, end).trim() }
    }
  }
  return undefined
}

const copiedDeclaration = new RegExp(`^(?:${keyBindings.join('|')})\\.declaration$`)

// Pass 1: literals. Edits are collected first, then applied from the end.
const edits = []
let literals = 0
const copiedFields = []
for (const match of text.matchAll(/(?<![\w.])Key \{/g)) {
  const start = match.index
  const before = text.slice(Math.max(0, start - 18), start)
  if (/(?:struct |impl |for |-> )$/.test(before)) continue
  const end = closing(text, start + 'Key '.length)
  const field = declarationValue(text.slice(start + 'Key '.length, end + 1))
  if (field !== undefined && copiedDeclaration.test(field.value)) {
    const offset = start + 'Key '.length
    copiedFields.push([offset + field.start, offset + field.end])
    continue
  }
  if (before.endsWith('internDeclaration(')) continue
  edits.push({ at: start, insert: 'internDeclaration(' }, { at: end + 1, insert: ')' })
  literals += 1
}

// Pass 2: position reads.
const functionStarts = [...text.matchAll(/^\s*(?:pub )?(?:test )?(?:effect )?fn (\w+)/gm)].map((m) => ({
  at: m.index,
  name: m[1],
}))
const enclosing = (at) => {
  let found = ''
  for (const entry of functionStarts) {
    if (entry.at > at) break
    found = entry.name
  }
  return found
}
const read = new RegExp(`(?<![\\w.])(${keyBindings.join('|')})\\.declaration\\b(?!\\s*:)`, 'g')
let reads = 0
for (const match of text.matchAll(read)) {
  const at = match.index
  if (rawFunctions.has(enclosing(at))) continue
  if (copiedFields.some(([from, to]) => at >= from && at < to)) continue
  if (text.slice(Math.max(0, at - 20), at).endsWith('declarationPosition(')) continue
  if (enclosing(at) === 'declarationPosition') continue
  reads += 1
  edits.push({ at, remove: match[0].length, insert: `declarationPosition(${match[1]})` })
}

edits.sort((a, b) => b.at - a.at)
for (const edit of edits) text = text.slice(0, edit.at) + edit.insert + text.slice(edit.at + (edit.remove ?? 0))

if (check) {
  if (text !== source) {
    console.error(`Semantic.silk: ${literals + reads} declaration accessor sites are not rewritten`)
    process.exit(1)
  }
} else {
  writeFileSync(path, text)
  console.log(`rewrote ${literals} literals and ${reads} reads`)
}
