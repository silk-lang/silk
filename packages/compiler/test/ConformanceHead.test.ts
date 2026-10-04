import { assert, it } from '@effect/vitest'
import * as ConformanceHead from '../src/ConformanceHead.js'
import * as Lifetime from '../src/Lifetime.js'
import * as Type from '../src/Type.js'

const owner = (name: string) => Object.freeze({ module: 'heads', name })

const binder = (
  ownerName: string,
  ordinal: number,
  name: string,
  kind: Type.ParameterKind = 'Value',
  bound?: Type.RepresentationBound,
) => Type.parameter(owner(ownerName), ordinal, name, kind, bound)

const decoder = (provider: Type.Type) => Type.nominal('heads', 'Decoder', [provider])

const wrap = (inner: Type.GenericArgument) => Type.nominal('heads', 'Wrap', [inner])

it('gives alpha-equivalent headers one identity and one requirement normal form', () => {
  // Two headers differing only in binder owner, spelling, and declaration order. Names are
  // provenance, and the normal form renumbers by first occurrence in the term, so both reduce to one
  // key. Requirements are renumbered through the same map, so they agree too even though the key
  // never reads them.
  const first = binder('a', 0, 'S')
  const second = binder('a', 1, 'T')
  const left = ConformanceHead.make(
    Type.nominal('heads', 'Pair', [first, second]),
    Type.nominal('heads', 'Box', [first, second]),
    [
      Object.freeze({ capability: decoder(second), provider: second }),
      Object.freeze({ capability: decoder(first), provider: first }),
    ],
  )
  const renamedFirst = binder('b', 1, 'Element')
  const renamedSecond = binder('b', 0, 'Other')
  const right = ConformanceHead.make(
    Type.nominal('heads', 'Pair', [renamedFirst, renamedSecond]),
    Type.nominal('heads', 'Box', [renamedFirst, renamedSecond]),
    [
      Object.freeze({ capability: decoder(renamedSecond), provider: renamedSecond }),
      Object.freeze({ capability: decoder(renamedFirst), provider: renamedFirst }),
    ],
  )
  const requirements = (head: ConformanceHead.ConformanceHead) =>
    head.requirements.map((requirement) => [
      Type.key(requirement.capability),
      Type.key(requirement.provider),
    ])
  assert.strictEqual(ConformanceHead.key(left), ConformanceHead.key(right))
  assert.deepEqual(requirements(left), requirements(right))
})

it('keeps a requirement from shifting the identity its header already has', () => {
  // Coherence never consults a bound, so adding one may not change what the header is.
  const parameter = binder('a', 0, 'S')
  const bare = ConformanceHead.make(decoder(wrap(parameter)), wrap(parameter))
  const bounded = ConformanceHead.make(decoder(wrap(parameter)), wrap(parameter), [
    Object.freeze({ capability: decoder(parameter), provider: parameter }),
  ])
  assert.strictEqual(ConformanceHead.key(bare), ConformanceHead.key(bounded))
})

it('reports overlap between two headers whose requirements are mutually exclusive', () => {
  // The two bounds cannot both hold, and that is deliberately not consulted: whether a bound is
  // satisfiable changes as a program grows, so a coherence answer that read it would move too.
  const left = ConformanceHead.make(decoder(wrap(binder('a', 0, 'S'))), wrap(binder('a', 0, 'S')), [
    Object.freeze({
      capability: Type.nominal('heads', 'Left', [binder('a', 0, 'S')]),
      provider: binder('a', 0, 'S'),
    }),
  ])
  const right = ConformanceHead.make(
    decoder(wrap(binder('b', 0, 'T'))),
    wrap(binder('b', 0, 'T')),
    [
      Object.freeze({
        capability: Type.nominal('heads', 'Right', [binder('b', 0, 'T')]),
        provider: binder('b', 0, 'T'),
      }),
    ],
  )
  assert.isTrue(ConformanceHead.mayOverlap(left, right))
})

it('separates headers whose providers are different nominals', () => {
  const left = ConformanceHead.make(decoder(wrap(binder('a', 0, 'S'))), wrap(binder('a', 0, 'S')))
  const other = Type.nominal('heads', 'Other', [binder('b', 0, 'T')])
  const right = ConformanceHead.make(decoder(other), other)
  assert.isFalse(ConformanceHead.mayOverlap(left, right))
})

it('separates a concrete header from one covering a different concrete provider', () => {
  const left = ConformanceHead.make(decoder(wrap('i32')), wrap('i32'))
  const right = ConformanceHead.make(decoder(wrap('bool')), wrap('bool'))
  assert.isFalse(ConformanceHead.mayOverlap(left, right))
  assert.isTrue(ConformanceHead.mayOverlap(left, left))
})

