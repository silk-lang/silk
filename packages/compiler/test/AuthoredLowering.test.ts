import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as AuthoredEncoding from '../src/AuthoredEncoding.js'
import type * as AuthoredHir from '../src/AuthoredHir.js'
import * as AuthoredIdentity from '../src/AuthoredIdentity.js'
import * as AuthoredLowering from '../src/AuthoredLowering.js'
import * as AuthoredModule from '../src/AuthoredModule.js'
import * as AuthoredPresentation from '../src/AuthoredPresentation.js'
import * as Hir from '../src/Hir.js'
import * as Lexer from '../src/Lexer.js'
import * as Parser from '../src/Parser.js'
import * as SourceFile from '../src/SourceFile.js'
import type * as SyntaxFile from '../src/SyntaxFile.js'
import { render } from './support/authoredRender.js'
import { unreachable } from './support/raise.js'

const encoder = new TextEncoder()

const parse = (id: string, source: string): SyntaxFile.SyntaxFile =>
  Parser.parse(Lexer.lex(SourceFile.make(id, encoder.encode(source))))

const owner = AuthoredIdentity.module('fixture', 'app/Main')

const lower = (id: string, source: string) => AuthoredLowering.lower(parse(id, source), owner)

it.effect('lowers an identified revision with recovered syntax and presentation diagnostics', () =>
  Effect.gen(function* () {
    const lowered = yield* Hir.lower(
      SourceFile.make('app/Broken', encoder.encode('pub fn broken( -> i32 { return 1 }')),
    )
    assert.strictEqual(lowered.syntax.source.id, 'app/Broken')
    assert.strictEqual(lowered.authored.presentation.revision, 'f7b12fdd82019f15')
    assert.isAbove(lowered.syntax.parserDiagnostics.length, 0)
    assert.strictEqual(lowered.authored.module.owner.module, 'app/Broken')
    assert.isAbove(lowered.authored.presentation.diagnostics.length, 0)
  }),
)

const golden = (name: string): string =>
  readFileSync(new URL(`./goldens/${name}`, import.meta.url), 'utf8')

/** Every record reachable from a value, in deterministic traversal order. */
const records = (root: unknown): ReadonlyArray<{ readonly _tag: string }> => {
  const found: Array<{ readonly _tag: string }> = []
  const pending: unknown[] = [root]
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object') continue
    if ('_tag' in value && typeof value._tag === 'string')
      found.push({ ...value, _tag: value._tag })
    for (const child of Object.values(value).reverse()) pending.push(child)
  }
  return found
}

const isTagged =
  <Tag extends AuthoredHir.Record['_tag']>(tag: Tag) =>
  (record: unknown): record is Extract<AuthoredHir.Record, { readonly _tag: Tag }> =>
    typeof record === 'object' && record !== null && '_tag' in record && record._tag === tag

const tagged = <Tag extends AuthoredHir.Record['_tag']>(
  root: unknown,
  tag: Tag,
): ReadonlyArray<Extract<AuthoredHir.Record, { readonly _tag: Tag }>> =>
  records(root).filter(isTagged(tag))

const declarationNamed = (module: AuthoredHir.Module, name: string): AuthoredHir.Declaration =>
  module.declarations.find((declaration) => declaration.owner.path.at(-1)?.name === name) ??
  unreachable(`expected declaration ${name}`)

const bodyBytes = (module: AuthoredHir.Module, name: string) =>
  AuthoredEncoding.body(module.pool, declarationNamed(module, name))

const headerBytes = (module: AuthoredHir.Module, name: string) =>
  AuthoredEncoding.header(module.pool, declarationNamed(module, name))

