import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import * as CompilationProfile from '../src/CompilationProfile.js'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { assert, it } from '@effect/vitest'
import * as Config from 'effect/Config'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as ExecutionPackage from '../src/ExecutionPackage.js'
import * as Layout from '../src/Layout.js'
import * as LayoutEncode from '../src/LayoutEncode.js'
import * as LayoutVerify from '../src/LayoutVerify.js'
import * as LocalSharedAllocationProvenance from '../src/LocalSharedAllocationProvenance.js'
import * as LocalSharedControlBlock from '../src/LocalSharedControlBlock.js'
import * as LocalSharedLifecycle from '../src/LocalSharedLifecycle.js'
import * as Mir from '../src/Mir.js'
import * as MirLinearization from '../src/MirLinearization.js'
import * as NativeToolchain from '../src/NativeToolchain.js'
import * as Linker from '../src/Linker.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Target from '../src/Target.js'
import * as Type from '../src/Type.js'
import * as ValueStorage from '../src/ValueStorage.js'
import * as NativeType from '../src/NativeType.js'
import * as NativeValue from '../src/NativeValue.js'
import { unreachable } from './support/raise.js'
import * as Lifetime from '../src/Lifetime.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const scalarShape = (type: Type.Builtin): Layout.CallingShapeNode => ({
  _tag: 'ScalarShape',
  type,
  laneCount: 1,
})

it.effect('projects payload carrier types through every calling-shape kind', () =>
  Effect.gen(function* () {
    const nominal = Type.nominal('layout/payload', 'Record', [])
    const product: Extract<Layout.CallingShapeNode, { readonly _tag: 'ProductShape' }> = {
      _tag: 'ProductShape',
      type: nominal,
      laneCount: 2,
      fields: ['u8', 'f64'].map((type, ordinal) => ({
        field: {
          _tag: 'FieldId',
          ordinal,
          owner: {
            _tag: 'StructFieldOwnerId',
            declaration: { _tag: 'DeclarationId', sourceId: 'layout/payload', ordinal: 0 },
          },
        },
        shape: scalarShape(type === 'u8' ? 'u8' : 'f64'),
      })),
    }
    const effect = Type.effect('u8', [], {
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
    })
    const normalized = Type.union(['u8', 'f64'])
    if (normalized._tag !== 'Normalized') return unreachable('expected normalized union')
    const union = normalized.type
    if (!Type.isUnion(union)) return unreachable('expected a structural union')
    const tag = { type: 'i32', lane: 0 } as const
    for (const target of [Target.wasm32UnknownUnknown, Target.aarch64AppleDarwin]) {
      const address: Layout.AddressScalar = {
        _tag: 'Address',
        element: 'u8',
        bits: target.pointerSize === 4 ? 32 : 64,
      }
      const cases: {
        readonly [K in Layout.CallingShapeNode['_tag']]: {
          readonly shape: Extract<Layout.CallingShapeNode, { readonly _tag: K }>
          readonly expected: ReadonlyArray<Type.Builtin>
        }
      } = {
        EmptyShape: { shape: { _tag: 'EmptyShape', type: 'never', laneCount: 0 }, expected: [] },
        ScalarShape: { shape: { _tag: 'ScalarShape', type: 'u8', laneCount: 1 }, expected: ['u8'] },
        ScalarEnumShape: {
          shape: { _tag: 'ScalarEnumShape', type: nominal, lane: 'u16', laneCount: 1 },
          expected: ['u16'],
        },
        ProductShape: { shape: product, expected: ['u8', 'f64'] },
        RepeatedShape: {
          shape: {
            _tag: 'RepeatedShape',
            type: Type.fixedArray(nominal, 2),
            element: product,
            length: 2,
            laneCount: 4,
          },
          expected: ['u8', 'f64', 'u8', 'f64'],
        },
        SliceShape: {
          shape: {
            _tag: 'SliceShape',
            type: Type.slice('Shared', 'u8', Lifetime.staticLifetime),
            address: { type: address, lane: 0 },
            length: { type: 'usize', lane: 1 },
            laneCount: 2,
          },
          expected: ['usize', 'usize'],
        },
        StringShape: {
          shape: {
            _tag: 'StringShape',
            type: Type.string(Lifetime.staticLifetime),
            storage: { type: address, lane: 0 },
            byteLength: { type: 'usize', lane: 1 },
            laneCount: 2,
          },
          expected: ['usize', 'usize'],
        },
        ReferenceShape: {
          shape: {
            _tag: 'ReferenceShape',
            type: Type.reference('Shared', 'u8', Lifetime.staticLifetime),
            address: { type: address, lane: 0 },
            laneCount: 1,
          },
          expected: ['usize'],
        },
        AddressShape: {
          shape: {
            _tag: 'AddressShape',
            type: 'u8',
            address: { type: address, lane: 0 },
            laneCount: 1,
          },
          expected: ['usize'],
        },
        CallableEnvironmentShape: {
          shape: {
            _tag: 'CallableEnvironmentShape',
            type: nominal,
            fields: [{ capture: 0, shape: product }],
            laneCount: 2,
          },
          expected: ['u8', 'f64'],
        },
        EffectEnvironmentShape: {
          shape: {
            _tag: 'EffectEnvironmentShape',
            type: effect,
            fields: [{ capture: 0, shape: product }],
            laneCount: 2,
          },
          expected: ['u8', 'f64'],
        },
        SumShape: {
          shape: {
            _tag: 'SumShape',
            type: union,
            tag,
            payloadLaneCount: 1,
            payloadTypes: ['f64'],
            zeroFill: true,
            members: [
              { member: 'u8', ordinal: 0, shape: scalarShape('u8'), payloadSlots: [0] },
              { member: 'f64', ordinal: 1, shape: scalarShape('f64'), payloadSlots: [0] },
            ],
            laneCount: 2,
          },
          expected: ['i32', 'f64'],
        },
        NominalUnionShape: {
          shape: {
            _tag: 'NominalUnionShape',
            type: nominal,
            tag,
            payloadLaneCount: 2,
            payloadTypes: ['u8', 'f64'],
            zeroFill: true,
            variants: [
              {
                variant: {
                  _tag: 'CanonicalUnionVariantId',
                  union: {
                    _tag: 'CanonicalDeclarationId',
                    module: nominal.module,
                    name: nominal.name,
                  },
                  name: 'Value',
                },
                ordinal: 0,
                shape: product,
                payloadSlots: [0, 1],
              },
            ],
            laneCount: 3,
          },
          expected: ['i32', 'u8', 'f64'],
        },
        OutcomeShape: {
          shape: {
            _tag: 'OutcomeShape',
            type: effect,
            success: scalarShape('u8'),
            failures: [],
            payloadLaneCount: 1,
            payloadTypes: ['u8'],
            laneCount: 2,
          },
          expected: ['i32', 'u8'],
        },
        EffectCompositeShape: {
          shape: {
            _tag: 'EffectCompositeShape',
            type: Type.represented(
              effect,
              effect,
              Type.compositeEffectRepresentationArgument(effect, [
                Type.exactRepresentationArgument(
                  Type.effectIdentityArgument('layout/payload/first'),
                  effect,
                ),
                Type.exactRepresentationArgument(
                  Type.effectIdentityArgument('layout/payload/second'),
                  effect,
                ),
              ]),
            ),
            alternativeLaneCounts: [1, 2],
            payloadTypes: [address, 'f32'],
            laneCount: 3,
          },
          expected: ['i32', 'usize', 'f32'],
        },
      }
      for (const { shape, expected } of Object.values(cases)) {
        assert.deepEqual(yield* Layout.unifyPayloadTypes([shape], target), expected, shape._tag)
      }
      assert.deepEqual(yield* Layout.unifyPayloadTypes([], target), [])
      assert.deepEqual(
        yield* Layout.unifyPayloadTypes(
          [
            {
              ...cases.RepeatedShape.shape,
              type: Type.fixedArray(nominal, 0),
              length: 0,
              laneCount: 0,
            },
          ],
          target,
        ),
        [],
      )
    }
  }),
)

