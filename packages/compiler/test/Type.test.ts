import { records } from './support/records.js'
import { locationAt } from './support/location.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Diagnostic from '../src/Diagnostic.js'
import * as NominalVariance from '../src/NominalVariance.js'
import * as CallableContract from '../src/CallableContract.js'
import * as Constraint from '../src/Constraint.js'
import * as FiniteRow from '../src/FiniteRow.js'
import * as EffectExecutionContract from '../src/internal/EffectExecutionContract.js'
import * as TypeInference from '../src/internal/TypeInference.js'
import * as Lifetime from '../src/Lifetime.js'
import * as LifetimeFlow from '../src/LifetimeFlow.js'
import * as RequirementRow from '../src/RequirementRow.js'
import * as RowAlgebra from '../src/RowAlgebra.js'
import * as SourceSpan from '../src/SourceSpan.js'
import * as Type from '../src/Type.js'
import * as TypeCompatibility from '../src/TypeCompatibility.js'
import * as TypeOutlives from '../src/TypeOutlives.js'
import { unreachable } from './support/raise.js'

const detached: Type.ExecutableLifetimes = Object.freeze({
  environment: Lifetime.staticLifetime,
  lifetimeBinders: [],
})
const staticText = Type.string(Lifetime.staticLifetime)

it('keys Effect execution by exact channels while erasing only outer lifetime proofs', () => {
  const owner = { module: 'effect-execution', name: 'runner' }
  const source = Lifetime.bound(owner, 0, 'source')
  const contextual = Lifetime.bound({ ...owner, name: 'caller' }, 0, 'contextual')
  const failure = Type.nominal('effect-execution', 'Failure')
  const otherFailure = Type.nominal('effect-execution', 'OtherFailure')
  const capability = Type.nominal('effect-execution', 'Capability')
  const otherCapability = Type.nominal('effect-execution', 'OtherCapability')
  const requirement: Type.Requirement = Object.freeze({
    capability,
    role: 'DefaultRole',
    access: 'Exclusive',
  })
  const physical = Type.effect(
    'i32',
    [failure],
    { environment: source, lifetimeBinders: [source] },
    'Take',
    [requirement],
  )
  const proofVariant = Type.effect(
    'i32',
    [failure],
    { environment: contextual, lifetimeBinders: [] },
    'Exclusive',
    [requirement],
  )
  const differentSuccess = Type.effect('u32', [failure], detached, 'Take', [requirement])
  const differentFailure = Type.effect('i32', [otherFailure], detached, 'Take', [requirement])
  const differentRequirement = Type.effect('i32', [failure], detached, 'Take', [
    { ...requirement, capability: otherCapability },
  ])
  const provided = Type.effect('i32', [failure], detached, 'Take')

  assert.strictEqual(
    EffectExecutionContract.key(physical),
    EffectExecutionContract.key(proofVariant),
  )
  assert.isTrue(EffectExecutionContract.equals(physical, proofVariant))
  assert.isFalse(EffectExecutionContract.equals(physical, differentSuccess))
  assert.isFalse(EffectExecutionContract.equals(physical, differentFailure))
  assert.isFalse(EffectExecutionContract.equals(physical, differentRequirement))
  assert.isTrue(
    EffectExecutionContract.providerSubtractionMatches(physical, provided, [
      { capability, role: 'DefaultRole', requirementAccess: 'Exclusive' },
    ]),
  )
  assert.isFalse(
    EffectExecutionContract.providerSubtractionMatches(physical, provided, [
      { capability, role: 'DefaultRole', requirementAccess: 'Shared' },
    ]),
  )
})

it('keeps requirement rows out of stored generic lifetime obligations', () => {
  const owner = { module: 'storage-parameters', name: 'Context' }
  const value = Type.parameter(owner, 0, 'T')
  const requirements = Type.parameter(owner, 1, 'R', 'RequirementRow')
  const context = Type.nominal(owner.module, owner.name, [
    value,
    Type.requirementRowArgument([], [requirements]),
  ])
  assert.deepEqual(Type.storageParameters(context), [value])
})

it('reuses the runtime identity of an immutable type across nested layout queries', () => {
  let argumentReads = 0
  const arguments_ = ['i32'] as const
  const nominal: Type.Nominal = {
    _tag: 'NominalType',
    module: 'runtime-key',
    name: 'Box',
    get arguments() {
      argumentReads += 1
      return arguments_
    },
  }
  const first = Type.runtimeKey(nominal)
  const readsAfterFirst = argumentReads
  assert.isAbove(readsAfterFirst, 0)
  assert.strictEqual(Type.runtimeKey(nominal), first)
  assert.strictEqual(
    Type.runtimeKey(Type.fixedArray(nominal, 2)),
    Type.runtimeKey(Type.fixedArray(Type.nominal('runtime-key', 'Box', arguments_), 2)),
  )
  assert.strictEqual(argumentReads, readsAfterFirst)
})

const span = (sourceId: string, start: number, end: number): SourceSpan.SourceSpan =>
  SourceSpan.fromOffsets(sourceId, start, end) ?? unreachable('expected a valid source span')

it('canonicalizes lifetime binders without erasing declaration, scope or assumptions', () => {
  const owner = { module: 'lifetimes', name: 'choose' }
  const long = Lifetime.bound(owner, 0, 'long')
  const short = Lifetime.bound(owner, 1, 'short')
  const use = Lifetime.bound(owner, 2, 'use')
  assert.strictEqual(Lifetime.key(long), Lifetime.key(Lifetime.bound(owner, 0, 'renamed')))
  assert.notStrictEqual(Lifetime.key(long), Lifetime.key(Lifetime.bound(owner, 0, 'long', [0])))
  assert.notStrictEqual(
    Lifetime.key(long),
    Lifetime.key(Lifetime.bound({ ...owner, name: 'other' }, 0, 'long')),
  )
  const bounds = Lifetime.assumptions([
    { longer: long, shorter: short },
    { longer: short, shorter: use },
  ])
  assert.isTrue(Lifetime.outlives(bounds, long, use))
  assert.isFalse(Lifetime.outlives(bounds, use, long))
  assert.isFalse(Lifetime.outlives(Lifetime.assumptions([]), long, use))
  assert.isTrue(Lifetime.outlives(bounds, Lifetime.staticLifetime, long))
  assert.isFalse(Lifetime.outlives(bounds, long, Lifetime.staticLifetime))
  assert.notStrictEqual(
    Lifetime.key(Lifetime.placeholder(long, 'first invocation')),
    Lifetime.key(Lifetime.placeholder(long, 'second invocation')),
  )
})

it('reuses lifetime proof keys across repeated comparisons and enclosing intersections', () => {
  let ownerReads = 0
  const owner = Object.freeze({ module: 'lifetimes', name: 'cached' })
  const lifetime: Lifetime.Local = {
    _tag: 'LocalLifetime',
    get owner() {
      ownerReads += 1
      return owner
    },
    context: 'Borrow:0',
    ordinal: 0,
  }
  const first = Lifetime.key(lifetime)
  const readsAfterFirst = ownerReads
  assert.isAbove(readsAfterFirst, 0)
  assert.strictEqual(Lifetime.key(lifetime), first)
  assert.isTrue(Lifetime.equals(lifetime, Lifetime.local(owner, 'Borrow:0', 0)))
  const other = Lifetime.bound(owner, 0, 'other')
  const meet = Lifetime.intersection([lifetime, other])
  assert.isTrue(Lifetime.outlives(Lifetime.assumptions([]), lifetime, meet))
  assert.strictEqual(ownerReads, readsAfterFirst)
})

it('reuses outlives proofs only within the same immutable assumptions', () => {
  const owner = { module: 'lifetimes', name: 'proofs' }
  const a = Lifetime.bound(owner, 0, 'a')
  const b = Lifetime.bound(owner, 1, 'b')
  const c = Lifetime.bound(owner, 2, 'c')
  const assumptions = Lifetime.assumptions([
    { longer: a, shorter: b },
    { longer: b, shorter: c },
  ])
  let reads = 0
  const observed: Lifetime.Assumptions = Object.freeze({
    key: assumptions.key,
    get bounds() {
      reads += 1
      return assumptions.bounds
    },
  })
  assert.isTrue(Lifetime.outlives(observed, a, c))
  assert.isFalse(Lifetime.outlives(observed, c, a))
  const initialReads = reads
  assert.isAbove(initialReads, 0)
  assert.isTrue(Lifetime.outlives(observed, Lifetime.bound(owner, 0, 'renamed'), c))
  assert.isFalse(Lifetime.outlives(observed, c, a))
  assert.isTrue(Lifetime.outlives(observed, b, c))
  assert.isFalse(Lifetime.outlives(observed, b, a))
  assert.strictEqual(reads, initialReads)
  assert.isFalse(Lifetime.outlives(Lifetime.assumptions([]), a, c))
  assert.isTrue(Lifetime.outlives(Lifetime.assumptions([{ longer: c, shorter: a }]), c, a))
})

it('canonicalizes finite environment intersections without promoting their validity', () => {
  const owner = { module: 'lifetimes', name: 'intersection' }
  const a = Lifetime.bound(owner, 0, 'a')
  const b = Lifetime.bound(owner, 1, 'b')
  const c = Lifetime.bound(owner, 2, 'c')
  const meet = Lifetime.intersection([a, b])
  assert.strictEqual(
    Lifetime.key(meet),
    Lifetime.key(
      Lifetime.intersection([b, Lifetime.intersection([a, b]), Lifetime.staticLifetime]),
    ),
  )
  assert.strictEqual(Lifetime.key(Lifetime.intersection([a, a])), Lifetime.key(a))
  const empty = Lifetime.assumptions([])
  assert.isTrue(Lifetime.outlives(empty, a, meet))
  assert.isTrue(Lifetime.outlives(empty, b, meet))
  assert.isFalse(Lifetime.outlives(empty, meet, a))
  assert.isFalse(Lifetime.outlives(empty, meet, b))
  assert.isFalse(Lifetime.outlives(empty, meet, c))
  assert.isTrue(
    Lifetime.outlives(
      Lifetime.assumptions([
        { longer: a, shorter: c },
        { longer: b, shorter: c },
      ]),
      meet,
      c,
    ),
  )
  assert.isFalse(Lifetime.outlives(Lifetime.assumptions([{ longer: a, shorter: c }]), meet, c))
  assert.isTrue(
    Lifetime.outlives(
      Lifetime.assumptions([{ longer: a, shorter: Lifetime.staticLifetime }]),
      meet,
      b,
    ),
  )
  const opened = Lifetime.placeholder(a, 'intersection invocation')
  assert.strictEqual(
    Lifetime.key(Lifetime.substitute(meet, new Map([[Lifetime.key(a), opened]]))),
    Lifetime.key(Lifetime.intersection([opened, b])),
  )
  const effect = Type.effectWithRows(
    'i32',
    RowAlgebra.concrete(Type.failureRowPolicy(), []),
    { environment: meet, lifetimeBinders: [] },
    'Take',
    RowAlgebra.concrete(Type.requirementRowPolicy(), []),
  )
  assert.deepEqual(
    Type.freeLifetimes(effect).map(Lifetime.key).sort(),
    [Lifetime.key(a), Lifetime.key(b)].sort(),
  )
  assert.strictEqual(
    Type.runtimeKey(effect),
    Type.runtimeKey(Type.substitute(effect, new Map([[Lifetime.key(a), Lifetime.staticLifetime]]))),
  )
})

it('requires grounded proofs when declared intersections participate in cycles', () => {
  const owner = { module: 'lifetimes', name: 'meet-cycle' }
  const a = Lifetime.bound(owner, 0, 'a')
  const b = Lifetime.bound(owner, 1, 'b')
  const c = Lifetime.bound(owner, 2, 'c')
  const target = Lifetime.bound(owner, 3, 'target')
  const meet = Lifetime.intersection([a, b])
  const cycle = [
    { longer: meet, shorter: c },
    { longer: c, shorter: a },
    { longer: a, shorter: target },
  ]
  const ungrounded = Lifetime.assumptions(cycle)
  assert.isTrue(Lifetime.outlives(ungrounded, meet, target))
  assert.isFalse(Lifetime.outlives(ungrounded, c, b))
  assert.isFalse(Lifetime.outlives(ungrounded, meet, Lifetime.staticLifetime))
  const grounded = Lifetime.assumptions([...cycle, { longer: a, shorter: Lifetime.staticLifetime }])
  assert.isTrue(Lifetime.outlives(grounded, c, b))
  assert.isTrue(Lifetime.outlives(grounded, meet, Lifetime.staticLifetime))
  // A query introduces this intersection without adding it to either assumption set.
  const query = Lifetime.intersection([c, target])
  assert.isFalse(Lifetime.outlives(grounded, query, b))
  assert.isTrue(Lifetime.outlives(grounded, query, target))
  assert.isFalse(Lifetime.outlives(ungrounded, c, b))
})

it('propagates later lifetime requirements through finite cycles and reports expired sources', () => {
  const owner = { module: 'lifetimes', name: 'reset' }
  const source = Lifetime.local(owner, 'body', 0)
  const holder = Lifetime.local(owner, 'body', 1)
  const copied = Lifetime.local(owner, 'body', 2)
  const solution = Lifetime.solve({
    pointCount: 4,
    regions: [
      { lifetime: source, unavailable: new Set([2, 3]), required: new Set([0]) },
      { lifetime: holder, unavailable: new Set(), required: new Set([1]) },
      { lifetime: copied, unavailable: new Set(), required: new Set([3]) },
    ],
    constraints: [
      { longer: source, shorter: holder },
      { longer: holder, shorter: copied },
      { longer: copied, shorter: holder },
    ],
  })
  if (solution._tag !== 'Solved') return unreachable('expected a finite region solution')
  assert.deepEqual(solution.violations, [{ lifetime: source, point: 3 }])
  assert.deepEqual(solution.required.get(Lifetime.key(source)), new Set([0, 1, 3]))
  assert.strictEqual(solution.work.propagatedPoints, 4)
})

it('requires every intersection constituent at concrete loan use points', () => {
  const owner = { module: 'lifetimes', name: 'intersection-use' }
  const a = Lifetime.local(owner, 'short', 0)
  const b = Lifetime.local(owner, 'long', 1)
  const meet = Lifetime.intersection([a, b])
  const solution = Lifetime.solve({
    pointCount: 3,
    regions: [
      { lifetime: a, unavailable: new Set([2]), required: new Set() },
      { lifetime: b, unavailable: new Set(), required: new Set() },
      { lifetime: meet, unavailable: new Set(), required: new Set([2]) },
    ],
    constraints: [],
  })
  if (solution._tag !== 'Solved') return unreachable('expected a finite intersection solution')
  assert.deepEqual(solution.violations, [{ lifetime: a, point: 2 }])
})

