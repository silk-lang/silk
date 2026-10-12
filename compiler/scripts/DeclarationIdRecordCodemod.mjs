#!/usr/bin/env node
// Migrates Silk sources in compiler/src to the shared-record DeclarationId (incremental v2 slice 0,
// step 2a). Copying an identity no longer allocates, so these calls are pure:
//
// - `DeclarationId.copy`, `DeclarationId.copyShared` and `Application.copyBodyDeclaration` lose a
//   leading `run` and any `|> Effect.provideMut<Allocator>(...)` piped after the call.
//
// It also lists the removed borrowing accessors, which need a by-hand conversion:
//
// - `DeclarationId.spelling(x)` and `DeclarationId.ownerName(x, i)` borrowed bytes that cannot
//   leave the shared record. Compare with `named`, `ownerNamedAs`, `sameSpelling` or
//   `sameOwnerName`; read with `withSpelling` or `withOwnerName`; copy with `copySpelling` or
//   `copyOwnerName`.
// - `chainLength`, `fillChain`, `fromChain` and `project` are gone; `DeclarationId.copy` replaces
//   them.
//
// The rewrite is idempotent. After merging selfhost into a branch, run it and fix what it lists:
//   node compiler/scripts/DeclarationIdRecordCodemod.mjs
// `--check` exits nonzero while a site needs rewriting or a removed accessor remains.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../src')
const check = process.argv.includes('--check')

const pure = /(DeclarationId\.copy(?:Shared)?|Application\.copyBodyDeclaration)\(/g
const removed = /DeclarationId\.(spelling|ownerName|chainLength|fillChain|fromChain|project)\(/g

const sources = (directory) =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith('.silk') ? [path] : []
  })

// The offset just past the call whose argument list opens at `open`.
const callEnd = (text, open) => {
  let depth = 0
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === '(') depth += 1
    else if (text[at] === ')') {
      depth -= 1
      if (depth === 0) return at + 1
    }
  }
  throw new Error(`unbalanced call at offset ${open}`)
}

let rewritten = 0
const remaining = []
for (const path of sources(root)) {
  const name = relative(root, path)
  if (name === 'semantic/DeclarationId.silk') continue
  const source = readFileSync(path, 'utf8')
  const edits = []
  for (const match of source.matchAll(pure)) {
    const start = match.index
    const before = source.slice(Math.max(0, start - 4), start)
    if (before === 'run ') edits.push({ from: start - 4, to: start, text: '' })
    const end = callEnd(source, start + match[0].length - 1)
    const piped = /^\s*\|>\s*Effect\.provideMut<Allocator>\([^()]*\)/.exec(source.slice(end))
    if (piped !== null) edits.push({ from: end, to: end + piped[0].length, text: '' })
  }
  edits.sort((a, b) => b.from - a.from)
  let text = source
  for (const edit of edits) text = text.slice(0, edit.from) + edit.text + text.slice(edit.to)
  rewritten += edits.length
  for (const match of text.matchAll(removed)) {
    remaining.push(`${name}:${text.slice(0, match.index).split('\n').length}: DeclarationId.${match[1]}`)
  }
  if (!check && text !== source) writeFileSync(path, text)
}

for (const line of remaining) console.error(line)
if (check) {
  if (rewritten > 0 || remaining.length > 0) {
    console.error(`${rewritten} pure DeclarationId copies to rewrite, ${remaining.length} removed accessors to convert`)
    process.exit(1)
  }
} else {
  console.log(`rewrote ${rewritten} sites; ${remaining.length} removed accessors need a by-hand conversion`)
  if (remaining.length > 0) process.exit(1)
}