it.effect('unifies unequal payloads by target width with stable equal-width ties', () =>
  Effect.gen(function* () {
    for (const target of [Target.wasm32UnknownUnknown, Target.aarch64AppleDarwin]) {
      const address: Layout.CallingShapeNode = {
        _tag: 'AddressShape',
        type: 'u8',
        address: {
          type: { _tag: 'Address', element: 'u8', bits: target.pointerSize === 4 ? 32 : 64 },
          lane: 0,
        },
        laneCount: 1,
      }
      const repeated: Layout.CallingShapeNode = {
        _tag: 'RepeatedShape',
        type: Type.fixedArray('u32', 2),
        length: 2,
        element: scalarShape('u32'),
        laneCount: 2,
      }
      const empty: Layout.CallingShapeNode = { _tag: 'EmptyShape', type: 'never', laneCount: 0 }
      const variants = [empty, address, repeated]
      const expected: ReadonlyArray<Type.Builtin> = [
        target.pointerSize === 4 ? 'u32' : 'usize',
        'u32',
      ]
      const result = yield* Layout.unifyPayloadTypes(variants, target)
      assert.deepEqual(result, expected)
      assert.deepEqual(yield* Layout.unifyPayloadTypes(variants.toReversed(), target), expected)
      assert.deepEqual(
        yield* Layout.unifyPayloadTypes([scalarShape('i32'), scalarShape('f32')], target),
        ['f32'],
      )
      assert.deepEqual(
        yield* Layout.unifyPayloadTypes([scalarShape('f32'), scalarShape('i32')], target),
        ['f32'],
      )
      assert.deepEqual(
        yield* Layout.unifyPayloadTypes([scalarShape('f32'), scalarShape('u64')], target),
        ['u64'],
      )
    }
  }),
)

it.effect('plans outcome storage separately from the concrete captured environment', () =>
  Effect.gen(function* () {
    for (const target of [Target.wasm32UnknownUnknown, Target.aarch64AppleDarwin]) {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'layout/outcome-storage',
        ascii('effect fn value() -> i32 { return 42 } pub fn main() -> i32 { return run value() }'),
        target.id,
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const module = Analysis.loweredMir(snapshot)
      const outcome =
        module.functions
          .flatMap((fn) => fn.localTypes)
          .find((type) => type._tag === 'EffectOutcome') ?? unreachable('expected outcome')
      if (outcome._tag !== 'EffectOutcome') return unreachable('expected outcome')
      const view =
        ValueStorage.find(module.layout, 'Outcome', outcome.type) ??
        unreachable('expected outcome storage')
      const storedOutcome = ValueStorage.outcome(module.layout, outcome.type)
      assert.strictEqual(NativeType.addressLayout(module.layout, outcome), storedOutcome)
      assert.deepEqual(
        [storedOutcome.size, storedOutcome.alignment, storedOutcome.payloadOffset],
        [8, 4, 4],
      )
      assert.deepEqual(
        storedOutcome.members.map((member) => member.storage),
        [{ _tag: 'Value' }],
      )
      assert.strictEqual(NativeValue.classify(module.layout, outcome), 'Place')
      assert.isUndefined(Layout.entry(module.layout, outcome.type))
      for (const environment of module.layout.effectEnvironments) {
        if (environment._tag === 'EffectEnvironment')
          assert.notStrictEqual(view.key, ValueStorage.captureKey(environment))
      }
      assert.deepEqual(
        view.slots.map((slot) => [slot.lane.type, slot.offset, slot.size]),
        [
          ['i32', 0, 4],
          ['i32', 4, 4],
        ],
      )
      assert.deepEqual(
        view.members.map((member) => [member.tag, member.lanes.map((lane) => lane.slot)]),
        [[0, [1]]],
      )
      assert.deepEqual(yield* ValueStorage.verify(module.layout), [])
      const shape =
        Layout.callingShape(module.layout, outcome.type) ?? unreachable('expected shape')
      const overflow = ValueStorage.carrier(target, 'Outcome', shape, view.members, 7)
      assert.strictEqual(overflow._tag, 'UnavailableValueStorage')
      if (overflow._tag === 'UnavailableValueStorage')
        assert.strictEqual(overflow.reason, 'Overflow')
      const member = view.members.at(0) ?? unreachable('expected success member')
      const lane = member.lanes.at(0) ?? unreachable('expected success lane')
      for (const slot of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
        const invalid = ValueStorage.carrier(target, 'Outcome', shape, [
          { ...member, lanes: [{ ...lane, slot }] },
        ])
        assert.strictEqual(invalid._tag, 'UnavailableValueStorage')
        if (invalid._tag === 'UnavailableValueStorage')
          assert.strictEqual(invalid.reason, 'InvalidMapping')
      }
      const binding = ValueStorage.bind(view, target, 3)
      assert.isFalse(binding.identicalOffsets)
      assert.deepEqual(
        binding.slots.map((slot) => [slot.storageOffset, slot.transportOffset]),
        [
          [0, 4],
          [4, 8],
        ],
      )
      assert.isTrue(ValueStorage.bind(view, target, 8).identicalOffsets)
      assert.deepEqual(
        (yield* ValueStorage.verify({ ...module.layout, valueStorage: [] })).map(
          (violation) => violation.rule,
        ),
        ['InvalidValueStorage'],
      )
      assert.deepEqual(
        (yield* ValueStorage.verify({
          ...module.layout,
          valueStorage: module.layout.valueStorage.map((candidate) =>
            candidate === view ? { ...view, size: view.size + 4 } : candidate,
          ),
        })).map((violation) => violation.rule),
        ['InvalidValueStorage'],
      )
    }
  }),
)

it.effect(
  'classifies concrete places and maps padded union alternatives within their stored extents',
  () =>
    Effect.gen(function* () {
      for (const target of [Target.wasm32UnknownUnknown, Target.aarch64AppleDarwin]) {
        const snapshot = yield* AnalysisFixture.retainingMain(
          'layout/places',
          ascii(`
struct Wide { marker: u8 wide: i64 items: [i32; 2] }
struct Small { value: i32 }
struct Empty {}
union Pair { Narrow {left: i32, right: i32}, Wide {left: i64, right: i64} }
fn choose(flag: bool) -> Wide | Small {
  if flag { return Wide { marker: 1, wide: 2, items: [3, 4] } }
  return Small { value: 42 }
}
pub fn main() -> i32 {
  let pair = Pair.Narrow {left: 1, right: 2}
  let right = match &pair { Pair.Narrow {right, ..} => right Pair.Wide {..} => 0 }
  drop right
  let empty = Empty {}
  drop empty
  let candidate = choose(false)
  return match move candidate { Wide { marker, wide, items } => items[0] Small { value } => value }
}`),
          target.id,
        )
        assert.deepEqual(Analysis.diagnostics(snapshot), [])
        const module = Analysis.loweredMir(snapshot)
        assert.strictEqual(NativeValue.classify(module.layout, { _tag: 'i32' }), 'Direct')
        assert.strictEqual(
          NativeValue.classify(module.layout, {
            _tag: 'String',
            type: Type.string(Lifetime.staticLifetime),
          }),
          'Direct',
        )
        assert.strictEqual(
          NativeValue.classify(module.layout, {
            _tag: 'Nominal',
            type: Type.nominal('layout/places', 'Empty'),
          }),
          'Empty',
        )
        assert.strictEqual(
          NativeValue.classify(module.layout, {
            _tag: 'Nominal',
            type: Type.nominal('layout/places', 'Wide'),
          }),
          'Place',
        )
        assert.strictEqual(
          NativeValue.classify(module.layout, {
            _tag: 'FixedArray',
            type: Type.fixedArray('i32', 2),
          }),
          'Place',
        )
        assert.strictEqual(
          NativeValue.classify(module.layout, {
            _tag: 'EnvironmentBorrow',
            type: 'i32',
            access: 'Shared',
          }),
          'BorrowedPlace',
        )
        const union =
          module.functions.flatMap((fn) => fn.localTypes).find((type) => type._tag === 'Union') ??
          unreachable('expected union')
        assert.strictEqual(NativeValue.classify(module.layout, union), 'Place')
        if (union._tag !== 'Union') return unreachable('expected union')
        const stored =
          Layout.entry(module.layout, union.type) ?? unreachable('expected stored union')
        const shape =
          Layout.callingShape(module.layout, union.type) ?? unreachable('expected carrier')
        const locations = shape.lanes.map(
          (lane) =>
            ValueStorage.location(module.layout, union.type, lane) ??
            unreachable('expected mapped lane'),
        )
        const check = (location: ValueStorage.Location): void => {
          if (location._tag === 'Slot') {
            const physical = ValueStorage.scalarLayout(target, location.lane)
            assert.strictEqual(location.offset % physical.alignment, 0)
            assert.isAtMost(location.offset + physical.size, stored.size)
          } else {
            assert.isAtMost(location.tagOffset + 4, stored.size)
            for (const alternative of location.alternatives) check(alternative.location)
          }
        }
        for (const location of locations) check(location)
        assert.isTrue(
          locations.some(
            (location) => location._tag === 'Choice' && location.alternatives.length === 2,
          ),
        )
        const pair = Type.nominal('layout/places', 'Pair')
        const pairEntry = Layout.entry(module.layout, pair) ?? unreachable('expected nominal pair')
        const pairShape =
          Layout.callingShape(module.layout, pair) ?? unreachable('expected pair calling shape')
        const rightLane = pairShape.lanes.at(2) ?? unreachable('expected right calling lane')
        const rightLocation = ValueStorage.location(module.layout, pair, rightLane)
        assert.strictEqual(rightLocation?._tag, 'Choice')
        if (rightLocation?._tag !== 'Choice' || pairEntry.representation._tag !== 'NominalUnion')
          return unreachable('expected canonical variant locations')
        const payloadOffset = pairEntry.representation.payloadOffset
        assert.deepEqual(
          rightLocation.alternatives.map((alternative) =>
            alternative.location._tag === 'Slot' ? alternative.location.offset - payloadOffset : -1,
          ),
          [4, 8],
        )
      }
    }),
)

