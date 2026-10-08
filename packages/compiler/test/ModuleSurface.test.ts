import { locationAt } from './support/location.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Analysis from '../src/Analysis.js'
import * as CallableContract from '../src/CallableContract.js'
import * as Constraint from '../src/Constraint.js'
import * as Lifetime from '../src/Lifetime.js'
import * as ModuleSurface from '../src/ModuleSurface.js'
import * as SemanticDisplay from '../src/SemanticDisplay.js'
import * as RowAlgebra from '../src/RowAlgebra.js'
import * as SourceSpan from '../src/SourceSpan.js'
import * as Type from '../src/Type.js'
import { unreachable } from './support/raise.js'

const encoder = new TextEncoder()
const JsonValue = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownSync(JsonValue)
const encodeJson = Schema.encodeSync(JsonValue)

const surface = Effect.fnUntraced(function* (source: string) {
  const analysis = yield* Analysis.ofSource('surface/Main', encoder.encode(source))
  return analysis.surfaces.get('surface/Main') ?? assert.fail('missing module surface')
})

const firstSubstitution = (value: unknown): ReadonlyArray<unknown> | undefined => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstSubstitution(entry)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'substitution' && Array.isArray(entry)) return entry
    const found = firstSubstitution(entry)
    if (found !== undefined) return found
  }
  return undefined
}

const replaceRecordField = (value: unknown, key: string, replacement: unknown): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return unreachable(`expected a record with ${key}`)
  }
  return Object.fromEntries(
    Object.entries(value).map(([field, entry]) => [field, field === key ? replacement : entry]),
  )
}

const recordField = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.entries(value).find(([field]) => field === key)?.[1]
    : undefined

const forgeFirstSubstitution = Effect.fnUntraced(function* (
  encoded: string,
  transform: (entries: ReadonlyArray<unknown>) => ReadonlyArray<unknown>,
) {
  return yield* Effect.try(() => {
    let replaced = false
    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewrite)
      if (typeof value !== 'object' || value === null) return value
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
          if (key !== 'substitution' || !Array.isArray(entry) || replaced)
            return [key, rewrite(entry)]
          replaced = true
          return [key, transform(entry)]
        }),
      )
    }
    const forged = encodeJson(rewrite(decodeJson(encoded)))
    return replaced ? forged : unreachable('expected a serialized substitution')
  })
})

it.effect('projects scalar enum declarations deterministically into module surfaces', () =>
  Effect.gen(function* () {
    const first = yield* surface('pub enum(u16) Status { Pending, Ready = 5, Done }')
    const repeated = yield* surface('pub enum(u16) Status { Pending, Ready = 5, Done }')
    const defaultRepresentation = yield* surface('pub enum Status { Pending, Ready = 5, Done }')
    const reordered = yield* surface('pub enum(u16) Status { Ready = 5, Pending, Done }')
    const unavailable = yield* surface('pub enum(usize) Status { Pending }')

    assert.strictEqual(ModuleSurface.equals(first, repeated), true)
    assert.strictEqual(ModuleSurface.equals(first, defaultRepresentation), false)
    assert.strictEqual(ModuleSurface.equals(first, reordered), false)
    assert.strictEqual(ModuleSurface.equals(first, unavailable), false)
    assert.include(first.canonical, 'AvailableEnumRepresentation')
    assert.include(first.canonical, 'AvailableEnumDiscriminant')
    assert.include(unavailable.canonical, 'UnavailableEnumRepresentation')
  }),
)

it.effect('projects complete nominal union headers into deterministic module surfaces', () =>
  Effect.gen(function* () {
    const base = yield* surface(
      'pub union Result<A, E> { Success { pub value: A }, Failure { error: E }, Pending }',
    )
    const repeated = yield* surface(
      'pub union Result<A, E> { Success { pub value: A }, Failure { error: E }, Pending }',
    )
    const reordered = yield* surface(
      'pub union Result<A, E> { Failure { error: E }, Success { pub value: A }, Pending }',
    )
    const changedField = yield* surface(
      'pub union Result<A, E> { Success { pub value: E }, Failure { error: E }, Pending }',
    )
    const changedVisibility = yield* surface(
      'pub union Result<A, E> { Success { value: A }, Failure { error: E }, Pending }',
    )
    const unitInstead = yield* surface(
      'pub union Result<A, E> { Success, Failure { error: E }, Pending }',
    )

    assert.strictEqual(ModuleSurface.equals(base, repeated), true)
    assert.strictEqual(ModuleSurface.equals(base, reordered), false)
    assert.strictEqual(ModuleSurface.equals(base, changedField), false)
    assert.strictEqual(ModuleSurface.equals(base, changedVisibility), false)
    assert.strictEqual(ModuleSurface.equals(base, unitInstead), false)
    assert.include(base.canonical, 'UnionDeclaration')
    assert.include(base.canonical, 'CanonicalUnionVariant')
    assert.include(base.canonical, 'AvailableStructDependency')
  }),
)

it.effect('preserves C-layout struct facts in presentation and module surfaces', () =>
  Effect.gen(function* () {
    const source = 'pub extern "C" struct Timespec { pub seconds: i64 }'
    const cLayout = yield* Analysis.ofSource('surface/Main', encoder.encode(source))
    const repeated = yield* surface(source)
    const ordinaryAnalysis = yield* Analysis.ofSource(
      'surface/Main',
      encoder.encode('pub struct Timespec { pub seconds: i64 }'),
    )
    const invalidAnalysis = yield* Analysis.ofSource(
      'surface/Main',
      encoder.encode('pub extern "Rust" struct Timespec { pub seconds: i64 }'),
    )
    const fact = cLayout.index.modules.at(0)?.structs.at(0)
    const cLayoutSurface =
      cLayout.surfaces.get('surface/Main') ?? assert.fail('missing C-layout module surface')
    const ordinary =
      ordinaryAnalysis.surfaces.get('surface/Main') ??
      assert.fail('missing ordinary module surface')
    const invalid =
      invalidAnalysis.surfaces.get('surface/Main') ?? assert.fail('missing invalid module surface')
    const ordinaryFact = ordinaryAnalysis.index.modules.at(0)?.structs.at(0)
    const invalidFact = invalidAnalysis.index.modules.at(0)?.structs.at(0)

    assert.strictEqual(fact?.layout._tag, 'Foreign')
    assert.strictEqual(fact?.layout._tag === 'Foreign' ? fact.layout.abi : undefined, 'C')
    assert.strictEqual(ordinaryFact?.layout._tag, 'Silk')
    assert.strictEqual(invalidFact?.layout._tag, 'InvalidForeign')
    assert.strictEqual(
      fact === undefined ? undefined : SemanticDisplay.structDeclaration(fact).text,
      'pub extern "C" struct Timespec',
    )
    assert.strictEqual(
      invalidFact === undefined ? undefined : SemanticDisplay.structDeclaration(invalidFact).text,
      'pub extern "Rust" struct Timespec',
    )
    assert.strictEqual(ModuleSurface.equals(cLayoutSurface, repeated), true)
    assert.strictEqual(ModuleSurface.equals(cLayoutSurface, ordinary), false)
    assert.strictEqual(ModuleSurface.equals(cLayoutSurface, invalid), false)
    assert.include(cLayoutSurface.canonical, 'ForeignStructLayout')
    assert.include(ordinary.canonical, 'SilkStructLayout')
    assert.include(invalid.canonical, 'InvalidForeignStructLayout')
    assert.deepEqual(
      invalidAnalysis.diagnostics.map((diagnostic) => diagnostic.code),
      ['SEM0185'],
    )
  }),
)

it.effect('compares independently allocated equal facts exactly', () =>
  Effect.gen(function* () {
    const source = `pub fn answer(value: i32) -> i32 { return value }
pub struct Pair { pub left: i32 pub right: i32 }
pub const enabled: bool = true`
    const left = yield* surface(source)
    const right = yield* surface(source)

    assert.notStrictEqual(left, right)
    assert.strictEqual(ModuleSurface.equals(left, right), true)
    assert.strictEqual(left.canonical, right.canonical)
  }),
)

it.effect('retains constant initializer templates in the module surface', () =>
  Effect.gen(function* () {
    const compact = yield* surface('pub const timeout: u64 = 1h5m')
    const padded = yield* surface('pub const timeout: u64 = 01h05m00s')
    const changed = yield* surface('pub const timeout: u64 = 1h6m')

    assert.strictEqual(ModuleSurface.equals(compact, padded), false)
    assert.strictEqual(ModuleSurface.equals(compact, changed), false)
    assert.include(compact.canonical, 'DurationLiteral')
    // The template is authored content, not source text: it records the written components
    // (`00s` is one) without their spelling.
    assert.notInclude(compact.canonical, '1h5m')
  }),
)

it.effect('encodes type aliases by their erased target', () =>
  Effect.gen(function* () {
    const preamble = 'pub struct HttpError {}\npub struct JsonError {}\npub struct Timeout {}\n'
    const left = yield* surface(`${preamble}pub type FetchError = HttpError | JsonError`)
    const reordered = yield* surface(`${preamble}pub type FetchError = JsonError | HttpError`)
    const widened = yield* surface(
      `${preamble}pub type FetchError = HttpError | JsonError | Timeout`,
    )
    const hidden = yield* surface(`${preamble}type FetchError = HttpError | JsonError`)

    assert.include(left.canonical, 'AliasDeclaration')
    assert.strictEqual(ModuleSurface.equals(left, reordered), true)
    assert.strictEqual(ModuleSurface.equals(left, widened), false)
    assert.strictEqual(ModuleSurface.equals(left, hidden), false)
  }),
)

