import { records } from './support/records.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import {
  borrowedBox,
  borrowedStream,
  borrowedFailure,
  affineBorrowedStream,
} from './support/borrowedOutcomes.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as ConformanceProof from '../src/ConformanceProof.js'
import * as ExecutableProperty from '../src/ExecutableProperty.js'
import * as Lifetime from '../src/Lifetime.js'
import * as Instances from '../src/Instances.js'
import * as MirVerification from '../src/MirVerification.js'
import * as ModuleSurface from '../src/ModuleSurface.js'
import * as SemanticContext from '../src/SemanticContext.js'
import * as NominalVariance from '../src/NominalVariance.js'
import * as OwnershipEncoding from '../src/OwnershipEncoding.js'
import * as Type from '../src/Type.js'
import * as TypeCompatibility from '../src/TypeCompatibility.js'
import * as SourceCallView from '../src/SourceCallView.js'
import * as Tir from '../src/Tir.js'
import { unreachable } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const snapshot = (source: string) =>
  AnalysisFixture.retainingMain('slices/Ownership', ascii(source))
const analyze = (source: string) => Analysis.ofSource('slices/Ownership', ascii(source))

it.effect('constructs ordinary boxes with externally borrowed elements', () =>
  Effect.gen(function* () {
    const source = borrowedBox
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
    const invalid = yield* analyze(
      source.replace('  let result = Box.into', '  drop value\n  let result = Box.into'),
    )
    assert.include(
      Analysis.diagnostics(invalid).map((diagnostic) => diagnostic.code),
      'OWN0019',
    )
  }),
)

it.effect('implements fixed externally borrowed stream items with fresh operation receivers', () =>
  Effect.gen(function* () {
    const source = borrowedStream
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
    const invalid = yield* analyze(source.replace('  drop stream', '  drop values\n  drop stream'))
    assert.include(
      Analysis.diagnostics(invalid).map((diagnostic) => diagnostic.code),
      'OWN0019',
    )
  }),
)

it.effect('preserves provided environment loans independently of external outcome loans', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
service Source { effect fn read<'data>(value: &'data i32) -> &'data i32 ? &Source }
struct Fixed { count: i32 }
impl Source for Fixed {
  effect fn read<'data>(self: &Fixed, value: &'data i32) -> &'data i32 { return value }
}
effect fn read<'data>(proof: &'data i32) -> &'data i32 ? &Source { return run Source.read(proof) }
pub fn main() -> i32 {
  let value = 42
  let provider = Fixed { count: 0 }
  let pending = Effect.provide(read(&value), &provider)
  let result = run pending
  drop pending
  drop provider
  return result.*
}`
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
    const discovery = Analysis.instancesOf(self)
    const caller = discovery.instances.find((instance) => instance.key.declaration.name === 'read')
    if (caller === undefined) return unreachable('missing provided service caller')
    const subject = caller.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
      .find(
        (node): node is Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }> =>
          node._tag === 'ServiceEffectConstruct',
      )
    if (subject === undefined) return unreachable('missing held service invocation')
    const call = discovery.calls.find(
      (candidate) =>
        Instances.keyText(candidate.owner) === Instances.keyText(caller.key) &&
        candidate.node?.ordinal === subject.id?.ordinal,
    )
    if (call === undefined) return unreachable('missing source-owned service call')
    const implementation = discovery.instances.find(
      (instance) => Instances.keyText(instance.key) === Instances.keyText(call.target),
    )
    const receiver = implementation?.specialization.parameters.at(0)
    const physical = implementation?.specialization.result
    if (
      implementation === undefined ||
      receiver === undefined ||
      !Type.isReference(receiver) ||
      !Type.isNominal(receiver.target) ||
      physical === undefined ||
      !Type.isEffect(physical)
    )
      return unreachable('missing original implementation contract')
    const service = Type.substitute(subject.service, caller.substitution)
    if (!Type.isNominal(service)) return unreachable('missing original service capability')
    const witness = ConformanceProof.witness(
      Analysis.declarationIndex(self),
      receiver.target,
      service,
    )
    if (witness?._tag !== 'SourceConformanceWitness') return unreachable('missing source witness')
    const provider = {
      capability: service,
      providerType: receiver.target,
      witness,
      role: subject.role,
      access: subject.access,
      requirementAccess: subject.access,
    }
    const held = {
      owner: caller,
      index: Analysis.declarationIndex(self),
      instances: discovery.instances,
      calls: discovery.calls,
      layout: Analysis.loweredMir(self).layout,
      semantic: (type: Type.Type) => Type.substitute(type, caller.substitution),
    }
    assert.isDefined(SourceCallView.service(held, subject, call, provider, physical))
    const alteredCall = (changed: Instances.CallInstance) => ({
      ...held,
      calls: discovery.calls.map((candidate) => (candidate === call ? changed : candidate)),
    })
    const wrongNode = { ...call, node: { _tag: 'TirNode' as const, ordinal: -1 } }
    assert.isUndefined(
      SourceCallView.service(alteredCall(wrongNode), subject, wrongNode, provider, physical),
    )
    const wrongTarget = { ...call, target: caller.key }
    assert.isUndefined(
      SourceCallView.service(alteredCall(wrongTarget), subject, wrongTarget, provider, physical),
    )
    const missingOriginalArgument = {
      ...call,
      target: { ...call.target, typeArguments: call.target.typeArguments.slice(1) },
    }
    assert.isUndefined(
      SourceCallView.service(
        alteredCall(missingOriginalArgument),
        subject,
        missingOriginalArgument,
        provider,
        physical,
      ),
    )
    assert.isUndefined(
      SourceCallView.service(held, { ...subject, arguments: [] }, call, provider, physical),
    )
    assert.isUndefined(
      SourceCallView.service(held, subject, call, { ...provider, role: 'foreign' }, physical),
    )
    assert.isUndefined(
      SourceCallView.service(held, subject, call, { ...provider, providerType: service }, physical),
    )
    assert.isUndefined(
      SourceCallView.service(held, subject, call, provider, { ...physical, success: 'bool' }),
    )
    assert.isUndefined(
      SourceCallView.service(held, subject, call, provider, {
        ...physical,
        failureRow: Type.effect('i32', ['bool'], physical).failureRow,
      }),
    )
    assert.isUndefined(
      SourceCallView.service(held, subject, call, provider, {
        ...physical,
        requirementRow: subject.type.requirementRow,
      }),
    )
    const copiedAccess = { ...physical, access: 'Take' as const }
    const copiedLayout = {
      ...held.layout,
      effectEnvironments: held.layout.effectEnvironments.map((environment) =>
        Instances.keyText(environment.instance) === Instances.keyText(call.target)
          ? {
              ...environment,
              effect: copiedAccess,
              ...('fields' in environment
                ? {
                    fields: environment.fields.map((field) => ({
                      ...field,
                      access: 'Take' as const,
                    })),
                  }
                : {}),
            }
          : environment,
      ),
    }
    assert.isUndefined(
      SourceCallView.service(
        { ...held, layout: copiedLayout },
        subject,
        call,
        provider,
        copiedAccess,
      ),
    )
    const foreignLayout = {
      ...held.layout,
      effectEnvironments: held.layout.effectEnvironments.map((environment) =>
        Instances.keyText(environment.instance) === Instances.keyText(call.target)
          ? {
              ...environment,
              site: Tir.effectRootSite(
                caller.view.artifact,
                caller.function.declaration.id.ordinal,
                caller.key.declaration,
              ),
            }
          : environment,
      ),
    }
    assert.isUndefined(
      SourceCallView.service({ ...held, layout: foreignLayout }, subject, call, provider, physical),
    )
    const invalid = yield* analyze(
      source
        .replace('  let result = run pending', '  drop provider\n  let result = run pending')
        .replace('  drop pending\n  drop provider', '  drop pending'),
    )
    assert.include(
      Analysis.diagnostics(invalid).map((diagnostic) => diagnostic.code),
      'OWN0019',
    )
  }),
)

it.effect('transfers affine borrowed items out of an ordinary owning stream', () =>
  Effect.gen(function* () {
    const source = affineBorrowedStream
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
    const invalid = yield* analyze(source.replace('  drop item', '  value = 1\n  drop item'))
    assert.isTrue(
      Analysis.diagnostics(invalid).some((diagnostic) =>
        ['OWN0010', 'OWN0011', 'OWN0019'].includes(diagnostic.code),
      ),
    )
  }),
)

it.effect('copies fixed stream items while retaining their nested external borrow', () =>
  Effect.gen(function* () {
    const source = `interface Stream<Item> { effect fn take<'call>(self: &'call mut Self) -> Item }
