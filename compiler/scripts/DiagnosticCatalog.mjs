import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'

export class DiagnosticCatalogError extends Data.TaggedError('DiagnosticCatalogError') {}

export const CoverageSchema = Schema.Array(
  Schema.Struct({
    code: Schema.String,
    rules: Schema.Array(Schema.String),
    reason: Schema.String,
  }),
)

// Keep offsets while hiding comments and literals from brace matching. Catalog functions have
// a deliberately closed form; this guard rejects other implementations instead of interpreting Silk.
const mask = (source) =>
  source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g, (text) =>
    text.replace(/[^\n]/g, ' '),
  )

const bodyOf = (source, declaration) => {
  const masked = mask(source)
  const start = masked.search(declaration)
  if (start < 0) return undefined
  const opening = masked.indexOf('{', start)
  if (opening < 0) return undefined
  let depth = 1
  for (let index = opening + 1; index < masked.length; index++) {
    if (masked[index] === '{') depth++
    if (masked[index] === '}') depth--
    if (depth === 0) return source.slice(opening + 1, index)
  }
  return undefined
}

/** The escapes a Silk string literal in the catalog may use. */
const escapes = { n: '\n', t: '\t' }

const enumMembers = (source, name) => {
  const body = bodyOf(source, new RegExp(`^\\s*pub enum ${name}\\s*\\{`, 'm'))
  return body === undefined ? [] : [...mask(body).matchAll(/\b(\w+)\s*,/g)].map((match) => match[1])
}

/** The Silk string literal at the start of `text`, decoded. */
const silkString = (text) => {
  const match = /^"((?:\\.|[^"\\])*)"/.exec(text)
  if (match === null) return undefined
  return (match[1] ?? '').replace(/\\(.)/g, (_text, escaped) => escapes[escaped] ?? escaped)
}

/** The arms of a function that is one exhaustive `return match` over `enumName`. */
const matchArms = (source, functionName, issues) => {
  const body = bodyOf(source, new RegExp(`^\\s*(?:pub )?fn ${functionName}\\s*\\(`, 'm'))
  const match = body?.match(/^\s*return\s+match\s+\w+\s*\{([\s\S]*)\}\s*$/)
  if (match === undefined || match === null) {
    issues.push(`${functionName}: expected one exhaustive return match`)
    return ''
  }
  return match[1] ?? ''
}

/** Maps each `Enum.Member` to the `Code` it reports, or to null for a refusal. */
const catalogArms = (source, functionName, enumName, issues) => {
  const arms = []
  const content = matchArms(source, functionName, issues)
  const remainder = content.replace(
    new RegExp(
      `^[ \\t]*${enumName}\\.(\\w+)\\s*=>\\s*Option<\\s*Code\\s*>\\.(?:some\\(\\s*Code\\.(\\w+),?\\s*\\)|none\\(\\))[ \\t]*$`,
      'gm',
    ),
    (_text, member, code) => {
      arms.push({ member, code: code ?? null })
      return ''
    },
  )
  if (mask(remainder).trim().length > 0) issues.push(`${functionName}: default or non-catalog arm`)
  return arms
}

