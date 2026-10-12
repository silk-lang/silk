import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as AuthoredEncoding from '../src/AuthoredEncoding.js'
import type * as AuthoredHir from '../src/AuthoredHir.js'
import * as AuthoredIdentity from '../src/AuthoredIdentity.js'
import * as AuthoredModule from '../src/AuthoredModule.js'
import * as AuthoredPool from '../src/AuthoredPool.js'
import * as AuthoredPresentation from '../src/AuthoredPresentation.js'
import type * as Elaboration from '../src/Elaboration.js'
import * as Tir from '../src/Tir.js'
import * as Lexer from '../src/Lexer.js'
import * as Parser from '../src/Parser.js'
import * as SourceFile from '../src/SourceFile.js'
import * as Type from '../src/Type.js'
import { elaborate as elaborateSyntax } from './support/elaborate.js'
import { unreachable } from './support/raise.js'
import * as AuthoredFunction from './support/authoredFunction.js'
import { broadModule } from './support/authoredFixture.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const hex = (bytes: readonly number[]): string =>
  (
    Buffer.from(bytes)
      .toString('hex')
      .match(/.{1,64}/g) ?? []
  ).join('\n') + '\n'

it.effect('publishes the authored vocabulary without source or semantic construction', () =>
  Effect.gen(function* () {
    const module = yield* AuthoredModule.make(yield* broadModule())
    for (const declaration of module.declarations) {
      yield* AuthoredEncoding.header(module.pool, declaration)
      yield* AuthoredEncoding.body(module.pool, declaration)
    }
    assert.isTrue(
      module.declarations.some((declaration) => declaration.header._tag === 'ConditionalHeader'),
    )
    // Inspect exact payloads in the same fixture, without executing a compiler pipeline.
    const pending: unknown[] = [module]
    const values: Array<bigint | string | number> = []
    while (pending.length > 0) {
      const value = pending.pop()
      if (value === null || typeof value !== 'object') continue
      if (
        '_tag' in value &&
        value._tag === 'FloatingLiteral' &&
        'coefficient' in value &&
        'exponent' in value &&
        'sign' in value
      ) {
        assert.strictEqual(typeof value.coefficient, 'bigint')
        assert.strictEqual(typeof value.exponent, 'bigint')
        if (typeof value.coefficient === 'bigint' && typeof value.sign === 'string') {
          values.push(value.coefficient, value.sign)
        }
      }
      for (const child of Object.values(value)) pending.push(child)
    }
    assert.include(values, 'Negative')
    assert.include(values, 0n)
    assert.include(values, 1000000000000000000000001n)
  }),
)

it.effect('rejects publication that would lose data or retain executable object behavior', () =>
  Effect.gen(function* () {
    const fixture = yield* AuthoredFunction.make()
    const nonEnumerable = { ...fixture.module }
    Object.defineProperty(nonEnumerable, 'declarations', { enumerable: false })
    const missingData = yield* Effect.flip(AuthoredModule.make(nonEnumerable))
    assert.strictEqual(missingData._tag, 'AuthoredEncodingError')
    let invoked = false
    const accessor = { ...fixture.module }
    Object.defineProperty(accessor, 'pool', {
      get: () => {
        invoked = true
        return fixture.module.pool
      },
    })
    const executable = yield* Effect.flip(AuthoredModule.make(accessor))
    assert.strictEqual(executable._tag, 'AuthoredEncodingError')
    assert.isFalse(invoked)
    const invalidPool = {
      ...fixture.module.pool,
      bytes: [{ _tag: 'PoolBytes' as const, value: [256], byteLength: 1 }],
    }
    const byteFailure = yield* Effect.flip(
      AuthoredModule.make({ ...fixture.module, pool: invalidPool }),
    )
    assert.strictEqual(byteFailure._tag, 'AuthoredEncodingError')
    const invalidDigest = yield* Effect.flip(AuthoredEncoding.digest([256]))
    assert.strictEqual(invalidDigest.reason._tag, 'InvalidArtifact')
    const sparse: number[] = []
    sparse.length = 1
    const sparseDigest = yield* Effect.flip(AuthoredEncoding.digest(sparse))
    assert.strictEqual(sparseDigest.reason._tag, 'InvalidArtifact')
    const duplicated = yield* Effect.flip(
      AuthoredModule.make({
        ...fixture.module,
        declarations: [fixture.declaration, fixture.declaration],
      }),
    )
    assert.strictEqual(duplicated._tag, 'AuthoredEncodingError')
    const foreignOwner = yield* Effect.flip(
      AuthoredModule.make({
        ...fixture.module,
        owner: AuthoredIdentity.module('another-origin', 'app/Value'),
      }),
    )
    assert.strictEqual(foreignOwner._tag, 'AuthoredEncodingError')
    const header = fixture.declaration.header
    const absentOwner =
      AuthoredIdentity.children(fixture.module.owner, [{ kind: 'function', name: 'absent' }])[0] ??
      unreachable()
    const foreignAnchor = yield* Effect.flip(
      AuthoredModule.make({
        ...fixture.module,
        declarations: [
          {
            ...fixture.declaration,
            header: {
              ...header,
              anchor: { ...header.anchor, owner: absentOwner },
            },
          },
        ],
      }),
    )
    assert.strictEqual(foreignAnchor._tag, 'AuthoredEncodingError')
    if (header._tag !== 'FunctionHeader') return yield* Effect.die('Expected a function fixture')
    const binding = fixture.literal.anchor
    const reference: AuthoredHir.Expression = {
      _tag: 'IdentifierExpression',
      anchor: header.anchor,
      origin: { _tag: 'Authored' },
      causes: [],
      name: header.name,
      binding: { _tag: 'LexicalReference', owner: binding.owner, path: binding.path },
    }
    const linked: AuthoredHir.Declaration = {
      ...fixture.declaration,
      header: {
        ...header,
        contract: {
          ...header.contract,
          parameters: [
            {
              _tag: 'Parameter',
              anchor: binding,
              origin: { _tag: 'Authored' },
              causes: [],
              name: header.name,
              type: header.contract.result ?? unreachable(),
              mode: 'Value',
            },
          ],
        },
      },
      body: { _tag: 'InitializerBody', value: reference },
    }
    yield* AuthoredModule.make({ ...fixture.module, declarations: [linked] })
    const dangling = yield* Effect.flip(
      AuthoredModule.make({ ...fixture.module, declarations: [{ ...linked, header }] }),
    )
    assert.strictEqual(dangling._tag, 'AuthoredEncodingError')
  }),
)