it('rejects missing lifetime solver inputs instead of treating them as unconstrained validity', () => {
  const source = Lifetime.local({ module: 'lifetimes', name: 'missing' }, 'body', 0)
  assert.deepEqual(
    Lifetime.solve({
      pointCount: 1,
      regions: [],
      constraints: [{ longer: source, shorter: Lifetime.staticLifetime }],
    }),
    { _tag: 'InvalidDomain', dimension: 'MissingRegion', lifetime: source },
  )
})

it('keeps nominal identity independent of field shape and import spelling', () => {
  const first = Type.nominal('syntax/Tree', 'Node')
  const repeated = Type.nominal('syntax/Tree', 'Node')
  const otherModule = Type.nominal('tir/Tree', 'Node')

  assert.strictEqual(Type.equals(first, repeated), true)
  assert.strictEqual(Type.equals(first, otherModule), false)
  assert.strictEqual(Type.encode(first), 'syntax/Tree.Node')
})

it('selects failure-carrier members only under their explicit tag convention', () => {
  const first = Type.nominal('types/failure-carrier', 'First')
  const second = Type.nominal('types/failure-carrier', 'Second')
  const normalized = Type.union([first, second])
  const union =
    normalized._tag === 'Normalized' && Type.isUnion(normalized.type)
      ? normalized.type
      : unreachable('expected a structural union')
  const effect = Type.effect('i32', [first, second], detached)

  assert.strictEqual(Type.failureCarrierMember(first, 0, 'ZeroBased'), first)
  assert.strictEqual(Type.failureCarrierMember('i32', 0, 'ZeroBased'), 'i32')
  assert.strictEqual(Type.failureCarrierMember(union, 0, 'ZeroBased'), first)
  assert.strictEqual(Type.failureCarrierMember(union, 1, 'ZeroBased'), second)
  assert.strictEqual(Type.failureCarrierMember(effect, 1, 'OneBased'), first)
  assert.strictEqual(Type.failureCarrierMember(effect, 2, 'OneBased'), second)
  assert.isUndefined(Type.failureCarrierMember(first, 1, 'ZeroBased'))
  assert.isUndefined(Type.failureCarrierMember(union, 1, 'OneBased'))
  assert.isUndefined(Type.failureCarrierMember(effect, 0, 'OneBased'))
  assert.isUndefined(Type.failureCarrierMember(effect, 1, 'ZeroBased'))
  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.isUndefined(Type.failureCarrierMember(union, invalid, 'ZeroBased'))
    assert.isUndefined(Type.failureCarrierMember(effect, invalid, 'OneBased'))
  }
})

it('refuses carrier tags whose member order can change after specialization', () => {
  const owner = Object.freeze({ module: 'types/failure-carrier', name: 'specialize' })
  const failures = Type.parameter(owner, 0, 'E')
  const member = Type.parameter(owner, 1, 'T')
  const alpha = Type.nominal('types/failure-carrier', 'Alpha')
  const zed = Type.nominal('types/failure-carrier', 'Zed')
  const openEffect = Type.effect('i32', [zed, failures], detached)

  assert.isUndefined(Type.failureCarrierMember(openEffect, 1, 'OneBased'))
  const specializedEffect = Type.substitute(
    openEffect,
    new Map([[Type.key(failures), Type.failureValue([alpha])]]),
  )
  const concreteEffect = Type.isEffect(specializedEffect)
    ? specializedEffect
    : unreachable('expected a specialized Effect carrier')
  assert.deepEqual(Type.failureMembers(concreteEffect), [alpha, zed])
  assert.isTrue(
    Type.equals(
      Type.failureCarrierMember(concreteEffect, 1, 'OneBased') ??
        unreachable('expected first specialized failure'),
      alpha,
    ),
  )
  assert.isTrue(
    Type.equals(
      Type.failureCarrierMember(concreteEffect, 2, 'OneBased') ??
        unreachable('expected second specialized failure'),
      zed,
    ),
  )

  const genericBox = Type.nominal('types/failure-carrier', 'Box', [member])
  const concreteBox = Type.nominal('types/failure-carrier', 'Box', ['i32'])
  const unavailableBox = Type.nominal('types/failure-carrier', 'Box', [
    Type.unavailableGenericArgument('Value', 'unresolved carrier argument'),
  ])
  const unavailableInner = Type.nominal('types/failure-carrier', 'Inner', [
    Type.unavailableGenericArgument('Value', 'unresolved nested carrier argument'),
  ])
  const unavailableOuter = Type.nominal('types/failure-carrier', 'Outer', [unavailableInner])
  const concreteOuter = Type.nominal('types/failure-carrier', 'Outer', [
    Type.nominal('types/failure-carrier', 'Inner', ['i32']),
  ])
  const normalized = Type.union([genericBox, concreteBox, zed])
  const openUnion =
    normalized._tag === 'Normalized' && Type.isUnion(normalized.type)
      ? normalized.type
      : unreachable('expected an open structural union')
  assert.isUndefined(Type.failureCarrierMember(genericBox, 0, 'ZeroBased'))
  assert.isUndefined(Type.failureCarrierMember(unavailableBox, 0, 'ZeroBased'))
  assert.isFalse(Type.isRuntimeConcrete(unavailableOuter))
  assert.isFalse(Type.isRuntimeConcreteGenericArgument(unavailableOuter))
  assert.isUndefined(Type.failureCarrierMember(unavailableOuter, 0, 'ZeroBased'))
  assert.isTrue(Type.isRuntimeConcrete(concreteOuter))
  assert.strictEqual(Type.failureCarrierMember(concreteOuter, 0, 'ZeroBased'), concreteOuter)
  assert.isUndefined(Type.failureCarrierMember(openUnion, 0, 'ZeroBased'))

  const unavailableEffect = Type.effect(unavailableOuter, [unavailableOuter], detached, 'Shared', [
    { capability: unavailableOuter, role: 'DefaultRole', access: 'Shared' },
  ])
  const unavailableUnionResult = Type.union([unavailableOuter, zed])
  const unavailableUnion =
    unavailableUnionResult._tag === 'Normalized' && Type.isUnion(unavailableUnionResult.type)
      ? unavailableUnionResult.type
      : unreachable('expected a nested-unavailable structural union')
  const unavailableCallable = Type.callable([unavailableOuter], unavailableOuter, detached)
  const unavailableIdentity = Type.effectIdentityArgument('types/failure-carrier.effect', {
    declaration: owner,
    typeArguments: [unavailableOuter],
    staticArgumentKeys: [],
  })
  const concreteContract = Type.effect('i32', [], detached)
  const unavailableRepresentation = Type.represented(
    concreteContract,
    concreteContract,
    Type.exactRepresentationArgument(unavailableIdentity, concreteContract),
  )
  assert.isFalse(Type.isRuntimeConcrete(unavailableEffect))
  assert.isUndefined(Type.failureCarrierMember(unavailableEffect, 1, 'OneBased'))
  assert.isFalse(Type.isRuntimeConcrete(unavailableUnion))
  assert.isUndefined(Type.failureCarrierMember(unavailableUnion, 0, 'ZeroBased'))
  assert.isFalse(Type.isRuntimeConcrete(unavailableCallable))
  assert.isFalse(Type.isRuntimeConcrete(unavailableRepresentation))
  assert.isFalse(Type.isRuntimeConcreteGenericArgument(unavailableIdentity))
  assert.isFalse(Type.isRuntimeConcreteGenericArgument(Type.failureValue([unavailableOuter])))
  assert.isFalse(
    Type.isRuntimeConcreteGenericArgument(
      Type.requirementRowArgument([
        { capability: unavailableOuter, role: 'DefaultRole', access: 'Shared' },
      ]),
    ),
  )
  assert.isTrue(
    Type.isRuntimeConcrete(
      Type.effect(concreteOuter, [zed], detached, 'Shared', [
        { capability: concreteOuter, role: 'DefaultRole', access: 'Shared' },
      ]),
    ),
  )

  const specializedUnion = Type.substitute(openUnion, new Map([[Type.key(member), 'i32']]))
  const concreteUnion = Type.isUnion(specializedUnion)
    ? specializedUnion
    : unreachable('expected a specialized structural union carrier')
  assert.strictEqual(concreteUnion.members.length, 2)
  assert.isTrue(
    Type.equals(
      Type.failureCarrierMember(concreteUnion, 0, 'ZeroBased') ??
        unreachable('expected first specialized union member'),
      concreteUnion.members.at(0) ?? unreachable('expected first canonical union member'),
    ),
  )
  assert.isTrue(
    Type.equals(
      Type.failureCarrierMember(concreteUnion, 1, 'ZeroBased') ??
        unreachable('expected second specialized union member'),
      concreteUnion.members.at(1) ?? unreachable('expected second canonical union member'),
    ),
  )
})

it('specializes executable owners throughout nested callable schemas without capturing binders', () => {
  const declaration = Object.freeze({ module: 'types/schema-owner', name: 'outer' })
  const openOwner = Type.parameter(declaration, 0, 'T')
  const nestedOwner = Object.freeze({ module: 'types/schema-owner', name: 'section' })
  const nested = Type.parameter(nestedOwner, 0, 'A')
  const marker = Type.nominal('types/schema-owner', 'Marker')
  const effect = Type.effect('i32', [], detached)
  const ownedIdentity = Type.exactRepresentationArgument(
    Type.effectIdentityArgument('types/schema-owner.effect', {
      declaration,
      typeArguments: [openOwner],
      staticArgumentKeys: [],
    }),
    effect,
  )
  const provider = Type.nominal('types/schema-owner', 'Provider', [ownedIdentity])
  const capability = Type.nominal('types/schema-owner', 'Service')
  const requirements = Type.requirementRowArgument([
    Object.freeze({ capability, role: 'DefaultRole', access: 'Shared' }),
  ]).row
  const constraint = Constraint.providerSelection('Shared', provider, requirements, requirements)
  const evidence = Constraint.assumed(constraint, new Map([[Type.key(nested), ownedIdentity]]))
  const contract = CallableContract.make({
    ...detached,
    functionKind: 'Function',
    binders: [nested],
    result: 'i32',
    constraints: [constraint],
  })
  const callable = Type.callable([], 'i32', detached, 'Shared', {
    contract,
    binders: [nested],
    constraints: [constraint],
    evidence: [evidence],
    substitution: new Map([[Type.key(nested), ownedIdentity]]),
    contractKey: CallableContract.key(contract),
    constraintKeys: [Constraint.key(constraint)],
    evidenceKeys: [Constraint.evidenceKey(evidence)],
    origins: [locationAt('types/schema-owner')],
  })

  const specialized = Type.specializeExecutableOwner(
    callable,
    Object.freeze({ declaration, typeArguments: [marker], staticArgumentKeys: [] }),
    Constraint.specializeCallableSchemaExecutableOwner,
  )
  assert.isTrue(Type.isCallable(specialized))
  const specializedCallable = Type.isCallable(specialized)
    ? specialized
    : unreachable('expected specialized callable type')
  const schema = specializedCallable.schema ?? unreachable('expected specialized callable schema')
  assert.deepEqual(schema.binders, [nested])
  assert.notStrictEqual(schema.contractKey, callable.schema?.contractKey)
  assert.deepEqual(schema.constraintKeys, schema.constraints.map(Constraint.key))
  assert.deepEqual(schema.evidenceKeys, schema.evidence.map(Constraint.evidenceKey))
  const argument = schema.substitution.get(Type.key(nested))
  assert.isTrue(argument !== undefined && Type.isExactRepresentationArgument(argument))
  const exactArgument =
    argument !== undefined && Type.isExactRepresentationArgument(argument)
      ? argument
      : unreachable('expected exact specialized schema substitution')
  assert.isTrue(Type.isEffectIdentityArgument(exactArgument.identity))
  const effectIdentity = Type.isEffectIdentityArgument(exactArgument.identity)
    ? exactArgument.identity
    : unreachable('expected specialized Effect identity')
  assert.deepEqual(effectIdentity.owner?.typeArguments, [marker])
})

it('orders built-in and nominal types by canonical keys', () => {
  const values: ReadonlyArray<Type.Type> = [
    Type.nominal('syntax/Tree', 'Node'),
    'i32',
    Type.nominal('ast/Tree', 'Node'),
    'bool',
  ]

  assert.deepEqual([...values].sort(Type.compare).map(Type.encode), [
    'bool',
    'i32',
    'ast/Tree.Node',
    'syntax/Tree.Node',
  ])
  assert.strictEqual(Type.isBuiltin('i32'), true)
  assert.strictEqual(Type.isNominal(values[0] ?? 'i32'), true)
})

it('keeps string canonical, non-scalar, borrowed, and structurally atomic', () => {
  const owner = { module: 'work', name: 'identity' }
  const parameter = Type.parameter(owner, 0, 'T')
  const substitution = new Map([[Type.key(parameter), 'u8' as const]])
  const values: ReadonlyArray<Type.Type> = [staticText, 'i32', Type.nominal('text', 'Owner')]

  assert.strictEqual(Type.isString(staticText), true)
  assert.strictEqual(Type.isBuiltin(staticText), false)
  assert.strictEqual(Type.key(staticText), 'string<static>')
  assert.strictEqual(Type.encode(staticText), "string<'static>")
  assert.deepEqual([...values].sort(Type.compare).map(Type.encode), [
    'i32',
    'text.Owner',
    "string<'static>",
  ])
  assert.strictEqual(Type.substitute(staticText, substitution), staticText)
  assert.strictEqual(Type.isConcrete(staticText), true)
  assert.deepEqual(Type.parameters(staticText), [])
  assert.deepEqual(Type.nominals(staticText), [])
  assert.strictEqual(Type.containsBorrow(staticText), true)
  assert.strictEqual(
    TypeCompatibility.isCompatible(TypeCompatibility.check(staticText, staticText)),
    true,
  )
  assert.strictEqual(
    TypeCompatibility.isCompatible(
      TypeCompatibility.check(staticText, Type.slice('Shared', 'u8', Lifetime.staticLifetime)),
    ),
    false,
  )
})

it('classifies ordinary references and slices as lexical views', () => {
  const nominal = Type.nominal('test', 'Counter')
  const reference = Type.reference('Exclusive', nominal, Lifetime.staticLifetime)
  const slice = Type.slice('Shared', nominal, Lifetime.staticLifetime)

  assert.strictEqual(Type.isViewBorrow(reference), true)
  assert.strictEqual(Type.isViewBorrow(slice), true)
  assert.strictEqual(Type.containsViewBorrow(reference), true)
  assert.strictEqual(Type.containsViewBorrow(Type.fixedArray(reference, 1)), true)
  assert.strictEqual(Type.isViewBorrow(Type.fixedArray(reference, 1)), false)
})

