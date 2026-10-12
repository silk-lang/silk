#!/usr/bin/env node
// Moves owner type arguments from `Owner.member<...>(...)` onto the owner (GEN-008).
//
//   node scripts/migrate-type-argument-placement.mjs [--write | --check] <file or directory>...
//
// Without --write it only reports. With --check it also exits nonzero when any site remains to be
// rewritten or reported, so a migrated tree prints `no sites` and exits zero. A site
// `Owner.member<Args>(` is rewritten when `Owner.member` is an inherent member or service operation
// of a generic owner and the written list starts with owner arguments: `Option.map<i32, i64>(f)`
// becomes `Option<i32>.map<i64>(f)`. Standard-library owners are classified from a semantic
// analysis of the stdlib (run `pnpm build` first). Owners declared in the file being migrated, such
// as test fixtures, are classified from their `impl` and `service` headers in that file, and shadow
// a standard-library owner of the same name there.
//
// A site whose rewrite would need an owner argument the call does not write is reported and left
// unchanged: a member that does not name every owner parameter, a written list that covers only
// part of the owner, or an owner with conflicting declarations in one file. In a TypeScript file
// only template literals, which hold the embedded Silk sources, are migrated. A site on a line
// whose `//` comment contains `invalid:` is an intentional counterexample and is left alone. The
// script is idempotent. Format rewritten `.silk` files with the native formatter afterwards.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Analysis from '../dist/Analysis.js'
import * as Stdlib from '../dist/Stdlib.js'

const isLifetimeName = (name) => name.startsWith("'")

// One classified member: the owner's binders in order and the ones the member's signature names.
const member = (binders, mentioned) => ({ binders, mentioned: new Set(mentioned) })

const stdlibMembers = Effect.gen(function* () {
  const root =
    Stdlib.manifest
      .map((entry, at) => `import ${entry.module.replaceAll('/', '.')} as stdlibModule${at}`)
      .join('\n') + '\npub fn main() -> i32 { return 0 }\n'
  const snapshot = yield* Analysis.ofSource(
    'main',
    new TextEncoder().encode(root),
    'x86_64-unknown-linux-gnu',
  )
  const index = Analysis.declarationIndex(snapshot)
  const members = new Map()
  const add = (key, entry) => members.set(key, [...(members.get(key) ?? []), entry])
  const binderName = (binder) =>
    binder.type.kind === 'Lifetime' ? binder.type.name : binder.type.name
  for (const headers of index.modules) {
    for (const fact of headers.declarations) {
      if (fact._tag !== 'FunctionDeclaration' || fact.associatedMember === undefined) continue
      const implementation = headers.inherentImpls.find(
        (candidate) => candidate.ordinal === fact.associatedMember.ordinal,
      )
      if (implementation === undefined || implementation.typeParameters.length === 0) continue
      const binders = implementation.typeParameters.map(binderName)
      const listed = new Set(fact.typeParameters.map(binderName))
      add(
        `${fact.associatedMember.ownerSpelling.replace(/<.*/s, '')}.${fact.associatedMember.name}`,
        member(
          binders,
          binders.filter((name) => listed.has(name)),
        ),
      )
    }
    for (const service of headers.services) {
      if (service.typeParameters.length === 0) continue
      const binders = service.typeParameters.map(binderName)
      const owner = service.name.spelling ?? service.name.value ?? service.name
      for (const operation of service.operations)
        add(`${owner}.${operation.name.spelling ?? operation.name}`, member(binders, binders))
    }
  }
  return members
})

// Splits a written argument list at top-level commas.
const split = (text) => {
  const parts = []
  let depth = 0
  let start = 0
  for (let at = 0; at < text.length; at++) {
    const c = text[at]
    if ('<([{'.includes(c)) depth++
    else if (c === '>' && text[at - 1] === '-') continue
    else if ('>)]}'.includes(c)) depth--
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, at))
      start = at + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

// The end of a balanced `<...>` list whose `<` precedes `from`, or -1.
const closeAngle = (text, from) => {
  let depth = 1
  for (let at = from; at < text.length; at++) {
    const c = text[at]
    if (c === '<') depth++
    else if (c === '>' && text[at - 1] !== '-') {
      depth--
      if (depth === 0) return at
    } else if (c === ';' || c === '{' || c === '}') return -1
  }
  return -1
}

const closeBrace = (text, open) => {
  let depth = 0
  for (let at = open; at < text.length; at++) {
    if (text[at] === '{') depth++
    else if (text[at] === '}' && --depth === 0) return at
  }
  return text.length
}

