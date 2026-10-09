import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import * as SourceResolver from '../src/SourceResolver.js'
import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Analysis from '../src/Analysis.js'
import * as AuthoredIdentity from '../src/AuthoredIdentity.js'
import * as Lifetime from '../src/Lifetime.js'
import * as SemanticContext from '../src/SemanticContext.js'
import * as Tir from '../src/Tir.js'
import * as Lexer from '../src/Lexer.js'
import * as MovePath from '../src/MovePath.js'
import * as MirVerification from '../src/MirVerification.js'
import type * as Mir from '../src/Mir.js'
import * as Ownership from '../src/Ownership.js'
import * as OwnershipEncoding from '../src/OwnershipEncoding.js'
import * as Parser from '../src/Parser.js'
import * as ResidualOwnership from '../src/ResidualOwnership.js'
import * as SourceFile from '../src/SourceFile.js'
import * as Type from '../src/Type.js'
import { elaborate, ownership } from './support/elaborate.js'
import { raise, unreachable } from './support/raise.js'

const movedState = (
  result: Result.Result<MovePath.State, MovePath.TransitionFailure>,
): MovePath.State =>
  Result.isSuccess(result) ? result.success : unreachable(`unexpected ${result.failure._tag}`)

const moveInspection = (
  state: MovePath.State,
  path: MovePath.Path,
  shape: MovePath.ShapeOf,
): MovePath.Inspection => {
  const result = MovePath.inspect(state, path, shape)
  return Result.isSuccess(result)
    ? result.success
    : unreachable(`unexpected ${result.failure._tag}`)
}

const fieldPath = (ordinal: number): MovePath.Selector => ({ _tag: 'Field', ordinal })

it.effect(
  'keeps loans live across loop backedges while respecting break and disjoint branch exits',
  () =>
    Effect.gen(function* () {
      const source = `struct Data { value: i32 }
fn read(x: &Data) -> i32 { return x.value }
fn bad() -> i32 {
  let mut x = Data { value: 1 } let r = &x let mut i = 0
  while i < 2 { i = read(r) x = Data { value: 2 } }
  return i
}
fn stopped() -> i32 {
  let mut x = Data { value: 1 } let r = &x let mut i = 0
  while i < 2 { i = read(r) x = Data { value: 2 } break }
  return i
}
fn recreated() -> i32 {
  let mut x = Data { value: 1 } let mut i = 0
  while i < 2 { let r = &x i = read(r) x = Data { value: 2 } }
  return i
}
fn branches<'a>(x: &'a i32, flag: bool) -> &'a i32 {
  let mut n = 1 let r = &n
  if flag { n = 2 return x } else { drop r }
  return x
}`
      const snapshot = yield* Analysis.ofSource(
        'ownership/cfg-loans',
        Uint8Array.from(source, (character) => character.charCodeAt(0)),
      )
      const diagnostics = Analysis.diagnostics(snapshot)
      assert.isAbove(diagnostics.length, 0)
      assert.isTrue(
        diagnostics.every(
          (diagnostic) => diagnostic.code === 'OWN0011' || diagnostic.code === 'OWN0019',
        ),
      )
      assert.isTrue(
        diagnostics.every(
          (diagnostic) =>
            diagnostic.span.start >= source.indexOf('fn bad') &&
            diagnostic.span.end < source.indexOf('fn stopped'),
        ),
      )
      const stopped =
        Analysis.rootAnalysis(snapshot).tir.functions.find(
          (fn) =>
            fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'stopped',
        ) ?? unreachable('expected stopped function')
      assert.isFalse(
        stopped.statements
          .flatMap(Tir.statementExpressions)
          .flatMap(Tir.expressionTree)
          .some((expression) => expression._tag === 'Unavailable'),
      )
    }),
)

it.effect(
  'starts incoming borrowed field obligations at installation and retains later invalidation checks',
  () =>
    Effect.gen(function* () {
      const source = `struct Holder<'a> { value: &'a [i32] }
fn read(h: &Holder) -> i32 { return h.value[0] }
fn valid() -> i32 {
  let mut first = [1] let mut h = Holder { value: &first }
  let second = [2] h.value = &second
  first = [3]
  return read(&h)
}
fn replacedAgain() -> i32 {
  let first = [1] let mut h = Holder { value: &first }
  let mut second = [2] h.value = &second
  let third = [3] h.value = &third
  second = [4]
  return h.value[0]
}
fn invalid() -> i32 {
  let first = [1] let mut h = Holder { value: &first }
  let mut second = [2] h.value = &second
  second = [3]
  return h.value[0]
}
fn conditional(flag: bool) -> i32 {
  let mut first = [1] let mut h = Holder { value: &first }
  let second = [2]
  if flag { h.value = &second }
  first = [3]
  return h.value[0]
}
struct Pair<'a> { left: &'a [i32] right: &'a [i32] }
fn sibling() -> i32 {
  let mut first = [1] let mut h = Pair { left: &first, right: &first }
  let second = [2] h.left = &second
  first = [3]
  return h.right[0]
}`
      const snapshot = yield* Analysis.ofSource(
        'ownership/installed-reference',
        Uint8Array.from(source, (character) => character.charCodeAt(0)),
      )
      const diagnostics = Analysis.diagnostics(snapshot)
      assert.isAbove(diagnostics.length, 0)
      assert.isTrue(
        diagnostics.every(
          (diagnostic) => diagnostic.code === 'OWN0011' || diagnostic.code === 'OWN0019',
        ),
      )
      assert.isTrue(
        diagnostics.every((diagnostic) => diagnostic.span.start >= source.indexOf('fn invalid')),
      )
      for (const [start, end] of [
        ['fn invalid', 'fn conditional'],
        ['fn conditional', 'struct Pair'],
        ['fn sibling', undefined],
      ])
        assert.isTrue(
          diagnostics.some(
            (diagnostic) =>
              diagnostic.span.start >= source.indexOf(start ?? '') &&
              (end === undefined || diagnostic.span.end < source.indexOf(end)),
          ),
        )
      for (const name of ['valid', 'replacedAgain']) {
        const fn =
          Analysis.rootAnalysis(snapshot).tir.functions.find(
            (candidate) =>
              candidate.declaration.name._tag === 'Present' &&
              candidate.declaration.name.spelling === name,
          ) ?? unreachable('expected valid replacement function')
        assert.isFalse(
          fn.statements
            .flatMap(Tir.statementExpressions)
            .flatMap(Tir.expressionTree)
            .some((expression) => expression._tag === 'Unavailable'),
          Tir.encode({
            _tag: 'TirModule',
            module: 'ownership/installed-reference',
            functions: [fn],
          }),
        )
      }
    }),
)

it.effect('releases outgoing sources after complete array and variant payload replacement', () =>
  Effect.gen(function* () {
    const source = `fn readArray<'a>(values: [&'a [i32]; 2]) -> i32 { return values[0][0] }
fn arrayReset() -> i32 {
  let mut first = [1] let mut values = [&first, &first]
  let second = [2] values[0] = &second values[1] = &second
  first = [3]
  return readArray(move values)
}
union Choice<'a> { Hold { value: &'a [i32] }, Empty }
fn readChoice<'a>(choice: Choice<'a>) -> i32 {
  return match move choice { Choice<'a>.Hold { value } => value[0] Choice<'a>.Empty {} => 0 }
}
fn unionReset() -> i32 {
  let mut first = [1] let mut choice = Choice.Hold { value: &first }
  let second = [2]
  match place choice { Choice.Hold { value } => { value = &second } Choice.Empty {} => {} }
  first = [3]
  return readChoice(move choice)
}
fn partialArray() -> i32 {
  let mut first = [1] let mut values = [&first, &first]
  let second = [2] values[0] = &second
  first = [3]
  return readArray(move values)
}
fn conditionalVariant(flag: bool) -> i32 {
  let mut first = [1] let mut choice = Choice.Hold { value: &first }
  let second = [2]
  match place choice { Choice.Hold { value } => { if flag { value = &second } } Choice.Empty {} => {} }
  first = [3]
  return readChoice(move choice)
}
fn explicitStaticPattern() -> i32 {
  let first = [1] let choice = Choice.Hold { value: &first }
  return match move choice { Choice<'static>.Hold { value } => value[0] Choice<'static>.Empty {} => 0 }
}`
    const snapshot = yield* Analysis.ofSource('ownership/complete-carrier-reset', ascii(source))
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.deepEqual(
      diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'OWN0011', span: 'first' },
        { code: 'OWN0019', span: 'move values' },
        { code: 'OWN0019', span: 'move values' },
        { code: 'OWN0019', span: 'values' },
        { code: 'OWN0019', span: 'values' },
        { code: 'OWN0011', span: 'first' },
        { code: 'OWN0019', span: 'move choice' },
        { code: 'OWN0019', span: 'choice' },
        { code: 'SEM0212', span: '&first' },
      ],
    )
    assert.isTrue(
      diagnostics.every((diagnostic) => diagnostic.span.start >= source.indexOf('fn partialArray')),
    )
    assert.strictEqual(
      diagnostics.find((diagnostic) => diagnostic.code === 'SEM0212')?.span.start,
      source.lastIndexOf('&first'),
    )
    for (const [start, end] of [
      ['fn partialArray', 'fn conditionalVariant'],
      ['fn conditionalVariant', 'fn explicitStaticPattern'],
    ])
      assert.isTrue(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.span.start >= source.indexOf(start ?? '') &&
            (end === undefined || diagnostic.span.end < source.indexOf(end)),
        ),
      )
  }),
)

it.effect('reborrows returned exclusive views while keeping sibling loans exclusive', () =>
  Effect.gen(function* () {
    const source = `struct Entry { value: i32 }
fn view<'a>(value: &'a mut Entry) -> &'a mut Entry { return move value }
fn use(value: &mut i32) { value.* = 2 }
fn valid() -> i32 {
  let mut entry = Entry { value: 1 }
  let mut held = view(&mut entry)
  use(&mut held.value)
  return entry.value
}
fn invalid() -> i32 {
  let mut entry = Entry { value: 1 }
  let mut held = view(&mut entry)
  let first = &mut held.value
  let second = &mut held.value
  use(move first)
  use(move second)
  return entry.value
}
fn invalidParent() -> i32 {
  let mut entry = Entry { value: 1 }
  let mut held = view(&mut entry)
  let first = &mut held.value
  let observed = held.value
  use(move first)
  return observed
}
fn implicitSlice<T>(anchor: &mut [T]) -> &mut [T] { return anchor }
fn explicitSlice<T>(anchor: &mut [T]) -> &mut [T] { return move anchor }
fn sharedSlice<T>(anchor: &[T]) -> &[T] { return anchor }`
    const snapshot = yield* Analysis.ofSource(
      'ownership/returned-exclusive-reborrow',
      ascii(source),
    )
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.isTrue(
      diagnostics.every((diagnostic) => diagnostic.span.start >= source.indexOf('fn invalid')),
    )
    assert.isTrue(diagnostics.some((diagnostic) => diagnostic.code === 'OWN0010'))
    assert.deepEqual(
      diagnostics
        .filter((diagnostic) => diagnostic.span.start >= source.indexOf('fn implicitSlice'))
        .map((diagnostic) => ({
          code: diagnostic.code,
          start: diagnostic.span.start,
          span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
        })),
      [
        {
          code: 'OWN0003',
          start: source.indexOf('anchor }', source.indexOf('fn implicitSlice')),
          span: 'anchor',
        },
      ],
    )
    assert.isTrue(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'OWN0011' &&
          diagnostic.span.start >= source.indexOf('fn invalidParent'),
      ),
    )
  }),
)

it('restores sparse children while refusing projections through a consumed ancestor', () => {
  const outer = fieldPath(0)
  const left = fieldPath(0)
  const right = fieldPath(1)
  const shape: MovePath.ShapeOf = (path) =>
    path.length < 2 ? { _tag: 'Fields', fields: [0, 1], dropBoundary: false } : { _tag: 'Leaf' }
  const initial = MovePath.make()
  const partial = movedState(MovePath.consume(initial, [outer, left], shape))
  assert.strictEqual(moveInspection(partial, [], shape).complete, false)
  assert.strictEqual(moveInspection(partial, [outer, right], shape).complete, true)
  assert.strictEqual(moveInspection(partial, [], shape).conditional, false)
  const bothMissing = movedState(MovePath.consume(partial, [outer, right], shape))
  assert.strictEqual(moveInspection(bothMissing, [outer], shape).empty, true)
  const firstRestored = movedState(MovePath.restore(bothMissing, [outer, left], shape))
  const restored = movedState(MovePath.restore(firstRestored, [outer, right], shape))
  assert.isTrue(MovePath.equivalent(restored, initial))
  const consumed = movedState(MovePath.consume(initial, [outer], shape))
  const invalid = MovePath.restore(consumed, [outer, left], shape)
  assert.isTrue(Result.isFailure(invalid))
  if (Result.isFailure(invalid)) {
    assert.strictEqual(invalid.failure._tag, 'MissingAncestor')
    assert.deepEqual(invalid.failure.path, [outer])
  }
  assert.isTrue(
    MovePath.equivalent(movedState(MovePath.restore(consumed, [outer], shape)), initial),
  )
})