struct View<'data> { value: &'data i32 }
impl<'data> Copy for View<'data> {}
struct Repeated<'data> { item: View<'data> }
impl<'data> Stream<View<'data>> for Repeated<'data> {
  effect fn take<'call>(self: &'call mut Repeated<'data>) -> View<'data> { return self.item }
}
pub fn main() -> i32 {
  let value = 21
  let mut stream = Repeated { item: View { value: &value } }
  let first = run Stream.take(&mut stream)
  let copied = first
  let second = run Stream.take(&mut stream)
  drop stream
  drop first
  return copied.value.* + second.value.*
}`
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
    const invalid = yield* analyze(source.replace('  drop first', '  drop value\n  drop first'))
    assert.include(
      Analysis.diagnostics(invalid).map((d) => d.code),
      'OWN0019',
    )
  }),
)

it.effect('rejects fixed-item lending from receiver-owned scratch', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`import silk.option { Option }
interface Stream<Item> { effect fn take<'call>(self: &'call mut Self) -> Option<Item> }
struct Scratch { value: i32 }
impl<'data> Stream<&'data i32> for Scratch {
  effect fn take<'call>(self: &'call mut Scratch) -> Option<&'data i32> {
    return Option.some(&self.value)
  }
}
pub fn main() -> i32 { return 0 }`)
    assert.include(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      'SEM0212',
    )
  }),
)

it.effect('retains reusable exclusive captures between borrowed-outcome runs', () =>
  Effect.gen(function* () {
    const source = `struct Holder<'data> { value: &'data i32 count: i32 }
effect fn take<'call, 'data>(self: &'call mut Holder<'data>) -> &'data i32 {
  self.count = self.count + 1 return self.value
}
pub fn main() -> i32 {
  let value = 42
  let mut holder = Holder { value: &value, count: 0 }
  let mut pending = take(&mut holder)
  let first = run pending
  let second = run pending
  drop pending
  holder.count = 3
  return first.* + second.*
}`
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
    const invalid = yield* analyze(
      source.replace('  let second =', '  holder.count = 4\n  let second ='),
    )
    assert.isTrue(
      Analysis.diagnostics(invalid).some((diagnostic) =>
        ['OWN0010', 'OWN0011', 'OWN0019'].includes(diagnostic.code),
      ),
    )
  }),
)

it.effect('preserves external Effect success dependencies after temporary receiver release', () =>
  Effect.gen(function* () {
    const source = `struct Holder<'data> { value: &'data i32 index: i32 }
effect fn take<'call, 'data>(self: &'call mut Holder<'data>) -> &'data i32 {
  self.index = self.index + 1
  return self.value
}
pub fn main() -> i32 {
  let value = 21
  let mut holder = Holder { value: &value, index: 0 }
  let first = run take(&mut holder)
  let second = run take(&mut holder)
  drop holder
  return first.* + second.*
}`
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
    const invalid = yield* analyze(source.replace('  drop holder', '  drop value\n  drop holder'))
    assert.include(
      Analysis.diagnostics(invalid).map((diagnostic) => diagnostic.code),
      'OWN0019',
    )
  }),
)

it.effect('rejects Effect outcomes borrowing destroyed local or captured owner storage', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`struct Owner { value: i32 }
effect fn local<'a>() -> &'a i32 { let value = 1 return &value }
effect fn captured<'a>(owner: Owner) -> &'a i32 { return &owner.value }
effect fn failure<'a>() -> i32 ! &'a i32 { let value = 1 fail &value }
pub fn main() -> i32 { return 0 }`)
    const diagnostics = Analysis.diagnostics(self)
    const spans = SemanticContext.fromModules(self.closure.modules)
    for (const name of ['local', 'captured', 'failure']) {
      const fn =
        Analysis.ownershipOf(self, 'slices/Ownership')?.functions.find(
          (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === name,
        ) ?? unreachable(name)
      const declared = spans.spanOf(fn.declaration.anchor)
      assert.isTrue(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'OWN0019' &&
            diagnostic.span.start >= declared.start &&
            diagnostic.span.end <= declared.end,
        ),
        name,
      )
    }
  }),
)

it.effect('propagates nested borrowed failures through ordinary recovery', () =>
  Effect.gen(function* () {
    const source = borrowedFailure
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
    const invalid = yield* analyze(
      source.replace('  return result.*', '  drop value\n  return result.*'),
    )
    assert.include(
      Analysis.diagnostics(invalid).map((diagnostic) => diagnostic.code),
      'OWN0019',
    )
  }),
)

it.effect('retains dependent remainder cleanup after a non-suspending incoming failure', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
struct Problem {}
struct Guard<'a> { value: &'a mut i32 code: i32 }
impl<'a> Drop for Guard<'a> { fn drop(self: &mut Guard<'a>) -> () { self.value.* = self.value.* + 1 return () } }
struct Pair<'a> { left: Guard<'a> right: Guard<'a> }
effect fn incoming<'a>(value: Guard<'a>) -> i32 ! Problem { drop value fail Problem {} }
effect fn replace<'a>(a: &'a mut i32, b: &'a mut i32, c: &'a mut i32) -> i32 ! Problem {
  let mut pair = Pair { left: Guard { value: move a, code: 1 }, right: Guard { value: move b, code: 2 } }
  pair.left = Guard { value: move c, code: run incoming(move pair.right) }
  return 0
}
effect fn recover(error: Problem) -> i32 { return 42 }
pub fn main() -> i32 {
  let mut a = 0 let mut b = 0 let mut c = 0
  let mut parent = &mut a let nested = &mut parent
  nested.*.* = 0 drop nested drop parent
  return run Effect.catchAll(replace(&mut a, &mut b, &mut c), recover)
}`
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const ownership = Analysis.ownershipOf(self, 'slices/Ownership') ?? unreachable('ownership')
    const replace =
      ownership.functions.find(
        (fn) =>
          fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'replace',
      ) ?? unreachable('replace ownership')
    const remainder = replace.exits
      .flatMap((exit) => exit.releases)
      .find(
        (release) =>
          release.binding.name === 'pair' &&
          release.initialization.children.some((child) => child.state.initialization === 'Missing'),
      )
    assert.isDefined(remainder)
    const program = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const hook =
      program.functions.find((fn) =>
        MirVerification.operations(fn).some(
          (operation) =>
            operation._tag === 'ReadPlace' &&
            operation.type._tag === 'Reference' &&
            operation.selectors.some((selector) => selector._tag === 'FieldSelector'),
        ),
      ) ?? unreachable('Drop MIR')
    const descriptor = MirVerification.operations(hook).find(
      (operation) => operation._tag === 'ReadPlace' && operation.type._tag === 'Reference',
    )
    if (descriptor?._tag !== 'ReadPlace') return unreachable('stored reference descriptor')
    const corrupted = {
      ...program,
      functions: program.functions.map((fn) =>
        fn !== hook
          ? fn
          : {
              ...fn,
              regions: fn.regions.map((region) =>
                region._tag === 'OperationRegion' && region.operations.includes(descriptor)
                  ? {
                      ...region,
                      outcome: {
                        _tag: 'Return' as const,
                        value: descriptor.destination,
                        provenance: descriptor.provenance,
                      },
                    }
                  : region,
              ),
            },
      ),
    }
    assert.isTrue(
      (yield* MirVerification.verify(corrupted)).some(
        (violation) => violation.rule === 'InvalidAggregateOperation',
      ),
    )
  }),
)