it('keeps fixed-array element type and length in recursive structural identity', () => {
  const three = Type.fixedArray('i32', 3)
  const repeated = Type.fixedArray('i32', 3)
  const four = Type.fixedArray('i32', 4)
  const nested = Type.fixedArray(Type.fixedArray(Type.nominal('model/Token', 'Token'), 0), 2)

  assert.strictEqual(Type.equals(three, repeated), true)
  assert.strictEqual(Type.equals(three, four), false)
  assert.strictEqual(Type.isFixedArray(three), true)
  assert.strictEqual(Type.encode(nested), 'Array<Array<model/Token.Token, 0>, 2>')
  assert.deepEqual(Type.nominals(nested).map(Type.encode), ['model/Token.Token'])
})

it('normalizes structural unions as canonical ordinary sets', () => {
  const token = Type.nominal('model/Token', 'Token')
  const end = Type.nominal('model/End', 'End')
  const first = Type.union([token, end, token])
  const permuted = Type.union([end, token])
  assert.strictEqual(first._tag, 'Normalized')
  assert.strictEqual(permuted._tag, 'Normalized')
  if (first._tag !== 'Normalized' || permuted._tag !== 'Normalized') return
  assert.strictEqual(Type.isUnion(first.type), true)
  assert.strictEqual(Type.equals(first.type, permuted.type), true)
  assert.strictEqual(Type.encode(first.type), 'model/End.End | model/Token.Token')
  assert.deepEqual(Type.nominals(first.type).map(Type.encode), [
    'model/End.End',
    'model/Token.Token',
  ])
  assert.isTrue(Type.isUnion(first.type))
})

it('finds generic nominal dependencies nested inside union members', () => {
  const hidden = Type.nominal('model/Private', 'Hidden')
  const box = Type.nominal('model/Box', 'Box', [hidden])
  const other = Type.nominal('model/Other', 'Other')
  const union = Type.union([box, other])
  assert.strictEqual(union._tag, 'Normalized')
  if (union._tag !== 'Normalized') return
  assert.deepEqual(Type.nominals(union.type).map(Type.encode), [
    'model/Box.Box<model/Private.Hidden>',
    'model/Private.Hidden',
    'model/Other.Other',
  ])
})

it('normalizes empty, singleton, scalar, and aggregate union members', () => {
  const token = Type.nominal('model/Token', 'Token')
  const empty = Type.union(['never'])
  const singleton = Type.union(['never', token, token])
  const aggregate = Type.union([token, 'i32', Type.fixedArray(token, 2)])
  assert.deepEqual(empty, { _tag: 'Normalized', type: 'never' })
  assert.strictEqual(singleton._tag, 'Normalized')
  if (singleton._tag === 'Normalized') assert.strictEqual(Type.equals(singleton.type, token), true)
  assert.strictEqual(aggregate._tag, 'Normalized')
  if (aggregate._tag === 'Normalized')
    assert.strictEqual(
      Type.encode(aggregate.type),
      'Array<model/Token.Token, 2> | i32 | model/Token.Token',
    )
})

it('admits finite shared borrow union storage and renormalizes generic members', () => {
  const owner = { module: 'model/GenericUnion', name: 'choose' }
  const left = Type.parameter(owner, 0, 'L')
  const right = Type.parameter(owner, 1, 'R')
  const borrowed = Type.slice('Shared', 'i32', Lifetime.staticLifetime)
  assert.strictEqual(Type.union(['i32', borrowed])._tag, 'Normalized')
  const mutable = Type.reference('Exclusive', 'i32', Lifetime.staticLifetime)
  assert.deepEqual(Type.union(['i32', mutable]), {
    _tag: 'InvalidMembers',
    members: [mutable],
  })
  const callable = Type.callable(['i32'], 'i32', detached)
  const effect = Type.effect('i32', [], detached)
  assert.deepEqual(Type.union(['i32', callable]), {
    _tag: 'InvalidMembers',
    members: [callable],
  })
  assert.deepEqual(Type.union(['i32', effect]), {
    _tag: 'InvalidMembers',
    members: [effect],
  })

  const open = Type.union([left, right])
  assert.strictEqual(open._tag, 'Normalized')
  if (open._tag !== 'Normalized') return
  const specialized = Type.substitute(
    open.type,
    new Map([
      [Type.key(left), 'i32'],
      [Type.key(right), 'i32'],
    ]),
  )
  assert.strictEqual(specialized, 'i32')
})

it('normalizes compiler-private effect contract identity and traverses substitutions', () => {
  const owner = { module: 'work', name: 'load' }
  const parameter = Type.parameter(owner, 0, 'T')
  const first = Type.nominal('errors', 'First')
  const second = Type.nominal('errors', 'Second')
  const contract = Type.effect(parameter, [second, first, second], detached, 'Take')
  const permuted = Type.effect(parameter, [first, second], detached, 'Take')

  assert.strictEqual(Type.isEffect(contract), true)
  assert.strictEqual(Type.equals(contract, permuted), true)
  assert.strictEqual(
    Type.encode(contract),
    "once Effect<'static; T ! errors.First | errors.Second>",
  )
  assert.deepEqual(Type.parameters(contract), [parameter])
  assert.deepEqual(Type.nominals(contract).map(Type.encode), ['errors.First', 'errors.Second'])

  const substituted = Type.substitute(contract, new Map([[Type.key(parameter), 'usize']]))
  assert.strictEqual(
    Type.encode(substituted),
    "once Effect<'static; usize ! errors.First | errors.Second>",
  )
  assert.strictEqual(Type.isConcrete(substituted), true)
})

it('canonicalizes callable contracts and orders invocation guarantees', () => {
  const owner = { module: 'work', name: 'apply' }
  const parameter = Type.parameter(owner, 0, 'T')
  const shared = Type.callable([parameter, 'bool'], parameter, detached)
  const unsafe = Type.callable([parameter, 'bool'], parameter, detached, 'Shared', undefined, true)
  const exclusive = Type.callable([parameter, 'bool'], parameter, detached, 'Exclusive')
  const once = Type.callable([parameter, 'bool'], parameter, detached, 'Take')
  const substitution = new Map([[Type.key(parameter), 'i32' as const]])

  assert.strictEqual(Type.encode(shared), "fn<'static>(T, bool) -> T")
  assert.strictEqual(Type.encode(unsafe), "unsafe fn<'static>(T, bool) -> T")
  assert.strictEqual(Type.encode(exclusive), "mut fn<'static>(T, bool) -> T")
  assert.strictEqual(Type.encode(once), "once fn<'static>(T, bool) -> T")
  assert.strictEqual(
    Type.encode(Type.substitute(shared, substitution)),
    "fn<'static>(i32, bool) -> i32",
  )
  assert.strictEqual(
    Type.encode(Type.substitute(unsafe, substitution)),
    "unsafe fn<'static>(i32, bool) -> i32",
  )
  assert.deepEqual(Type.parameters(shared), [parameter])
  assert.strictEqual(
    TypeCompatibility.isCompatible(TypeCompatibility.check(shared, exclusive)),
    true,
  )
  assert.strictEqual(TypeCompatibility.isCompatible(TypeCompatibility.check(shared, once)), true)
  assert.strictEqual(TypeCompatibility.isCompatible(TypeCompatibility.check(exclusive, once)), true)
  assert.strictEqual(
    TypeCompatibility.isCompatible(TypeCompatibility.check(exclusive, shared)),
    false,
  )
  assert.strictEqual(
    TypeCompatibility.isCompatible(TypeCompatibility.check(once, exclusive)),
    false,
  )
  assert.strictEqual(TypeCompatibility.isCompatible(TypeCompatibility.check(shared, unsafe)), true)
  assert.strictEqual(TypeCompatibility.isCompatible(TypeCompatibility.check(unsafe, shared)), false)
})

it('applies the Shared < Exclusive < Take order across compatibility and inference', () => {
  const accesses = ['Shared', 'Exclusive', 'Take'] as const
  const expected = [
    [true, true, true],
    [false, true, true],
    [false, false, true],
  ] as const

  for (const [requiredOrdinal, required] of accesses.entries()) {
    for (const [suppliedOrdinal, supplied] of accesses.entries()) {
      const accepted = expected.at(requiredOrdinal)?.at(suppliedOrdinal) ?? false
      const requiredCallable = Type.callable(['i32'], 'i32', detached, required)
      const suppliedCallable = Type.callable(['i32'], 'i32', detached, supplied)
      const requiredEffect = Type.effect('i32', [], detached, required)
      const suppliedEffect = Type.effect('i32', [], detached, supplied)

      assert.strictEqual(Type.compareAccess(supplied, required), accepted)
      assert.strictEqual(
        TypeCompatibility.isCompatible(TypeCompatibility.check(requiredCallable, suppliedCallable)),
        accepted,
      )
      assert.strictEqual(
        TypeCompatibility.isCompatible(TypeCompatibility.check(requiredEffect, suppliedEffect)),
        accepted,
      )
      assert.strictEqual(
        TypeInference.infer(suppliedCallable, requiredCallable, new Map()),
        accepted,
      )
      assert.strictEqual(TypeInference.infer(suppliedEffect, requiredEffect, new Map()), accepted)
    }
  }
})

it('widens Effect requirement rows only from fewer requirements to an allowed superset', () => {
  const capability = Type.nominal('test', 'Capability')
  const allowed = Type.effect('i32', [], detached, 'Take', [
    { capability, role: 'DefaultRole', access: 'Exclusive' },
  ])
  const closed = Type.effect('i32', [], detached, 'Take')
  const requiring = Type.effect('i32', [], detached, 'Take', [
    { capability, role: 'DefaultRole', access: 'Shared' },
  ])

  assert.isTrue(TypeCompatibility.isCompatible(TypeCompatibility.check(closed, allowed)))
  assert.isFalse(TypeCompatibility.isCompatible(TypeCompatibility.check(requiring, closed)))
})

it('searches every nested type position including requirement capabilities', () => {
  const borrowed = Type.slice('Shared', 'u8', Lifetime.staticLifetime)
  const capability = Type.nominal('test', 'Capability', [borrowed])
  const effect = Type.effect('i32', [], detached, 'Shared', [
    { capability, role: 'DefaultRole', access: 'Shared' },
  ])

  assert.strictEqual(Type.someSubterm(effect, Type.isSlice), true)
  assert.strictEqual(Type.containsBorrow(effect), true)
  assert.strictEqual(Type.containsViewBorrow(effect), true)
  assert.strictEqual(Type.containsBorrowWrapper(effect), true)
})

it('normalizes finite rows and applies total exact set operations deterministically', () => {
  const policy: FiniteRow.Policy<string> = {
    collisionKey: (member) => member,
    memberKey: (member) => member,
    merge: (left) => left,
  }
  const first = FiniteRow.make(policy, ['C', 'A', 'B', 'A'])
  const permuted = FiniteRow.make(policy, ['B', 'C', 'A'])
  const selected = FiniteRow.make(policy, ['C', 'missing', 'A'])

  assert.deepEqual(first.members, ['A', 'B', 'C'])
  assert.strictEqual(FiniteRow.equals(policy, first, permuted), true)
  assert.strictEqual(FiniteRow.key(policy, first), FiniteRow.key(policy, permuted))
  assert.deepEqual(FiniteRow.intersection(policy, first, selected).members, ['A', 'C'])
  assert.deepEqual(FiniteRow.difference(policy, first, selected).members, ['B'])
  assert.deepEqual(
    FiniteRow.difference(policy, first, FiniteRow.make(policy, ['missing'])).members,
    ['A', 'B', 'C'],
  )
  assert.strictEqual(FiniteRow.isSubset(policy, FiniteRow.make(policy, ['A', 'C']), first), true)
  assert.strictEqual(
    FiniteRow.encode(policy, first, (member) => member),
    'A | B | C',
  )
})

it('keeps requirement union joins and exact membership separate from key difference', () => {
  type Capability = 'Clock' | 'Logger'
  type Member = RequirementRow.Member<Capability>
  const policy = RequirementRow.policy<Capability>((capability) => capability)
  const member = (
    capability: Capability,
    access: RequirementRow.Access,
    role = 'Default',
  ): Member => ({ capability, access, role })

  for (const [left, right, expected] of [
    ['Shared', 'Shared', 'Shared'],
    ['Shared', 'Exclusive', 'Exclusive'],
    ['Exclusive', 'Shared', 'Exclusive'],
    ['Exclusive', 'Exclusive', 'Exclusive'],
  ] as const) {
    const united = FiniteRow.union(
      policy,
      FiniteRow.make(policy, [member('Logger', left)]),
      FiniteRow.make(policy, [member('Logger', right)]),
    )
    assert.strictEqual(united.members.at(0)?.access, expected)
  }

  const shared = FiniteRow.make(policy, [member('Logger', 'Shared')])
  const exclusive = FiniteRow.make(policy, [member('Logger', 'Exclusive')])
  assert.strictEqual(FiniteRow.has(policy, shared, member('Logger', 'Shared')), true)
  assert.strictEqual(FiniteRow.has(policy, shared, member('Logger', 'Exclusive')), false)
  assert.strictEqual(FiniteRow.has(policy, exclusive, member('Logger', 'Shared')), false)
  assert.strictEqual(FiniteRow.has(policy, exclusive, member('Logger', 'Exclusive')), true)
  assert.deepEqual(FiniteRow.intersection(policy, shared, exclusive).members, [])
  assert.deepEqual(FiniteRow.intersection(policy, exclusive, shared).members, [])
  assert.deepEqual(FiniteRow.intersection(policy, shared, shared).members, shared.members)
  assert.deepEqual(FiniteRow.intersection(policy, exclusive, exclusive).members, exclusive.members)
  assert.strictEqual(FiniteRow.isSubset(policy, shared, exclusive), false)
  assert.strictEqual(FiniteRow.isSubset(policy, exclusive, shared), false)
  assert.strictEqual(FiniteRow.isSubset(policy, shared, shared), true)
  assert.strictEqual(FiniteRow.isSubset(policy, exclusive, exclusive), true)
  assert.deepEqual(FiniteRow.difference(policy, shared, exclusive).members, [])
  assert.deepEqual(FiniteRow.difference(policy, exclusive, shared).members, [])
  assert.deepEqual(FiniteRow.difference(policy, shared, shared).members, [])
  assert.deepEqual(FiniteRow.difference(policy, exclusive, exclusive).members, [])

  const collisions = FiniteRow.make(policy, [
    member('Logger', 'Shared'),
    member('Logger', 'Exclusive'),
    member('Clock', 'Shared'),
    member('Logger', 'Shared', 'Audit'),
  ])
  assert.deepEqual(collisions.members, [
    member('Clock', 'Shared'),
    member('Logger', 'Shared', 'Audit'),
    member('Logger', 'Exclusive'),
  ])
})

