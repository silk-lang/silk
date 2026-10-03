import { assert, it } from '@effect/vitest'
import * as Lexer from '../src/Lexer.js'
import * as Parser from '../src/Parser.js'
import * as SourceFile from '../src/SourceFile.js'
import type * as SyntaxFile from '../src/SyntaxFile.js'
import * as Tir from '../src/Tir.js'
import { elaborate } from './support/elaborate.js'
import { ordinaryStorageSource } from './support/ordinaryStorageSource.js'
import { raise } from './support/raise.js'

const parseText = (id: string, source: string): SyntaxFile.SyntaxFile =>
  Parser.parse(
    Lexer.lex(
      SourceFile.make(
        id,
        Uint8Array.from(ordinaryStorageSource(source), (character) => character.charCodeAt(0)),
      ),
    ),
  )

const analyze = (id: string, source: string) => elaborate(parseText(id, source)).located

it('publishes one typed body per source declaration', () => {
  const result = analyze(
    'fixture://published-bodies.silk',
    `fn identity(value: i32) -> i32 { return value }
pub fn main() -> i32 { return identity(42) }`,
  )

  assert.deepEqual(result.diagnostics, [])
  assert.strictEqual(result.bodies.length, 2)
  assert.strictEqual(result.tir.functions.length, 2)
})

it('publishes dense node and local identities', () => {
  const result = analyze(
    'fixture://dense-identities.silk',
    `pub fn main(value: i32) -> i32 {
  let answer = value
  return answer
}`,
  )
  const body = result.bodies.at(0) ?? raise('expected checked body')
  const nodes = Tir.nodesOf(body.function)
  const locals = body.function.locals ?? raise('expected local table')

  assert.deepEqual(
    nodes.map((node) => node.id.ordinal),
    nodes.map((_, ordinal) => ordinal),
  )
  assert.deepEqual(
    locals.map((local) => local.id.ordinal),
    locals.map((_, ordinal) => ordinal),
  )
})

it('stores resolved calls and their operands on typed nodes', () => {
  const result = analyze(
    'fixture://resolved-call.silk',
    `fn identity(value: i32) -> i32 { return value }
pub fn main() -> i32 { return identity(identity(42)) }`,
  )
  const main = result.bodies.at(1)?.function ?? raise('expected main body')
  const outer = Tir.returned(main)

  assert.strictEqual(outer._tag, 'Call')
  if (outer._tag !== 'Call') return
  assert.strictEqual(outer.target.name, 'identity')
  assert.strictEqual(outer.arguments.at(0)?._tag, 'Call')
  assert.strictEqual(outer.evidence._tag, 'TirEvidence')
})

it('publishes unavailable causes through the body table', () => {
  const result = analyze(
    'fixture://unavailable-call.silk',
    'pub fn main() -> i32 { return missing(42) }',
  )
  const body = result.bodies.at(0) ?? raise('expected checked body')
  const returned = Tir.returned(body.function)

  assert.strictEqual(returned._tag, 'Unavailable')
  if (returned._tag !== 'Unavailable') return
  assert.strictEqual(returned.cause?._tag, 'TirCause')
  assert.strictEqual(
    returned.cause === undefined ? undefined : body.results.causes.at(returned.cause.ordinal)?.code,
    'SEM0004',
  )
})

it('keeps static functions as checked bodies but out of runtime module TIR', () => {
  const result = analyze(
    'fixture://static-body.silk',
    `static fn answer() -> i32 { return 42 }
pub fn main() -> i32 { return answer() }`,
  )

  assert.strictEqual(result.bodies.length, 2)
  assert.strictEqual(result.bodies.at(0)?.declaration.phase, 'Static')
  assert.strictEqual(result.tir.functions.length, 1)
  assert.strictEqual(
    Tir.returned(result.bodies.at(0)?.function ?? raise('expected static body'))._tag,
    'IntegerLiteral',
  )
})

it('publishes source names as supplementary occurrences instead of rebuilding a body', () => {
  const result = analyze(
    'fixture://occurrences.silk',
    `fn identity(value: i32) -> i32 { return value }
pub fn main() -> i32 { return identity(42) }`,
  )
  const main = result.bodies.at(1) ?? raise('expected main body')

  const tooling = main.results.tooling ?? raise('expected editor results')
  assert.isTrue(tooling.occurrences.some((occurrence) => occurrence.role === 'Value'))
  assert.isTrue(tooling.expressionTypes.length > 0)
})