it.effect(
  'keeps exclusive replacement and whole Drop-field extraction within their declared boundaries',
  () =>
    Effect.gen(function* () {
      const source = `struct Guard<'a> { value: &'a mut i32 }
impl<'a> Drop for Guard<'a> { fn drop(self: &mut Guard<'a>) -> () { return () } }
struct Outer<'a> { guard: Guard<'a> code: i32 }
fn extract<'a>(outer: Outer<'a>) -> Guard<'a> { return move outer.guard }
fn replace<T>(slot: &mut T, value: T) -> T { return Intrinsic.replace(slot.*, move value) }
fn swap<T>(left: &mut T, right: &mut T, spare: T) -> T {
  let oldLeft = Intrinsic.replace(left.*, move spare)
  let oldRight = Intrinsic.replace(right.*, move oldLeft)
  return Intrinsic.replace(left.*, move oldRight)
}
fn valid<'a>(guard: &mut Guard<'a>, other: &'a mut i32) -> Guard<'a> {
  return replace(move guard, Guard { value: move other })
}
fn invalidMove<'a>(guard: Guard<'a>) -> &'a mut i32 { return move guard.value }
fn invalidReplace<'a, 'b>(guard: &mut Guard<'a>, other: &'b mut i32) -> Guard<'a> {
  return replace(move guard, Guard { value: move other })
}`
      const self = yield* analyze(source)
      const diagnostics = Analysis.diagnostics(self)
      assert.isFalse(
        diagnostics.some((diagnostic) => diagnostic.span.start < source.indexOf('fn invalidMove')),
      )
      assert.isTrue(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'OWN0002' &&
            diagnostic.span.start >= source.indexOf('fn invalidMove') &&
            diagnostic.span.start < source.indexOf('fn invalidReplace'),
        ),
      )
      assert.isTrue(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.span.start >= source.indexOf('fn invalidReplace') &&
            ['SEM0052', 'SEM0129', 'SEM0212'].includes(diagnostic.code),
        ),
      )
    }),
)

it.effect(
  'preserves exclusive stored views through extraction and child reborrow restoration',
  () =>
    Effect.gen(function* () {
      const source = `struct View<'a> { value: &'a mut i32 }
struct Wrap<T> { value: T }
fn extract<'a>(view: View<'a>) -> &'a mut i32 { return move view.value }
fn identity<T>(value: T) -> T { return move value }
fn chain(value: &mut i32) -> i32 {
  let first = View { value: &mut value.* }
  let second = View { value: &mut first.value.* }
  let third = View { value: &mut second.value.* }
  let child = &third.value.* let copy = child drop child
  let result = copy.* drop copy drop third drop second drop first
  value.* = result return result
}
fn restored() -> i32 {
  let mut value = 1
  let mut holder = Wrap { value: View { value: &mut value } }
  let extracted = move holder.value
  holder.value = identity(move extracted)
  let parent = extract(move holder.value)
  let child = &parent.*
  let copy = child
  let observed = copy.*
  parent.* = observed + 1
  return parent.*
}`
      const self = yield* analyze(source)
      assert.deepEqual(Analysis.diagnostics(self), [])
    }),
)

it.effect('keeps dependent destructor uses live even without explicit payload reads', () =>
  Effect.gen(function* () {
    const source = `struct Guard<'a> { value: &'a i32 }
impl<'a> Drop for Guard<'a> { fn drop(self: &mut Guard<'a>) -> () { return () } }
fn valid() -> i32 { let mut source = 1 let guard = Guard { value: &source } drop guard source = 2 return source }
fn invalid() -> i32 { let mut source = 1 let guard = Guard { value: &source } source = 2 return 0 }`
    const self = yield* analyze(source)
    const diagnostics = Analysis.diagnostics(self)
    assert.isFalse(
      diagnostics.some((diagnostic) => diagnostic.span.start < source.indexOf('fn invalid')),
    )
    assert.isTrue(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'OWN0011' && diagnostic.span.start >= source.indexOf('fn invalid'),
      ),
    )
  }),
)

it.effect('rejects destructor-only exclusive aliases until dependent cleanup completes', () =>
  Effect.gen(function* () {
    const source = `struct Guard<'a> { value: &'a mut i32 }
impl<'a> Drop for Guard<'a> { fn drop(self: &mut Guard<'a>) -> () { return () } }
fn invalid() -> i32 { let mut source = 1 let guard = Guard { value: &mut source } let child = &source return child.* }`
    const self = yield* analyze(source)
    assert.isTrue(Analysis.diagnostics(self).some((diagnostic) => diagnostic.code === 'OWN0010'))
  }),
)

