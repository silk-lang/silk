import * as AnalysisFixture from './support/AnalysisFixture.js'
import { unreachable } from './support/raise.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Tir from '../src/Tir.js'
import type * as Mir from '../src/Mir.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Residualization from '../src/Residualization.js'
import * as Type from '../src/Type.js'
import type * as StaticValue from '../src/StaticValue.js'
import { referenceProjectionAcceptance } from './support/corpus.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

it.effect('retains failed referent facts and rejects affine borrowed reads', () =>
  Effect.gen(function* () {
    const invalid = yield* AnalysisFixture.declarations(
      'reference-projection/non-reference-referent',
      ascii('fn invalid(value: i32) -> i32 { return value.* }'),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(
      Analysis.diagnostics(invalid).map((diagnostic) => diagnostic.code),
      ['SEM0171'],
    )
    const invalidFunction = Analysis.rootAnalysis(invalid).tir.functions.at(0)
    assert.strictEqual(
      invalidFunction === undefined ? undefined : Tir.returned(invalidFunction)._tag,
      'Unavailable',
    )

    const affine = yield* AnalysisFixture.declarations(
      'reference-projection/affine-referent',
      ascii(`struct Token { value: i32 }
fn invalid(value: &Token) -> Token { return value.* }`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(
      Analysis.diagnostics(affine).map((diagnostic) => diagnostic.code),
      ['OWN0012'],
    )
  }),
)

it.effect('rejects strengthening a shared value-reference reborrow', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'reference-projection/value-reborrow-strengthening',
      ascii(`struct Box { value: i32 }
fn mutate(box: &mut Box) -> () { box.value = 1 }
fn invalid(box: &Box) -> () { mutate(&mut box) }`),
      'wasm32-unknown-unknown',
    )

    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0058'],
    )
  }),
)

it.effect('retains zero-lane reads and nested reborrows while restoring the parent', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'reference-projection/surviving-runtime-structure',
      ascii(referenceProjectionAcceptance),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const encoded = Tir.encode(Analysis.rootAnalysis(snapshot).tir)
    assert.include(encoded, 'reborrow-value')
    assert.include(encoded, 'readEmpty')
    assert.deepEqual(Tir.verify(Analysis.rootAnalysis(snapshot).tir), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
  }),
)