it('joins sparse array holes to conditional state and reaches a finite fixed point', () => {
  const shape: MovePath.ShapeOf = (path) =>
    path.length === 0 ? { _tag: 'Array', length: 3 } : { _tag: 'Leaf' }
  const slot: MovePath.Selector = { _tag: 'ConstantIndex', index: 2 }
  const initial = MovePath.make()
  const partial = movedState(MovePath.consume(initial, [slot], shape))
  assert.deepEqual(
    partial.children.map((child) => child.selector),
    [slot],
  )
  const joined = MovePath.join([initial, partial], shape)
  assert.strictEqual(moveInspection(joined, [slot], shape).conditional, true)
  assert.strictEqual(
    moveInspection(joined, [{ _tag: 'ConstantIndex', index: 0 }], shape).complete,
    true,
  )
  assert.isTrue(MovePath.equivalent(MovePath.join([joined, partial], shape), joined))
  assert.isTrue(MovePath.equivalent(MovePath.join([partial, initial], shape), joined))
  assert.isTrue(MovePath.equivalent(movedState(MovePath.restore(joined, [slot], shape)), initial))
  assert.isTrue(Result.isFailure(MovePath.consume(joined, [slot], shape)))
  assert.isFalse(MovePath.overlaps([slot], [{ _tag: 'ConstantIndex', index: 0 }]))
})

it('joins only feasible variant predecessors while preserving a partial discriminant', () => {
  const variant: MovePath.Selector = { _tag: 'Variant', ordinal: 0 }
  const payload = fieldPath(0)
  const shape: MovePath.ShapeOf = (path) => {
    if (path.length === 0) return { _tag: 'Variants', variants: [0, 1], dropBoundary: false }
    if (path.length === 1) return { _tag: 'Fields', fields: [0], dropBoundary: false }
    return { _tag: 'Leaf' }
  }
  const initial = MovePath.make()
  assert.isTrue(Result.isFailure(MovePath.consume(initial, [variant, payload], shape)))
  const first = movedState(MovePath.refine(initial, [], 0, shape))
  const moved = movedState(MovePath.consume(first, [variant, payload], shape))
  assert.strictEqual(moveInspection(moved, [], shape).discriminant, 'Initialized')
  const second = movedState(MovePath.refine(initial, [], 1, shape))
  const joined = MovePath.join([moved, second], shape)
  assert.strictEqual(joined.activeVariant, undefined)
  const selected = movedState(MovePath.refine(joined, [], 0, shape))
  const inspected = moveInspection(selected, [variant, payload], shape)
  assert.strictEqual(inspected.empty, true)
  assert.strictEqual(inspected.conditional, false)
  const consumed = movedState(MovePath.terminate(selected, [], shape))
  assert.isTrue(Result.isFailure(MovePath.refine(consumed, [], 0, shape)))
})

it('allows a complete Drop child to move but rejects extraction through its hook boundary', () => {
  const outer = fieldPath(0)
  const inner = fieldPath(0)
  const shape: MovePath.ShapeOf = (path) =>
    path.length < 2
      ? { _tag: 'Fields', fields: [0], dropBoundary: path.length === 1 }
      : { _tag: 'Leaf' }
  const initial = MovePath.make()
  assert.isTrue(Result.isSuccess(MovePath.consume(initial, [outer], shape)))
  const invalid = MovePath.consume(initial, [outer, inner], shape)
  assert.isTrue(Result.isFailure(invalid))
  if (Result.isFailure(invalid)) assert.strictEqual(invalid.failure._tag, 'DropBoundary')
})

it('terminates partial and conditional owners once without reviving empty moved values', () => {
  const shape: MovePath.ShapeOf = (path) =>
    path.length === 0 ? { _tag: 'Fields', fields: [0, 1], dropBoundary: false } : { _tag: 'Leaf' }
  const initial = MovePath.make()
  const partial = movedState(MovePath.consume(initial, [fieldPath(0)], shape))
  const terminated = movedState(MovePath.terminate(partial, [], shape))
  assert.isTrue(Result.isFailure(MovePath.terminate(terminated, [], shape)))
  const conditional = MovePath.join([initial, terminated], shape)
  assert.isTrue(Result.isSuccess(MovePath.terminate(conditional, [], shape)))
  assert.isTrue(Result.isFailure(MovePath.restore(conditional, [fieldPath(0)], shape)))
  const emptyShape: MovePath.ShapeOf = () => ({ _tag: 'Array', length: 0 })
  const emptyMoved = movedState(MovePath.consume(initial, [], emptyShape))
  assert.strictEqual(moveInspection(emptyMoved, [], emptyShape).complete, false)
  assert.isTrue(Result.isFailure(MovePath.consume(emptyMoved, [], emptyShape)))
})

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const acceptedSource = `pub fn choose(left: i32, right: i32) -> i32 { return left }
pub fn main() -> i32 { return choose(1, 2) }`
const damagedSource = `pub fn puzzle(value: Mystery) -> i32 { return value }
pub fn main() -> i32 { return missing() }`
const localSharedSource = `fn retain<T>(value: Intrinsic.SharedCore<T>) -> Intrinsic.SharedCore<T> {
  return move value
}
pub fn main() -> i32 { return 0 }`

const check = (id: string, text: string): Ownership.ModuleOwnership =>
  ownership(elaborate(Parser.parse(Lexer.lex(SourceFile.make(id, ascii(text))))))

const checkPartial = (id: string, text: string): Ownership.ModuleOwnership => {
  const syntax = Parser.parse(Lexer.lex(SourceFile.make(id, ascii(text))))
  assert.deepEqual(syntax.lexicalDiagnostics, [])
  assert.deepEqual(syntax.parserDiagnostics, [])
  const result = elaborate(syntax)
  assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics))
  return ownership(result)
}

it('tracks projected transfers and restores complete aggregate use after a field assignment', () => {
  const facts = checkPartial(
    'ownership/partial-restoration',
    `
struct Token { value: i32 }
struct Pair { left: Token right: Token }
fn total(pair: Pair) -> i32 { return pair.left.value + pair.right.value }
pub fn main() -> i32 {
  let mut pair = Pair { left: Token { value: 1 }, right: Token { value: 2 } }
  let first = move pair.left
  pair.left = Token { value: first.value }
  return total(move pair)
}`,
  )
  assert.deepEqual(facts.diagnostics, [])
  const main = facts.functions.at(-1) ?? unreachable('expected main ownership')
  assert.deepEqual(
    main.transitions.map((transition) => [transition.kind, MovePath.key(transition.path)]),
    [
      ['Move', 'f0'],
      ['Write', 'f0'],
      ['Move', ''],
    ],
  )
  assert.deepEqual(main.replacements, [])
})

it('retains only conditional field presence at an exit while disjoint fields remain usable', () => {
  const facts = checkPartial(
    'ownership/partial-branch',
    `
struct Token { value: i32 }
struct Pair { left: Token right: Token }
fn choose(flag: bool, pair: Pair) -> i32 {
  if flag { let first = move pair.left }
  return pair.right.value
}`,
  )
  assert.deepEqual(facts.diagnostics, [])
  const release =
    facts.functions
      .at(0)
      ?.exits.at(-1)
      ?.releases.find((item) => item.binding.name === 'pair') ??
    unreachable('expected remaining pair cleanup')
  assert.strictEqual(release.initialization.initialization, 'Initialized')
  assert.deepEqual(
    release.initialization.children.map((child) => [
      MovePath.key([child.selector]),
      child.state.initialization,
    ]),
    [['f0', 'Maybe']],
  )
})

it.effect(
  'lowers conditional field cleanup and recreates guarded match bindings and results across loops',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'ownership/partial-cleanup-mir',
        ascii(`
struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
struct Pair { left: Token right: Token }
union Maybe { Some { token: Token }, None }
struct Wrapped { maybe: Maybe }
fn touch(token: &mut Token) -> i32 { return token.value }
fn inspectBorrowed(owned: &mut Wrapped, early: bool) -> i32 {
  if !early { let Wrapped { maybe } = &owned.* }
  if let Maybe.Some { token } = &owned.maybe {
    if early { return token.value }
  }
  if let Maybe.Some { token } = &mut owned.maybe { let value = touch(&mut token) }
  return 0
}
fn choose(flag: bool) -> i32 {
  let pair = Pair { left: Token { value: 1 }, right: Token { value: 2 } }
  if flag { let first = move pair.left }
  return pair.right.value
}
fn repeat() -> i32 {
  let mut index = 0
  while index < 2 {
    let pair = Pair { left: Token { value: index }, right: Token { value: 0 } }
    let token = match move pair {
      Pair { left, .. } if left.value < 1 => Token { value: 1 }
      Pair { left, .. } => Token { value: 2 }
    }
    index = index + token.value
  }
  return index
}
pub fn main() -> i32 {
  let mut owned = Wrapped { maybe: Maybe.Some { token: Token { value: 7 } } }
  return inspectBorrowed(&mut owned, false) + inspectBorrowed(&mut owned, true) + choose(true) + repeat()
}
`),
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const program = Analysis.loweredMir(snapshot)
      assert.deepEqual(yield* MirVerification.verify(program), [])
      const borrowed =
        program.functions.find((fn) => fn.id.name === 'inspectBorrowed') ??
        unreachable('expected borrowed pattern function')
      assert.isFalse(
        MirVerification.operations(borrowed).some(
          (operation) => operation._tag === 'Drop' && operation.cleanup._tag !== 'NoCleanup',
        ),
      )
      const main =
        program.functions.find((fn) => fn.id.name === 'main') ??
        unreachable('expected owning caller')
      assert.isTrue(
        MirVerification.operations(main).some(
          (operation) => operation._tag === 'Drop' && operation.cleanup._tag !== 'NoCleanup',
        ),
      )
      const operations = program.functions.flatMap((fn) => MirVerification.operations(fn))
      assert.isTrue(
        operations.some(
          (operation) =>
            operation._tag === 'ReadPlace' &&
            operation.consume === true &&
            MovePath.key(operation.ownershipPath ?? []) === 'f0',
        ),
      )
      const partial = operations.find(
        (operation) =>
          operation._tag === 'Drop' &&
          operation.initialization?.state.children.some(
            (child) => child.state.initialization === 'Maybe',
          ),
      )
      if (partial?._tag !== 'Drop') return unreachable('expected conditional cleanup')
      assert.deepEqual(
        partial.initialization?.flags.map((flag) => MovePath.key(flag.path)),
        ['f0'],
      )
      assert.isTrue(
        operations.some(
          (operation) => operation._tag === 'SetInitialized' && !operation.initialized,
        ),
      )
      const initialization =
        partial.initialization ?? unreachable('expected partial initialization')
      const replaceCleanup = (replacement: Mir.DropOperation): Mir.Module => ({
        ...program,
        functions: program.functions.map((fn) => ({
          ...fn,
          regions: fn.regions.map((region): Mir.Region => {
            if (region._tag === 'OperationRegion')
              return {
                ...region,
                operations: region.operations.map((operation) =>
                  operation === partial ? replacement : operation,
                ),
              }
            if (region._tag === 'CleanupRegion')
              return {
                ...region,
                releases: region.releases.map((release) =>
                  release === partial ? replacement : release,
                ),
              }
            return region
          }),
        })),
      })
      for (const corrupted of [
        { ...partial, initialization: { ...initialization, flags: [] } },
        { ...partial, initialization: { state: MovePath.make(), flags: [] } },
      ])
        assert.isTrue(
          (yield* MirVerification.verify(replaceCleanup(corrupted))).some(
            (violation) => violation.rule === 'InvalidInitializationState',
          ),
        )
    }),
)