it('renormalizes requirement collisions introduced by substitution', () => {
  const owner = { module: 'work', name: 'provide' }
  const capability = Type.parameter(owner, 0, 'P')
  const logger = Type.nominal('silk/logger', 'Logger')
  const contract = Type.effect('never', [], detached, 'Shared', [
    { capability, role: 'Default', access: 'Shared' },
    { capability: logger, role: 'Default', access: 'Exclusive' },
  ])
  const substituted = Type.substitute(contract, new Map([[Type.key(capability), logger]]))

  assert.strictEqual(Type.isEffect(substituted), true)
  if (Type.isEffect(substituted))
    assert.deepEqual(Type.requirementMembers(substituted), [
      { capability: logger, role: 'Default', access: 'Exclusive' },
    ])
})

it('checks provider compatibility independently from exact stored access', () => {
  assert.strictEqual(RequirementRow.providerCanSelect('Shared', 'Shared'), true)
  assert.strictEqual(RequirementRow.providerCanSelect('Shared', 'Exclusive'), false)
  assert.strictEqual(RequirementRow.providerCanSelect('Exclusive', 'Shared'), true)
  assert.strictEqual(RequirementRow.providerCanSelect('Exclusive', 'Exclusive'), true)
  assert.strictEqual(RequirementRow.providerCanSelect('Take', 'Shared'), true)
  assert.strictEqual(RequirementRow.providerCanSelect('Take', 'Exclusive'), true)
})

it('subtracts exact service keys without waiting for unrelated borrow lifetimes', () => {
  const lifetime = Lifetime.bound({ module: 'work', name: 'provide' }, 0, 'borrow')
  const policy = Type.requirementRowPolicy()
  const selected: Type.Requirement = {
    capability: Type.nominal('work', 'Selected', [lifetime]),
    role: 'DefaultRole',
    access: 'Exclusive',
  }
  const remaining = { ...selected, capability: Type.nominal('work', 'Other', [lifetime]) }
  const difference = RowAlgebra.without(
    policy,
    RowAlgebra.concrete(policy, [selected, remaining]),
    RowAlgebra.concrete(policy, [{ ...selected, access: 'Shared' }]),
  )
  assert.deepEqual(RowAlgebra.concretize(policy, difference), {
    _tag: 'Concrete',
    row: { members: [remaining] },
  })
  // Same nominal heads with different unresolved lifetimes may still collide later.
  const otherLifetime = Lifetime.bound({ module: 'work', name: 'provide' }, 1, 'other')
  assert.strictEqual(
    RowAlgebra.without(
      policy,
      RowAlgebra.concrete(policy, [selected]),
      RowAlgebra.concrete(policy, [
        { ...selected, capability: Type.nominal('work', 'Selected', [otherLifetime]) },
      ]),
    ).expression._tag,
    'Without',
  )
})

it('defers concrete difference until generic member keys finish specializing', () => {
  const owner = { module: 'work', name: 'difference' }
  const left = Type.parameter(owner, 0, 'A')
  const right = Type.parameter(owner, 1, 'B')
  const problem = (argument: Type.Type): Type.Nominal => Type.nominal('work', 'Problem', [argument])
  const failurePolicy = Type.failureRowPolicy()
  const openFailures = RowAlgebra.without(
    failurePolicy,
    RowAlgebra.concrete(failurePolicy, [problem(left)]),
    RowAlgebra.concrete(failurePolicy, [problem(right)]),
  )
  assert.strictEqual(openFailures.expression._tag, 'Without')

  const concrete = Type.nominal('work', 'Token')
  const substitution = new Map([
    [Type.key(left), concrete],
    [Type.key(right), concrete],
  ])
  const failures = Type.substituteFailureRow(openFailures, substitution)
  assert.deepEqual(RowAlgebra.concretize(failurePolicy, failures), {
    _tag: 'Concrete',
    row: { members: [] },
  })

  const capability = (argument: Type.Type): Type.Nominal =>
    Type.nominal('work', 'Capability', [argument])
  const requirementPolicy = Type.requirementRowPolicy()
  const requirement = (
    argument: Type.Type,
    access: Type.Requirement['access'],
    role: string,
  ): Type.Requirement => ({ capability: capability(argument), access, role })
  const sourceRow = RowAlgebra.concrete(requirementPolicy, [
    requirement(left, 'Exclusive', 'Audit'),
  ])
  const possiblyEqual = RowAlgebra.concrete(requirementPolicy, [
    requirement(right, 'Shared', 'Audit'),
  ])
  assert.isFalse(
    RowAlgebra.isKnownSubset(
      requirementPolicy,
      sourceRow,
      RowAlgebra.without(requirementPolicy, sourceRow, possiblyEqual),
    ),
  )
  const specialize = (
    source: Type.Requirement,
    selected: Type.Requirement,
  ): ReadonlyArray<Type.Requirement> => {
    const open = RowAlgebra.without(
      requirementPolicy,
      RowAlgebra.concrete(requirementPolicy, [source]),
      RowAlgebra.concrete(requirementPolicy, [selected]),
    )
    assert.strictEqual(open.expression._tag, source.role === selected.role ? 'Without' : 'Concrete')
    const specialized = Type.substituteRequirementsRow(open, substitution)
    const result = RowAlgebra.concretize(requirementPolicy, specialized)
    assert.strictEqual(result._tag, 'Concrete')
    return result._tag === 'Concrete' ? result.row.members : []
  }

  assert.deepEqual(
    specialize(requirement(left, 'Exclusive', 'Audit'), requirement(right, 'Exclusive', 'Audit')),
    [],
  )
  assert.deepEqual(
    specialize(requirement(left, 'Exclusive', 'Audit'), requirement(right, 'Shared', 'Audit')),
    [],
  )
  assert.deepEqual(
    specialize(
      requirement(left, 'Exclusive', 'Audit'),
      requirement(right, 'Exclusive', 'DefaultRole'),
    ),
    [requirement(concrete, 'Exclusive', 'Audit')],
  )
})

it('normalizes open row union ACI and retains erased member obligations', () => {
  interface SymbolicMember {
    readonly parameter: string
  }
  const finite: FiniteRow.Policy<string> = {
    collisionKey: (member) => member,
    memberKey: (member) => member,
    merge: (left) => left,
  }
  const policy: RowAlgebra.Policy<string, string, SymbolicMember, string> = {
    finite,
    concreteMemberMaySpecialize: () => false,
    rowParameterKey: (parameter) => parameter,
    symbolicMemberKey: (member) => member.parameter,
    symbolicMemberParameters: (member) => [member.parameter],
    memberParameterKey: (parameter) => parameter,
    memberWellFormedKey: (member) => `FailureMember:${member.parameter}`,
    allowsSetCancellation: true,
  }
  const firstOrigin = span('main', 20, 21)
  const earlierOrigin = span('main', 10, 11)
  const a = RowAlgebra.parameter<string, string, SymbolicMember>('A')
  const b = RowAlgebra.parameter<string, string, SymbolicMember>('B')
  const s1 = RowAlgebra.singleton(policy, { parameter: 'S' }, firstOrigin)
  const s2 = RowAlgebra.singleton(policy, { parameter: 'S' }, earlierOrigin)
  const left = RowAlgebra.union(policy, RowAlgebra.union(policy, a, b), s1)
  const right = RowAlgebra.union(policy, s2, RowAlgebra.union(policy, b, a))

  assert.strictEqual(RowAlgebra.equals(policy, left, right), true)
  assert.strictEqual(RowAlgebra.key(policy, left), RowAlgebra.key(policy, right))
  assert.deepEqual(right.memberWellFormed.at(0)?.origins, [earlierOrigin])

  const repeated = RowAlgebra.union(policy, left, s2)
  assert.deepEqual(repeated.memberWellFormed.at(0)?.origins, [earlierOrigin, firstOrigin])
  assert.strictEqual(RowAlgebra.key(policy, repeated), RowAlgebra.key(policy, left))
  const obligation = repeated.memberWellFormed.at(0)
  assert.isDefined(obligation)
  if (obligation !== undefined) {
    assert.deepEqual(RowAlgebra.diagnosticLocations(obligation), {
      primary: earlierOrigin,
      secondary: [firstOrigin],
    })
    const responsible = span('call', 30, 31)
    assert.deepEqual(RowAlgebra.diagnosticLocations(obligation, responsible), {
      primary: responsible,
      secondary: [earlierOrigin, firstOrigin],
    })
  }

  const erased = RowAlgebra.without(policy, s1, s2)
  assert.strictEqual(
    RowAlgebra.encode(policy, erased, String, String, (member) => member.parameter),
    '',
  )
  assert.deepEqual(RowAlgebra.parameters(policy, erased), { rows: [], members: ['S'] })
  assert.strictEqual(RowAlgebra.concretize(policy, erased)._tag, 'Residual')
  const emptyLeft = RowAlgebra.without(policy, RowAlgebra.concrete(policy, []), s1)
  assert.deepEqual(RowAlgebra.parameters(policy, emptyLeft), { rows: [], members: ['S'] })
})

it('substitutes symbolic members residually or concretely and reports invalid singleton domains', () => {
  interface SymbolicMember {
    readonly parameter: string
  }
  const policy: RowAlgebra.Policy<string, string, SymbolicMember, string> = {
    finite: {
      collisionKey: (member) => member,
      memberKey: (member) => member,
      merge: (left) => left,
    },
    concreteMemberMaySpecialize: () => false,
    rowParameterKey: (parameter) => parameter,
    symbolicMemberKey: (member) => member.parameter,
    symbolicMemberParameters: (member) => [member.parameter],
    memberParameterKey: (parameter) => parameter,
    memberWellFormedKey: (member) => `FailureMember:${member.parameter}`,
    allowsSetCancellation: true,
  }
  const origin = span('main', 4, 5)
  const symbolic = RowAlgebra.singleton(policy, { parameter: 'S' }, origin)
  const source = RowAlgebra.union(
    policy,
    RowAlgebra.parameter<string, string, SymbolicMember>('E'),
    symbolic,
  )
  const expression = RowAlgebra.without(policy, source, symbolic)
  const noRows = () => undefined

  const residual = RowAlgebra.substitute(policy, expression, {
    row: noRows,
    member: (member) => ({
      _tag: 'Residual',
      member: { parameter: `${member.parameter}2` },
    }),
  })
  assert.strictEqual(residual._tag, 'Substituted')
  if (residual._tag === 'Substituted')
    assert.deepEqual(RowAlgebra.parameters(policy, residual.row), {
      rows: ['E'],
      members: ['S2'],
    })

  const concrete = RowAlgebra.substitute(policy, expression, {
    row: (parameter) =>
      parameter === 'E' ? RowAlgebra.concrete(policy, ['Problem', 'Other']) : undefined,
    member: () => ({ _tag: 'Concrete', member: 'Problem' }),
  })
  assert.strictEqual(concrete._tag, 'Substituted')
  if (concrete._tag === 'Substituted') {
    const finite = RowAlgebra.concretize(policy, concrete.row)
    assert.strictEqual(finite._tag, 'Concrete')
    if (finite._tag === 'Concrete') assert.deepEqual(finite.row.members, ['Other'])

    const distinctOpen = RowAlgebra.parameter<string, string, SymbolicMember>('OnlyOther')
    const sameConcrete = RowAlgebra.substitute(policy, distinctOpen, {
      row: () => RowAlgebra.concrete(policy, ['Other']),
      member: (member) => ({ _tag: 'Residual', member }),
    })
    assert.strictEqual(sameConcrete._tag, 'Substituted')
    if (sameConcrete._tag === 'Substituted')
      assert.strictEqual(RowAlgebra.equals(policy, concrete.row, sameConcrete.row), true)
  }

  const invalid = RowAlgebra.substitute(policy, expression, {
    row: noRows,
    member: () => ({ _tag: 'InvalidSingleton', reason: 'expected one nominal failure' }),
  })
  assert.deepEqual(invalid, {
    _tag: 'InvalidMembers',
    invalid: [
      {
        key: 'FailureMember:S',
        reason: 'expected one nominal failure',
        origins: [origin],
      },
    ],
  })
})

it('applies safe cancellation only in domains that opt into set laws', () => {
  const finite: FiniteRow.Policy<string> = {
    collisionKey: (member) => member,
    memberKey: (member) => member,
    merge: (left) => left,
  }
  const makePolicy = (
    allowsSetCancellation: boolean,
  ): RowAlgebra.Policy<string, string, string, string> => ({
    finite,
    concreteMemberMaySpecialize: () => false,
    rowParameterKey: (parameter) => parameter,
    symbolicMemberKey: (member) => member,
    symbolicMemberParameters: (member) => [member],
    memberParameterKey: (parameter) => parameter,
    memberWellFormedKey: (member) => member,
    allowsSetCancellation,
  })
  const setPolicy = makePolicy(true)
  const accessPolicy = makePolicy(false)
  const a = RowAlgebra.parameter<string, string, string>('A')
  const b = RowAlgebra.parameter<string, string, string>('B')
  const source = RowAlgebra.union(setPolicy, a, b)
  const cancelled = RowAlgebra.without(setPolicy, source, a)
  const retained = RowAlgebra.without(accessPolicy, source, a)

  assert.strictEqual(
    RowAlgebra.encode(setPolicy, cancelled, String, String, String),
    'Without<B, A>',
  )
  assert.strictEqual(
    RowAlgebra.encode(accessPolicy, retained, String, String, String),
    'Without<A | B, A>',
  )
})

it('keeps failure and fixed-role requirement member parameters domain-specific', () => {
  const owner = { module: 'work', name: 'generic' }
  const s = Type.parameter(owner, 0, 'S')
  const p = Type.parameter(owner, 1, 'P')
  const q = Type.parameter(owner, 2, 'Q')
  const origin = span('main', 8, 9)
  const failurePolicy = Type.failureRowPolicy()
  const requirementPolicy = Type.requirementRowPolicy()
  const failure = RowAlgebra.singleton(failurePolicy, Type.failureMemberShape(s), origin)
  const requirement = RowAlgebra.singleton(
    requirementPolicy,
    Type.requirementMemberShape(p, 'Exclusive', 'Audit'),
    origin,
  )

  assert.deepEqual(RowAlgebra.parameters(failurePolicy, failure), {
    rows: [],
    members: [s],
  })
  assert.deepEqual(RowAlgebra.parameters(requirementPolicy, requirement), {
    rows: [],
    members: [p],
  })
  assert.strictEqual(
    RowAlgebra.encode(
      requirementPolicy,
      requirement,
      (member) => `${member.access}:${Type.encode(member.capability)}@${member.role}`,
      Type.encode,
      (member) => `${member.access}:${member.capability.name}@${member.role}`,
    ),
    'Exclusive:P@Audit',
  )

  const residual = RowAlgebra.substitute(requirementPolicy, requirement, {
    row: () => undefined,
    member: (member) => ({
      _tag: 'Residual',
      member: Type.requirementMemberShape(q, member.access, member.role),
    }),
  })
  assert.strictEqual(residual._tag, 'Substituted')
  if (residual._tag === 'Substituted')
    assert.deepEqual(RowAlgebra.parameters(requirementPolicy, residual.row), {
      rows: [],
      members: [q],
    })

  const logger = Type.nominal('silk/logger', 'Logger')
  const concreteRequirement = RowAlgebra.substitute(requirementPolicy, requirement, {
    row: () => undefined,
    member: (member) => ({
      _tag: 'Concrete',
      member: { capability: logger, access: member.access, role: member.role },
    }),
  })
  assert.strictEqual(concreteRequirement._tag, 'Substituted')
  if (concreteRequirement._tag === 'Substituted') {
    const finite = RowAlgebra.concretize(requirementPolicy, concreteRequirement.row)
    assert.strictEqual(finite._tag, 'Concrete')
    if (finite._tag === 'Concrete')
      assert.deepEqual(finite.row.members, [
        { capability: logger, access: 'Exclusive', role: 'Audit' },
      ])
  }

  const invalid = RowAlgebra.substitute(requirementPolicy, requirement, {
    row: () => undefined,
    member: () => ({
      _tag: 'InvalidSingleton',
      reason: 'requirement capability must specialize to a service nominal',
    }),
  })
  assert.strictEqual(invalid._tag, 'InvalidMembers')

  const invalidFailure = RowAlgebra.substitute(failurePolicy, failure, {
    row: () => undefined,
    member: () => ({
      _tag: 'InvalidSingleton',
      reason: 'failure member specialized to a union',
    }),
  })
  assert.strictEqual(invalidFailure._tag, 'InvalidMembers')
})