const broad = `//! Module documentation.
module with compiler.link(library: "m")
import platform.clock as clock
pub import platform.first { original as selected, plain }
static if choose() {
  pub const answer: i32 = 42
  static if true { import nested.inner }
} else static if false {
  pub extern "C" fn selected() -> i32
} else {
  import missing.module
  pub fn selected() -> i32 { return 7 }
}
param retries: u32 = 3 where retries < 10
const limit: u64 = 18446744073709551615
pub type FetchError = HttpError | JsonError
type Pair<T> = Point<T>
/// A point.
pub extern "C" struct Point<T> { pub x: T y: [i32; 4] }
tuple Coordinates<T>(T, &'a mut T)
enum(u8) Color { Red = 1, Green = -2, Blue }
union Shape<T> { Empty, Circle { radius: T }, Rect { pub w: i32, h: i32 } }
pub service Clock<T> {
  fn now() -> u64
  operator + effect<'a> fn plus(left: T, right: T) -> T ! Overflow ? &mut Clock at Primary
}
interface Show { fn show(value: &Self) -> string with compiler.inline(always: true) }
role Primary
impl<T> Show for Point<T> { show: Point.render fn drop(self: &mut Point<T>) -> () {} }
unsafe extern "C" static errno: i32 as "__errno" with compiler.link(library: "c")
export "C" static counter: u32 as "silk_counter" = 0
pub static fn double(value: i32) -> i32 { return value * 2 }
unsafe extern "C" fn c_add(a: i32, b: i32, ...) -> i32 as "add" with compiler.link(library: "m")
pub export "C" fn exported(input: *const u8, table: ?[*]const ?*mut align(1) addrspace(0) i32, callback: extern "C" fn(i32) -> i32, exact: typeof(double)) -> ?*mut u8 { return null_pointer() }
effect<'a & 'b> fn effectful<T: Show, ?R, 'a>(items: &'a [T], mut count: usize, static width: u32) -> some<F: fn(i32) -> i32> F ! Failure ? Without<R, Clock> | R where T in Shape<T>, Clock provides Primary from Clock {
  let mut total: i32 = 0
  let static size = 4
  let Point { x, y: renamed, .. } = first_point()
  total = total + 1
  if total == 1 { total = 2 } else if total < 0 { fail move Failure.Negative } else { drop total }
  if let Shape.Circle { radius } = shape { total = radius }
  static if size > 2 { total = size } else { total = 0 }
  static for index in items { total = total + index }
  while true { if total > 10 { break } continue }
  unsafe { unsafe c_add(1, 2) }
  let text = "plain" + r"raw\\n" + """triple""" + b"by\\x00tes" + 'x'
  let numbers = [0xff, 0b1010, 0o17, 1_000, 3.25e-2, -1.5, 1h30m15s]
  let record = .{ enabled: true, unit: () }
  let point = Point<i32> { x: 1, y: zeros }
  let pair = (1, 2)
  let variant = Shape<i32>.Circle { radius: 3 }
  let empty = Shape<i32>.Empty
  let bare = Color.Red
  let borrowed = &mut total
  let moved = move record
  let result = match &items[0] {
    Shape<i32>.Circle { radius } if radius > 1 => radius
    Shape.Rect { w, h: height } => { let area = w * height return area }
    Color.Red => 1
    3 => 3
    Point { x, .. } => x
    Point p => p.x
    _ => 0
  }
  let projected = pair.0.*.field[1]
  let called = compute<i32, 'a, Clock at Primary>(1)(2)
  let piped = total |> double
  let negated = -(total + ~total) & !flag
  let closure = fn(step: i32) -> i32 { return step + total }
  let lazy = effect { return run closure(1) }
  let message = compileError("stop")
  return total
}
`