it('reports overlap between a parametric header and a concrete one it covers', () => {
  const parametric = ConformanceHead.make(
    decoder(wrap(binder('a', 0, 'S'))),
    wrap(binder('a', 0, 'S')),
  )
  const concrete = ConformanceHead.make(decoder(wrap('i32')), wrap('i32'))
  assert.isTrue(ConformanceHead.mayOverlap(parametric, concrete))
  assert.isTrue(ConformanceHead.mayOverlap(concrete, parametric))
})

it('refuses a binding only an infinite term would satisfy', () => {
  // `Wrap<S>` against `S` has no finite common instance, so the two headers are genuinely disjoint
  // rather than conservatively ambiguous.
  const inner = binder('a', 0, 'S')
  const left = ConformanceHead.make(
    Type.nominal('heads', 'Pair', [inner, wrap(inner)]),
    Type.nominal('heads', 'Box', [inner]),
  )
  const opposing = binder('b', 0, 'T')
  const right = ConformanceHead.make(
    Type.nominal('heads', 'Pair', [wrap(opposing), opposing]),
    Type.nominal('heads', 'Box', [opposing]),
  )
  assert.isFalse(ConformanceHead.mayOverlap(left, right))
})

it('treats an open failure type as covering every type it could become', () => {
  const open = binder('a', 0, 'E')
  const closed = Type.failureValue([Type.nominal('heads', 'Broken')])
  const left = ConformanceHead.make(
    Type.nominal('heads', 'Runner', [open]),
    Type.nominal('heads', 'Box', [open]),
  )
  const right = ConformanceHead.make(
    Type.nominal('heads', 'Runner', [closed]),
    Type.nominal('heads', 'Box', [closed]),
  )
  assert.isTrue(ConformanceHead.mayOverlap(left, right))
})

it('separates two closed failure rows that name different members', () => {
  const first = Type.failureValue([Type.nominal('heads', 'Broken')])
  const second = Type.failureValue([Type.nominal('heads', 'Other')])
  const left = ConformanceHead.make(
    Type.nominal('heads', 'Runner', [first]),
    Type.nominal('heads', 'Box', [first]),
  )
  const right = ConformanceHead.make(
    Type.nominal('heads', 'Runner', [second]),
    Type.nominal('heads', 'Box', [second]),
  )
  assert.isFalse(ConformanceHead.mayOverlap(left, right))
})