it.effect('binds a complete nested union payload that contains an imported opaque aggregate', () =>
  Effect.gen(function* () {
    const sourceId = 'layout/imported-opaque-union'
    const selected = AnalysisFixture.configuration(sourceId)
    const snapshot = yield* Analysis.make({
      root: sourceId,
      configuration: selected,
    }).pipe(
      Effect.flatMap((frontend) => Analysis.realize(frontend, selected)),
      Effect.provide(
        SourceResolver.overlay([
          SourceFile.make(
            sourceId,
            ascii(`
import silk.result { Result }
import layout.problem { Problem }

fn extract(result: Result<i32, Problem>) -> Problem {
  return match move result {
    Result<i32, Problem>.Success { value } => Problem.Limit { kind: value, limit: 0 }
    Result<i32, Problem>.Failure { error } => move error
  }
}

fn consume(problem: Problem) -> i32 {
  return match move problem {
    Problem.Limit { kind, .. } => kind
    _ => 0
  }
}

pub fn main() -> i32 {
  let problem = Problem.Limit { kind: 1, limit: 0 }
  let result = Result<i32, Problem>.failResult(move problem)
  let extracted = extract(move result)
  return consume(move extracted)
}`),
          ),
        ]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map([
                [
                  'layout/problem',
                  ascii(`
import silk.filesystem { FileError }

pub union Problem {
  File { pub operation: i32, pub error: FileError },
  Limit { pub kind: i32, pub limit: usize }
}`),
                ],
              ]),
            ),
          ),
        ),
      ),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const module = Analysis.loweredMir(snapshot)
    const bindings = module.functions
      .filter((candidate) => candidate.id.module === sourceId)
      .flatMap((candidate) => MirLinearization.linearize(candidate))
      .flatMap((block) => block.operations)
      .filter(
        (operation) =>
          operation._tag === 'BindMatch' &&
          Type.encode(Mir.semanticType(operation.type)) === 'layout/problem.Problem',
      )
      .map((operation) => {
        if (operation._tag !== 'BindMatch') return unreachable('expected match binding')
        const physical = Layout.coverageFieldSlots(
          operation.shape,
          operation.member,
          operation.path,
        )
        const target = Layout.callingShape(module.layout, Mir.semanticType(operation.type))
        return {
          physical: physical?.length,
          target: target?.lanes.length,
        }
      })
    assert.isNotEmpty(bindings)
    assert.deepEqual(
      bindings.filter((binding) => binding.physical !== binding.target),
      [],
    )
  }),
)

it.effect('retains the outer union tag when binding a whole value for cleanup', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'layout/nested-error',
      ascii(`
import silk.vector { Vector }
union Problem { Value { value: i32 }, Owned { values: Vector<i32> } }
struct Other {}
fn inspect(problem: Problem | Other) -> i32 {
  return match move problem {
    Problem.Value {value} => value
    _ => 0
  }
}
pub fn main() -> i32 { return inspect(Problem.Value {value: 42}) }
`),
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    const module = Analysis.loweredMir(self)
    const bindings = module.functions
      .flatMap(MirLinearization.linearize)
      .flatMap((block) => block.operations)
      .filter((operation) => operation._tag === 'BindMatch')
    assert.isNotEmpty(bindings)
    for (const operation of bindings) {
      const physical = Layout.coverageBindingSlots(
        operation.shape,
        operation.member,
        operation.path,
        Mir.semanticType(operation.type),
      )
      const target = Layout.callingShape(module.layout, Mir.semanticType(operation.type))
      assert.strictEqual(
        physical?.length,
        target?.lanes.length,
        Type.encode(Mir.semanticType(operation.type)),
      )
    }
  }),
)

it('plans transport from its actual start without treating tail padding as payload', () => {
  const lanes: ReadonlyArray<Layout.CallingLane> = [
    { _tag: 'CallingLane', path: [], type: 'u8' },
    { _tag: 'CallingLane', path: [], type: 'f64' },
    { _tag: 'CallingLane', path: [], type: { _tag: 'Address', element: 'u8', bits: 64 } },
  ]
  const packed = ValueStorage.transport(Target.aarch64AppleDarwin, lanes, 3)
  assert.deepEqual(
    packed.entries.map((slot) => slot.offset),
    [3, 8, 16],
  )
  assert.strictEqual(packed.end, 24)
  assert.notDeepEqual(
    packed.entries.map((slot) => slot.offset - 3),
    ValueStorage.transport(Target.aarch64AppleDarwin, lanes).entries.map((slot) => slot.offset),
  )
  assert.isUndefined(ValueStorage.transportWithin(Target.aarch64AppleDarwin, lanes, 3, 23))
  assert.isUndefined(ValueStorage.transportWithin(Target.wasm32UnknownUnknown, lanes, -1, 24))
  assert.isUndefined(
    ValueStorage.transportWithin(
      Target.aarch64AppleDarwin,
      lanes,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ),
  )
})
it.effect(
  'retains typed address and floating carriers and zero-byte outcome members',
  Effect.fnUntraced(function* () {
    const string = Type.string(Lifetime.staticLifetime)
    for (const target of [Target.wasm32UnknownUnknown, Target.aarch64AppleDarwin]) {
      for (const success of ['u8', 'f64', string, Layout.neverEntry().type] as const) {
        const effect = Type.effect(success, [], {
          environment: Lifetime.staticLifetime,
          lifetimeBinders: [],
        })
        const entries = [
          Layout.scalarEntry(target, 'u8'),
          Layout.scalarEntry(target, 'f64'),
          Layout.stringEntry(target, string),
          Layout.neverEntry(),
        ]
        const base = {
          ...(yield* Layout.make(target, ['i32'])),
          entries,
          callingShapes: yield* Layout.planCallingShapes(target, entries, [
            ...entries.map((entry) => entry.type),
            effect,
          ]),
        }
        const views = ValueStorage.plan(base)
        const view =
          views.find((view) => view.role === 'Outcome') ?? unreachable('expected outcome')
        assert.strictEqual(view._tag, 'ValueStorage')
        if (view._tag !== 'ValueStorage') continue
        assert.deepEqual(yield* ValueStorage.verify({ ...base, valueStorage: views }), [])
        const member = view.members.at(0) ?? unreachable('expected success member')
        assert.deepEqual(
          member.lanes.map((mapping) => mapping.lane),
          Layout.callingShape(base, success)?.lanes,
        )
        for (const slot of view.slots) {
          assert.strictEqual(slot.offset % slot.alignment, 0)
          assert.isAtMost(slot.offset + slot.size, view.size)
        }
        if (Type.isNever(success)) {
          assert.deepEqual(member.lanes, [])
          assert.strictEqual(view.size, 4)
        }
        if (Type.isString(success))
          assert.strictEqual(typeof member.lanes.at(0)?.lane.type, 'object')
        if (success === 'f64') assert.strictEqual(view.slots.at(1)?.lane.type, 'f64')
        assert.strictEqual(
          ValueStorage.encode(view),
          ValueStorage.encode(
            ValueStorage.plan(base).find((candidate) => candidate.key === view.key) ??
              unreachable('expected repeat'),
          ),
        )
      }
    }
  }),
)

class CLayoutOracleError extends Data.TaggedError('CLayoutOracleError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const cLayoutOracleToolchain: NativeToolchain.Toolchain = Object.freeze({
  _tag: 'Toolchain',
  clang: Effect.runSync(Config.String('SILK_TEST_CLANG').pipe(Config.withDefault('clang'))),
  llvmAr: 'llvm-ar',
  runtimeObjectCache: NativeToolchain.makeRuntimeObjectCache(),
})