it.effect('lowers every syntax category into one published source-free module', () =>
  Effect.gen(function* () {
    const syntax = parse('broad', broad)
    assert.deepEqual(syntax.parserDiagnostics, [])
    assert.deepEqual(syntax.lexicalDiagnostics, [])
    const lowered = yield* AuthoredLowering.lower(syntax, owner)
    const { module, presentation } = lowered
    for (const declaration of module.declarations) {
      yield* AuthoredEncoding.header(module.pool, declaration)
      yield* AuthoredEncoding.body(module.pool, declaration)
      assert.isTrue(AuthoredModule.isUndamaged(declaration), render(declaration.owner.path))
    }
    // Both conditional arms and nested groups are lowered without selecting any arm.
    const conditional =
      module.declarations.find((d) => d.header._tag === 'ConditionalHeader') ?? unreachable()
    assert.strictEqual(conditional.body._tag, 'ConditionalBody')
    if (conditional.body._tag !== 'ConditionalBody') return
    assert.strictEqual(conditional.body.thenBranch.header._tag, 'GroupHeader')
    assert.strictEqual(conditional.body.elseBranch?.header._tag, 'ConditionalHeader')
    const groupHeaders = tagged(conditional, 'GroupHeader')
    assert.deepEqual(
      groupHeaders.map((g) => g.branch),
      ['Then', 'Then', 'Then', 'Else'],
    )
    const imports = tagged(conditional, 'ImportHeader')
    assert.strictEqual(imports.length, 2)
    // Static bodies and every header form are retained as authored data.
    const double = declarationNamed(module, 'double')
    assert.strictEqual(double.header._tag, 'FunctionHeader')
    if (double.header._tag === 'FunctionHeader') assert.isTrue(double.header.contract.static)
    assert.strictEqual(double.body._tag, 'CallableBody')
    const headerTags = new Set(module.declarations.map((d) => d.header._tag))
    for (const tag of [
      'ModulePropertyHeader',
      'ImportHeader',
      'ConditionalHeader',
      'PackageParameterHeader',
      'ConstantHeader',
      'AliasHeader',
      'StructHeader',
      'TupleHeader',
      'EnumHeader',
      'UnionHeader',
      'ServiceHeader',
      'InterfaceHeader',
      'RoleHeader',
      'ImplHeader',
      'StaticHeader',
      'FunctionHeader',
    ] as const)
      assert.isTrue(headerTags.has(tag), tag)
    const members = tagged(module, 'OperationHeader')
    assert.strictEqual(members.length, 3)
    assert.strictEqual(members[1]?.operator?._tag, 'Name')
    assert.deepEqual(tagged(module, 'ImplAliasHeader').length, 1)
    // Every record vocabulary the grammar can produce appears, and no source object leaks.
    const tags = new Set(records(module).map((r) => r._tag))
    for (const tag of Object.values(AuthoredLowering.coverage)) {
      const expected: ReadonlyArray<string> = typeof tag === 'string' ? [tag] : []
      for (const candidate of Array.isArray(tag) ? tag : expected)
        if (!candidate.startsWith('Missing') && !candidate.startsWith('Invalid'))
          assert.isTrue(tags.has(candidate), candidate)
    }
    const pending: unknown[] = [module]
    while (pending.length > 0) {
      const value = pending.pop()
      if (value === null || typeof value !== 'object') continue
      assert.isFalse('span' in value)
      if ('_tag' in value)
        assert.notInclude(
          ['SyntaxNode', 'Token', 'MissingToken', 'SyntaxFile', 'SourceFile'],
          value._tag,
        )
      for (const child of Object.values(value)) pending.push(child)
    }
    // Exact literal payloads survive before any contextual rounding.
    const integers = tagged(module, 'IntegerLiteral').map((literal) => literal.value)
    assert.include(integers, 18446744073709551615n)
    assert.include(integers, -2n)
    assert.include(integers, 255n)
    assert.include(integers, 1000n)
    assert.deepEqual(
      tagged(module, 'IntegerLiteral')
        .filter((literal) => literal.radix !== 10)
        .map((literal) => literal.radix),
      [16, 2, 8],
    )
    const floats = tagged(module, 'FloatingLiteral').map((literal) => [
      literal.sign,
      literal.coefficient,
      literal.exponent,
    ])
    assert.deepEqual(floats, [
      ['Positive', 325n, -4n],
      ['Negative', 15n, -1n],
    ])
    const duration = tagged(module, 'DurationLiteral')[0] ?? unreachable()
    assert.deepEqual(
      duration.components.map((c) => [c.magnitude, c.unit]),
      [
        [1n, 'h'],
        [30n, 'm'],
        [15n, 's'],
      ],
    )
    const bytesLiteral = tagged(module, 'BytesLiteral')[0] ?? unreachable()
    assert.deepEqual(
      module.pool.bytes[bytesLiteral.value.index]?.value,
      [98, 121, 0, 116, 101, 115],
    )
    assert.strictEqual(tagged(module, 'CharacterLiteral')[0]?.scalar, 0x78)
    const texts = tagged(module, 'TextLiteral').map(
      (literal) => module.pool.texts[literal.value.index]?.value,
    )
    assert.includeMembers(texts, ['plain', 'raw\\n', 'triple', 'm', 'C'])
    assert.deepEqual(tagged(module, 'MatchExpression')[0]?.access, 'Shared')
    // Presentation owns the spans, spellings and raw documentation.
    assert.strictEqual(presentation.sourceId, 'broad')
    assert.isTrue(
      presentation.entries.some((entry) => entry.documentation === '//! Module documentation.'),
    )
    assert.isTrue(presentation.entries.some((entry) => entry.documentation === '/// A point.'))
    assert.isTrue(presentation.entries.some((entry) => entry.spelling === '18446744073709551615'))
    assert.deepEqual(presentation.diagnostics, [])
    // Anchors index the current revision: every declaration header resolves to a source span.
    const index = AuthoredPresentation.index(presentation)
    for (const declaration of module.declarations) {
      const span = index.span(declaration.header.anchor)
      assert.isDefined(span)
      assert.strictEqual(span?.sourceId, presentation.sourceId)
    }
    const first = module.declarations[0] ?? unreachable('expected a declaration')
    assert.isUndefined(
      index.span({
        ...first.header.anchor,
        path: [{ _tag: 'LocalSegment', role: 'nowhere', occurrence: 0 }],
      }),
    )
  }),
)