/** The native catalog of compiler/src/diagnostic/Catalog.silk, by `Code` member. */
const nativeCatalog = (source, issues) => {
  const entries = new Map()
  for (const member of enumMembers(source, 'Code'))
    entries.set(member, { spelling: undefined, meaning: undefined, templates: [] })
  const literalArms = (functionName, field) => {
    const content = matchArms(source, functionName, issues)
    for (const match of content.matchAll(/^[ \t]*Code\.(\w+)\s*=>\s*(".*)$/gm)) {
      const entry = entries.get(match[1] ?? '')
      if (entry === undefined) issues.push(`${functionName}: unknown member ${match[1]}`)
      else entry[field] = silkString(match[2] ?? '')
    }
  }
  literalArms('spelling', 'spelling')
  literalArms('meaning', 'meaning')
  const templates = matchArms(source, 'template', issues)
  for (const match of templates.matchAll(
    /^([ \t]*)Code\.(\w+)\s*=>\s*(?:(".*)|\{([\s\S]*?)^\1\})$/gm,
  )) {
    const entry = entries.get(match[2] ?? '')
    if (entry === undefined) {
      issues.push(`template: unknown member ${match[2]}`)
      continue
    }
    if (match[3] !== undefined) entry.templates = [silkString(match[3])]
    else {
      const block = match[4] ?? ''
      const chosen = [...block.matchAll(/if choice == (\d+) \{\s*return (".*")\s*\}/g)].map(
        ([, ordinal, literal]) => ({ ordinal: Number(ordinal), text: silkString(literal ?? '') }),
      )
      const fallback = /^[ \t]*return (".*)$/m.exec(
        block.replace(/if choice == \d+ \{\s*return ".*"\s*\}/g, ''),
      )
      entry.templates = [
        silkString(fallback?.[1] ?? ''),
        ...chosen.sort((left, right) => left.ordinal - right.ordinal).map((choice) => choice.text),
      ]
      chosen.forEach((choice, index) => {
        if (choice.ordinal !== index + 1)
          issues.push(`template: ${match[2]} skips choice ${index + 1}`)
      })
    }
  }
  return entries
}

/** Checks semantic identity as well as code membership; a different valid code is still wrong. */
export const verify = ({ catalog, rejection, lexical, staticExecution, references, coverage }) => {
  const issues = []
  const native = nativeCatalog(catalog, issues)
  if (native.size === 0) issues.push('native catalog is empty')
  const holders = new Set()
  const spellings = new Map()
  for (const [member, entry] of native) {
    if (entry.spelling === undefined || !/^[A-Z]{3}[0-9]{4}$/.test(entry.spelling)) {
      issues.push(`Code.${member}: no stable spelling`)
      continue
    }
    if (holders.has(entry.spelling)) issues.push(`duplicate catalog code ${entry.spelling}`)
    holders.add(entry.spelling)
    spellings.set(member, entry.spelling)
    if (entry.meaning === undefined || entry.meaning.trim().length === 0)
      issues.push(`Code.${member}: no meaning`)
    if (entry.templates.length === 0 || entry.templates.some((text) => text.trim().length === 0))
      issues.push(`Code.${member}: missing nonempty message template`)
  }

  const used = new Set()
  const checkCode = (owner, member) => {
    const code = spellings.get(member)
    if (code === undefined) issues.push(`${owner}: unknown catalog code Code.${member}`)
    else used.add(code)
  }
  const reported = (source, functionName, enumName, members) => {
    const arms = catalogArms(source, functionName, enumName, issues)
    if (arms.length === 0) issues.push(`${functionName}: code table is empty`)
    const named = new Set()
    for (const arm of arms) {
      if (named.has(arm.member)) issues.push(`${functionName}: duplicate arm ${arm.member}`)
      if (!members.includes(arm.member)) issues.push(`${functionName}: unknown arm ${arm.member}`)
      named.add(arm.member)
      if (arm.code !== null) checkCode(`${enumName}.${arm.member}`, arm.code)
    }
    for (const member of members)
      if (!named.has(member)) issues.push(`${functionName}: missing arm ${member}`)
  }
  const members = enumMembers(rejection, 'RejectionCode')
  if (members.length === 0) issues.push('RejectionCode enum is empty or absent')
  reported(rejection, 'catalogCode', 'RejectionCode', members)

  // Lexical output records its semantic reason beside the code it reports.
  const lexicalMembers = bodyOf(lexical, /^\s*pub union LexicalDiagnostic\s*\{/m)
  const lexicalReasons = new Set()
  const lexicalArms = [...lexical.matchAll(/run writeLine\(\s*Code\.(\w+),\s*"(\w+)"/g)]
  if (lexicalArms.length === 0) issues.push('lexical code table is empty')
  for (const [, member, reason] of lexicalArms) {
    if (lexicalReasons.has(reason)) issues.push(`duplicate lexical reason ${reason}`)
    if (member !== reason) issues.push(`lexical reason ${reason} reports Code.${member}`)
    lexicalReasons.add(reason)
    checkCode(reason, member)
  }
  if (lexicalMembers === undefined) issues.push('LexicalDiagnostic union is absent')
  else
    for (const [, member] of lexicalMembers.matchAll(/^[ \t]+(\w+)\s*\{/gm))
      if (!lexicalReasons.has(member)) issues.push(`missing lexical reason ${member}`)
  const faults = enumMembers(staticExecution, 'Fault')
  if (faults.length === 0) issues.push('static Fault enum is empty or absent')
  reported(staticExecution, 'faultCatalogCode', 'Fault', faults)

  const rules = new Set(['reference/index.md'])
  for (const heading of references.split('\n').filter((line) => line.startsWith('#')))
    for (const [rule] of heading.matchAll(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3}\b/g))
      rules.add(rule)
  const gaps = new Set()
  for (const gap of coverage) {
    if (gaps.has(gap.code)) issues.push(`duplicate coverage gap ${gap.code}`)
    if (!holders.has(gap.code)) issues.push(`coverage gap has unknown code ${gap.code}`)
    if (used.has(gap.code)) issues.push(`covered code still listed as a gap: ${gap.code}`)
    if (gap.rules.length === 0 || gap.rules.some((rule) => rule.trim().length === 0))
      issues.push(`${gap.code}: coverage gap has no reference rule`)
    for (const rule of gap.rules)
      if (!rules.has(rule)) issues.push(`${gap.code}: unknown reference rule ${rule}`)
    if (gap.reason.trim().length === 0) issues.push(`${gap.code}: coverage gap has no explanation`)
    gaps.add(gap.code)
  }
  for (const code of holders)
    if (!used.has(code) && !gaps.has(code))
      issues.push(`${code}: no native producer or explicit gap`)
  return issues
}

/** Reads only the consuming checkout; no network, compiler build, or generated-file mutation. */
export const check = Effect.fn('DiagnosticCatalog.check')(function* () {
  const fs = yield* FileSystem.FileSystem
  const referenceDirectory = 'reference'
  const referenceFiles = yield* fs.readDirectory(referenceDirectory)
  const references = yield* Effect.forEach(
    referenceFiles.filter((file) => file.endsWith('.md')),
    (file) => fs.readFileString(`${referenceDirectory}/${file}`),
  )
  const sources = yield* Effect.all({
    catalog: fs.readFileString('compiler/src/diagnostic/Catalog.silk'),
    rejection: fs.readFileString('compiler/src/semantic/Rejection.silk'),
    lexical: fs.readFileString('compiler/src/lexer/LexicalDiagnostic.silk'),
    staticExecution: fs.readFileString('compiler/src/semantic/StaticExecution.silk'),
    coverage: fs
      .readFileString('compiler/diagnostic-coverage.json')
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CoverageSchema)))),
  })
  const issues = verify({ ...sources, references: references.join('\n') })
  if (issues.length > 0) return yield* new DiagnosticCatalogError({ issues })
  return yield* Console.log('Native diagnostic catalog is complete')
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const require = createRequire(new URL('../../package.json', import.meta.url))
  /** @type {{ NodeServices: {layer: import('effect/Layer').Layer<import('effect/FileSystem').FileSystem>} }} */
  const { NodeServices } = await import(
    pathToFileURL(require.resolve('@effect/platform-node')).href
  )
  await Effect.runPromise(check().pipe(Effect.provide(NodeServices.layer)))
}
