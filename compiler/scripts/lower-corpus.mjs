// One prebuilt native compiler, many lowered modules. No per-file compiler invocations, no
// bootstrap import: every assertion here is a property of the self-hosted dump alone.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'

assert.ok(
  process.argv[2],
  'Usage: node compiler/scripts/lower-corpus.mjs <built-executable> [source-files...]',
)
const executable = resolve(process.argv[2])

const filesUnder = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return filesUnder(path)
    return path.endsWith('.silk') ? [path] : []
  })

function sourceFiles() {
  if (process.argv.length > 3) return process.argv.slice(3)
  return [
    ...filesUnder('compiler/fixtures'),
    // The source-written parser tests run explicitly and are not part of this corpus.
    ...filesUnder('compiler/src').filter((file) => file !== 'compiler/src/parser/ParserCases.silk'),
    ...filesUnder('stdlib/silk'),
  ]
}

// `Hir.writeQuotedText` escapes `"`, `\`, and the line breaks, so a quoted value never leaves its
// line and never closes early. Reading one back is the inverse of that escape.
function readQuoted(text, from) {
  assert.equal(text[from], '"', `quoted value at ${from}`)
  let value = ''
  let index = from + 1
  while (index < text.length) {
    const character = text[index]
    if (character === '"') return { value, end: index + 1 }
    if (character !== '\\') {
      value += character
      index += 1
      continue
    }
    const escaped = text[index + 1]
    const decoded = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }[escaped]
    assert.ok(decoded !== undefined, `known escape \\${escaped} at ${index}`)
    value += decoded
    index += 2
  }
  assert.fail(`unterminated quoted value at ${from}`)
}

// A field value is one of: `#id`, `none`, `[#a #b]`, `start..end`, a quoted symbol, an owner key
// (`Kind "name" #occurrence`), a boolean, a magnitude, or an enum spelling. Only the identities
// matter to the invariants, so the reader returns those and keeps the rest as text.
function readValue(text) {
  const references = []
  const symbols = []
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (character === '"') {
      const { value, end } = readQuoted(text, index)
      symbols.push(value)
      index = end
      continue
    }
    if (character === '#') {
      const match = /^#(\d+)/.exec(text.slice(index))
      assert.ok(match, `identity after # at ${index}: ${text}`)
      references.push(Number(match[1]))
      index += match[0].length
      continue
    }
    index += 1
  }
  return { references, symbols, text }
}

// `Kind "name" #occurrence`, or `Kind anonymous #occurrence` for a declaration with no name.
function readOwner(text, where) {
  const match = /^(\w+) (".*"|anonymous) #(\d+)$/.exec(text)
  assert.ok(match, `${where}: unreadable owner key: ${text}`)
  const symbols = match[2] === 'anonymous' ? [] : [readQuoted(match[2], 0).value]
  return { references: [], symbols, text }
}

