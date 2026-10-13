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

const enumMembers = (source, name) => {
  const body = bodyOf(source, new RegExp(`^\\s*pub enum ${name}\\s*\\{`, 'm'))
  return body === undefined ? [] : [...mask(body).matchAll(/\b(\w+)\s*,/g)].map((match) => match[1])
}

const annotatedArms = (source, functionName, enumName, issues) => {
  const body = bodyOf(source, new RegExp(`^\\s*(?:pub )?fn ${functionName}\\s*\\(`, 'm'))
  const match = body?.match(/^\s*return\s+match\s+\w+\s*\{([\s\S]*)\}\s*$/)
  if (match === undefined || match === null) {
    issues.push(`${functionName}: expected one exhaustive return match`)
    return []
  }
  const arms = []
  const expression = new RegExp(
    `^[ \\t]*// (bootstrap|native): (\\w+Code)\\s+${enumName}\\.(\\w+)\\s*=>\\s*b"([A-Z]{3}[0-9]{4})"`,
    'gm',
  )
  const content = match[1].replace(/\/\*[\s\S]*?\*\//g, '')
  const remainder = content.replace(expression, (_text, classification, symbol, member, code) => {
    arms.push({ classification, symbol, member, code })
    return ''
  })
  if (mask(remainder).trim().length > 0)
    issues.push(`${functionName}: unannotated, default, or nonliteral arm`)
  return arms
}

/** Checks semantic identity as well as code membership; a different valid code is still wrong. */
export const verify = ({
  bootstrap,
  rejection,
  lexical,
  staticExecution,
  documentation,
  references,
  coverage,
}) => {
  const issues = []
  const constants = new Map()
  const holders = new Map()
  for (const match of bootstrap.matchAll(
    /export const (\w+Code) = '([A-Z]{3}[0-9]{4})' as const/g,
  )) {
    const [, symbol, code] = match
    if (constants.has(symbol)) issues.push(`duplicate bootstrap constant ${symbol}`)
    if (holders.has(code)) issues.push(`duplicate catalog code ${code}`)
    constants.set(symbol, code)
    holders.set(code, symbol)
    const factory = new RegExp(
      `\\bcode: ${symbol},(?:(?!\\bcode:|\\n\\}).){0,600}?\\bmessage:\\s*([^\\n]+)`,
      's',
    )
    const message = bootstrap.match(factory)?.[1]?.trim()
    if (message === undefined || /^(?:''|""|``)(?:\s*[,}]|\s*$)/.test(message))
      issues.push(`${code}: missing nonempty message template`)
  }
  if (constants.size === 0) issues.push('bootstrap catalog is empty')

  const documented = new Set()
  for (const match of documentation.matchAll(/^\| `([A-Z]{3}[0-9]{4})` \| (.*)$/gm)) {
    const [, code, row] = match
    if (documented.has(code)) issues.push(`duplicate documentation code ${code}`)
    if (!holders.has(code)) issues.push(`undocumented catalog declaration for ${code}`)
    if (!/`[^`]+`/.test(row)) issues.push(`${code}: documentation has no message template`)
    documented.add(code)
  }
  for (const code of holders.keys())
    if (!documented.has(code)) issues.push(`${code}: missing generated documentation row`)

  const used = new Set()
  const checkCode = (member, symbol, code) => {
    const expected = constants.get(symbol)
    if (expected === undefined) issues.push(`${member}: unregistered bootstrap constant ${symbol}`)
    else if (expected !== code)
      issues.push(`${member}: ${code} differs from ${symbol} (${expected})`)
    if (!holders.has(code)) issues.push(`${member}: unregistered code ${code}`)
    used.add(code)
  }
  const members = enumMembers(rejection, 'RejectionCode')
  if (members.length === 0) issues.push('RejectionCode enum is empty or absent')
  const arms = annotatedArms(rejection, 'stableCode', 'RejectionCode', issues)
  const named = new Set()
  for (const arm of arms) {
    if (named.has(arm.member)) issues.push(`duplicate native arm ${arm.member}`)
    if (!members.includes(arm.member)) issues.push(`unknown native arm ${arm.member}`)
    named.add(arm.member)
    checkCode(arm.member, arm.symbol, arm.code)
  }
  for (const member of members) if (!named.has(member)) issues.push(`missing native arm ${member}`)

  // Lexical output already records its semantic reason beside the numeric code.
  const lexicalMembers = bodyOf(lexical, /^\s*pub union LexicalDiagnostic\s*\{/m)
  const lexicalReasons = new Set()
  const lexicalArms = [...lexical.matchAll(/run writeLine\(\s*"([A-Z]{3}[0-9]{4})",\s*"(\w+)"/g)]
  if (lexicalArms.length === 0) issues.push('lexical code table is empty')
  for (const [, code, reason] of lexicalArms) {
    if (lexicalReasons.has(reason)) issues.push(`duplicate lexical reason ${reason}`)
    lexicalReasons.add(reason)
    checkCode(reason, `${reason.slice(0, 1).toLowerCase()}${reason.slice(1)}Code`, code)
  }
  if (lexicalMembers === undefined) issues.push('LexicalDiagnostic union is absent')
  else
    for (const [, member] of lexicalMembers.matchAll(/^[ \t]+(\w+)\s*\{/gm))
      if (!lexicalReasons.has(member)) issues.push(`missing lexical reason ${member}`)
  const staticArms = annotatedArms(staticExecution, 'faultCode', 'Fault', issues)
  if (staticArms.length === 0) issues.push('static fault code table is empty')
  const faults = enumMembers(staticExecution, 'Fault')
  const staticReasons = new Set()
  if (faults.length === 0) issues.push('static Fault enum is empty or absent')
  for (const arm of staticArms) {
    if (staticReasons.has(arm.member)) issues.push(`duplicate static fault ${arm.member}`)
    if (!faults.includes(arm.member)) issues.push(`unknown static fault ${arm.member}`)
    staticReasons.add(arm.member)
    checkCode(`Fault.${arm.member}`, arm.symbol, arm.code)
  }
  for (const fault of faults)
    if (!staticReasons.has(fault)) issues.push(`missing static fault ${fault}`)

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
  for (const code of holders.keys())
    if (!used.has(code) && !gaps.has(code))
      issues.push(`${code}: no native producer or explicit gap`)
  return issues
}

/** Reads only the consuming checkout; no network, compiler build, or generated-file mutation. */
export const check = Effect.fn('DiagnosticCatalog.check')(function* () {
  const fs = yield* FileSystem.FileSystem
  const referenceDirectory = 'apps/docs/content/reference'
  const referenceFiles = yield* fs.readDirectory(referenceDirectory)
  const references = yield* Effect.forEach(
    referenceFiles.filter((file) => file.endsWith('.md')),
    (file) => fs.readFileString(`${referenceDirectory}/${file}`),
  )
  const sources = yield* Effect.all({
    bootstrap: fs.readFileString('packages/compiler/src/Diagnostic.ts'),
    rejection: fs.readFileString('compiler/src/semantic/Rejection.silk'),
    lexical: fs.readFileString('compiler/src/lexer/LexicalDiagnostic.silk'),
    staticExecution: fs.readFileString('compiler/src/semantic/StaticExecution.silk'),
    documentation: fs.readFileString('apps/docs/content/language/diagnostics.md'),
    coverage: fs
      .readFileString('compiler/diagnostic-coverage.json')
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CoverageSchema)))),
  })
  const issues = verify({ ...sources, references: references.join('\n') })
  if (issues.length > 0) return yield* new DiagnosticCatalogError({ issues })
  return yield* Console.log('Native diagnostic catalog agrees with bootstrap and documentation')
})

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url))
  /** @type {{ NodeServices: {layer: import('effect/Layer').Layer<import('effect/FileSystem').FileSystem>} }} */
  const { NodeServices } = await import(
    pathToFileURL(require.resolve('@effect/platform-node')).href
  )
  await Effect.runPromise(check().pipe(Effect.provide(NodeServices.layer)))
}