it.effect(
  'rejects conflicting access through stored exclusive parents and surviving child copies',
  () =>
    Effect.gen(function* () {
      const source = `struct View<'a> { value: &'a mut i32 }
fn childCopy() -> i32 {
  let mut value = 1
  let holder = View { value: &mut value }
  let child = &holder.value.*
  let copy = child
  drop child
  holder.value.* = 2
  return copy.*
}
fn duplicate() -> i32 {
  let mut value = 1
  let holder = View { value: &mut value }
  let first = move holder.value
  let second = move holder.value
  return first.* + second.*
}`
      const self = yield* analyze(source)
      const diagnostics = Analysis.diagnostics(self)
      assert.isTrue(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'OWN0011' && diagnostic.span.start < source.indexOf('fn duplicate'),
        ),
      )
      assert.isTrue(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'OWN0001' &&
            diagnostic.span.start >= source.indexOf('fn duplicate'),
        ),
      )
    }),
)

it.effect(
  'lowers writes through stored exclusive references for mutable and immutable holders',
  () =>
    Effect.gen(function* () {
      const source = `struct View<'a> { value: &'a mut i32 }
fn mutableHolder() -> i32 {
  let mut value = 1
  let mut holder = View { value: &mut value }
  holder.value.* = 2
  return value
}
fn immutableHolder() -> i32 {
  let mut value = 1
  let holder = View { value: &mut value }
  holder.value.* = 2
  return value
}
pub fn main() -> i32 { return mutableHolder() + immutableHolder() }`
      const self = yield* snapshot(source)
      assert.deepEqual(Analysis.diagnostics(self), [])
      assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
      for (const name of ['mutableHolder', 'immutableHolder']) {
        const fn =
          Analysis.loweredMir(self).functions.find((candidate) => candidate.id.name === name) ??
          unreachable(`expected ${name}`)
        assert.lengthOf(
          MirVerification.operations(fn).filter((operation) => operation._tag === 'WritePlace'),
          1,
        )
      }

      const sharedSource = `struct View<'a> { value: &'a i32 }
fn invalid() -> i32 {
  let mut value = 1
  let mut holder = View { value: &value }
  holder.value.* = 2
  return value
}`
      const shared = yield* analyze(sharedSource)
      assert.isTrue(
        Analysis.diagnostics(shared).some((diagnostic) => diagnostic.code === 'SEM0036'),
      )
    }),
)

it.effect('round-trips semantic borrowed types and executable predicates without erasure', () =>
  Effect.gen(function* () {
    const owner = { module: 'slices/roundtrip', name: 'header' }
    const a = Lifetime.bound(owner, 0, 'a')
    const b = Lifetime.bound(owner, 1, 'b')
    const call = Lifetime.bound(owner, 0, 'call', [0])
    const value = Type.parameter(owner, 2, 'T')
    const callable = Type.callable([Type.reference('Shared', value, call)], Type.string(b), {
      environment: a,
      lifetimeBinders: [call],
      lifetimeBounds: [{ longer: a, shorter: b }],
      typeOutlives: [{ type: value, lifetime: a }],
    })
    const effect = Type.effect(
      Type.nominal(owner.module, 'Holder', [
        a,
        Type.fixedArray(Type.reference('Shared', Type.string(b), a), 2),
      ]),
      [],
      {
        environment: a,
        lifetimeBinders: [],
        typeOutlives: [{ type: value, lifetime: a }],
      },
    )
    const represented = Type.represented(
      effect,
      effect,
      Type.exactRepresentationArgument(
        Type.effectIdentityArgument('roundtrip', {
          declaration: owner,
          typeArguments: [a, value],
          staticArgumentKeys: [],
        }),
        effect,
      ),
    )
    for (const source of [callable, represented]) {
      const restored = yield* ModuleSurface.decodeSemanticType(
        ModuleSurface.encodeSemanticType(source),
      )
      assert.strictEqual(Type.key(restored), Type.key(source))
      assert.deepEqual(Type.lifetimes(restored), Type.lifetimes(source))
      const substitution = new Map<string, Type.GenericArgument>([
        [Type.key(value), 'i32'],
        [Lifetime.key(b), a],
      ])
      assert.strictEqual(
        Type.key(Type.substitute(restored, substitution)),
        Type.key(Type.substitute(source, substitution)),
      )
    }
  }),
)

it.effect('derives recursive borrowed nominal variance from actual declaration cycles', () =>
  Effect.gen(function* () {
    const self = yield* Analysis.ofSource(
      'slices/recursive',
      ascii(`struct Link<'a, T> { value: &'a T }
struct A<'a> { next: Link<'a, B<'a>> }
struct B<'a> { next: &'a A<'a> }
struct Tree<'a> { children: &'a [Tree<'a>] }`),
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    for (const name of ['A', 'Tree'])
      assert.strictEqual(
        self.index.modules
          .flatMap((module) => module.structs)
          .find(
            (struct) => struct.canonical._tag === 'Canonical' && struct.canonical.id.name === name,
          )?.dependency._tag,
        'Available',
      )
    const variance = NominalVariance.derive(self.index)
    for (const name of ['A', 'B', 'Tree'])
      assert.deepEqual(
        variance.summaries.get(
          TypeCompatibility.nominalVarianceKey(Type.nominal('slices/recursive', name)),
        ),
        ['Covariant'],
      )
    assert.strictEqual(NominalVariance.derive(self.index), variance)
  }),
)

it.effect(
  'projects independent borrowed fields while rejecting unrelated and owned-inline escapes',
  () =>
    Effect.gen(function* () {
      const source = `struct Pair<'a, 'b> { first: &'a i32 second: &'b i32 }
struct Inline { values: [i32; 1] }
fn first<'a, 'b>(pair: Pair<'a, 'b>) -> &'a i32 { return pair.first }
fn second<'a, 'b>(pair: Pair<'a, 'b>) -> &'b i32 { return pair.second }
fn wrong<'a, 'b>(pair: Pair<'a, 'b>) -> &'a i32 { return pair.second }
fn inlineEscape() -> &'static [i32] { let owner = Inline { values: [1] } return &owner.values }`
      const self = yield* Analysis.ofSource('slices/projections', ascii(source))
      const diagnostics = Analysis.diagnostics(self)
      assert.isFalse(
        diagnostics.some((diagnostic) => diagnostic.span.start < source.indexOf('fn wrong')),
      )
      assert.isTrue(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'SEM0129' &&
            diagnostic.span.start >= source.indexOf('fn wrong') &&
            diagnostic.span.start < source.indexOf('fn inlineEscape'),
        ),
      )
      assert.isTrue(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'OWN0019' &&
            diagnostic.span.start >= source.indexOf('fn inlineEscape'),
        ),
      )
    }),
)