function decode(output, sourceLength, file) {
  const lines = output.split('\n')
  const nodes = []
  const causes = []
  const diagnostics = []
  const violations = []
  let documentation
  let declarations
  let section = 'header'
  let current
  const counts = new Map()
  for (const [lineNumber, line] of lines.entries()) {
    const where = `${file}:dump line ${lineNumber + 1}`
    if (line === '') continue
    let match
    if (section === 'header' && line.startsWith('documentation ')) {
      const rest = line.slice('documentation '.length)
      documentation = rest === 'none' ? undefined : readQuoted(rest, 0).value
      continue
    }
    if (section === 'header' && line.startsWith('declarations ')) {
      declarations = readValue(line.slice('declarations '.length)).references
      continue
    }
    if ((match = /^(nodes|causes|diagnostics|fingerprints|violations) (\d+)$/.exec(line))) {
      section = match[1]
      counts.set(section, Number(match[2]))
      current = undefined
      continue
    }
    if (section === 'nodes') {
      if ((match = /^#(\d+) (\w+) (\d+)\.\.(\d+)$/.exec(line))) {
        assert.equal(Number(match[1]), nodes.length, `${where}: identities are arena indices`)
        current = {
          kind: match[2],
          start: Number(match[3]),
          end: Number(match[4]),
          causes: [],
          fields: new Map(),
        }
        assert.ok(current.start <= current.end, `${where}: ordered span`)
        assert.ok(current.end <= sourceLength, `${where}: span addresses source bytes`)
        nodes.push(current)
        continue
      }
      assert.ok(current, `${where}: a field precedes its node`)
      match = /^ {2}([A-Za-z]\w*): (.*)$/.exec(line)
      assert.ok(match, `${where}: unreadable field line: ${line}`)
      // An owner key ends in `#<occurrence>`, which counts same-key siblings and is not an arena
      // identity; the generic reader would otherwise mistake it for a child.
      const value = match[1] === 'owner' ? readOwner(match[2], where) : readValue(match[2])
      if (match[1] === 'causes') current.causes = value.references
      else {
        assert.ok(!current.fields.has(match[1]), `${where}: one entry per field`)
        current.fields.set(match[1], value)
      }
      continue
    }
    if (section === 'causes' || section === 'diagnostics') {
      match = /^#(\d+) (\w+) (\d+)\.\.(\d+)$/.exec(line)
      assert.ok(match, `${where}: unreadable ${section} line: ${line}`)
      const record = { code: match[2], start: Number(match[3]), end: Number(match[4]) }
      assert.ok(record.start <= record.end, `${where}: ordered span`)
      assert.ok(record.end <= sourceLength, `${where}: span addresses source bytes`)
      const target = section === 'causes' ? causes : diagnostics
      assert.equal(Number(match[1]), target.length, `${where}: ${section} are storage indices`)
      target.push(record)
      continue
    }
    if (section === 'fingerprints') {
      assert.ok(
        /^ {2}\w+ (".*"|anonymous) #\d+ [0-9a-f]{64} [0-9a-f]{64}$/.test(line),
        `${where}: unreadable fingerprint line: ${line}`,
      )
      continue
    }
    if (section === 'violations') {
      match = /^#(\d+) (\w+)$/.exec(line)
      assert.ok(match, `${where}: unreadable violation line: ${line}`)
      violations.push({ id: Number(match[1]), violation: match[2] })
      continue
    }
    assert.fail(`${where}: unreadable line outside every section: ${line}`)
  }
  assert.equal(section, 'violations', `${file}: the dump ends with its violation section`)
  assert.notEqual(declarations, undefined, `${file}: the dump names its declaration range`)
  assert.deepEqual(
    {
      nodes: nodes.length,
      causes: causes.length,
      diagnostics: diagnostics.length,
      violations: violations.length,
    },
    {
      nodes: counts.get('nodes'),
      causes: counts.get('causes'),
      diagnostics: counts.get('diagnostics'),
      violations: counts.get('violations'),
    },
    `${file}: every section holds the number of entries it announces`,
  )
  return { nodes, causes, diagnostics, violations, declarations, documentation }
}

// `IdentifierExpression.binding` names the binder an identifier resolves to. It is the one
// reference that is not an ownership edge: a binder is owned by the parameter list, block, or
// pattern that declares it and is pointed at by every identifier that reads it, so a traversal
// that followed it would reach the binder more than once and call the arena cyclic.
const isResolution = (kind, field) => kind === 'IdentifierExpression' && field === 'binding'

// The four node kinds a binder can be, from the declaration sites: a callable parameter, a `let`,
// a pattern binding, and the bare `Name` a `static for` binds because postorder means its own
// statement node does not exist yet.
const BINDER_KINDS = new Set(['Parameter', 'BindingStatement', 'BindingPattern', 'Name'])

// The flat-arena invariants the lowering promises, checked against the dump rather than against
// the arena: identities precede their parent, every node is reached exactly once from the
// declaration range, every span exists, and every reference lands inside its storage.
function checkInvariants(dump, file) {
  const { nodes, causes, declarations, violations } = dump
  assert.deepEqual(violations, [], `${file}: the module's own verifier reports no defect`)
  for (const [id, node] of nodes.entries()) {
    for (const [name, value] of node.fields) {
      for (const reference of value.references) {
        assert.ok(
          reference < id,
          `${file}: #${id}.${name} refers to #${reference}, which does not precede it`,
        )
      }
    }
    for (const cause of node.causes) {
      assert.ok(cause < causes.length, `${file}: #${id} refers to cause #${cause}`)
    }
    const binding = node.kind === 'IdentifierExpression' ? node.fields.get('binding') : undefined
    for (const binder of binding?.references ?? []) {
      assert.ok(
        BINDER_KINDS.has(nodes[binder].kind),
        `${file}: #${id} resolves to #${binder} ${nodes[binder].kind}, which binds nothing`,
      )
    }
    if (node.kind.startsWith('Missing') || node.kind.startsWith('Invalid')) {
      assert.ok(node.causes.length > 0, `${file}: #${id} ${node.kind} records no cause`)
    }
  }
  for (const declaration of declarations) {
    assert.ok(declaration < nodes.length, `${file}: declaration #${declaration} leaves the arena`)
    assert.equal(
      nodes[declaration].kind,
      'Declaration',
      `${file}: #${declaration} is a declaration`,
    )
  }
  // Reachability: one traversal from the declaration range must reach every node exactly once,
  // which is what makes the arena a forest of the declarations rather than a bag with orphans.
  const parents = Array.from({ length: nodes.length })
  // Iterative, because a long expression chain lowers to an equally long reference chain and the
  // standard library holds modules deep enough to exhaust the JavaScript stack.
  const pending = declarations.map((declaration) => [declaration, 'the module'])
  while (pending.length > 0) {
    const [id, parent] = pending.pop()
    assert.equal(
      parents[id],
      undefined,
      `${file}: #${id} is reached from #${parent} and from #${parents[id]}`,
    )
    parents[id] = parent
    for (const [name, value] of nodes[id].fields) {
      if (isResolution(nodes[id].kind, name)) continue
      for (const reference of value.references) pending.push([reference, id])
    }
  }
  const orphans = parents.flatMap((parent, id) => (parent === undefined ? [id] : []))
  assert.deepEqual(
    orphans.map((id) => `#${id} ${nodes[id].kind}`),
    [],
    `${file}: every node is reached from the declaration range`,
  )
  for (const [id, node] of nodes.entries()) {
    if (parents[id] === 'the module') continue
    const parent = nodes[parents[id]]
    assert.ok(
      node.start >= parent.start && node.end <= parent.end,
      `${file}: #${id} ${node.kind} ${node.start}..${node.end} leaves its parent ` +
        `#${parents[id]} ${parent.kind} ${parent.start}..${parent.end}`,
    )
  }
}

let checked = 0
let failed = 0
function checkFile(file) {
  const bytes = readFileSync(file)
  const output = execFileSync(executable, ['hir', relative(process.cwd(), resolve(file))], {
    encoding: 'utf8',
    // The largest standard-library modules take about a minute in an unoptimized debug build.
    timeout: 180000,
    maxBuffer: 256 * 1024 * 1024,
  })
  const dump = decode(output, bytes.length, file)
  checkInvariants(dump, file)
  // A file the parser accepts has nothing for the lowering to recover from, so a cause there is a
  // lowering defect rather than reported damage. A file with diagnostics — `recovery.silk` and the
  // lexical fixtures — is exempt, because its causes are the damage it deliberately contains.
  if (dump.diagnostics.length === 0) {
    assert.deepEqual(
      dump.causes.map((cause) => `${cause.code} ${cause.start}..${cause.end}`),
      [],
      `${file}: a syntactically clean file lowers without a recovery cause`,
    )
  }
  return dump
}

const files = sourceFiles()
let totalNodes = 0
for (const file of files) {
  try {
    const dump = checkFile(file)
    totalNodes += dump.nodes.length
    checked++
    process.stdout.write(`ok ${file} (${dump.nodes.length} nodes, ${dump.causes.length} causes)\n`)
  } catch (error) {
    failed++
    process.stderr.write(`FAIL ${file}: ${error.message}\n`)
  }
}
process.stdout.write(
  `Lowered ${checked} source files (${totalNodes} nodes); ${failed} failed: ` +
    `flat-arena invariants, reachability, span containment, and clean-file recovery.\n`,
)
if (failed > 0) process.exitCode = 1