it('restores constant array elements and rejects dynamic moves and descent through a Drop boundary', () => {
  const source = `struct Token { value: i32 }
struct Guarded { token: Token }
impl Drop for Guarded { fn drop(self: &mut Guarded) -> () { return () } }
fn restore(mut values: [Token; 2]) -> [Token; 2] {
  let first = move values[0]
  values[0] = Token { value: first.value }
  return move values
}
fn dynamic(values: [Token; 2], index: usize) -> i32 {
  let selected = move values[index]
  return selected.value
}
fn guarded(value: Guarded) -> i32 {
  let selected = move value.token
  return selected.value
}`
  const facts = checkPartial('ownership/partial-array-boundary', source)
  const restore =
    facts.functions.find(
      (fn) =>
        fn.declaration.canonical._tag === 'Canonical' &&
        fn.declaration.canonical.id.name === 'restore',
    ) ?? unreachable('expected restored array')
  assert.deepEqual(
    restore.transitions.map((transition) => [transition.kind, MovePath.key(transition.path)]),
    [
      ['Move', 'i0'],
      ['Write', 'i0'],
      ['Move', ''],
    ],
  )
  assert.deepEqual(
    facts.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
    })),
    [
      { code: 'OWN0002', span: 'move values[index]' },
      { code: 'OWN0002', span: 'move value.token' },
    ],
  )
})

it('keeps disjoint field loans separate and retains every source when reborrowing a selected result', () => {
  const source = `struct Token { value: i32 }
struct Pair { left: Token right: Token }
fn sum(left: &mut Token, right: &mut Token) -> i32 { return left.value + right.value }
fn disjoint(mut pair: Pair) -> i32 { return sum(&mut pair.left, &mut pair.right) }
fn overlapping(mut pair: Pair) -> i32 { return sum(&mut pair.left, &mut pair.left) }
fn choose<'a>(left: &'a i32, right: &'a i32, flag: bool) -> &'a i32 { if flag { return left } return right }
fn selected(mut left: i32, mut right: i32) -> i32 {
  let chosen = choose(&left, &right, true)
  let borrowed = &chosen.*
  return borrowed.*
}`
  const facts = checkPartial('ownership/loan-referents', source)
  assert.deepEqual(
    facts.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
    })),
    [{ code: 'OWN0010', span: '&mut pair.left' }],
  )
  const disjoint = facts.functions.at(1) ?? unreachable('disjoint field loans')
  assert.deepEqual(
    disjoint.loans.map((loan) => loan.referents.map(Ownership.referentKey)),
    [['p0/f0'], ['p0/f1']],
  )
  const selected = facts.functions.at(-1) ?? unreachable('selected result holder')
  const reborrow =
    selected.loans.find((loan) => loan.root._tag === 'Let' && loan.referents.length === 2) ??
    unreachable('every selected input source retained')
  assert.deepEqual(reborrow.referents.map((referent) => Ownership.siteKey(referent.root)).sort(), [
    'p0',
    'p1',
  ])
})

it('refines a discriminant-only match and moves aliases from the original variant payload', () => {
  const facts = checkPartial(
    'ownership/partial-variant',
    `
struct Token { value: i32 }
union Choice { First { token: Token }, Second }
fn choose(input: Choice) -> i32 {
  let result = match place input {
    Choice.First { token } => { let selected = move token return selected.value }
    Choice.Second {} => 0
  }
  drop input
  return result
}
fn restore(mut input: Choice) -> Choice {
  match place input {
    Choice.First { token } => { let selected = move token token = Token { value: selected.value } }
    Choice.Second {} => {}
  }
  return move input
}`,
  )
  assert.deepEqual(facts.diagnostics, [])
  const choose = facts.functions.at(0) ?? unreachable('expected choose ownership')
  const move = choose.transitions.find((transition) => transition.kind === 'Move')
  assert.strictEqual(move?.root._tag, 'Parameter')
  assert.strictEqual(MovePath.key(move?.path ?? []), 'v0/f0')
  assert.isTrue(choose.bindings.some((binding) => binding.place !== undefined))
  const restore = facts.functions.at(1) ?? unreachable('expected restored variant')
  assert.deepEqual(
    restore.transitions.map((transition) => [transition.kind, MovePath.key(transition.path)]),
    [
      ['Move', 'v0/f0'],
      ['Write', 'v0/f0'],
      ['Move', ''],
    ],
  )
})

it('rejects whole use after a projected move and records explicit partial-place termination', () => {
  const facts = checkPartial(
    'ownership/partial-drop',
    `
struct Token { value: i32 }
struct Pair { left: Token right: Token }
fn total(pair: Pair) -> i32 { return pair.left.value + pair.right.value }
fn invalid(pair: Pair) -> i32 { let first = move pair.left return total(move pair) }
fn cleanup(pair: Pair) -> i32 { let first = move pair.left drop pair return first.value }
`,
  )
  assert.deepEqual(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0001'],
  )
  const cleanup = facts.functions.at(-1) ?? unreachable('expected cleanup ownership')
  assert.strictEqual(cleanup.verdict._tag, 'Satisfied')
  assert.deepEqual(
    cleanup.transitions.map((transition) => [transition.kind, MovePath.key(transition.path)]),
    [
      ['Move', 'f0'],
      ['Drop', ''],
    ],
  )
  assert.isFalse(
    cleanup.exits.some((exit) => exit.releases.some((release) => release.binding.name === 'pair')),
  )
})

const golden = (name: string): string =>
  readFileSync(new URL(`./goldens/${name}`, import.meta.url), 'utf8')

it('publishes copyable binding facts live through the function body', () => {
  const facts = check('golden/accepted', acceptedSource)
  const choose = facts.functions.at(0)

  assert.strictEqual(choose?.verdict._tag, 'Satisfied')
  assert.deepEqual(
    choose?.bindings.map((binding) => ({
      name: binding.name,
      category: binding.category._tag,
      from: binding.liveFrom.start,
      to: binding.liveTo.end,
    })),
    [
      { name: 'left', category: 'Copyable', from: 14, to: 59 },
      { name: 'right', category: 'Copyable', from: 25, to: 59 },
    ],
  )
})

it('plans one empty-release return exit per frozen-slice function', () => {
  const facts = check('golden/accepted', acceptedSource)

  for (const fn of facts.functions) {
    assert.strictEqual(fn.exits.length, 1)
    assert.strictEqual(fn.exits.at(0)?.kind, 'Return')
    assert.deepEqual(fn.exits.at(0)?.releases, [])
  }
})

it('keeps unavailable verdicts explicit with causes', () => {
  const facts = check('golden/damaged', damagedSource)
  const puzzle = facts.functions.at(0)
  const main = facts.functions.at(1)

  assert.strictEqual(puzzle?.verdict._tag, 'Unavailable')
  if (puzzle?.verdict._tag !== 'Unavailable') return
  assert.strictEqual(puzzle.verdict.cause?.code, 'SEM0001')
  assert.strictEqual(main?.verdict._tag, 'Unavailable')
  if (main?.verdict._tag !== 'Unavailable') return
  assert.strictEqual(main.verdict.cause?.code, 'SEM0004')
})

it('matches the ownership golden encodings byte-for-byte', () => {
  assert.strictEqual(
    OwnershipEncoding.encode(check('golden/accepted', acceptedSource)),
    golden('accepted.ownership.txt'),
  )
  assert.strictEqual(
    OwnershipEncoding.encode(check('golden/damaged', damagedSource)),
    golden('damaged.ownership.txt'),
  )
})

it('matches the local-shared ownership golden and repeats byte-for-byte in process', () => {
  const first = OwnershipEncoding.encode(check('golden/local-shared', localSharedSource))
  const second = OwnershipEncoding.encode(check('golden/local-shared', localSharedSource))

  assert.strictEqual(first, golden('local-shared.ownership.txt'))
  assert.strictEqual(second, first)
})

it('checks and encodes identically across repeated fresh runs', () => {
  const first = check('golden/repeat', damagedSource)
  const second = check('golden/repeat', damagedSource)

  assert.deepEqual(first, second)
  assert.strictEqual(OwnershipEncoding.encode(first), OwnershipEncoding.encode(second))
})

const bindingSource = `pub fn main() -> i32 { let first = 1 let second = 2 return first }`

it('ranges let bindings from their statement to the end of the body', () => {
  const facts = check('golden/bindings', bindingSource)
  const main = facts.functions.at(0)

  assert.strictEqual(main?.verdict._tag, 'Satisfied')
  assert.deepEqual(
    main?.bindings.map((binding) => ({
      site: binding.site._tag,
      name: binding.name,
      from: binding.liveFrom.start,
      to: binding.liveTo.end,
    })),
    [
      { site: 'Let', name: 'first', from: 23, to: 66 },
      { site: 'Let', name: 'second', from: 37, to: 66 },
    ],
  )
  assert.strictEqual(facts.diagnostics.length, 0)
})

it('consumes an owner at explicit drop and rejects later use', () => {
  const facts = check(
    'ownership/explicit-drop',
    `struct Token { value: i32 }
fn inspect(token: Token) -> i32 { return token.value }
fn main() -> i32 {
  let token = Token { value: 1 }
  drop token
  return inspect(token)
}`,
  )
  assert.include(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0001',
  )
})

it('releases live let bindings in reverse binding order at the return exit', () => {
  const facts = check('golden/bindings', bindingSource)
  const exit = facts.functions.at(0)?.exits.at(0)

  assert.deepEqual(
    exit?.releases.map((release) => release.binding.name),
    ['second', 'first'],
  )
})

it('releases unused owned parameters in reverse declaration order', () => {
  const facts = check(
    'ownership/owned-parameter-order',
    `struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
effect fn hold(first: Token, middle: Token, last: Token) -> () {
  drop middle
  return ()
}
pub fn main() -> i32 { return 0 }`,
  )
  const hold = facts.functions.at(0)
  const returned = hold?.exits.find((exit) => exit.kind === 'Return')

  assert.deepEqual(facts.diagnostics, [])
  assert.deepEqual(
    returned?.releases.map((release) => ({
      name: release.binding.name,
      site: release.binding.site._tag,
    })),
    [
      { name: 'last', site: 'Parameter' },
      { name: 'first', site: 'Parameter' },
    ],
  )
})

it('ends liveness at a consuming move and skips the moved binding at the exit', () => {
  const facts = check(
    'golden/moved',
    `pub fn identity(value: i32) -> i32 { return value }
pub fn main() -> i32 { let value = 42 return identity(move value) }`,
  )
  const main = facts.functions.at(1)
  const binding = main?.bindings.at(0)

  assert.strictEqual(main?.verdict._tag, 'Satisfied')
  assert.strictEqual(binding?.name, 'value')
  assert.notStrictEqual(binding?.movedAt, undefined)
  assert.strictEqual(binding?.liveTo.end, binding?.movedAt?.end)
  assert.deepEqual(main?.exits.at(0)?.releases, [])
})

it('diagnoses a use after move as an OWN0001 violation with published facts', () => {
  const facts = check(
    'golden/violation',
    `pub fn choose(left: i32, right: i32) -> i32 { return right }
pub fn main() -> i32 { let value = 42 return choose(move value, value) }`,
  )
  const main = facts.functions.at(1)

  assert.strictEqual(main?.verdict._tag, 'Violation')
  if (main?.verdict._tag !== 'Violation') return
  assert.strictEqual(main.verdict.cause.code, 'OWN0001')
  assert.strictEqual(main.verdict.cause.phase, 'ownership')
  assert.deepEqual(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0001'],
  )
  const diagnostic = facts.diagnostics.at(0)
  assert.strictEqual(diagnostic?.relatedSpans?.at(0)?.label, 'moved here')
  assert.strictEqual(main.bindings.length, 1)
})

it('treats valid scalar enums as cleanup-free Copy values while explicit move still consumes', () => {
  const reusable = check(
    'ownership/scalar-enum-copy',
    `enum State { Ready, Done }
fn choose(left: State, right: State) -> State { return right }
pub fn main() -> i32 {
  let state = State.Ready
  let copy = state
  let selected = choose(state, copy)
  drop selected
  return 0
}`,
  )
  const main = reusable.functions.at(1)
  assert.strictEqual(main?.verdict._tag, 'Satisfied')
  assert.deepEqual(
    main?.bindings.map((binding) => ({
      name: binding.name,
      category: binding.category._tag,
      cleanup: binding.cleanup._tag,
    })),
    [
      { name: 'state', category: 'Copyable', cleanup: 'NoCleanup' },
      { name: 'copy', category: 'Copyable', cleanup: 'NoCleanup' },
      { name: 'selected', category: 'Copyable', cleanup: 'NoCleanup' },
    ],
  )
  assert.ok(
    main?.exits
      .flatMap((exit) => exit.releases)
      .every((release) => release.cleanup._tag === 'NoCleanup'),
  )

  const consumed = check(
    'ownership/scalar-enum-move',
    `enum State { Ready }
fn choose(left: State, right: State) -> State { return right }
pub fn main() -> i32 {
  let state = State.Ready
  let selected = choose(move state, state)
  drop selected
  return 0
}`,
  )
  assert.deepEqual(
    consumed.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0001'],
  )
})