it.effect('retains borrowed generic payloads across containers and builtin string views', () =>
  Effect.gen(function* () {
    const source = `union Option<T> { Some { value: T }, None }
tuple Box<T>(T)
fn identity<T>(value: T) -> T { return move value }
fn store<'a>(value: &'a i32) -> Option<&'a i32> {
  let boxed = Box<&'a i32>(value)
  let positional = (boxed.0,)
  let record = .{ value: positional.0 }
  let values = [record.value]
  return Option<&'a i32>.Some { value: identity(values[0]) }
}
fn empty<'a>(proof: &'a i32) -> Option<&'a i32> { return Option<&'a i32>.None }
fn nested<'a, 'b>(value: &'a &'b i32) -> &'b i32 { return value.* }
fn bytes<'a>(value: string<'a>) -> &'a [u8] { return Intrinsic.stringUtf8Bytes(value) }
fn text<'a>(value: &'a [u8]) -> string<'a> { unsafe { return Intrinsic.stringFromUtf8Unchecked(value) } return "" }`
    const self = yield* Analysis.ofSource('slices/containers', ascii(source))
    assert.deepEqual(Analysis.diagnostics(self), [])
    const functions = records(Analysis.rootAnalysis(self)).functions
    for (const name of ['store', 'empty', 'bytes', 'text']) {
      const fn =
        functions.find(
          (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === name,
        ) ?? unreachable('expected container function')
      const result = fn.declaration.returnType
      if (result._tag !== 'Resolved') return unreachable('expected resolved result')
      assert.strictEqual(
        ExecutableProperty.detachedOfType(self.index, result.type)._tag,
        'Unsatisfied',
      )
      const parameter = fn.declaration.parameters.at(0)?.declaredType
      if (parameter?._tag !== 'Resolved') return unreachable('expected resolved parameter')
      assert.deepEqual(Type.storageLifetimes(result.type), Type.storageLifetimes(parameter.type))
    }
  }),
)

it.effect('requires opt-in Copy for borrowed aggregates and preserves copied dependencies', () =>
  Effect.gen(function* () {
    const source = `struct View<'a> { value: &'a i32 }
impl<'a> Copy for View<'a> {}
struct Affine<'a> { value: &'a i32 }
fn duplicate<'a>(value: &'a i32) -> i32 { let holder = View { value: value } let copy = holder return holder.value.* + copy.value.* }
fn invalidCopy() -> View<'static> { let local = 1 let holder = View { value: &local } let copy = holder return copy }
fn invalidMove<'a>(value: &'a i32) -> i32 { let holder = Affine { value: value } let moved = move holder return holder.value.* }
fn invalidExclusive(value: &mut i32) -> i32 { let moved = move value return value.* }`
    const self = yield* Analysis.ofSource('slices/copy', ascii(source))
    const diagnostics = Analysis.diagnostics(self)
    assert.isFalse(
      diagnostics.some((diagnostic) => diagnostic.span.start < source.indexOf('fn invalidCopy')),
    )
    assert.isTrue(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'OWN0019' &&
          diagnostic.span.start >= source.indexOf('fn invalidCopy') &&
          diagnostic.span.start < source.indexOf('fn invalidMove'),
      ),
    )
    assert.isTrue(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'OWN0001' &&
          diagnostic.span.start >= source.indexOf('fn invalidMove') &&
          diagnostic.span.start < source.indexOf('fn invalidExclusive'),
      ),
    )
    assert.isTrue(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'OWN0001' &&
          diagnostic.span.start >= source.indexOf('fn invalidExclusive'),
      ),
    )
    const lifetime = Lifetime.bound({ module: 'slices/copy', name: 'proof' }, 0, 'a')
    assert.isTrue(
      ConformanceProof.copyType(self.index, Type.nominal('slices/copy', 'View', [lifetime])),
    )
    assert.isFalse(
      ConformanceProof.copyType(self.index, Type.nominal('slices/copy', 'Affine', [lifetime])),
    )
    assert.isFalse(
      ConformanceProof.copyType(self.index, Type.reference('Exclusive', 'i32', lifetime)),
    )
  }),
)

it.effect('records deterministic call-scoped loans and accepts shared aliases', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`fn compare(left: &[i32], right: &[i32]) -> i32 { return 1 }
fn valid() -> i32 { let values = [1, 2, 3] return compare(&values, &values) }
pub fn main() -> i32 { return valid() }`)

    assert.deepEqual(Analysis.diagnostics(self), [])
    const ownership = Analysis.ownershipOf(self, 'slices/Ownership')?.functions.at(1)
    assert.deepEqual(
      ownership?.loans.map((loan) => ({
        ordinal: loan.id.ordinal,
        access: loan.access,
        root: loan.root._tag,
        start: loan.startRegion.ordinal,
        end: loan.endRegion.ordinal,
      })),
      [
        { ordinal: 0, access: 'Shared', root: 'Let', start: 1, end: 1 },
        { ordinal: 1, access: 'Shared', root: 'Let', start: 1, end: 1 },
      ],
    )
    assert.deepEqual(
      ownership?.exits.at(0)?.loanEnds.map((loan) => loan.ordinal),
      [0, 1],
    )
  }),
)

it.effect('rejects conflicting aliases and later owner access during a call', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`fn mixed(left: &[i32], right: &mut [i32]) -> i32 { return 1 }
fn both(left: &mut [i32], right: &mut [i32]) -> i32 { return 1 }
fn observe(view: &mut [i32], value: i32) -> i32 { return value }
fn aliases() -> i32 { let mut values = [1, 2] return mixed(&values, &mut values) }
fn exclusives() -> i32 { let mut values = [1, 2] return both(&mut values, &mut values) }
fn later() -> i32 { let mut values = [1, 2] return observe(&mut values, values[0]) }
pub fn main() -> i32 { return 0 }`)

    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      ['OWN0010', 'OWN0010', 'OWN0011'],
    )
  }),
)

