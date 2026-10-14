// One prebuilt native parser, many syntax-only inputs. No per-fixture compiler invocations.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import * as Lexer from '../../packages/compiler/dist/Lexer.js'
import * as Parser from '../../packages/compiler/dist/Parser.js'
import * as SourceFile from '../../packages/compiler/dist/SourceFile.js'
import * as SyntaxTree from '../../packages/compiler/dist/SyntaxTree.js'
import { cases } from './parser-cases.mjs'

assert.ok(
  process.argv[2],
  'Usage: node compiler/scripts/test-parser.mjs <built-executable> [source-files... | --cases [names...]]',
)
const executable = resolve(process.argv[2])
const trivia = new Set(['Whitespace', 'LineComment', 'DocComment', 'ModuleDocComment'])
const filesUnder = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return filesUnder(path)
    return path.endsWith('.silk') ? [path] : []
  })

function decode(output, sourceLength) {
  const nodes = []
  let root
  let diagnosticCount
  let current
  const diagnostics = []
  for (const line of output.split('\n')) {
    let match
    if ((match = /^root #(\d+)$/.exec(line))) root = Number(match[1])
    else if ((match = /^diagnostics (\d+)$/.exec(line))) diagnosticCount = Number(match[1])
    else if (
      diagnosticCount !== undefined &&
      (match =
        /^#(\d+) (MissingToken|UnexpectedToken|NestingLimit|ReservedTemplate|ReservedImportBinding) (\S+) (\d+)\.\.(\d+)$/.exec(
          line,
        ))
    ) {
      assert.equal(Number(match[1]), diagnostics.length)
      const start = Number(match[4])
      const end = Number(match[5])
      assert.ok(start <= end && end <= sourceLength, 'diagnostic spans address source bytes')
      if (match[2] === 'MissingToken') assert.equal(start, end)
      diagnostics.push({ kind: match[2], detail: match[3], start, end })
    } else if (
      diagnosticCount === undefined &&
      (match = /^#(\d+) (\w+) (\d+)\.\.(\d+)$/.exec(line))
    ) {
      assert.equal(Number(match[1]), nodes.length, 'IDs must be array indices')
      current = { kind: match[2], start: Number(match[3]), end: Number(match[4]), elements: [] }
      assert.ok(current.start <= current.end && current.end <= sourceLength, line)
      nodes.push(current)
    } else if ((match = /^  node #(\d+)$/.exec(line))) {
      assert.ok(current)
      const id = Number(match[1])
      assert.ok(id < nodes.length - 1, 'children must precede parents')
      current.elements.push({ node: id })
    } else if ((match = /^  token #(\d+) (\w+) (\d+)\.\.(\d+)$/.exec(line))) {
      assert.ok(current)
      current.elements.push({
        token: Number(match[1]),
        kind: match[2],
        start: Number(match[3]),
        end: Number(match[4]),
      })
    } else if ((match = /^  missing (\w+) (\d+)\.\.(\d+)$/.exec(line))) {
      assert.ok(current)
      assert.equal(match[2], match[3], 'missing tokens must have zero width')
      current.elements.push({ missing: match[1], start: Number(match[2]), end: Number(match[3]) })
    }
  }
  assert.equal(root, nodes.length - 1)
  assert.equal(nodes[root]?.kind, 'SourceFile')
  assert.equal(nodes[root]?.start, 0)
  assert.equal(nodes[root]?.end, sourceLength)
  assert.notEqual(diagnosticCount, undefined)
  assert.equal(diagnostics.length, diagnosticCount, 'decode every diagnostic')
  const reached = new Set()
  const tokens = new Set()
  const visit = (id) => {
    assert.ok(!reached.has(id), 'a node must have exactly one parent')
    reached.add(id)
    const node = nodes[id]
    let cursor = node.start
    for (const element of node.elements) {
      const span = element.node === undefined ? element : nodes[element.node]
      assert.ok(span.start >= cursor && span.end <= node.end, `ordered elements in ${node.kind}`)
      cursor = span.end
      if (element.node !== undefined) visit(element.node)
      if (element.token !== undefined) {
        assert.ok(!tokens.has(element.token), 'significant tokens must have exactly one owner')
        tokens.add(element.token)
      }
    }
  }
  visit(root)
  assert.equal(reached.size, nodes.length, 'no orphan nodes')
  const shape = (id) => ({
    kind: nodes[id].kind,
    children: nodes[id].elements.map((element) => {
      if (element.node !== undefined) return shape(element.node)
      if (element.missing) return `Missing(${element.missing})`
      return element.kind
    }),
  })
  return { nodes, diagnosticCount, diagnostics, shape: shape(root), tokens }
}

function bootstrapShape(node) {
  return {
    kind: node.kind,
    children: node.children
      .filter((child) => !SyntaxTree.isToken(child) || !trivia.has(child.kind))
      .map((child) => {
        if (SyntaxTree.isNode(child)) return bootstrapShape(child)
        if (SyntaxTree.isToken(child)) return child.kind
        return `Missing(${child.expected})`
      }),
  }
}

function shapeDifferences(actual, expected, path) {
  if (typeof actual !== typeof expected) return [`${path}: node/token mismatch`]
  if (typeof expected === 'string')
    return actual === expected ? [] : [`${path}: ${actual} instead of ${expected}`]
  if (actual.kind !== expected.kind) return [`${path}: ${actual.kind} instead of ${expected.kind}`]
  if (actual.children.length !== expected.children.length)
    return [
      `${path}.${expected.kind}: ${actual.children.length} children instead of ${expected.children.length}`,
    ]
  return expected.children.flatMap((child, index) =>
    shapeDifferences(actual.children[index], child, `${path}.${expected.kind}[${index}]`),
  )
}

let checked = 0
let failed = 0
function sourceFiles() {
  if (process.argv[3] === '--cases') return []
  if (process.argv.length > 3) return process.argv.slice(3)
  return [
    ...filesUnder('compiler/fixtures/parser'),
    // The source-written parser tests run explicitly and are not part of this differential corpus.
    ...filesUnder('compiler/src').filter((file) => file !== 'compiler/src/parser/ParserCases.silk'),
    ...filesUnder('packages/compiler/stdlib/silk'),
  ]
}
const files = sourceFiles()
function checkFile(file, testCase) {
  const bytes = readFileSync(file)
  const lexical = Lexer.lex(SourceFile.make(file, bytes))
  const bootstrap = Parser.parse(lexical)
  const output = execFileSync(executable, [relative(process.cwd(), resolve(file))], {
    encoding: 'utf8',
    // The largest standard-library modules take about 15 seconds in an unoptimized debug build.
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const actual = decode(output, bytes.length)
  for (const [id, token] of lexical.tokens.entries()) {
    if (!trivia.has(token.kind)) assert.ok(actual.tokens.has(id), `${file}: missing token #${id}`)
  }
  for (const node of actual.nodes) {
    for (const element of node.elements) {
      if (element.token === undefined) continue
      const token = lexical.tokens[element.token]
      assert.ok(token, 'token IDs address the lexer array')
      assert.deepEqual(
        { kind: element.kind, start: element.start, end: element.end },
        { kind: token.kind, start: token.span.start, end: token.span.end },
        'token identities retain their kind and source span',
      )
    }
  }
  if (testCase !== undefined) {
    assert.equal(
      bootstrap.parserDiagnostics.length > 0,
      testCase.bootstrapInvalid ?? testCase.invalid ?? false,
      'bootstrap acceptance',
    )
    assert.equal(actual.diagnosticCount > 0, testCase.invalid ?? false, 'self-hosted acceptance')
    if (testCase.diagnostic !== undefined) {
      assert.ok(
        actual.diagnostics.some((d) => d.kind === testCase.diagnostic),
        testCase.diagnostic,
      )
    }
    if (testCase.missing !== undefined) {
      const offset = bytes.indexOf(testCase.missing.before)
      assert.ok(offset >= 0, 'diagnostic anchor occurs in source')
      assert.ok(
        actual.diagnostics.some(
          (d) =>
            d.kind === 'MissingToken' &&
            d.detail === testCase.missing.token &&
            d.start === offset &&
            d.end === offset,
        ),
        `missing ${testCase.missing.token} at byte ${offset}`,
      )
    }
    checkWitnesses(actual, bytes, testCase.witnesses)
    checkBootstrapWitnesses(
      bootstrap.root,
      bytes,
      testCase.bootstrapWitnesses ?? testCase.witnesses,
    )
  } else if (file.endsWith('/recovery.silk')) {
    assert.ok(actual.diagnosticCount > 0)
    assert.ok(
      actual.nodes.filter((node) => node.kind === 'FunctionDeclaration').length >= 2,
      'preserve following valid declarations',
    )
  } else {
    assert.equal(
      bootstrap.parserDiagnostics.length,
      0,
      `${file}: fixture must be valid bootstrap syntax`,
    )
    assert.equal(
      actual.diagnosticCount,
      0,
      `${file}: ${output.slice(output.lastIndexOf('\ndiagnostics'))}`,
    )
    assert.deepEqual(
      shapeDifferences(actual.shape, bootstrapShape(bootstrap.root), file),
      [],
      `${file}: significant AST structure must agree`,
    )
  }
}

function checkWitnesses(actual, bytes, witnesses) {
  const intact = (node) =>
    !node.kind.startsWith('Error') &&
    node.elements.every((element) =>
      element.node === undefined
        ? element.missing === undefined
        : intact(actual.nodes[element.node]),
    )
  for (const { kind, text } of witnesses) {
    const candidates = actual.nodes.filter(
      (node) =>
        node.kind === kind && bytes.subarray(node.start, node.end).toString().trim() === text,
    )
    assert.ok(candidates.length > 0, `preserve ${kind}: ${text}`)
    assert.ok(
      candidates.some(
        (node) =>
          intact(node) &&
          !actual.diagnostics.some((d) => d.start > node.start && d.start < node.end),
      ),
      `undamaged ${kind}: ${text}`,
    )
  }
}

function checkBootstrapWitnesses(root, bytes, witnesses) {
  const nodes = []
  const visit = (node) => {
    const childrenIntact = node.children
      .map((child) => {
        if (SyntaxTree.isNode(child)) return visit(child)
        return SyntaxTree.isToken(child)
      })
      .every(Boolean)
    const intact = childrenIntact && !node.kind.startsWith('Error')
    nodes.push({
      kind: node.kind,
      text: bytes.subarray(node.span.start, node.span.end).toString().trim(),
      intact,
    })
    return intact
  }
  visit(root)
  for (const { kind, text } of witnesses) {
    assert.ok(
      nodes.some((node) => node.kind === kind && node.text === text && node.intact),
      `bootstrap preserves ${kind}: ${text}`,
    )
  }
}
if (process.argv.length === 3 || process.argv[3] === '--cases') {
  const names = process.argv.slice(4)
  for (const name of names)
    assert.ok(
      cases.some((testCase) => testCase.name === name),
      `unknown case: ${name}`,
    )
  const directory = mkdtempSync('compiler/fixtures/.parser-cases-')
  try {
    for (const testCase of cases.filter(
      (testCase) => names.length === 0 || names.includes(testCase.name),
    )) {
      const file = `${directory}/${testCase.name}.silk`
      writeFileSync(file, testCase.source)
      try {
        checkFile(file, testCase)
        checked++
        process.stdout.write(`ok case:${testCase.name}\n`)
      } catch (error) {
        failed++
        process.stderr.write(
          `FAIL case:${testCase.name}: ${error.message}${error.signal ? ` (signal ${error.signal})` : ''}\n`,
        )
      }
    }
  } finally {
    rmSync(directory, { recursive: true })
  }
}
for (const file of files) {
  try {
    checkFile(file)
    checked++
    process.stdout.write(`ok ${file}\n`)
  } catch (error) {
    failed++
    process.stderr.write(`FAIL ${file}: ${error.message}\n`)
  }
}
process.stdout.write(
  `Verified ${checked} source files; ${failed} failed: flat-tree invariants, token ownership, grammar, and recovery.\n`,
)
if (failed > 0) process.exitCode = 1
