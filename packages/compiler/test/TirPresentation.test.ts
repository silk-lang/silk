import { assert, it } from '@effect/vitest'
import * as Elaboration from '../src/Elaboration.js'
import * as Lexer from '../src/Lexer.js'
import * as LifetimeFlow from '../src/LifetimeFlow.js'
import * as Parser from '../src/Parser.js'
import * as SemanticContext from '../src/SemanticContext.js'
import * as SourceFile from '../src/SourceFile.js'
import * as Tir from '../src/Tir.js'
import { elaborate } from './support/elaborate.js'
import { raise } from './support/raise.js'

const program = `struct Token { value: i32 }
union Maybe { Some { token: Token }, None }
struct Wrapped { maybe: Maybe }
fn touch(token: &mut Token) -> i32 { return token.value }
fn read(value: i32, values: &mut [i32]) -> i32 { return value }
fn widen(flag: bool) -> i32 | bool { if flag { return 1 } return false }
fn inspect(owned: &mut Wrapped, early: bool) -> i32 {
  if !early { let Wrapped { maybe } = &owned.* }
  if let Maybe.Some { token } = &mut owned.maybe { let value = touch(&mut token) }
  return 0
}
pub fn main() -> i32 {
  let mut values = [1, 2]
  let callback = read(&mut values)
  drop callback
  values[0] = 2
  let first = touch(&mut Token { value: 3 })
  let picked = match Maybe.None {
    Maybe.Some { token } => token.value,
    Maybe.None => 0,
  }
  return values[0] + picked + first
}`

const analyze = (text: string) =>
  elaborate(
    Parser.parse(Lexer.lex(SourceFile.make('present/main', new TextEncoder().encode(text)))),
  )

it('presents a body built in one revision exactly as the next revision lowers it', () => {
  const before = analyze(program)
  const after = analyze(`// a comment that moves every declaration\n\n${program}`)
  const context = SemanticContext.make(after.authored)
  assert.isAbove(before.tir.functions.length, 4)
  // Every position in a body is a function of an authored node, so presenting the old body through
  // the new presentation leaves nothing that still belongs to the old revision.
  for (const [ordinal, fn] of before.tir.functions.entries()) {
    const current = after.tir.functions.at(ordinal) ?? raise('expected the same functions')
    const presentedBody = Tir.present(fn, context.spanOf, current.declaration)
    const differences: Array<string> = []
    const compare = (left: unknown, right: unknown, path: string): void => {
      if (differences.length > 12 || left === right) return
      if (
        typeof left !== 'object' ||
        typeof right !== 'object' ||
        left === null ||
        right === null
      ) {
        differences.push(`${path}: ${String(left)} != ${String(right)}`)
        return
      }
      if (left instanceof Map || right instanceof Map) return
      const keys = new Set([...Object.keys(left), ...Object.keys(right)])
      for (const key of keys)
        compare(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
          `${path}.${key}`,
        )
    }
    compare(
      { ...presentedBody, declaration: undefined },
      { ...current, declaration: undefined },
      `fn${ordinal}`,
    )
    assert.deepEqual(differences, [])
  }
  assert.notDeepEqual(before.tir, after.tir)
})

it('presents the region proof of a body through the next revision', () => {
  const before = analyze(program)
  const after = analyze(`// a comment that moves every declaration\n\n${program}`)
  const context = SemanticContext.make(after.authored)
  let compared = 0
  for (const [ordinal, body] of before.bodies.entries()) {
    const current = after.bodies.at(ordinal)?.results.lifetimes
    if (body.results.lifetimes === undefined || current === undefined) continue
    const presented = LifetimeFlow.present(body.results.lifetimes, context)
    assert.deepEqual(presented.spans, current.spans)
    for (const [key, origin] of presented.origins) {
      const other = current.origins.get(key)
      assert.deepEqual(
        [
          key,
          origin.span,
          origin.path?.map((step) => [step._tag, step.span, step.at !== undefined]),
        ],
        [
          key,
          other?.span,
          other?.path?.map((step) => [step._tag, step.span, step.at !== undefined]),
        ],
      )
    }
    assert.deepEqual(presented.origins, current.origins)
    assert.deepEqual(presented.controlFlow.spans, current.controlFlow.spans)
    assert.deepEqual(presented.controlFlow.writes, current.controlFlow.writes)
    compared += 1
  }
  assert.isAbove(compared, 4)
})

it('encodes a body without positions, so moved source encodes the same', () => {
  const before = analyze(program)
  const after = analyze(
    `// a comment that moves every declaration\n\n${program.replaceAll('  ', '\t')}`,
  )
  assert.notDeepEqual(before.tir, after.tir)
  assert.strictEqual(Tir.encode(after.tir), Tir.encode(before.tir))
  assert.notMatch(Tir.encode(before.tir), /\[\d+, \d+\)/)
})

it('presents the region proof of a moved body where the next revision builds it', () => {
  const before = analyze(program)
  const after = analyze(`// a comment that moves every declaration\n\n${program}`)
  const context = SemanticContext.make(after.authored)
  for (const [ordinal, body] of before.bodies.entries()) {
    const current = after.bodies.at(ordinal) ?? raise('expected the same bodies')
    const presented = Elaboration.presentBody(body, context, current.declaration)
    assert.deepEqual(presented.results.lifetimes?.spans, current.results.lifetimes?.spans)
    assert.deepEqual(
      presented.results.lifetimes?.controlFlow.spans,
      current.results.lifetimes?.controlFlow.spans,
    )
    assert.deepEqual(presented.results.tooling?.scopes, current.results.tooling?.scopes)
    assert.deepEqual(presented.results.tooling?.occurrences, current.results.tooling?.occurrences)
  }
})