it('keys callable contracts and branded constraint evidence without source locations', () => {
  const owner = { module: 'work', name: 'provide' }
  const selectedParameter = Type.parameter(owner, 0, 'S', 'RequirementRow')
  const providerParameter = Type.parameter(owner, 1, 'P')
  const logger = Type.nominal('silk/logger', 'Logger')
  const clock = Type.nominal('work', 'Clock')
  const loggerRequirement: Type.Requirement = {
    capability: logger,
    role: 'Default',
    access: 'Exclusive',
  }
  const selected = RowAlgebra.parameter<
    Type.Requirement,
    Type.Parameter,
    Type.RequirementMemberShape
  >(selectedParameter)
  const loggerSource = RowAlgebra.concrete(Type.requirementRowPolicy(), [loggerRequirement])
  const clockSource = RowAlgebra.concrete(Type.requirementRowPolicy(), [
    { capability: clock, role: 'Default', access: 'Exclusive' },
  ])
  const loggerWanted = Constraint.providerSelection(
    'Exclusive',
    providerParameter,
    selected,
    loggerSource,
  )
  const clockWanted = Constraint.providerSelection(
    'Exclusive',
    providerParameter,
    selected,
    clockSource,
  )
  const loggerEvidence = Constraint.requirementSelectionEvidence(loggerWanted, loggerRequirement, {
    _tag: 'Identity',
  })
  const clockEvidence = Constraint.requirementSelectionEvidence(
    clockWanted,
    { capability: clock, role: 'Default', access: 'Exclusive' },
    { _tag: 'Identity' },
  )

  assert.notStrictEqual(Constraint.key(loggerWanted), Constraint.key(clockWanted))
  assert.notStrictEqual(loggerEvidence.wantedKey, clockEvidence.wantedKey)
  assert.notStrictEqual(
    Constraint.evidenceKey(loggerEvidence),
    Constraint.evidenceKey(clockEvidence),
  )
  assert.strictEqual(
    Constraint.evidenceKey(loggerEvidence),
    Constraint.evidenceKey(
      Constraint.requirementSelectionEvidence(loggerWanted, loggerRequirement, {
        _tag: 'Identity',
      }),
    ),
  )

  const contract = CallableContract.make({
    ...detached,
    functionKind: 'Effect',
    binders: [selectedParameter, providerParameter],
    parameters: [
      {
        type: Type.reference('Exclusive', providerParameter, Lifetime.staticLifetime),
        mode: 'Exclusive',
      },
    ],
    result: Type.effect('never', [], detached),
    constraints: [loggerWanted],
    captures: [{ parameter: 0, capture: 0 }],
  })
  assert.strictEqual(CallableContract.key(contract), CallableContract.key(contract))
  const quantified = Type.callable(
    [Type.reference('Exclusive', providerParameter, Lifetime.staticLifetime)],
    Type.effect('never', [], detached),
    detached,
    'Exclusive',
    {
      contract,
      binders: contract.binders,
      constraints: contract.constraints,
      evidence: [Constraint.assumed(loggerWanted, new Map())],
      substitution: new Map(),
      contractKey: CallableContract.key(contract),
      constraintKeys: contract.constraints.map(Constraint.key),
      evidenceKeys: [Constraint.evidenceKey(Constraint.assumed(loggerWanted, new Map()))],
      origins: [locationAt('work', 1)],
    },
  )
  const movedOrigin = Type.callable(
    quantified.parameters,
    quantified.result,
    detached,
    quantified.mode,
    quantified.schema === undefined
      ? undefined
      : { ...quantified.schema, origins: [locationAt('work', 2)] },
  )
  assert.deepEqual(Type.parameters(quantified), [])
  assert.strictEqual(Type.isConcrete(quantified), true)
  assert.strictEqual(Type.key(quantified), Type.key(movedOrigin))
  assert.notStrictEqual(
    Type.key(quantified),
    Type.key(Type.callable(quantified.parameters, quantified.result, detached, quantified.mode)),
  )
})

it('keeps neutral witness identity specialization-complete and origin-distinct', () => {
  const declaration = { module: 'work', name: 'loggerWitness' }
  const sourceI32: Constraint.WitnessIdentity = {
    origin: { _tag: 'SourceWitness', declaration },
    typeArguments: ['i32'],
  }
  const sourceBool: Constraint.WitnessIdentity = {
    origin: { _tag: 'SourceWitness', declaration },
    typeArguments: ['bool'],
  }
  const intrinsic: Constraint.WitnessIdentity = {
    origin: { _tag: 'IntrinsicWitness', operation: 'work.loggerWitness' },
    typeArguments: ['i32'],
  }

  assert.notStrictEqual(Constraint.witnessKey(sourceI32), Constraint.witnessKey(sourceBool))
  assert.notStrictEqual(Constraint.witnessKey(sourceI32), Constraint.witnessKey(intrinsic))
  assert.notStrictEqual(
    Constraint.providerMatchKey({ _tag: 'Identity' }),
    Constraint.providerMatchKey({ _tag: 'Conformance', witness: sourceI32 }),
  )
})

it('keeps a free parameter open when a nested callable schema binds the same parameter', () => {
  const parameter = Type.parameter({ module: 'work', name: 'wrap' }, 0, 'T')
  const contract = CallableContract.make({
    ...detached,
    functionKind: 'Function',
    binders: [parameter],
    parameters: [{ type: parameter, mode: 'Shared' }],
    result: parameter,
  })
  const quantified = Type.callable([parameter], parameter, detached, 'Shared', {
    contract,
    binders: [parameter],
    constraints: [],
    evidence: [],
    substitution: new Map(),
    contractKey: CallableContract.key(contract),
    constraintKeys: [],
    evidenceKeys: [],
    origins: [locationAt('work')],
  })
  assert.deepEqual(Type.parameters(quantified), [])
  assert.strictEqual(Type.isConcrete(quantified), true)

  const wrapped = Type.callable([parameter], quantified, detached)
  assert.deepEqual(Type.parameters(wrapped), [parameter])
  assert.strictEqual(Type.isConcrete(wrapped), false)
})