it.effect('publishes source-free authored content with canonical header and body goldens', () =>
  Effect.gen(function* () {
    const original = yield* AuthoredFunction.make()
    const module = yield* AuthoredModule.make(original.module)
    const declaration = module.declarations[0] ?? unreachable()
    original.statements.length = 0
    assert.strictEqual(declaration.body._tag, 'CallableBody')
    if (declaration.body._tag !== 'CallableBody') return yield* Effect.die('Expected callable body')
    assert.strictEqual(declaration.body.block?.statements.length, 1)
    assert.isTrue(AuthoredModule.isUndamaged(declaration))
    const header = yield* AuthoredEncoding.header(module.pool, declaration)
    const body = yield* AuthoredEncoding.body(module.pool, declaration)
    assert.strictEqual(hex(header), golden('authored-header.hex'))
    assert.strictEqual(hex(body), golden('authored-body.hex'))
    assert.notDeepEqual(header, body)
    assert.strictEqual((yield* AuthoredEncoding.digest(body)).length, 64)
    // The known SHA-256 vector also checks the platform boundary independently of our framing.
    assert.strictEqual(
      yield* AuthoredEncoding.digest([97, 98, 99]),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    const reordered = yield* AuthoredFunction.make(['unrelated', 'value', 'identity', 'i32'])
    assert.deepEqual(
      header,
      yield* AuthoredEncoding.header(reordered.module.pool, reordered.declaration),
    )
    assert.deepEqual(
      body,
      yield* AuthoredEncoding.body(reordered.module.pool, reordered.declaration),
    )
    const edited = yield* AuthoredFunction.make(undefined, 9007199254740994n)
    assert.deepEqual(declaration.owner, edited.declaration.owner)
    assert.deepEqual(header, yield* AuthoredEncoding.header(edited.module.pool, edited.declaration))
    assert.notDeepEqual(body, yield* AuthoredEncoding.body(edited.module.pool, edited.declaration))
    const anchor = declaration.header.anchor
    const before = yield* AuthoredPresentation.make(
      'old/path.silk',
      'revision-a',
      [{ anchor, span: { start: 0, end: 10 }, spelling: 'identity', documentation: 'old docs' }],
      [],
    )
    const after = yield* AuthoredPresentation.make(
      'moved/path.silk',
      'revision-b',
      [{ anchor, span: { start: 30, end: 40 }, spelling: 'identity', documentation: 'new docs' }],
      [],
    )
    assert.notDeepEqual(before, after)
    assert.deepEqual(header, yield* AuthoredEncoding.header(module.pool, declaration))
    assert.deepEqual(body, yield* AuthoredEncoding.body(module.pool, declaration))
    const pending: unknown[] = [module]
    while (pending.length > 0) {
      const value = pending.pop()
      if (value === null || typeof value !== 'object') continue
      assert.notInstanceOf(value, Map)
      if ('_tag' in value) {
        assert.notInclude(
          ['SyntaxNode', 'Token', 'SyntaxFile', 'SourceFile', 'DeclarationFact'],
          value._tag,
        )
      }
      assert.isFalse('span' in value)
      for (const child of Object.values(value)) pending.push(child)
    }
  }),
)

it.effect('keeps authored recovery explicit and excludes damaged owners from reuse', () =>
  Effect.gen(function* () {
    const texts = ['identity', 'i32', 'value', 'healthy']
    const fixture = yield* AuthoredFunction.make(texts)
    const healthy = yield* AuthoredFunction.make(texts, 42n, 'healthy')
    const missing: AuthoredHir.MissingExpression = {
      _tag: 'MissingExpression',
      anchor: fixture.literal.anchor,
      origin: { _tag: 'Authored' },
      causes: [{ _tag: 'Cause', anchor: fixture.literal.anchor, code: 'PAR0001' }],
    }
    const damaged: AuthoredHir.Declaration = {
      ...fixture.declaration,
      body: { _tag: 'InitializerBody', value: missing },
    }
    const repaired: AuthoredHir.Declaration = {
      ...damaged,
      body: { _tag: 'InitializerBody', value: fixture.literal },
    }
    const module = yield* AuthoredModule.make({
      ...fixture.module,
      declarations: [damaged, healthy.declaration],
    })
    assert.isFalse(AuthoredModule.isUndamaged(module.declarations[0] ?? unreachable()))
    assert.isTrue(AuthoredModule.isUndamaged(repaired))
    const following = module.declarations[1] ?? unreachable()
    assert.isTrue(AuthoredModule.isUndamaged(following))
    assert.deepEqual(
      yield* AuthoredEncoding.body(module.pool, following),
      yield* AuthoredEncoding.body(healthy.module.pool, healthy.declaration),
    )
    assert.notDeepEqual(
      yield* AuthoredEncoding.body(module.pool, damaged),
      yield* AuthoredEncoding.body(module.pool, repaired),
    )
    assert.deepEqual(
      yield* AuthoredEncoding.header(module.pool, damaged),
      yield* AuthoredEncoding.header(module.pool, repaired),
    )
    const badRef: AuthoredHir.Declaration = {
      ...damaged,
      body: {
        _tag: 'InitializerBody',
        value: {
          _tag: 'TextLiteral',
          anchor: fixture.literal.anchor,
          origin: fixture.literal.origin,
          causes: [],
          value: { _tag: 'TextRef', index: 99 },
        },
      },
    }
    const rejected = yield* Effect.flip(
      AuthoredModule.make({
        ...fixture.module,
        declarations: [badRef],
      }),
    )
    assert.strictEqual(rejected._tag, 'AuthoredEncodingError')
  }),
)

it('keeps authored owners stable by logical parent and same-key occurrence', () => {
  const module = AuthoredIdentity.module('demo', 'app/Value')
  const keys = [
    { kind: 'function', name: 'identity' },
    { kind: 'function', name: 'other' },
    { kind: 'function', name: 'identity' },
    { kind: 'struct', name: 'identity' },
  ]
  const owners = AuthoredIdentity.children(module, keys)
  const identity = owners[0] ?? unreachable()
  const reordered = AuthoredIdentity.children(module, [
    { kind: 'function', name: 'inserted' },
    ...keys.slice(1, 2),
    keys[0] ?? unreachable(),
  ])
  assert.isTrue(AuthoredIdentity.equals(identity, reordered[2] ?? unreachable()))
  assert.isFalse(AuthoredIdentity.equals(identity, owners[2] ?? unreachable()))
  assert.isFalse(AuthoredIdentity.equals(identity, owners[3] ?? unreachable()))
  assert.isFalse(AuthoredIdentity.equals(identity, owners[1] ?? unreachable()))
  const group =
    AuthoredIdentity.children(module, [{ kind: 'conditional', role: 'group' }])[0] ?? unreachable()
  const arms = AuthoredIdentity.children(group, [
    { kind: 'branch', role: 'then' },
    { kind: 'branch', role: 'else' },
  ])
  const thenOwner =
    AuthoredIdentity.children(arms[0] ?? unreachable(), keys.slice(0, 1))[0] ?? unreachable()
  const elseOwner =
    AuthoredIdentity.children(arms[1] ?? unreachable(), keys.slice(0, 1))[0] ?? unreachable()
  assert.isFalse(AuthoredIdentity.equals(thenOwner, elseOwner))
  assert.isFalse(AuthoredIdentity.equals(identity, thenOwner))
  const ambiguousInsertion = AuthoredIdentity.children(module, [keys[0] ?? unreachable(), ...keys])
  assert.isFalse(AuthoredIdentity.equals(identity, ambiguousInsertion[1] ?? unreachable()))
})

it('keeps executable identities structural and free of source-coordinate fields', () => {
  const owner = AuthoredIdentity.module('identity', 'app/Main')
  const checked: Tir.ArtifactId = Object.freeze({
    owner,
    request: Object.freeze({ _tag: 'Check' }),
  })
  const specialized: Tir.ArtifactId = Object.freeze({
    owner,
    request: Object.freeze({ _tag: 'Specialize', application: 'i32' }),
  })
  const node: Tir.NodeRef = Object.freeze({
    artifact: checked,
    node: Object.freeze({ _tag: 'TirNode', ordinal: 7 }),
  })
  const identities: ReadonlyArray<
    Tir.BorrowId | Tir.TemporaryOwnerId | Tir.EffectSiteId | Tir.CallableSiteId
  > = [
    Object.freeze({ _tag: 'BorrowId', call: node, ordinal: 0 }),
    Object.freeze({ _tag: 'TemporaryOwnerId', node }),
    Tir.effectRootSite(checked, 0),
    Object.freeze({ _tag: 'EffectSiteId', node, ordinal: 0, functionOrdinal: 0 }),
    Object.freeze({ _tag: 'CallableSiteId', node, ordinal: 0, functionOrdinal: 0 }),
  ]
  const identityTags = new Set(['BorrowId', 'TemporaryOwnerId', 'EffectSiteId', 'CallableSiteId'])
  const forbiddenFields = ['span', 'callSpan', 'function', 'at', 'occurrence']
  const pending: unknown[] = [identities]
  let visited = 0

  while (pending.length > 0) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object') continue
    if ('_tag' in value && typeof value._tag === 'string' && identityTags.has(value._tag)) {
      visited += 1
      for (const field of forbiddenFields) assert.isFalse(field in value, `${value._tag}.${field}`)
    }
    for (const child of Object.values(value)) pending.push(child)
  }

  assert.strictEqual(visited, identities.length)
  assert.strictEqual(
    Tir.executableSiteKey(Tir.effectRootSite(checked, 0)),
    Tir.executableSiteKey(Tir.effectRootSite(specialized, 0)),
  )
})