it('accepts an ordinary read before the consuming move', () => {
  const facts = check(
    'golden/read-then-move',
    `pub fn choose(left: i32, right: i32) -> i32 { return right }
pub fn main() -> i32 { let value = 42 return choose(value, move value) }`,
  )

  assert.strictEqual(facts.functions.at(1)?.verdict._tag, 'Satisfied')
  assert.strictEqual(facts.diagnostics.length, 0)
})

it('matches the binding ownership golden encoding byte-for-byte', () => {
  assert.strictEqual(
    OwnershipEncoding.encode(check('golden/bindings', bindingSource)),
    golden('bindings.ownership.txt'),
  )
})

const branchSource = `pub fn main() -> i32 { let outer = 2 if outer == 2 { let inner = 1 return inner } return outer }`

it('scopes arm bindings to their arm with per-return exits', () => {
  const facts = check('golden/arms', branchSource)
  const main = facts.functions.at(0)

  assert.strictEqual(main?.verdict._tag, 'Satisfied')
  const exits = main?.exits ?? []
  assert.deepEqual(
    exits.map((exit) => ({
      kind: exit.kind,
      releases: exit.releases.map((release) => release.binding.name),
    })),
    [
      { kind: 'Return', releases: ['inner', 'outer'] },
      { kind: 'Return', releases: ['outer'] },
    ],
  )
})

it('releases an unmoved arm binding at the arm end when the arm falls through', () => {
  const facts = check(
    'golden/arm-end',
    'pub fn main() -> i32 { if 1 == 1 { let side = 5 } return 0 }',
  )
  const main = facts.functions.at(0)
  const armEnd = main?.exits.find((exit) => exit.kind === 'ArmEnd')

  assert.notStrictEqual(armEnd, undefined)
  assert.deepEqual(
    armEnd?.releases.map((release) => release.binding.name),
    ['side'],
  )
})

it('keeps a value live when the only arm that moves it returns', () => {
  const facts = check(
    'golden/conditional-move',
    `pub fn identity(value: i32) -> i32 { return value }
pub fn main() -> i32 { let value = 1 if 1 == 1 { return identity(move value) } return value }`,
  )
  const main = facts.functions.at(1)

  assert.strictEqual(main?.verdict._tag, 'Satisfied')
  assert.deepEqual(facts.diagnostics, [])
})

it('consumes a take recipe on its first run and rejects a repeated run', () => {
  const facts = check(
    'ownership/take-effect',
    `struct Payload { value: i32 }
effect fn inspect(payload: Payload) -> i32 { return payload.value }
pub fn main() -> i32 {
  let payload = Payload { value: 21 }
  let recipe = inspect(move payload)
  let first = run recipe
  return first + run recipe
}`,
  )

  assert.deepEqual(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0001'],
  )
  assert.strictEqual(facts.functions.at(1)?.verdict._tag, 'Violation')
})

it('consumes a take effect parameter on its first run and rejects a repeated run', () => {
  const facts = check(
    'ownership/take-effect-parameter',
    `pub effect fn twice<A, E, ?R>(self: once Effect<A ! E ? R>) -> A ! E ? R {
  let first = run self
  return run self
}`,
  )

  assert.deepEqual(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0001'],
  )
  assert.strictEqual(facts.functions.at(0)?.verdict._tag, 'Violation')
})

it('accepts a single run of a take effect parameter', () => {
  const facts = check(
    'ownership/take-effect-parameter-single',
    `pub effect fn flattenLike<A, E, F, ?R, ?S>(
  self: once Effect<Effect<A ! F ? S> ! E ? R>
) -> A ! E | F ? R | S {
  let inner = run self
  return run inner
}`,
  )

  assert.deepEqual(facts.diagnostics, [])
  assert.strictEqual(facts.functions.at(0)?.verdict._tag, 'Satisfied')
})

it('allows a shared effect parameter to run repeatedly', () => {
  const facts = check(
    'ownership/shared-effect-parameter',
    `pub effect fn twiceShared<?R>(self: Effect<i32 ? R>) -> i32 ? R {
  return (run self) + (run self)
}`,
  )

  assert.deepEqual(facts.diagnostics, [])
  assert.strictEqual(facts.functions.at(0)?.verdict._tag, 'Satisfied')
})

it('derives take-once execution from an effect-block moved capture', () => {
  const facts = check(
    'ownership/take-effect-block',
    `struct Payload { value: i32 }
pub fn main(payload: Payload) -> i32 {
  let pending = effect { return move payload }
  let first = run pending
  let second = run pending
  return first.value + second.value
}`,
  )

  assert.include(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0001',
  )
  assert.strictEqual(facts.functions.at(0)?.verdict._tag, 'Violation')
})

it('allows a shared copy-only recipe to run repeatedly', () => {
  const facts = check(
    'ownership/shared-effect',
    `effect fn inspect(value: i32) -> i32 { return value }
pub fn main() -> i32 {
  let recipe = inspect(21)
  return (run recipe) + (run recipe)
}`,
  )

  assert.deepEqual(facts.diagnostics, [])
  assert.strictEqual(facts.functions.at(1)?.verdict._tag, 'Satisfied')
})

it('keeps a borrowed effect capture loan live until its last run', () => {
  const facts = check(
    'ownership/borrowed-effect',
    `effect fn inspect(values: &[i32]) -> i32 { return values[0] }
pub fn main() -> i32 {
  let mut values = [1]
  let recipe = inspect(&values)
  values[0] = 2
  return run recipe
}`,
  )
  const main = facts.functions.at(1)
  const loan = main?.loans.at(0)

  assert.deepEqual(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0011'],
  )
  assert.strictEqual(main?.verdict._tag, 'Violation')
  assert.notStrictEqual(loan, undefined)
  assert.ok((loan?.endSpan.start ?? 0) > (loan?.startSpan.start ?? 0))
})

it('keeps an existing borrowed provider live until its last run', () => {
  const facts = check(
    'ownership/borrowed-provider',
    `struct Clock { tick: i32 }
effect fn read() -> i32 ? &Clock { return 42 }
pub fn main() -> i32 {
  let mut clock = Clock { tick: 0 }
  let recipe = read() |> Intrinsic.bindRequirement(&clock)
  clock.tick = 1
  return run recipe
}`,
  )

  assert.deepEqual(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0011'],
  )
  assert.strictEqual(facts.functions.at(1)?.verdict._tag, 'Violation')
})

it('moves an owned provider into a take-once Effect wrapper', () => {
  const facts = check(
    'ownership/moved-provider',
    `struct Token { action: once fn<'static>() -> i32 }
struct Clock { token: Token }
fn tick() -> i32 { return 1 }
effect fn read() -> i32 ? &mut Clock { return 42 }
pub fn main() -> i32 {
  let clock = Clock { token: Token { action: tick } }
  let recipe = read() |> Intrinsic.bindRequirementOwned(move clock)
  let first = run recipe
  return first + run recipe
}`,
  )

  assert.include(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0001',
  )
  assert.strictEqual(facts.functions.at(2)?.verdict._tag, 'Violation')
})

it('copies an owned Copy provider so its bound Effect remains repeatable', () => {
  const facts = check(
    'ownership/copied-provider',
    `struct Clock { tick: i32 }
impl Copy for Clock {}
effect fn read() -> i32 ? &mut Clock { return 42 }
pub fn main() -> i32 {
  let clock = Clock { tick: 0 }
  let recipe = read() |> Intrinsic.bindRequirementOwned(move clock)
  return (run recipe) + (run recipe)
}`,
  )

  assert.deepEqual(facts.diagnostics, [])
  assert.strictEqual(facts.functions.at(1)?.verdict._tag, 'Satisfied')
})

it('allows an owner to change after the borrowed recipe has finished its last run', () => {
  const facts = check(
    'ownership/finished-borrowed-effect',
    `effect fn inspect(values: &[i32]) -> i32 { return values[0] }
pub fn main() -> i32 {
  let mut values = [1]
  let recipe = inspect(&values)
  let seen = run recipe
  values[0] = 2
  return seen + values[0]
}`,
  )

  assert.deepEqual(facts.diagnostics, [])
  assert.strictEqual(facts.functions.at(1)?.verdict._tag, 'Satisfied')
})

it('treats Evaluate expressions as ownership roots without inventing bindings', () => {
  const moved = check(
    'ownership/evaluate-move',
    `struct Token { value: i32 }
fn consume(token: Token) -> () { drop move token return () }
pub fn main() -> i32 {
  let token = Token { value: 1 }
  consume(move token)
  consume(move token)
  return 0
}`,
  )
  const borrowed = check(
    'ownership/evaluate-borrow',
    `effect fn inspect(values: &[i32]) -> () { return () }
pub fn main() -> i32 {
  let mut values = [1]
  let recipe = inspect(&values)
  run recipe
  values[0] = 2
  return values[0]
}`,
  )
  const propagated = check(
    'ownership/evaluate-propagation',
    `struct Token { value: i32 }
impl Drop for Token {
  fn drop(self: &mut Token) -> () { return () }
}
struct Problem {}
effect fn stop() -> () ! Problem { fail move Problem {} }
effect fn outer() -> () ! Problem {
  let token = Token { value: 1 }
  run stop()
  return ()
}`,
  )
  const outer = propagated.functions.at(1)
  const propagation = outer?.exits.find((exit) => exit.kind === 'Propagation')

  assert.include(
    moved.diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0001',
  )
  assert.deepEqual(borrowed.diagnostics, [])
  assert.strictEqual(borrowed.functions.at(1)?.loans.length, 1)
  assert.deepEqual(propagated.diagnostics, [])
  assert.deepEqual(
    outer?.deferredBindings
      .filter((binding) => binding.site._tag === 'Let')
      .map((binding) => binding.name),
    ['token'],
  )
  assert.deepEqual(
    propagation?.releases.map((release) => release.binding.name),
    ['token'],
  )
})

it('keeps ownership checking active for acknowledged unsafe source calls', () => {
  const facts = check(
    'ownership/unsafe-call-move',
    `struct Token { value: i32 }
unsafe fn consume(token: Token) -> () { drop move token return () }
pub fn main() -> i32 {
  let token = Token { value: 1 }
  unsafe consume(move token)
  unsafe consume(move token)
  return 0
}`,
  )

  assert.include(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0001',
  )
})

it('plans a stored callable environment and drops moved slots in reverse capture order', () => {
  const facts = check(
    'ownership/callable-environment',
    `struct Token { value: i32 }
fn select(value: i32, first: Token, second: Token) -> i32 { return value }
pub fn main() -> i32 {
  let first = Token { value: 1 }
  let second = Token { value: 2 }
  let callback = select(move first, move second)
  return 0
}`,
  )
  const main = facts.functions.at(1)
  const environment = main?.callables.at(0)
  const callback = main?.bindings.find((binding) => binding.name === 'callback')

  assert.deepEqual(facts.diagnostics, [])
  assert.strictEqual(environment?.mode, 'Take')
  assert.deepEqual(environment?.dropOrder, [1, 0])
  assert.strictEqual(callback?.cleanup._tag, 'CallableCleanup')
  if (callback?.cleanup._tag !== 'CallableCleanup') return
  assert.deepEqual(
    callback.cleanup.slots.map((slot) => slot.ordinal),
    [1, 0],
  )
})

it('rejects a second invocation of a take-once callable binding', () => {
  const facts = check(
    'ownership/take-callable-reuse',
    `struct Token { value: i32 }
fn consume(value: i32, token: Token) -> i32 { return value }
pub fn main() -> i32 {
  let token = Token { value: 1 }
  let callback = consume(move token)
  let first = callback(20)
  let second = callback(22)
  return first + second
}`,
  )

  assert.include(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0001',
  )
  assert.strictEqual(facts.functions.at(1)?.verdict._tag, 'Violation')
})

it('retains a callable capture loan until the callable is dropped', () => {
  const blocked = check(
    'ownership/borrowed-callable',
    `fn read(value: i32, values: &mut [i32]) -> i32 { return value }
pub fn main() -> i32 {
  let mut values = [1]
  let callback = read(&mut values)
  values[0] = 2
  return callback(42)
}`,
  )
  const released = check(
    'ownership/dropped-borrowed-callable',
    `fn read(value: i32, values: &mut [i32]) -> i32 { return value }
pub fn main() -> i32 {
  let mut values = [1]
  let callback = read(&mut values)
  drop callback
  values[0] = 2
  return values[0]
}`,
  )

  assert.include(
    blocked.diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0011',
  )
  assert.deepEqual(released.diagnostics, [])
  assert.strictEqual(released.functions.at(1)?.loans.at(0)?.origin, 'CallableCapture')
})