it.effect('ignores bodies and source positions while retaining header meaning', () =>
  Effect.gen(function* () {
    const left = yield* surface(`fn helper() -> i32 { return 1 }
pub fn answer() -> i32 { return 42 }`)
    const right = yield* surface(`fn helper() -> i32 { return 123456 }


pub fn answer() -> i32 { return 99 }`)

    assert.strictEqual(ModuleSurface.equals(left, right), true)
  }),
)

it.effect('retains static modes and body-template meaning without source positions', () =>
  Effect.gen(function* () {
    const left = yield* surface(
      'pub fn render(static template: string, value: i32) -> i32 { let static parsed = template return value }',
    )
    const repeated = yield* surface(
      '\n\npub fn render(static template: string, value: i32) -> i32 { let static parsed = template return value }',
    )
    const changed = yield* surface(
      'pub fn render(static template: string, value: i32) -> i32 { let static parsed = "changed" return value }',
    )
    const runtimeParameter = yield* surface(
      'pub fn render(template: string, value: i32) -> i32 { return value }',
    )

    assert.strictEqual(ModuleSurface.equals(left, repeated), true)
    assert.strictEqual(ModuleSurface.equals(left, changed), false)
    assert.strictEqual(ModuleSurface.equals(left, runtimeParameter), false)
    assert.include(left.canonical, 'Static')
    assert.include(left.canonical, 'FunctionBodyTemplate')
  }),
)

it.effect('erases local parameter mutability from the exported callable surface', () =>
  Effect.gen(function* () {
    const immutable = yield* surface(`pub struct Counter { pub value: i32 }
pub fn update(counter: Counter) -> Counter { return move counter }`)
    const mutable = yield* surface(`pub struct Counter { pub value: i32 }
pub fn update(mut counter: Counter) -> Counter { return move counter }`)

    assert.strictEqual(ModuleSurface.equals(immutable, mutable), true)
  }),
)

it.effect('distinguishes every cross-module observable header family', () =>
  Effect.gen(function* () {
    const cases = [
      ['pub fn answer() -> i32 { return 1 }', 'pub fn answer(value: i32) -> i32 { return value }'],
      ['pub fn answer() -> i32 { return 1 }', 'fn answer() -> i32 { return 1 }'],
      ['pub struct Pair { pub left: i32 }', 'pub struct Pair { pub left: i32 pub right: i32 }'],
      ['pub const answer: i32 = 1', 'pub const answer: i32 = 2'],
      [
        `struct Guard {}
impl Drop for Guard { fn drop(self: &mut Guard) -> () { return () } }`,
        'struct Guard {}',
      ],
      ['pub fn answer() -> Mystery { return 1 }', 'pub fn answer() -> Other { return 1 }'],
      [
        'pub fn ab() -> i32 { return 1 }',
        'pub fn a() -> i32 { return 1 } fn b() -> i32 { return 1 }',
      ],
    ] as const

    for (const [before, after] of cases) {
      const left = yield* surface(before)
      const right = yield* surface(after)
      assert.strictEqual(ModuleSurface.equals(left, right), false, `${before} should differ`)
    }
  }),
)

it.effect('keeps string distinct from an immutable byte view in module surfaces', () =>
  Effect.gen(function* () {
    const text = yield* surface('pub fn identity(value: string) -> string { return value }')
    const bytes = yield* surface('pub fn identity(value: &[u8]) -> &[u8] { return value }')

    assert.strictEqual(ModuleSurface.equals(text, bytes), false)
    assert.include(text.canonical, 'string')
    assert.include(bytes.canonical, 'slice:Shared<')
    // Pins the canonical surface encoding byte-for-byte; an encoding change must be deliberate.
    assert.strictEqual(
      text.canonical,
      '13:ModuleSurface12:surface/Main7:5:Array1152:5:Array1140:19:FunctionDeclaration35:18:DeclarationOrdinal11:6:Number1:053:9:Canonical39:11:CanonicalId12:surface/Main8:identity6:Public7:Runtime8:Ordinary131:19:ExecutableLifetimes6:static80:5:Array70:13:BoundLifetime39:11:Declaration12:surface/Main8:identity7:5:Array1:07:5:Array7:5:Array7:5:False6:4:None6:4:None6:4:None155:5:Array144:13:TypeParameter79:4:Type70:13:BoundLifetime39:11:Declaration12:surface/Main8:identity7:5:Array1:017:14:LifetimeBinder7:5:Array6:4:None7:5:Array11:6:Number1:1187:5:Array176:9:Parameter11:6:Number1:021:11:PresentName5:value7:Runtime114:12:ResolvedType87:4:Type78:string<13:BoundLifetime39:11:Declaration12:surface/Main8:identity7:5:Array1:0>7:5:False24:11:PresentName8:identity114:12:ResolvedType87:4:Type78:string<13:BoundLifetime39:11:Declaration12:surface/Main8:identity7:5:Array1:0>7:5:False6:4:None133:10:FailureRow6:4:True7:5:Array7:5:Array7:5:Array21:18:EmptyRowExpression58:10:RowAlgebra33:8:Concrete20:9:FiniteRow7:5:Array7:5:Array137:14:RequirementRow6:4:True7:5:Array21:18:EmptyRowExpression58:10:RowAlgebra33:8:Concrete20:9:FiniteRow7:5:Array7:5:Array7:5:Array7:5:Array7:5:Array7:5:Array6:4:None6:4:None7:5:Array7:5:Array',
    )
  }),
)

it.effect('keeps malformed and unavailable header states deterministic without stale repair', () =>
  Effect.gen(function* () {
    const damaged = 'pub fn answer(value: ) -> { return 1 }'
    const first = yield* surface(damaged)
    const second = yield* surface(damaged)
    const repaired = yield* surface('pub fn answer(value: i32) -> i32 { return value }')

    assert.strictEqual(ModuleSurface.equals(first, second), true)
    assert.strictEqual(ModuleSurface.equals(first, repaired), false)
  }),
)

it.effect('distinguishes damaged ordinary applied arguments in module surfaces', () =>
  Effect.gen(function* () {
    const withFailure = (failure: string) => `pub struct Envelope<T, E> {}
pub fn inspect(value: Envelope<i32, ${failure}>) -> i32 { return 0 }`
    const left = yield* surface(withFailure('MissingA'))
    const right = yield* surface(withFailure('MissingB'))

    assert.strictEqual(ModuleSurface.equals(left, right), false)
  }),
)

it.effect('excludes conformance hook bodies from the exported semantic surface', () =>
  Effect.gen(function* () {
    const first = yield* surface(`struct Guard {}
impl Drop for Guard { fn drop(self: &mut Guard) -> () { return () } }`)
    const second = yield* surface(`struct Guard {}
impl Drop for Guard { fn drop(self: &mut Guard) -> () { unsafe { return () } } }`)

    assert.strictEqual(ModuleSurface.equals(first, second), true)
  }),
)

it('refuses to encode a section binder as an ordinary parameter', () => {
  const parameter = Type.parameter({ module: 'surface/section', name: 'provide' }, 0, 'A')
  assert.strictEqual(
    ModuleSurface.encodeSemanticType(parameter),
    ModuleSurface.encodeSemanticType(
      Type.parameter({ module: 'surface/section', name: 'provide' }, 0, 'A'),
    ),
  )
  assert.throws(() => ModuleSurface.encodeSemanticType(Type.sectionBinder(parameter)), RangeError)
})