it('plans opaque local-shared blocks without exposing field offsets to source layout data', () => {
  const scalar: Layout.Entry = Object.freeze({
    _tag: 'LayoutEntry',
    type: 'i32',
    copy: true,
    size: 4,
    alignment: 4,
    representation: Object.freeze({ _tag: 'SignedInteger', bits: 32 }),
  })
  const zst: Layout.Entry = Object.freeze({
    _tag: 'LayoutEntry',
    type: Type.unit,
    copy: true,
    size: 0,
    alignment: 1,
    representation: Object.freeze({ _tag: 'Aggregate', fields: Object.freeze([]), tailPadding: 0 }),
  })
  const wasm = LocalSharedControlBlock.plan(Target.wasm32UnknownUnknown, 'i32', scalar)
  const native = LocalSharedControlBlock.plan(Target.aarch64AppleDarwin, 'i32', scalar)
  const zero = LocalSharedControlBlock.plan(Target.aarch64AppleDarwin, Type.unit, zst)
  assert.strictEqual(wasm._tag, 'LocalSharedControlBlockPlan')
  assert.strictEqual(native._tag, 'LocalSharedControlBlockPlan')
  assert.strictEqual(zero._tag, 'LocalSharedControlBlockPlan')
  if (
    wasm._tag !== 'LocalSharedControlBlockPlan' ||
    native._tag !== 'LocalSharedControlBlockPlan' ||
    zero._tag !== 'LocalSharedControlBlockPlan'
  )
    return
  assert.deepEqual({ size: wasm.size, alignment: wasm.alignment }, { size: 36, alignment: 4 })
  assert.deepEqual({ size: native.size, alignment: native.alignment }, { size: 72, alignment: 8 })
  assert.deepEqual({ size: zero.size, alignment: zero.alignment }, { size: 64, alignment: 8 })
  assert.notStrictEqual(wasm.provenance, native.provenance)
})

it('classifies every checked local-shared layout overflow before execution', () => {
  const payload = (size: number, alignment: number): Layout.Entry =>
    Object.freeze({
      _tag: 'LayoutEntry',
      type: 'i32',
      copy: true,
      size,
      alignment,
      representation: Object.freeze({ _tag: 'SignedInteger', bits: 32 }),
    })
  const reason = (selection: LocalSharedControlBlock.Selection) =>
    selection._tag === 'LocalSharedControlBlockUnavailable' ? selection.reason : undefined
  assert.strictEqual(
    reason(
      LocalSharedControlBlock.planWithin(Target.wasm32UnknownUnknown, 'i32', payload(4, 4), 4),
    ),
    'HeaderAddition',
  )
  assert.strictEqual(
    reason(
      LocalSharedControlBlock.planWithin(Target.wasm32UnknownUnknown, 'i32', payload(1, 1), 32),
    ),
    'PayloadPlacement',
  )
  assert.strictEqual(
    reason(
      LocalSharedControlBlock.planWithin(Target.wasm32UnknownUnknown, 'i32', payload(1, 8), 35),
    ),
    'AlignmentRounding',
  )
})

it('compares a target-sized local-shared count before incrementing', () => {
  assert.strictEqual(
    LocalSharedControlBlock.strongMaximum(Target.wasm32UnknownUnknown),
    0xffff_ffffn,
  )
  assert.strictEqual(
    LocalSharedControlBlock.strongMaximum(Target.aarch64AppleDarwin),
    0xffff_ffff_ffff_ffffn,
  )
  const before = Object.freeze({ count: 2n, maximum: 3n })
  const cloned = LocalSharedLifecycle.clone(before)
  assert.deepEqual(cloned, {
    _tag: 'Cloned',
    state: { count: 3n, maximum: 3n },
  })
  const rejected = LocalSharedLifecycle.clone(cloned._tag === 'Cloned' ? cloned.state : before)
  assert.deepEqual(rejected, {
    _tag: 'StrongOverflow',
    state: { count: 3n, maximum: 3n },
  })
})

it('selects exactly one local-shared access branch and preserves an active outer access', () => {
  const outer = LocalSharedLifecycle.beginAccess('Available')
  assert.deepEqual(outer, { _tag: 'Use', state: 'Active' })
  const nested = LocalSharedLifecycle.beginAccess(outer.state)
  assert.deepEqual(nested, { _tag: 'Conflict', state: 'Active' })
  assert.strictEqual(LocalSharedLifecycle.endAccess(nested.state), 'Available')
  assert.deepEqual(LocalSharedLifecycle.drop({ count: 2n, maximum: 3n }), {
    _tag: 'Decremented',
    state: { count: 1n, maximum: 3n },
  })
  assert.deepEqual(LocalSharedLifecycle.drop({ count: 1n, maximum: 3n }), {
    _tag: 'LastHandle',
  })
})

it('selects primitive conflict beneath every later public shared/exclusive nested shape', () => {
  const publicAccesses = ['Shared', 'Exclusive'] as const
  for (const outer of publicAccesses) {
    for (const inner of publicAccesses) {
      const entered = LocalSharedLifecycle.beginAccess('Available')
      assert.deepEqual(entered, { _tag: 'Use', state: 'Active' }, `${outer}/${inner}: outer`)
      assert.deepEqual(
        LocalSharedLifecycle.beginAccess(entered.state),
        { _tag: 'Conflict', state: 'Active' },
        `${outer}/${inner}: inner`,
      )
    }
  }
})

it.effect('rejects an unrepresentable local-shared block at its layout call before MIR', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'layout/local-shared-overflow',
      ascii(`import silk.layout { Layout }
pub fn main() -> i32 {
  let layout = Intrinsic.sharedLayout<[[u8; 2147483647]; 2]>()
  drop layout
  return 42
}`),
      'wasm32-unknown-unknown',
    )
    const unavailable = Analysis.diagnostics(snapshot).find(
      (diagnostic) => diagnostic.code === 'SEM0093',
    )
    assert.strictEqual(unavailable?.reason._tag, 'IntrinsicTargetUnavailable')
    assert.strictEqual(unavailable?.span.sourceId, 'layout/local-shared-overflow')
    assert.strictEqual(unavailable?.span.start, 68)
    assert.strictEqual(unavailable?.span.end, 115)
    assert.throws(() => Analysis.loweredMir(snapshot), /MIR is unavailable/)
  }),
)

it.effect('plans only concrete types reached through discovered instances', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'layout/program',
      ascii(`pub fn unused(value: bool) -> bool { return value }
pub fn main() -> i32 { return 42 }`),
    )
    const catalog = yield* Layout.computeTypes(
      Target.aarch64AppleDarwin,
      Analysis.declarationIndex(snapshot),
      snapshot.resolution.contexts,
    )
    const plan = yield* Layout.computeRuntime(
      catalog,
      Analysis.instancesOf(snapshot),
      snapshot.index,
    )

    assert.deepEqual(
      plan.entries.map((candidate) => candidate.type),
      ['i32'],
    )
    assert.deepEqual(yield* LayoutVerify.verify(plan), [])
  }),
)

it.effect('plans nominal types carried through Evaluate expressions', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'layout/evaluate',
      ascii(`struct Token { value: i32 }
fn consume(token: Token) -> () { drop move token return () }
pub fn main() -> i32 { consume(Token { value: 1 }) return 0 }`),
    )

    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.deepEqual(
      Analysis.instancesOf(snapshot).instances.map((instance) => instance.key.declaration.name),
      ['main', 'consume'],
    )
    const plan = Analysis.layoutOf(snapshot)
    assert.strictEqual(plan._tag, 'Available')
    if (plan._tag !== 'Available') return
    assert.include(
      plan.value.entries.map((entry) => Type.encode(entry.type)),
      'layout/evaluate.Token',
    )
    assert.deepEqual(yield* LayoutVerify.verify(plan.value), [])
  }),
)

it.effect('plans hidden Effect capture environments by construction site and target', () =>
  Effect.gen(function* () {
    for (const target of [Target.wasm32UnknownUnknown, Target.aarch64AppleDarwin]) {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'layout/effect-environment',
        ascii(`pub fn main() -> i32 {
  let mut counter = 0
  let pending = effect { counter = counter + 1 return counter }
  return 0
}`),
        target.id,
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const plan = Analysis.layoutOf(snapshot)
      assert.strictEqual(plan._tag, 'Available')
      if (plan._tag !== 'Available') continue
      const environment = plan.value.effectEnvironments.at(0)
      assert.strictEqual(environment?._tag, 'EffectEnvironment')
      if (environment?._tag !== 'EffectEnvironment') continue
      assert.strictEqual(environment.fields.length, 1)
      assert.strictEqual(environment.fields.at(0)?.access, 'Exclusive')
      assert.strictEqual(environment.fields.at(0)?.representation, 'Borrow')
      assert.strictEqual(environment.size, target.pointerSize)
      assert.strictEqual(environment.alignment, target.pointerAlignment)
      assert.deepEqual(yield* LayoutVerify.verify(plan.value), [])
    }
  }),
)