it('checks an affine pipeline input once before its callable section', () => {
  const facts = check(
    'ownership/affine-pipeline',
    `struct Token { value: i32 }
fn consume(token: Token, adjustment: i32) -> i32 { return token.value + adjustment }
pub fn main() -> i32 {
  let token = Token { value: 40 }
  let result = move token |> consume(2)
  drop token
  return result
}`,
  )

  assert.deepEqual(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0001'],
  )
})

it('distinguishes immutable and mutable owned parameter storage', () => {
  const immutable = check(
    'ownership/immutable-owned-parameter',
    `struct Counter { value: i32 }
fn increment(counter: Counter) -> Counter {
  counter.value = counter.value + 1
  return move counter
}
pub fn main() -> i32 { return 0 }`,
  )
  const mutable = check(
    'ownership/mutable-owned-parameter',
    `struct Counter { value: i32 }
fn increment(mut counter: Counter) -> Counter {
  counter.value = counter.value + 1
  return move counter
}
pub fn main() -> i32 { return 0 }`,
  )
  const indexed = check(
    'ownership/mutable-owned-array-parameter',
    `fn update(mut values: [i32; 2]) -> [i32; 2] {
  values[0] = values[0] + 1
  return move values
}
pub fn main() -> i32 { return 0 }`,
  )

  assert.deepEqual(immutable.diagnostics, [])
  assert.deepEqual(mutable.diagnostics, [])
  assert.deepEqual(indexed.diagnostics, [])
  assert.strictEqual(immutable.functions.at(0)?.bindings.at(0)?.mutability, 'Immutable')
  assert.strictEqual(mutable.functions.at(0)?.bindings.at(0)?.mutability, 'Mutable')
})

it('reinitializes a mutable owned parameter after an explicit move', () => {
  const accepted = check(
    'ownership/reinitialized-owned-parameter',
    `struct Counter { value: i32 }
fn reset(mut counter: Counter) -> Counter {
  let previous = move counter
  counter = Counter { value: previous.value + 1 }
  drop previous
  return move counter
}
pub fn main() -> i32 { return 0 }`,
  )
  const rejected = check(
    'ownership/moved-owned-parameter',
    `struct Counter { value: i32 }
fn invalid(mut counter: Counter) -> i32 {
  let moved = move counter
  return counter.value
}
pub fn main() -> i32 { return 0 }`,
  )

  assert.deepEqual(accepted.diagnostics, [])
  assert.deepEqual(
    rejected.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0001'],
  )
})

it('borrows mutable owned parameter storage exclusively', () => {
  const facts = check(
    'ownership/borrowed-mutable-owned-parameter',
    `struct Counter { value: i32 }
fn increment(view: &mut Counter) -> i32 {
  view.value = view.value + 1
  return view.value
}
fn update(mut counter: Counter) -> Counter {
  let result = increment(&mut counter)
  return move counter
}
pub fn main() -> i32 { return 0 }`,
  )

  assert.deepEqual(facts.diagnostics, [])
  assert.strictEqual(facts.functions.at(1)?.loans.at(0)?.root._tag, 'Parameter')
  assert.strictEqual(facts.functions.at(1)?.loans.at(0)?.access, 'Exclusive')
})

it('blocks mutable owned parameter access until its exclusive loan ends', () => {
  const facts = check(
    'ownership/mutable-owned-parameter-active-loan',
    `struct Counter { value: i32 }
fn invalid(mut counter: Counter) -> Counter {
  let mut view = &mut counter
  counter.value = 1
  view.value = 2
  return move counter
}
pub fn main() -> i32 { return 0 }`,
  )

  assert.deepEqual(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0011'],
  )
})

it('releases a live mutable owned parameter on typed failure', () => {
  const facts = check(
    'ownership/mutable-owned-parameter-failure',
    `struct Token { value: i32 }
struct Problem {}
effect fn stop(mut token: Token) -> never ! Problem {
  fail Problem {}
}
pub fn main() -> i32 { return 0 }`,
  )
  const failureExit = facts.functions
    .at(0)
    ?.exits.find((exit) => exit.releases.some((release) => release.binding.name === 'token'))

  assert.deepEqual(facts.diagnostics, [])
  assert.strictEqual(failureExit?.kind, 'Return')
  assert.deepEqual(
    failureExit?.releases.map((release) => release.binding.name),
    ['token'],
  )
})

it('keeps a mutable owned parameter live across loop transfer and releases it once on return', () => {
  const facts = check(
    'ownership/mutable-owned-parameter-loop-transfer',
    `struct Token { value: i32 }
impl Drop for Token {
  fn drop(self: &mut Token) -> () { return () }
}
fn finish(mut token: Token) -> () {
  while token.value > 0 {
    break
  }
  return ()
}
pub fn main() -> i32 { return 0 }`,
  )
  const finish = facts.functions.at(0)
  const breakExit = finish?.exits.find((exit) => exit.kind === 'Break')
  const returnExit = finish?.exits.find(
    (exit) =>
      exit.kind === 'Return' && exit.releases.some((release) => release.binding.name === 'token'),
  )

  assert.deepEqual(facts.diagnostics, [])
  assert.notInclude(breakExit?.releases.map((release) => release.binding.name) ?? [], 'token')
  assert.deepEqual(
    returnExit?.releases.map((release) => release.binding.name),
    ['token'],
  )
})

it('requires explicit transfer at mutable owned parameter boundaries and rejects overlap', () => {
  const caller = check(
    'ownership/mutable-owned-parameter-caller-move',
    `struct Counter { value: i32 }
fn increment(mut counter: Counter) -> Counter { return move counter }
pub fn main() -> i32 {
  let counter = Counter { value: 0 }
  let result = increment(counter)
  return result.value
}`,
  )
  const returned = check(
    'ownership/mutable-owned-parameter-return-move',
    `struct Counter { value: i32 }
fn increment(mut counter: Counter) -> Counter { return counter }
pub fn main() -> i32 { return 0 }`,
  )
  const overlap = check(
    'ownership/mutable-owned-parameter-overlap',
    `struct Counter { value: i32 }
fn replace(mut counter: Counter) -> Counter {
  counter = move counter
  return Counter { value: 0 }
}
pub fn main() -> i32 { return 0 }`,
  )

  assert.deepEqual(
    caller.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0003'],
  )
  assert.deepEqual(
    returned.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0003'],
  )
  assert.deepEqual(
    overlap.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0004'],
  )
})

it('assigns Allocation one private active reclaim ticket', () => {
  const facts = check(
    'ownership/allocation-ticket',
    `fn consume(allocation: Allocation) -> i32 { return 42 }
pub fn main() -> i32 { return 0 }`,
  )
  const release = facts.functions.at(0)?.exits.at(0)?.releases.at(0)

  assert.deepEqual(facts.diagnostics, [])
  assert.strictEqual(release?.binding.name, 'allocation')
  assert.strictEqual(release?.binding.category._tag, 'MoveOnly')
  assert.deepEqual(release?.cleanup, {
    _tag: 'AllocationCleanup',
    type: Type.allocation,
    ticket: 'ActiveReclaimTicket',
  })
})

it('plans cleanup only through the active nominal union variant', () => {
  const facts = check(
    'ownership/nominal-union-cleanup',
    `union MaybeAllocation { None, Some { value: Allocation } }
fn consume(value: MaybeAllocation) -> i32 { return 42 }
pub fn main() -> i32 { return 0 }`,
  )
  const cleanup = facts.functions.at(0)?.exits.at(0)?.releases.at(0)?.cleanup

  assert.deepEqual(facts.diagnostics, [])
  assert.strictEqual(cleanup?._tag, 'NominalUnionCleanup')
  if (cleanup?._tag !== 'NominalUnionCleanup') return
  assert.deepEqual(
    cleanup.variants.map((variant) => ({
      name: variant.variant.name,
      fields: variant.fields.map((field) => field.cleanup._tag),
    })),
    [
      { name: 'None', fields: [] },
      { name: 'Some', fields: ['AllocationCleanup'] },
    ],
  )
})

it('admits Copy and Drop conformances on nominal union parents', () => {
  const copied = check(
    'ownership/nominal-union-copy',
    `union Choice { First { value: i32 }, Second }
impl Copy for Choice {}
fn duplicate(value: Choice) -> Choice { let copy = value return move copy }
pub fn main() -> i32 { return 0 }`,
  )
  const dropped = check(
    'ownership/nominal-union-drop',
    `union Owner { Empty, Present { value: i32 } }
impl Drop for Owner {
  fn drop(self: &mut Owner) -> () { return () }
}
fn consume(value: Owner) -> i32 { return 0 }
pub fn main() -> i32 { return 0 }`,
  )

  assert.deepEqual(copied.diagnostics, [])
  assert.strictEqual(copied.functions.at(0)?.bindings.at(0)?.category._tag, 'Copyable')
  assert.deepEqual(dropped.diagnostics, [])
  assert.strictEqual(
    dropped.functions.at(0)?.exits.at(0)?.releases.at(0)?.cleanup._tag,
    'HookCleanup',
  )
})

it('ends exclusive service access when a provided operation returns', () => {
  const facts = check(
    'ownership/service-provider-loan',
    `service Counter { effect fn next() -> i32 ? &mut Counter }
struct Provider { value: i32 }
effect fn next(self: &mut Provider) -> i32 { return self.value }
impl Counter for Provider { next: Provider.next }
effect fn readTwice(provider: Provider) -> i32 {
  let mut allocator = move provider
  let firstRecipe = Counter.next() |> Intrinsic.bindRequirementMut(&mut allocator)
  let first = run firstRecipe
  let secondRecipe = Counter.next() |> Intrinsic.bindRequirementMut(&mut allocator)
  let second = run secondRecipe
  return first + second
}
pub fn main() -> i32 { return 0 }`,
  )

  assert.deepEqual(facts.diagnostics, [])
  assert.strictEqual(facts.functions.at(0)?.verdict._tag, 'Satisfied')
})

it('ends unsafe lexical owners at the explicit boundary', () => {
  const facts = check(
    'ownership/unsafe-boundary',
    'struct Token { value: i32 } pub fn main() -> i32 { unsafe { let token = Token { value: 1 } } return 42 }',
  )
  const scopeExit = facts.functions.at(0)?.exits.find((exit) => exit.kind === 'ScopeEnd')
  assert.deepEqual(facts.diagnostics, [])
  assert.strictEqual(scopeExit?.releases.at(0)?.binding.name, 'token')
  assert.strictEqual(scopeExit?.releases.at(0)?.cleanup._tag, 'StructCleanup')
})

it('keeps a Slot loan active until the lexical Slot is consumed', () => {
  const facts = check(
    'ownership/slot-loan',
    `fn misuse(buffer: RawBuffer<i32>) -> i32 {
  let mut owner = move buffer
  unsafe {
    let slot = Intrinsic.rawBufferSlot(&mut owner, 0)
    drop owner
    let value = Intrinsic.slotTake(move slot)
    return value
  }
  return 0
}`,
  )

  assert.include(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    'OWN0011',
  )
  assert.strictEqual(facts.functions.at(0)?.loans.at(0)?.origin, 'ReturnedView')
})

it('reports moves and double drops inside lazy effect bodies', () => {
  const doubled = check(
    'ownership/effect-body-double-drop',
    `import silk.effect { Effect }
struct Token { value: i32 }
struct Problem { code: i32 }
effect fn store() -> i32 ! Problem {
  let token = Token { value: 1 }
  drop token
  drop token
  return 1
}
effect fn recover(error: Problem) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
  )
  assert.deepEqual(
    doubled.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0001'],
  )

  // A healthy body stays clean, and the deferred walk publishes no facts for it: the body's
  // exits and bindings belong to its own compiled function, not to the enclosing one.
  const healthy = check(
    'ownership/effect-body-healthy',
    `import silk.effect { Effect }
struct Token { value: i32 }
struct Problem { code: i32 }
effect fn store() -> i32 ! Problem {
  let token = Token { value: 1 }
  drop token
  return 1
}
effect fn recover(error: Problem) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
  )
  assert.deepEqual(healthy.diagnostics, [])
  const store = healthy.functions.at(0)
  assert.deepEqual(
    store?.bindings.filter((binding) => binding.site._tag === 'Let'),
    [],
  )
})