it.effect('owns exact text and byte pools and rejects invalid references and payloads', () =>
  Effect.gen(function* () {
    const bytes = [65, 0, 255]
    const pool = yield* AuthoredPool.make(['é\u0000𝄞'], [bytes])
    bytes[0] = 90
    assert.deepEqual(yield* AuthoredPool.text(pool, { _tag: 'TextRef', index: 0 }), {
      _tag: 'PoolText',
      value: 'é\u0000𝄞',
      byteLength: 7,
    })
    assert.deepEqual(yield* AuthoredPool.bytes(pool, { _tag: 'BytesRef', index: 0 }), {
      _tag: 'PoolBytes',
      value: [65, 0, 255],
      byteLength: 3,
    })
    const invalidByte = yield* Effect.flip(AuthoredPool.make([], [[256]]))
    assert.strictEqual(invalidByte.reason._tag, 'InvalidByte')
    const invalidText = yield* Effect.flip(AuthoredPool.make(['\ud800'], []))
    assert.strictEqual(invalidText.reason._tag, 'InvalidText')
    const invalidRef = yield* Effect.flip(AuthoredPool.text(pool, { _tag: 'TextRef', index: -1 }))
    assert.strictEqual(invalidRef.reason._tag, 'InvalidReference')
    const invalidAnchor = yield* Effect.flip(
      AuthoredIdentity.anchor(AuthoredIdentity.module('demo', 'app/Value'), [
        { role: 'operand', occurrence: 0.5 },
      ]),
    )
    assert.strictEqual(invalidAnchor.reason._tag, 'InvalidLocalOccurrence')
  }),
)

const acceptedSource = `pub fn identity(value: i32) -> i32 { return value }
pub fn main() -> i32 { return identity(identity(42)) }`
const damagedSource = `pub fn puzzle(value: Mystery) -> i32 { return value }
pub fn main() -> i32 { return missing(2147483648) }`

const elaborate = (id: string, text: string): Elaboration.Result =>
  elaborateSyntax(Parser.parse(Lexer.lex(SourceFile.make(id, ascii(text))))).located

const unavailableCause = (
  result: Elaboration.Result,
  fn: Tir.TirFunction,
  expression: Extract<Tir.Expression, { readonly _tag: 'Unavailable' }>,
) =>
  expression.cause === undefined
    ? undefined
    : result.bodies
        .find((body) => body.function === fn)
        ?.results.causes.at(expression.cause.ordinal)

const elaborateWithStdlib = Effect.fnUntraced(function* (id: string, text: string) {
  const module = id.replace('://', '/').replace(/\.silk$/, '')
  return Analysis.rootAnalysis(yield* Analysis.ofSource(module, ascii(text)))
})

const golden = (name: string): string =>
  readFileSync(new URL(`./goldens/${name}`, import.meta.url), 'utf8')