it.effect('consumes a static field descriptor into an ordinary shared residual borrow', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'reference-projection/static-descriptor',
      ascii(`struct Box { value: i32 }

fn borrowValue(
  owner: &Box,
  static field: Intrinsic.Field<Box, i32>,
) -> &i32 {
  return Intrinsic.borrowField<Box, i32>(owner, field)
}

pub fn main() -> i32 { return 0 }`),
      'wasm32-unknown-unknown',
    )

    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const module = snapshot.index.modules.find(
      (candidate) => candidate.module === 'reference-projection/static-descriptor',
    )
    const aggregate = module?.structs.find(
      (declaration) => declaration.name._tag === 'Present' && declaration.name.spelling === 'Box',
    )
    const function_ = module?.declarations.find(
      (declaration) =>
        declaration.name._tag === 'Present' && declaration.name.spelling === 'borrowValue',
    )
    assert.strictEqual(aggregate?._tag, 'StructDeclaration')
    assert.strictEqual(function_?._tag, 'FunctionDeclaration')
    if (
      aggregate?._tag !== 'StructDeclaration' ||
      aggregate.canonical._tag !== 'Canonical' ||
      function_?._tag !== 'FunctionDeclaration' ||
      function_.canonical._tag !== 'Canonical' ||
      snapshot.target._tag !== 'Resolved'
    )
      return
    const field = aggregate.fields.at(0)
    assert.isDefined(field)
    if (field === undefined || field.declaredType._tag !== 'Resolved') return
    const descriptor: StaticValue.FieldDescriptorValue = Object.freeze({
      _tag: 'FieldDescriptorValue',
      owner: Object.freeze({
        _tag: 'TypeDescriptorValue',
        owner: Object.freeze({
          _tag: 'NominalType',
          module: aggregate.canonical.id.module,
          name: aggregate.canonical.id.name,
          arguments: Object.freeze([]),
        }),
        kind: aggregate.aggregateKind,
      }),
      declarationOrdinal: field.id.ordinal,
      member: Object.freeze({ _tag: 'LabeledField', label: 'value' }),
      valueType: field.declaredType.type,
      authorization: function_.canonical.id,
      provenance: Object.freeze({
        anchor: field.anchor,
      }),
    })
    const residual = Residualization.residualize(
      Residualization.make(
        snapshot.profile ?? unreachable('expected completed profile'),
        snapshot.results,
        snapshot.resolution,
        snapshot.index,
      ),
      Object.freeze({
        declaration: function_.canonical.id,
        typeArguments: function_.typeParameters.map((parameter) =>
          Type.parameterArgument(parameter.type),
        ),
        evidence: Object.freeze([]),
        contractRow: Object.freeze([]),
        staticArguments: Object.freeze([descriptor]),
      }),
    )
    assert.strictEqual(residual._tag, 'ResidualBody')
    if (residual._tag !== 'ResidualBody') return
    assert.deepEqual(residual.diagnostics, [])
    assert.strictEqual(
      residual.function.contract._tag === 'Contract'
        ? residual.function.contract.parameters.length
        : 0,
      1,
    )
    const expressions = residual.function.statements.flatMap(Tir.statementExpressions)
    const tree = expressions.flatMap(Tir.expressionTree)
    const projection = tree.find(
      (expression): expression is Extract<Tir.Expression, { readonly _tag: 'ValueBorrow' }> =>
        expression._tag === 'ValueBorrow',
    )
    assert.isDefined(
      projection,
      Tir.encode(
        Object.freeze({
          _tag: 'TirModule',
          module: 'debug',
          functions: Object.freeze([residual.function]),
        }),
      ),
    )
    assert.strictEqual(projection?.access, 'Shared')
    assert.strictEqual(projection?.selectors.length, 1)
    assert.strictEqual(projection?.selectors.at(0)?._tag, 'Field')
    const encoded = Tir.encode(
      Object.freeze({
        _tag: 'TirModule',
        module: 'reference-projection/static-descriptor',
        functions: Object.freeze([residual.function]),
      }),
    )
    assert.isFalse(encoded.includes('Intrinsic.borrowField'))
    assert.isFalse(encoded.includes('Intrinsic.Field'))
    assert.deepEqual(
      Tir.verify(
        Object.freeze({
          _tag: 'TirModule',
          module: 'reference-projection/static-descriptor',
          functions: Object.freeze([residual.function]),
        }),
      ),
      [],
    )

    const unauthorized = Residualization.residualize(
      Residualization.make(
        snapshot.profile ?? unreachable('expected completed profile'),
        snapshot.results,
        snapshot.resolution,
        snapshot.index,
      ),
      Object.freeze({
        declaration: function_.canonical.id,
        typeArguments: function_.typeParameters.map((parameter) =>
          Type.parameterArgument(parameter.type),
        ),
        evidence: Object.freeze([]),
        contractRow: Object.freeze([]),
        staticArguments: Object.freeze([
          Object.freeze({
            ...descriptor,
            authorization: Object.freeze({
              _tag: 'CanonicalDeclarationId' as const,
              module: 'reference-projection/unauthorized',
              name: 'forged',
            }),
          }),
        ]),
      }),
    )
    assert.strictEqual(unauthorized._tag, 'ResidualBody')
    if (unauthorized._tag === 'ResidualBody') {
      assert.include(
        unauthorized.diagnostics.map((diagnostic) => diagnostic.code),
        'SEM0028',
      )
    }
  }),
)