it('separates closed Effect heads with disjoint success types', () => {
  const leftEffect = Type.effect('i32', [], {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const rightEffect = Type.effect('bool', [], {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const left = ConformanceHead.make(decoder(leftEffect), leftEffect)
  const right = ConformanceHead.make(decoder(rightEffect), rightEffect)
  assert.isFalse(ConformanceHead.mayOverlap(left, right))
})

it('separates closed Effect heads with disjoint failure rows', () => {
  const leftEffect = Type.effect('i32', [Type.nominal('heads', 'Problem')], {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const rightEffect = Type.effect('i32', [Type.nominal('heads', 'Other')], {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const left = ConformanceHead.make(decoder(leftEffect), leftEffect)
  const right = ConformanceHead.make(decoder(rightEffect), rightEffect)
  assert.isFalse(ConformanceHead.mayOverlap(left, right))
})

it('separates closed Effect heads with disjoint requirement rows', () => {
  const leftEffect = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
    [
      Object.freeze({
        capability: Type.nominal('heads', 'Left'),
        role: 'provider',
        access: 'Shared',
      }),
    ],
  )
  const rightEffect = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
    [
      Object.freeze({
        capability: Type.nominal('heads', 'Right'),
        role: 'provider',
        access: 'Shared',
      }),
    ],
  )
  const left = ConformanceHead.make(decoder(leftEffect), leftEffect)
  const right = ConformanceHead.make(decoder(rightEffect), rightEffect)
  assert.isFalse(ConformanceHead.mayOverlap(left, right))
})

it('treats an open Effect requirement row as covering a compatible closed row', () => {
  const openEffect = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
    [],
    [binder('a', 0, 'R', 'RequirementRow')],
  )
  const closedEffect = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
    [
      Object.freeze({
        capability: Type.nominal('heads', 'Clock'),
        role: 'provider',
        access: 'Shared',
      }),
    ],
  )
  const left = ConformanceHead.make(decoder(openEffect), openEffect)
  const right = ConformanceHead.make(decoder(closedEffect), closedEffect)
  assert.isTrue(ConformanceHead.mayOverlap(left, right))
})

it('reports overlap between Effect heads whose access modes share one admissible actual', () => {
  const shared = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
  )
  const exclusive = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Exclusive',
  )
  const left = ConformanceHead.make(decoder(shared), shared)
  const right = ConformanceHead.make(decoder(exclusive), exclusive)
  assert.isTrue(ConformanceHead.mayOverlap(left, right))
})

it('reports overlap between callable heads whose modes share one admissible actual', () => {
  const shared = Type.callable(
    ['i32'],
    'i32',
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
  )
  const consuming = Type.callable(
    ['i32'],
    'i32',
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Take',
  )
  const left = ConformanceHead.make(decoder(shared), shared)
  const right = ConformanceHead.make(decoder(consuming), consuming)
  assert.isTrue(ConformanceHead.mayOverlap(left, right))
})

it('reports overlap between closed requirement rows whose access shares one actual', () => {
  const capability = Type.nominal('heads', 'Clock')
  const shared = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
    [Object.freeze({ capability, role: 'provider', access: 'Shared' })],
  )
  const exclusive = Type.effect(
    'i32',
    [],
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Shared',
    [Object.freeze({ capability, role: 'provider', access: 'Exclusive' })],
  )
  const left = ConformanceHead.make(decoder(shared), shared)
  const right = ConformanceHead.make(decoder(exclusive), exclusive)
  assert.isTrue(ConformanceHead.mayOverlap(left, right))
})

it('separates representation-bounded headers whose bounds cannot intersect', () => {
  // The admissibility and intersection answers are the ones representation parameters already own;
  // this only asks them the coherence question.
  const callableBound = Type.callable(['i32'], 'i32', {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const effectBound = Type.effect('i32', [], {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const callableParameter = binder('a', 0, 'F', 'CallableRepresentation', callableBound)
  const effectParameter = binder('b', 0, 'G', 'EffectRepresentation', effectBound)
  const callableHead = Type.represented(
    callableBound,
    callableBound,
    Type.representationParameterArgument(callableParameter),
  )
  const effectHead = Type.represented(
    effectBound,
    effectBound,
    Type.representationParameterArgument(effectParameter),
  )
  const left = ConformanceHead.make(
    Type.nominal('heads', 'Holder', [callableHead]),
    Type.nominal('heads', 'Holder', [callableHead]),
  )
  const right = ConformanceHead.make(
    Type.nominal('heads', 'Holder', [effectHead]),
    Type.nominal('heads', 'Holder', [effectHead]),
  )
  assert.isFalse(ConformanceHead.mayOverlap(left, right))
  assert.isTrue(ConformanceHead.mayOverlap(left, left))
})

it('normalizes parameters inside representation bounds before comparing overlap', () => {
  const leftValue = binder('a', 0, 'T')
  const leftBound = Type.callable([leftValue], leftValue, {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const leftRepresentation = binder('a', 1, 'F', 'CallableRepresentation', leftBound)
  const rightValue = binder('b', 1, 'Element')
  const rightBound = Type.callable([rightValue], rightValue, {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const rightRepresentation = binder('b', 0, 'Operation', 'CallableRepresentation', rightBound)
  const left = ConformanceHead.make(
    Type.nominal('heads', 'Holder', [Type.representationParameterArgument(leftRepresentation)]),
    Type.nominal('heads', 'Holder', [Type.representationParameterArgument(leftRepresentation)]),
  )
  const right = ConformanceHead.make(
    Type.nominal('heads', 'Holder', [Type.representationParameterArgument(rightRepresentation)]),
    Type.nominal('heads', 'Holder', [Type.representationParameterArgument(rightRepresentation)]),
  )
  const leftArgument = left.capability.arguments.at(0)
  const rightArgument = right.capability.arguments.at(0)
  assert.isDefined(leftArgument)
  assert.isDefined(rightArgument)
  if (leftArgument === undefined || rightArgument === undefined) return
  assert.isTrue(Type.isRepresentationParameterArgument(leftArgument))
  assert.isTrue(Type.isRepresentationParameterArgument(rightArgument))
  assert.strictEqual(left.parameters.length, 2)
  assert.strictEqual(right.parameters.length, 2)
  assert.isDefined(left.parameters.at(0)?.representationBound)
  assert.isDefined(right.parameters.at(0)?.representationBound)
  assert.strictEqual(
    Type.key(left.parameters.at(0)?.representationBound ?? 'never'),
    Type.key(right.parameters.at(0)?.representationBound ?? 'never'),
  )
  assert.strictEqual(ConformanceHead.key(left), ConformanceHead.key(right))
  assert.isTrue(ConformanceHead.mayOverlap(left, right))
})

it('normalizes ordinary binders nested only inside Effect representation bounds', () => {
  const leftValue = binder('a', 0, 'T')
  const leftBound = Type.effect(leftValue, [], {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const leftRepresentation = binder('a', 1, 'F', 'EffectRepresentation', leftBound)
  const rightValue = binder('b', 1, 'Element')
  const rightBound = Type.effect(rightValue, [], {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const rightRepresentation = binder('b', 0, 'Operation', 'EffectRepresentation', rightBound)
  const left = ConformanceHead.make(
    Type.nominal('heads', 'Holder', [Type.representationParameterArgument(leftRepresentation)]),
    Type.nominal('heads', 'Holder', [Type.representationParameterArgument(leftRepresentation)]),
  )
  const right = ConformanceHead.make(
    Type.nominal('heads', 'Holder', [Type.representationParameterArgument(rightRepresentation)]),
    Type.nominal('heads', 'Holder', [Type.representationParameterArgument(rightRepresentation)]),
  )
  const leftArgument = left.capability.arguments.at(0)
  const rightArgument = right.capability.arguments.at(0)
  assert.isDefined(leftArgument)
  assert.isDefined(rightArgument)
  if (leftArgument === undefined || rightArgument === undefined) return
  assert.isTrue(Type.isRepresentationParameterArgument(leftArgument))
  assert.isTrue(Type.isRepresentationParameterArgument(rightArgument))
  assert.strictEqual(left.parameters.length, 2)
  assert.strictEqual(right.parameters.length, 2)
  assert.isDefined(left.parameters.at(0)?.representationBound)
  assert.isDefined(right.parameters.at(0)?.representationBound)
  assert.strictEqual(
    Type.key(left.parameters.at(0)?.representationBound ?? 'never'),
    Type.key(right.parameters.at(0)?.representationBound ?? 'never'),
  )
  assert.strictEqual(ConformanceHead.key(left), ConformanceHead.key(right))
})

it('reports overlap between an open callable bound and an alpha-renamed exact callable', () => {
  const openValue = binder('open', 0, 'T')
  const openBound = Type.callable([openValue], openValue, {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const openRepresentation = binder('open', 1, 'F', 'CallableRepresentation', openBound)
  const exactValue = binder('exact', 0, 'Element')
  const exactContract = Type.callable([exactValue], exactValue, {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const exactRepresentation = Type.exactRepresentationArgument(
    Type.callableIdentityArgument(
      'heads.identity',
      { _tag: 'Declaration', module: 'heads', name: 'identity' },
      [exactValue],
    ),
    exactContract,
  )
  const open = ConformanceHead.make(
    Type.nominal('heads', 'Holder', [Type.representationParameterArgument(openRepresentation)]),
    Type.nominal('heads', 'Holder', [Type.representationParameterArgument(openRepresentation)]),
  )
  const exact = ConformanceHead.make(
    Type.nominal('heads', 'Holder', [exactRepresentation]),
    Type.nominal('heads', 'Holder', [exactRepresentation]),
  )
  const groundRepresentation = Type.exactRepresentationArgument(
    Type.callableIdentityArgument('heads.i32Identity', {
      _tag: 'Declaration',
      module: 'heads',
      name: 'i32Identity',
    }),
    Type.callable(['i32'], 'i32', { environment: Lifetime.staticLifetime, lifetimeBinders: [] }),
  )
  const ground = ConformanceHead.make(
    Type.nominal('heads', 'Holder', [groundRepresentation]),
    Type.nominal('heads', 'Holder', [groundRepresentation]),
  )
  assert.isTrue(ConformanceHead.mayOverlap(open, exact))
  assert.isTrue(ConformanceHead.mayOverlap(exact, open))
  assert.isTrue(ConformanceHead.mayOverlap(open, ground))
  assert.isTrue(ConformanceHead.mayOverlap(ground, open))
})

it('reports overlap between an open Effect bound and an alpha-renamed exact Effect', () => {
  const openValue = binder('open', 0, 'T')
  const openBound = Type.effect(openValue, [], {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const openRepresentation = binder('open', 1, 'F', 'EffectRepresentation', openBound)
  const exactValue = binder('exact', 0, 'Element')
  const exactContract = Type.effect(exactValue, [], {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const exactRepresentation = Type.exactRepresentationArgument(
    Type.effectIdentityArgument('heads.identityEffect'),
    exactContract,
  )
  const open = ConformanceHead.make(
    Type.nominal('heads', 'Holder', [Type.representationParameterArgument(openRepresentation)]),
    Type.nominal('heads', 'Holder', [Type.representationParameterArgument(openRepresentation)]),
  )
  const exact = ConformanceHead.make(
    Type.nominal('heads', 'Holder', [exactRepresentation]),
    Type.nominal('heads', 'Holder', [exactRepresentation]),
  )
  const groundRepresentation = Type.exactRepresentationArgument(
    Type.effectIdentityArgument('heads.i32IdentityEffect'),
    Type.effect('i32', [], { environment: Lifetime.staticLifetime, lifetimeBinders: [] }),
  )
  const ground = ConformanceHead.make(
    Type.nominal('heads', 'Holder', [groundRepresentation]),
    Type.nominal('heads', 'Holder', [groundRepresentation]),
  )
  assert.isTrue(ConformanceHead.mayOverlap(open, exact))
  assert.isTrue(ConformanceHead.mayOverlap(exact, open))
  assert.isTrue(ConformanceHead.mayOverlap(open, ground))
  assert.isTrue(ConformanceHead.mayOverlap(ground, open))
})

it('accepts a requirement that names the immediate inner provider', () => {
  const inner = binder('a', 0, 'S')
  const head = ConformanceHead.make(decoder(wrap(inner)), wrap(inner), [
    Object.freeze({ capability: decoder(inner), provider: inner }),
  ])
  assert.deepEqual(ConformanceHead.terminationFailures(head), [])
})

it('rejects a requirement whose provider equals the header it is declared on', () => {
  const inner = binder('a', 0, 'S')
  const head = ConformanceHead.make(decoder(wrap(inner)), wrap(inner), [
    Object.freeze({ capability: decoder(wrap(inner)), provider: wrap(inner) }),
  ])
  const failures = ConformanceHead.terminationFailures(head)
  assert.deepEqual(
    failures.map((failure) => failure._tag),
    ['ProviderNotStrictSubterm'],
  )
})

it('rejects a requirement whose provider grows', () => {
  // Growth is caught by the descent condition rather than the occurrence one: wrapping a binder
  // once more adds term size without adding an occurrence.
  const inner = binder('a', 0, 'S')
  const head = ConformanceHead.make(decoder(wrap(inner)), wrap(inner), [
    Object.freeze({ capability: decoder(wrap(wrap(inner))), provider: wrap(wrap(inner)) }),
  ])
  assert.deepEqual(
    ConformanceHead.terminationFailures(head).map((failure) => failure._tag),
    ['ProviderNotStrictSubterm'],
  )
})

it('rejects a requirement that multiplies a binder it was given once', () => {
  // Trading depth for width is the other way a requirement escapes the measure, so the occurrence
  // count is compared across the complete goal rather than the provider alone.
  const inner = binder('a', 0, 'S')
  const pair = Type.nominal('heads', 'Pair', [inner, inner])
  const head = ConformanceHead.make(decoder(wrap(inner)), wrap(inner), [
    Object.freeze({ capability: decoder(pair), provider: pair }),
  ])
  assert.include(
    ConformanceHead.terminationFailures(head).map((failure) => failure._tag),
    'IncreasingVariableOccurrences',
  )
})

it('rejects a requirement naming a peer of the header provider', () => {
  const inner = binder('a', 0, 'S')
  const peer = Type.nominal('heads', 'Peer', [inner])
  const head = ConformanceHead.make(decoder(wrap(inner)), wrap(inner), [
    Object.freeze({ capability: decoder(peer), provider: peer }),
  ])
  assert.deepEqual(
    ConformanceHead.terminationFailures(head).map((failure) => failure._tag),
    ['ProviderNotStrictSubterm'],
  )
})

it('rejects a requirement that rewrites a ground interface argument', () => {
  const inner = binder('a', 0, 'S')
  const convert = (provider: Type.Type, fixed: Type.Type) =>
    Type.nominal('heads', 'Convert', [provider, fixed])
  const head = ConformanceHead.make(convert(wrap(inner), 'i32'), wrap(inner), [
    Object.freeze({ capability: convert(inner, 'bool'), provider: inner }),
  ])
  assert.deepEqual(
    ConformanceHead.terminationFailures(head).map((failure) => failure._tag),
    ['ChangedGroundArgument'],
  )
})

it('accepts a requirement that leaves a ground interface argument alone', () => {
  const inner = binder('a', 0, 'S')
  const convert = (provider: Type.Type, fixed: Type.Type) =>
    Type.nominal('heads', 'Convert', [provider, fixed])
  const head = ConformanceHead.make(convert(wrap(inner), 'i32'), wrap(inner), [
    Object.freeze({ capability: convert(inner, 'i32'), provider: inner }),
  ])
  assert.deepEqual(ConformanceHead.terminationFailures(head), [])
})