it('owns complete callable target conversion and intrinsic-aware equality', () => {
  const declaration: Type.CallableIdentityArgument['target'] = Object.freeze({
    _tag: 'Declaration',
    module: 'targets',
    name: 'decode',
  })
  const identity: Type.CallableIdentityArgument['target'] = Object.freeze({
    _tag: 'Builtin',
    actor: 'Intrinsic',
    operation: 'Add',
    intrinsic: Object.freeze({ actor: 'i32', name: 'add' }),
  })
  const target = Tir.callableTargetFromIdentity(identity)

  assert.deepEqual(
    Tir.callableTargetIdentity(Tir.callableTargetFromIdentity(declaration)),
    declaration,
  )
  assert.deepEqual(Tir.callableTargetIdentity(target), identity)
  assert.strictEqual(Tir.matchesCallableTargetIdentity(target, identity), true)
  assert.strictEqual(
    Tir.matchesCallableTargetIdentity(target, {
      ...identity,
      intrinsic: Object.freeze({ actor: 'u32', name: 'add' }),
    }),
    false,
  )
})

it('constructs typed TIR with canonical call targets and normalized contracts', () => {
  const result = elaborate('golden://accepted.silk', acceptedSource)
  const main = result.tir.functions.at(1)

  assert.deepEqual(main?.contract, {
    _tag: 'Contract',
    unsafe: false,
    parameters: [],
    result: 'i32',
    constraints: [],
  })
  const body = main === undefined ? undefined : Tir.returned(main)
  assert.strictEqual(body?._tag, 'Call')
  if (body?._tag !== 'Call') return
  assert.deepEqual(body.target, {
    _tag: 'CanonicalDeclarationId',
    module: 'golden/accepted.silk',
    name: 'identity',
  })
  assert.strictEqual(body.type, 'i32')
  const inner = body.arguments.at(0)
  assert.strictEqual(inner?._tag, 'Call')
  if (inner?._tag !== 'Call') return
  assert.strictEqual(inner.arguments.at(0)?._tag, 'IntegerLiteral')
})