it.effect('plans target-aware callable environments and ephemeral code/environment views', () =>
  Effect.gen(function* () {
    for (const target of [Target.wasm32UnknownUnknown, Target.aarch64AppleDarwin]) {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'layout/callable-environment',
        ascii(`struct Token { value: i32 }
fn choose(value: i32, values: &mut [i32], token: Token) -> i32 { return value }
pub fn main() -> i32 {
  let mut values = [1]
  let token = Token { value: 2 }
  let callback = choose(&mut values, move token)
  return 0
}`),
        target.id,
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      assert.strictEqual(Analysis.instancesOf(snapshot).callables.length, 1)
      const plan = Analysis.layoutOf(snapshot)
      assert.strictEqual(plan._tag, 'Available')
      if (plan._tag !== 'Available') continue
      const environment = plan.value.callableEnvironments.at(0)
      assert.strictEqual(environment?._tag, 'CallableEnvironment')
      if (environment?._tag !== 'CallableEnvironment') continue
      assert.strictEqual(environment.callable.mode, 'Take')
      assert.deepEqual(
        environment.fields.map((field) => ({
          access: field.access,
          representation: field.representation,
          offset: field.offset,
        })),
        [
          // A slice capture is already a stable borrow descriptor and is stored inline.
          { access: 'Exclusive', representation: 'Value', offset: 0 },
          { access: 'Take', representation: 'Value', offset: target.pointerSize * 2 },
        ],
      )
      assert.strictEqual(environment.size, target.pointerSize === 4 ? 12 : 24)
      assert.deepEqual(environment.view, {
        codeOffset: 0,
        environmentOffset: target.pointerSize,
        size: target.pointerSize * 2,
        alignment: target.pointerAlignment,
        pointerBits: target.pointerSize === 4 ? 32 : 64,
      })
      assert.deepEqual(yield* LayoutVerify.verify(plan.value), [])
    }
  }),
)

it.effect('plans every scalar enum as one exact nominal integer lane with no metadata', () =>
  Effect.gen(function* () {
    const source = `enum Default { Only }
enum(u8) U8 { Value }
enum(u16) U16 { Value }
enum(u32) U32 { Value }
enum(u64) U64 { Value }
enum(i8) I8 { Value = -1 }
enum(i16) I16 { Value = -1 }
enum(i32) I32 { Value = -1 }
enum(i64) I64 { Value = -1 }
pub fn main() -> i32 { return 0 }`
    const expected: ReadonlyArray<readonly [string, Type.Builtin, number]> = [
      ['Default', 'u8', 1],
      ['U8', 'u8', 1],
      ['U16', 'u16', 2],
      ['U32', 'u32', 4],
      ['U64', 'u64', 8],
      ['I8', 'i8', 1],
      ['I16', 'i16', 2],
      ['I32', 'i32', 4],
      ['I64', 'i64', 8],
    ]
    for (const target of Target.all) {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'layout/scalar-enums',
        ascii(source),
        target.id,
      )
      const catalog = Analysis.layoutCatalogOf(snapshot)
      assert.strictEqual(catalog._tag, 'Available')
      if (catalog._tag !== 'Available') continue
      for (const [name, lane, bytes] of expected) {
        const entry = Layout.catalogEntry(catalog.value, Type.nominal('layout/scalar-enums', name))
        assert.strictEqual(entry?._tag, 'LayoutEntry')
        if (entry?._tag !== 'LayoutEntry') continue
        assert.strictEqual(entry.copy, true)
        assert.strictEqual(entry.size, bytes)
        assert.strictEqual(entry.alignment, bytes)
        assert.strictEqual(entry.representation._tag, 'ScalarEnum')
        if (entry.representation._tag !== 'ScalarEnum' || !Type.isNominal(entry.type)) continue
        assert.strictEqual(entry.representation.scalar, lane)
        assert.strictEqual(entry.representation.bits, bytes * 8)
        assert.strictEqual(
          entry.representation.signedness,
          lane.startsWith('i') ? 'Signed' : 'Unsigned',
        )
        assert.strictEqual('hiddenMetadata' in entry.representation, false)
        assert.isUndefined(entry.executable)
        const shape = (yield* Layout.planCallingShapes(target, [entry])).at(0)
        assert.deepEqual(shape?.tree, {
          _tag: 'ScalarEnumShape',
          type: entry.type,
          lane,
          laneCount: 1,
        })
        assert.strictEqual(shape?.laneCount, 1)
        assert.deepEqual(shape?.lanes, [{ _tag: 'CallingLane', path: [], type: lane }])
        assert.deepEqual(LayoutVerify.verifyCatalog(catalog.value, snapshot.index), [])
      }
    }
  }),
)

it.effect('rejects malformed scalar enum width, signedness, metadata, and calling lanes', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'layout/verify-scalar-enum',
      ascii(`enum State { Ready }
pub fn main() -> i32 { let state = State.Ready drop state return 0 }`),
    )
    const planned = Analysis.layoutOf(snapshot)
    assert.strictEqual(planned._tag, 'Available')
    if (planned._tag !== 'Available') return
    const entry = Layout.entry(planned.value, Type.nominal('layout/verify-scalar-enum', 'State'))
    assert.strictEqual(entry?.representation._tag, 'ScalarEnum')
    if (entry?.representation._tag !== 'ScalarEnum' || !Type.isNominal(entry.type)) return
    const enumType = entry.type
    const malformedLane = 'u16' as const
    const malformedBits = 16 as const
    const malformedSignedness = 'Signed' as const
    const malformedRepresentation = {
      ...entry.representation,
      scalar: malformedLane,
      bits: malformedBits,
      signedness: malformedSignedness,
      hiddenMetadata: 1,
    }
    const malformedEntry: Layout.Entry = {
      ...entry,
      size: 2,
      alignment: 2,
      representation: malformedRepresentation,
    }
    const malformedShape: ReadonlyArray<Layout.CallingShape> = planned.value.callingShapes.map(
      (shape) =>
        Type.equals(shape.type, entry.type)
          ? {
              ...shape,
              tree: { _tag: 'ScalarEnumShape', type: enumType, lane: 'i16', laneCount: 1 },
              lanes: [{ _tag: 'CallingLane', path: [], type: 'i16' }],
            }
          : shape,
    )
    const malformed: Layout.Plan = {
      ...planned.value,
      entries: planned.value.entries.map((candidate) =>
        Type.equals(candidate.type, entry.type) ? malformedEntry : candidate,
      ),
      callingShapes: malformedShape,
    }
    assert.deepEqual(
      (yield* LayoutVerify.verify(malformed)).map((violation) => violation.rule),
      ['InvalidScalar', 'InvalidCallingShape'],
    )
  }),
)

it.effect('isolates invalid scalar enum layouts from valid peers', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'layout/invalid-scalar-enum',
      ascii(`enum(usize) Broken { Value }
enum Good { Only }
pub fn main() -> i32 { return 0 }`),
    )
    const catalog = Analysis.layoutCatalogOf(snapshot)
    const plan = Analysis.layoutOf(snapshot)
    assert.strictEqual(catalog._tag, 'Available')
    assert.strictEqual(plan._tag, 'Available')
    if (catalog._tag !== 'Available' || plan._tag !== 'Available') return
    assert.strictEqual(
      Layout.catalogEntry(catalog.value, Type.nominal('layout/invalid-scalar-enum', 'Broken'))
        ?._tag,
      'UnavailableLayoutEntry',
    )
    assert.strictEqual(
      Layout.catalogEntry(catalog.value, Type.nominal('layout/invalid-scalar-enum', 'Good'))?._tag,
      'LayoutEntry',
    )
  }),
)
it.effect(
  'orders and encodes canonical scalar entries identically on every target',
  Effect.fnUntraced(function* () {
    for (const target of Target.all) {
      const first = yield* Layout.make(target, ['i32', 'bool', 'i32'])
      const second = yield* Layout.make(target, ['bool', 'i32'])
      assert.deepEqual(
        first.entries.map((candidate) => candidate.type),
        ['bool', 'i32'],
      )
      assert.strictEqual(LayoutEncode.encode(first), LayoutEncode.encode(second))
      assert.deepEqual(yield* LayoutVerify.verify(first), [])
    }
  }),
)
it.effect(
  'plans canonical IEEE storage and lanes on every target',
  Effect.fnUntraced(function* () {
    for (const target of Target.all) {
      const plan = yield* Layout.make(target, ['f64', 'f32'])
      assert.deepEqual(
        plan.entries.map((entry) => ({
          type: entry.type,
          size: entry.size,
          alignment: entry.alignment,
          representation: entry.representation,
        })),
        [
          {
            type: 'f32',
            size: 4,
            alignment: 4,
            representation: { _tag: 'Floating', bits: 32, ieee: true },
          },
          {
            type: 'f64',
            size: 8,
            alignment: 8,
            representation: { _tag: 'Floating', bits: 64, ieee: true },
          },
        ],
      )
      assert.deepEqual(yield* LayoutVerify.verify(plan), [])
    }
  }),
)