it.effect('retains reborrow parent suspension and restores access after the call', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.usize
fn edit(values: &mut [i32]) -> i32 { return 1 }
fn forward(values: &mut [i32]) -> i32 {
  let result = edit(&mut values)
  return usize.toI32(values.length)
}
pub fn main() -> i32 { return 0 }`)

    assert.deepEqual(Analysis.diagnostics(self), [])
    const ownership = Analysis.ownershipOf(self, 'slices/Ownership')?.functions.at(1)
    const loan = ownership?.loans.at(0)
    assert.strictEqual(loan?.origin, 'SliceReborrow')
    assert.strictEqual(loan?.parent?._tag, 'Parameter')
    assert.strictEqual(loan?.suspendsParent, true)
    assert.strictEqual(loan?.startRegion.ordinal, loan?.endRegion.ordinal)
  }),
)

it.effect('retains a callable capture loan when the callable is stored after invocation', () =>
  Effect.gen(function* () {
    const source = `fn inspect(value: i32, values: &[i32]) -> i32 {
  return value + values[0]
}
pub fn main() -> i32 {
  let mut values = [1]
  let callback = inspect(&values)
  let observed = callback(1)
  let stored = callback
  values[0] = 40
  let later = stored(1)
  return observed + later
}`
    const self = yield* analyze(source)
    assert.deepEqual(
      Analysis.diagnostics(self).map((d) => ({
        code: d.code,
        span: source.slice(d.span.start, d.span.end).trim(),
      })),
      [
        { code: 'OWN0011', span: 'values[0]' },
        { code: 'OWN0019', span: 'stored' },
      ],
    )
  }),
)

it.effect('retains a hidden array owner through a stored borrowed holder', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`struct Guard { value: i32 }
impl Drop for Guard { fn drop(self: &mut Guard) -> () { return () } }
struct Holder { values: &[Guard] }
fn make(values: &[Guard]) -> Holder { return Holder { values: values } }
fn read(holder: &Holder) -> i32 {
  let values = holder.values
  return values[0].value
}
pub fn main() -> i32 {
  let holder = make(&[Guard { value: 42 }])
  let mut result = 0
  while result < 84 { result = result + read(&holder) }
  return result
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
    const main =
      Analysis.loweredMir(self).functions.find((fn) => fn.id.name === 'main') ??
      unreachable('expected main')
    const operations = MirVerification.operations(main)
    const array = operations.find((operation) => operation._tag === 'ConstructArray')
    assert.isDefined(array)
    if (array?._tag !== 'ConstructArray') return
    const cleanup = operations.findIndex(
      (operation) =>
        operation._tag === 'Drop' && operation.local.ordinal === array.destination.ordinal,
    )
    const calls = operations.flatMap((operation, ordinal) =>
      operation._tag === 'Call' ? [ordinal] : [],
    )
    assert.isAbove(cleanup, calls.at(-1) ?? unreachable('expected holder read'))
    assert.strictEqual(
      operations.filter(
        (operation) =>
          operation._tag === 'Drop' && operation.local.ordinal === array.destination.ordinal,
      ).length,
      1,
    )
  }),
)

it.effect('preserves temporary array inference and rejects escaping hidden storage', () =>
  Effect.gen(function* () {
    const source = `struct Holder<'a, A> { values: &'a [A] }
fn make<'a, A>(values: &'a [A]) -> Holder<'a, A> { return Holder { values: values } }
fn inferred() -> i32 { let holder = make(&[1, 2]) return holder.values[0] }
fn typed() -> u32 { let value: u32 = 1 let holder = make(&[value]) return holder.values[0] }
effect fn deferredRead(holder: Holder<i32>) -> i32 { return holder.values[0] }
fn wrong() -> u32 { let holder = make(&[1, 2]) return holder.values[0] }
fn escape<'a>() -> Holder<'a, i32> { let holder = make(&[1, 2]) return move holder }
fn escapeSlice<'a>() -> &'a [i32] { let view: &[i32] = &[1, 2] return view }
effect fn escapeEffect<'a>() -> Holder<'a, i32> { let holder = make(&[1, 2]) return move holder }
fn escapeRetainedEffect() -> once Effect<'static; i32> { let holder = make(&[1, 2]) return deferredRead(move holder) }`
    const self = yield* analyze(source)
    const diagnostics = Analysis.diagnostics(self)
    assert.isFalse(
      diagnostics.some((diagnostic) => diagnostic.span.start < source.indexOf('fn wrong')),
    )
    for (const name of ['wrong', 'escape', 'escapeSlice', 'escapeEffect', 'escapeRetainedEffect']) {
      const start = source.indexOf(`fn ${name}`)
      const end = source.indexOf('}', start)
      assert.isTrue(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.code === (name === 'wrong' ? 'SEM0129' : 'OWN0019') &&
            diagnostic.span.start >= start &&
            diagnostic.span.end <= end,
        ),
        name,
      )
    }
    assert.isTrue(diagnostics.some((diagnostic) => diagnostic.code === 'OWN0019'))
  }),
)

it.effect('cleans a hidden temporary owner after its loan ends', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`struct Guard { value: i32 }
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () { return () }
}
fn read(values: &[Guard]) -> i32 { return values[0].value }
pub fn main() -> i32 { return read(&[Guard { value: 42 }]) }`)

    assert.deepEqual(Analysis.diagnostics(self), [])
    const mir = Analysis.mirOf(self)
    assert.strictEqual(mir._tag, 'Available')
    if (mir._tag !== 'Available') return
    const main = mir.value.functions.find((fn) => fn.id.name === 'main')
    const operations =
      main?.regions.flatMap((region) => {
        if (region._tag === 'OperationRegion') return region.operations
        if (region._tag === 'CleanupRegion') return region.releases
        return []
      }) ?? []
    const ending = operations.findIndex((operation) => operation._tag === 'EndLoan')
    const cleanup = operations.findIndex(
      (operation, ordinal) => operation._tag === 'Drop' && ordinal > ending,
    )
    assert.isAtLeast(ending, 0)
    assert.isAbove(cleanup, ending)
  }),
)

it.effect('keeps a returned shared view live through its last use and then restores mutation', () =>
  Effect.gen(function* () {
    const source = `fn identity(values: &[i32]) -> &[i32] { return values }
fn conflict() -> i32 {
  let mut values = [1, 2]
  let view = identity(&values)
  values[0] = 3
  return view[0]
}
fn restored() -> i32 {
  let mut values = [1, 2]
  let view = identity(&values)
  let observed = view[0]
  values[0] = 3
  return observed
}
pub fn main() -> i32 { return restored() }`
    const self = yield* snapshot(source)
    assert.deepEqual(
      Analysis.diagnostics(self).map((d) => ({
        code: d.code,
        span: source.slice(d.span.start, d.span.end).trim(),
      })),
      [
        { code: 'OWN0011', span: 'values[0]' },
        { code: 'OWN0019', span: 'view[0]' },
      ],
    )

    const conflict = Analysis.ownershipOf(self, 'slices/Ownership')?.functions.at(1)
    const returned = conflict?.loans.find((loan) => loan.origin === 'ReturnedView')
    assert.strictEqual(returned?.root._tag, 'Let')
    assert.strictEqual(returned?.access, 'Shared')
    assert.strictEqual(
      returned === undefined ? false : returned.endSpan.end > returned.startSpan.end,
      true,
    )
    const restored = Analysis.ownershipOf(self, 'slices/Ownership')?.functions.at(2)
    assert.strictEqual(
      restored?.loans.some((loan) => loan.origin === 'ReturnedView'),
      true,
    )
  }),
)

it.effect('suspends all owner access for an exclusive returned view until its last use', () =>
  Effect.gen(function* () {
    const self =
      yield* snapshot(`fn identity(values: &mut [i32]) -> &mut [i32] { return move values }
fn conflict() -> i32 {
  let mut values = [1, 2]
  let mut view = identity(&mut values)
  let ownerRead = values[0]
  view[1] = 3
  return ownerRead
}
fn restored() -> i32 {
  let mut values = [1, 2]
  let mut view = identity(&mut values)
  view[1] = 3
  return values[1]
}
pub fn main() -> i32 { return restored() }`)

    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      ['OWN0011'],
    )
    const conflict = Analysis.ownershipOf(self, 'slices/Ownership')?.functions.at(1)
    assert.strictEqual(conflict?.loans.at(0)?.access, 'Exclusive')
    assert.strictEqual(conflict?.loans.at(0)?.origin, 'ReturnedView')
    const ownership = Analysis.ownershipOf(self, 'slices/Ownership')
    assert.include(
      ownership === undefined ? '' : OwnershipEncoding.encode(ownership),
      'returned-view',
    )
  }),
)