it.effect('preserves contextual conversions across generic and service calls', () =>
  Effect.gen(function* () {
    const service = yield* elaborateWithStdlib(
      'tir://service-argument-conversion.silk',
      `service Sink<'a, ?R> { effect fn put(value: i32 | bool) -> i32 ? R | &Sink<'a, R> }
effect fn use() -> i32 ? &Sink<'static, never> { return run Sink<'static, never>.put(1) }
pub fn main() -> i32 { return 42 }`,
    )
    assert.deepEqual(service.diagnostics, [])
    const use = service.tir.functions.find(
      (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'use',
    )
    const serviceConstruct =
      use === undefined
        ? undefined
        : Tir.expressionTree(Tir.returned(use)).find(
            (expression) => expression._tag === 'ServiceEffectConstruct',
          )
    assert.strictEqual(serviceConstruct?._tag, 'ServiceEffectConstruct')
    if (serviceConstruct?._tag === 'ServiceEffectConstruct') {
      assert.strictEqual(serviceConstruct.arguments.at(0)?._tag, 'UnionConvert')
      assert.deepEqual(serviceConstruct.service.arguments.map(Type.encodeGenericArgument), [
        "'static",
        '? ',
      ])
    }

    const generic = elaborate(
      'tir://generic-argument-conversion.silk',
      `fn accept<T>(value: T | i32) -> i32 { return 42 }
fn forward<T>(value: T) -> i32 { return accept<T>(move value) }
pub fn main() -> i32 { return forward<bool>(true) }`,
    )
    assert.deepEqual(generic.diagnostics, [])
    const forward = generic.tir.functions.find(
      (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'forward',
    )
    const acceptCall =
      forward === undefined
        ? undefined
        : Tir.expressionTree(Tir.returned(forward)).find(
            (expression) => expression._tag === 'Call' && expression.target.name === 'accept',
          )
    assert.strictEqual(acceptCall?._tag, 'Call')
    if (acceptCall?._tag === 'Call')
      assert.strictEqual(acceptCall.arguments.at(0)?._tag, 'UnionConvert')
  }),
)

it('retains canonical scalar enum member, value, and equality identities in typed TIR', () => {
  const result = elaborate(
    'tir://enum-values.silk',
    `enum(i8) Status { Unknown = -1, Ready = 1 }
fn raw(value: Status) -> i8 { return Status.value(value) }
fn same(left: Status, right: Status) -> bool { return left == right }
fn ready() -> Status { return Status.Ready }`,
  )
  assert.deepEqual(result.diagnostics, [])

  const raw = result.tir.functions.at(0)
  const conversion = raw === undefined ? undefined : Tir.returned(raw)
  assert.strictEqual(conversion?._tag, 'EnumValue')
  if (conversion?._tag === 'EnumValue') {
    assert.deepEqual(conversion.enum, {
      _tag: 'CanonicalDeclarationId',
      module: 'tir/enum-values.silk',
      name: 'Status',
    })
    assert.strictEqual(conversion.intrinsic.name, 'enumValue')
    assert.strictEqual(conversion.type, 'i8')
  }

  const same = result.tir.functions.at(1)
  const equality = same === undefined ? undefined : Tir.returned(same)
  assert.strictEqual(equality?._tag, 'EnumEquality')
  if (equality?._tag === 'EnumEquality') assert.strictEqual(equality.type, 'bool')

  const ready = result.tir.functions.at(2)
  const member = ready === undefined ? undefined : Tir.returned(ready)
  assert.strictEqual(member?._tag, 'EnumMember')
  if (member?._tag === 'EnumMember') {
    assert.strictEqual(member.member.name, 'Ready')
    assert.strictEqual(member.discriminant, 1n)
    assert.strictEqual(Type.encode(member.type), 'tir/enum-values.silk.Status')
  }
  const encoded = Tir.encode(result.tir)
  assert.include(encoded, 'enum-value tir/enum-values.silk.Status via Intrinsic.enumValue : i8')
  assert.include(encoded, 'enum-equals tir/enum-values.silk.Status : bool')
  assert.include(encoded, 'enum-member tir/enum-values.silk.Status.Ready discriminant=1')
})

it('retains scalar enum pattern identities and nominal scrutinee type in typed TIR', () => {
  const result = elaborate(
    'tir://enum-match.silk',
    `enum Status { Unknown, Ready }
fn inspect(value: Status) -> i32 {
  return match value { Status.Unknown => 0 Status.Ready => 1 }
}`,
  )
  const inspect = result.tir.functions.at(0)
  const match = inspect === undefined ? undefined : Tir.returned(inspect)

  assert.deepEqual(result.diagnostics, [])
  assert.strictEqual(match?._tag, 'Match')
  if (match?._tag !== 'Match') return
  assert.notStrictEqual(match.scrutinee._tag, 'Unavailable')
  if (match.scrutinee._tag === 'Unavailable') return
  assert.strictEqual(Type.encode(match.scrutinee.type), 'tir/enum-match.silk.Status')
  assert.deepEqual(
    match.members.map((member) => ({
      tag: member._tag,
      name: member._tag === 'EnumMember' ? member.member.name : undefined,
      type: Type.encode(member.type),
    })),
    [
      { tag: 'EnumMember', name: 'Unknown', type: 'tir/enum-match.silk.Status' },
      { tag: 'EnumMember', name: 'Ready', type: 'tir/enum-match.silk.Status' },
    ],
  )
  assert.deepEqual(
    match.arms.map((arm) => ({
      member: arm.member?._tag === 'EnumMember' ? arm.member.member.name : undefined,
      before: arm.before.map((member) =>
        member._tag === 'EnumMember' ? member.member.name : Type.encode(member.type),
      ),
      after: arm.after.map((member) =>
        member._tag === 'EnumMember' ? member.member.name : Type.encode(member.type),
      ),
    })),
    [
      { member: 'Unknown', before: ['Unknown', 'Ready'], after: ['Ready'] },
      { member: 'Ready', before: ['Ready'], after: [] },
    ],
  )
  assert.deepEqual(Tir.verify(result.tir), [])
})

it('preserves unsafe declaration and section contracts in typed TIR', () => {
  const result = elaborate(
    'tir://unsafe-callable.silk',
    `unsafe fn combine(left: i32, right: i32) -> i32 { return left + right }
fn staged() -> unsafe fn<'static>(i32) -> i32 { return combine(2) }
pub fn main() -> i32 { let callback = staged() return unsafe callback(40) }`,
  )
  const combine = result.tir.functions.at(0)
  const staged = result.tir.functions.at(1)
  const section = staged === undefined ? undefined : Tir.returned(staged)

  assert.deepEqual(result.diagnostics, [])
  assert.strictEqual(combine?.contract._tag, 'Contract')
  assert.strictEqual(combine?.contract._tag === 'Contract' ? combine.contract.unsafe : false, true)
  assert.strictEqual(section?._tag, 'CallableSection')
  assert.strictEqual(section?._tag === 'CallableSection' ? section.type.unsafe : false, true)
})

it('keeps unknown facts explicit with causes instead of typed operations', () => {
  const result = elaborate('golden://damaged.silk', damagedSource)
  const puzzle = result.tir.functions.at(0)
  const main = result.tir.functions.at(1)

  assert.strictEqual(puzzle?.contract._tag, 'Unavailable')
  if (puzzle?.contract._tag !== 'Unavailable') return
  assert.strictEqual(puzzle.contract.cause?.code, 'SEM0001')
  assert.strictEqual(Tir.returned(puzzle)._tag, 'Unavailable')
  const mainBody = main === undefined ? undefined : Tir.returned(main)
  assert.strictEqual(mainBody?._tag, 'Unavailable')
  if (main === undefined || mainBody?._tag !== 'Unavailable') return
  assert.strictEqual(unavailableCause(result, main, mainBody)?.code, 'SEM0004')
})

it('elaborates binding statements into typed locals with moves', () => {
  const result = elaborate(
    'golden://bindings.silk',
    `pub fn main() -> i32 { let value = 42 let copy = value return move copy }`,
  )
  const main = result.tir.functions.at(0)

  assert.strictEqual(main?.statements.length, 3)
  const first = main?.statements.at(0)
  assert.strictEqual(first?._tag, 'Bind')
  if (first?._tag !== 'Bind') return
  assert.strictEqual(first.name, 'value')
  assert.strictEqual(first.initializer._tag, 'IntegerLiteral')
  const second = main?.statements.at(1)
  assert.strictEqual(second?._tag, 'Bind')
  if (second?._tag !== 'Bind') return
  assert.strictEqual(second.initializer._tag, 'BindingReference')
  const returned = main === undefined ? undefined : Tir.returned(main)
  assert.strictEqual(returned?._tag, 'Move')
  if (returned?._tag !== 'Move') return
  assert.strictEqual(returned.subject._tag, 'BindingReference')
  if (returned.subject._tag !== 'BindingReference') return
  assert.strictEqual(returned.subject.binding.ordinal, 1)
  assert.strictEqual(result.diagnostics.length, 0)
})

it('keeps expression statements as Evaluate TIR with unavailable causes intact', () => {
  const accepted = elaborate(
    'golden://evaluate.silk',
    `effect fn pulse() -> () { return () }
effect fn main() -> () { run pulse() return () }`,
  )
  const damaged = elaborate(
    'golden://evaluate-damaged.silk',
    'fn main() -> () { missing() return () }',
  )
  const effectBlock = accepted.tir.functions
    .flatMap((fn) => fn.statements)
    .flatMap(Tir.statementExpressions)
    .flatMap(Tir.expressionTree)
    .find(
      (expression) =>
        expression._tag === 'EffectBlock' &&
        expression.statements.some((statement) => statement._tag === 'Evaluate'),
    )
  const evaluated =
    effectBlock?._tag === 'EffectBlock'
      ? effectBlock.statements.find((statement) => statement._tag === 'Evaluate')
      : undefined
  const unavailable = damaged.tir.functions
    .flatMap((fn) => fn.statements)
    .find((statement) => statement._tag === 'Evaluate')

  assert.strictEqual(evaluated?._tag, 'Evaluate')
  if (evaluated?._tag !== 'Evaluate') return
  assert.strictEqual(evaluated.expression._tag, 'Run')
  assert.include(Tir.encode(accepted.tir), 'evaluate r0')

  assert.strictEqual(unavailable?._tag, 'Evaluate')
  if (unavailable?._tag !== 'Evaluate') return
  assert.strictEqual(unavailable.expression._tag, 'Unavailable')
  if (unavailable.expression._tag !== 'Unavailable') return
  const unavailableFunction = damaged.tir.functions.at(0)
  if (unavailableFunction === undefined) return
  assert.strictEqual(
    unavailableCause(damaged, unavailableFunction, unavailable.expression)?.code,
    'SEM0004',
  )
})

it('rejects rebinding a name while references keep resolving to the original', () => {
  const result = elaborate(
    'golden://rebind.silk',
    `pub fn main() -> i32 { let value = 1 let value = 2 return value }`,
  )

  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['SEM0008'],
  )
  const main = result.tir.functions.at(0)
  const returned = main === undefined ? undefined : Tir.returned(main)
  assert.strictEqual(returned?._tag, 'BindingReference')
  if (returned?._tag !== 'BindingReference') return
  assert.strictEqual(returned.binding.ordinal, 0)
})

it('resolves a nested lexical shadow to the nearest local binding', () => {
  const result = elaborate(
    'golden://shadow.silk',
    `pub fn main() -> i32 {
      let value = 1
      if true {
        let value = 2
        return value
      }
      return value
    }`,
  )

  assert.deepEqual(result.diagnostics, [])
  const main = result.tir.functions.at(0)
  const conditional = main?.statements.at(1)
  assert.strictEqual(conditional?._tag, 'If')
  if (conditional?._tag !== 'If') return
  const returned = conditional.taken.at(-1)
  assert.strictEqual(returned?._tag, 'Return')
  if (returned?._tag !== 'Return') return
  assert.strictEqual(returned.expression._tag, 'BindingReference')
  if (returned.expression._tag !== 'BindingReference') return
  assert.strictEqual(returned.expression.binding.ordinal, 1)
})

it('reports an unknown name and a use before its binding as missing references', () => {
  const result = elaborate(
    'golden://forward.silk',
    `pub fn main() -> i32 { let early = late let late = 2 return early }`,
  )

  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['SEM0006'],
  )
  const main = result.tir.functions.at(0)
  const first = main?.statements.at(0)
  assert.strictEqual(first?._tag, 'Bind')
  if (first?._tag !== 'Bind') return
  assert.strictEqual(first.initializer._tag, 'Unavailable')
})