it.effect(
  'plans tagged effect outcomes for zero-lane success and target-sized failure payloads',
  () =>
    Effect.gen(function* () {
      const source = `import silk.effect { Effect }
struct Empty {}
struct Problem { position: usize }
effect fn risky() -> Empty ! Problem { fail move Problem { position: 1 } }
effect fn recover(problem: Problem) -> Empty { return Empty {} }
pub fn main() -> i32 {
  let recipe = Effect.catchAll(risky(), recover)
  let ignored = run recipe
  return 42
}`
      for (const target of Target.all) {
        const snapshot = yield* AnalysisFixture.retainingMain(
          'layout/effect-outcome',
          ascii(source),
          target.id,
        )
        assert.deepEqual(Analysis.diagnostics(snapshot), [])
        const planned = Analysis.layoutOf(snapshot)
        assert.strictEqual(planned._tag, 'Available')
        if (planned._tag !== 'Available') continue
        const outcomes = planned.value.callingShapes.filter(
          (shape) => Type.isEffect(shape.type) && Type.failureMembers(shape.type).length > 0,
        )
        assert.isAbove(outcomes.length, 0)
        for (const outcome of outcomes) {
          assert.strictEqual(outcome.tree._tag, 'OutcomeShape')
          assert.strictEqual(outcome.lanes.at(0)?.type, 'i32')
          assert.strictEqual(outcome.lanes.at(1)?.type, 'usize')
        }
        assert.deepEqual(yield* LayoutVerify.verify(planned.value), [])
      }
    }),
  // Every target outcome layout took 20.2s locally on 2026-09-23 and exceeded 60s in CI shard 2.
  120_000,
)

it.effect('rejects non-canonical failure tags before payload-member indexing', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'layout/failure-tags',
      ascii(`import silk.effect { Effect }
struct A { code: i32 }
struct B { code: f64 }
effect fn risky(flag: bool) -> i32 ! A | B {
  if flag { fail A { code: 1 } }
  fail B { code: 2.0 }
}
effect fn recover(problem: A | B) -> i32 {
  return match move problem {
    A { code } => code
    B { code } => 0
  }
}
pub fn main() -> i32 { return run Effect.catchAll(risky(true), recover) }`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const planned = Analysis.layoutOf(snapshot)
    assert.strictEqual(planned._tag, 'Available')
    if (planned._tag !== 'Available') return

    const a = Type.nominal('layout/failure-tags', 'A')
    const b = Type.nominal('layout/failure-tags', 'B')
    const normalizedUnion = Type.union([a, b])
    assert.strictEqual(normalizedUnion._tag, 'Normalized')
    if (normalizedUnion._tag !== 'Normalized' || !Type.isUnion(normalizedUnion.type)) return
    const union = normalizedUnion.type
    const effect = planned.value.callingShapes
      .map((shape) => shape.type)
      .find(
        (type): type is Type.Effect =>
          Type.isEffect(type) &&
          Type.failureMembers(type).length === 2 &&
          Type.failureMembers(type).some((failure) => Type.equals(failure, a)),
      )
    assert.notStrictEqual(effect, undefined)
    if (effect === undefined) return
    const targetTag =
      Type.failureMembers(effect).findIndex((failure) => Type.equals(failure, a)) + 1
    const unionTag = union.members.findIndex((member) => Type.equals(member, a))
    assert.isAbove(targetTag, 0)
    assert.isAtLeast(unionTag, 0)
    assert.notStrictEqual(
      Layout.failurePayloadRepacking(planned.value, a, 0, effect, targetTag),
      undefined,
    )
    assert.notStrictEqual(
      Layout.failurePayloadRepacking(planned.value, union, unionTag, effect, targetTag),
      undefined,
    )
    assert.notStrictEqual(
      Layout.failurePayloadRepacking(planned.value, effect, targetTag, effect, targetTag),
      undefined,
    )

    const invalidTags = [-1, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]
    for (const tag of invalidTags) {
      assert.strictEqual(
        Layout.failurePayloadRepacking(planned.value, a, tag, effect, targetTag),
        undefined,
      )
      assert.strictEqual(
        Layout.failurePayloadRepacking(planned.value, union, tag, effect, targetTag),
        undefined,
      )
      assert.strictEqual(
        Layout.failurePayloadRepacking(planned.value, effect, tag, effect, targetTag),
        undefined,
      )
      assert.strictEqual(
        Layout.failurePayloadRepacking(planned.value, effect, targetTag, effect, tag),
        undefined,
      )
    }
    assert.strictEqual(
      Layout.failurePayloadRepacking(planned.value, effect, 0, effect, targetTag),
      undefined,
    )
    assert.strictEqual(
      Layout.failurePayloadRepacking(planned.value, effect, targetTag, effect, 0),
      undefined,
    )
  }),
)
it.effect(
  'reports malformed target, order, duplicates, and scalar facts as data',
  Effect.fnUntraced(function* () {
    const canonical = yield* Layout.make(Target.aarch64AppleDarwin, ['bool', 'i32'])
    const bool = canonical.entries.at(0)
    const i32 = canonical.entries.at(1)
    if (bool === undefined || i32 === undefined) throw new Error('expected scalar layouts')
    const malformed: Layout.Plan = {
      ...canonical,
      target: { ...Target.aarch64AppleDarwin, pointerSize: 4 },
      entries: [i32, { ...bool, size: 1 }, bool],
    }

    assert.deepEqual(
      (yield* LayoutVerify.verify(malformed)).map((violation) => violation.rule),
      [
        'NonCanonicalTarget',
        'NonCanonicalOrder',
        'InvalidScalar',
        'DuplicateType',
        'InvalidCallingShape',
      ],
    )
  }),
)

it.effect(
  'catalogs empty and nested structs before reachability and reuses their exact entries',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'layout/catalog',
        ascii(`struct Empty {}
struct Pair { left: i32 right: bool }
struct Outer { marker: Empty pair: Pair }
struct Unused { value: i32 }
fn make() -> Outer { return Outer { marker: Empty {}, pair: Pair { right: true, left: 42 } } }
pub fn main() -> i32 { let outer = make() return outer.pair.left }`),
        'wasm32-unknown-unknown',
      )
      const catalog = Analysis.layoutCatalogOf(snapshot)
      const plan = Analysis.layoutOf(snapshot)
      assert.strictEqual(catalog._tag, 'Available')
      assert.strictEqual(plan._tag, 'Available')
      if (catalog._tag !== 'Available' || plan._tag !== 'Available') return

      assert.deepEqual(
        catalog.value.entries.map((candidate) => Type.encode(candidate.type)).sort(),
        [
          'layout/catalog.Empty',
          'layout/catalog.Outer',
          'layout/catalog.Pair',
          'layout/catalog.Unused',
        ],
      )
      const empty = Layout.catalogEntry(catalog.value, Type.nominal('layout/catalog', 'Empty'))
      const pair = Layout.catalogEntry(catalog.value, Type.nominal('layout/catalog', 'Pair'))
      const outer = Layout.catalogEntry(catalog.value, Type.nominal('layout/catalog', 'Outer'))
      assert.strictEqual(empty?._tag, 'LayoutEntry')
      assert.strictEqual(pair?._tag, 'LayoutEntry')
      assert.strictEqual(outer?._tag, 'LayoutEntry')
      if (
        empty?._tag !== 'LayoutEntry' ||
        pair?._tag !== 'LayoutEntry' ||
        outer?._tag !== 'LayoutEntry' ||
        pair.representation._tag !== 'Aggregate' ||
        outer.representation._tag !== 'Aggregate'
      )
        return
      assert.deepEqual([empty.size, empty.alignment], [0, 1])
      assert.deepEqual(
        pair.representation.fields.map((field) => [field.name, field.offset, field.padding]),
        [
          ['left', 0, 0],
          ['right', 4, 0],
        ],
      )
      assert.deepEqual([pair.size, pair.alignment, pair.representation.tailPadding], [8, 4, 0])
      assert.deepEqual(
        outer.representation.fields.map((field) => [field.name, field.offset, field.size]),
        [
          ['marker', 0, 0],
          ['pair', 0, 8],
        ],
      )
      assert.deepEqual(LayoutVerify.verifyCatalog(catalog.value, snapshot.index), [])
      assert.deepEqual(LayoutVerify.verifyAgainstCatalog(plan.value, catalog.value), [])
      assert.strictEqual(Layout.entry(plan.value, Type.nominal('layout/catalog', 'Outer')), outer)
      assert.strictEqual(
        Layout.entry(plan.value, Type.nominal('layout/catalog', 'Unused')),
        undefined,
      )
    }),
)