it.effect('rejects invalid mixed field-projection calling shapes before residual TIR', () =>
  Effect.gen(function* () {
    const wrongOwner = yield* Analysis.ofSource(
      'reference-projection/static-descriptor-owner',
      ascii(`struct Left { value: i32 }
struct Right { value: i32 }
fn invalid(
  owner: &Right,
  static field: Intrinsic.Field<Left, i32>,
) -> &i32 {
  return Intrinsic.borrowField<Left, i32>(owner, field)
}`),
    )
    assert.include(
      Analysis.diagnostics(wrongOwner).map((diagnostic) => diagnostic.code),
      'SEM0100',
    )

    const runtimeDescriptor = yield* Analysis.ofSource(
      'reference-projection/runtime-descriptor',
      ascii(`struct Box { value: i32 }
fn invalid(owner: &Box, field: Intrinsic.Field<Box, i32>) -> &i32 {
  return Intrinsic.borrowField<Box, i32>(owner, field)
}`),
    )
    assert.include(
      Analysis.diagnostics(runtimeDescriptor).map((diagnostic) => diagnostic.code),
      'SEM0176',
    )

    const owned = yield* Analysis.ofSource(
      'reference-projection/owned-descriptor-projection',
      ascii(`struct Box { value: i32 }
fn invalid(owner: Box, static field: Intrinsic.Field<Box, i32>) -> &i32 {
  return Intrinsic.borrowField<Box, i32>(owner, field)
}`),
    )
    assert.include(
      Analysis.diagnostics(owned).map((diagnostic) => diagnostic.code),
      'SEM0012',
    )

    const exclusive = yield* Analysis.ofSource(
      'reference-projection/exclusive-descriptor-projection',
      ascii(`struct Box { value: i32 }
fn invalid(owner: &mut Box, static field: Intrinsic.Field<Box, i32>) -> &i32 {
  return Intrinsic.borrowField<Box, i32>(owner, field)
}`),
    )
    assert.include(
      Analysis.diagnostics(exclusive).map((diagnostic) => diagnostic.code),
      'SEM0012',
    )

    const escapingSource = `struct Box { value: i32 }
fn invalid(
  source: &Box,
  static field: Intrinsic.Field<Box, i32>,
) -> &i32 {
  let local = Box { value: 0 }
  return Intrinsic.borrowField<Box, i32>(&local, field)
}`
    const escaping = yield* Analysis.ofSource(
      'reference-projection/escaping-descriptor-projection',
      ascii(escapingSource),
    )
    assert.deepEqual(
      Analysis.diagnostics(escaping).map((diagnostic) => ({
        code: diagnostic.code,
        span: escapingSource.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'OWN0019', span: 'Intrinsic.borrowField<Box, i32>(&local, field)' },
        { code: 'SEM0212', span: '&local' },
      ],
    )
  }),
)

it.effect('rejects forged consuming reads and writes through shared references', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'reference-projection/forged-shared-mir',
      ascii(`fn read(value: &i32) -> i32 { return value.* }
pub fn main() -> i32 {
  let value = 42
  return read(&value)
}`),
      'wasm32-unknown-unknown',
    )
    const mir = Analysis.loweredMir(snapshot)
    const functionIndex = mir.functions.findIndex((fn) => fn.id.name === 'read')
    const fn = mir.functions.at(functionIndex)
    if (fn === undefined) throw new RangeError('expected read MIR function')
    const read = MirVerification.operations(fn).find((operation) => operation._tag === 'ReadPlace')
    if (read === undefined) throw new RangeError('expected shared referent read')
    const rootType = fn.localTypes.at(read.root.ordinal)
    if (rootType === undefined) throw new RangeError('expected shared reference root type')

    const consuming: Mir.MirFunction = Object.freeze({
      ...fn,
      regions: Object.freeze(
        fn.regions.map((region) =>
          region._tag === 'OperationRegion'
            ? Object.freeze({
                ...region,
                operations: Object.freeze(
                  region.operations.map((operation): Mir.Operation =>
                    operation === read ? Object.freeze({ ...read, consume: true }) : operation,
                  ),
                ),
              })
            : region,
        ),
      ),
    })
    const consumingModule: Mir.Module = Object.freeze({
      ...mir,
      functions: Object.freeze([
        ...mir.functions.slice(0, functionIndex),
        consuming,
        ...mir.functions.slice(functionIndex + 1),
      ]),
    })
    assert.include(
      (yield* MirVerification.verify(consumingModule)).map((violation) => violation.rule),
      'InvalidAggregateOperation',
    )

    const sharedWrite: Mir.MirFunction = Object.freeze({
      ...fn,
      regions: Object.freeze(
        fn.regions.map((region) =>
          region._tag === 'OperationRegion'
            ? Object.freeze({
                ...region,
                operations: Object.freeze(
                  region.operations.flatMap((operation): ReadonlyArray<Mir.Operation> =>
                    operation === read
                      ? [
                          read,
                          Object.freeze({
                            _tag: 'CheckPlace',
                            root: read.root,
                            selectors: read.selectors,
                            type: read.type,
                            provenance: read.provenance,
                          }),
                          Object.freeze({
                            _tag: 'WritePlace',
                            root: read.root,
                            selectors: read.selectors,
                            source: read.destination,
                            rootType,
                            type: read.type,
                            mutable: true,
                            replacement: 'Copy',
                            commit: 'AfterCleanup',
                            provenance: read.provenance,
                          }),
                        ]
                      : [operation],
                  ),
                ),
              })
            : region,
        ),
      ),
    })
    const sharedWriteModule: Mir.Module = Object.freeze({
      ...mir,
      functions: Object.freeze([
        ...mir.functions.slice(0, functionIndex),
        sharedWrite,
        ...mir.functions.slice(functionIndex + 1),
      ]),
    })
    assert.include(
      (yield* MirVerification.verify(sharedWriteModule)).map((violation) => violation.rule),
      'InvalidWrite',
    )
  }),
)