it('matches the accepted TIR golden encoding byte-for-byte', () => {
  const result = elaborate('golden://accepted.silk', acceptedSource)

  assert.strictEqual(Tir.encode(result.tir), golden('accepted.tir.txt'))
})

it('matches the damaged TIR golden encoding and names unavailable states', () => {
  const result = elaborate('golden://damaged.silk', damagedSource)
  const encoded = Tir.encode(result.tir)

  assert.strictEqual(encoded, golden('damaged.tir.txt'))
  assert.include(encoded, 'contract-unavailable')
  assert.include(encoded, 'unavailable @')
})

it('elaborates and encodes byte-identically across repeated fresh runs', () => {
  const first = elaborate('golden://repeat.silk', damagedSource)
  const second = elaborate('golden://repeat.silk', damagedSource)

  assert.deepEqual(first, second)
  assert.strictEqual(Tir.encode(first.tir), Tir.encode(second.tir))
})

it('elaborates built-in arithmetic calls with signed literals', () => {
  const result = elaborate(
    'golden://arith.silk',
    'pub fn main() -> i32 { return Intrinsic.i32Add(-8, 50) }',
  )
  const main = result.tir.functions.at(0)
  const returned = main === undefined ? undefined : Tir.returned(main)

  assert.strictEqual(result.diagnostics.length, 0)
  assert.strictEqual(returned?._tag, 'BuiltinCall')
  if (returned?._tag !== 'BuiltinCall') return
  assert.strictEqual(returned.operation, 'Add')
  const first = returned.arguments.at(0)
  assert.strictEqual(first?._tag, 'IntegerLiteral')
  if (first?._tag !== 'IntegerLiteral') return
  assert.strictEqual(first.value, -8n)
  assert.include(Tir.encode(result.tir), 'builtin i32.Add : i32')
})

it('accepts the signed minimum and rejects one below it', () => {
  const minimum = elaborate('golden://min.silk', 'pub fn main() -> i32 { return -2147483648 }')
  const below = elaborate('golden://below.silk', 'pub fn main() -> i32 { return -2147483649 }')

  assert.deepEqual(minimum.diagnostics, [])
  const fn = minimum.tir.functions.at(0)
  const returned = fn === undefined ? undefined : Tir.returned(fn)
  assert.strictEqual(returned?._tag, 'IntegerLiteral')
  if (returned?._tag !== 'IntegerLiteral') return
  assert.strictEqual(returned.value, -2147483648n)
  assert.deepEqual(
    below.diagnostics.map((diagnostic) => diagnostic.code),
    ['SEM0002'],
  )
})

it('diagnoses unknown actors and unknown operations distinctly', () => {
  const actor = elaborate('golden://actor.silk', 'pub fn main() -> i32 { return Math.add(1, 2) }')
  const operation = elaborate(
    'golden://operation.silk',
    'pub fn main() -> i32 { return Intrinsic.i32Frobnicate(1, 2) }',
  )
  const arity = elaborate(
    'golden://arity.silk',
    'pub fn main() -> i32 { return Intrinsic.i32Add() }',
  )

  assert.deepEqual(
    actor.diagnostics.map((diagnostic) => diagnostic.code),
    ['SEM0009'],
  )
  assert.deepEqual(
    operation.diagnostics.map((diagnostic) => diagnostic.code),
    ['SEM0010'],
  )
  assert.deepEqual(
    arity.diagnostics.map((diagnostic) => diagnostic.code),
    ['SEM0007'],
  )
  for (const result of [actor, operation, arity]) {
    const fn = result.tir.functions.at(0)
    const returned = fn === undefined ? undefined : Tir.returned(fn)
    assert.strictEqual(returned?._tag, 'Unavailable')
  }
})

it('keeps bare built-in operation names unresolved', () => {
  const result = elaborate('golden://bare.silk', 'pub fn main() -> i32 { return add(1, 2) }')

  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['SEM0004'],
  )
})

it('elaborates conditionals with typed bool conditions and arm scopes', () => {
  const result = elaborate(
    'golden://branch.silk',
    'pub fn main() -> i32 { let base = 40 if base == 40 { let bonus = 2 return base + bonus } return 0 }',
  )
  const main = result.tir.functions.at(0)

  assert.deepEqual(result.diagnostics, [])
  const conditional = main?.statements.at(1)
  assert.strictEqual(conditional?._tag, 'If')
  if (conditional?._tag !== 'If') return
  assert.strictEqual(conditional.condition._tag, 'BuiltinCall')
  assert.strictEqual(
    conditional.condition._tag === 'BuiltinCall' ? conditional.condition.type : undefined,
    'bool',
  )
  const armBind = conditional.taken.at(0)
  assert.strictEqual(armBind?._tag, 'Bind')
  if (armBind?._tag !== 'Bind') return
  assert.strictEqual(armBind.binding.ordinal, 1)
  assert.strictEqual(conditional.taken.at(1)?._tag, 'Return')
  const encoded = Tir.encode(result.tir)
  assert.include(encoded, 'if r')
  assert.include(encoded, 'then')
})