it('publishes an effect fn body pattern binding as a deferred fact that allBindings joins', () => {
  const source = (modifiers: string): string =>
    `struct Left { value: i32 }
struct Right { value: i32 }
${modifiers} fn inspect(input: Left | Right) -> i32 {
  return match &input {
    Left { value } => value
    Right { value } => value
  }
}`
  const plain = check('ownership/pattern-plain', source('pub'))
  const deferred = check('ownership/pattern-effect', source('pub effect'))
  const names = (facts: ReadonlyArray<Ownership.BindingFact>): ReadonlyArray<string | undefined> =>
    facts.filter((binding) => binding.site._tag === 'Pattern').map((binding) => binding.name)

  assert.deepEqual(plain.diagnostics, [])
  assert.deepEqual(deferred.diagnostics, [])

  // A plain body's pattern bindings reach the enclosing fact set.
  const inspected = plain.functions.at(0)
  assert.deepEqual(names(inspected?.bindings ?? []), ['value', 'value'])
  assert.deepEqual(names(inspected?.deferredBindings ?? []), [])

  // An effect fn is entirely a deferred body, so the same patterns publish on the other field.
  // This is the documented publication boundary, not a tracking hole — see FunctionOwnership.
  const lazy = deferred.functions.at(0)
  assert.deepEqual(names(lazy?.bindings ?? []), [])
  assert.deepEqual(names(lazy?.deferredBindings ?? []), ['value', 'value'])

  // allBindings is the join a consumer needing completeness must use: it answers the same for
  // both shapes, where reading `bindings` alone does not.
  assert.deepEqual(names(Ownership.allBindings(inspected)), ['value', 'value'])
  assert.deepEqual(names(Ownership.allBindings(lazy)), ['value', 'value'])
  assert.deepEqual(Ownership.allBindings(undefined), [])
})

it('reports an incompatible loop header when the while condition consumes an owner', () => {
  const facts = check(
    'ownership/while-condition-consumes',
    `struct Token { value: i32 }
impl Drop for Token {
  fn drop(self: &mut Token) -> () { return () }
}
fn consume(token: Token) -> i32 { return 0 }
fn spin(token: Token) -> () {
  while consume(move token) == 1 {
  }
  return ()
}
pub fn main() -> i32 { return 0 }`,
  )

  assert.deepEqual(
    facts.diagnostics.map((diagnostic) => diagnostic.code),
    ['OWN0005'],
  )
})

it('joins conditional owner presence and omits cleanup when every branch transfers it', () => {
  const oneArm = check(
    'ownership/if-one-arm-move',
    `struct Token { value: i32 }
impl Drop for Token {
  fn drop(self: &mut Token) -> () { return () }
}
fn consume(token: Token) -> () { return () }
fn branch(token: Token) -> () {
  if 1 == 1 {
    consume(move token)
  }
  return ()
}
pub fn main() -> i32 { return 0 }`,
  )
  const bothArms = check(
    'ownership/if-both-arms-move',
    `struct Token { value: i32 }
impl Drop for Token {
  fn drop(self: &mut Token) -> () { return () }
}
fn consume(token: Token) -> () { return () }
fn branch(token: Token) -> () {
  if 1 == 1 {
    consume(move token)
  } else {
    consume(move token)
  }
  return ()
}
pub fn main() -> i32 { return 0 }`,
  )

  assert.deepEqual(oneArm.diagnostics, [])
  assert.deepEqual(bothArms.diagnostics, [])
  const conditional = oneArm.functions
    .find(
      (fn) =>
        fn.declaration.canonical._tag === 'Canonical' &&
        fn.declaration.canonical.id.name === 'branch',
    )
    ?.exits.flatMap((exit) => exit.releases)
    .find((release) => release.binding.name === 'token')
  assert.strictEqual(conditional?.initialization.initialization, 'Maybe')
  assert.isFalse(
    bothArms.functions
      .find(
        (fn) =>
          fn.declaration.canonical._tag === 'Canonical' &&
          fn.declaration.canonical.id.name === 'branch',
      )
      ?.exits.some((exit) => exit.releases.some((release) => release.binding.name === 'token')),
  )
})

it('copies a raw pointer binding freely without a move or cleanup', () => {
  const facts = check(
    'ownership/pointer-copy',
    `fn take(value: *const i32) -> i32 { return 0 }
pub fn twice(pointer: *mut i32) -> i32 {
  let copy = pointer
  return take(copy) + take(copy) + take(pointer)
}`,
  )

  assert.deepEqual(facts.diagnostics, [])
  const twice = facts.functions.at(1)
  assert.strictEqual(twice?.verdict._tag, 'Satisfied')
  assert.deepEqual(
    twice?.bindings.map((binding) => [binding.name, binding.category._tag]),
    [
      ['pointer', 'Copyable'],
      ['copy', 'Copyable'],
    ],
  )
})

it.effect('records no conflict when a pointer root is moved or mutated after formation', () =>
  Effect.gen(function* () {
    const moved = yield* Analysis.ofSource(
      'ownership/pointer-root-moved',
      ascii(`import silk.pointer { Pointer }
struct Token { value: i32 }
fn take(token: Token) -> i32 { return token.value }
pub fn main() -> i32 {
  let mut box = Token { value: 1 }
  let p = Pointer.fromMutRef(&mut box)
  return take(move box)
}`),
    )
    const mutated = yield* Analysis.ofSource(
      'ownership/pointer-root-mutated',
      ascii(`import silk.pointer { Pointer }
pub fn main() -> i32 {
  let mut values = [1, 2, 3, 4]
  let p = Pointer.fromMutSlice(&mut values)
  values[0] = 40
  return values[0]
}`),
    )

    assert.deepEqual(Analysis.diagnostics(moved), [])
    assert.deepEqual(Analysis.diagnostics(mutated), [])
  }),
)

const checkValid = (id: string, text: string): Ownership.ModuleOwnership => {
  const syntax = Parser.parse(Lexer.lex(SourceFile.make(id, ascii(text))))
  assert.deepEqual(syntax.lexicalDiagnostics, [])
  assert.deepEqual(syntax.parserDiagnostics, [])
  const elaboration = elaborate(syntax)
  assert.deepEqual(elaboration.diagnostics, [])
  return ownership(elaboration)
}

it('joins only completing match arms and releases selected block owners at their exits', () => {
  const source = `struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
struct Left { kept: Token omitted: Token }
struct Right {}
fn consume(earlier: Token, value: i32) -> i32 { return value }
fn inspect(input: Left | Right, owner: Token) -> i32 {
  let decision = consume(Token { value: 0 }, match move input {
    Left { kept, .. } => {
      let local = Token { value: 3 }
      drop owner
      return 7
    }
    Right {} => 2
  })
  return owner.value + decision
}`
  const facts = checkValid('ownership/ordinary-match-exits', source)
  const fn = facts.functions.at(1)
  assert.deepEqual(facts.diagnostics, [])
  assert.strictEqual(fn?.verdict._tag, 'Satisfied')
  const selectedExit = fn?.exits.find(
    (exit) => source.slice(exit.span.start, exit.span.end).trim() === '7',
  )
  assert.deepEqual(
    selectedExit?.releases.map((release) => release.binding.name),
    ['local', 'kept'],
  )
  assert.deepEqual(
    selectedExit?.matches.map((release) =>
      release.cleanup.map((field) => field.path.map((part) => part.ordinal)),
    ),
    [[[1]]],
  )
  assert.deepEqual(
    [
      ...(selectedExit?.releases.map((release) => ({
        ordinal: release.ordinal,
        name: release.binding.name,
      })) ?? []),
      ...(selectedExit?.matches.map((release) => ({ ordinal: release.ordinal, name: 'omitted' })) ??
        []),
      ...(selectedExit?.temporaries.map((release) => ({
        ordinal: release.ordinal,
        name: 'earlier',
      })) ?? []),
    ]
      .sort((left, right) => right.ordinal - left.ordinal)
      .map((entry) => entry.name),
    ['local', 'kept', 'omitted', 'earlier'],
  )
  const followingExit = fn?.exits.find(
    (exit) => source.slice(exit.span.start, exit.span.end).trim() === 'owner.value + decision',
  )
  assert.deepEqual(
    followingExit?.releases.map((release) => release.binding.name),
    ['decision', 'owner'],
  )
  assert.deepEqual(followingExit?.matches, [])
})

it('releases abandoned earlier arguments in reverse order without storing a transferring initializer', () => {
  const source = `struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
struct Left {}
struct Right {}
fn consume(first: Token, second: Token, value: i32) -> i32 { return value }
fn inspect(input: Left | Right) -> i32 {
  let result = consume(Token { value: 1 }, Token { value: 2 }, match &input {
    Left {} => { let local = Token { value: 3 } return 9 }
    Right {} => 4
  })
  return result
}`
  const facts = checkValid('ownership/ordinary-match-temporaries', source)
  const fn = facts.functions.at(1)
  assert.deepEqual(facts.diagnostics, [])
  const early = fn?.exits.find(
    (exit) => source.slice(exit.span.start, exit.span.end).trim() === '9',
  )
  assert.deepEqual(
    early?.temporaries.map((temporary) =>
      source.slice(temporary.span.start, temporary.span.end).trim(),
    ),
    ['Token { value: 2 }', 'Token { value: 1 }'],
  )
  assert.deepEqual(
    early?.releases.map((release) => release.binding.name),
    ['local', 'input'],
  )
  assert.isFalse(early?.releases.some((release) => release.binding.name === 'result'))
  const following = fn?.exits.find(
    (exit) => source.slice(exit.span.start, exit.span.end).trim() === 'result',
  )
  assert.deepEqual(following?.temporaries, [])
})

it('cleans a provisional consumed payload on guard transfer and preserves it on Boolean fallback', () => {
  const source = `struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
struct Left { token: Token }
struct Right {}
struct Stop {}
struct Keep {}
fn inspect(input: Left | Right, decision: Stop | Keep) -> i32 {
  return match move input {
    Left { token } if match &decision {
      Stop {} => { return 8 }
      Keep {} => false
    } => { drop token return 1 }
    Left { token } => { return token.value }
    Right {} => 0
  }
}`
  const facts = checkValid('ownership/ordinary-match-guard', source)
  const fn = facts.functions.at(0)
  assert.deepEqual(facts.diagnostics, [])
  const guardExit = fn?.exits.find(
    (exit) => source.slice(exit.span.start, exit.span.end).trim() === '8',
  )
  assert.deepEqual(
    guardExit?.releases.map((release) => release.binding.name),
    ['decision'],
  )
  assert.deepEqual(
    guardExit?.matches.flatMap((release) => release.cleanup.map((field) => field.path)),
    [[]],
  )
  const fallbackExit = fn?.exits.find(
    (exit) => source.slice(exit.span.start, exit.span.end).trim() === 'token.value',
  )
  assert.deepEqual(
    fallbackExit?.releases.map((release) => release.binding.name),
    ['token', 'decision'],
  )
  assert.isTrue(fn?.matches.some((match) => match.access === 'Move' && match.arms.length === 3))
})

it('keeps enclosing argument temporaries alive when an arm breaks only its own inner loop', () => {
  const source = `struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
struct Left {}
struct Right {}
fn consume(token: Token, unit: ()) -> i32 { return token.value }
fn inspect(input: Left | Right) -> i32 {
  return consume(Token { value: 1 }, match &input {
    Left {} => { while true { let local = Token { value: 2 } break } }
    Right {} => {}
  })
}`
  const facts = checkValid('ownership/ordinary-match-inner-loop', source)
  const fn = facts.functions.at(1)
  assert.deepEqual(facts.diagnostics, [])
  const transfer = fn?.exits.find((exit) => exit.kind === 'Break')
  assert.deepEqual(
    transfer?.releases.map((release) => release.binding.name),
    ['local'],
  )
  assert.deepEqual(transfer?.temporaries, [])
  assert.deepEqual(transfer?.matches, [])
  assert.isTrue(fn?.exits.some((exit) => exit.kind === 'Return'))
})