it.effect('keeps reference projection inside the borrow contract', () =>
  Effect.gen(function* () {
    // Writing through a shared reference is not a writable place.
    const shared = yield* AnalysisFixture.retainingMain(
      'reference-projection/shared-write',
      ascii(`struct Counter { value: i32 }
fn bump(self: &Counter) -> i32 {
  self.value = 1
  return self.value
}`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(
      Analysis.diagnostics(shared).map((diagnostic) => diagnostic.code),
      ['SEM0036'],
    )

    // Consuming a field through a reference stays a partial move.
    const stolen = yield* AnalysisFixture.retainingMain(
      'reference-projection/steal',
      ascii(`struct Token { value: i32 }
struct Holder { token: Token }
fn steal(self: &mut Holder) -> Token {
  return move self.token
}`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(
      Analysis.diagnostics(stolen).map((diagnostic) => diagnostic.code),
      ['OWN0002'],
    )
  }),
)

it.effect('retains reference field loans and lifetime-erased array elements', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'reference-projection/stored-reference-place',
      ascii(`import silk.ownership {Copy}
struct Box { value: i32 }
struct View<'a> { box: &'a mut Box }
struct ArrayBox { values: [i32; 1] }
struct ArrayView<'a> { box: &'a ArrayBox }
fn next(count: &mut i32) -> usize { count.* = count.* + 1 return 0 }
fn read(value: &i32) -> i32 { return value.* }
fn ordered(views: &[ArrayView], index: usize, count: &mut i32) -> i32 {
  return views[index].box.values[next(&mut count)]
}
fn orderedBorrow(views: &[ArrayView], index: usize, count: &mut i32) -> i32 {
  return read(&views[index].box.values[next(&mut count)])
}
fn exerciseArray(box: &ArrayBox) -> i32 {
  let views = [ArrayView { box: box }]
  let mut count = 0
  let first = ordered(&views, 0, &mut count)
  return first + orderedBorrow(&views, 0, &mut count) + count
}
struct Text<'a> { name: string<'a> }
impl<'a> Copy for Text<'a> {}
union Outcome<'a> { Present { value: Text<'a> } }
fn makeText<'a>(name: string<'a>) -> Outcome<'a> {
  return Outcome<'a>.Present { value: Text<'a> { name: name } }
}
fn entries(name: string) -> i32 {
  let local = makeText(name)
  drop local
  let constant = match move makeText("static") { Outcome.Present { value: item } => item }
  let values: [Text<'static>; 1] = [constant]
  drop values
  return 42
}
fn increment(value: &mut i32) -> () { value.* = value.* + 1 }
fn inspect(view: &mut View) -> i32 {
  increment(&mut view.box.value)
  return view.box.value
}
fn use(box: &mut Box) -> i32 {
  let mut view = View { box: move box }
  return inspect(&mut view)
}
pub fn main() -> i32 {
  let mut box = Box { value: 41 }
  let arrayBox = ArrayBox { values: [0] }
  return use(&mut box) + entries("local") + exerciseArray(&arrayBox) - 44
}`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.isTrue(mir.functions.some((fn) => fn.id.name === 'inspect'))
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    for (const name of ['ordered', 'orderedBorrow']) {
      const ordered =
        mir.functions.find((fn) => fn.id.name === name) ??
        unreachable('expected ordered projection')
      const operations = MirVerification.operations(ordered)
      const checkedDescriptor = operations.findIndex(
        (operation) =>
          operation._tag === 'ReadPlace' &&
          operation.type._tag === 'Reference' &&
          operation.selectors.some((selector) => selector._tag === 'SliceElementSelector'),
      )
      const laterIndex = operations.findIndex(
        (operation) => operation._tag === 'Call' && operation.target.name === 'next',
      )
      assert.isAtLeast(checkedDescriptor, 0)
      assert.isAbove(laterIndex, checkedDescriptor)
    }

    const entries =
      mir.functions.find((fn) => fn.id.name === 'entries') ?? unreachable('expected entries')
    const array =
      MirVerification.operations(entries).find(
        (operation) => operation._tag === 'ConstructArray',
      ) ?? unreachable('expected array')
    if (array._tag !== 'ConstructArray') return unreachable('expected array construction')
    const integerOrdinal = entries.localTypes.findIndex((type) => type._tag === 'i32')
    assert.isAtLeast(integerOrdinal, 0)
    const incompatible: Mir.LocalId = { _tag: 'Local', ordinal: integerOrdinal }
    const region =
      entries.regions.find(
        (region) => region._tag === 'OperationRegion' && region.operations.includes(array),
      ) ?? unreachable('expected array region')
    const invalid = {
      ...mir,
      functions: mir.functions.map((fn) =>
        fn !== entries
          ? fn
          : {
              ...fn,
              regions: fn.regions.map((candidate) =>
                candidate !== region || candidate._tag !== 'OperationRegion'
                  ? candidate
                  : {
                      ...candidate,
                      operations: candidate.operations.map((operation) =>
                        operation !== array ? operation : { ...array, elements: [incompatible] },
                      ),
                    },
              ),
            },
      ),
    }
    assert.isTrue(
      (yield* MirVerification.verify(invalid)).some(
        (violation) =>
          violation.rule === 'InvalidAggregateOperation' &&
          violation.function === entries.id &&
          violation.region === region.id,
      ),
    )
  }),
)