it.effect('records lexical binders, shadowing and captures while deferring imported lookups', () =>
  Effect.gen(function* () {
    const { module } = yield* lower(
      'lexical',
      `fn compute(value: i32) -> i32 {
  let early = later
  let value = value + helper()
  let closure = fn(step: i32) -> i32 { return step + value }
  let later = match value { 1 => value i32 n => n }
  static for item in [value] { drop item }
  return value
}`,
    )
    const compute = declarationNamed(module, 'compute')
    const identifiers = tagged(compute, 'IdentifierExpression')
    const binding = (spelling: string, occurrence: number) =>
      identifiers.filter(
        (id) =>
          id.name._tag === 'Name' && module.pool.texts[id.name.text.index]?.value === spelling,
      )[occurrence] ?? unreachable(spelling)
    const parameter = tagged(compute, 'Parameter')[0] ?? unreachable()
    const rebinding = tagged(compute, 'BindingStatement')[1] ?? unreachable()
    // Use before binding and module-level names stay unresolved for later semantics.
    assert.isUndefined(binding('later', 0).binding)
    assert.isUndefined(binding('helper', 0).binding)
    // The initializer of `let value` sees the parameter; later uses see the new binder.
    assert.deepEqual(binding('value', 0).binding?.path, parameter.anchor.path)
    assert.deepEqual(binding('value', 1).binding?.path, rebinding.anchor.path)
    assert.deepEqual(binding('value', 4).binding?.path, rebinding.anchor.path)
    // Closures introduce a nested authored owner and capture enclosing binders lexically.
    const closure = tagged(compute, 'CallableExpression')[0] ?? unreachable()
    assert.notDeepEqual(closure.anchor.owner, compute.owner)
    assert.deepEqual(closure.anchor.owner.path.slice(0, -1), compute.owner.path)
    const captured = tagged(closure, 'IdentifierExpression').find(
      (id) => id.binding?.owner.path.length === compute.owner.path.length,
    )
    assert.deepEqual(captured?.binding, {
      _tag: 'LexicalReference',
      owner: compute.owner,
      path: rebinding.anchor.path,
    })
    const step = tagged(closure, 'IdentifierExpression').find(
      (id) => id.binding?.owner.path.length === closure.anchor.owner.path.length,
    )
    assert.deepEqual(step?.binding?.path, tagged(closure, 'Parameter')[0]?.anchor.path)
    // Match arm and static-for binders scope to their arm and body.
    const armBinding = tagged(compute, 'BindingPattern')[0] ?? unreachable()
    const n =
      identifiers.find(
        (id) => id.name._tag === 'Name' && module.pool.texts[id.name.text.index]?.value === 'n',
      ) ?? unreachable()
    assert.deepEqual(n.binding?.path, armBinding.anchor.path)
    const loop = tagged(compute, 'StaticForStatement')[0] ?? unreachable()
    const item =
      identifiers.find(
        (id) => id.name._tag === 'Name' && module.pool.texts[id.name.text.index]?.value === 'item',
      ) ?? unreachable()
    assert.deepEqual(item.binding?.path, loop.anchor.path)
  }),
)