it.effect('retains equivalent returned-reference loans for direct and pipeline calls', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`struct Counter { value: i32 }
fn identity(counter: &mut Counter) -> &mut Counter { return move counter }
fn directConflict() -> i32 {
  let mut counter = Counter { value: 1 }
  let mut view = identity(&mut counter)
  let ownerRead = counter.value
  view.value = 2
  return ownerRead
}
fn pipelineConflict() -> i32 {
  let mut counter = Counter { value: 1 }
  let mut view = &mut counter |> identity
  let ownerRead = counter.value
  view.value = 2
  return ownerRead
}
fn directRestored() -> i32 {
  let mut counter = Counter { value: 1 }
  let mut view = identity(&mut counter)
  view.value = 2
  return counter.value
}
fn pipelineRestored() -> i32 {
  let mut counter = Counter { value: 1 }
  let mut view = &mut counter |> identity
  view.value = 2
  return counter.value
}
pub fn main() -> i32 { return directRestored() + pipelineRestored() }`)

    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      ['OWN0011', 'OWN0011'],
    )
    const ownership = Analysis.ownershipOf(self, 'slices/Ownership')
    for (const ordinal of [1, 2, 3, 4]) {
      const loan = ownership?.functions
        .at(ordinal)
        ?.loans.find((candidate) => candidate.origin === 'ReturnedView')
      assert.strictEqual(loan?.root._tag, 'Let')
      assert.strictEqual(loan?.access, 'Exclusive')
    }
  }),
)

it.effect('retains source dependencies through immutable callable aliases', () =>
  Effect.gen(function* () {
    const source = `struct Counter { value: i32 }
fn identity(counter: &mut Counter) -> &mut Counter { return move counter }
fn aliased() -> i32 {
  let mut counter = Counter { value: 1 }
  let callback = identity
  let alias = callback
  let mut view = alias(&mut counter)
  counter.value = 20
  view.value = 42
  return counter.value
}`
    const self = yield* analyze(source)
    assert.deepEqual(
      Analysis.diagnostics(self).map((d) => ({
        code: d.code,
        span: source.slice(d.span.start, d.span.end).trim(),
      })),
      [
        { code: 'OWN0011', span: 'counter.value' },
        { code: 'OWN0019', span: 'view.value' },
      ],
    )
  }),
)