it('retains pointer qualifiers through identity, inference and safe weakening', () => {
  const constI32 = Type.pointer({
    mutable: false,
    pointee: 'i32',
    nullable: false,
    extent: 'Single',
    alignment: 'Natural',
    addressSpace: 0,
  })
  const mutI32 = Type.pointer({
    mutable: true,
    pointee: 'i32',
    nullable: false,
    extent: 'Single',
    alignment: 'Natural',
    addressSpace: 0,
  })
  const constU32 = Type.pointer({
    mutable: false,
    pointee: 'u32',
    nullable: false,
    extent: 'Single',
    alignment: 'Natural',
    addressSpace: 0,
  })

  assert.deepEqual([constI32, mutI32, constU32].map(Type.key), [
    'pointer:Single:const:nonnull:Natural:0<builtin:i32>',
    'pointer:Single:mut:nonnull:Natural:0<builtin:i32>',
    'pointer:Single:const:nonnull:Natural:0<builtin:u32>',
  ])
  assert.deepEqual([constI32, mutI32, constU32].map(Type.encode), [
    '*const i32',
    '*mut i32',
    '*const u32',
  ])
  const nullable = Type.pointer({ ...constI32, nullable: true })
  const many = Type.pointer({ ...constI32, extent: 'Many' })
  const unaligned = Type.pointer({ ...constI32, alignment: 1 })
  assert.strictEqual(new Set([constI32, nullable, many, unaligned].map(Type.key)).size, 4)
  assert.strictEqual(new Set([constI32, nullable, many, unaligned].map(Type.runtimeKey)).size, 4)
  assert.strictEqual(TypeCompatibility.check(constI32, nullable)._tag, 'PointerWeakening')
  assert.strictEqual(TypeCompatibility.check(nullable, constI32)._tag, 'Incompatible')
  assert.strictEqual(TypeCompatibility.check(constI32, many)._tag, 'Incompatible')
  assert.strictEqual(TypeCompatibility.check(many, constI32)._tag, 'Incompatible')
  assert.strictEqual(TypeCompatibility.check(constI32, unaligned)._tag, 'PointerWeakening')
  assert.strictEqual(TypeCompatibility.check(unaligned, constI32)._tag, 'Incompatible')
  assert.strictEqual(Type.isViewBorrow(mutI32), false)
  assert.strictEqual(Type.containsBorrow(mutI32), false)
  assert.strictEqual(Type.containsBorrowWrapper(mutI32), false)

  const mutU8 = Type.pointer({
    mutable: true,
    pointee: 'u8',
    nullable: false,
    extent: 'Single',
    alignment: 'Natural',
    addressSpace: 0,
  })
  const constU8 = Type.pointer({
    mutable: false,
    pointee: 'u8',
    nullable: false,
    extent: 'Single',
    alignment: 'Natural',
    addressSpace: 0,
  })
  assert.strictEqual(TypeCompatibility.check(mutU8, constU8)._tag, 'PointerWeakening')
  assert.strictEqual(TypeCompatibility.check(constU8, mutU8)._tag, 'Incompatible')
  assert.strictEqual(
    TypeCompatibility.check(
      Type.pointer({
        mutable: true,
        pointee: mutU8,
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
      Type.pointer({
        mutable: true,
        pointee: constU8,
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    )._tag,
    'Incompatible',
  )

  assert.strictEqual(
    TypeInference.infer(
      Type.pointer({ ...constI32, pointee: nullable }),
      Type.pointer({ ...constI32, pointee: constI32 }),
      new Map(),
    ),
    false,
  )
  const aligned = Type.pointer({ ...constI32, alignment: 16 })
  assert.strictEqual(
    TypeCompatibility.check(aligned, Type.pointer({ ...aligned, alignment: 4 }))._tag,
    'PointerWeakening',
  )
  assert.strictEqual(TypeCompatibility.check(unaligned, aligned)._tag, 'Incompatible')

  const parameter = Type.parameter({ module: 'test', name: 'identity' }, 0, 'T')
  const inferred = new Map<string, Type.GenericArgument>()
  assert.strictEqual(
    TypeInference.infer(
      Type.pointer({
        mutable: false,
        pointee: parameter,
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
      mutI32,
      inferred,
    ),
    true,
  )
  assert.strictEqual(
    Type.genericArgumentKey(inferred.get(Type.key(parameter)) ?? 'never'),
    'builtin:i32',
  )
  assert.strictEqual(
    TypeInference.infer(
      Type.pointer({
        mutable: true,
        pointee: parameter,
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
      constI32,
      new Map(),
    ),
    false,
  )
  assert.strictEqual(
    Type.key(
      Type.substitute(
        Type.pointer({
          mutable: true,
          pointee: parameter,
          nullable: false,
          extent: 'Single',
          alignment: 'Natural',
          addressSpace: 0,
        }),
        new Map([[Type.key(parameter), 'u32']]),
      ),
    ),
    Type.key(
      Type.pointer({
        mutable: true,
        pointee: 'u32',
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    ),
  )
})

it('preserves lifetime arguments through generic substitution and erases only runtime identity', () => {
  const owner = { module: 'lifetimes', name: 'transport' }
  const first = Lifetime.bound(owner, 0, 'data')
  const second = Lifetime.local(owner, 'call', 0)
  const binder = Type.parameter(owner, 0, 'data', 'Lifetime')
  const source = Type.nominal('lifetimes', 'Holder', [
    first,
    Type.fixedArray(Type.reference('Shared', Type.string(first), first), 2),
  ])
  const substitution =
    TypeInference.prefixSubstitution([binder], [second]) ??
    unreachable('expected a lifetime-kind substitution')
  const result = Type.substitute(source, substitution)
  assert.strictEqual(Type.key(binder), Lifetime.key(first))
  assert.deepEqual(Type.parameterArgument(binder), first)
  assert.notStrictEqual(Type.key(source), Type.key(result))
  assert.strictEqual(Type.runtimeKey(source), Type.runtimeKey(result))
  assert.deepEqual(Type.lifetimes(result), [second])
  assert.isFalse(Type.isTypeArgument(first))

  const effect = Type.effect(source, [], {
    environment: first,
    lifetimeBinders: [],
    lifetimeBounds: [{ longer: first, shorter: second }],
  })
  const represented = Type.represented(
    effect,
    effect,
    Type.exactRepresentationArgument(
      Type.effectIdentityArgument('lifetimes/transport', {
        declaration: owner,
        typeArguments: [first, source],
        staticArgumentKeys: [],
      }),
      effect,
    ),
  )
  const updated = Type.substitute(represented, substitution)
  assert.deepEqual(Type.lifetimes(updated), [second])
  assert.notStrictEqual(Type.key(represented), Type.key(updated))
  assert.strictEqual(Type.runtimeKey(represented), Type.runtimeKey(updated))
  assert.isUndefined(TypeInference.prefixSubstitution([binder], ['i32']))
})

it('checks declared lifetime covariance while keeping mutable storage and cache assumptions invariant', () => {
  const owner = { module: 'lifetimes', name: 'variance' }
  const long = Lifetime.bound(owner, 0, 'long')
  const short = Lifetime.bound(owner, 1, 'short')
  const longView = Type.reference('Shared', 'i32', long)
  const shortView = Type.reference('Shared', 'i32', short)
  const holder = Type.nominal('lifetimes', 'Holder', [longView])
  const shorterHolder = Type.nominal('lifetimes', 'Holder', [shortView])
  const assumptions = Lifetime.assumptions([{ longer: long, shorter: short }])
  const context = TypeCompatibility.context({
    assumptions,
    nominalVariance: new Map([[TypeCompatibility.nominalVarianceKey(holder), ['Covariant']]]),
  })
  assert.isTrue(
    TypeCompatibility.isCompatible(TypeCompatibility.check(holder, shorterHolder, context)),
  )
  assert.isTrue(
    TypeCompatibility.isCompatible(TypeCompatibility.check(holder, shorterHolder, context)),
  )
  assert.strictEqual(context.work.cacheHits, 1)
  assert.isFalse(
    TypeCompatibility.isCompatible(TypeCompatibility.check(shorterHolder, holder, context)),
  )
  assert.isFalse(TypeCompatibility.isCompatible(TypeCompatibility.check(holder, shorterHolder)))
  assert.isFalse(
    TypeCompatibility.isCompatible(
      TypeCompatibility.check(
        Type.reference('Exclusive', holder, long),
        Type.reference('Exclusive', shorterHolder, short),
        context,
      ),
    ),
  )
  assert.isTrue(
    TypeCompatibility.isCompatible(
      TypeCompatibility.check(Type.string(long), Type.string(short), context),
    ),
  )
  assert.isFalse(
    TypeCompatibility.isCompatible(
      TypeCompatibility.check(Type.string(short), Type.string(long), context),
    ),
  )
})

it('checks finite callable binders with rigid placeholders and rejects stronger bounds or nested quantification', () => {
  const offeredOwner = { module: 'lifetimes', name: 'offered' }
  const expectedOwner = { module: 'lifetimes', name: 'expected' }
  const a = Lifetime.bound(offeredOwner, 0, 'a')
  const b = Lifetime.bound(offeredOwner, 1, 'b')
  const x = Lifetime.bound(expectedOwner, 0, 'x')
  const y = Lifetime.bound(expectedOwner, 1, 'y')
  const make = (
    first: Lifetime.Bound,
    second: Lifetime.Bound,
    bounds: ReadonlyArray<Lifetime.Outlives>,
  ) =>
    Type.callable(
      [Type.reference('Shared', 'i32', first)],
      Type.reference('Shared', 'i32', second),
      {
        environment: Lifetime.staticLifetime,
        lifetimeBinders: [first, second],
        lifetimeBounds: bounds,
      },
    )
  const offered = make(a, b, [{ longer: a, shorter: b }])
  const expected = make(x, y, [{ longer: x, shorter: y }])
  assert.isTrue(TypeCompatibility.isCompatible(TypeCompatibility.check(offered, expected)))
  const inference = new Map<string, Type.GenericArgument>()
  assert.isTrue(TypeInference.infer(expected, offered, inference))
  assert.strictEqual(inference.size, 0)
  assert.isFalse(TypeInference.infer(make(x, y, []), offered, new Map()))
  assert.isFalse(
    TypeCompatibility.isCompatible(
      TypeCompatibility.check(make(a, b, [{ longer: b, shorter: a }]), expected),
    ),
  )
  assert.isFalse(TypeCompatibility.isCompatible(TypeCompatibility.check(offered, make(x, y, []))))
  assert.strictEqual(
    Type.key(
      Type.substituteLifetimes(offered, new Map([[Lifetime.key(a), Lifetime.staticLifetime]])),
    ),
    Type.key(offered),
  )
  assert.deepEqual(Type.freeLifetimes(offered), [Lifetime.staticLifetime])
  const nested = Type.callable([offered], 'i32', {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [x],
  })
  assert.isFalse(TypeCompatibility.isCompatible(TypeCompatibility.check(nested, nested)))
  assert.isFalse(TypeInference.infer(nested, nested, new Map()))
  const consumer = Type.callable([offered], 'i32', detached)
  assert.isTrue(TypeCompatibility.isCompatible(TypeCompatibility.check(consumer, consumer)))
  assert.isTrue(
    TypeCompatibility.isCompatible(
      TypeCompatibility.check(consumer, Type.callable([expected], 'i32', detached)),
    ),
  )
  const escaping = Type.callable(
    [Type.reference('Shared', 'i32', a)],
    Type.reference('Shared', 'i32', a),
    { environment: a, lifetimeBinders: [] },
  )
  const universal = Type.callable(
    [Type.reference('Shared', 'i32', x)],
    Type.reference('Shared', 'i32', x),
    { environment: Lifetime.staticLifetime, lifetimeBinders: [x] },
  )
  assert.isFalse(TypeCompatibility.isCompatible(TypeCompatibility.check(escaping, universal)))
  const selected = Type.callable(
    [Type.reference('Shared', 'i32', y)],
    Type.reference('Shared', 'i32', y),
    detached,
  )
  assert.isTrue(TypeCompatibility.isCompatible(TypeCompatibility.check(universal, selected)))
  const selectedInference = new Map<string, Type.GenericArgument>()
  assert.isTrue(TypeInference.infer(selected, universal, selectedInference))
  assert.deepEqual([...selectedInference], [[Lifetime.key(y), y]])
  const restricted = Type.callable(universal.parameters, universal.result, {
    ...universal,
    lifetimeBounds: [{ longer: x, shorter: Lifetime.staticLifetime }],
  })
  assert.isFalse(TypeCompatibility.isCompatible(TypeCompatibility.check(restricted, selected)))
  assert.isFalse(TypeInference.infer(selected, restricted, new Map()))
  const outerType = Type.parameter(offeredOwner, 2, 'T')
  const typeRestricted = Type.callable(universal.parameters, universal.result, {
    ...universal,
    typeOutlives: [{ type: outerType, lifetime: x }],
  })
  assert.isFalse(TypeCompatibility.isCompatible(TypeCompatibility.check(typeRestricted, selected)))
  assert.isFalse(TypeInference.infer(selected, typeRestricted, new Map()))
  const captured = Type.callable(universal.parameters, universal.result, {
    ...universal,
    environment: a,
  })
  assert.isFalse(TypeCompatibility.isCompatible(TypeCompatibility.check(captured, selected)))
  assert.isFalse(TypeInference.infer(selected, captured, new Map()))
})

it('keeps intersection invocation regions rigid while shortening free capture validity', () => {
  const owner = { module: 'lifetimes', name: 'scoped-environment' }
  const env = Lifetime.bound(owner, 0, 'env')
  const call = Lifetime.bound(owner, 1, 'call')
  const other = Lifetime.bound({ ...owner, name: 'other' }, 0, 'other')
  const local = Lifetime.local(owner, 'capture', 0)
  const make = (scope: Lifetime.Bound, capture: Lifetime.Lifetime) =>
    Type.callable(
      [Type.reference('Exclusive', 'i32', scope)],
      Type.effect(
        'i32',
        [],
        { environment: Lifetime.intersection([scope, capture]), lifetimeBinders: [] },
        'Take',
      ),
      { environment: capture, lifetimeBinders: [scope] },
      'Take',
    )
  const offered = make(call, env)
  const alpha = make(other, env)
  assert.strictEqual(Type.key(offered), Type.key(make(Lifetime.bound(owner, 1, 'renamed'), env)))
  assert.isTrue(TypeCompatibility.isCompatible(TypeCompatibility.check(offered, alpha)))
  assert.deepEqual(Type.freeLifetimes(offered).map(Lifetime.key), [Lifetime.key(env)])
  const obligations: Array<Lifetime.Outlives> = []
  const context = TypeCompatibility.context({
    outlives: (longer, shorter) =>
      longer._tag === 'LocalLifetime' || shorter._tag === 'LocalLifetime',
    commitOutlives: (longer, shorter) => obligations.push({ longer, shorter }),
  })
  assert.isTrue(
    TypeCompatibility.isCompatible(TypeCompatibility.check(offered, make(other, local), context)),
  )
  assert.isNotEmpty(obligations)
  assert.isTrue(
    obligations.every((bound) =>
      [bound.longer, bound.shorter].every(
        (region) => region._tag !== 'PlaceholderLifetime' && region._tag !== 'IntersectionLifetime',
      ),
    ),
  )
  const promoted = Type.callable(
    alpha.parameters,
    Type.effect('i32', [], { environment: other, lifetimeBinders: [] }, 'Take'),
    alpha,
    'Take',
  )
  assert.isFalse(
    TypeCompatibility.isCompatible(TypeCompatibility.check(offered, promoted, context)),
  )
  assert.strictEqual(TypeInference.inferenceFailure(promoted, offered)?._tag, 'EnvironmentMismatch')
  assert.isFalse(
    TypeCompatibility.isCompatible(
      TypeCompatibility.check(
        Type.reference('Exclusive', offered.result, Lifetime.staticLifetime),
        Type.reference('Exclusive', promoted.result, Lifetime.staticLifetime),
        context,
      ),
    ),
  )
  const result = Type.parameter(owner, 2, 'A')
  const escape = Type.callable(alpha.parameters, result, alpha, 'Take')
  assert.isFalse(TypeInference.infer(escape, offered, new Map()))
  const literal = Type.callable(
    alpha.parameters,
    alpha.result,
    { ...alpha, lifetimeBinders: [] },
    'Take',
  )
  assert.isTrue(Type.lifetimes(literal).some((region) => Lifetime.equals(region, other)))
})

it('infers a selected call with a common local region and preserves mutable pointee invariance', () => {
  const owner = { module: 'lifetimes', name: 'selected' }
  const a = Lifetime.bound(owner, 0, 'a')
  const left = Lifetime.bound({ module: 'lifetimes', name: 'caller' }, 0, 'left')
  const right = Lifetime.bound({ module: 'lifetimes', name: 'caller' }, 1, 'right')
  const common = Lifetime.local(owner, 'Call:0', 0)
  const obligations: Array<Lifetime.Outlives> = []
  const context = TypeCompatibility.context({
    assumptions: Lifetime.assumptions([{ longer: left, shorter: right }]),
    outlives: (longer, shorter) => {
      if (longer._tag !== 'LocalLifetime' && shorter._tag !== 'LocalLifetime') return false
      obligations.push({ longer, shorter })
      return true
    },
  })
  const inference: TypeInference.LifetimeInference = {
    accepts: (source, target, invariant) =>
      TypeCompatibility.isCompatible(
        TypeCompatibility.check(Type.string(source), Type.string(target), context),
      ) &&
      (!invariant ||
        TypeCompatibility.isCompatible(
          TypeCompatibility.check(Type.string(target), Type.string(source), context),
        )),
  }
  const inferred = new Map<string, Type.GenericArgument>([[Lifetime.key(a), common]])
  const parameter = Type.reference('Shared', 'i32', a)
  assert.isTrue(
    TypeInference.infer(parameter, Type.reference('Shared', 'i32', left), inferred, inference),
  )
  assert.isTrue(
    TypeInference.infer(parameter, Type.reference('Shared', 'i32', right), inferred, inference),
  )
  assert.deepEqual(Type.substitute(parameter, inferred), Type.reference('Shared', 'i32', common))
  assert.deepEqual(obligations, [
    { longer: left, shorter: common },
    { longer: right, shorter: common },
  ])
  assert.isFalse(
    TypeInference.infer(
      Type.reference('Exclusive', Type.string(right), Lifetime.staticLifetime),
      Type.reference('Exclusive', Type.string(left), Lifetime.staticLifetime),
      new Map(),
      inference,
    ),
  )
  assert.isTrue(
    TypeInference.infer(
      Type.reference('Exclusive', Type.string(a), Lifetime.staticLifetime),
      Type.reference('Exclusive', Type.string(left), Lifetime.staticLifetime),
      inferred,
      inference,
    ),
  )
  assert.isTrue(
    obligations.some(
      (bound) => Lifetime.equals(bound.longer, common) && Lifetime.equals(bound.shorter, left),
    ),
  )
})

it.effect(
  'checks finite borrowed uses and return escapes without inferring a public lifetime contract',
  () =>
    Effect.gen(function* () {
      const source = `fn identity<'a>(value: &'a i32) -> &'a i32 { return value }
fn invalid() -> &'static i32 { let local = 1 let view = &local return view }
fn caller() -> i32 { let local = 2 let view = identity(&local) return view.* }`
      const snapshot = yield* Analysis.ofSource(
        'lifetimes/flow',
        Uint8Array.from(source, (character) => character.charCodeAt(0)),
      )
      const diagnostics = Analysis.diagnostics(snapshot)
      assert.include(
        diagnostics.map((diagnostic) => diagnostic.code),
        Diagnostic.expiredLifetimeCode,
      )
      assert.include(
        diagnostics
          .filter((diagnostic) => diagnostic.code === Diagnostic.expiredLifetimeCode)
          .map((diagnostic) => diagnostic.span.start),
        source.indexOf('return view') + 'return '.length,
      )
      assert.isFalse(
        diagnostics.some((diagnostic) => diagnostic.span.start >= source.indexOf('fn caller')),
      )
      const functions = records(Analysis.rootAnalysis(snapshot)).functions
      const valid = functions.find(
        (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'caller',
      )
      assert.strictEqual(valid?.lifetimeFlow?.solution._tag, 'Solved')
      assert.deepEqual(valid?.lifetimeFlow?.diagnostics, [])
    }),
)

it.effect('derives finite nominal variance from shared, exclusive and callable storage', () =>
  Effect.gen(function* () {
    const source = `struct Shared<'a> { value: &'a i32 }
struct Mutable<'a> { value: &'static mut &'a i32 }
struct Callback<'a> { value: fn<'static>(&'a i32) -> i32 }`
    const snapshot = yield* Analysis.ofSource(
      'lifetimes/variance',
      Uint8Array.from(source, (character) => character.charCodeAt(0)),
    )
    const derived = NominalVariance.derive(snapshot.index)
    assert.deepEqual(
      derived.summaries.get(
        TypeCompatibility.nominalVarianceKey(Type.nominal('lifetimes/variance', 'Shared')),
      ),
      ['Covariant'],
    )
    assert.deepEqual(
      derived.summaries.get(
        TypeCompatibility.nominalVarianceKey(Type.nominal('lifetimes/variance', 'Mutable')),
      ),
      ['Invariant'],
    )
    assert.deepEqual(
      derived.summaries.get(
        TypeCompatibility.nominalVarianceKey(Type.nominal('lifetimes/variance', 'Callback')),
      ),
      ['Contravariant'],
    )
    assert.strictEqual(NominalVariance.derive(snapshot.index), derived)
  }),
)

it.effect(
  'retains every selected input source through borrowed aggregate and multi-source returns',
  () =>
    Effect.gen(function* () {
      const source = `struct Pair<'a> { left: &'a i32 right: &'a i32 }
fn choose<'a>(left: &'a i32, right: &'a i32, flag: bool) -> &'a i32 {
  if flag { return left } return right
}
fn pair<'a>(left: &'a i32, right: &'a i32) -> Pair<'a> { return Pair<'a> { left: left, right: right } }
fn caller() -> i32 {
  let left = 1 let right = 2
  let selected = choose(&left, &right, true)
  let values = pair(&left, &right)
  return values.left.*
}`
      const snapshot = yield* Analysis.ofSource(
        'lifetimes/selected',
        Uint8Array.from(source, (character) => character.charCodeAt(0)),
      )
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => ({
          code: diagnostic.code,
          span: diagnostic.span.start,
        })),
        [],
      )
      const caller =
        records(Analysis.rootAnalysis(snapshot)).functions.at(-1) ?? unreachable('caller body')
      const flow = caller.lifetimeFlow ?? unreachable('finite lifetime proof')
      assert.strictEqual(flow.solution._tag, 'Solved')
      assert.deepEqual(flow.diagnostics, [])
      const parentCounts = new Map<string, number>()
      for (const edge of flow.input.constraints)
        if (edge.shorter._tag === 'LocalLifetime' && edge.shorter.context.startsWith('Call:'))
          parentCounts.set(
            Lifetime.key(edge.shorter),
            (parentCounts.get(Lifetime.key(edge.shorter)) ?? 0) + 1,
          )
      assert.isTrue([...parentCounts.values()].some((count) => count >= 2))
      const selected = caller.bindings.find((binding) => binding.name === 'selected')
      assert.isDefined(selected)
      if (selected !== undefined) {
        const sources = LifetimeFlow.sources(flow, selected.type)
        assert.strictEqual(
          new Set(
            sources.flatMap((origin) =>
              origin.root?._tag === 'Let' ? [origin.root.binding.ordinal] : [],
            ),
          ).size,
          2,
        )
        assert.strictEqual(LifetimeFlow.sources(flow, selected.type), sources)
      }
    }),
)

it.effect('rejects a borrowed temporary which escapes its full expression', () =>
  Effect.gen(function* () {
    const source = `fn invalid() -> &'static [i32] { let view = &[1, 2] return view }`
    const snapshot = yield* Analysis.ofSource(
      'lifetimes/temporary',
      Uint8Array.from(source, (character) => character.charCodeAt(0)),
    )
    assert.include(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      Diagnostic.expiredLifetimeCode,
    )
  }),
)

it.effect('releases a replaced local reference before its former source expires', () =>
  Effect.gen(function* () {
    const source = `fn reset() -> i32 {
  let outer = 1
  let mut view = &outer
  if true { let inner = 2 view = &inner view = &outer }
  return view.*
}`
    const snapshot = yield* Analysis.ofSource(
      'lifetimes/reset',
      Uint8Array.from(source, (character) => character.charCodeAt(0)),
    )
    assert.deepStrictEqual(Analysis.diagnostics(snapshot), [])
  }),
)

it('separates stored executable environments from hypothetical outcome and invocation lifetimes', () => {
  const owner = { module: 'lifetimes/storage', name: 'value' }
  const a = Lifetime.bound(owner, 0, 'a')
  const b = Lifetime.bound(owner, 1, 'b')
  const callable = Type.callable([Type.reference('Shared', 'i32', a)], Type.string(b), {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [a],
    lifetimeBounds: [{ longer: a, shorter: b }],
  })
  assert.deepEqual(Type.storageLifetimes(callable), [Lifetime.staticLifetime])
  assert.includeMembers(Type.lifetimes(callable).map(Lifetime.key), [
    Lifetime.key(a),
    Lifetime.key(b),
  ])
  assert.strictEqual(Type.encode(callable), "for<'a: 'b> fn<'static>(&'a i32) -> string<'b>")
  const effect = Type.effect(Type.string(b), [], detached)
  assert.deepEqual(Type.storageLifetimes(effect), [Lifetime.staticLifetime])
  const promised = Type.parameter(
    owner,
    2,
    'F',
    'EffectRepresentation',
    Type.effect(Type.string(a), [], { environment: b, lifetimeBinders: [] }),
    ['Intrinsic.Detached'],
  )
  const represented =
    Type.representedType(Type.representationParameterArgument(promised)) ??
    unreachable('represented Effect')
  assert.deepEqual(Type.storageLifetimes(represented), [Lifetime.staticLifetime])
  assert.includeMembers(Type.freeLifetimes(represented).map(Lifetime.key), [
    Lifetime.key(a),
    Lifetime.key(b),
  ])
  assert.deepEqual(Type.storageLifetimes(Type.nominal('test', 'Holder', [Type.string(b)])), [b])
  const inferred = new Map<string, Type.GenericArgument>()
  assert.isTrue(TypeInference.infer(Type.string(a), Type.string(a), inferred))
  assert.strictEqual(inferred.get(Lifetime.key(a)), a)
})

it.effect('requires declared type outlives bounds at applied nominal storage boundaries', () =>
  Effect.gen(function* () {
    const source = `struct Holder<'a, T: 'a> { value: T marker: &'a i32 }
struct Reference<'a, T> { value: &'a T }
fn inherited<'a, T>(value: Holder<'a, T>) -> Holder<'a, T> { return move value }
fn borrowed<'a, T>(proof: &'a T) -> Reference<'a, T> { return Reference<'a, T> { value: proof } }
fn valid<'a, T: 'a>(value: Holder<'a, T>) -> i32 { return value.marker.* }
fn implied<'a, T>(value: T, proof: &'a T, marker: &'a i32) -> Holder<'a, T> { return Holder<'a, T> { value: move value, marker: marker } }
fn invalid<'a, T>(value: T, marker: &'a i32) -> Holder<'a, T> { return Holder<'a, T> { value: move value, marker: marker } }
fn concrete<'a>(value: Holder<'a, i32>) -> i32 { return value.marker.* }
fn expired<'a>(value: &'a i32, marker: &'static i32) -> Holder<'static, &'a i32> { return Holder<'static, &'a i32> { value: value, marker: marker } }`
    const snapshot = yield* Analysis.ofSource(
      'lifetimes/wellformed',
      Uint8Array.from(source, (character) => character.charCodeAt(0)),
    )
    const failures = Analysis.diagnostics(snapshot).filter(
      (diagnostic) => diagnostic.code === Diagnostic.unsatisfiedLifetimeBoundCode,
    )
    assert.isTrue(
      failures.some(
        (diagnostic) =>
          diagnostic.span.start >= source.indexOf('fn invalid') &&
          diagnostic.span.start < source.indexOf('fn concrete'),
      ),
    )
    assert.isTrue(
      failures.some((diagnostic) => diagnostic.span.start >= source.indexOf('fn expired')),
    )
    assert.isFalse(
      failures.some((diagnostic) => diagnostic.span.start < source.indexOf('fn invalid')),
    )
    assert.isFalse(
      failures.some(
        (diagnostic) =>
          diagnostic.span.start >= source.indexOf('fn concrete') &&
          diagnostic.span.start < source.indexOf('fn expired'),
      ),
    )
  }),
)

it.effect('keeps a borrowed pattern field tied to the outer referent across match arms', () =>
  Effect.gen(function* () {
    const source = `struct Left { value: [i32; 1] }
struct Right { value: [i32; 1] }
struct Both { value: Left | Right }
fn view<'a>(outer: &'a Both) -> &'a [i32] {
  return match &outer.value { Left { value } => &value Right { value } => &value }
}`
    const snapshot = yield* Analysis.ofSource(
      'lifetimes/pattern',
      Uint8Array.from(source, (character) => character.charCodeAt(0)),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((d) => ({ code: d.code, start: d.span.start })),
      [],
    )
  }),
)

it('binds authored lifetime and ordinary generic prefixes in independent namespaces', () => {
  const owner = { module: 'lifetimes/prefix', name: 'map' }
  const env = Type.parameter(owner, 0, 'env', 'Lifetime')
  const value = Type.parameter(owner, 1, 'A')
  const call = Type.parameter(owner, 2, 'call', 'Lifetime')
  const result = Type.parameter(owner, 3, 'B')
  const ordinary = TypeInference.prefixSubstitution([env, value, call, result], ['i32'])
  assert.strictEqual(ordinary?.get(Type.key(value)), 'i32')
  assert.isFalse(ordinary?.has(Type.key(env)))
  const supplied = TypeInference.prefixSubstitution(
    [env, value, call, result],
    ['i32', Lifetime.staticLifetime, 'bool'],
  )
  assert.strictEqual(supplied?.get(Type.key(env)), Lifetime.staticLifetime)
  assert.strictEqual(supplied?.get(Type.key(value)), 'i32')
  assert.strictEqual(supplied?.get(Type.key(result)), 'bool')
  assert.isUndefined(TypeInference.prefixSubstitution([env, value], ['i32', 'bool']))
})

it.effect('does not strengthen a universal lifetime through a local reborrow', () =>
  Effect.gen(function* () {
    const source = `fn invalid<'a>(value: &'a i32) -> &'static i32 { return &value.* }
fn valid<'a>(value: &'a i32) -> &'a i32 { return &value.* }`
    const snapshot = yield* Analysis.ofSource(
      'lifetimes/universal',
      Uint8Array.from(source, (character) => character.charCodeAt(0)),
    )
    const failures = Analysis.diagnostics(snapshot)
    assert.isTrue(
      failures.some(
        (diagnostic) =>
          diagnostic.code === Diagnostic.unsatisfiedLifetimeBoundCode &&
          diagnostic.span.start < source.indexOf('fn valid'),
      ),
    )
    assert.isFalse(
      failures.some((diagnostic) => diagnostic.span.start >= source.indexOf('fn valid')),
    )
  }),
)

it.effect('requires captured generic data to prove the returned callable environment', () =>
  Effect.gen(function* () {
    const source = `fn discard<T>(result: i32, value: T) -> i32 { return result }
fn invalid<T>(value: T) -> once fn<'static>(i32) -> i32 { return discard(move value) }
fn valid<'a, T: 'a>(value: T) -> once fn<'a>(i32) -> i32 { return discard(move value) }`
    const snapshot = yield* Analysis.ofSource(
      'lifetimes/generic-capture',
      Uint8Array.from(source, (character) => character.charCodeAt(0)),
    )
    const failures = Analysis.diagnostics(snapshot)
    assert.isTrue(
      failures.some(
        (diagnostic) =>
          diagnostic.code === Diagnostic.expiredLifetimeCode &&
          diagnostic.span.start >= source.indexOf('fn invalid') &&
          diagnostic.span.start < source.indexOf('fn valid'),
      ),
    )
    assert.isFalse(
      failures.some((diagnostic) => diagnostic.span.start >= source.indexOf('fn valid')),
    )
  }),
)

it.effect('keeps declared executable environment bounds in universal invocation checking', () =>
  Effect.gen(function* () {
    const source = `fn apply<'env>(use: for<'a> once fn<'env>(&'a i32) -> i32, value: &i32) -> i32 { return use(value) }`
    const snapshot = yield* Analysis.ofSource(
      'lifetimes/invoke',
      Uint8Array.from(source, (c) => c.charCodeAt(0)),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)

it('retains type outlives predicates through quantifier comparison, substitution and runtime erasure', () => {
  const owner = { module: 'lifetimes/predicates', name: 'source' }
  const value = Type.parameter(owner, 0, 'T')
  const a = Lifetime.bound(owner, 1, 'a')
  const b = Lifetime.bound({ ...owner, name: 'other' }, 0, 'b')
  const bare = Type.callable([], 'i32', { ...detached, lifetimeBinders: [a] })
  const required = Type.callable([], 'i32', {
    ...detached,
    lifetimeBinders: [a],
    typeOutlives: [{ type: value, lifetime: a }],
  })
  const renamed = Type.callable([], 'i32', {
    ...detached,
    lifetimeBinders: [b],
    typeOutlives: [{ type: value, lifetime: b }],
  })
  assert.isFalse(TypeCompatibility.isCompatible(TypeCompatibility.check(required, bare)))
  assert.isTrue(TypeCompatibility.isCompatible(TypeCompatibility.check(bare, required)))
  assert.isTrue(TypeCompatibility.isCompatible(TypeCompatibility.check(required, renamed)))
  assert.isFalse(TypeInference.infer(bare, required, new Map()))
  assert.isTrue(TypeInference.infer(required, renamed, new Map()))
  assert.notStrictEqual(Type.key(required), Type.key(bare))
  assert.strictEqual(Type.runtimeKey(required), Type.runtimeKey(bare))
  const changed = Type.substitute(required, new Map([[Type.key(value), 'i32']]))
  assert.isTrue(Type.isCallable(changed))
  if (Type.isCallable(changed)) assert.strictEqual(changed.typeOutlives.at(0)?.type, 'i32')
})

it('carries executable formation facts without assuming invocation predicates or strengthening environments', () => {
  const owner = { module: 'lifetimes/formation', name: 'retained' }
  const env = Lifetime.bound(owner, 0, 'env')
  const source = Lifetime.bound(owner, 1, 'source')
  const value = Type.parameter(owner, 2, 'T')
  const outer = Type.parameter({ ...owner, name: 'outer' }, 0, 'U')
  const plain = Type.callable([], 'i32', { environment: env, lifetimeBinders: [] })
  const retained = Type.callable([], 'i32', {
    ...plain,
    lifetimeBounds: [{ longer: source, shorter: env }],
    typeOutlives: [{ type: outer, lifetime: env }],
  })
  assert.isTrue(TypeCompatibility.isCompatible(TypeCompatibility.check(retained, plain)))
  assert.isTrue(TypeInference.infer(plain, retained, new Map()))
  const forgedEnvironment = Type.callable([], 'i32', {
    ...retained,
    lifetimeBounds: [{ longer: env, shorter: Lifetime.staticLifetime }],
  })
  assert.isFalse(
    TypeCompatibility.isCompatible(
      TypeCompatibility.check(forgedEnvironment, Type.callable([], 'i32', detached)),
    ),
  )
  assert.isFalse(
    TypeInference.infer(Type.callable([], 'i32', detached), forgedEnvironment, new Map()),
  )
  const contract = CallableContract.make({
    ...detached,
    functionKind: 'Function',
    binders: [value],
    parameters: [],
    result: 'i32',
    constraints: [],
    captures: [],
  })
  const schema: Type.CallableSchema = {
    contract,
    binders: contract.binders,
    constraints: [],
    evidence: [],
    substitution: new Map(),
    contractKey: CallableContract.key(contract),
    constraintKeys: [],
    evidenceKeys: [],
    origins: [],
  }
  const generic = Type.callable(
    [],
    'i32',
    {
      ...plain,
      typeOutlives: [{ type: value, lifetime: env }],
    },
    'Shared',
    schema,
  )
  assert.deepEqual(Type.executableFormationRequirements(generic).typeOutlives, [])
  assert.isFalse(TypeCompatibility.isCompatible(TypeCompatibility.check(generic, plain)))
  assert.isFalse(TypeInference.infer(plain, generic, new Map()))
  const selected = Type.callable(
    [],
    'i32',
    {
      ...generic,
      typeOutlives: [{ type: outer, lifetime: env }],
    },
    'Shared',
    schema,
  )
  assert.isTrue(TypeCompatibility.isCompatible(TypeCompatibility.check(selected, plain)))
  assert.isTrue(TypeInference.infer(plain, selected, new Map()))
  const effect = Type.effect('i32', [], { ...retained, lifetimeBinders: [] })
  const expectedEffect = Type.effect('i32', [], { ...plain, lifetimeBinders: [] })
  assert.isTrue(TypeCompatibility.isCompatible(TypeCompatibility.check(effect, expectedEffect)))
  assert.isTrue(TypeInference.infer(expectedEffect, effect, new Map()))
})

it.effect('keeps captured generic Effect storage bounded independently from its result type', () =>
  Effect.gen(function* () {
    const source = `effect fn retain<T>(value: T) -> i32 { return 0 }
fn invalid<T>(value: T) -> once Effect<'static; i32> { return retain(move value) }
fn valid<'a, T: 'a>(value: T) -> once Effect<'a; i32> { return retain(move value) }`
    const snapshot = yield* Analysis.ofSource(
      'lifetimes/generic-effect',
      Uint8Array.from(source, (c) => c.charCodeAt(0)),
    )
    const failures = Analysis.diagnostics(snapshot)
    assert.isTrue(
      failures.some(
        (d) =>
          d.code === Diagnostic.unsatisfiedLifetimeBoundCode &&
          d.span.start >= source.indexOf('\nfn invalid') &&
          d.span.start < source.indexOf('fn valid'),
      ),
    )
    assert.isFalse(failures.some((d) => d.span.start >= source.indexOf('fn valid')))
  }),
)

it('compares quantified contracts on the same representation without merging distinct representations', () => {
  const owner = { module: 'lifetimes/representation', name: 'operation' }
  const a = Lifetime.bound(owner, 0, 'a', [0])
  const b = Lifetime.bound({ ...owner, name: 'required' }, 0, 'b', [0])
  const offered = Type.callable([Type.reference('Shared', 'i32', a)], 'i32', {
    ...detached,
    lifetimeBinders: [a],
  })
  const wanted = Type.callable([Type.reference('Shared', 'i32', b)], 'i32', {
    ...detached,
    lifetimeBinders: [b],
  })
  const representation = Type.parameter(owner, 1, 'F', 'CallableRepresentation', offered)
  const argument = Type.representationParameterArgument(representation)
  const source = Type.represented(offered, offered, argument)
  const target = Type.represented(wanted, wanted, argument)
  assert.isTrue(TypeCompatibility.isCompatible(TypeCompatibility.check(source, target)))
  const different = Type.representationParameterArgument(
    Type.parameter(owner, 2, 'G', 'CallableRepresentation', wanted),
  )
  assert.isFalse(
    TypeCompatibility.isCompatible(
      TypeCompatibility.check(source, Type.represented(wanted, wanted, different)),
    ),
  )
  const env = Type.parameter(owner, 4, 'env', 'Lifetime')
  const required = Type.parameter(
    owner,
    3,
    'R',
    'CallableRepresentation',
    Type.callable([], 'i32', { environment: Lifetime.bound(owner, 4, 'env'), lifetimeBinders: [] }),
  )
  const supplied = Type.representationParameterArgument(
    Type.parameter(owner, 5, 'S', 'CallableRepresentation', Type.callable([], 'i32', detached)),
  )
  assert.isDefined(
    TypeInference.prefixSubstitution([required, env], [supplied, Lifetime.staticLifetime]),
  )
})

it('substitutes the retained contract of an open representation parameter', () => {
  const owner = { module: 'lifetimes/representation', name: 'substitution' }
  const value = Type.parameter(owner, 0, 'D')
  const env = Lifetime.bound(owner, 1, 'env')
  const bound = Type.callable([value], value, { environment: env, lifetimeBinders: [] })
  const parameter = Type.parameter(owner, 2, 'F', 'CallableRepresentation', bound)
  const argument = Type.representationParameterArgument(parameter)
  const source = Type.represented(bound, bound, argument)
  const result = Type.substitute(
    source,
    new Map<string, Type.GenericArgument>([
      [Type.key(value), 'i32'],
      [Lifetime.key(env), Lifetime.staticLifetime],
    ]),
  )
  assert.isTrue(Type.isRepresented(result))
  if (!Type.isRepresented(result)) return unreachable('expected represented result')
  const expected = Type.callable(['i32'], 'i32', detached)
  assert.isTrue(Type.equals(result.contract, expected))
  assert.isTrue(Type.equals(result.representation.requiredBound, expected))
  assert.isTrue(Type.equalsGenericArgument(result.representation.argument, argument))
  const environmentApplied = Type.substitute(
    source,
    new Map([[Lifetime.key(env), Lifetime.staticLifetime]]),
  )
  const sequential = Type.substitute(environmentApplied, new Map([[Type.key(value), 'i32']]))
  assert.isTrue(Type.equals(sequential, result))
  assert.deepEqual(Type.storageLifetimes(sequential), [Lifetime.staticLifetime])
  const holder = Type.nominal(owner.module, 'Holder', [argument])
  const appliedHolder = Type.substitute(
    holder,
    new Map([[Lifetime.key(env), Lifetime.staticLifetime]]),
  )
  assert.deepEqual(Type.storageLifetimes(appliedHolder), [Lifetime.staticLifetime])
})

it('checks fixed generic arguments under callable variance without reinferring their type', () => {
  const owner = { module: 'lifetimes/inference', name: 'fixed' }
  const long = Lifetime.bound(owner, 0, 'long')
  const short = Lifetime.bound(owner, 1, 'short')
  const parameter = Type.parameter(owner, 2, 'T')
  const fixed = Type.reference('Shared', 'i32', long)
  const shorter = Type.reference('Shared', 'i32', short)
  const assumptions = Lifetime.assumptions([{ longer: long, shorter: short }])
  const lifetimes: TypeInference.LifetimeInference = {
    accepts: (source, target, invariant) =>
      Lifetime.outlives(assumptions, source, target) &&
      (!invariant || Lifetime.outlives(assumptions, target, source)),
  }
  const inferred = new Map<string, Type.GenericArgument>([[Type.key(parameter), fixed]])
  assert.isTrue(
    TypeInference.infer(
      Type.callable([parameter], Type.unit, detached),
      Type.callable([shorter], Type.unit, detached),
      inferred,
      lifetimes,
    ),
  )
  assert.isFalse(TypeInference.infer(parameter, shorter, inferred, lifetimes))
  assert.isFalse(
    TypeInference.infer(
      Type.reference('Exclusive', parameter, Lifetime.staticLifetime),
      Type.reference('Exclusive', shorter, Lifetime.staticLifetime),
      inferred,
      lifetimes,
    ),
  )
  assert.deepEqual(inferred.get(Type.key(parameter)), fixed)
})

it.effect('derives nominal well-formedness assumptions from requirement and impl headers', () =>
  Effect.gen(function* () {
    const source = `struct Holder<'a, T: 'a> { value: T }
interface Marker {}
impl<'a, T> Marker for Holder<'a, T> {}
impl<'a, T> Holder<'a, T> { fn count(self: &Self) -> i32 { return 1 } }
service Store<'a, T: 'a> { effect fn save(value: T) -> () }
effect fn requiring<'a, T>() -> () ? &Store<'a, T> { return () }`
    const snapshot = yield* Analysis.ofSource(
      'lifetimes/header-obligations',
      Uint8Array.from(source, (character) => character.charCodeAt(0)),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const index = Analysis.declarationIndex(snapshot)
    const scope = TypeOutlives.context(index.modules)
    const module =
      index.modules.find((module) => module.module === 'lifetimes/header-obligations') ??
      unreachable('expected source module')
    const requiring = module.members.find(
      (member) =>
        member._tag === 'FunctionDeclaration' &&
        member.name._tag === 'Present' &&
        member.name.spelling === 'requiring',
    )
    if (requiring?._tag !== 'FunctionDeclaration')
      return unreachable('expected requirement declaration')
    for (const declaration of [requiring, ...module.conformances, ...module.inherentImpls]) {
      const parameter =
        declaration.typeParameters.find((parameter) => parameter.type.name === 'T') ??
        unreachable('expected retained generic parameter')
      assert.isTrue(
        (scope.parameterBounds.get(Type.key(parameter.type))?.length ?? 0) > 0,
        Type.key(parameter.type),
      )
    }
  }),
)

it('discards rejected compatibility proofs and replays cached obligations after acceptance', () => {
  const owner = { module: 'lifetimes/proof', name: 'compatibility' }
  const local = Lifetime.local(owner, 'source', 0)
  const target = Lifetime.bound(owner, 0, 'target')
  const obligations: Array<Lifetime.Outlives> = []
  const context = TypeCompatibility.context({
    outlives: () => true,
    commitOutlives: (longer, shorter) => {
      obligations.push({ longer, shorter })
    },
  })
  const source = Type.reference('Shared', 'i32', local)
  const expected = Type.reference('Shared', 'i32', target)
  assert.isFalse(
    TypeCompatibility.isCompatible(
      TypeCompatibility.check(source, Type.reference('Shared', 'bool', target), context),
    ),
  )
  assert.deepEqual(obligations, [])
  TypeCompatibility.commitWhen(
    context,
    () => {
      assert.isTrue(
        TypeCompatibility.isCompatible(TypeCompatibility.check(source, expected, context)),
      )
      return false
    },
    (accepted) => accepted,
  )
  assert.deepEqual(obligations, [])
  const hits = context.work.cacheHits
  assert.isTrue(TypeCompatibility.isCompatible(TypeCompatibility.check(source, expected, context)))
  assert.isAbove(context.work.cacheHits, hits)
  assert.deepEqual(obligations, [{ longer: local, shorter: target }])
})

it('rolls back failed inference while retaining a later cached successful proof', () => {
  const owner = { module: 'lifetimes/proof', name: 'inference' }
  const source = Lifetime.local(owner, 'source', 0)
  const target = Lifetime.bound(owner, 0, 'target')
  const obligations: Array<Lifetime.Outlives> = []
  const compatibility = TypeCompatibility.context({
    outlives: () => true,
    commitOutlives: (longer, shorter) => {
      obligations.push({ longer, shorter })
    },
  })
  const inference: TypeInference.LifetimeInference = {
    compatibility,
    accepts: (longer, shorter) =>
      TypeCompatibility.isCompatible(
        TypeCompatibility.check(Type.string(longer), Type.string(shorter), compatibility),
      ),
  }
  const pattern = Type.callable([Type.reference('Shared', 'i32', target)], 'bool', detached)
  assert.isFalse(
    TypeInference.infer(
      pattern,
      Type.callable([Type.reference('Shared', 'i32', source)], 'i32', detached),
      new Map(),
      inference,
    ),
  )
  assert.deepEqual(obligations, [])
  const hits = compatibility.work.cacheHits
  assert.isTrue(
    TypeInference.infer(
      pattern,
      Type.callable([Type.reference('Shared', 'i32', source)], 'bool', detached),
      new Map(),
      inference,
    ),
  )
  assert.isAbove(compatibility.work.cacheHits, hits)
  assert.deepEqual(obligations, [{ longer: target, shorter: source }])
})

it('commits only the successful complete row inference alternative', () => {
  const owner = { module: 'lifetimes/proof', name: 'row' }
  const a = Lifetime.bound(owner, 0, 'a')
  const b = Lifetime.bound(owner, 1, 'b')
  const left = Lifetime.local(owner, 'source', 0)
  const right = Lifetime.local(owner, 'source', 1)
  const parameter = Type.parameter(owner, 2, 'T')
  const failure = (region: Lifetime.Lifetime, value: Type.Type) =>
    Type.nominal(owner.module, 'Failure', [region, value])
  const obligations: Array<Lifetime.Outlives> = []
  const compatibility = TypeCompatibility.context({
    outlives: () => true,
    commitOutlives: (longer, shorter) => {
      obligations.push({ longer, shorter })
    },
  })
  const inference: TypeInference.LifetimeInference = {
    compatibility,
    accepts: (longer, shorter) =>
      TypeCompatibility.isCompatible(
        TypeCompatibility.check(Type.string(longer), Type.string(shorter), compatibility),
      ),
  }
  const inferred = new Map<string, Type.GenericArgument>()
  assert.isTrue(
    TypeInference.infer(
      Type.effect('i32', [failure(a, parameter), failure(b, 'bool')], detached),
      Type.effect('i32', [failure(left, 'bool'), failure(right, 'i32')], detached),
      inferred,
      inference,
    ),
  )
  assert.deepEqual(inferred.get(Type.key(parameter)), 'i32')
  assert.sameDeepMembers(obligations, [
    { longer: right, shorter: a },
    { longer: left, shorter: b },
  ])
})

it('merges lifetime assumptions without changing canonical order or duplicate precedence', () => {
  const owner = { module: 'lifetimes/merge', name: 'body' }
  const a = Lifetime.bound(owner, 0, 'a')
  const renamedA = Lifetime.bound(owner, 0, 'renamed')
  const b = Lifetime.bound(owner, 1, 'b')
  const c = Lifetime.bound(owner, 2, 'c')
  const left = Lifetime.assumptions([{ longer: a, shorter: b }])
  const right = Lifetime.assumptions([
    { longer: b, shorter: c },
    { longer: renamedA, shorter: b },
  ])
  const merged = Lifetime.mergeAssumptions(left, right)
  assert.deepStrictEqual(merged, Lifetime.assumptions([...left.bounds, ...right.bounds]))
  assert.strictEqual(merged, right)
  assert.isTrue(Lifetime.outlives(merged, a, c))
  assert.isFalse(Lifetime.outlives(left, a, c))
  assert.deepStrictEqual(
    Lifetime.mergeAssumptions(right, left),
    Lifetime.assumptions([...right.bounds, ...left.bounds]),
  )
  const extra = Lifetime.assumptions([{ longer: c, shorter: Lifetime.staticLifetime }])
  assert.deepStrictEqual(
    Lifetime.mergeAssumptions(right, extra),
    Lifetime.assumptions([...right.bounds, ...extra.bounds]),
  )
  assert.strictEqual(Lifetime.mergeAssumptions(left, Lifetime.assumptions([])), left)
  assert.strictEqual(Lifetime.mergeAssumptions(Lifetime.assumptions([]), left), left)
})

it('reuses canonical lifetime bounds while snapshotting caller-owned input', () => {
  const owner = { module: 'lifetimes/merge', name: 'snapshot' }
  const a = Lifetime.bound(owner, 0, 'a')
  const b = Lifetime.bound(owner, 1, 'b')
  const bounds: Array<Lifetime.Outlives> = [{ longer: a, shorter: b }]
  const before = Lifetime.assumptions(bounds)
  assert.strictEqual(Lifetime.assumptions(before.bounds), before)
  bounds.push({ longer: b, shorter: a })
  const after = Lifetime.assumptions(bounds)
  assert.isFalse(Lifetime.outlives(before, b, a))
  assert.isTrue(Lifetime.outlives(after, b, a))
})