it.effect(
  'keeps recovery explicit in inactive arms while healthy neighbours stay byte-identical',
  () =>
    Effect.gen(function* () {
      const damaged = parse(
        'damaged',
        'static if true { const broken: = 1 } else { fn good() -> () {} }\nfn healthy() -> i32 { return 1 }',
      )
      const repaired = parse(
        'repaired',
        'static if true { const broken: i32 = 1 } else { fn good() -> () {} }\nfn healthy() -> i32 { return 1 }',
      )
      assert.isTrue(damaged.parserDiagnostics.length > 0)
      const left = yield* AuthoredLowering.lower(damaged, owner)
      const right = yield* AuthoredLowering.lower(repaired, owner)
      const conditional = left.module.declarations[0] ?? unreachable()
      assert.isFalse(AuthoredModule.isUndamaged(conditional))
      assert.isTrue(AuthoredModule.isUndamaged(right.module.declarations[0] ?? unreachable()))
      const causes = tagged(conditional, 'MissingName').flatMap((name) =>
        name.causes.map((cause) => cause.code),
      )
      assert.deepEqual(causes, ['PAR0001'])
      assert.notDeepEqual(
        yield* AuthoredEncoding.body(left.module.pool, conditional),
        yield* AuthoredEncoding.body(
          right.module.pool,
          right.module.declarations[0] ?? unreachable(),
        ),
      )
      assert.deepEqual(
        yield* bodyBytes(left.module, 'healthy'),
        yield* bodyBytes(right.module, 'healthy'),
      )
      assert.deepEqual(
        yield* headerBytes(left.module, 'healthy'),
        yield* headerBytes(right.module, 'healthy'),
      )
      assert.deepEqual(
        left.presentation.diagnostics.map((d) => d.code),
        ['PAR0001'],
      )
      const broken =
        tagged(conditional, 'Declaration').find((d) => d.owner.path.at(-1)?.name === 'broken') ??
        unreachable()
      assert.deepEqual(left.presentation.diagnostics[0]?.anchor, broken.header.anchor)
      assert.deepEqual(right.presentation.diagnostics, [])
    }),
)

it.effect('preserves semantic fingerprints across trivia, movement and pool growth', () =>
  Effect.gen(function* () {
    const base = yield* lower(
      'base',
      'fn identity(value: i32) -> i32 { return value }\nfn other() -> i32 { return 1 }',
    )
    const moved = yield* lower(
      'moved',
      `// unrelated leading declaration widens the pool and renumbers every reference
fn zebra(extra: u8) -> u8 { return extra }
fn other() -> i32 {
  return 1
}
/// documented and moved
fn identity(value: i32)   ->  i32 { return value }`,
    )
    assert.deepEqual(
      declarationNamed(base.module, 'identity').owner,
      declarationNamed(moved.module, 'identity').owner,
    )
    assert.deepEqual(
      yield* headerBytes(base.module, 'identity'),
      yield* headerBytes(moved.module, 'identity'),
    )
    assert.deepEqual(
      yield* bodyBytes(base.module, 'identity'),
      yield* bodyBytes(moved.module, 'identity'),
    )
    assert.deepEqual(
      yield* bodyBytes(base.module, 'other'),
      yield* bodyBytes(moved.module, 'other'),
    )
    assert.notDeepEqual(base.module.pool, moved.module.pool)
    assert.notStrictEqual(base.presentation.revision, moved.presentation.revision)
    const spanOf = (lowered: AuthoredLowering.Lowered, name: string) =>
      lowered.presentation.entries.find(
        (entry) => entry.anchor.owner.path.at(-1)?.name === name && entry.anchor.path.length === 1,
      )
    assert.notDeepEqual(spanOf(base, 'identity')?.span, spanOf(moved, 'identity')?.span)
    assert.strictEqual(spanOf(moved, 'identity')?.documentation, '/// documented and moved')
    // A body-only edit changes body bytes but leaves the owner and header untouched.
    const edited = yield* lower('edited', 'fn identity(value: i32) -> i32 { return value + 1 }')
    assert.deepEqual(
      yield* headerBytes(base.module, 'identity'),
      yield* headerBytes(edited.module, 'identity'),
    )
    assert.notDeepEqual(
      yield* bodyBytes(base.module, 'identity'),
      yield* bodyBytes(edited.module, 'identity'),
    )
    // Reuse keys normalize lifetimes per binding scope: `for<'x>` binders are alpha-equivalent and
    // shadow header lifetimes, while free lifetimes keep their spelling.
    const key = (lowered: AuthoredLowering.Lowered) =>
      AuthoredLowering.canonicalBody(lowered, declarationNamed(lowered.module, 'pick'))
    const inner = (binder: string, environment: string) =>
      lower(
        `pick-${binder}-${environment}`,
        `fn pick<'a, 'b>(p: &'a u8, q: &'b u8) -> u32 { let g: for<'${binder}> fn<'${environment}>(&'${binder} u8) -> u32 = h  return 1 }`,
      )
    assert.strictEqual(key(yield* inner('a', 'static')), key(yield* inner('z', 'static')))
    assert.notStrictEqual(key(yield* inner('a', 'b')), key(yield* inner('b', 'a')))
    assert.notStrictEqual(
      key(yield* lower('free-a', "fn pick() -> u32 { let g: &'a u8 = h  return 1 }")),
      key(yield* lower('free-b', "fn pick() -> u32 { let g: &'b u8 = h  return 1 }")),
    )
  }),
)