it.effect('uses declared lifetimes through callable parameters, results and aliases', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`fn identity<'a>(value: &'a i32) -> &'a i32 { return value }
fn factory() -> for<'a> fn<'static>(&'a i32) -> &'a i32 { return identity }
fn apply<'env>(callback: for<'a> fn<'env>(&'a i32) -> &'a i32, value: &i32) -> i32 {
  return callback(value).*
}
fn routes(value: &i32) -> i32 {
  let direct = identity
  let alias = direct
  let returned = factory()
  let first = apply(alias, value)
  let second = (returned)(value)
  return first + second.*
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
  }),
)

it.effect('isolates and rejects deferred mutation of a captured callable', () =>
  Effect.gen(function* () {
    const source = `struct Counter { value: i32 }
fn identity(counter: &mut Counter) -> &mut Counter { return move counter }
fn alternate(counter: &mut Counter) -> &mut Counter { return move counter }
fn diverge() -> never { return diverge() }
fn simple(value: i32) -> i32 { return value }
fn alternateSimple(value: i32) -> i32 { return value + 1 }
fn make(value: i32) -> fn<'static>(i32) -> i32 { drop value return alternateSimple }
fn consume(value: i32, callback: fn(i32) -> i32) -> i32 {
  drop callback
  return value
}
fn assigned(flag: bool) -> i32 {
  let mut counter = Counter { value: 1 }
  let mut callback = identity
  let pending = effect {
    if flag {
      callback = alternate
      return ()
    } else {
      return ()
    }
  }
  drop move pending
  let view = callback(&mut counter)
  return view.value
}
fn replaced() -> i32 {
  let mut counter = Counter { value: 1 }
  let mut callback = identity
  let pending = effect {
    let previous = Intrinsic.replace(callback, alternate)
    drop previous
    return ()
  }
  drop move pending
  let view = callback(&mut counter)
  return view.value
}
fn unreachable() -> i32 {
  let mut counter = Counter { value: 1 }
  let mut callback = identity
  let pending = effect {
    let impossible = diverge()
    callback = alternate
    drop impossible
    return ()
  }
  drop move pending
  let view = callback(&mut counter)
  return view.value
}
fn neverAssignment() -> i32 {
  let mut counter = Counter { value: 1 }
  let mut callback = identity
  let pending = effect {
    callback = diverge()
    return ()
  }
  drop move pending
  let view = callback(&mut counter)
  return view.value
}
fn neverReplace() -> i32 {
  let mut counter = Counter { value: 1 }
  let mut callback = identity
  let pending = effect {
    let previous = Intrinsic.replace(callback, diverge())
    drop previous
    return ()
  }
  drop move pending
  let view = callback(&mut counter)
  return view.value
}
fn shortCircuit(flag: bool) -> i32 {
  let mut counter = Counter { value: 1 }
  let mut callback = identity
  let pending = effect {
    let skipped = flag && diverge()
    drop skipped
    callback = alternate
    return ()
  }
  drop move pending
  let view = callback(&mut counter)
  return view.value
}
fn eagerAssignment() -> i32 {
  let mut callback = simple
  let pending = effect {
    callback = make(diverge())
    return ()
  }
  drop move pending
  return callback(1)
}
fn eagerReplace() -> i32 {
  let mut callback = simple
  let pending = effect {
    let ignored = consume(diverge(), Intrinsic.replace(callback, alternateSimple))
    drop ignored
    return ()
  }
  drop move pending
  return callback(1)
}
pub fn main() -> i32 { return 0 }`
    const self = yield* analyze(source)
    assert.deepEqual(
      Analysis.diagnostics(self).map((d) => ({
        code: d.code,
        span: source.slice(d.span.start, d.span.end).trim(),
      })),
      [
        { code: 'SEM0145', span: 'callback' },
        { code: 'SEM0145', span: 'callback' },
        { code: 'SEM0012', span: 'diverge()' },
        { code: 'SEM0145', span: 'callback' },
      ],
    )
  }),
)

it.effect('rejects moving or dropping an owner while a returned view is live', () =>
  Effect.gen(function* () {
    const source = `struct Token { value: i32 }
fn identity(values: &[Token]) -> &[Token] { return values }
fn moved() -> i32 {
  let values = [Token { value: 1 }]
  let view = identity(&values)
  let consumed = move values
  return view[0].value
}
fn dropped() -> i32 {
  let values = [Token { value: 1 }]
  let view = identity(&values)
  drop values
  return view[0].value
}
pub fn main() -> i32 { return 0 }`
    const self = yield* analyze(source)
    assert.deepEqual(
      Analysis.diagnostics(self).map((d) => ({
        code: d.code,
        span: source.slice(d.span.start, d.span.end).trim(),
      })),
      [
        { code: 'OWN0011', span: 'values' },
        { code: 'OWN0019', span: 'view[0]' },
        { code: 'OWN0011', span: 'values' },
        { code: 'OWN0019', span: 'view[0]' },
      ],
    )
  }),
)

it.effect('rejects moving a non-Copy value through a borrowed element place', () =>
  Effect.gen(function* () {
    const self = yield* analyze(`struct Token { value: i32 }
fn steal(values: &[Token], index: usize) -> Token { return move values[index] }
pub fn main() -> i32 { return 0 }`)

    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      ['OWN0012'],
    )
  }),
)

it.effect('plans exactly one displaced cleanup for exclusive borrowed replacement', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`struct Token { value: i32 }
struct Empty {}
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
fn replace(values: &mut [Token], index: usize) -> i32 {
  values[index] = Token { value: 42 }
  return values[index].value
}
fn clear(values: &mut [Empty], index: usize) -> i32 {
  values[index] = Empty {}
  return 0
}
pub fn main() -> i32 {
  let mut empty = [Empty {}]
  let cleared = clear(&mut empty, 0)
  let mut values = [Token { value: 1 }]
  return replace(&mut values, 0) + cleared
}`)

    assert.deepEqual(Analysis.diagnostics(self), [])
    const replacements =
      Analysis.ownershipOf(self, 'slices/Ownership')?.functions.at(0)?.replacements ?? []
    assert.strictEqual(replacements.length, 1)
    assert.strictEqual(replacements.at(0)?.cleanup._tag, 'HookCleanup')
    const empty =
      Analysis.ownershipOf(self, 'slices/Ownership')?.functions.at(1)?.replacements ?? []
    const cleanup = empty.at(0)?.cleanup
    assert.strictEqual(cleanup?._tag, 'StructCleanup')
    if (cleanup?._tag === 'StructCleanup') {
      assert.deepEqual(cleanup.fields, [])
    }
    const mir = self.mir._tag === 'Available' ? self.mir.value : unreachable('replacement MIR')
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const replace = mir.functions.find((fn) => fn.id.name === 'replace') ?? unreachable('replace')
    const corrupted = {
      ...mir,
      functions: mir.functions.map((fn) =>
        fn !== replace
          ? fn
          : {
              ...fn,
              regions: fn.regions.map((region) =>
                region._tag !== 'OperationRegion'
                  ? region
                  : {
                      ...region,
                      operations: region.operations.filter(
                        (operation) => operation._tag !== 'WritePlace',
                      ),
                    },
              ),
            },
      ),
    }
    assert.deepEqual(
      (yield* MirVerification.verify(corrupted)).map((violation) => violation.rule),
      ['InvalidSliceOperation'],
    )
  }),
)

it.effect('ends loop-body loans before continue and return cleanup boundaries', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`fn read(values: &[i32]) -> i32 { return 1 }
fn flowTest() -> i32 {
  let values = [1, 2]
  while false {
    let seen = read(&values)
    continue
  }
  return read(&values)
}
pub fn main() -> i32 { return 0 }`)

    assert.deepEqual(Analysis.diagnostics(self), [])
    const ownership = Analysis.ownershipOf(self, 'slices/Ownership')?.functions.at(1)
    const continuing = ownership?.exits.find((exit) => exit.kind === 'Continue')
    const returned = ownership?.exits.find(
      (exit) => exit.kind === 'Return' && exit.loanEnds.length > 0,
    )
    assert.deepEqual(continuing?.loanEnds, [])
    assert.deepEqual(
      returned?.loanEnds.map((loan) => loan.ordinal),
      [0],
    )
    assert.notStrictEqual(ownership?.loans.at(0)?.endRegion.ordinal, continuing?.region?.ordinal)
  }),
)

it.effect('extends a view loan through a use nested in a place replace', () =>
  Effect.gen(function* () {
    // The view's last use sits inside Place.replace's value operand; the owner write between the
    // direct uses and that nested use must still count as access during the loan.
    const source = `pub fn main() -> i32 {
  let mut values = [1, 2]
  let view = &values
  let first = view[1]
  values[0] = 40
  let mut sink = 0
  let old = Intrinsic.replace(sink, view[0])
  return first + old + values[0]
}`
    const self = yield* analyze(source)
    assert.deepEqual(
      Analysis.diagnostics(self).map((d) => ({
        code: d.code,
        span: source.slice(d.span.start, d.span.end).trim(),
      })),
      [
        { code: 'OWN0011', span: 'values[0]' },
        { code: 'OWN0019', span: 'view[0]' },
      ],
    )
  }),
)

it.effect('rejects AES-GCM input/output and detached-tag aliases at the call boundary', () =>
  Effect.gen(function* () {
    const source = `import silk.aes_gcm { AesGcm }
fn invalidSeal(key: &[u8], nonce: &[u8], aad: &[u8], bytes: &mut [u8], tag: &mut [u8]) -> () {
  let result = AesGcm.seal(key, nonce, aad, &bytes, &mut bytes, &mut tag)
}
fn invalidOpen(key: &[u8], nonce: &[u8], aad: &[u8], bytes: &mut [u8], tag: &[u8]) -> () {
  let result = AesGcm.open(key, nonce, aad, &bytes, tag, &mut bytes)
}
fn invalidTag(key: &[u8], nonce: &[u8], aad: &[u8], bytes: &[u8], output: &mut [u8]) -> () {
  let result = AesGcm.seal(key, nonce, aad, bytes, &mut output, &mut output)
}`
    const self = yield* analyze(source)
    const diagnostics = Analysis.diagnostics(self)
    const spans = ['&mut bytes, &mut tag', '&mut bytes)', '&mut output)'].map((text) =>
      source.indexOf(text),
    )
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['OWN0010', 'OWN0010', 'OWN0010'],
    )
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.span.start),
      spans,
    )
  }),
)

it.effect('enforces X25519 consumption, private storage and Random provision', () =>
  Effect.gen(function* () {
    const source = `import silk.x25519 { X25519 }
import silk.u8
fn reused(key: X25519, peer: &[u8]) -> () {
  let agreed = X25519.agree(move key, peer)
  let public = X25519.publicKey(&key)
}
fn privateStorage(key: &X25519) -> () {
  let secret = key.scalar
}
fn missingRandom() -> () {
  let key = run X25519.generate()
}
pub fn main() -> i32 { return 0 }`
    const self = yield* analyze(source)
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => ({
        code: diagnostic.code,
        span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'OWN0001', span: '&key' },
        { code: 'SEM0028', span: 'scalar' },
        { code: 'SEM0071', span: 'run X25519.generate()' },
      ],
    )
  }),
)