it.effect('plans nominal union tags and variant-local payload layouts', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'layout/nominal-union',
      ascii(`union State { Ready, Data { flag: bool, value: i64 }, Empty { impossible: never } }
union Box<T> { Full { value: T }, Vacant }
fn retain(value: Box<i32>) -> Box<i32> { return move value }
pub fn main() -> i32 { return 0 }`),
      'wasm32-unknown-unknown',
    )
    const catalog = Analysis.layoutCatalogOf(snapshot)
    const plan = Analysis.layoutOf(snapshot)
    assert.strictEqual(catalog._tag, 'Available')
    assert.strictEqual(plan._tag, 'Available')
    if (catalog._tag !== 'Available' || plan._tag !== 'Available') return

    const state = Layout.catalogEntry(catalog.value, Type.nominal('layout/nominal-union', 'State'))
    const box = Layout.catalogEntry(
      catalog.value,
      Type.nominal('layout/nominal-union', 'Box', ['i32']),
    )
    assert.strictEqual(state?._tag, 'LayoutEntry')
    assert.strictEqual(box?._tag, 'LayoutEntry')
    if (
      state?._tag !== 'LayoutEntry' ||
      state.representation._tag !== 'NominalUnion' ||
      box?._tag !== 'LayoutEntry' ||
      box.representation._tag !== 'NominalUnion'
    )
      return

    assert.deepEqual(
      state.representation.variants.map((variant) => [
        variant.variant.name,
        variant.ordinal,
        variant.fields.map((field) => [field.name, field.offset]),
      ]),
      [
        ['Ready', 0, []],
        [
          'Data',
          1,
          [
            ['flag', 0],
            ['value', 8],
          ],
        ],
        ['Empty', 2, [['impossible', 0]]],
      ],
    )
    assert.deepEqual(
      [
        state.representation.payloadOffset,
        state.representation.payloadSize,
        state.size,
        state.alignment,
      ],
      [8, 16, 24, 8],
    )
    assert.deepEqual(
      box.representation.variants.map((variant) => [variant.variant.name, variant.size]),
      [
        ['Full', 4],
        ['Vacant', 0],
      ],
    )
    const boxType = Type.nominal('layout/nominal-union', 'Box', ['i32'])
    const boxShape = (yield* Layout.planCallingShapes(
      Target.wasm32UnknownUnknown,
      catalog.value.entries.flatMap((entry) => (entry._tag === 'LayoutEntry' ? [entry] : [])),
      [boxType],
    )).at(0)
    assert.strictEqual(boxShape?.tree._tag, 'NominalUnionShape')
    assert.deepEqual(
      boxShape?.lanes.map((lane) => lane.path.at(0)?._tag),
      ['NominalUnionTagSelector', 'NominalUnionPayloadSelector'],
    )
    assert.include(
      LayoutEncode.encodeCatalog(catalog.value),
      'repr=nominal-union layout/nominal-union.State',
    )
    assert.deepEqual(LayoutVerify.verifyCatalog(catalog.value, snapshot.index), [])
    assert.deepEqual(yield* LayoutVerify.verify(plan.value), [])
  }),
)

it.effect(
  'retains unavailable fields, cycles, and transitive dependencies without harming peers',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'layout/unavailable',
        ascii(`struct Good { value: i32 }
struct Broken { value: Missing }
struct Outer { broken: Broken }
struct Left { right: Right }
struct Right { left: Left }
pub fn main() -> i32 { return 42 }`),
        'aarch64-apple-darwin',
      )
      const selected = Analysis.layoutCatalogOf(snapshot)
      assert.strictEqual(selected._tag, 'Available')
      if (selected._tag !== 'Available') return
      const get = (name: string) =>
        Layout.catalogEntry(selected.value, Type.nominal('layout/unavailable', name))
      const good = get('Good')
      const broken = get('Broken')
      const outer = get('Outer')
      const left = get('Left')
      const right = get('Right')

      assert.strictEqual(good?._tag, 'LayoutEntry')
      assert.strictEqual(broken?._tag, 'UnavailableLayoutEntry')
      assert.strictEqual(outer?._tag, 'UnavailableLayoutEntry')
      assert.strictEqual(left?._tag, 'UnavailableLayoutEntry')
      assert.strictEqual(right?._tag, 'UnavailableLayoutEntry')
      if (
        broken?._tag !== 'UnavailableLayoutEntry' ||
        outer?._tag !== 'UnavailableLayoutEntry' ||
        left?._tag !== 'UnavailableLayoutEntry' ||
        right?._tag !== 'UnavailableLayoutEntry'
      )
        return
      assert.strictEqual(broken.cause?.code, 'SEM0001')
      assert.strictEqual(outer.reason._tag, 'UnavailableDependency')
      assert.strictEqual(outer.cause?.code, 'SEM0001')
      assert.strictEqual(left.cause?.code, 'SEM0020')
      assert.strictEqual(right.cause?.code, 'SEM0020')
      assert.deepEqual(LayoutVerify.verifyCatalog(selected.value, snapshot.index), [])
    }),
)

it.effect(
  'encodes nominal catalogs identically for repeated inputs and preserves target identity',
  () =>
    Effect.gen(function* () {
      const source = ascii(
        'struct Pair { left: i32 right: bool }\npub fn main() -> i32 { return 42 }',
      )
      const first = yield* AnalysisFixture.retainingMain(
        'layout/repeat',
        source,
        'aarch64-apple-darwin',
      )
      const second = yield* AnalysisFixture.retainingMain(
        'layout/repeat',
        source,
        'aarch64-apple-darwin',
      )
      const wasm = yield* AnalysisFixture.retainingMain(
        'layout/repeat',
        source,
        'wasm32-unknown-unknown',
      )
      const firstCatalog = Analysis.layoutCatalogOf(first)
      const secondCatalog = Analysis.layoutCatalogOf(second)
      const wasmCatalog = Analysis.layoutCatalogOf(wasm)
      assert.strictEqual(firstCatalog._tag, 'Available')
      assert.strictEqual(secondCatalog._tag, 'Available')
      assert.strictEqual(wasmCatalog._tag, 'Available')
      if (
        firstCatalog._tag !== 'Available' ||
        secondCatalog._tag !== 'Available' ||
        wasmCatalog._tag !== 'Available'
      )
        return
      assert.strictEqual(
        LayoutEncode.encodeCatalog(firstCatalog.value),
        LayoutEncode.encodeCatalog(secondCatalog.value),
      )
      assert.notStrictEqual(
        LayoutEncode.encodeCatalog(firstCatalog.value),
        LayoutEncode.encodeCatalog(wasmCatalog.value),
      )
    }),
)

it.effect('reports malformed aggregate facts and divergence from the catalog', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'layout/verify-aggregate',
      ascii('extern "C" struct Pair { left: i32 right: i64 }\npub fn main() -> i32 { return 0 }'),
      'aarch64-apple-darwin',
    )
    const selected = Analysis.layoutCatalogOf(snapshot)
    assert.strictEqual(selected._tag, 'Available')
    if (selected._tag !== 'Available') return
    const pair = Layout.catalogEntry(
      selected.value,
      Type.nominal('layout/verify-aggregate', 'Pair'),
    )
    assert.strictEqual(pair?._tag, 'LayoutEntry')
    if (pair?._tag !== 'LayoutEntry' || pair.representation._tag !== 'Aggregate') return
    const first = pair.representation.fields.at(0)
    if (first === undefined) return
    const malformed: Layout.Entry = {
      ...pair,
      representation: {
        ...pair.representation,
        fields: [
          { ...first, id: { ...first.id, ordinal: 1 }, offset: 1 },
          ...pair.representation.fields.slice(1),
        ],
      },
    }
    const catalog: Layout.Catalog = { ...selected.value, entries: [malformed] }
    const plan: Layout.Plan = {
      _tag: 'LayoutPlan',
      target: selected.value.target,
      entries: [malformed],
      effectEnvironments: [],
      callableEnvironments: [],
      callingShapes: [],
      valueStorage: [],
      literalVerdicts: [],
      localSharedAllocationProvenance: LocalSharedAllocationProvenance.empty(),
      executionPackages: ExecutionPackage.empty(),
      diagnostics: [],
    }

    const rules = LayoutVerify.verifyCatalog(catalog, snapshot.index).map(
      (violation) => violation.rule,
    )
    assert.include(rules, 'InvalidAggregate')
    assert.include(rules, 'InvalidCLayout')
    assert.deepEqual(
      LayoutVerify.verifyAgainstCatalog(plan, selected.value).map((violation) => violation.rule),
      ['CatalogMismatch'],
    )
  }),
)