it.effect('round-trips constrained callable schemas without source origins', () =>
  Effect.gen(function* () {
    const owner = { module: 'surface/Main', name: 'provide' }
    const selectedParameter = Type.parameter(owner, 0, 'S', 'RequirementRow')
    const providerParameter = Type.parameter(owner, 1, 'P')
    const sourceParameter = Type.parameter(owner, 2, 'R', 'RequirementRow')
    const selected = RowAlgebra.parameter<
      Type.Requirement,
      Type.Parameter,
      Type.RequirementMemberShape
    >(selectedParameter)
    const source = RowAlgebra.parameter<
      Type.Requirement,
      Type.Parameter,
      Type.RequirementMemberShape
    >(sourceParameter)
    const wanted = Constraint.providerSelection('Exclusive', providerParameter, selected, source)
    const logger = Type.nominal('silk/logger', 'Logger')
    const provider = Type.nominal('surface/Logger', 'Provider')
    const requirement: Type.Requirement = {
      capability: logger,
      role: 'DefaultRole',
      access: 'Exclusive',
    }
    const selectedRequirements = RowAlgebra.concrete(Type.requirementRowPolicy(), [requirement])
    const concreteWanted = Constraint.providerSelection(
      'Exclusive',
      provider,
      selectedRequirements,
      selectedRequirements,
    )
    const evidence = Constraint.requirementSelectionEvidence(concreteWanted, requirement, {
      _tag: 'Conformance',
      witness: {
        origin: {
          _tag: 'SourceWitness',
          declaration: { module: 'surface/Logger', name: 'loggerConformance' },
        },
        typeArguments: [provider, Type.requirementRowArgument([requirement])],
      },
    })
    const assumed = Constraint.assumed(wanted, new Map())
    const contract = CallableContract.make({
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
      functionKind: 'Effect',
      unsafe: true,
      binders: [selectedParameter, providerParameter, sourceParameter],
      parameters: [
        {
          type: Type.effectWithRows(
            Type.unit,
            RowAlgebra.concrete(Type.failureRowPolicy(), []),
            { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
            'Take',
            source,
          ),
          mode: 'Take',
        },
        {
          type: Type.reference('Exclusive', providerParameter, Lifetime.staticLifetime),
          mode: 'Exclusive',
        },
      ],
      result: Type.effectWithRows(
        Type.unit,
        RowAlgebra.concrete(Type.failureRowPolicy(), []),
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Take',
        RowAlgebra.without(Type.requirementRowPolicy(), source, selected),
      ),
      constraints: [wanted],
    })
    const callable = Type.callable(
      [contract.parameters.at(0)?.type ?? 'never'],
      contract.result,
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Exclusive',
      {
        contract,
        binders: contract.binders,
        constraints: contract.constraints,
        evidence: [assumed],
        substitution: new Map([[Type.key(providerParameter), provider]]),
        contractKey: CallableContract.key(contract),
        constraintKeys: [Constraint.key(wanted)],
        evidenceKeys: [Constraint.evidenceKey(assumed)],
        origins: [locationAt('surface/Main')],
      },
      true,
    )

    const decoded = yield* ModuleSurface.decodeSemanticType(
      ModuleSurface.encodeSemanticType(callable),
    )
    assert.strictEqual(Type.key(decoded), Type.key(callable))
    assert.isTrue(Type.isCallable(decoded))
    if (!Type.isCallable(decoded)) return
    assert.strictEqual(decoded.unsafe, true)
    assert.deepEqual(decoded.schema?.origins, [])
    assert.deepEqual(decoded.schema?.constraintKeys, callable.schema?.constraintKeys)
    assert.deepEqual(decoded.schema?.evidenceKeys, callable.schema?.evidenceKeys)
    const decodedConstraint = yield* ModuleSurface.decodeConstraint(
      ModuleSurface.encodeConstraint(wanted),
    )
    assert.strictEqual(Constraint.key(decodedConstraint), Constraint.key(wanted))
    assert.strictEqual(
      decoded.schema?.constraints.at(0) === undefined
        ? undefined
        : Constraint.key(decoded.schema.constraints.at(0) ?? wanted),
      Constraint.key(wanted),
    )
    assert.strictEqual(
      decoded.schema?.evidence.at(0) === undefined
        ? undefined
        : Constraint.evidenceKey(decoded.schema.evidence.at(0) ?? assumed),
      Constraint.evidenceKey(assumed),
    )
    const decodedEvidence = yield* ModuleSurface.decodeConstraintEvidence(
      ModuleSurface.encodeConstraintEvidence(evidence),
    )
    assert.strictEqual(Constraint.evidenceKey(decodedEvidence), Constraint.evidenceKey(evidence))
    const identityWanted = Constraint.providerSelection(
      'Exclusive',
      logger,
      selectedRequirements,
      selectedRequirements,
    )
    const identityEvidence = Constraint.requirementSelectionEvidence(identityWanted, requirement, {
      _tag: 'Identity',
    })
    const decodedIdentityEvidence = yield* ModuleSurface.decodeConstraintEvidence(
      ModuleSurface.encodeConstraintEvidence(identityEvidence),
    )
    assert.strictEqual(
      Constraint.evidenceKey(decodedIdentityEvidence),
      Constraint.evidenceKey(identityEvidence),
    )
    assert.include(Type.encode(decoded.result), 'Without<R, S>')
  }),
)

it.effect('round trips finite intersection environments inside quantified callback results', () =>
  Effect.gen(function* () {
    const owner = { module: 'surface/Intersection', name: 'callback' }
    const env = Lifetime.bound(owner, 0, 'env')
    const scope = Lifetime.bound(owner, 1, 'scope')
    const type = Type.callable(
      [Type.reference('Exclusive', 'i32', scope)],
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.intersection([env, scope]), lifetimeBinders: [] },
        'Take',
      ),
      { environment: env, lifetimeBinders: [scope] },
      'Take',
    )
    const encoded = ModuleSurface.encodeSemanticType(type)
    const decoded = yield* ModuleSurface.decodeSemanticType(encoded)
    assert.strictEqual(Type.key(decoded), Type.key(type))
    assert.strictEqual(ModuleSurface.encodeSemanticType(decoded), encoded)
    assert.strictEqual(Type.runtimeKey(decoded), Type.runtimeKey(type))
  }),
)

it.effect('validates canonical substitutions against their local parameter scope', () =>
  Effect.gen(function* () {
    const owner = { module: 'surface/Substitution', name: 'callable' }
    const first = Type.parameter(owner, 0, 'First')
    const second = Type.parameter(owner, 1, 'Second')
    const contract = CallableContract.make({
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
      functionKind: 'Function',
      binders: [first, second],
      parameters: [{ type: 'i32', mode: 'Value' }],
      result: 'i32',
    })
    const substitution: Type.Substitution = new Map([
      [Type.key(first), 'i32'],
      [Type.key(second), 'bool'],
    ])
    const schema: Type.CallableSchema = {
      source: owner,
      contract,
      binders: contract.binders,
      constraints: contract.constraints,
      evidence: [],
      substitution,
      contractKey: CallableContract.key(contract),
      constraintKeys: [],
      evidenceKeys: [],
      origins: [],
    }
    const callable = Type.callable(
      ['i32'],
      'i32',
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Shared',
      schema,
    )
    const callableEncoding = ModuleSurface.encodeSemanticType(callable)
    const decodedCallable = yield* ModuleSurface.decodeSemanticType(callableEncoding)
    assert.strictEqual(Type.key(decodedCallable), Type.key(callable))
    assert.strictEqual(ModuleSurface.encodeSemanticType(decodedCallable), callableEncoding)
    const residual = Type.callable(
      ['i32'],
      'i32',
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Shared',
      {
        ...schema,
        substitution: new Map<string, Type.GenericArgument>([[Type.key(first), 'i32']]),
      },
    )
    const decodedResidual = yield* ModuleSurface.decodeSemanticType(
      ModuleSurface.encodeSemanticType(residual),
    )
    assert.strictEqual(Type.key(decodedResidual), Type.key(residual))

    const origin =
      SourceSpan.fromOffsets('surface/Substitution', 0, 1) ??
      unreachable('expected substitution source span')
    const wanted = Constraint.nominalMember(
      first,
      RowAlgebra.singleton(Type.failureRowPolicy(), Type.failureMemberShape(second), origin),
    )
    const assumed = Constraint.assumed(wanted, substitution)
    const assumedEncoding = ModuleSurface.encodeConstraintEvidence(assumed)
    const decodedAssumed = yield* ModuleSurface.decodeConstraintEvidence(assumedEncoding)
    assert.strictEqual(Constraint.evidenceKey(decodedAssumed), Constraint.evidenceKey(assumed))
    assert.strictEqual(ModuleSurface.encodeConstraintEvidence(decodedAssumed), assumedEncoding)

    const rowParameter = Type.parameter(
      { module: 'surface/Substitution', name: 'rowCallable' },
      0,
      'Failures',
      'RequirementRow',
    )
    const rowContract = CallableContract.make({
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
      functionKind: 'Function',
      binders: [rowParameter],
      parameters: [{ type: 'i32', mode: 'Value' }],
      result: 'i32',
    })
    const rowSubstitution: Type.Substitution = new Map([
      [Type.key(rowParameter), Type.requirementRowArgument([])],
    ])
    const rowCallable = Type.callable(
      ['i32'],
      'i32',
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Shared',
      {
        contract: rowContract,
        binders: rowContract.binders,
        constraints: [],
        evidence: [],
        substitution: rowSubstitution,
        contractKey: CallableContract.key(rowContract),
        constraintKeys: [],
        evidenceKeys: [],
        origins: [],
      },
    )
    const rowEncoding = ModuleSurface.encodeSemanticType(rowCallable)
    const parsedRow = yield* Effect.try(() => decodeJson(rowEncoding))
    const rowEntry =
      firstSubstitution(parsedRow)?.at(0) ?? unreachable('expected row substitution entry')
    const wrongKindArgument =
      recordField(rowEntry, 'argument') ?? unreachable('expected row substitution argument')

    const mutations: ReadonlyArray<
      readonly [string, string, (entries: ReadonlyArray<unknown>) => ReadonlyArray<unknown>]
    > = [
      [
        'duplicate',
        'duplicate parameter',
        (entries) => [
          ...entries,
          entries.at(-1) ?? unreachable('expected substitution entry to duplicate'),
        ],
      ],
      ['reversed', 'canonical order', (entries) => [...entries].reverse()],
      [
        'unknown',
        'unknown parameter',
        (entries) => [
          replaceRecordField(
            entries.at(0) ?? unreachable('expected substitution entry to rename'),
            'parameter',
            '',
          ),
          ...entries.slice(1),
        ],
      ],
      [
        'wrong-kind',
        'wrong kind',
        (entries) => [
          replaceRecordField(
            entries.at(0) ?? unreachable('expected substitution entry to damage'),
            'argument',
            wrongKindArgument,
          ),
          ...entries.slice(1),
        ],
      ],
    ]

    for (const [context, detail, mutate] of mutations) {
      const forgedCallable = yield* forgeFirstSubstitution(callableEncoding, mutate)
      const callableFailure = yield* Effect.flip(ModuleSurface.decodeSemanticType(forgedCallable))
      assert.instanceOf(callableFailure, ModuleSurface.ModuleSurfaceDecodeError, context)
      assert.include(callableFailure.reason.detail, detail, context)

      const forgedAssumed = yield* forgeFirstSubstitution(assumedEncoding, mutate)
      const assumedFailure = yield* Effect.flip(
        ModuleSurface.decodeConstraintEvidence(forgedAssumed),
      )
      assert.instanceOf(assumedFailure, ModuleSurface.ModuleSurfaceDecodeError, context)
      assert.include(assumedFailure.reason.detail, detail, context)
    }
  }),
)