it('types booleans through declarations and literals', () => {
  const result = elaborate(
    'golden://bool.silk',
    `pub fn check(flag: bool) -> bool { return flag }
pub fn main() -> i32 { if check(true) { return 1 } return 0 }`,
  )

  assert.deepEqual(result.diagnostics, [])
  const check = result.tir.functions.at(0)
  assert.deepEqual(check?.contract, {
    _tag: 'Contract',
    unsafe: false,
    parameters: ['bool'],
    result: 'bool',
    constraints: [],
  })
  const returned = check === undefined ? undefined : Tir.returned(check)
  assert.strictEqual(returned?._tag, 'ParameterReference')
  if (returned?._tag !== 'ParameterReference') return
  assert.strictEqual(returned.type, 'bool')
})

it('rejects non-bool conditions and mistyped arguments', () => {
  const condition = elaborate(
    'golden://condition.silk',
    'pub fn main() -> i32 { if 1 { return 1 } return 0 }',
  )
  const builtinArg = elaborate(
    'golden://builtin-arg.silk',
    'pub fn main() -> i32 { return Intrinsic.i32Add(true, 1) }',
  )
  const userArg = elaborate(
    'golden://user-arg.silk',
    `pub fn pick(flag: bool) -> i32 { return 1 }
pub fn main() -> i32 { return pick(42) }`,
  )

  assert.deepEqual(
    condition.diagnostics.map((diagnostic) => diagnostic.code),
    ['SEM0011'],
  )
  assert.deepEqual(
    builtinArg.diagnostics.map((diagnostic) => diagnostic.code),
    ['SEM0012'],
  )
  assert.deepEqual(
    userArg.diagnostics.map((diagnostic) => diagnostic.code),
    ['SEM0012'],
  )
  const mainFn = builtinArg.tir.functions.at(0)
  const returned = mainFn === undefined ? undefined : Tir.returned(mainFn)
  assert.strictEqual(returned?._tag, 'Unavailable')
})

it('erases grouping and operators into canonical builtin TIR calls', () => {
  const result = elaborate(
    'golden://operators.silk',
    'pub fn main() -> i32 { return -(2 + 3 * 4) }',
  )
  const fn = result.tir.functions.at(0)
  const returned = fn === undefined ? undefined : Tir.returned(fn)

  assert.deepEqual(result.diagnostics, [])
  assert.strictEqual(returned?._tag, 'BuiltinCall')
  if (returned?._tag !== 'BuiltinCall') return
  assert.strictEqual(returned.operation, 'Negate')
  const addition = returned.arguments.at(0)
  assert.strictEqual(addition?._tag, 'BuiltinCall')
  if (addition?._tag !== 'BuiltinCall') return
  assert.strictEqual(addition.operation, 'Add')
  const multiplication = addition.arguments.at(1)
  assert.strictEqual(multiplication?._tag, 'BuiltinCall')
  if (multiplication?._tag !== 'BuiltinCall') return
  assert.strictEqual(multiplication.operation, 'Multiply')
})

it('lowers builtin pipelines into left-first callable application with an erasable section', () => {
  const result = elaborate(
    'golden://pipeline.silk',
    'pub fn main() -> i32 { return 2 |> Intrinsic.i32Add(3) }',
  )
  const fn = result.tir.functions.at(0)
  const returned = fn === undefined ? undefined : Tir.returned(fn)

  assert.deepEqual(result.diagnostics, [])
  assert.strictEqual(returned?._tag, 'CallableApply')
  if (returned?._tag !== 'CallableApply') return
  assert.strictEqual(returned.evaluation, 'LeftThenCallable')
  assert.strictEqual(returned.realization, 'DirectErasedSection')
  assert.strictEqual(returned.arguments.at(0)?._tag, 'IntegerLiteral')
  assert.strictEqual(returned.callee._tag, 'CallableSection')
  if (returned.callee._tag !== 'CallableSection') return
  assert.strictEqual(returned.callee.target._tag, 'BuiltinCallableTarget')
  assert.strictEqual(returned.callee.captures.at(0)?.value._tag, 'IntegerLiteral')
})

it('preserves stored and cross-call owned callable environments', () => {
  const result = elaborate(
    'tir://owned-callable-return.silk',
    `struct Token { value: i32 }
fn consume(value: i32, token: Token) -> i32 { return value }
fn make(token: Token) -> once fn<'static>(i32) -> i32 { return consume(move token) }
pub fn main() -> i32 {
  let token = Token { value: 42 }
  let callback = make(move token)
  return callback(1)
}`,
  )
  const make = result.tir.functions.at(1)
  const main = result.tir.functions.at(2)
  const returnedEnvironment = make === undefined ? undefined : Tir.returned(make)
  const applied = main === undefined ? undefined : Tir.returned(main)

  assert.deepEqual(result.diagnostics, [])
  assert.strictEqual(returnedEnvironment?._tag, 'CallableSection')
  assert.strictEqual(
    returnedEnvironment?._tag === 'CallableSection' ? returnedEnvironment.mode : undefined,
    'Take',
  )
  assert.strictEqual(applied?._tag, 'CallableApply')
  assert.strictEqual(
    applied?._tag === 'CallableApply' ? applied.realization : undefined,
    'Environment',
  )
})