it('cleans abandoned operands on enclosing break continue and failure paths', () => {
  const source = `struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
struct Leave {}
struct Again {}
struct Stop {}
struct Problem {}
fn consume(token: Token, unit: ()) -> () { return () }
effect fn inspect(input: Leave | Again | Stop) -> () ! Problem {
  while true {
    drop consume(Token { value: 1 }, match &input {
      Leave {} => { let local = Token { value: 2 } break }
      Again {} => { let local = Token { value: 3 } continue }
      Stop {} => { let local = Token { value: 4 } fail Problem {} }
    })
  }
}`
  const facts = checkValid('ownership/ordinary-match-loop-failure', source)
  const fn = facts.functions.at(1)
  assert.deepEqual(facts.diagnostics, [])
  const transfers =
    fn?.exits.filter(
      (exit) =>
        exit.kind === 'Break' ||
        exit.kind === 'Continue' ||
        (exit.kind === 'Return' && exit.temporaries.length > 0),
    ) ?? []
  assert.deepEqual(
    transfers.map((exit) => exit.kind),
    ['Break', 'Continue', 'Return'],
  )
  for (const transfer of transfers) {
    assert.deepEqual(
      transfer.temporaries.map((temporary) =>
        source.slice(temporary.span.start, temporary.span.end).trim(),
      ),
      ['Token { value: 1 }'],
    )
    assert.deepEqual(
      transfer.releases
        .filter((release) => release.binding.name === 'local')
        .map((release) => release.binding.name),
      ['local'],
    )
    assert.deepEqual(
      transfer.matches.flatMap((match) => match.cleanup),
      [],
    )
  }
})

it('keeps provisional pattern consumption illegal inside an ordinary guard block', () => {
  const source = `struct Token { value: i32 }
struct Left { token: Token }
struct Right {}
struct Stop {}
struct Keep {}
fn inspect(input: Left | Right, decision: Stop | Keep) -> i32 {
  return match move input {
    Left { token } if match &decision {
      Stop {} => { drop token return 8 }
      Keep {} => false
    } => 1
    Left { token } => token.value
    Right {} => 0
  }
}
fn capture(input: Left | Right) -> i32 {
  return match move input {
    Left { token } if run effect { drop move token return false } => 1
    Left { token: fallback } => fallback.value
    Right {} => 0
  }
}`
  const facts = checkValid('ownership/ordinary-match-guard-consumption', source)
  assert.deepEqual(
    facts.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
    })),
    [
      { code: 'OWN0008', span: 'token' },
      { code: 'OWN0008', span: 'token' },
    ],
  )
})

it('ends an abandoned earlier argument loan only when control leaves its containing expression', () => {
  const source = `struct Token { value: i32 }
struct Left {}
struct Right {}
fn consume(token: &Token, unit: ()) -> i32 { return token.value }
fn inspect(input: Left | Right, owner: Token) -> i32 {
  return consume(&owner, match &input {
    Left {} => { while true { break } return 7 }
    Right {} => {}
  })
}`
  const facts = checkValid('ownership/ordinary-match-abandoned-loan', source)
  const fn = facts.functions.at(1)
  assert.deepEqual(facts.diagnostics, [])
  const loan =
    fn?.loans.find(
      (entry) => source.slice(entry.startSpan.start, entry.startSpan.end).trim() === '&owner',
    ) ?? raise('expected earlier argument loan')
  const innerBreak = fn?.exits.find((exit) => exit.kind === 'Break')
  assert.deepEqual(innerBreak?.loanEnds, [])
  const earlyReturn = fn?.exits.find(
    (exit) => source.slice(exit.span.start, exit.span.end).trim() === '7',
  )
  assert.deepEqual(earlyReturn?.loanEnds, [loan.id])
})

it.effect(
  'reuses exact source ownership proofs and caches failed residual checks without replaying work',
  () =>
    Effect.gen(function* () {
      const source = `fn choose(left: i32, right: i32) -> i32 { return right }
fn good(value: &i32) -> i32 { return value.* }
fn bad() -> i32 { let value = 42 return choose(move value, value) }`
      const snapshot = yield* Analysis.ofSource(
        'ownership/residual-cache',
        new TextEncoder().encode(source),
      )
      const result =
        snapshot.results.get(snapshot.closure.rootModule) ?? unreachable('expected source result')
      const plan = Ownership.localSharedAccessBoundaryPlan(snapshot.results)
      const context = SemanticContext.make(result.authored)
      const selected = (name: string): Ownership.CheckInput => {
        const fn =
          result.tir.functions.find(
            (candidate) =>
              candidate.declaration.name._tag === 'Present' &&
              candidate.declaration.name.spelling === name,
          ) ?? unreachable('expected TIR function')
        const body =
          result.bodies.find((candidate) => candidate.function === fn) ??
          unreachable('expected checked body')
        return Ownership.input(
          fn,
          body.artifact,
          body.results.lifetimes,
          snapshot.index,
          plan,
          context,
          body.results.causes,
        )
      }
      const good = selected('good')
      const bad = selected('bad')
      const query = ResidualOwnership.make()
      for (const input of [good, bad]) {
        const sourceProof =
          Ownership.sourceProof(input) ?? unreachable('expected published source proof')
        assert.strictEqual(ResidualOwnership.check(query, input, 'UnchangedBody'), sourceProof)
        assert.strictEqual(
          ResidualOwnership.check(
            query,
            { ...input, boundaries: [...input.boundaries] },
            'UnchangedBody',
          ),
          sourceProof,
        )
      }
      const retained = ResidualOwnership.counters(query)
      assert.strictEqual(retained.sourceReused, 2)
      assert.strictEqual(retained.cacheReused, 2)
      assert.strictEqual(retained.checked, 0)
      assert.isTrue(Object.values(retained.executedWork).every((count) => count === 0))
      const changed: ReadonlyArray<Ownership.CheckInput> = [
        { ...good, function: { ...good.function } },
        { ...good, lifetimes: { ...(good.lifetimes ?? unreachable('expected a region proof')) } },
        { ...good, index: { ...good.index } },
        { ...good, boundaries: [context.spanOf(good.function.declaration.anchor)] },
        { ...good, resultBoundaries: [context.spanOf(good.function.declaration.anchor)] },
      ]
      for (const input of changed) {
        assert.isUndefined(Ownership.sourceProof(input))
        ResidualOwnership.check(query, input, 'ChangedOwnershipInputs')
      }
      const failedInput = { ...bad, function: { ...bad.function } }
      const failed = ResidualOwnership.check(query, failedInput, 'SelectedStaticBody')
      assert.strictEqual(failed.ownership.verdict._tag, 'Violation')
      assert.deepEqual(
        failed.diagnostics.map((diagnostic) => diagnostic.code),
        ['OWN0001'],
      )
      const beforeHit = ResidualOwnership.counters(query)
      assert.strictEqual(ResidualOwnership.check(query, failedInput, 'SelectedStaticBody'), failed)
      const afterHit = ResidualOwnership.counters(query)
      assert.strictEqual(afterHit.checked, 6)
      assert.strictEqual(afterHit.requests, 11)
      assert.strictEqual(afterHit.cacheReused, 3)
      assert.deepEqual(afterHit.executedWork, beforeHit.executedWork)
      assert.isAbove(afterHit.executedWork.loanAccessChecks, 0)
      assert.isAbove(afterHit.executedWork.cleanupPlanQueries, 0)
      assert.deepEqual(
        ResidualOwnership.observations(query).map((observation) => observation.branch),
        [
          'SourceReused',
          'CacheReused',
          'SourceReused',
          'CacheReused',
          'Checked',
          'Checked',
          'Checked',
          'Checked',
          'Checked',
          'Checked',
          'CacheReused',
        ],
      )
      assert.isTrue(
        ResidualOwnership.observations(query)
          .filter((observation) => observation.branch !== 'Checked')
          .every((observation) => observation.work === undefined),
      )
    }),
)

const installedDropPrelude = `struct Source { value: i32 }
impl Drop for Source { fn drop(self: &mut Source) -> () { self.value = 99 return () } }
struct Guard<'a> { value: &'a Source }
impl<'a> Drop for Guard<'a> {
  fn drop(self: &mut Guard<'a>) -> () { let observed = self.value.value return () }
}
`

for (const [name, body, valid] of [
  [
    'later',
    `let first = Source { value: 1 }
    let mut guard = Guard { value: &first }
    let second = Source { value: 2 }
    guard.value = &second`,
    false,
  ],
  [
    'nested',
    `let first = Source { value: 1 }
    let mut guard = Guard { value: &first }
    if true { let second = Source { value: 2 } guard.value = &second }`,
    false,
  ],
  [
    'earlier',
    `let first = Source { value: 1 }
    let second = Source { value: 2 }
    let mut guard = Guard { value: &first }
    guard.value = &second`,
    true,
  ],
] as const) {
  it.effect(`checks installed dependent Drop referents at cleanup: ${name}`, () =>
    Effect.gen(function* () {
      const source = `${installedDropPrelude}fn check() -> i32 { ${body} return 0 }`
      const snapshot = yield* Analysis.ofSource(`ownership/installed-drop-${name}`, ascii(source))
      const diagnostics = Analysis.diagnostics(snapshot)
      if (valid) assert.deepEqual(diagnostics, [])
      else {
        const diagnostic =
          diagnostics.find((diagnostic) => diagnostic.code === 'OWN0019') ??
          unreachable('expected expired installed lifetime')
        assert.isTrue(
          diagnostic.relatedSpans?.some(
            ({ span }) =>
              span.start === source.indexOf('&second') &&
              span.end === source.indexOf('&second') + '&second'.length,
          ),
        )
      }
    }),
  )
}