const identifiers = (text) => new Set(text.match(/'?[A-Za-z_][A-Za-z0-9_]*/g) ?? [])

// Owners declared in one file: `impl<Binders> Owner<...> { fn member<...>(...) ... }` and
// `service Owner<Binders> { ... fn operation(...) }`.
const localMembers = (text) => {
  const members = new Map()
  const add = (key, entry) => members.set(key, [...(members.get(key) ?? []), entry])
  const impl = /\bimpl<([^{]*?)>\s+([A-Z][A-Za-z0-9_]*)\s*<[^{]*?\{/g
  for (let match = impl.exec(text); match !== null; match = impl.exec(text)) {
    if (/\bfor\b/.test(match[0])) continue
    const binders = split(match[1]).map((binder) => binder.replace(/^\?/, '').split(/[\s:]/)[0])
    const body = text.slice(impl.lastIndex, closeBrace(text, impl.lastIndex - 1))
    const fn = /\bfn\s+([a-z_][A-Za-z0-9_]*)\s*(<[^(]*>)?\s*\(([^{]*)\{/g
    for (let item = fn.exec(body); item !== null; item = fn.exec(body)) {
      const signature = identifiers(`${item[2] ?? ''}(${item[3]}`)
      const mentions = signature.has('Self') || signature.has('self')
      add(
        `${match[2]}.${item[1]}`,
        member(
          binders,
          binders.filter((name) => mentions || signature.has(name)),
        ),
      )
    }
  }
  const service = /\bservice\s+([A-Z][A-Za-z0-9_]*)\s*<([^{]*?)>\s*\{/g
  for (let match = service.exec(text); match !== null; match = service.exec(text)) {
    const binders = split(match[2]).map((binder) => binder.replace(/^\?/, '').split(/[\s:]/)[0])
    const body = text.slice(service.lastIndex, closeBrace(text, service.lastIndex - 1))
    for (const item of body.matchAll(/\bfn\s+([a-z_][A-Za-z0-9_]*)/g))
      add(`${match[1]}.${item[1]}`, member(binders, binders))
  }
  return members
}

const sameMember = (left, right) =>
  left.binders.join() === right.binders.join() &&
  [...left.mentioned].join() === [...right.mentioned].join()

// A written list in the layout of the original: one line, or one argument per line.
const list = (items, layout) =>
  layout === undefined
    ? `<${items.join(', ')}>`
    : `<\n${items.map((item) => `${layout.indent}${item},`).join('\n')}\n${layout.close}>`

// The layout of a list spanning lines: its first argument's indentation and its `>`'s.
const layoutOf = (inner) => {
  if (!inner.includes('\n')) return undefined
  const lines = inner.split('\n')
  const first = lines.find((line) => line.trim().length > 0) ?? ''
  return { indent: first.match(/^\s*/)[0], close: lines.at(-1).match(/^\s*/)[0] }
}

// The rewrite of one site, or the reason it is reported.
const rewrite = (owner, name, written, entry, layout) => {
  const lifetimes = written.filter(isLifetimeName)
  const ordinary = written.filter((argument) => !isLifetimeName(argument))
  const ownerLifetimes = entry.binders.filter(isLifetimeName)
  const ownerOrdinary = entry.binders.filter((binder) => !isLifetimeName(binder))
  const namedLifetimes = ownerLifetimes.filter((binder) => entry.mentioned.has(binder))
  const namedOrdinary = ownerOrdinary.filter((binder) => entry.mentioned.has(binder))
  const writtenOwnerLifetimes = Math.min(lifetimes.length, namedLifetimes.length)
  const writtenOwnerOrdinary = Math.min(ordinary.length, namedOrdinary.length)
  if (writtenOwnerLifetimes === 0 && writtenOwnerOrdinary === 0) return { _tag: 'Unchanged' }
  if (writtenOwnerOrdinary < namedOrdinary.length)
    return { _tag: 'Reported', reason: 'incomplete-owner-arguments' }
  if (namedOrdinary.length < ownerOrdinary.length)
    return { _tag: 'Reported', reason: 'unmentioned-owner-parameter' }
  const keepLifetimes =
    writtenOwnerLifetimes === ownerLifetimes.length &&
    namedLifetimes.length === ownerLifetimes.length
  if (writtenOwnerLifetimes > 0 && !keepLifetimes)
    return { _tag: 'Reported', reason: 'unmentioned-owner-lifetime' }
  const ownerList = []
  let lifetimeAt = 0
  let ordinaryAt = 0
  for (const binder of entry.binders) {
    if (isLifetimeName(binder)) {
      if (keepLifetimes) ownerList.push(lifetimes[lifetimeAt++])
    } else ownerList.push(ordinary[ordinaryAt++])
  }
  const own = [...lifetimes.slice(writtenOwnerLifetimes), ...ordinary.slice(writtenOwnerOrdinary)]
  return {
    _tag: 'Rewritten',
    text: `${owner}${list(ownerList, layout)}.${name}${own.length > 0 ? list(own, layout) : ''}`,
  }
}

// The template-literal ranges of a TypeScript file, ignoring `${...}` substitutions' contents.
const templateRanges = (text) => {
  const ranges = []
  let start = -1
  let depth = 0
  for (let at = 0; at < text.length; at++) {
    const c = text[at]
    if (c === '\\') {
      at++
      continue
    }
    if (start < 0) {
      if (c === '`') start = at
    } else if (depth > 0) {
      if (c === '{') depth++
      else if (c === '}') depth--
    } else if (c === '$' && text[at + 1] === '{') {
      depth = 1
      at++
    } else if (c === '`') {
      ranges.push([start, at])
      start = -1
    }
  }
  return ranges
}

const files = (path) => {
  if (!statSync(path).isDirectory()) return /\.(silk|tsx?|md)$/.test(path) ? [path] : []
  return readdirSync(path).flatMap((entry) =>
    entry === 'node_modules' || entry === 'dist' ? [] : files(join(path, entry)),
  )
}

const program = Effect.gen(function* () {
  const write = process.argv.includes('--write')
  const check = process.argv.includes('--check')
  const roots = process.argv
    .slice(2)
    .filter((argument) => argument !== '--write' && argument !== '--check')
  const stdlib = yield* stdlibMembers
  const counts = new Map()
  const reported = []
  for (const file of roots.flatMap(files)) {
    const text = readFileSync(file, 'utf8')
    const local = localMembers(text)
    const ranges = /\.tsx?$/.test(file) ? templateRanges(text) : undefined
    const inSource = (at) =>
      ranges === undefined || ranges.some(([start, end]) => start < at && at < end)
    let output = ''
    let copied = 0
    const site = /(?<![A-Za-z0-9_.])([A-Z][A-Za-z0-9_]*)\.([a-z_][A-Za-z0-9_]*)</g
    for (let match = site.exec(text); match !== null; match = site.exec(text)) {
      const close = closeAngle(text, site.lastIndex)
      if (close < 0 || text[close + 1] !== '(' || !inSource(match.index)) continue
      const lineEnd = text.indexOf('\n', close)
      const rest = text.slice(close, lineEnd < 0 ? text.length : lineEnd)
      if (/\/\/.*invalid:/.test(rest)) continue
      const key = `${match[1]}.${match[2]}`
      const candidates = local.get(key) ?? stdlib.get(key)
      if (candidates === undefined) continue
      const line = text.slice(0, match.index).split('\n').length
      const location = `${relative(process.cwd(), file)}:${line}`
      const note = (category) => counts.set(category, (counts.get(category) ?? 0) + 1)
      if (!candidates.every((candidate) => sameMember(candidate, candidates[0]))) {
        note('ambiguous-owner')
        reported.push(`ambiguous-owner\t${location}\t${text.slice(match.index, close + 1)}`)
        continue
      }
      const inner = text.slice(site.lastIndex, close)
      const result = rewrite(match[1], match[2], split(inner), candidates[0], layoutOf(inner))
      if (result._tag === 'Unchanged') continue
      if (result._tag === 'Reported') {
        note(result.reason)
        reported.push(
          `${result.reason}\t${location}\t${text.slice(match.index, close + 1).replace(/\s+/g, ' ')}`,
        )
        continue
      }
      note('rewritten')
      output += text.slice(copied, match.index) + result.text
      copied = close + 1
      site.lastIndex = close + 1
    }
    if (write && copied > 0) writeFileSync(file, output + text.slice(copied))
  }
  const summary = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `${category}: ${count}`)
  process.stdout.write(
    [...reported, ...(summary.length === 0 ? ['no sites'] : summary)].join('\n') + '\n',
  )
  if (check && summary.length > 0) {
    process.stderr.write('check failed: unmigrated owner type arguments remain\n')
    process.exitCode = 1
  }
})

Effect.runPromise(program).catch((error) => {
  process.stderr.write(`${error}\n`)
  process.exit(1)
})