it.effect('desugars effect functions and source-defined catch calls to hidden effect values', () =>
  Effect.gen(function* () {
    const result = yield* elaborateWithStdlib(
      'tir://effect.silk',
      `import silk.effect { Effect }
struct Problem { code: i32 }
effect fn risky() -> i32 ! Problem { fail move Problem { code: 41 } }
effect fn recover(problem: Problem) -> i32 { return problem.code + 1 }
pub fn main() -> i32 {
  let recipe = Effect.catchAll(risky(), recover)
  return run recipe
}`,
    )
    const risky = result.tir.functions.at(0)
    const main = result.tir.functions.at(2)

    assert.deepEqual(result.diagnostics, [])
    assert.strictEqual(risky?.contract._tag, 'Contract')
    if (risky?.contract._tag === 'Contract') {
      assert.isUndefined(risky.contract.functionKind)
      assert.strictEqual(
        Type.encode(risky.contract.result),
        "Effect<'static; i32 ! tir/effect.Problem>",
      )
    }
    assert.strictEqual(risky?.statements.at(0)?._tag, 'Return')
    const riskyBody = risky?.statements.at(0)
    assert.strictEqual(
      riskyBody?._tag === 'Return' ? riskyBody.expression._tag : undefined,
      'EffectBlock',
    )
    if (riskyBody?._tag === 'Return' && riskyBody.expression._tag === 'EffectBlock')
      assert.strictEqual(riskyBody.expression.statements.at(0)?._tag, 'Fail')
    assert.strictEqual(main?.statements.at(0)?._tag, 'Bind')
    const binding = main?.statements.at(0)
    assert.strictEqual(
      binding?._tag === 'Bind' ? binding.initializer._tag : undefined,
      'EffectConstruct',
    )
    if (binding?._tag === 'Bind' && binding.initializer._tag === 'EffectConstruct') {
      assert.strictEqual(binding.initializer.target.module, 'silk/effect')
      assert.strictEqual(binding.initializer.target.name, 'Effect.catchAll')
      assert.strictEqual(binding.initializer.arguments.at(0)?._tag, 'EffectConstruct')
    }
    assert.strictEqual(main === undefined ? undefined : Tir.returned(main)._tag, 'Run')
    assert.deepEqual(Tir.verify(result.tir), [])
  }),
)

it('retains every runtime effect-function argument in declaration order', () => {
  const result = elaborate(
    'tir://effect-function-arguments.silk',
    `struct Guard {}
effect fn hold(
  first: Guard,
  shared: &[i32],
  middle: Guard,
  exclusive: &mut [i32],
  last: Guard
) -> () {
  drop middle
  return ()
}`,
  )
  const hold = result.tir.functions.at(0)
  const returned = hold === undefined ? undefined : Tir.returned(hold)

  assert.deepEqual(result.diagnostics, [])
  assert.strictEqual(returned?._tag, 'EffectBlock')
  if (returned?._tag !== 'EffectBlock') return
  assert.deepEqual(
    returned.captures.map((capture) => [capture.parameter?.ordinal, capture.access]),
    [
      [0, 'Take'],
      [1, 'Shared'],
      [2, 'Take'],
      [3, 'Exclusive'],
      [4, 'Take'],
    ],
  )
  assert.strictEqual(returned.type.access, 'Take')
})

it('retains effect blocks as lazy statement regions with canonical captures', () => {
  const result = elaborate(
    'tir://effect-block.silk',
    `fn main(value: i32) -> i32 {
  let mut counter = value
  let pending = effect { counter = counter + 1 return counter }
  return 0
}`,
  )
  const binding = result.tir.functions.at(0)?.statements.at(1)
  assert.deepEqual(result.diagnostics, [])
  assert.strictEqual(binding?._tag, 'Bind')
  if (binding?._tag !== 'Bind' || binding.initializer._tag !== 'EffectBlock') return
  assert.strictEqual(binding.initializer.type.access, 'Exclusive')
  assert.deepEqual(
    binding.initializer.site.owner === undefined
      ? undefined
      : Tir.effectRunnerId(binding.initializer.site.owner, binding.initializer.site),
    {
      _tag: 'CanonicalDeclarationId',
      module: 'tir/effect-block.silk',
      name: 'main$effect$0',
    },
  )
  assert.deepEqual(
    binding.initializer.captures.map((capture) => [capture.binding?.ordinal, capture.access]),
    [[1, 'Exclusive']],
  )
  assert.include(
    Tir.encode(result.tir),
    `effect-block site=${Tir.executableSiteLabel(binding.initializer.site)}`,
  )
  assert.include(Tir.encode(result.tir), 'access=exclusive')
})

it('retains explicit unsafe boundaries as typed TIR regions', () => {
  const result = elaborate(
    'tir://unsafe.silk',
    'struct Token { value: i32 } pub fn main() -> i32 { unsafe { let token = Token { value: 1 } drop token } return 42 }',
  )
  const statement = result.tir.functions.at(0)?.statements.at(0)
  assert.deepEqual(result.diagnostics, [])
  assert.strictEqual(statement?._tag, 'Unsafe')
  if (statement?._tag !== 'Unsafe') return
  assert.deepEqual(
    statement.statements.map((nested) => nested._tag),
    ['Bind', 'Drop'],
  )
  assert.include(Tir.encode(result.tir), 'unsafe r')
  assert.deepEqual(Tir.verify(result.tir), [])
})

it('retains generic raw-buffer operations and whole-value borrows', () => {
  const result = elaborate(
    'tir://raw-storage.silk',
    `fn destroy(buffer: Intrinsic.RawBuffer<i32>) -> () {
  let mut owner = move buffer
  unsafe { return Intrinsic.slotDrop(Intrinsic.rawBufferSlot(&mut owner, 0)) }
}`,
  )
  const unsafe = result.tir.functions.at(0)?.statements.at(1)

  assert.deepEqual(result.diagnostics, [])
  assert.strictEqual(unsafe?._tag, 'Unsafe')
  if (unsafe?._tag !== 'Unsafe') return
  const returned = unsafe.statements.at(0)
  assert.strictEqual(returned?._tag, 'Return')
  if (returned?._tag !== 'Return' || returned.expression._tag !== 'BuiltinCall') return
  assert.strictEqual(returned.expression.operation, 'SlotDrop')
  const slot = returned.expression.arguments.at(0)
  assert.strictEqual(slot?._tag, 'BuiltinCall')
  if (slot?._tag !== 'BuiltinCall') return
  assert.strictEqual(slot.operation, 'RawBufferSlot')
  assert.strictEqual(slot.arguments.at(0)?._tag, 'ValueBorrow')
  assert.deepEqual(Tir.verify(result.tir), [])
})

it('retains shared pattern-field reborrows and raw-buffer reads', () => {
  const result = elaborate(
    'tir://shared-pattern-read.silk',
    `struct Box { buffer: Intrinsic.RawBuffer<i32> }
fn read(buffer: &Intrinsic.RawBuffer<i32>) -> i32 {
  unsafe { return Intrinsic.rawBufferRead<i32>(buffer, 0) }
}
fn inspect(input: Box) -> i32 {
  return match &input { Box { buffer } => read(&buffer) }
}`,
  )

  assert.deepEqual(result.diagnostics, [])
  assert.include(Tir.encode(result.tir), 'borrow-value')
  assert.include(Tir.encode(result.tir), 'binding #1 buffer')
  assert.include(Tir.encode(result.tir), 'RawBufferRead')
  assert.deepEqual(Tir.verify(result.tir), [])
})