it.effect('round-trips ordered sealed executable properties in semantic type encodings', () =>
  Effect.gen(function* () {
    const parameter = Type.parameter(
      { module: 'surface/Executable', name: 'Deferred' },
      0,
      'F',
      'EffectRepresentation',
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
      ),
      ['Intrinsic.Detached', 'Intrinsic.NonParking'],
    )
    const container = Type.nominal('surface/Executable', 'Deferred', [
      Type.representationParameterArgument(parameter),
    ])
    const encoded = ModuleSurface.encodeSemanticType(container)
    const decoded = yield* ModuleSurface.decodeSemanticType(encoded)
    const argument = Type.isNominal(decoded) ? decoded.arguments.at(0) : undefined
    const restored =
      argument !== undefined && Type.isRepresentationParameterArgument(argument)
        ? argument.parameter
        : undefined

    assert.isDefined(restored)
    assert.deepEqual(restored?.staticProperties, ['Intrinsic.Detached', 'Intrinsic.NonParking'])
    assert.strictEqual(ModuleSurface.encodeSemanticType(decoded), encoded)
  }),
)

it.effect('rejects noncanonical sealed executable properties in semantic type encodings', () =>
  Effect.gen(function* () {
    const parameter = Type.parameter(
      { module: 'surface/Executable', name: 'Deferred' },
      0,
      'F',
      'EffectRepresentation',
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Shared',
      ),
      ['Intrinsic.Detached', 'Intrinsic.NonParking'],
    )
    const encoded = ModuleSurface.encodeSemanticType(
      Type.nominal('surface/Executable', 'Deferred', [
        Type.representationParameterArgument(parameter),
      ]),
    )
    const reversed = encoded.replace(
      '"staticProperties":["Intrinsic.Detached","Intrinsic.NonParking"]',
      '"staticProperties":["Intrinsic.NonParking","Intrinsic.Detached"]',
    )
    const failure = yield* Effect.flip(ModuleSurface.decodeSemanticType(reversed))

    assert.instanceOf(failure, ModuleSurface.ModuleSurfaceDecodeError)
    assert.include(failure.reason.detail, 'canonical order')
    assert.notStrictEqual(
      Type.key(parameter),
      Type.key(
        Type.parameter(parameter.owner, 0, 'F', parameter.kind, parameter.representationBound),
      ),
    )
  }),
)

it.effect('round-trips substitutions independently through nested callable scopes', () =>
  Effect.gen(function* () {
    const innerParameter = Type.parameter({ module: 'surface/Nested', name: 'inner' }, 0, 'Inner')
    const innerContract = CallableContract.make({
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
      functionKind: 'Function',
      binders: [innerParameter],
      parameters: [{ type: innerParameter, mode: 'Value' }],
      result: innerParameter,
    })
    const inner = Type.callable(
      ['i32'],
      'i32',
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Shared',
      {
        contract: innerContract,
        binders: innerContract.binders,
        constraints: [],
        evidence: [],
        substitution: new Map<string, Type.GenericArgument>([[Type.key(innerParameter), 'i32']]),
        contractKey: CallableContract.key(innerContract),
        constraintKeys: [],
        evidenceKeys: [],
        origins: [],
      },
    )
    const outerParameter = Type.parameter({ module: 'surface/Nested', name: 'outer' }, 0, 'Outer')
    const outerContract = CallableContract.make({
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
      functionKind: 'Function',
      binders: [outerParameter],
      parameters: [{ type: inner, mode: 'Value' }],
      result: outerParameter,
    })
    const outerSchema: Type.CallableSchema = {
      contract: outerContract,
      binders: outerContract.binders,
      constraints: [],
      evidence: [],
      substitution: new Map<string, Type.GenericArgument>([[Type.key(outerParameter), 'bool']]),
      contractKey: CallableContract.key(outerContract),
      constraintKeys: [],
      evidenceKeys: [],
      origins: [],
    }
    const outer = Type.callable(
      [inner],
      'bool',
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Take',
      outerSchema,
    )

    const decoded = yield* ModuleSurface.decodeSemanticType(ModuleSurface.encodeSemanticType(outer))
    assert.strictEqual(Type.key(decoded), Type.key(outer))
    assert.strictEqual(
      ModuleSurface.encodeSemanticType(decoded),
      ModuleSurface.encodeSemanticType(outer),
    )

    const leakedNestedBinder = Type.callable(
      [inner],
      'bool',
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Take',
      {
        ...outerSchema,
        substitution: new Map<string, Type.GenericArgument>([
          [Type.key(innerParameter), 'i32'],
          [Type.key(outerParameter), 'bool'],
        ]),
      },
    )
    const failure = yield* Effect.flip(
      ModuleSurface.decodeSemanticType(ModuleSurface.encodeSemanticType(leakedNestedBinder)),
    )
    assert.instanceOf(failure, ModuleSurface.ModuleSurfaceDecodeError)
    assert.include(failure.reason.detail, 'unknown parameter')
  }),
)