it.effect('plans a raw pointer as one Copy address-width lane on every target', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'layout/pointer',
      ascii(`struct Opaque {}
struct Handle { raw: *mut Opaque }
struct Qualified { raw: ?[*]const align(1) Opaque }
pub fn main() -> i32 { return 42 }`),
    )
    for (const [target, size, bits] of [
      [Target.aarch64AppleDarwin, 8, 64],
      [Target.wasm32UnknownUnknown, 4, 32],
    ] as const) {
      const catalog = yield* Layout.computeTypes(
        target,
        Analysis.declarationIndex(snapshot),
        snapshot.resolution.contexts,
      )
      const pointer = Type.pointer({
        mutable: true,
        pointee: Type.nominal('layout/pointer', 'Opaque'),
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      })
      const entry = Layout.catalogEntry(catalog, pointer)
      assert.strictEqual(entry?._tag, 'LayoutEntry')
      if (entry?._tag !== 'LayoutEntry') return
      assert.deepEqual([entry.copy, entry.size, entry.alignment], [true, size, size])
      const shape = (yield* Layout.planCallingShapes(target, [entry])).at(0)
      assert.strictEqual(shape?.tree._tag, 'AddressShape')
      assert.deepEqual(shape?.lanes, [
        {
          _tag: 'CallingLane',
          path: [{ _tag: 'ReferenceAddressSelector' }],
          type: { _tag: 'Address', element: Type.nominal('layout/pointer', 'Opaque'), bits },
        },
      ])
      const qualified = Type.pointer({
        ...pointer,
        mutable: false,
        nullable: true,
        extent: 'Many',
        alignment: 1,
      })
      const qualifiedEntry = Layout.catalogEntry(catalog, qualified)
      assert.strictEqual(qualifiedEntry?._tag, 'LayoutEntry')
      if (qualifiedEntry?._tag !== 'LayoutEntry') return
      assert.deepEqual(
        [qualifiedEntry.copy, qualifiedEntry.size, qualifiedEntry.alignment],
        [true, size, size],
      )
      assert.deepEqual(
        (yield* Layout.planCallingShapes(target, [qualifiedEntry])).at(0)?.lanes,
        shape?.lanes,
      )
      const malformed = { ...qualifiedEntry, type: Type.pointer({ ...qualified, alignment: 3 }) }
      assert.include(
        LayoutVerify.verifyCatalog({ ...catalog, entries: [malformed] }, snapshot.index).map(
          (violation) => violation.rule,
        ),
        'InvalidScalar',
      )
      const handle = Layout.catalogEntry(catalog, Type.nominal('layout/pointer', 'Handle'))
      assert.strictEqual(handle?._tag, 'LayoutEntry')
      if (handle?._tag !== 'LayoutEntry') return
      assert.deepEqual([handle.size, handle.alignment], [size, size])
      assert.deepEqual(LayoutVerify.verifyCatalog(catalog, snapshot.index), [])
    }
  }),
)

it.effect('matches mixed nested and array record layout with the host C compiler', () =>
  Effect.gen(function* () {
    const host = yield* NativeToolchain.hostTarget()

    const sourceId = 'layout/c-record-oracle'
    const snapshot = yield* AnalysisFixture.retainingMain(
      sourceId,
      ascii(`extern "C" struct Inner {
  count: i32
  ratio: f64
}
extern "C" struct Mixed {
  marker: i8
  wide: i64
  opaque: *mut u8
  values: [u16; 3]
  inner: Inner
}
pub fn main() -> i32 { return 0 }`),
      host.id,
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const selectedCatalog = Analysis.layoutCatalogOf(snapshot)
    assert.strictEqual(selectedCatalog._tag, 'Available')
    if (selectedCatalog._tag !== 'Available') return
    const index = Analysis.declarationIndex(snapshot)
    const mixed = Layout.catalogEntry(selectedCatalog.value, Type.nominal(sourceId, 'Mixed'))
    const inner = Layout.catalogEntry(selectedCatalog.value, Type.nominal(sourceId, 'Inner'))
    const array = Layout.catalogEntry(selectedCatalog.value, Type.fixedArray('u16', 3))
    assert.strictEqual(mixed?._tag, 'LayoutEntry')
    assert.strictEqual(inner?._tag, 'LayoutEntry')
    assert.strictEqual(array?._tag, 'LayoutEntry')
    if (
      mixed?._tag !== 'LayoutEntry' ||
      inner?._tag !== 'LayoutEntry' ||
      array?._tag !== 'LayoutEntry' ||
      mixed.representation._tag !== 'Aggregate' ||
      inner.representation._tag !== 'Aggregate' ||
      array.representation._tag !== 'Repeated'
    )
      return

    const oracle = yield* NativeToolchain.withBuildScope('c-layout-oracle', (scope) =>
      Effect.gen(function* () {
        const object = yield* NativeToolchain.compileCObject(
          cLayoutOracleToolchain,
          scope,
          host,
          'record-layout',
          `#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

struct Inner {
  int32_t count;
  double ratio;
};

struct Mixed {
  int8_t marker;
  int64_t wide;
  void *opaque;
  uint16_t values[3];
  struct Inner inner;
};

int main(void) {
  struct Mixed value;
  printf("%zu %zu "
         "%zu %zu %zu %zu %zu %zu %zu %zu %zu %zu "
         "%zu %zu %zu %zu %zu %zu "
         "%zu %zu\\n",
         sizeof(struct Mixed), _Alignof(struct Mixed),
         offsetof(struct Mixed, marker), sizeof(value.marker),
         offsetof(struct Mixed, wide), sizeof(value.wide),
         offsetof(struct Mixed, opaque), sizeof(value.opaque),
         offsetof(struct Mixed, values), sizeof(value.values),
         offsetof(struct Mixed, inner), sizeof(value.inner),
         sizeof(struct Inner), _Alignof(struct Inner),
         offsetof(struct Inner, count), sizeof(value.inner.count),
         offsetof(struct Inner, ratio), sizeof(value.inner.ratio),
         _Alignof(uint16_t[3]), sizeof(value.values[0]));
  return 0;
}
`,
        )
        const destination = join(scope.root, 'record-layout-oracle')
        const plan = yield* NativeToolchain.planNativeLink(
          cLayoutOracleToolchain,
          scope,
          'NativeExecutable',
          yield* CompilationProfile.normalize({ target: host.id }),
          [object.artifact],
          [],
          destination,
          {
            request: { kind: 'default' },
            composition: { kind: 'default' },
            resolved: { kind: 'default' },
          },
        )
        const executable = (yield* Linker.link({
          scope,
          plan,
          artifactKind: 'NativeExecutable',
          destination,
          cache: Object.freeze({ _tag: 'Disabled' }),
        })).artifact
        const ran = yield* Effect.try({
          try: () => spawnSync(executable.path, [], { encoding: 'utf8' }),
          catch: (cause) =>
            new CLayoutOracleError({ message: 'C layout oracle could not execute', cause }),
        })
        if (ran.error !== undefined || ran.status !== 0) {
          return yield* new CLayoutOracleError({
            message: `C layout oracle failed: ${ran.stderr}${ran.error?.message ?? ''}`,
            ...(ran.error === undefined ? {} : { cause: ran.error }),
          })
        }
        const values = ran.stdout.trim().split(/\s+/u).map(Number)
        assert.strictEqual(values.length, 20)
        return values
      }),
    )

    assert.deepEqual(
      [
        mixed.size,
        mixed.alignment,
        ...mixed.representation.fields.flatMap((field) => [field.offset, field.size]),
        inner.size,
        inner.alignment,
        ...inner.representation.fields.flatMap((field) => [field.offset, field.size]),
        array.alignment,
        array.representation.stride,
      ],
      oracle,
    )

    const expectedPadding = (
      recordSize: number,
      offsetSizePairs: ReadonlyArray<number>,
    ): { readonly fields: ReadonlyArray<number>; readonly tail: number } => {
      let cursor = 0
      const fields: Array<number> = []
      for (let pair = 0; pair < offsetSizePairs.length; pair += 2) {
        const offset = offsetSizePairs.at(pair)
        const size = offsetSizePairs.at(pair + 1)
        if (offset === undefined || size === undefined) continue
        fields.push(offset - cursor)
        cursor = offset + size
      }
      return { fields, tail: recordSize - cursor }
    }
    const cMixedPadding = expectedPadding(oracle.at(0) ?? 0, oracle.slice(2, 12))
    const cInnerPadding = expectedPadding(oracle.at(12) ?? 0, oracle.slice(14, 18))
    assert.deepEqual(
      mixed.representation.fields.map((field) => field.padding),
      cMixedPadding.fields,
    )
    assert.strictEqual(mixed.representation.tailPadding, cMixedPadding.tail)
    assert.deepEqual(
      inner.representation.fields.map((field) => field.padding),
      cInnerPadding.fields,
    )
    assert.strictEqual(inner.representation.tailPadding, cInnerPadding.tail)
    assert.deepEqual(LayoutVerify.verifyCatalog(selectedCatalog.value, index), [])
  }),
)