it.effect(
  'retains test qualification and its presentation span in source-free authored headers',
  () =>
    Effect.gen(function* () {
      const source = 'pub test effect fn checked() -> () ! i32 { fail 1 }\nfn test() {}'
      const lowered = yield* lower('test-header', source)
      const checked = declarationNamed(lowered.module, 'checked')
      const header = checked.header
      assert.strictEqual(header._tag, 'FunctionHeader')
      if (header._tag !== 'FunctionHeader') return
      assert.isTrue(header.contract.test)
      assert.isDefined(header.contract.testAnchor)
      const marker = lowered.presentation.entries.find(
        (entry) => entry.anchor === header.contract.testAnchor,
      )
      assert.strictEqual(
        marker === undefined ? undefined : source.slice(marker.span.start, marker.span.end),
        'test',
      )
      const ordinary = declarationNamed(lowered.module, 'test')
      assert.strictEqual(ordinary.header._tag, 'FunctionHeader')
      if (ordinary.header._tag === 'FunctionHeader') {
        assert.isFalse(ordinary.header.contract.test)
        assert.isUndefined(ordinary.header.contract.testAnchor)
      }
      yield* AuthoredEncoding.header(lowered.module.pool, checked)
    }),
)

const structural = `import platform.clock as clock
static if false { import inactive.alternative fn unused() -> i32 { return missing() } }
static fn size() -> u64 { return 18446744073709551616 }
fn answer(seed: i32) -> i32 {
  let value = clock.now(seed, 1.5e300, 'z', "text", b"\\x00", 2h)
  return value
}
const broken: = 1
fn healthy() -> i32 { return answer(0) }
`

it.effect('matches the structural golden for a representative module', () =>
  Effect.gen(function* () {
    const { module } = yield* lower('structural', structural)
    // A digest of the deterministic rendering pins the whole shape without a 4,000-line dump;
    // regenerate with `render(module)` when authored vocabulary or anchoring changes on purpose.
    assert.strictEqual(
      `${yield* AuthoredEncoding.digest([...encoder.encode(render(module))])}
`,
      golden('authored-lowering.sha256'),
    )
  }),
)

it.effect(
  'owns invocation-use role in authored identity while retaining lifetime alpha equivalence',
  () =>
    Effect.gen(function* () {
      const fixture = (marker: string, name: string) =>
        lower(
          `invocation-role-${marker}-${name}`,
          `fn pick() -> i32 { let callback: for<${marker}'${name}> fn<'static>(i32) -> i32 = target return 1 }`,
        )
      const marked = yield* fixture('use ', 'call')
      const renamed = yield* fixture('use ', 'other')
      const ordinary = yield* fixture('', 'call')
      const binder =
        tagged(marked.module, 'LifetimeParameter').at(0) ?? unreachable('expected marked binder')
      assert.strictEqual(binder.invocationUse, true)
      assert.strictEqual(
        tagged(ordinary.module, 'LifetimeParameter').at(0)?.invocationUse,
        undefined,
      )
      const key = (value: AuthoredLowering.Lowered) =>
        AuthoredLowering.canonicalBody(value, declarationNamed(value.module, 'pick'))
      assert.strictEqual(key(marked), key(renamed))
      assert.notStrictEqual(key(marked), key(ordinary))
      assert.notDeepEqual(
        yield* bodyBytes(marked.module, 'pick'),
        yield* bodyBytes(ordinary.module, 'pick'),
      )
    }),
)