it.effect('rejects forged failure and requirement member-obligation branding', () =>
  Effect.gen(function* () {
    const owner = { module: 'surface/Obligations', name: 'effect' }
    const failureParameter = Type.parameter(owner, 0, 'Failure')
    const capabilityParameter = Type.parameter(owner, 1, 'Capability')
    const origin =
      SourceSpan.fromOffsets('surface/Obligations', 0, 1) ??
      unreachable('expected a valid source span')
    const failureMember = Type.failureMemberShape(failureParameter)
    const requirementMember = Type.requirementMemberShape(capabilityParameter, 'Exclusive', 'Audit')
    const failureRow = RowAlgebra.singleton(Type.failureRowPolicy(), failureMember, origin)
    const requirementRow = RowAlgebra.singleton(
      Type.requirementRowPolicy(),
      requirementMember,
      origin,
    )
    const encoded = ModuleSurface.encodeSemanticType(
      Type.effectWithRows(
        'i32',
        failureRow,
        { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
        'Take',
        requirementRow,
      ),
    )
    const failureKey = Type.failureRowPolicy().memberWellFormedKey(failureMember)
    const requirementKey = Type.requirementRowPolicy().memberWellFormedKey(requirementMember)

    for (const key of [failureKey, requirementKey]) {
      const forged = encoded.replace(
        `"key":${encodeJson(key)}`,
        `"key":${encodeJson(`forged:${key}`)}`,
      )
      assert.notStrictEqual(forged, encoded)
      const failure = yield* Effect.flip(ModuleSurface.decodeSemanticType(forged))
      assert.instanceOf(failure, ModuleSurface.ModuleSurfaceDecodeError)
      assert.strictEqual(failure.reason._tag, 'InvalidEncoding')
    }
  }),
)

it.effect('rejects parameter kinds and builtin operations forged into incompatible slots', () =>
  Effect.gen(function* () {
    const owner = { module: 'surface/InvalidSlots', name: 'decode' }
    const origin =
      SourceSpan.fromOffsets('surface/InvalidSlots', 0, 1) ??
      unreachable('expected a valid source span')
    const noFailures = RowAlgebra.concrete(Type.failureRowPolicy(), [])
    const noRequirements = RowAlgebra.concrete(Type.requirementRowPolicy(), [])
    const valueParameter = Type.parameter(owner, 0, 'Value')
    const requirementParameter = Type.parameter(owner, 2, 'Requirements', 'RequirementRow')
    const callable = Type.callable([], Type.unit, {
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
    })
    const effect = Type.effect(Type.unit, [], {
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
    })
    const invalidRequirementMember = Type.requirementMemberShape(
      requirementParameter,
      'Exclusive',
      'Audit',
    )
    const builtinIdentity = Type.callableIdentityArgument('surface.invalid-builtin', {
      _tag: 'Builtin',
      actor: 'i32',
      operation: 'Add',
      intrinsic: { actor: 'i32', name: 'add' },
    })
    const malformed: ReadonlyArray<readonly [string, string]> = [
      [
        'failure whole-row parameter',
        ModuleSurface.encodeSemanticType(
          Type.effectWithRows(
            Type.unit,
            RowAlgebra.parameter<Type.Nominal, Type.Parameter, Type.FailureMemberShape>(
              valueParameter,
            ),
            { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
            'Take',
            noRequirements,
          ),
        ),
      ],
      [
        'requirement whole-row parameter',
        ModuleSurface.encodeSemanticType(
          Type.effectWithRows(
            Type.unit,
            noFailures,
            { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
            'Take',
            RowAlgebra.parameter<Type.Requirement, Type.Parameter, Type.RequirementMemberShape>(
              valueParameter,
            ),
          ),
        ),
      ],
      [
        'requirement lifted-member parameter',
        ModuleSurface.encodeSemanticType(
          Type.effectWithRows(
            Type.unit,
            noFailures,
            { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
            'Take',
            RowAlgebra.singleton(Type.requirementRowPolicy(), invalidRequirementMember, origin),
          ),
        ),
      ],
      [
        'representation parameter argument',
        ModuleSurface.encodeSemanticType(
          Type.nominal('surface/InvalidSlots', 'Holder', [
            Type.representationParameterArgument(valueParameter),
          ]),
        ),
      ],
      [
        'representation parameter bound',
        ModuleSurface.encodeSemanticType(
          Type.nominal('surface/InvalidSlots', 'Holder', [
            Type.representationParameterArgument(
              Type.parameter(owner, 3, 'Mismatched', 'CallableRepresentation', effect),
            ),
          ]),
        ),
      ],
      [
        'exact representation identity',
        ModuleSurface.encodeSemanticType(
          Type.nominal('surface/InvalidSlots', 'Holder', [
            Type.exactRepresentationArgument(
              Type.effectIdentityArgument('surface.invalid-effect'),
              callable,
            ),
          ]),
        ),
      ],
      [
        'builtin operation',
        ModuleSurface.encodeSemanticType(
          Type.nominal('surface/InvalidSlots', 'Holder', [builtinIdentity]),
        ).replace('"operation":"Add"', '"operation":"DefinitelyNotAnOperation"'),
      ],
      ['negative fixed-array length', ModuleSurface.encodeSemanticType(Type.fixedArray('i32', -1))],
    ]

    for (const [context, encoded] of malformed) {
      const failure = yield* Effect.flip(ModuleSurface.decodeSemanticType(encoded))
      assert.instanceOf(failure, ModuleSurface.ModuleSurfaceDecodeError, context)
      assert.strictEqual(failure.operation, 'ModuleSurface.decodeSemanticType', context)
      assert.strictEqual(failure.reason._tag, 'InvalidEncoding', context)
    }

    assert.strictEqual(Type.isBuiltinOperation('Add'), true)
    assert.strictEqual(Type.isBuiltinOperation('EffectSuspend'), true)
    assert.strictEqual(Type.isBuiltinOperation('DefinitelyNotAnOperation'), false)
  }),
)

it.effect('rejects negative semantic ordinals in every serialized identity family', () =>
  Effect.gen(function* () {
    const owner = { module: 'surface/InvalidOrdinals', name: 'decode' }
    const callable = Type.callable([], Type.unit, {
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
    })
    const callableIdentity = (site: Type.CallableEnvironmentSite): Type.Type =>
      Type.nominal('surface/InvalidOrdinals', 'Holder', [
        Type.callableIdentityArgument(
          'surface.invalid-ordinal',
          {
            _tag: 'Declaration',
            module: 'surface/InvalidOrdinals',
            name: 'callable',
          },
          [],
          Type.callableEnvironmentIdentity(site, {
            declaration: owner,
            typeArguments: [],
            staticArgumentKeys: ['static:key'],
          }),
        ),
      ])
    const malformed: ReadonlyArray<readonly [string, Type.Type]> = [
      ['generic parameter', Type.parameter(owner, -1, 'Value')],
      [
        'declared callable environment site',
        callableIdentity(Type.callableEnvironmentSite(owner, 0, -1)),
      ],
      [
        'recovered callable environment function',
        callableIdentity(Type.callableEnvironmentSite(undefined, -1, 0)),
      ],
      [
        'recovered callable environment site',
        callableIdentity(Type.callableEnvironmentSite(undefined, 0, -1)),
      ],
      [
        'opaque representation binder',
        Type.nominal('surface/InvalidOrdinals', 'Holder', [
          Type.opaqueRepresentationArgument(
            {
              _tag: 'OpaqueFamilyKey',
              producer: owner,
              binderOrdinal: -1,
            },
            callable,
            [],
          ),
        ]),
      ],
    ]

    for (const [context, value] of malformed) {
      const failure = yield* Effect.flip(
        ModuleSurface.decodeSemanticType(ModuleSurface.encodeSemanticType(value)),
      )
      assert.instanceOf(failure, ModuleSurface.ModuleSurfaceDecodeError, context)
      assert.strictEqual(failure.operation, 'ModuleSurface.decodeSemanticType', context)
      assert.strictEqual(failure.reason._tag, 'InvalidEncoding', context)
    }
  }),
)

it.effect('round-trips callable and Effect representation slots with matching kinds', () =>
  Effect.gen(function* () {
    const owner = { module: 'surface/RepresentationSlots', name: 'decode' }
    const callable = Type.callable([], Type.unit, {
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
    })
    const effect = Type.effect(Type.unit, [], {
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
    })
    const values: ReadonlyArray<Type.Type> = [
      Type.nominal('surface/RepresentationSlots', 'OpenCallable', [
        Type.representationParameterArgument(
          Type.parameter(owner, 0, 'F', 'CallableRepresentation', callable),
        ),
      ]),
      Type.nominal('surface/RepresentationSlots', 'OpenEffect', [
        Type.representationParameterArgument(
          Type.parameter(owner, 1, 'E', 'EffectRepresentation', effect),
        ),
      ]),
      Type.nominal('surface/RepresentationSlots', 'ExactCallable', [
        Type.exactRepresentationArgument(
          Type.callableIdentityArgument('surface.callable', {
            _tag: 'Declaration',
            module: 'surface/RepresentationSlots',
            name: 'callable',
          }),
          callable,
        ),
      ]),
      Type.nominal('surface/RepresentationSlots', 'ExactEffect', [
        Type.exactRepresentationArgument(Type.effectIdentityArgument('surface.effect'), effect),
      ]),
    ]

    for (const value of values) {
      const decoded = yield* ModuleSurface.decodeSemanticType(
        ModuleSurface.encodeSemanticType(value),
      )
      assert.strictEqual(Type.key(decoded), Type.key(value))
    }
  }),
)

it.effect('canonicalizes finite collisions, union order, and reducible Without encodings', () =>
  Effect.gen(function* () {
    const nominal = (name: string) => ({
      tag: 'Nominal',
      module: 'surface/CanonicalRows',
      name,
      arguments: [],
    })
    const concrete = (members: ReadonlyArray<unknown>) => ({
      tag: 'Concrete',
      members,
    })
    const row = (expression: unknown) => ({ tag: 'Row', expression, obligations: [] })
    const effect = (failureRow: unknown, requirementRow: unknown) =>
      JSON.stringify({
        tag: 'Effect',
        environment: { tag: 'StaticLifetime' },
        lifetimeBinders: [],
        lifetimeBounds: [],
        typeOutlives: [],
        success: { tag: 'Atom', value: 'i32' },
        failureRow,
        requirementRow,
        access: 'Take',
      })
    const first = Type.nominal('surface/CanonicalRows', 'First')
    const second = Type.nominal('surface/CanonicalRows', 'Second')
    const clock = Type.nominal('surface/CanonicalRows', 'Clock')
    const logger = Type.nominal('surface/CanonicalRows', 'Logger')
    const noFailures = RowAlgebra.concrete(Type.failureRowPolicy(), [])
    const noRequirements = RowAlgebra.concrete(Type.requirementRowPolicy(), [])
    const encodedNoRequirements = row(concrete([]))

    const decodedUnion = yield* ModuleSurface.decodeSemanticType(
      effect(
        row({
          tag: 'Union',
          operands: [
            concrete([nominal('Second')]),
            {
              tag: 'Union',
              operands: [concrete([nominal('First')]), concrete([nominal('Second')]), concrete([])],
            },
          ],
        }),
        encodedNoRequirements,
      ),
    )
    const unionEffect = Type.isEffect(decodedUnion)
      ? decodedUnion
      : unreachable('expected a decoded Effect')
    assert.strictEqual(
      Type.key(unionEffect),
      Type.key(
        Type.effectWithRows(
          'i32',
          RowAlgebra.concrete(Type.failureRowPolicy(), [first, second]),
          { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
          'Take',
          noRequirements,
        ),
      ),
    )

    const decodedRequirements = yield* ModuleSurface.decodeSemanticType(
      effect(
        row(concrete([])),
        row(
          concrete([
            {
              tag: 'Requirement',
              capability: nominal('Logger'),
              role: 'DefaultRole',
              access: 'Exclusive',
            },
            {
              tag: 'Requirement',
              capability: nominal('Clock'),
              role: 'DefaultRole',
              access: 'Shared',
            },
            {
              tag: 'Requirement',
              capability: nominal('Clock'),
              role: 'DefaultRole',
              access: 'Exclusive',
            },
          ]),
        ),
      ),
    )
    const requirementEffect = Type.isEffect(decodedRequirements)
      ? decodedRequirements
      : unreachable('expected a decoded Effect')
    const expectedRequirements = RowAlgebra.concrete(Type.requirementRowPolicy(), [
      { capability: clock, role: 'DefaultRole', access: 'Exclusive' },
      { capability: logger, role: 'DefaultRole', access: 'Exclusive' },
    ])
    assert.strictEqual(
      Type.key(requirementEffect),
      Type.key(
        Type.effectWithRows(
          'i32',
          noFailures,
          { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
          'Take',
          expectedRequirements,
        ),
      ),
    )

    const decodedWithout = yield* ModuleSurface.decodeSemanticType(
      effect(
        row({
          tag: 'Without',
          source: concrete([nominal('Second'), nominal('First'), nominal('First')]),
          selected: concrete([nominal('First')]),
        }),
        encodedNoRequirements,
      ),
    )
    const withoutEffect = Type.isEffect(decodedWithout)
      ? decodedWithout
      : unreachable('expected a decoded Effect')
    assert.strictEqual(
      Type.key(withoutEffect),
      Type.key(
        Type.effectWithRows(
          'i32',
          RowAlgebra.concrete(Type.failureRowPolicy(), [second]),
          { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
          'Take',
          noRequirements,
        ),
      ),
    )
  }),
)

it.effect('round-trips distinct witness identities and provider matches', () =>
  Effect.gen(function* () {
    const declaration = {
      _tag: 'SourceWitness' as const,
      declaration: { module: 'surface/Provider', name: 'conditional' },
    }
    const first: Constraint.WitnessIdentity = {
      origin: declaration,
      typeArguments: ['i32'],
    }
    const second: Constraint.WitnessIdentity = {
      origin: declaration,
      typeArguments: ['bool'],
    }
    const intrinsic: Constraint.WitnessIdentity = {
      origin: { _tag: 'IntrinsicWitness', operation: 'surface/Provider.conditional' },
      typeArguments: ['i32'],
    }
    const decodedFirst = yield* ModuleSurface.decodeWitnessIdentity(
      ModuleSurface.encodeWitnessIdentity(first),
    )
    const decodedSecond = yield* ModuleSurface.decodeWitnessIdentity(
      ModuleSurface.encodeWitnessIdentity(second),
    )

    assert.strictEqual(Constraint.witnessKey(decodedFirst), Constraint.witnessKey(first))
    assert.strictEqual(Constraint.witnessKey(decodedSecond), Constraint.witnessKey(second))
    assert.notStrictEqual(Constraint.witnessKey(decodedFirst), Constraint.witnessKey(decodedSecond))
    const decodedIntrinsic = yield* ModuleSurface.decodeWitnessIdentity(
      ModuleSurface.encodeWitnessIdentity(intrinsic),
    )
    assert.strictEqual(Constraint.witnessKey(decodedIntrinsic), Constraint.witnessKey(intrinsic))
    assert.notStrictEqual(
      Constraint.witnessKey(decodedFirst),
      Constraint.witnessKey(decodedIntrinsic),
    )

    for (const match of [
      { _tag: 'Identity' as const },
      { _tag: 'Conformance' as const, witness: first },
    ]) {
      const decoded = yield* ModuleSurface.decodeProviderMatch(
        ModuleSurface.encodeProviderMatch(match),
      )
      assert.strictEqual(Constraint.providerMatchKey(decoded), Constraint.providerMatchKey(match))
    }
  }),
)

it.effect('rejects forged callable-schema brands and structural evidence', () =>
  Effect.gen(function* () {
    const owner = { module: 'surface/Forged', name: 'section' }
    const origin =
      SourceSpan.fromOffsets('surface/Forged', 0, 1) ??
      unreachable('expected a valid forged-evidence source span')
    const selectedParameter = Type.parameter(owner, 0, 'S')
    const sourceParameter = Type.parameter(owner, 1, 'R')
    const selected = RowAlgebra.singleton(
      Type.failureRowPolicy(),
      Type.failureMemberShape(selectedParameter),
      origin,
    )
    const source = RowAlgebra.singleton(
      Type.failureRowPolicy(),
      Type.failureMemberShape(sourceParameter),
      origin,
    )
    const wanted = Constraint.failureSubset(selected, source)
    const evidence = Constraint.assumed(wanted, new Map())
    const contract = CallableContract.make({
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
      functionKind: 'Function',
      binders: [selectedParameter, sourceParameter],
      parameters: [
        { type: 'i32', mode: 'Value' },
        { type: 'bool', mode: 'Value' },
      ],
      result: 'i32',
      constraints: [wanted],
    })
    const schema: Type.CallableSchema = {
      contract,
      binders: contract.binders,
      constraints: contract.constraints,
      evidence: [evidence],
      substitution: new Map(),
      contractKey: CallableContract.key(contract),
      constraintKeys: contract.constraints.map(Constraint.key),
      evidenceKeys: [Constraint.evidenceKey(evidence)],
      origins: [],
    }
    const callable = Type.callable(
      ['i32', 'bool'],
      'i32',
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Shared',
      schema,
    )
    const encoded = ModuleSurface.encodeSemanticType(callable)
    const forgeries = [
      encoded.replace(
        `"contractKey":${encodeJson(callable.schema?.contractKey)}`,
        '"contractKey":"forged-contract"',
      ),
      encoded.replace(
        `"constraintKeys":${encodeJson(callable.schema?.constraintKeys)}`,
        '"constraintKeys":["forged-constraint"]',
      ),
      encoded.replace(
        `"evidenceKeys":${encodeJson(callable.schema?.evidenceKeys)}`,
        '"evidenceKeys":["forged-evidence"]',
      ),
      encoded.replace(
        '"result":{"tag":"Atom","value":"i32"}',
        '"result":{"tag":"Atom","value":"bool"}',
      ),
      encoded.replace(
        '"parameters":[{"tag":"Atom","value":"i32"},{"tag":"Atom","value":"bool"}]',
        '"parameters":[{"tag":"Atom","value":"bool"}]',
      ),
    ]
    for (const forged of forgeries) {
      assert.notStrictEqual(forged, encoded)
      const failure = yield* Effect.flip(ModuleSurface.decodeSemanticType(forged))
      assert.instanceOf(failure, ModuleSurface.ModuleSurfaceDecodeError)
      assert.strictEqual(failure.reason._tag, 'InvalidEncoding')
    }
    const partial = Type.callable(
      ['i32'],
      'i32',
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Take',
      schema,
    )
    const decodedPartial = yield* ModuleSurface.decodeSemanticType(
      ModuleSurface.encodeSemanticType(partial),
    )
    assert.strictEqual(Type.key(decodedPartial), Type.key(partial))

    const selectedFailure = Type.nominal('surface/Forged', 'SelectedFailure')
    const otherFailure = Type.nominal('surface/Forged', 'OtherFailure')
    const selectedFailures = RowAlgebra.concrete(Type.failureRowPolicy(), [selectedFailure])
    const otherFailures = RowAlgebra.concrete(Type.failureRowPolicy(), [otherFailure])
    const capability = Type.nominal('surface/Forged', 'Capability')
    const requirement: Type.Requirement = {
      capability,
      role: 'DefaultRole',
      access: 'Exclusive',
    }
    const selectedRequirements = RowAlgebra.concrete(Type.requirementRowPolicy(), [requirement])
    const noRequirements = RowAlgebra.concrete(Type.requirementRowPolicy(), [])
    const validEvidence: ReadonlyArray<Constraint.ConstraintEvidence> = [
      { _tag: 'Member', selected: selectedFailure, source: selectedFailures },
      {
        _tag: 'FailureSubset',
        selected: selectedFailures,
        source: RowAlgebra.concrete(Type.failureRowPolicy(), [selectedFailure, otherFailure]),
      },
      {
        _tag: 'RequirementSubset',
        selected: selectedRequirements,
        source: selectedRequirements,
      },
    ]
    for (const proof of validEvidence) {
      const decoded = yield* ModuleSurface.decodeConstraintEvidence(
        ModuleSurface.encodeConstraintEvidence(proof),
      )
      assert.strictEqual(Constraint.evidenceKey(decoded), Constraint.evidenceKey(proof))
    }
    const falseEvidence: ReadonlyArray<Constraint.ConstraintEvidence> = [
      { _tag: 'Member', selected: selectedFailure, source: otherFailures },
      { _tag: 'FailureSubset', selected: selectedFailures, source: otherFailures },
      { _tag: 'RequirementSubset', selected: selectedRequirements, source: noRequirements },
    ]
    for (const forged of falseEvidence) {
      const failure = yield* Effect.flip(
        ModuleSurface.decodeConstraintEvidence(ModuleSurface.encodeConstraintEvidence(forged)),
      )
      assert.instanceOf(failure, ModuleSurface.ModuleSurfaceDecodeError)
      assert.strictEqual(failure.reason._tag, 'InvalidEncoding')
    }

    const provider = Type.nominal('surface/Forged', 'Provider')
    const unavailableInner = Type.nominal('surface/Forged', 'Inner', [
      Type.unavailableGenericArgument('Value', 'unresolved nested surface argument'),
    ])
    const unavailableProvider = Type.nominal('surface/Forged', 'Provider', [unavailableInner])
    const unavailableCapability = Type.nominal('surface/Forged', 'UnavailableCapability', [
      unavailableInner,
    ])
    const otherCapability = Type.nominal('surface/Forged', 'OtherCapability')
    const otherRequirement: Type.Requirement = {
      capability: otherCapability,
      role: 'DefaultRole',
      access: 'Exclusive',
    }
    const otherRequirements = RowAlgebra.concrete(Type.requirementRowPolicy(), [otherRequirement])
    const providerMatch: Constraint.ProviderMatch = {
      _tag: 'Conformance',
      witness: {
        origin: {
          _tag: 'SourceWitness',
          declaration: { module: 'surface/Forged', name: 'providerConformance' },
        },
        typeArguments: [],
      },
    }
    const unavailableWitness: Constraint.WitnessIdentity = {
      origin: {
        _tag: 'SourceWitness',
        declaration: { module: 'surface/Forged', name: 'unavailableConformance' },
      },
      typeArguments: [unavailableInner],
    }
    const witnessFailure = yield* Effect.flip(
      ModuleSurface.decodeWitnessIdentity(ModuleSurface.encodeWitnessIdentity(unavailableWitness)),
    )
    assert.instanceOf(witnessFailure, ModuleSurface.ModuleSurfaceDecodeError)
    assert.strictEqual(witnessFailure.reason._tag, 'InvalidEncoding')
    const selectedWanted = Constraint.providerSelection(
      'Exclusive',
      provider,
      selectedRequirements,
      selectedRequirements,
    )
    const sharedWanted = Constraint.providerSelection(
      'Shared',
      capability,
      selectedRequirements,
      selectedRequirements,
    )
    const missingSourceWanted = Constraint.providerSelection(
      'Exclusive',
      provider,
      selectedRequirements,
      noRequirements,
    )
    const multipleSelectedWanted = Constraint.providerSelection(
      'Exclusive',
      provider,
      RowAlgebra.union(Type.requirementRowPolicy(), selectedRequirements, otherRequirements),
      RowAlgebra.union(Type.requirementRowPolicy(), selectedRequirements, otherRequirements),
    )
    const unavailableRequirement: Type.Requirement = {
      capability: unavailableCapability,
      role: 'DefaultRole',
      access: 'Exclusive',
    }
    const unavailableRequirements = RowAlgebra.concrete(Type.requirementRowPolicy(), [
      unavailableRequirement,
    ])
    const sourceWithUnavailable = RowAlgebra.union(
      Type.requirementRowPolicy(),
      selectedRequirements,
      unavailableRequirements,
    )
    const forgedSelections: ReadonlyArray<Constraint.ConstraintEvidence> = [
      Constraint.requirementSelectionEvidence(selectedWanted, otherRequirement, providerMatch),
      Constraint.requirementSelectionEvidence(selectedWanted, requirement, { _tag: 'Identity' }),
      Constraint.requirementSelectionEvidence(
        Constraint.providerSelection(
          'Exclusive',
          capability,
          selectedRequirements,
          selectedRequirements,
        ),
        requirement,
        providerMatch,
      ),
      Constraint.requirementSelectionEvidence(sharedWanted, requirement, { _tag: 'Identity' }),
      Constraint.requirementSelectionEvidence(missingSourceWanted, requirement, providerMatch),
      Constraint.requirementSelectionEvidence(multipleSelectedWanted, requirement, providerMatch),
      Constraint.requirementSelectionEvidence(
        Constraint.providerSelection(
          'Exclusive',
          unavailableProvider,
          selectedRequirements,
          selectedRequirements,
        ),
        requirement,
        providerMatch,
      ),
      Constraint.requirementSelectionEvidence(
        Constraint.providerSelection(
          'Exclusive',
          provider,
          selectedRequirements,
          sourceWithUnavailable,
        ),
        requirement,
        providerMatch,
      ),
      Constraint.requirementSelectionEvidence(selectedWanted, requirement, {
        _tag: 'Conformance',
        witness: unavailableWitness,
      }),
    ]
    for (const forged of forgedSelections) {
      const failure = yield* Effect.flip(
        ModuleSurface.decodeConstraintEvidence(ModuleSurface.encodeConstraintEvidence(forged)),
      )
      assert.instanceOf(failure, ModuleSurface.ModuleSurfaceDecodeError)
      assert.strictEqual(failure.reason._tag, 'InvalidEncoding')
    }
  }),
)

it.effect('rejects malformed semantic encodings through the typed boundary', () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<
      readonly [
        ModuleSurface.DecodeOperation,
        Effect.Effect<unknown, ModuleSurface.ModuleSurfaceDecodeError>,
      ]
    > = [
      ['ModuleSurface.decodeSemanticType', ModuleSurface.decodeSemanticType('{')],
      ['ModuleSurface.decodeConstraint', ModuleSurface.decodeConstraint('{')],
      ['ModuleSurface.decodeConstraintEvidence', ModuleSurface.decodeConstraintEvidence('{')],
      ['ModuleSurface.decodeWitnessIdentity', ModuleSurface.decodeWitnessIdentity('{')],
      ['ModuleSurface.decodeProviderMatch', ModuleSurface.decodeProviderMatch('{')],
    ]

    for (const [operation, decoding] of cases) {
      const result = yield* Effect.result(decoding)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, ModuleSurface.ModuleSurfaceDecodeError)
        assert.strictEqual(result.failure.operation, operation)
        assert.strictEqual(result.failure.reason._tag, 'InvalidEncoding')
      }
    }

    const structuredFailure = yield* Effect.flip(
      ModuleSurface.decodeSemanticType('{"tag":"UnknownType"}'),
    )
    assert.instanceOf(structuredFailure, ModuleSurface.ModuleSurfaceDecodeError)
    assert.strictEqual(structuredFailure.operation, 'ModuleSurface.decodeSemanticType')
    assert.strictEqual(structuredFailure.reason._tag, 'InvalidEncoding')
  }),
)

it.effect(
  'encodes inherent members and heads so contract edits invalidate and body edits do not',
  () =>
    Effect.gen(function* () {
      const declare = (result: string, body: string) =>
        `pub struct Counter { value: i32 }
impl Counter {
  pub fn read(self: &Self) -> ${result} { return ${body} }
}`
      const base = yield* surface(declare('i32', 'self.value'))
      const body = yield* surface(declare('i32', 'self.value + 0'))
      const contract = yield* surface(declare('i64', '0'))
      const secondBlock = yield* surface(
        `${declare('i32', 'self.value')}
impl Counter { pub fn zero() -> Self { return Counter { value: 0 } } }`,
      )
      assert.strictEqual(ModuleSurface.equals(base, body), true)
      assert.strictEqual(ModuleSurface.equals(base, contract), false)
      assert.strictEqual(ModuleSurface.equals(base, secondBlock), false)
      assert.include(base.canonical, 'AssociatedMember')
      assert.include(base.canonical, 'InherentImpl')
    }),
)

it.effect('round-trips raw pointer types and keys public pointer signatures by mutability', () =>
  Effect.gen(function* () {
    const pointer = Type.pointer({
      mutable: true,
      pointee: Type.pointer({
        mutable: false,
        pointee: Type.nominal('surface/Main', 'Opaque'),
        nullable: true,
        extent: 'Single',
        alignment: 1,
        addressSpace: 0,
      }),
      nullable: true,
      extent: 'Many',
      alignment: 'Natural',
      addressSpace: 0,
    })
    const decoded = yield* ModuleSurface.decodeSemanticType(
      ModuleSurface.encodeSemanticType(pointer),
    )
    assert.strictEqual(Type.key(decoded), Type.key(pointer))
    assert.strictEqual(Type.encode(decoded), '?[*]mut ?*const align(1) surface/Main.Opaque')

    const mutable = yield* surface(
      'pub struct Opaque {}\npub fn take(handle: *mut Opaque) -> *mut Opaque { return handle }',
    )
    const repeated = yield* surface(
      'pub struct Opaque {}\npub fn take(handle: *mut Opaque) -> *mut Opaque { return handle }',
    )
    const constant = yield* surface(
      'pub struct Opaque {}\npub fn take(handle: *const Opaque) -> *const Opaque { return handle }',
    )
    assert.strictEqual(ModuleSurface.equals(mutable, repeated), true)
    assert.strictEqual(ModuleSurface.equals(mutable, constant), false)
    assert.include(mutable.canonical, 'pointer:Single:mut:nonnull:Natural:0<')
    assert.include(constant.canonical, 'pointer:Single:const:nonnull:Natural:0<')
  }),
)

it.effect('round-trips C function pointers and data-symbol declarations in module surfaces', () =>
  Effect.gen(function* () {
    const callback = Type.foreignFunction(
      [
        Type.pointer({
          mutable: false,
          pointee: 'i32',
          nullable: false,
          extent: 'Single',
          alignment: 'Natural',
          addressSpace: 0,
        }),
      ],
      'i32',
    )
    const decoded = yield* ModuleSurface.decodeSemanticType(
      ModuleSurface.encodeSemanticType(callback),
    )
    assert.strictEqual(Type.key(decoded), Type.key(callback))
    assert.strictEqual(Type.encode(decoded), 'extern "C" fn(*const i32) -> i32')

    const original = yield* surface(`unsafe extern "C" static environment: *mut *mut u8 as "environ"
export "C" static silk_abi_version: u32 = 1`)
    const changed = yield* surface(`unsafe extern "C" static environment: *mut *mut u8 as "environ"
export "C" static silk_abi_version: u32 = 2`)
    assert.include(original.canonical, 'ForeignStaticDeclaration')
    assert.include(original.canonical, 'environ')
    assert.include(original.canonical, 'silk_abi_version')
    assert.strictEqual(ModuleSurface.equals(original, changed), false)
  }),
)

it.effect('round-trips closed invocation-use contracts and refuses malformed designations', () =>
  Effect.gen(function* () {
    const owner = { module: 'surface/Invocation', name: 'callback' }
    const data = Lifetime.bound(owner, 0, 'data')
    const use = Lifetime.bound(owner, 1, 'call')
    const inputs: ReadonlyArray<Type.Type> = ['i32', Type.reference('Shared', 'i32', data)]
    const lifetimes: Type.ExecutableLifetimes = {
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [data, use],
      invocationUse: { lifetime: use, parameters: [0, 1] },
    }
    const contract = CallableContract.make({
      ...lifetimes,
      functionKind: 'Function',
      parameters: inputs.map((type): CallableContract.Parameter => ({ type, mode: 'Value' })),
      result: 'i32',
    })
    const schema: Type.CallableSchema = {
      source: owner,
      contract,
      binders: [],
      constraints: [],
      evidence: [],
      substitution: new Map(),
      contractKey: CallableContract.key(contract),
      constraintKeys: [],
      evidenceKeys: [],
      origins: [],
    }
    const callable = Type.callable(inputs, 'i32', lifetimes, 'Shared', schema)
    const encoded = ModuleSurface.encodeSemanticType(callable)
    const decoded = yield* ModuleSurface.decodeSemanticType(encoded)
    assert.isTrue(Type.isCallable(decoded))
    if (!Type.isCallable(decoded)) return assert.fail('expected decoded callable')
    assert.deepStrictEqual(decoded.invocationUse, { lifetime: use, parameters: [0, 1] })
    assert.strictEqual(Type.key(decoded), Type.key(callable))
    assert.deepStrictEqual(decoded.schema?.contract.invocationUse, {
      lifetime: use,
      parameters: [0, 1],
    })
    assert.strictEqual(ModuleSurface.encodeSemanticType(decoded), encoded)
    const record = decodeJson(encoded)
    const usage = recordField(record, 'invocationUse')
    const serializedUse = recordField(usage, 'lifetime')
    const otherOwner = replaceRecordField(serializedUse, 'owner', {
      module: owner.module,
      name: 'foreign-callback',
    })
    for (const malformed of [
      replaceRecordField(usage, 'parameters', [0]),
      replaceRecordField(usage, 'parameters', [0, 0]),
      replaceRecordField(usage, 'parameters', [1, 0]),
      replaceRecordField(usage, 'lifetime', { tag: 'StaticLifetime' }),
      replaceRecordField(usage, 'lifetime', otherOwner),
    ]) {
      const failure = yield* Effect.flip(
        ModuleSurface.decodeSemanticType(
          encodeJson(replaceRecordField(record, 'invocationUse', malformed)),
        ),
      )
      assert.instanceOf(failure, ModuleSurface.ModuleSurfaceDecodeError)
      assert.strictEqual(failure.reason._tag, 'InvalidEncoding')
    }
    const placeholder = Lifetime.placeholder(use, 'private-call')
    const opened = Type.callable(
      ['i32'],
      'i32',
      {
        environment: Lifetime.staticLifetime,
        lifetimeBinders: [],
        invocationUse: { lifetime: placeholder, parameters: [0] },
      },
      'Shared',
      undefined,
      false,
      'Opened',
    )
    assert.throws(() => ModuleSurface.encodeSemanticType(opened))
    const foreign = decodeJson(
      ModuleSurface.encodeSemanticType(Type.foreignFunction(['i32'], 'i32')),
    )
    const foreignForged = { ...serializedRecordForInvocation(foreign), invocationUse: usage }
    const effect = decodeJson(
      ModuleSurface.encodeSemanticType(
        Type.effect('i32', [], {
          environment: Lifetime.staticLifetime,
          lifetimeBinders: [],
        }),
      ),
    )
    const effectForged = { ...serializedRecordForInvocation(effect), invocationUse: usage }
    for (const nonCallable of [foreignForged, effectForged]) {
      const failure = yield* Effect.flip(ModuleSurface.decodeSemanticType(encodeJson(nonCallable)))
      assert.instanceOf(failure, ModuleSurface.ModuleSurfaceDecodeError)
      assert.strictEqual(failure.reason._tag, 'InvalidEncoding')
    }
  }),
)

const serializedRecordForInvocation = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return unreachable('expected an encoded executable record')
  return Object.fromEntries(Object.entries(value))
}

it.effect('authenticates invocation adapters against original target lifetime slots', () =>
  Effect.gen(function* () {
    const target = { module: 'surface/Invocation', name: 'completed' }
    const success = Type.parameter(target, 0, 'A')
    const failure = Type.parameter(target, 1, 'E')
    const environment = Type.parameter(target, 2, 'env', 'Lifetime')
    const originalRegion = Lifetime.bound(target, 2, 'env')
    const use = Lifetime.bound({ module: 'surface/Caller', name: 'recover' }, 0, 'call')
    const capture = Lifetime.bound({ module: 'surface/Caller', name: 'capture' }, 0, 'env')
    const selectedRegion = Lifetime.intersection([use, capture])
    const contract = CallableContract.make({
      functionKind: 'Function',
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
      binders: [success, failure, environment],
      parameters: [
        { type: failure, mode: 'Value' },
        { type: success, mode: 'Value' },
        { type: 'u8', mode: 'Value' },
      ],
      captures: [{ parameter: 2, capture: 0 }],
      result: Type.effect(
        success,
        [failure],
        { environment: originalRegion, lifetimeBinders: [] },
        'Take',
      ),
    })
    const schema: Type.CallableSchema = {
      source: target,
      contract,
      binders: contract.binders,
      constraints: [],
      evidence: [],
      origins: [],
      constraintKeys: [],
      evidenceKeys: [],
      contractKey: CallableContract.key(contract),
      substitution: new Map<string, Type.GenericArgument>([
        [Type.key(success), 'i32'],
        [Type.key(failure), 'bool'],
        [Type.key(environment), selectedRegion],
      ]),
      invocationAdapter: {
        binder: use,
        originalInputs: [0, 1],
        parameters: [0],
        lifetimes: [{ parameter: environment, lifetime: selectedRegion }],
      },
    }
    const adapted = Type.callable(
      ['bool'],
      Type.effect(
        'i32',
        ['bool'],
        {
          environment: selectedRegion,
          lifetimeBinders: [],
        },
        'Take',
      ),
      {
        environment: capture,
        lifetimeBinders: [use],
        invocationUse: { lifetime: use, parameters: [0] },
      },
      'Shared',
      schema,
    )
    const encoded = ModuleSurface.encodeSemanticType(adapted)
    const decoded = yield* ModuleSurface.decodeSemanticType(encoded)
    assert.strictEqual(Type.key(decoded), Type.key(adapted))
    if (!Type.isCallable(decoded)) return assert.fail('expected an adapter')
    const decodedSchema = decoded.schema ?? unreachable('expected original schema')
    assert.strictEqual(decodedSchema.contract.invocationUse, undefined)
    assert.strictEqual(CallableContract.key(decodedSchema.contract), CallableContract.key(contract))
    assert.deepStrictEqual(decodedSchema.invocationAdapter, schema.invocationAdapter)
    assert.deepStrictEqual(Type.callableInputOrdinals(decodedSchema.contract), [0, 1])
    assert.deepStrictEqual(decodedSchema.invocationAdapter?.originalInputs, [0, 1])
    assert.deepStrictEqual(decodedSchema.invocationAdapter?.parameters, [0])
    const record = decodeJson(encoded)
    const encodedSchema = recordField(record, 'schema')
    const recipe = recordField(encodedSchema, 'invocationAdapter')
    const slots = recordField(recipe, 'lifetimes')
    if (!Array.isArray(slots)) return assert.fail('expected encoded lifetime slots')
    const slot = slots.at(0) ?? unreachable('expected env2 slot')
    const parameter = recordField(slot, 'parameter')
    for (const malformed of [
      replaceRecordField(recipe, 'parameters', [1]),
      replaceRecordField(recipe, 'parameters', [2]),
      replaceRecordField(recipe, 'originalInputs', [0]),
      replaceRecordField(recipe, 'originalInputs', [0, 0]),
      replaceRecordField(recipe, 'originalInputs', [0, 1, 2]),
      replaceRecordField(recipe, 'originalInputs', [1, 0]),
      replaceRecordField(recipe, 'originalInputs', undefined),
      replaceRecordField(recipe, 'lifetimes', []),
      replaceRecordField(recipe, 'lifetimes', [
        replaceRecordField(slot, 'parameter', replaceRecordField(parameter, 'ordinal', 1)),
      ]),
      replaceRecordField(recipe, 'lifetimes', [
        replaceRecordField(slot, 'lifetime', { tag: 'StaticLifetime' }),
      ]),
    ]) {
      const forged = encodeJson(
        replaceRecordField(
          record,
          'schema',
          replaceRecordField(encodedSchema, 'invocationAdapter', malformed),
        ),
      )
      const error = yield* Effect.flip(ModuleSurface.decodeSemanticType(forged))
      assert.instanceOf(error, ModuleSurface.ModuleSurfaceDecodeError)
      assert.strictEqual(error.reason._tag, 'InvalidEncoding')
    }
    const markedContract = CallableContract.make({
      functionKind: 'Function',
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [use],
      invocationUse: { lifetime: use, parameters: [0] },
      parameters: [
        { type: 'i32', mode: 'Value' },
        { type: 'u8', mode: 'Value' },
      ],
      captures: [{ parameter: 1, capture: 0 }],
      result: 'i32',
    })
    const markedSchema: Type.CallableSchema = {
      contract: markedContract,
      binders: [],
      constraints: [],
      evidence: [],
      origins: [],
      constraintKeys: [],
      evidenceKeys: [],
      substitution: new Map(),
      contractKey: CallableContract.key(markedContract),
      invocationAdapter: { binder: use, originalInputs: [0], parameters: [0], lifetimes: [] },
    }
    const marked = Type.callable(
      ['i32'],
      'i32',
      {
        environment: Lifetime.staticLifetime,
        lifetimeBinders: [use],
        invocationUse: { lifetime: use, parameters: [0] },
      },
      'Shared',
      markedSchema,
    )
    const encodedMarked = ModuleSurface.encodeSemanticType(marked)
    const decodedMarked = yield* ModuleSurface.decodeSemanticType(encodedMarked)
    assert.strictEqual(Type.key(decodedMarked), Type.key(marked))
    const markedRecord = decodeJson(encodedMarked)
    const markedSchemaRecord = recordField(markedRecord, 'schema')
    const markedContractRecord = recordField(markedSchemaRecord, 'contract')
    const forgedCapture = encodeJson(
      replaceRecordField(
        markedRecord,
        'schema',
        replaceRecordField(
          markedSchemaRecord,
          'contract',
          replaceRecordField(markedContractRecord, 'captures', [
            { tag: 'CaptureRelationship', parameter: 0, capture: 0 },
          ]),
        ),
      ),
    )
    const captureFailure = yield* Effect.flip(ModuleSurface.decodeSemanticType(forgedCapture))
    assert.strictEqual(captureFailure.reason._tag, 'InvalidEncoding')
    const removed = encodeJson(
      replaceRecordField(
        record,
        'schema',
        replaceRecordField(encodedSchema, 'invocationAdapter', undefined),
      ),
    )
    const missingRecipe = yield* Effect.flip(ModuleSurface.decodeSemanticType(removed))
    assert.strictEqual(missingRecipe.reason._tag, 'InvalidEncoding')
  }),
)