for (const [name, acquisition] of [
  ['match', 'match move input { Envelope { pair } => { if i == 0 { drop pair.a } } }'],
  [
    'statement',
    `let Envelope { pair } = move input
 if i == 0 { drop pair.a }`,
  ],
] as const) {
  it.effect(`resets reacquired ${name} owners inside selected execution`, () =>
    Effect.gen(function* () {
      const source = `struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
struct Pair { a: Token b: Token }
struct Envelope { pair: Pair }
pub fn main() -> i32 {
  let mut i = 0
  while i < 2 {
    let input = Envelope { pair: Pair { a: Token { value: 1 }, b: Token { value: 2 } } }
    ${acquisition}
    i = i + 1
  }
  return 0
}`
      const selected = AnalysisFixture.configuration(
        `ownership/reacquired-${name}`,
        'wasm32-unknown-unknown',
      )
      const front = yield* Analysis.make({
        root: `ownership/reacquired-${name}`,
        configuration: selected,
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make(`ownership/reacquired-${name}`, ascii(source)),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      )
      assert.deepEqual(Analysis.diagnostics(front), [])
      const snapshot = yield* Analysis.realize(front, selected, {
        normalizeMir: false,
      }).pipe(Effect.provide(SourceResolver.empty))
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const program = Analysis.loweredMir(snapshot)
      assert.deepEqual(yield* MirVerification.verify(program), [])
      const fn =
        program.functions.find((fn) => fn.id.name === 'main') ?? unreachable('expected main')
      const operations = MirVerification.operations(fn)
      const clear = operations.find((op) => op._tag === 'SetInitialized' && !op.initialized)
      if (clear?._tag !== 'SetInitialized') return unreachable('expected conditional field flag')
      const match = operations.find(
        (op) => op._tag === 'Match' && op.arms.some((arm) => arm.bindings.length > 0),
      )
      if (match?._tag !== 'Match') return unreachable('expected acquiring match')
      const arm =
        match.arms.find((arm) => arm.bindings.length > 0) ?? unreachable('expected selected arm')
      const entry = arm.selected.execution.regions.find(
        (region) => region.id.ordinal === arm.selected.execution.entry.ordinal,
      )
      if (entry?._tag !== 'OperationRegion')
        return unreachable('expected selected entry operations')
      assert.isTrue(
        entry.operations.some(
          (op) =>
            op._tag === 'SetInitialized' &&
            op.flag.ordinal === clear.flag.ordinal &&
            op.initialized,
        ),
      )
    }),
  )
}

it.effect(
  'authenticates invocation-use payload owners and retains real loans through scoped holder aliases',
  () =>
    Effect.gen(function* () {
      const source = `struct Holder<'scope> { work: once Effect<'scope; i32> }
fn owned<T>(callback: for<use 'call> once fn<'static>(T, T) -> once Effect<'call; i32>, first: T, second: T) -> i32 {
  let waiting = callback(move first, move second)
  drop waiting
  return 0
}
fn staged<T>(callback: for<use 'call> once fn<'static>(T, T, T) -> once Effect<'call; i32>, first: T, second: T, third: T) -> i32 {
  let firstStage = callback(move third)
  let alias = move firstStage
  let secondStage = alias(move second)
  let waiting = secondStage(move first)
  drop waiting
  return 0
}
fn blocked(callback: for<use 'call> once fn<'static>(&'call mut [i32]) -> once Effect<'call; i32>) -> i32 {
  let mut values = [1]
  let waiting = callback(&mut values)
  let holder = Holder { work: move waiting }
  values[0] = 2
  drop holder
  return 0
}
fn released(callback: for<use 'call> once fn<'static>(&'call mut [i32]) -> once Effect<'call; i32>) -> i32 {
  let mut values = [1]
  let waiting = callback(&mut values)
  let holder = Holder { work: move waiting }
  drop holder
  values[0] = 2
  return values[0]
}`
      const snapshot = yield* Analysis.ofSourceRealized('ownership/invocation-use', ascii(source))
      const result =
        snapshot.results.get(snapshot.closure.rootModule) ?? unreachable('expected checked source')
      const plan = Ownership.localSharedAccessBoundaryPlan(snapshot.results)
      const context = SemanticContext.make(result.authored)
      const selected = (name: string): Ownership.CheckInput => {
        const body =
          result.bodies.find(
            (candidate) =>
              candidate.declaration.name._tag === 'Present' &&
              candidate.declaration.name.spelling === name,
          ) ?? unreachable(`expected ${name}`)
        return Ownership.input(
          body.function,
          body.artifact,
          body.results.lifetimes,
          snapshot.index,
          plan,
          context,
          body.results.causes,
        )
      }
      const ownedInput = selected('owned')
      const owned = Ownership.check(ownedInput)
      assert.deepEqual(owned.diagnostics, [])
      assert.strictEqual(owned.ownership.verdict._tag, 'Satisfied')
      assert.strictEqual(owned.ownership.invocations.length, 1)
      const invocation =
        owned.ownership.invocations.at(0) ?? unreachable('expected exact invocation')
      assert.deepEqual(
        invocation.inputs.map((input) => input.parameter),
        [0, 1],
      )
      assert.deepEqual(
        invocation.inputs.map((input) => input.source?.root),
        [
          { _tag: 'Parameter', parameter: { _tag: 'TirLocal', ordinal: 1 } },
          { _tag: 'Parameter', parameter: { _tag: 'TirLocal', ordinal: 2 } },
        ],
      )
      assert.deepEqual(
        invocation.inputs.map((input) => input.transfer),
        ['Move', 'Move'],
      )
      assert.deepEqual(
        invocation.inputs.map((input) => input.conditionalContents),
        [true, true],
      )
      assert.deepEqual(
        invocation.inputs.map((input) => input.referents),
        [[], []],
      )
      assert.deepEqual(owned.ownership.loans, [])
      const firstInput = invocation.inputs.at(0) ?? unreachable('expected first input provenance')
      const secondInput = invocation.inputs.at(1) ?? unreachable('expected second input provenance')
      assert.strictEqual(Type.key(firstInput.type), Type.key(secondInput.type))
      assert.isFalse(Tir.nodeRefEquals(firstInput.argument, secondInput.argument))
      assert.strictEqual(invocation.retained, true)
      const flow = ownedInput.lifetimes ?? unreachable('expected real caller lifetime domain')
      assert.isTrue(
        flow.input.regions.some((entry) =>
          Lifetime.equals(entry.lifetime, invocation.obligation.lifetime),
        ),
      )
      const origin =
        flow.anchors.get(invocation.obligation.lifetime.ordinal) ??
        unreachable('expected call origin')
      assert.strictEqual(
        AuthoredIdentity.anchorKey(origin),
        AuthoredIdentity.anchorKey(invocation.obligation.origin),
      )
      const drop = source.indexOf('drop waiting')
      assert.isAtLeast(invocation.end.span.start, drop)
      assert.isAtMost(invocation.end.span.end, drop + 'drop waiting'.length)

      const stagedInput = selected('staged')
      const staged = Ownership.check(stagedInput)
      assert.deepEqual(staged.diagnostics, [])
      assert.strictEqual(staged.ownership.verdict._tag, 'Satisfied')
      assert.strictEqual(staged.ownership.invocations.length, 1)
      const stagedUse =
        staged.ownership.invocations.at(0) ?? unreachable('expected final staged invocation')
      assert.deepEqual(
        stagedUse.inputs.map((input) => input.parameter),
        [2, 1, 0],
      )
      assert.deepEqual(
        stagedUse.inputs.map((input) => input.transfer),
        ['Capture', 'Capture', 'Move'],
      )
      assert.deepEqual(
        stagedUse.inputs.map((input) => input.source?.root),
        [
          { _tag: 'Parameter', parameter: { _tag: 'TirLocal', ordinal: 3 } },
          { _tag: 'Parameter', parameter: { _tag: 'TirLocal', ordinal: 2 } },
          { _tag: 'Parameter', parameter: { _tag: 'TirLocal', ordinal: 1 } },
        ],
      )
      const prior = stagedUse.inputs.at(0) ?? unreachable('expected retained base frame')
      const current = stagedUse.inputs.at(1) ?? unreachable('expected current stored input')
      assert.deepEqual(
        prior.capture?.path?.map((step) => step._tag),
        ['Base', 'Capture'],
      )
      assert.deepEqual(
        current.capture?.path?.map((step) => step._tag),
        ['Capture'],
      )
      assert.strictEqual(prior.capture?.ordinal, 0)
      assert.strictEqual(current.capture?.ordinal, 0)
      assert.isFalse(Tir.nodeRefEquals(prior.argument, current.argument))
      const firstStage = stagedInput.function.statements.find(
        (statement) => statement._tag === 'Bind' && statement.name === 'firstStage',
      )
      const secondStage = stagedInput.function.statements.find(
        (statement) => statement._tag === 'Bind' && statement.name === 'secondStage',
      )
      if (
        firstStage?._tag !== 'Bind' ||
        firstStage.initializer._tag !== 'CallableApply' ||
        secondStage?._tag !== 'Bind' ||
        secondStage.initializer._tag !== 'CallableApply'
      )
        return unreachable('expected original source stage producers')
      const firstFrame = firstStage.initializer.staged ?? unreachable('expected first stored frame')
      const secondFrame =
        secondStage.initializer.staged ?? unreachable('expected second stored frame')
      const baseStep = prior.capture?.path?.at(0) ?? unreachable('expected authenticated base step')
      const leafStep =
        prior.capture?.path?.at(1) ?? unreachable('expected authenticated stored leaf')
      const ownStep =
        current.capture?.path?.at(0) ?? unreachable('expected authenticated own capture')
      assert.isTrue(Tir.nodeRefEquals(baseStep.site.node, secondFrame.site.node))
      assert.isTrue(Tir.nodeRefEquals(leafStep.site.node, firstFrame.site.node))
      assert.isTrue(Tir.nodeRefEquals(ownStep.site.node, secondFrame.site.node))
      assert.deepEqual(
        stagedUse.inputs.map((input) => input.conditionalContents),
        [true, true, true],
      )
      assert.deepEqual(
        stagedUse.inputs.map((input) => input.referents),
        [[], [], []],
      )
      assert.deepEqual(staged.ownership.loans, [])

      const stagedBinding = stagedInput.function.statements.find(
        (statement) => statement._tag === 'Bind' && statement.name === 'waiting',
      )
      if (stagedBinding?._tag !== 'Bind' || stagedBinding.initializer._tag !== 'CallableApply')
        return unreachable('expected genuine final staged call')
      const stagedCall = stagedBinding.initializer
      const stagedObligation =
        stagedCall.invocationUse ?? unreachable('expected complete staged input obligation')
      const firstStored = stagedObligation.inputs.at(0) ?? unreachable('expected base stored input')
      const wrongStagedObligation: Tir.InvocationUseObligation = {
        ...stagedObligation,
        inputs: [
          {
            ...firstStored,
            capturePath: [{ _tag: 'Capture', site: secondFrame.site, ordinal: 0 }],
          },
          ...stagedObligation.inputs.slice(1),
        ],
      }
      const wrongFrame = Ownership.check({
        ...stagedInput,
        function: {
          ...stagedInput.function,
          statements: stagedInput.function.statements.map((statement) =>
            statement === stagedBinding
              ? {
                  ...stagedBinding,
                  initializer: { ...stagedCall, invocationUse: wrongStagedObligation },
                }
              : statement,
          ),
        },
      })
      assert.strictEqual(wrongFrame.ownership.verdict._tag, 'Violation')
      assert.isTrue(
        wrongFrame.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'SEM0211' &&
            diagnostic.span.start === stagedCall.span.start &&
            diagnostic.span.end === stagedCall.span.end,
        ),
      )

      const blocked = Ownership.check(selected('blocked'))
      assert.strictEqual(blocked.ownership.verdict._tag, 'Violation')
      const write = source.indexOf('values[0] = 2', source.indexOf('fn blocked'))
      assert.isTrue(
        blocked.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'OWN0011' &&
            diagnostic.span.start === write &&
            diagnostic.span.end === write + 'values[0]'.length,
        ),
      )
      const released = Ownership.check(selected('released'))
      assert.deepEqual(released.diagnostics, [])
      assert.strictEqual(released.ownership.verdict._tag, 'Satisfied')
      const retained =
        released.ownership.invocations.at(0) ?? unreachable('expected borrowed invocation')
      const input = retained.inputs.at(0) ?? unreachable('expected actual borrowed operand')
      assert.strictEqual(input.transfer, 'Borrow')
      assert.strictEqual(input.conditionalContents, false)
      assert.deepEqual(
        input.referents.map((referent) => referent.root),
        [{ _tag: 'Let', binding: { _tag: 'TirLocal', ordinal: 1 } }],
      )
      const release = source.indexOf('drop holder', source.indexOf('fn released'))
      const loan =
        released.ownership.loans.find((candidate) => candidate.origin === 'ReturnedView') ??
        unreachable('expected retained actual input loan')
      assert.isAtLeast(loan.endSpan.start, release)
      assert.isAtMost(loan.endSpan.end, release + 'drop holder'.length)
      assert.deepEqual(
        loan.referents.map((referent) => referent.root),
        input.referents.map((referent) => referent.root),
      )

      // Corrupt only obligation metadata on the genuine checked call: equal T cannot hide a swap.
      const binding =
        ownedInput.function.statements.find((statement) => statement._tag === 'Bind') ??
        unreachable('expected waiting binding')
      if (binding._tag !== 'Bind' || binding.initializer._tag !== 'CallableApply')
        return unreachable('expected actual callback application')
      const call = binding.initializer
      const obligation = call.invocationUse ?? unreachable('expected required input obligation')
      const first = obligation.inputs.at(0) ?? unreachable('expected first actual input')
      const second = obligation.inputs.at(1) ?? unreachable('expected second actual input')
      const firstArgument = call.arguments.at(0) ?? unreachable('expected real first operand')
      const secondArgument = call.arguments.at(1) ?? unreachable('expected real second operand')
      assert.strictEqual(
        AuthoredIdentity.anchorKey(first.argument),
        AuthoredIdentity.anchorKey(firstArgument.origin.anchor),
      )
      assert.strictEqual(
        AuthoredIdentity.anchorKey(second.argument),
        AuthoredIdentity.anchorKey(secondArgument.origin.anchor),
      )
      const checkCall = (changed: Extract<Tir.Expression, { readonly _tag: 'CallableApply' }>) =>
        Ownership.check({
          ...ownedInput,
          function: {
            ...ownedInput.function,
            statements: ownedInput.function.statements.map((statement) =>
              statement === binding ? { ...binding, initializer: changed } : statement,
            ),
          },
        })
      const swapped = checkCall({
        ...call,
        invocationUse: {
          ...obligation,
          inputs: [
            { ...first, argument: second.argument },
            { ...second, argument: first.argument },
          ],
        },
      })
      const { invocationUse: required, ...missing } = call
      assert.strictEqual(required, obligation)
      const absent = checkCall(missing)
      for (const rejected of [swapped, absent]) {
        assert.strictEqual(rejected.ownership.verdict._tag, 'Violation')
        assert.isTrue(
          rejected.diagnostics.some(
            (diagnostic) =>
              diagnostic.code === 'SEM0211' &&
              diagnostic.span.start === call.span.start &&
              diagnostic.span.end === call.span.end,
          ),
        )
      }
    }),
)

// Lifetime flow must see `let` initializers inside an inline Effect block: a borrowed array
// temporary there keeps the binding's lexical validity, exactly as it does in a function body.
it.effect('extends a let-bound array temporary borrowed inside an inline effect block', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'ownership/effect-block-array-temporary',
      ascii(`struct Token { value: i32 }
fn keep(slice: &[Token]) -> &[Token] { return slice }
fn read() -> i32 {
  return run effect {
    let slice = keep(&[Token { value: 8 }])
    return slice[0].value
  }
}
pub fn main() -> i32 { return read() }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)
