#!/usr/bin/env node
// Spells the core storage types through the sealed `Intrinsic` namespace (INTR-005).
//
//   node scripts/migrate-intrinsic-storage-types.mjs [--write | --check] <file or directory>...
//
// Without --write it only reports. With --check it also exits nonzero when any site remains, so a
// migrated tree prints `no sites` and exits zero. A type position `RawBuffer<...>`, `Slot<...>` or
// `Allocation` becomes `Intrinsic.RawBuffer<...>`, `Intrinsic.Slot<...>` or `Intrinsic.Allocation`.
// Member calls such as `RawBuffer.fill(...)` and `Slot.view(...)` name the ordinary standard-library
// actors and are left alone, as is a name already qualified by any owner. `Allocation` is a type
// position only after `:`, `->`, `<`, `,`, `(`, `&`, `|` or `mut`. Only source text is migrated:
// `.silk` code outside `//` comments, `.ts` lines that are not `//` comments, and `silk` fences in
// `.md` files. A line whose `//` comment contains `invalid:` is an intentional counterexample and is
// left alone. The script is idempotent.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const generic = /(?<![\w.])(RawBuffer|Slot)</g
const allocation = /((?:[:<,(&|]|->|\bmut)\s*)Allocation\b(?![\w.{])/g

const rewriteCode = (code) =>
  code.replace(generic, 'Intrinsic.$1<').replace(allocation, '$1Intrinsic.Allocation')

// Splits a line at its first `//` that is not inside a string or byte-string literal.
const splitComment = (line) => {
  let quote = undefined
  for (let at = 0; at < line.length; at += 1) {
    const character = line[at]
    if (quote !== undefined) {
      if (character === '\\') at += 1
      else if (character === quote) quote = undefined
    } else if (character === '"' || character === '`') quote = character
    else if (character === '/' && line[at + 1] === '/') return [line.slice(0, at), line.slice(at)]
  }
  return [line, '']
}

const rewriteLine = (line, kind) => {
  if (kind === 'ts') {
    if (line.trimStart().startsWith('//')) return line
    return /\/\/.*invalid:/.test(line) ? line : rewriteCode(line)
  }
  const [code, comment] = splitComment(line)
  if (comment.includes('invalid:')) return line
  return rewriteCode(code) + comment
}

const rewriteFile = (text, kind) => {
  const lines = text.split('\n')
  let fenced = false
  return lines
    .map((line) => {
      if (kind !== 'md') return rewriteLine(line, kind)
      if (/^\s*```/.test(line)) {
        fenced = /^\s*```silk\b/.test(line)
        return line
      }
      return fenced ? rewriteLine(line, 'silk') : line
    })
    .join('\n')
}

const kindOf = (path) =>
  path.endsWith('.silk')
    ? 'silk'
    : path.endsWith('.ts')
      ? 'ts'
      : path.endsWith('.md')
        ? 'md'
        : undefined

const files = (path) => {
  if (statSync(path).isDirectory())
    return readdirSync(path)
      .filter((name) => name !== 'node_modules' && name !== 'dist' && !name.startsWith('.'))
      .flatMap((name) => files(join(path, name)))
  return kindOf(path) === undefined || path.endsWith('.generated.ts') ? [] : [path]
}

const flags = new Set(process.argv.slice(2).filter((argument) => argument.startsWith('--')))
const paths = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
let sites = 0
for (const path of paths.flatMap(files)) {
  const before = readFileSync(path, 'utf8')
  const after = rewriteFile(before, kindOf(path))
  if (after === before) continue
  const changed = before.split('\n').filter((line, at) => line !== after.split('\n')[at]).length
  sites += changed
  console.log(`${relative(process.cwd(), path)}: ${changed} line${changed === 1 ? '' : 's'}`)
  if (flags.has('--write')) writeFileSync(path, after)
}
console.log(sites === 0 ? 'no sites' : `${sites} line${sites === 1 ? '' : 's'}`)
if (flags.has('--check') && sites !== 0) process.exitCode = 1
