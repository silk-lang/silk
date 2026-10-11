import * as Layer from 'effect/Layer'
import type * as ModuleClosure from '../src/ModuleClosure.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import * as ArtifactComposition from '../src/ArtifactComposition.js'
import * as ArtifactPlan from '../src/ArtifactPlan.js'
import * as CompilationProfile from '../src/CompilationProfile.js'
import * as ConfigurationOrigin from '../src/ConfigurationOrigin.js'
import * as NativeRequirement from '../src/NativeRequirement.js'
import * as NativeRequirementBinding from '../src/NativeRequirementBinding.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as CleanupPlan from '../src/CleanupPlan.js'
import * as DeclarationFacts from '../src/DeclarationFacts.js'
import * as Backend from '../src/Backend.js'
import * as Layout from '../src/Layout.js'
import * as Lifetime from '../src/Lifetime.js'
import * as Tir from '../src/Tir.js'
import * as FunctionIndex from '../src/internal/FunctionIndex.js'
import * as Instances from '../src/Instances.js'
import * as SemanticContext from '../src/SemanticContext.js'
import * as LlvmBackend from '../src/LlvmBackend.js'
import * as Match from '../src/Match.js'
import * as Mir from '../src/Mir.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Preparation from '../src/Preparation.js'
import * as Type from '../src/Type.js'
import * as SuspensionMode from '../src/SuspensionMode.js'
import { unreachable } from './support/raise.js'
import { dereferencedCallAcceptance, reflectedBorrowWrapperAcceptance } from './support/corpus.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

// Pinned, not host-resolved: the goldens record a target line, so an unpinned host target makes
// these assertions pass only on Apple Silicon.
const snapshot = (
  text: string,
): Effect.Effect<Analysis.Snapshot, ModuleClosure.ModuleClosureError> =>
  AnalysisFixture.retainingMain('golden/program', ascii(text), 'aarch64-apple-darwin')

const golden = (name: string): string =>
  readFileSync(new URL(`./goldens/${name}`, import.meta.url), 'utf8')

const nestedSource = `pub fn identity(value: i32) -> i32 { return value }
pub fn main() -> i32 { return identity(identity(42)) }`

it.effect('discovers an ordinary call beneath a referent place', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(dereferencedCallAcceptance)
    assert.deepEqual(Analysis.diagnostics(result), [])
    assert.isTrue(
      result.instances.instances.some((instance) => instance.key.declaration.name === 'view'),
    )
  }),
)

it.effect('discovers each reflection wrapper call beneath a referent place', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(reflectedBorrowWrapperAcceptance)
    assert.deepEqual(Analysis.diagnostics(result), [])
    const wrappers = result.instances.instances.filter(
      (instance) => instance.key.declaration.name === 'Reflect.borrowField',
    )
    assert.deepEqual(
      wrappers.map((instance) => {
        const field = instance.key.staticArguments.at(0)
        return field?._tag === 'FieldDescriptorValue'
          ? field.declarationOrdinal
          : unreachable('expected a sealed field descriptor specialization')
      }),
      [0, 1],
    )
  }),
)

it.effect('preserves all specialization matches and isolates discovery frontiers', () =>
  Effect.gen(function* () {
    const analysis = yield* snapshot(nestedSource)
    const discovery = analysis.instances
    const base =
      discovery.instances.find((instance) => instance.key.declaration.name === 'identity') ??
      unreachable('expected identity instance')
    const first: Instances.Instance = { ...base, key: { ...base.key, typeArguments: ['i32'] } }
    const second: Instances.Instance = {
      ...first,
      key: { ...first.key, contractRow: ['another row'] },
    }
    const otherType: Instances.Instance = { ...base, key: { ...base.key, typeArguments: ['u32'] } }
    const otherModule: Instances.Instance = {
      ...first,
      key: { ...first.key, declaration: { ...first.key.declaration, module: 'another/module' } },
    }
    const expanded = { ...discovery, instances: [otherModule, first, otherType, second] }
    assert.deepEqual(Instances.matchingSpecialization(expanded, first.key), [first, second])
    assert.deepEqual(Instances.matchingSpecialization(expanded, otherType.key), [otherType])
    assert.deepEqual(Instances.matchingSpecialization(expanded, otherModule.key), [otherModule])
    assert.deepEqual(
      Instances.matchingSpecialization({ ...expanded, instances: [second] }, first.key),
      [second],
    )
    assert.deepEqual(
      Instances.matchingSpecialization({ ...expanded, instances: [] }, first.key),
      [],
    )
    assert.deepEqual(Instances.matchingSpecialization(expanded, first.key), [first, second])
  }),
)

it.effect('keeps suspension subjects, duplicate precedence, and fact snapshots independent', () =>
  Effect.gen(function* () {
    const analysis = yield* snapshot('pub fn main() -> i32 { return 0 }')
    const discovery = analysis.instances
    const key = discovery.instances.at(0)?.key ?? unreachable('expected main instance')
    // Use the same text in all three namespaces so an untagged index cannot pass.
    const identity = Instances.keyText(key)
    const nested: SuspensionMode.Summary = {
      ...SuspensionMode.direct,
      modes: ['NestedTransfer'],
    }
    const parked: SuspensionMode.Summary = {
      ...SuspensionMode.direct,
      modes: ['ExternalPark'],
    }
    const facts: ReadonlyArray<Instances.SuspensionFact> = [
      { _tag: 'SuspensionFact', subject: { _tag: 'Instance', key }, summary: nested },
      { _tag: 'SuspensionFact', subject: { _tag: 'Execution', key }, summary: parked },
      {
        _tag: 'SuspensionFact',
        subject: { _tag: 'Effect', identity },
        summary: SuspensionMode.direct,
      },
      { _tag: 'SuspensionFact', subject: { _tag: 'Instance', key }, summary: parked },
      { _tag: 'SuspensionFact', subject: { _tag: 'Execution', key }, summary: nested },
      { _tag: 'SuspensionFact', subject: { _tag: 'Effect', identity }, summary: parked },
    ]
    const populated = { ...discovery, suspension: facts }
    assert.strictEqual(Instances.suspensionOf(populated, { ...key }), nested)
    assert.strictEqual(Instances.executionSuspensionOf(populated, key), parked)
    assert.strictEqual(Instances.effectSuspensionOf(populated, identity), SuspensionMode.direct)
    const replaced = { ...populated, suspension: facts.slice(3) }
    assert.strictEqual(Instances.suspensionOf(replaced, key), parked)
    assert.strictEqual(Instances.executionSuspensionOf(replaced, key), nested)
    assert.strictEqual(Instances.effectSuspensionOf(replaced, identity), parked)
    const empty = { ...populated, suspension: [] }
    assert.strictEqual(Instances.suspensionOf(empty, key), SuspensionMode.direct)
    assert.strictEqual(Instances.executionSuspensionOf(empty, key), SuspensionMode.direct)
    assert.strictEqual(Instances.effectSuspensionOf(empty, identity), SuspensionMode.direct)
    assert.strictEqual(Instances.suspensionOf(populated, key), nested)
  }),
)

it('indexes canonical functions in source order without admitting unresolved declarations', () => {
  const first = { _tag: 'CanonicalDeclarationId', module: 'one', name: 'same' } as const
  const second = { ...first, module: 'two' }
  const duplicate = { ...first }
  const entries = [undefined, first, second, duplicate]
  const index = FunctionIndex.make(entries, (entry) => entry)
  assert.deepEqual(index.names.get('same'), [first, second, duplicate])
  assert.strictEqual(index.names.get('same')?.at(0), first)
  assert.deepEqual(FunctionIndex.candidates(index, first), [first, duplicate])
  assert.strictEqual(FunctionIndex.candidates(index, first).at(0), first)
  assert.deepEqual(FunctionIndex.candidates(index, second), [second])
  assert.deepEqual(FunctionIndex.candidates(index, { ...first, module: 'missing' }), [])
})

it.effect('discovers reachable call chains once and terminates recursion', () =>
  Effect.gen(function* () {
    const analyzedNested = yield* snapshot(nestedSource)
    const nested = Analysis.instancesOf(analyzedNested)
    const tir = Analysis.rootAnalysis(analyzedNested).tir
    for (const fn of tir.functions) {
      if (fn.declaration.canonical._tag !== 'Canonical') continue
      const declaration = fn.declaration.canonical.id
      assert.strictEqual(FunctionIndex.tirByName(tir, declaration.name), fn)
      assert.strictEqual(FunctionIndex.tirByCanonical(tir, declaration), fn)
      assert.strictEqual(
        FunctionIndex.tirByCanonical(tir, { ...declaration, module: 'missing' }),
        undefined,
      )
    }
    assert.strictEqual(FunctionIndex.tirByName(tir, 'missing'), undefined)
    assert.strictEqual(FunctionIndex.tirByName(undefined, 'main'), undefined)
    // A changed immutable snapshot must not inherit the old module's cached entries.
    assert.strictEqual(FunctionIndex.tirByName({ ...tir, functions: [] }, 'main'), undefined)
    const direct = Analysis.instancesOf(yield* snapshot('pub fn main() -> i32 { return main() }'))
    const mutual = Analysis.instancesOf(
      yield* snapshot(`pub fn main() -> i32 { return other() }
pub fn other() -> i32 { return main() }`),
    )
    const aggregate = Analysis.instancesOf(
      yield* snapshot(`struct Pair { left: i32 right: i32 }
fn build(remaining: i32) -> Pair {
  if remaining == 0 { return Pair { left: 40, right: 2 } }
  return build(remaining - 1)
}
pub fn main() -> i32 {
  let pair = build(4)
  return pair.left + pair.right
}`),
    )
    assert.deepEqual(
      nested.instances.map((instance) => instance.key.declaration.name),
      ['main', 'identity'],
    )
    assert.deepEqual(
      direct.instances.map((instance) => instance.key.declaration.name),
      ['main'],
    )
    assert.deepEqual(
      mutual.instances.map((instance) => instance.key.declaration.name),
      ['main', 'other'],
    )
    assert.deepEqual(
      aggregate.instances.map((instance) => instance.key.declaration.name),
      ['main', 'build'],
    )
    for (const discovery of [nested, direct, mutual, aggregate])
      assert.strictEqual(discovery.counters.residualBodies.requests, discovery.instances.length)
    const mutualRoot =
      mutual.instances.find((instance) => instance.key.declaration.name === 'main') ??
      unreachable('expected mutual-recursion root')
    const mutualClosure = Instances.executionClosure(mutual, mutualRoot.key)
    assert.deepEqual(mutualClosure.gaps, [])
    assert.deepEqual(
      mutualClosure.instances.map((instance) => instance.key.declaration.name),
      ['main', 'other'],
    )
  }),
)

it.effect('shares monomorphic discovery across converging call paths', () =>
  Effect.gen(function* () {
    const analyzed = yield* snapshot(`fn leaf(value: i32) -> i32 { return value }
fn left(value: i32) -> i32 { return leaf(value) }
fn right(value: i32) -> i32 { return leaf(value) }
pub fn main() -> i32 { return left(1) + right(2) }`)
    assert.deepEqual(Analysis.diagnostics(analyzed), [])
    const discovery = Analysis.instancesOf(analyzed)
    assert.deepEqual(
      discovery.instances.map((instance) => instance.key.declaration.name),
      ['main', 'left', 'right', 'leaf'],
    )
    // These are semantic body requests, not timings: different monomorphic paths must share
    // the same discovery context, rather than asking residualization to cache duplicate work.
    assert.strictEqual(discovery.counters.residualBodies.requests, discovery.instances.length)
  }),
)

it.effect('retains generic ancestors across shared monomorphic helpers', () =>
  Effect.gen(function* () {
    const analyzed = yield* snapshot(`fn generic<T>() -> i32 { return helper() }
fn helper() -> i32 { return generic<bool>() }
pub fn main() -> i32 { return helper() + generic<i32>() }`)
    assert.deepEqual(
      Analysis.diagnostics(analyzed).map((diagnostic) => diagnostic.code),
      ['SEM0053'],
    )
    const discovery = Analysis.instancesOf(analyzed)
    assert.deepEqual(
      discovery.violations.map((violation) => ({
        caller: violation.caller.declaration.name,
        target: violation.target.typeArguments.map(Type.encodeGenericArgument),
      })),
      [{ caller: 'helper', target: ['bool'] }],
    )
    // `middle` joins the cycle only once its call back to `generic` is evaluated, after the
    // history entering it was projected without `generic`; the guard must still fire there.
    const late = Analysis.instancesOf(
      yield* snapshot(`fn generic<T>(value: T) -> i32 { return middle<T>(move value) }
fn middle<T>(value: T) -> i32 { return generic<[T; 1]>([move value]) }
pub fn main() -> i32 { return generic<i32>(1) }`),
    )
    assert.deepEqual(
      late.violations.map((violation) => ({
        caller: violation.caller.declaration.name,
        target: violation.target.typeArguments.map(Type.encodeGenericArgument),
      })),
      [{ caller: 'middle', target: ['Array<i32, 1>'] }],
    )
    assert.deepEqual(
      late.instances.map((instance) => instance.key.declaration.name),
      ['main', 'generic', 'middle'],
    )
  }),
)

it.effect('forgets ancestors outside the recursive cycle a call enters', () =>
  Effect.gen(function* () {
    // Callable wrappers `z*` each see every entry, while every entry reaches the same recursive
    // walkers `a*`. Correlating wrapper identities with walker paths the guard never compares
    // multiplied the exact histories; only the walkers' own cycle is retained below them.
    const walkers = Array.from(
      { length: 8 },
      (_, index) => `fn a${index}(depth: i32, visit: fn(i32) -> i32) -> i32 {
  if depth == 0 { return visit(depth) }
  return a${(index + 1) % 8}(depth - 1, visit) + a${(index + 2) % 8}(depth - 1, visit)
}`,
    )
    const entries = Array.from(
      { length: 8 },
      (_, index) => `fn e${index}(depth: i32) -> i32 { return a${index}(depth, leaf) }`,
    )
    const discovery = Analysis.instancesOf(
      yield* snapshot(`fn leaf(value: i32) -> i32 { return value }
${walkers.join('\n')}
${entries.join('\n')}
fn z0(depth: i32, entry: fn(i32) -> i32) -> i32 { return z1(depth, entry) }
fn z1(depth: i32, entry: fn(i32) -> i32) -> i32 { return z2(depth, entry) }
fn z2(depth: i32, entry: fn(i32) -> i32) -> i32 { return entry(depth) }
pub fn main() -> i32 { return ${entries.map((_, index) => `z0(1, e${index})`).join(' + ')} }`),
    )
    assert.deepEqual(discovery.violations, [])
    assert.strictEqual(discovery.counters.residualBodies.requests, discovery.instances.length)
    const root =
      discovery.instances.find((instance) => instance.key.declaration.name === 'main') ??
      unreachable('expected cycle-projection root')
    const closure = Instances.executionClosure(discovery, root.key)
    assert.deepEqual(closure.gaps, [])
    assert.strictEqual(closure.instances.length, discovery.instances.length)
    // Structural, not a timing: the unprojected guard built over 5000 decision nodes here.
    assert.isBelow(discovery.counters.ancestryNodes, 1000)
  }),
)

it.effect('bounds ancestry for one mutually recursive lowering cycle across modules', () =>
  Effect.gen(function* () {
    // The shape of the self-hosted HIR lowering: mutually recursive `effect fn` walkers threading
    // one `&mut State` and requiring `&mut Allocator`, spread over several modules so the whole
    // set is one strongly connected component, with a second cycle reachable from the first.
    // Every walker is monomorphic, so no ancestor of one can ever differ from a target of it and
    // the guard below it decides nothing; correlating them was what grew the exact histories past
    // what a process can hold once the component reached a few hundred declarations.
    const walkers = (module: string, count: number, next: string): string =>
      Array.from(
        { length: count },
        (_, index) => `pub effect fn w${module}${index}(state: &mut State, depth: i32) -> i32
? &mut Allocator {
  if depth == 0 { return run ${next}(&mut state.*, depth) }
  let left = run w${module}${(index + 1) % count}(&mut state.*, depth - 1)
  let right = run ${index + 1 === count ? next : `w${module}${index + 1}`}(&mut state.*, depth - 1)
  return left + right
}`,
      ).join('\n')
    const modules = new Map([
      [
        'lower/state',
        ascii(`pub struct State { count: i32 }
pub fn newState() -> State { return State { count: 0 } }
pub service Allocator { effect fn reserve(size: i32) -> i32 ? &mut Allocator }`),
      ],
      [
        'lower/second',
        ascii(`import lower.state { State, Allocator }
pub effect fn tail(state: &mut State, depth: i32) -> i32 ? &mut Allocator {
  if depth == 0 { return run Allocator.reserve(1) }
  return run tailAgain(&mut state.*, depth - 1)
}
pub effect fn tailAgain(state: &mut State, depth: i32) -> i32 ? &mut Allocator {
  if depth == 0 { return run Allocator.reserve(2) }
  return run tail(&mut state.*, depth - 1)
}`),
      ],
      [
        'lower/type',
        ascii(`import lower.state { State, Allocator }
import lower.expression { wexpression0 }
import lower.second { tail }
${walkers('type', 8, 'wexpression0')}`),
      ],
      [
        'lower/expression',
        ascii(`import lower.state { State, Allocator }
import lower.pattern { wpattern0 }
${walkers('expression', 8, 'wpattern0')}`),
      ],
      [
        'lower/pattern',
        ascii(`import lower.state { State, Allocator }
import lower.type { wtype0 }
import lower.second { tail }
${walkers('pattern', 8, 'tail')}`),
      ],
    ])
    const root = `import lower.state { State, Allocator, newState }
import lower.type { wtype0 }
pub effect fn main() -> i32 ? &mut Allocator {
  let mut state = newState()
  return run wtype0(&mut state, 3)
}`
    const selected = AnalysisFixture.configuration('lower/root', 'aarch64-apple-darwin')
    const analyzed = yield* Analysis.make({ root: 'lower/root', configuration: selected }).pipe(
      Effect.flatMap((frontend) => Analysis.realize(frontend, selected)),
      Effect.provide(
        SourceResolver.overlay([SourceFile.make('lower/root', ascii(root))]).pipe(
          Layer.provideMerge(SourceResolver.memory(modules)),
          Layer.provideMerge(SourceResolver.empty),
        ),
      ),
    )
    assert.deepEqual(Analysis.diagnostics(analyzed), [])
    const discovery = Analysis.instancesOf(analyzed)
    assert.deepEqual(discovery.violations, [])
    // Every walker is reached, so the bound is not the absence of discovery.
    assert.strictEqual(
      discovery.instances.filter((instance) => instance.key.declaration.name.startsWith('w'))
        .length,
      24,
    )
    // Structural, not a timing: before the bound this component interned a decision node for every
    // correlated subset of its walkers. A declaration realized at one instance key decides nothing,
    // so none of them enters the ancestry at all.
    assert.strictEqual(discovery.counters.ancestryNodes, 0)
  }),
)

it.effect('roots native libraries at C exports without selecting main', () =>
  Effect.gen(function* () {
    const frontend = yield* Analysis.ofSource(
      'library/Math',
      ascii(`fn helper(value: i32) -> i32 { return value + 1 }
export "C" fn increment(value: i32) -> i32 { return helper(value) }
pub fn main() -> i32 { return 0 }`),
    )
    const prepared = Preparation.preparation(
      yield* Preparation.promote(frontend, 'aarch64-apple-darwin', {
        artifactKind: 'NativeSharedLibrary',
        emission: true,
      }).pipe(Effect.provide(SourceResolver.empty)),
    )
    assert.strictEqual(prepared._tag, 'Prepared')
    if (prepared._tag !== 'Prepared') return
    assert.deepStrictEqual(
      {
        functions: prepared.program.functions.map((fn) => fn.id.name),
        exports: prepared.program.foreignExports.map((export_) => export_.symbol),
      },
      { functions: ['increment', 'helper'], exports: ['increment'] },
    )
    assert.deepStrictEqual(
      prepared.program.foreignExports.map((export_) => export_.symbol),
      ['increment'],
    )
    assert.deepStrictEqual(yield* MirVerification.verify(prepared.program), [])
    const artifact = yield* LlvmBackend.LlvmBackend.emit(prepared.program, {
      mode: 'release',
      verifyIr: true,
    })
    assert.match(artifact.ir, /define hidden i32 @silk_/)
    assert.match(artifact.ir, /define i32 @increment\(/)
    assert.notMatch(artifact.ir, /define hidden i32 @increment\(/)
  }),
)

it.effect('emits an empty native library without retaining unrelated public functions', () =>
  Effect.gen(function* () {
    const frontend = yield* Analysis.ofSource(
      'library/Empty',
      ascii('pub fn helper() -> i32 { return 42 }'),
    )
    const prepared = Preparation.preparation(
      yield* Preparation.promote(frontend, 'aarch64-apple-darwin', {
        artifactKind: 'NativeStaticLibrary',
        emission: true,
      }).pipe(Effect.provide(SourceResolver.empty)),
    )
    assert.strictEqual(prepared._tag, 'Prepared')
    if (prepared._tag === 'Prepared') {
      assert.deepEqual(prepared.program.functions, [])
      const artifact = yield* LlvmBackend.LlvmBackend.emit(prepared.program, {
        mode: 'release',
        verifyIr: true,
      })
      assert.deepEqual(artifact.foreignExports, [])
    }
  }),
)

it.effect('discovers calls nested in Evaluate statements deterministically', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`effect fn pulse() -> () { return () }
pub effect fn main() -> () { run pulse() return () }`)

    assert.deepEqual(Analysis.diagnostics(result), [])
    assert.deepEqual(
      Analysis.instancesOf(result).instances.map((instance) => instance.key.declaration.name),
      ['main', 'pulse'],
    )
  }),
)

it.effect('discovers concrete stored and deferred-generic callable section identities', () =>
  Effect.gen(function* () {
    const stored = Analysis.instancesOf(
      yield* snapshot(`fn add(left: i32, right: i32) -> i32 { return left + right }
pub fn main() -> i32 { let plusTwo = add(2) return plusTwo(40) }`),
    )
    const generic = Analysis.instancesOf(
      yield* snapshot(`fn select<T>(value: T, enabled: bool) -> T { return move value }
pub fn main() -> i32 { let whenEnabled = select(true) return whenEnabled(42) }`),
    )

    assert.deepEqual(
      stored.instances.map((instance) => instance.key.declaration.name),
      ['main', 'add'],
    )
    assert.strictEqual(stored.callables.length, 1)
    assert.deepEqual(stored.callables.at(0)?.captureTypes.map(Type.encode), ['i32'])
    assert.strictEqual(stored.callables.at(0)?.mode, 'Shared')
    assert.deepEqual(
      generic.instances.map((instance) => ({
        name: instance.key.declaration.name,
        arguments: instance.key.typeArguments.map(Type.encodeGenericArgument),
      })),
      [
        { name: 'main', arguments: [] },
        { name: 'select', arguments: ['i32'] },
      ],
    )
    // The section leaves `T` open, so its one environment is named before its application: the
    // identity keeps `T` as the section's own binder and the stored value has the closed contract.
    // The application invokes the complete `select<i32>` instance above through its own call.
    const [environment, ...others] = generic.callables
    assert.deepEqual(others, [])
    assert.isTrue(
      environment?.typeArguments.every(
        (argument) => Type.isTypeArgument(argument) && Type.isSectionBinder(argument),
      ),
    )
    assert.strictEqual(Type.encode(environment?.type ?? 'i32'), "fn<'static>(never) -> never")
    assert.deepEqual(
      generic.calls
        .filter((call) => call.target.declaration.name === 'select')
        .map((call) => call.target.typeArguments.map(Type.encodeGenericArgument)),
      [['i32']],
    )
  }),
)

it.effect('resolves a provided service effect captured by a callable section', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }

service Sink {
  effect fn value() -> i32 ? &mut Sink
}

struct FixedSink {}

impl Sink for FixedSink {
  effect fn value(self: &mut Self) -> i32 ? &mut Sink { return 42 }
}

effect fn forward<A, E, ?R>(marker: i32, protected: once Effect<A ! E ? R>) -> A ! E ? R {
  return run move protected
}

pub fn main() -> i32 {
  let mut sink = FixedSink {}
  let finish = forward(Sink.value())
  return run finish(0) |> Effect.provideMut(&mut sink)
}`
    const result = yield* snapshot(source)

    // Discovery closes over the provider; native lowering of the provided section is a SEM0219 gap.
    assert.deepEqual(
      Analysis.diagnostics(result).map((diagnostic) => ({
        code: diagnostic.code,
        span: source.slice(diagnostic.span.start, diagnostic.span.end),
      })),
      [
        {
          code: 'SEM0219',
          span: source.slice(
            source.indexOf('effect fn forward'),
            source.indexOf('\n\npub fn main'),
          ),
        },
        { code: 'SEM0219', span: 'run finish(0) |> Effect.provideMut(&mut sink)' },
      ],
    )
    assert.deepEqual(
      Analysis.instancesOf(result).instances.map((instance) => instance.key.declaration.name),
      ['main', 'Effect.provideMut', 'forward', 'forward', 'impl@0.value'],
    )
    const discovery = Analysis.instancesOf(result)
    const root =
      discovery.instances.find((instance) => instance.key.declaration.name === 'main') ??
      unreachable('expected provider root')
    const closure = Instances.executionClosure(discovery, root.key)
    assert.deepEqual(closure.gaps, [])
    assert.include(
      closure.edges.map((edge) => edge.kind),
      'Provider',
    )
    assert.include(
      closure.instances.map((instance) => instance.key.declaration.name),
      'impl@0.value',
    )
  }),
)

it.effect('keeps inferred hidden calls scoped to the function that contains their expression', () =>
  Effect.gen(function* () {
    const result =
      yield* snapshot(`fn make() -> once Effect<'static; i32> { return effect { return 42 } }
fn relay() -> once Effect<'static; i32> { return make() }
fn forward<'env, A, E, ?R>(protected: once Effect<'env; A ! E ? R>) -> once Effect<'env; A ! E ? R> {
  return move protected
}
pub fn main() -> i32 { return run forward(relay()) }`)
    const discovery = Analysis.instancesOf(result)

    assert.deepEqual(Analysis.diagnostics(result), [])
    assert.deepEqual(
      discovery.calls.map((call) => ({
        owner: call.owner.declaration.name,
        target: call.target.declaration.name,
      })),
      [
        { owner: 'main', target: 'forward' },
        { owner: 'main', target: 'relay' },
        { owner: 'relay', target: 'make' },
      ],
    )
    const registry = SemanticContext.fromModules(result.results.values())
    for (const call of discovery.calls) {
      const owner = discovery.instances.find(
        (instance) => Instances.keyText(instance.key) === Instances.keyText(call.owner),
      )
      assert.notStrictEqual(owner, undefined)
      if (owner === undefined) continue
      const ownerSpan = registry.spanOf(owner.function.declaration.anchor)
      assert.strictEqual(call.span.sourceId, ownerSpan.sourceId)
      assert.isAtLeast(call.span.start, ownerSpan.start)
      assert.isAtMost(call.span.end, ownerSpan.end)
    }
  }),
)

it.effect('keeps executable sites distinct across generic owner specializations', () =>
  Effect.gen(function* () {
    const analyzed = yield* snapshot(`fn add(left: i32, right: i32) -> i32 { return left + right }
fn section<T>(value: T) -> i32 {
  let plusOne = add(1)
  return plusOne(41)
}
effect<'env> fn deferred<T: 'env, 'env>(value: T) -> T { return move value }
pub fn main() -> i32 {
  let left = section<i32>(1)
  let right = section<bool>(true)
  let number = run deferred<i32>(left + right)
  let flag = run deferred<bool>(true)
  if flag { return number }
  return 0
}`)
    assert.deepEqual(Analysis.diagnostics(analyzed), [])
    const result = Analysis.instancesOf(analyzed)
    assert.strictEqual(result.counters.residualBodies.checked, 0)
    assert.strictEqual(result.counters.residualOwnership.checked, 0)
    assert.strictEqual(result.counters.residualOwnership.cacheReused, 2)
    assert.isAbove(result.counters.residualOwnership.sourceReused, 0)
    assert.strictEqual(
      Object.values(result.counters.residualOwnership.executedWork).reduce(
        (total, count) => total + count,
        0,
      ),
      0,
    )
    assert.deepEqual(
      analyzed.report.find((phase) => phase.phase === 'instance-discovery')?.counters,
      result.counters,
    )
    const sections = result.callables.filter(
      (callable) => callable.owner.declaration.name === 'section',
    )
    const effects = result.instances
      .filter((instance) => instance.key.declaration.name === 'deferred')
      .flatMap((instance) => (instance.resultEffect === undefined ? [] : [instance.resultEffect]))

    assert.strictEqual(sections.length, 2)
    assert.strictEqual(new Set(sections.map(Instances.callableIdentity)).size, 2)
    assert.strictEqual(effects.length, 2)
    assert.strictEqual(new Set(effects).size, 2)
    assert.strictEqual(
      [...sections.map(Instances.callableIdentity), ...effects].some((identity) =>
        /@\d/.test(identity),
      ),
      false,
    )
  }),
)

it.effect('rejects polymorphic recursion reached through a callable section', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`fn expand<T>(seed: i32, value: T) -> i32 {
  let next = expand<[T; 1]>([move value])
  return next(seed)
}
pub fn main() -> i32 { return expand<i32>(0, 1) }`)

    assert.deepEqual(
      Analysis.diagnostics(result).map((diagnostic) => diagnostic.code),
      ['SEM0053'],
    )
    assert.strictEqual(result.instances.violations.length, 1)
    assert.deepEqual(
      result.instances.violations.at(0)?.target.typeArguments.map(Type.encodeGenericArgument),
      ['Array<i32, 1>'],
    )
  }),
)

it.effect('discovers cleanup hooks called by source failure recovery', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`struct SomeError { storage: RawBuffer<i32> }
impl Drop for SomeError {
  fn drop(self: &mut SomeError) -> () { return () }
}
fn makeError() -> SomeError { return makeError() }
effect fn failWithOwnedError() -> () ! SomeError {
  let error = makeError()
  fail move error
}
effect fn recover(error: SomeError) -> () { drop error }
pub fn main() -> () { return run Intrinsic.catchFailure<SomeError>(failWithOwnedError(), recover) }`)
    assert.deepEqual(Analysis.diagnostics(result), [])
    const discovery = Analysis.instancesOf(result)
    assert.deepEqual(
      discovery.instances.map((instance) => instance.key.declaration.name),
      ['main', 'failWithOwnedError', 'recover', 'makeError', 'drop@impl#0'],
    )
    const root =
      discovery.instances.find((instance) => instance.key.declaration.name === 'main') ??
      unreachable('expected cleanup root')
    const closure = Instances.executionClosure(discovery, root.key)
    assert.deepEqual(closure.gaps, [])
    assert.include(
      closure.edges.map((edge) => edge.kind),
      'Cleanup',
    )
    assert.include(
      closure.instances.map((instance) => instance.key.declaration.name),
      'drop@impl#0',
    )
  }),
)

it.effect('discovers Drop hooks inside an opaque shared payload', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`import silk.bytes { Bytes }
import silk.option { Option }
import silk.shared { Shared }
import silk.vector { Vector }
pub fn main() -> () {
  let value = Option.none<Shared<Vector<Option<Bytes>>>>()
  drop value
  return ()
}`)
    assert.deepEqual(Analysis.diagnostics(result), [])
    assert.isTrue(
      Analysis.instancesOf(result).instances.some(
        (instance) =>
          instance.key.declaration.module === 'silk/vector' &&
          instance.key.declaration.name === 'drop@impl#0' &&
          instance.key.typeArguments.map(Type.encodeGenericArgument).join(', ') ===
            'silk/option.Option<silk/bytes.Bytes>',
      ),
    )
  }),
)

it.effect('admits sibling shared payload cleanup selected outside any cleanup measure', () =>
  Effect.gen(function* () {
    // Dropping a `Shared<Outer>` directly starts each payload hook's cleanup measure afresh; the
    // hook's own helpers run at its `Shared<Head>` and `Shared<Ty>` arguments, which the
    // `Shared<Outer>` root does not cover by descent. Entering the same types through a vector
    // starts a measured path instead.
    const types = `struct Ty { value: i32 }
struct Head { tys: Vector<Shared<Ty>> }
struct Outer { heads: Vector<Shared<Head>> }
`
    const direct = yield* snapshot(`import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
import silk.vector { Vector }
${types}effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let outer = run (Shared.make<Outer>(Outer { heads: Vector.make<Shared<Head>>() })
    |> Effect.provideMut<Allocator>(&mut allocator))
  drop outer
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`)
    const measured = yield* snapshot(`import silk.shared { Shared }
import silk.vector { Vector }
${types}pub fn main() -> i32 {
  let outer = Vector.make<Shared<Outer>>()
  drop outer
  return 0
}`)
    const releases = (result: Analysis.Snapshot): Array<string> =>
      result.instances.instances
        .filter(
          (instance) =>
            instance.key.declaration.module === 'silk/vector' &&
            instance.key.declaration.name === 'releaseFull',
        )
        .map((instance) => instance.key.typeArguments.map(Type.encodeGenericArgument).join(', '))
        .sort()
    for (const result of [direct, measured]) {
      assert.deepEqual(Analysis.diagnostics(result), [])
      assert.deepEqual(result.instances.violations, [])
    }
    assert.deepEqual(releases(direct), [
      'silk/shared.Shared<golden/program.Head>',
      'silk/shared.Shared<golden/program.Ty>',
    ])
  }),
)

it.effect('admits finite owned payload cleanup nested through a shared vector', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`import silk.bytes { Bytes }
import silk.shared { Shared }
import silk.vector { Vector }
struct Evidence { value: Bytes }
struct Cached { items: Vector<Shared<Evidence>> }
struct Root { answer: Shared<Cached> }
pub fn main() -> () {
  let roots = Vector.make<Root>()
  drop roots
  return ()
}`)
    assert.deepEqual(
      Analysis.diagnostics(result).map((diagnostic) => diagnostic.code),
      [],
    )
    assert.deepEqual(result.instances.violations, [])
    const main =
      result.instances.instances.find((instance) => instance.key.declaration.name === 'main') ??
      unreachable('expected cleanup root')
    assert.deepEqual(Instances.executionClosure(result.instances, main.key).gaps, [])
    assert.isTrue(
      result.instances.instances.some(
        (instance) =>
          instance.key.declaration.module === 'silk/vector' &&
          instance.key.declaration.name === 'drop@impl#0' &&
          instance.key.typeArguments.map(Type.encodeGenericArgument).join(', ') ===
            'silk/shared.Shared<golden/program.Evidence>',
      ),
    )
    assert.isTrue(
      result.instances.instances.some(
        (instance) =>
          instance.key.declaration.module === 'silk/vector' &&
          instance.key.declaration.name === 'drop@impl#0' &&
          instance.key.typeArguments.map(Type.encodeGenericArgument).join(', ') === 'u8',
      ),
    )
  }),
)

it.effect('admits cleanup of a payload owned directly by a root element field', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`import silk.shared { Shared }
import silk.vector { Vector }
union Type {
  Nominal { arguments: Vector<Argument> },
  Union { members: Vector<Shared<Type>> }
}
union Argument {
  Type { value: Shared<Type> },
  Empty
}
struct Binding { value: Argument }
pub fn main() -> () {
  let bindings = Vector.make<Binding>()
  drop bindings
  return ()
}`)
    assert.deepEqual(Analysis.diagnostics(result), [])
    assert.deepEqual(result.instances.violations, [])
  }),
)

it.effect('finds a late structural cleanup field behind recursive metadata siblings', () =>
  Effect.gen(function* () {
    // Borrowed Shared edges retain the recursive structural graph without demanding owned
    // payload cleanup or recursively deriving affinity through every metadata path.
    const metadata = Array.from(
      { length: 18 },
      (_, owner) =>
        `struct Metadata${owner}<'a> {
${Array.from({ length: 18 }, (_, field) =>
  field === owner ? '' : `  field${field}: &'a Shared<Metadata${field}<'a>>`,
).join('\n')}
}`,
    ).join('\n')
    // Distinct scalar fields exercise discovery after its optional reachability pruning
    // gives way to the guarded search. Their contents require no cleanup specialization.
    const padding = Array.from(
      { length: 513 },
      (_, field) => `  field${field}: [u8; ${field}]`,
    ).join('\n')
    const result = yield* snapshot(`import silk.vector { Vector }
import silk.shared { Shared }
${metadata}
struct Padding {
  marker: i32
${padding}
}
struct Frame { value: i32 }
struct Machine<'a> {
  padding: Padding
  metadata: &'a Shared<Metadata0<'a>>
  active: Vector<Frame>
}
fn hold<'a>(anchor: &'a i32) -> () {
  let machines = Vector.make<Machine<'a>>()
  drop machines
  return ()
}
pub fn main() -> () {
  let anchor = 0
  hold(&anchor)
  return ()
}`)
    assert.deepEqual(Analysis.diagnostics(result), [])
    assert.deepEqual(result.instances.violations, [])
    const main =
      result.instances.instances.find((instance) => instance.key.declaration.name === 'main') ??
      unreachable('expected cleanup root')
    assert.deepEqual(Instances.executionClosure(result.instances, main.key).gaps, [])
    assert.isTrue(
      result.instances.instances.some(
        (instance) =>
          instance.key.declaration.module === 'silk/vector' &&
          instance.key.declaration.name === 'drop@impl#0' &&
          instance.key.typeArguments.map(Type.encodeGenericArgument).join(', ') ===
            'golden/program.Frame',
      ),
    )
    const index = result.instances.declarationIndex ?? unreachable('expected declaration facts')
    const struct = (name: string): DeclarationFacts.StructFact => {
      const fact = DeclarationFacts.byCanonical(index, {
        _tag: 'CanonicalDeclarationId',
        module: 'golden/program',
        name,
      })
      if (fact?._tag !== 'StructDeclaration') return unreachable('expected source struct')
      return fact
    }
    const fieldType = (field: DeclarationFacts.FieldFact): Type.Type => {
      if (field.declaredType._tag !== 'Resolved') return unreachable('expected resolved field')
      return field.declaredType.type
    }
    const spelling = (field: DeclarationFacts.FieldFact): string =>
      field.name._tag === 'Present' ? field.name.spelling : unreachable('expected named field')
    const borrowedShared = (type: Type.Type, owner: string, target: string): void => {
      if (!Type.isReference(type)) return unreachable('expected borrowed metadata')
      const region = Lifetime.bound({ module: 'golden/program', name: owner }, 0, 'a')
      assert.strictEqual(type.access, 'Shared')
      assert.strictEqual(Lifetime.key(type.lifetime), Lifetime.key(region))
      if (!Type.isNominal(type.target)) return unreachable('expected Shared referent')
      assert.deepEqual(
        { module: type.target.module, name: type.target.name },
        { module: 'silk/shared', name: 'Shared' },
      )
      const payload = type.target.arguments.at(0) ?? unreachable('expected Shared payload')
      if (!Type.isTypeArgument(payload) || !Type.isNominal(payload))
        return unreachable('expected metadata payload')
      assert.deepEqual(
        { module: payload.module, name: payload.name },
        { module: 'golden/program', name: target },
      )
      const argument = payload.arguments.at(0) ?? unreachable('expected referent lifetime')
      if (!Lifetime.isLifetime(argument)) return unreachable('expected lifetime argument')
      assert.strictEqual(Lifetime.key(argument), Lifetime.key(region))
      assert.strictEqual(CleanupPlan.cleanupPlan(index, type)._tag, 'NoCleanup')
    }
    const machine = struct('Machine')
    assert.deepEqual(machine.fields.map(spelling), ['padding', 'metadata', 'active'])
    borrowedShared(
      fieldType(machine.fields.at(1) ?? unreachable('expected metadata field')),
      'Machine',
      'Metadata0',
    )
    assert.strictEqual(
      Type.encode(fieldType(machine.fields.at(2) ?? unreachable('expected active field'))),
      'silk/vector.Vector<golden/program.Frame>',
    )
    for (let owner = 0; owner < 18; owner += 1) {
      const fields = struct(`Metadata${owner}`).fields
      const targets = Array.from({ length: 18 }, (_, target) => target).filter(
        (target) => target !== owner,
      )
      assert.deepEqual(
        fields.map(spelling),
        targets.map((target) => `field${target}`),
      )
      for (const [position, target] of targets.entries()) {
        borrowedShared(
          fieldType(fields.at(position) ?? unreachable('expected metadata sibling')),
          `Metadata${owner}`,
          `Metadata${target}`,
        )
      }
    }
    const paddingFields = struct('Padding').fields
    assert.deepEqual(paddingFields.map(spelling), [
      'marker',
      ...Array.from({ length: 513 }, (_, field) => `field${field}`),
    ])
    assert.strictEqual(
      fieldType(paddingFields.at(0) ?? unreachable('expected padding marker')),
      'i32',
    )
    for (let field = 0; field < 513; field += 1) {
      const type = fieldType(paddingFields.at(field + 1) ?? unreachable('expected padding field'))
      if (!Type.isFixedArray(type)) return unreachable('expected distinct array type')
      assert.strictEqual(type.element, 'u8')
      assert.strictEqual(type.length, field)
    }
    const frame = struct('Frame')
    assert.deepEqual(frame.fields.map(spelling), ['value'])
    assert.strictEqual(fieldType(frame.fields.at(0) ?? unreachable('expected frame value')), 'i32')
    const frameArguments = (key: Instances.InstanceKey): boolean =>
      key.typeArguments.map(Type.encodeGenericArgument).join(', ') === 'golden/program.Frame'
    const slotCall =
      result.instances.executionEdges.find((edge) => {
        const payload = edge.owner.typeArguments.at(0)
        return (
          edge.kind === 'Runtime' &&
          edge.owner.declaration.module === 'silk/vector' &&
          edge.owner.declaration.name === 'releaseBuffer' &&
          payload !== undefined &&
          Type.isTypeArgument(payload) &&
          Type.isNominal(payload) &&
          payload.module === 'golden/program' &&
          payload.name === 'Machine' &&
          edge.target.declaration.module === 'silk/slot' &&
          edge.target.declaration.name === 'Slot.dropValue'
        )
      }) ?? unreachable('expected releaseBuffer to call Slot.dropValue')
    const releasedPayload =
      slotCall.owner.typeArguments.at(0) ?? unreachable('expected owner payload')
    const storage = slotCall.target.typeArguments.at(0) ?? unreachable('expected storage lifetime')
    const slotPayload = slotCall.target.typeArguments.at(1) ?? unreachable('expected slot payload')
    if (!Lifetime.isLifetime(storage)) return unreachable('expected storage lifetime argument')
    if (!Type.isTypeArgument(releasedPayload) || !Type.isTypeArgument(slotPayload))
      return unreachable('expected ordinary payload arguments')
    assert.strictEqual(slotCall.target.typeArguments.length, 2)
    assert.strictEqual(Type.key(slotPayload), Type.key(releasedPayload))
    const sameSlotArguments = (key: Instances.InstanceKey): boolean => {
      const lifetime = key.typeArguments.at(0)
      const payload = key.typeArguments.at(1)
      return (
        key.typeArguments.length === 2 &&
        lifetime !== undefined &&
        Lifetime.isLifetime(lifetime) &&
        Lifetime.key(lifetime) === Lifetime.key(storage) &&
        payload !== undefined &&
        Type.isTypeArgument(payload) &&
        Type.key(payload) === Type.key(slotPayload)
      )
    }
    const slotOwner = { module: 'silk/slot', name: 'Slot.dropValue' }
    const slotFact = DeclarationFacts.byCanonical(index, slotCall.target.declaration)
    if (slotFact?._tag !== 'FunctionDeclaration') return unreachable('expected slot declaration')
    assert.deepEqual(
      slotFact.typeParameters.map(({ type }) => ({
        owner: type.owner,
        ordinal: type.ordinal,
        kind: type.kind,
      })),
      [
        { owner: slotOwner, ordinal: 0, kind: 'Lifetime' },
        { owner: slotOwner, ordinal: 1, kind: 'Value' },
      ],
    )
    const slotParameter = slotFact.parameters.at(0) ?? unreachable('expected slot parameter')
    if (slotParameter.declaredType._tag !== 'Resolved')
      return unreachable('expected resolved slot parameter')
    const declaredSlot = slotParameter.declaredType.type
    if (!Type.isSlot(declaredSlot)) return unreachable('expected declared slot type')
    assert.strictEqual(
      Lifetime.key(declaredSlot.arguments[0]),
      Lifetime.key(Lifetime.bound(slotOwner, 0, 'storage')),
    )
    const declaredPayload = declaredSlot.arguments[1]
    if (!Type.isParameter(declaredPayload)) return unreachable('expected declared payload binder')
    assert.deepEqual(
      {
        owner: declaredPayload.owner,
        ordinal: declaredPayload.ordinal,
        kind: declaredPayload.kind,
      },
      { owner: slotOwner, ordinal: 1, kind: 'Value' },
    )
    const slotInstance =
      result.instances.instances.find(
        (instance) =>
          Instances.keyText(instance.key) === Instances.keyText(slotCall.target) &&
          sameSlotArguments(instance.key),
      ) ?? unreachable('expected recorded slot instance')
    const specializedSlot = Type.substitute(declaredSlot, slotInstance.substitution)
    if (!Type.isSlot(specializedSlot)) return unreachable('expected specialized slot type')
    assert.strictEqual(Lifetime.key(specializedSlot.arguments[0]), Lifetime.key(storage))
    assert.strictEqual(Type.key(specializedSlot.arguments[1]), Type.key(slotPayload))
    assert.isTrue(
      result.instances.executionEdges.some(
        (edge) =>
          edge.kind === 'Cleanup' &&
          Instances.keyText(edge.owner) === Instances.keyText(slotCall.target) &&
          sameSlotArguments(edge.owner) &&
          edge.target.declaration.module === 'silk/vector' &&
          edge.target.declaration.name === 'drop@impl#0' &&
          frameArguments(edge.target),
      ),
    )
    for (const [owner, target] of [
      ['drop@impl#0', 'releaseFull'],
      ['releaseFull', 'releaseBuffer'],
    ]) {
      assert.isTrue(
        result.instances.executionEdges.some(
          (edge) =>
            edge.kind === 'Runtime' &&
            edge.owner.declaration.module === 'silk/vector' &&
            edge.owner.declaration.name === owner &&
            frameArguments(edge.owner) &&
            edge.target.declaration.module === 'silk/vector' &&
            edge.target.declaration.name === target &&
            frameArguments(edge.target),
        ),
      )
    }
  }),
)

it.effect('shares cleanup subterm answers across unfoldings of unreachable declarations', () =>
  Effect.gen(function* () {
    // Each hub offers two instantiations of its layer, and every layer borrows the next hub, so the
    // path to hub j has unfolded one of 2^(j-1) layer combinations above it. None of those
    // declarations is reachable below the hub, so the answer there cannot depend on them.
    // Borrowed Shared edges keep the structural unfolding without per-path affinity derivation.
    const depth = 24
    const hubs = Array.from({ length: depth }, (_, index) => {
      const level = index + 1
      if (level === depth) return `struct Hub${level}<'a> { marker: &'a i32 }`
      return `struct Hub${level}<'a> {
  first: Layer${level}<'a, i32>
  second: Layer${level}<'a, u8>
}
struct Layer${level}<'a, T> {
  value: T
  next: &'a Shared<Hub${level + 1}<'a>>
}`
    }).join('\n')
    // Distinct scalar fields keep the graph beyond the reachability-pruning budget.
    const padding = Array.from(
      { length: 513 },
      (_, field) => `  field${field}: [u8; ${field}]`,
    ).join('\n')
    const result = yield* snapshot(`import silk.vector { Vector }
import silk.shared { Shared }
${hubs}
struct Padding {
  marker: i32
${padding}
}
struct Frame { value: i32 }
struct Holder { active: Vector<Frame> }
struct Machine<'a> {
  padding: Padding
  layers: &'a Shared<Hub1<'a>>
  holder: Holder
}
fn hold<'a>(anchor: &'a i32) -> () {
  let machines = Vector.make<Machine<'a>>()
  drop machines
  return ()
}
pub fn main() -> () {
  let anchor = 0
  hold(&anchor)
  return ()
}`)
    assert.deepEqual(Analysis.diagnostics(result), [])
    assert.deepEqual(result.instances.violations, [])
    assert.isTrue(
      result.instances.instances.some(
        (instance) =>
          instance.key.declaration.module === 'silk/vector' &&
          instance.key.declaration.name === 'drop@impl#0' &&
          instance.key.typeArguments.map(Type.encodeGenericArgument).join(', ') ===
            'golden/program.Frame',
      ),
    )
  }),
)

it.effect('admits nested cleanup reached through a lexical service provider', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`import silk.effect { Effect }
import silk.vector { Vector }
struct Inner { value: i32 }
struct Leaf { inner: Vector<Inner> }
struct Owner { leaves: Vector<Leaf> }
service Source { effect fn load() -> Owner ? &mut Source }
struct Provider {}
impl Provider {
  effect fn load(self: &mut Self) -> Owner {
    return Owner { leaves: Vector.make<Leaf>() }
  }
}
impl Source for Provider { load: Provider.load }
effect fn program() -> i32 {
  let mut provider = Provider {}
  let owner = run Source.load() |> Effect.provideMut<Source>(&mut provider)
  drop owner
  return 42
}
pub fn main() -> i32 { return run program() }`)
    assert.deepEqual(Analysis.diagnostics(result), [])
    assert.deepEqual(Analysis.instancesOf(result).violations, [])
  }),
)

it.effect('rejects unrelated polymorphic recursion inside a lexical service provider', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`import silk.effect { Effect }
service Source { effect fn load() -> i32 ? &mut Source }
struct Provider<T> {}
fn expand<T>() -> i32 { return expand<[T; 1]>() }
impl<T> Source for Provider<T> {
  effect fn load(self: &mut Self) -> i32 { return expand<T>() }
}
pub fn main() -> i32 {
  let mut provider = Provider<i32> {}
  return run Source.load() |> Effect.provideMut<Source>(&mut provider)
}`)
    assert.deepEqual(
      Analysis.diagnostics(result).map((diagnostic) => diagnostic.code),
      ['SEM0053'],
    )
    assert.strictEqual(result.instances.violations.length, 1)
    assert.deepEqual(
      result.instances.violations.at(0)?.target.typeArguments.map(Type.encodeGenericArgument),
      ['Array<i32, 1>'],
    )
  }),
)

it.effect('admits nested generic calls that select distinct finite provider bodies', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`fn demand<T>(value: T, provide: once fn(T) -> i32) -> i32 {
  return provide(move value)
}
fn inner(value: bool) -> i32 { return 1 }
fn outer(value: i32) -> i32 { return demand<bool>(true, inner) }
pub fn main() -> i32 { return demand<i32>(0, outer) }`)
    assert.deepEqual(Analysis.diagnostics(result), [])
    assert.deepEqual(result.instances.violations, [])
    assert.deepEqual(
      result.instances.instances
        .filter((instance) => instance.key.declaration.name === 'demand')
        .map((instance) =>
          Type.encodeGenericArgument(
            instance.key.typeArguments.at(0) ?? unreachable('expected demand value type'),
          ),
        )
        .sort(),
      ['bool', 'i32'],
    )
  }),
)

it.effect('rejects type growth across alternating provider bodies', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`fn demand<T>(value: T, provide: once fn(T) -> i32) -> i32 {
  return provide(move value)
}
fn left<T>(value: T) -> i32 {
  return demand<[T; 1]>([move value], fn(next: [T; 1]) -> i32 {
    return right<[T; 1]>(move next)
  })
}
fn right<T>(value: T) -> i32 {
  return demand<[T; 1]>([move value], fn(next: [T; 1]) -> i32 {
    return left<[T; 1]>(move next)
  })
}
pub fn main() -> i32 { return left<i32>(0) }`)
    assert.deepEqual(
      Analysis.diagnostics(result).map((diagnostic) => diagnostic.code),
      ['SEM0053'],
    )
    assert.strictEqual(result.instances.violations.length, 1)
  }),
)

it.effect('rejects hidden callable identity growth reached through cleanup', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`struct Guard {}
fn invoke(value: i32, callback: once fn(i32) -> i32) -> i32 { return callback(value) }
fn loop(seed: i32, callback: once fn(i32) -> i32) -> i32 {
  let wrapped = invoke(move callback)
  let next = loop(move wrapped)
  return next(seed)
}
fn identity(value: i32) -> i32 { return value }
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    let call = loop(identity)
    let value = call(0)
    return ()
  }
}
pub fn main() -> i32 {
  let held = Guard {}
  drop held
  return 0
}`)
    assert.deepEqual(
      Analysis.diagnostics(result).map((diagnostic) => diagnostic.code),
      ['SEM0053'],
    )
    assert.strictEqual(result.instances.violations.length, 1)
  }),
)

it.effect('keeps composite Effect representations guarded at a terminal cleanup callable', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`struct First {}
struct Second {}
struct Guard {}

fn initial(input: First | Second) -> Effect<'static; i32> {
  return match move input {
    First {} => effect { return 1 }
    Second {} => effect { return 2 }
  }
}

fn recursive(input: First | Second) -> Effect<'static; i32> {
  return match move input {
    First {} => effect { return 3 }
    Second {} => effect { return 4 }
  }
}

fn identity(value: i32) -> i32 { return value }

fn loop(
  operation: once Effect<'static; i32>,
  callback: once fn<'static>(i32) -> i32
) -> i32 {
  return loop(recursive(First {}), identity)
}

impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    let value = loop(initial(First {}), identity)
    return ()
  }
}

pub fn main() -> i32 {
  let held = Guard {}
  drop held
  return 0
}`)
    assert.deepEqual(
      Analysis.diagnostics(result).map((diagnostic) => diagnostic.code),
      ['SEM0053'],
    )
    assert.strictEqual(result.instances.violations.length, 1)
  }),
)

it.effect('rejects mutually recursive cleanup specialization growth', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`import silk.box { Box }
import silk.vector { Vector }
struct Left<T> { next: Box<Right<Box<T>>> }
struct Right<T> { next: Box<Left<Box<T>>> }
pub fn main() -> i32 {
  let held = Vector.make<Left<i32>>()
  return 0
}`)
    assert.deepEqual(
      Analysis.diagnostics(result).map((diagnostic) => diagnostic.code),
      ['SEM0053'],
    )
    assert.strictEqual(result.instances.violations.length, 1)
  }),
)

it.effect('admits repeated nominal cleanup at a smaller instantiation', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`import silk.box { Box }
import silk.vector { Vector }
struct Outer<T> { next: Box<Middle<T>> }
struct Middle<T> { next: Box<T> }
pub fn main() -> i32 {
  let held = Vector.make<Outer<Outer<i32>>>()
  return 0
}`)
    assert.deepEqual(Analysis.diagnostics(result), [])
    assert.deepEqual(Analysis.instancesOf(result).violations, [])
  }),
)

it.effect('answers each cleanup subterm question independently of other roots', () =>
  Effect.gen(function* () {
    // Each owner exercises one unfolding-guard branch: `Node` repeats its own type, `Bad` and the
    // `Left`/`Right` pair recurse without descending, `Outer` descends, and `Fork` reaches one
    // owner through two fields. No answer may depend on which other root's questions came first,
    // so one discovery of every owner equals the union of the separate discoveries.
    const declarations = `import silk.box { Box }
import silk.option { Option }
import silk.vector { Vector }
struct Node { value: i32 next: Option<Box<Node>> }
struct Bad<T> { next: Option<Box<Bad<Box<T>>>> }
struct Left<T> { next: Box<Right<Box<T>>> }
struct Right<T> { next: Box<Left<Box<T>>> }
struct Outer<T> { next: Box<Middle<T>> }
struct Middle<T> { next: Box<T> }
struct Leaf { nodes: Vector<Node> }
struct Fork { first: Box<Leaf> second: Vector<Leaf> }
`
    const owners = [
      { owner: 'Node', codes: [] },
      { owner: 'Bad<i32>', codes: ['SEM0053'] },
      { owner: 'Left<i32>', codes: ['SEM0053'] },
      { owner: 'Outer<Outer<i32>>', codes: [] },
      { owner: 'Fork', codes: [] },
    ]
    const program = (held: ReadonlyArray<string>) =>
      snapshot(`${declarations}pub fn main() -> i32 {
${held.map((owner, ordinal) => `  let held${ordinal} = Vector.make<${owner}>()`).join('\n')}
  return 0
}`)
    const keys = (result: Analysis.Snapshot): ReadonlyArray<string> =>
      result.instances.instances
        .filter((instance) => instance.key.declaration.name !== 'main')
        .map((instance) => Instances.keyText(instance.key))
    const violations = (result: Analysis.Snapshot): ReadonlyArray<string> =>
      result.instances.violations.map(
        (violation) =>
          `${Instances.keyText(violation.caller)}\u0005${Instances.keyText(violation.target)}`,
      )
    const codes = (result: Analysis.Snapshot): ReadonlyArray<string> =>
      Analysis.diagnostics(result).map((diagnostic) => diagnostic.code)
    const union = (lists: ReadonlyArray<ReadonlyArray<string>>): Array<string> =>
      [...new Set(lists.flat())].sort()
    const separate: Array<Analysis.Snapshot> = []
    for (const { owner, codes: expected } of owners) {
      const result = yield* program([owner])
      assert.deepEqual(codes(result), expected, owner)
      separate.push(result)
    }
    const combined = yield* program(owners.map(({ owner }) => owner))
    assert.deepEqual(union([codes(combined)]), union(separate.map(codes)))
    assert.deepEqual([...violations(combined)].sort(), union(separate.map(violations)))
    assert.deepEqual([...keys(combined)].sort(), union(separate.map(keys)))
  }),
)

it.effect('erases nested lifetimes while one cleanup type position descends', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`import silk.box { Box }
import silk.option { Option }
struct Outer<T> { value: T }
struct Chain<'a, A, Whole, Part> {
  anchor: &'a i32
  marker: A
  whole: Whole
  part: Part
  next: Option<Box<Chain<'a, &'a i32, Part, Part>>>
}
impl<'a, A, Whole, Part> Drop for Chain<'a, A, Whole, Part> {
  fn drop(self: &mut Chain<'a, A, Whole, Part>) -> () { return () }
}
fn make<'a, 'b>(left: &'a i32, right: &'b i32)
  -> Chain<'a, &'b i32, Outer<i32>, i32> {
  return Chain {
    anchor: left,
    marker: right,
    whole: Outer { value: 1 },
    part: 2,
    next: Option.none<Box<Chain<'a, &'a i32, i32, i32>>>()
  }
}
pub fn main() -> i32 {
  let left = 1
  let right = 2
  let held = make(&left, &right)
  drop held
  return 0
}`)
    assert.deepEqual(Analysis.diagnostics(result), [])
    assert.deepEqual(Analysis.instancesOf(result).violations, [])
  }),
)

it.effect('lowers discovered instances deterministically to verifier-clean MIR', () =>
  Effect.gen(function* () {
    const program = Analysis.loweredMir(yield* snapshot(nestedSource))
    const original = program.functions.at(0) ?? unreachable('expected main function')
    const generic: Mir.MirFunction = {
      ...original,
      instance: { ...original.instance, typeArguments: ['bool'] },
    }
    const specialized: Mir.MirFunction = {
      ...original,
      instance: {
        ...original.instance,
        staticArguments: [{ _tag: 'IntegerValue', type: 'i32', value: 42n }],
      },
    }
    const otherModule: Mir.MirFunction = {
      ...original,
      id: { ...original.id, module: 'other' },
    }
    const duplicate = { ...original }
    const functions = [original, generic, specialized, otherModule, duplicate]
    const index = FunctionIndex.make(functions, (fn) => fn.id)
    assert.deepEqual(FunctionIndex.candidates(index, original.id), [
      original,
      generic,
      specialized,
      duplicate,
    ])
    for (const fn of functions) {
      const matches = (candidate: Mir.MirFunction) =>
        Mir.matchesInstance(
          candidate,
          fn.id,
          fn.instance.typeArguments,
          fn.instance.staticArguments,
        )
      assert.strictEqual(
        FunctionIndex.candidates(index, fn.id).find(matches),
        functions.find(matches),
      )
      assert.deepEqual(
        FunctionIndex.mirInstances(
          index,
          fn.id,
          fn.instance.typeArguments,
          fn.instance.staticArguments,
        ),
        functions.filter(matches),
      )
    }
    assert.deepEqual(FunctionIndex.mirInstances(index, original.id, ['i32']), [])
    assert.deepEqual(FunctionIndex.mirInstances(index, { ...original.id, name: 'missing' }, []), [])
    assert.deepEqual(FunctionIndex.candidates(index, { ...original.id, name: 'missing' }), [])
    assert.strictEqual(
      FunctionIndex.candidates(index, original.id).find((fn) =>
        Mir.matchesInstance(fn, original.id, ['i32']),
      ),
      undefined,
    )
    assert.strictEqual(MirEncoding.encode(program), golden('lowered.mir.txt'))
  }),
)

it.effect('lowers callable construction and application into the structured MIR DAG', () =>
  Effect.gen(function* () {
    const stored = Analysis.loweredMir(
      yield* snapshot(`fn add(left: i32, right: i32) -> i32 { return left + right }
pub fn main() -> i32 { let plusTwo = add(2) return plusTwo(40) }`),
    )
    const direct = Analysis.loweredMir(
      yield* snapshot(`fn add(left: i32, right: i32) -> i32 { return left + right }
pub fn main() -> i32 { return 40 |> add(2) }`),
    )
    const storedOperations = stored.functions.at(0)
    const directOperations = direct.functions.at(0)
    assert.deepEqual(yield* MirVerification.verify(stored), [])
    assert.deepEqual(yield* MirVerification.verify(direct), [])
    assert.deepEqual(
      storedOperations === undefined
        ? []
        : MirVerification.operations(storedOperations).map((operation) => operation._tag),
      ['Literal', 'MakeCallable', 'Move', 'Literal', 'ApplyCallable', 'Drop'],
    )
    assert.deepEqual(
      directOperations === undefined
        ? []
        : MirVerification.operations(directOperations).map((operation) => operation._tag),
      ['Literal', 'Literal', 'ApplyCallable'],
    )
    const applied =
      directOperations === undefined
        ? undefined
        : MirVerification.operations(directOperations).find(
            (operation) => operation._tag === 'ApplyCallable',
          )
    assert.strictEqual(
      applied?._tag === 'ApplyCallable' ? applied.realization : undefined,
      'DirectErasedSection',
    )
    assert.strictEqual(
      applied?._tag === 'ApplyCallable' ? applied.evaluation : undefined,
      'LeftThenCallable',
    )
    const malformed: Mir.Module = Object.freeze({
      ...stored,
      functions: Object.freeze(
        stored.functions.map((fn, ordinal) => {
          if (ordinal !== 0) return fn
          return Object.freeze({
            ...fn,
            regions: Object.freeze(
              fn.regions.map((region) => {
                if (region._tag !== 'OperationRegion') return region
                return Object.freeze({
                  ...region,
                  operations: Object.freeze(
                    region.operations.map((operation): Mir.Operation => {
                      if (operation._tag !== 'ApplyCallable') return operation
                      return Object.freeze({ ...operation, access: 'Take' })
                    }),
                  ),
                })
              }),
            ),
          })
        }),
      ),
    })
    assert.include(
      (yield* MirVerification.verify(malformed)).map((violation) => violation.rule),
      'InvalidCallableOperation',
    )
  }),
)

it.effect('retains canonical hidden anonymous targets and exact capture ordinals', () =>
  Effect.gen(function* () {
    const source = `struct Token { value: i32 }
fn consume(value: i32, token: Token) -> i32 { return value + token.value }
pub fn main() -> i32 {
  let copied = 1
  let owned = Token { value: 40 }
  let first = fn(value: i32) -> i32 { return value }
  let second = fn(value: i32) -> i32 { return value }
  let combined = fn(value: i32) -> i32 { return consume(value + copied, move owned) }
  return combined(1)
}`
    const analysis = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(analysis), [])

    const tir = Analysis.rootAnalysis(analysis).tir
    const hiddenNames = (tir: Tir.Module) =>
      tir.functions.flatMap((fn) =>
        fn.declaration.canonical._tag === 'Canonical' &&
        fn.declaration.canonical.id.name.includes('$callable$')
          ? [fn.declaration.canonical.id.name]
          : [],
      )
    assert.deepEqual(hiddenNames(tir), ['main$callable$0', 'main$callable$1', 'main$callable$2'])

    const main = tir.functions.find(
      (fn) =>
        fn.declaration.canonical._tag === 'Canonical' &&
        fn.declaration.canonical.id.name === 'main',
    )
    const sections =
      main === undefined
        ? []
        : main.statements
            .flatMap(Tir.statementExpressions)
            .flatMap(Tir.expressionTree)
            .filter(
              (
                expression,
              ): expression is Extract<
                Tir.Expression,
                {
                  readonly _tag: 'CallableSection'
                }
              > => expression._tag === 'CallableSection',
            )
    assert.deepEqual(
      sections.map((section) => ({
        site: Tir.executableSiteOrdinal(section.site),
        target:
          section.target._tag === 'DeclarationCallableTarget'
            ? section.target.declaration.name
            : section.target.operation,
        remaining: section.remainingParameters,
        mode: section.mode,
        captures: section.captures.map((capture) => ({
          ordinal: capture.ordinal,
          parameterOrdinal: capture.parameterOrdinal,
          access: capture.access,
          expression: capture.value._tag,
        })),
      })),
      [
        {
          site: 0,
          target: 'main$callable$0',
          remaining: [0],
          mode: 'Shared',
          captures: [],
        },
        {
          site: 1,
          target: 'main$callable$1',
          remaining: [0],
          mode: 'Shared',
          captures: [],
        },
        {
          site: 2,
          target: 'main$callable$2',
          remaining: [0],
          mode: 'Take',
          captures: [
            { ordinal: 0, parameterOrdinal: 1, access: 'Copy', expression: 'BindingReference' },
            { ordinal: 1, parameterOrdinal: 2, access: 'Take', expression: 'Move' },
          ],
        },
      ],
    )

    const hidden = tir.functions.find(
      (fn) =>
        fn.declaration.canonical._tag === 'Canonical' &&
        fn.declaration.canonical.id.name === 'main$callable$2',
    )
    assert.deepEqual(
      hidden?.declaration.parameters.map((parameter) => ({
        ordinal: parameter.id.ordinal,
        name: parameter.name._tag === 'Present' ? parameter.name.spelling : '_',
      })),
      [
        { ordinal: 0, name: 'value' },
        { ordinal: 1, name: 'copied' },
        { ordinal: 2, name: 'owned' },
      ],
    )
    assert.strictEqual(hidden?.contract._tag, 'Contract')
    if (hidden?.contract._tag !== 'Contract') return
    assert.deepEqual(hidden.contract.parameters.map(Type.encode), [
      'i32',
      'i32',
      'golden/program.Token',
    ])
    assert.strictEqual(Type.encode(hidden.contract.result), 'i32')

    const mir = Analysis.loweredMir(analysis)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const mainMir = mir.functions.find((fn) => fn.id.name === 'main')
    assert.isDefined(mainMir)
    if (mainMir === undefined) return
    const operations = MirVerification.operations(mainMir)
    const constructions = operations.filter(
      (
        operation,
      ): operation is Extract<
        Mir.Operation,
        {
          readonly _tag: 'MakeCallable'
        }
      > => operation._tag === 'MakeCallable',
    )
    assert.deepEqual(
      constructions.map((operation) => ({
        target:
          operation.target._tag === 'DeclarationCallableTarget'
            ? operation.target.declaration.name
            : operation.target.operation,
        captures: operation.captures.map(({ ordinal, parameterOrdinal, access }) => ({
          ordinal,
          parameterOrdinal,
          access,
        })),
        fields:
          operation.type.environment?.fields.map(({ ordinal, parameterOrdinal, access }) => ({
            ordinal,
            parameterOrdinal,
            access,
          })) ?? [],
      })),
      [
        { target: 'main$callable$0', captures: [], fields: [] },
        { target: 'main$callable$1', captures: [], fields: [] },
        {
          target: 'main$callable$2',
          captures: [
            { ordinal: 0, parameterOrdinal: 1, access: 'Copy' },
            { ordinal: 1, parameterOrdinal: 2, access: 'Take' },
          ],
          fields: [
            { ordinal: 0, parameterOrdinal: 1, access: 'Copy' },
            { ordinal: 1, parameterOrdinal: 2, access: 'Take' },
          ],
        },
      ],
    )
    const applied = operations.find((operation) => operation._tag === 'ApplyCallable')
    assert.deepEqual(
      applied?._tag === 'ApplyCallable'
        ? { access: applied.access, realization: applied.realization, captures: applied.captures }
        : undefined,
      { access: 'Take', realization: 'Environment', captures: [] },
    )
    const callableDrops = operations.flatMap((operation) => {
      if (operation._tag !== 'Drop') return []
      const type = mainMir.localTypes.at(operation.local.ordinal)
      return type?._tag === 'CallableValue' && type.target._tag === 'DeclarationCallableTarget'
        ? [type.target.declaration.name]
        : []
    })
    assert.deepEqual(callableDrops, ['main$callable$1', 'main$callable$0'])
    assert.notInclude(callableDrops, 'main$callable$2')
  }),
)

it.effect('ends callable capture loans before drop and transfers consuming captures once', () =>
  Effect.gen(function* () {
    const borrowed = Analysis.loweredMir(
      yield* snapshot(`fn read(value: i32, values: &mut [i32]) -> i32 { return value }
pub fn main() -> i32 {
  let mut values: [i32; 1] = [1]
  let callback = read(&mut values)
  drop callback
  values[0] = 2
  return values[0]
}`),
    )
    const consumed = Analysis.loweredMir(
      yield* snapshot(`struct Token { value: i32 }
fn consume(value: i32, token: Token) -> i32 { return value + token.value }
pub fn main() -> i32 {
  let token = Token { value: 2 }
  let callback = consume(move token)
  return callback(40)
}`),
    )
    const borrowedMain = borrowed.functions.at(0)
    const consumedMain = consumed.functions.at(0)
    const borrowedTags =
      borrowedMain === undefined
        ? []
        : MirVerification.operations(borrowedMain).map((operation) => operation._tag)
    const consumedTags =
      consumedMain === undefined
        ? []
        : MirVerification.operations(consumedMain).map((operation) => operation._tag)
    assert.deepEqual(yield* MirVerification.verify(borrowed), [])
    assert.deepEqual(yield* MirVerification.verify(consumed), [])
    assert.ok(borrowedTags.indexOf('BeginLoan') < borrowedTags.indexOf('MakeCallable'))
    assert.ok(borrowedTags.indexOf('MakeCallable') < borrowedTags.indexOf('EndLoan'))
    assert.ok(borrowedTags.indexOf('EndLoan') < borrowedTags.indexOf('Drop'))
    assert.include(consumedTags, 'ApplyCallable')
    assert.strictEqual(consumedTags.filter((tag) => tag === 'ApplyCallable').length, 1)
    assert.strictEqual(consumedTags.includes('Drop'), false)
  }),
)

it.effect(
  'lowers complete ungrouped run operands before grouped post-run callable transforms',
  () =>
    Effect.gen(function* () {
      const composedSnapshot = yield* snapshot(`effect fn work() -> i32 { return 41 }
effect<'env> fn offset<'env>(self: Effect<'env; i32>, amount: i32) -> i32 {
  let value = run self
  return value + amount
}
pub fn main() -> i32 { return run work() |> offset(1) }`)
      assert.deepEqual(Analysis.diagnostics(composedSnapshot), [])
      const composed = Analysis.loweredMir(composedSnapshot)
      const grouped = Analysis.loweredMir(
        yield* snapshot(`effect fn work() -> i32 { return 41 }
pub fn main() -> i32 { return (run work()) |> Intrinsic.i32Add(1) }`),
      )
      const composedMain = composed.functions.at(0)
      const groupedMain = grouped.functions.at(0)
      assert.deepEqual(yield* MirVerification.verify(composed), [])
      assert.deepEqual(yield* MirVerification.verify(grouped), [])
      assert.include(
        composedMain === undefined
          ? []
          : MirVerification.operations(composedMain).map((operation) => operation._tag),
        'RunStaticEffect',
      )
      assert.strictEqual(
        groupedMain === undefined
          ? undefined
          : MirVerification.operations(groupedMain).at(-1)?._tag,
        'ApplyCallable',
      )
    }),
)

it.effect('encodes generic, consuming, and grouped-run callable MIR', () =>
  Effect.gen(function* () {
    const sources = [
      `fn select<T>(value: T, enabled: bool) -> T { return move value }
pub fn main() -> i32 { let whenEnabled = select(true) return whenEnabled(42) }`,
      `struct Token { value: i32 }
fn consume(value: i32, token: Token) -> i32 { return value + token.value }
pub fn main() -> i32 {
  let token = Token { value: 2 }
  let callback = consume(move token)
  return callback(40)
}`,
      `effect fn work() -> i32 { return 41 }
pub fn main() -> i32 { return (run work()) |> Intrinsic.i32Add(1) }`,
    ]
    for (const source of sources) {
      const mir = Analysis.loweredMir(yield* snapshot(source))
      assert.deepEqual(yield* MirVerification.verify(mir), [])
      const encoded = MirEncoding.encode(mir)
      assert.include(encoded, 'apply-callable')
      if (source === sources.at(0)) assert.strictEqual(encoded, golden('generic.mir.txt'))
    }
  }),
)

const bindingSource = `pub fn identity(value: i32) -> i32 { return value }
pub fn main() -> i32 { let value = identity(42) let extra = 1 return value }`

const nestedMatchSource = `pub struct Token { kind: i32 }
pub struct Box { token: Token }
pub fn adjust(value: i32) -> i32 { return value + 1 }
pub fn main() -> i32 {
  let boxed = Box { token: Token { kind: 41 } }
  return match move boxed {
    Box { token } => match move token {
      Token { kind: answer } => adjust(answer)
    }
  }
}`

it.effect('lowers binding cleanup and rejects ownership violations during analysis', () =>
  Effect.gen(function* () {
    const bindings = Analysis.loweredMir(yield* snapshot(bindingSource))
    const bindingFunction = bindings.functions.at(0)
    assert.deepEqual(yield* MirVerification.verify(bindings), [])
    assert.strictEqual(MirEncoding.encode(bindings), golden('bindings.mir.txt'))
    assert.deepEqual(
      bindingFunction === undefined
        ? []
        : MirVerification.operations(bindingFunction).map((operation) => operation._tag),
      ['Literal', 'Call', 'Move', 'Literal', 'Move', 'Move', 'Drop', 'Drop'],
    )

    const source = `pub fn choose(left: i32, right: i32) -> i32 { return right }
pub fn main() -> i32 { let value = 42 return choose(move value, value) }`
    const violated = yield* Analysis.ofSource('ownership/violated-call', ascii(source))
    assert.deepEqual(
      Analysis.diagnostics(violated).map((diagnostic) => ({
        code: diagnostic.code,
        span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [{ code: 'OWN0001', span: 'value' }],
    )
  }),
)

it.effect('lowers built-ins and leaves diagnosed bodies unavailable to MIR', () =>
  Effect.gen(function* () {
    const builtins = Analysis.loweredMir(
      yield* snapshot(
        'pub fn main() -> i32 { return Intrinsic.i32Subtract(Intrinsic.i32Multiply(6, 7), 0) }',
      ),
    )
    const builtinFunction = builtins.functions.at(0)
    assert.deepEqual(
      builtinFunction === undefined
        ? []
        : MirVerification.operations(builtinFunction).map((operation) => {
            if (operation._tag === 'Binary') return `Binary:${operation.operator}`
            return operation._tag
          }),
      ['Literal', 'Literal', 'Binary:Multiply', 'Literal', 'Binary:Subtract'],
    )
    const source = 'pub fn main() -> i32 { return missing() }'
    const unavailable = yield* snapshot(source)
    assert.deepEqual(
      Analysis.diagnostics(unavailable).map((diagnostic) => ({
        code: diagnostic.code,
        span: source.slice(diagnostic.span.start, diagnostic.span.end),
      })),
      [{ code: 'SEM0004', span: 'missing' }],
    )
    assert.strictEqual(Analysis.mirOf(unavailable)._tag, 'Unavailable')
  }),
)

it.effect('materializes runtime reads of static local bindings', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`static fn amount(base: i32) -> i32 { return base * 10 + 1 }
fn constant() -> i32 { let static scaled = 42 return scaled }
fn withLocal(value: i32) -> i32 { let static scaled = amount(2) return scaled + value }
pub fn main() -> i32 { return constant() + withLocal(0) }`)
    assert.deepEqual(Analysis.diagnostics(result), [])
    const mir = Analysis.loweredMir(result)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const shape = (name: string) => {
      const fn = mir.functions.find((candidate) => candidate.id.name === name)
      return fn === undefined
        ? undefined
        : {
            operations: MirVerification.operations(fn).map((operation) => {
              if (operation._tag === 'Literal') return `Literal:${String(operation.value)}`
              if (operation._tag === 'Binary') return `Binary:${operation.operator}`
              return operation._tag
            }),
            outcomes: fn.regions.flatMap((region) =>
              region._tag === 'OperationRegion' ? [region.outcome._tag] : [],
            ),
          }
    }
    assert.deepEqual(shape('constant'), { operations: ['Literal:42'], outcomes: ['Return'] })
    assert.deepEqual(shape('withLocal'), {
      operations: ['Literal:21', 'Move', 'Binary:Add'],
      outcomes: ['Return'],
    })
    assert.deepEqual(
      mir.functions.map((fn) => fn.id.name),
      ['main', 'constant', 'withLocal'],
    )
  }),
)

it.effect('discovers calls and lowers nested matches as structured acyclic operations', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(nestedMatchSource)
    assert.deepEqual(
      Analysis.diagnostics(result).map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [],
    )
    assert.deepEqual(
      Analysis.instancesOf(result).instances.map((instance) => instance.key.declaration.name),
      ['main', 'adjust'],
    )
    const mir = Analysis.loweredMir(result)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const main = mir.functions.find((fn) => fn.id.name === 'main')
    const matches =
      main === undefined
        ? []
        : MirVerification.operations(main).filter((operation) => operation._tag === 'Match')
    assert.strictEqual(matches.length, 2)
    const selected = matches.at(0)?.arms.at(0)?.selected.execution
    assert.strictEqual(
      selected === undefined ? undefined : Mir.executionOperations(selected).at(0)?._tag,
      'Match',
    )
    const outerMember = matches.at(0)?.decisions.at(0)?.member
    const innerMember = matches.at(1)?.decisions.at(0)?.member
    const outerType = outerMember === undefined ? undefined : Match.sourceType(outerMember)
    const innerType = innerMember === undefined ? undefined : Match.sourceType(innerMember)
    assert.strictEqual(
      outerType !== undefined && Type.isNominal(outerType) ? outerType.name : undefined,
      'Box',
    )
    assert.strictEqual(
      innerType !== undefined && Type.isNominal(innerType) ? innerType.name : undefined,
      'Token',
    )
    assert.strictEqual(MirEncoding.encode(mir), golden('match.mir.txt'))
    assert.strictEqual(
      MirEncoding.encode(mir),
      MirEncoding.encode(Analysis.loweredMir(yield* snapshot(nestedMatchSource))),
    )
  }),
)

it.effect('rejects hand-built match decisions before LLVM emission', () =>
  Effect.gen(function* () {
    const mir = Analysis.loweredMir(yield* snapshot(nestedMatchSource))
    let changed = false
    const malformed: Mir.Module = {
      ...mir,
      functions: mir.functions.map((fn) => ({
        ...fn,
        regions: fn.regions.map((region) =>
          region._tag !== 'OperationRegion'
            ? region
            : {
                ...region,
                operations: region.operations.map((operation) => {
                  if (changed || operation._tag !== 'Match') return operation
                  changed = true
                  return { ...operation, decisions: [] }
                }),
              },
        ),
      })),
    }

    assert.strictEqual(changed, true)
    assert.include(
      (yield* MirVerification.verify(malformed)).map((violation) => violation.rule),
      'InvalidMatchDecision',
    )
  }),
)

const branchProgram =
  'pub fn main() -> i32 { let base = 40 if base == 40 { let bonus = 2 return base + bonus } return 0 }'

it.effect('lowers branch diamonds to the committed MIR golden', () =>
  Effect.gen(function* () {
    const mir = Analysis.loweredMir(yield* snapshot(branchProgram))
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    assert.strictEqual(MirEncoding.encode(mir), golden('branch-program.mir.txt'))
  }),
)

it.effect('deduplicates definitionally different open rows after concrete specialization', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`struct First {}
struct Second {}
effect fn source() -> i32 ! First | Second { return 1 }
effect fn forward<A, E>(self: once Effect<A ! E>) -> A ! E { return run self }
pub fn main() -> i32 {
  let direct = forward<i32, First | Second>(source())
  let permuted = forward<i32, Second | First>(source())
  return 0
}`)

    assert.deepEqual(Analysis.diagnostics(result), [])
    const discovered = Analysis.instancesOf(result)
    const forwards = discovered.instances.filter(
      (instance) => instance.key.declaration.name === 'forward',
    )
    assert.strictEqual(forwards.length, 1)
    for (const instance of discovered.instances) {
      const failures = instance.specialization.failureRow
      const requirements = instance.specialization.requirementRow
      if (failures !== undefined)
        assert.strictEqual(Type.isRuntimeConcreteGenericArgument(Type.failureType(failures)), true)
      if (requirements !== undefined)
        assert.strictEqual(
          Type.isRuntimeConcreteGenericArgument({
            _tag: 'RequirementRowArgument',
            row: requirements,
          }),
          true,
        )
    }
  }),
)

it.effect('discovers an uncalled admitted C export after main on native and Wasm targets', () =>
  Effect.gen(function* () {
    const source = `export "C" fn silk_test_double_v1(value: i32) -> i32 { return value * 2 }
pub fn main() -> i32 { return 0 }`
    const native = Analysis.instancesOf(yield* snapshot(source))
    assert.deepEqual(
      native.instances.map((instance) => instance.key.declaration.name),
      ['main', 'silk_test_double_v1'],
    )
    assert.deepEqual(
      native.foreignExports.map((record) => [record.symbol, Instances.keyText(record.key)]),
      [
        [
          'silk_test_double_v1',
          Instances.keyText(
            native.instances.at(1)?.key ?? unreachable('expected the export instance'),
          ),
        ],
      ],
    )
    const wasm = Analysis.instancesOf(
      yield* AnalysisFixture.retainingMain(
        'golden/program',
        ascii(source),
        'wasm32-unknown-unknown',
      ),
    )
    assert.deepEqual(
      wasm.instances.map((instance) => instance.key.declaration.name),
      ['main', 'silk_test_double_v1'],
    )
  }),
)

it.effect('keys pointer instances by pointee and mutability without reaching the pointee', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`import silk.vector { Vector }
fn probe<T>(flag: bool) -> bool { return flag }
fn hold(value: *mut Vector<i32>) -> i32 { return 0 }
pub fn main() -> i32 {
  let first = probe<*const i32>(true)
  let second = probe<*mut i32>(true)
  let third = probe<*mut Vector<i32>>(true)
  return 0
}`)

    assert.deepEqual(Analysis.diagnostics(result), [])
    const discovery = Analysis.instancesOf(result)
    assert.deepEqual(
      discovery.instances.map((instance) => ({
        name: instance.key.declaration.name,
        arguments: instance.key.typeArguments.map(Type.encodeGenericArgument),
      })),
      [
        { name: 'main', arguments: [] },
        { name: 'probe', arguments: ['*const i32'] },
        { name: 'probe', arguments: ['*mut i32'] },
        { name: 'probe', arguments: ['*mut silk/vector.Vector<i32>'] },
      ],
    )
  }),
)

it.effect('shares runtime instances and layouts across distinct proven lifetime arguments', () =>
  Effect.gen(function* () {
    const result = yield* snapshot(`struct View<'a> { value: &'a i32 }
struct Exclusive<'a> { value: &'a mut i32 }
impl<'a> Drop for Exclusive<'a> { fn drop(self: &mut Exclusive<'a>) -> () { return () } }
fn guard<'a>(value: &'a mut i32) -> Exclusive<'a> { return Exclusive { value: move value } }
fn wrap<'a>(value: &'a i32) -> View<'a> { return View<'a> { value: value } }
fn reborrow<'a>(value: &'a i32) -> &'a i32 { return &value.* }
effect fn read<'a>(value: &'a i32) -> i32 { return value.* }
pub fn main() -> i32 {
  let mut left = 20
  let mut right = 22
  let first = wrap(&left)
  let second = wrap(&right)
  let firstValue = run read(reborrow(first.value))
  let secondValue = run read(reborrow(second.value))
  let exclusiveLeft = guard(&mut left)
  let exclusiveRight = guard(&mut right)
  drop exclusiveLeft drop exclusiveRight
  return firstValue + secondValue
}`)
    assert.deepEqual(Analysis.diagnostics(result), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(result)), [])
    const discovery = Analysis.instancesOf(result)
    assert.strictEqual(
      discovery.instances.filter((instance) => instance.key.declaration.name === 'read').length,
      1,
    )
    assert.strictEqual(
      discovery.instances.filter((instance) => instance.key.declaration.name === 'wrap').length,
      1,
    )
    assert.strictEqual(
      discovery.instances.filter((instance) => instance.key.declaration.name === 'reborrow').length,
      1,
    )
    assert.strictEqual(
      discovery.instances.filter((instance) => instance.key.declaration.name === 'guard').length,
      1,
    )
    const plan = Analysis.layoutOf(result)
    assert.strictEqual(plan._tag, 'Available')
    if (plan._tag !== 'Available') return
    const first = Type.reference(
      'Shared',
      'i32',
      Lifetime.bound({ module: 'test', name: 'one' }, 0, "'first"),
    )
    const second = Type.reference(
      'Shared',
      'i32',
      Lifetime.bound({ module: 'test', name: 'two' }, 0, "'second"),
    )
    assert.notStrictEqual(Type.key(first), Type.key(second))
    assert.isDefined(Layout.entry(plan.value, first))
    assert.strictEqual(Layout.entry(plan.value, first), Layout.entry(plan.value, second))
    const firstView = Type.nominal('golden/program', 'View', [first.lifetime])
    const secondView = Type.nominal('golden/program', 'View', [second.lifetime])
    assert.include(
      plan.value.entries.map((entry) => Type.runtimeKey(entry.type)),
      Type.runtimeKey(firstView),
    )
    assert.strictEqual(Layout.entry(plan.value, firstView), Layout.entry(plan.value, secondView))
    const firstExclusive = Type.nominal('golden/program', 'Exclusive', [first.lifetime])
    const secondExclusive = Type.nominal('golden/program', 'Exclusive', [second.lifetime])
    assert.isDefined(Layout.entry(plan.value, firstExclusive))
    assert.strictEqual(
      Layout.entry(plan.value, firstExclusive),
      Layout.entry(plan.value, secondExclusive),
    )
    const firstShape =
      Layout.callingShape(plan.value, first) ?? unreachable('missing first reference shape')
    const secondShape =
      Layout.callingShape(plan.value, second) ?? unreachable('missing second reference shape')
    assert(Type.equals(firstShape.type, first))
    assert(Type.equals(secondShape.type, second))
    assert.strictEqual(firstShape.tree, secondShape.tree)
    assert.strictEqual(firstShape.lanes, secondShape.lanes)
    const fn =
      Analysis.loweredMir(result).functions.find((fn) => fn.id.name === 'read') ??
      unreachable('missing read instance')
    const key = fn.instance
    const alternate = {
      ...fn,
      instance: {
        ...key,
        typeArguments: key.typeArguments.map((argument) =>
          Lifetime.isLifetime(argument) ? Lifetime.staticLifetime : argument,
        ),
      },
    }
    assert.strictEqual(Backend.symbolFor(fn), Backend.symbolFor(alternate))
  }),
)

it.effect('activates native requirements by declaration, selected module and artifact scope', () =>
  Effect.gen(function* () {
    const source = SourceFile.make(
      'requirements',
      ascii(`
module with Intrinsic.native(kind: "startup-object", name: "module")
unsafe extern "C" fn used() -> i32 as "used"
  with Intrinsic.foreign(memory: "none")
  with Intrinsic.native(kind: "library", name: "needed", linkage: "dynamic")
unsafe extern "C" fn unused() -> i32 as "unused"
  with Intrinsic.native(kind: "library", name: "unused")
unsafe extern "C" static data: i32 with Intrinsic.native(kind: "library", name: "data")
unsafe extern "C" static unusedData: i32 with Intrinsic.native(kind: "library", name: "unusedData")
static if false {
  module with Intrinsic.native(kind: "library", name: "inactive")
  import missing
}
export "C" fn value() -> i32 { unsafe { return used() + data } }
`),
    )
    const analysis = yield* Analysis.makeRealized({
      root: source.id,
      configuration: {
        profile: {
          target: 'x86_64-unknown-linux-gnu',
          artifact: 'object',
          runtime: { kind: 'none' },
        },
        composition: {
          runtimes: [],
          defaults: [],
          retention: [],
          requirements: [{ kind: 'prebuilt-object', name: 'artifact' }],
        },
      },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([source]).pipe(Layer.provideMerge(SourceResolver.empty)),
      ),
    )
    assert.deepEqual(Analysis.diagnostics(analysis), [])
    const plan = analysis.artifactPlan ?? unreachable('expected artifact plan')
    assert.deepEqual(plan.requirements.map((entry) => entry.name).sort(), [
      'artifact',
      'data',
      'module',
      'needed',
    ])
    assert.deepEqual(
      plan.requirements
        .flatMap((entry) => entry.contributions.map((fact) => fact.scope.kind))
        .sort(),
      ['artifact', 'declaration', 'declaration', 'module'],
    )
    assert.strictEqual(plan.sources.length, 1)
  }),
)

it.effect(
  'composes a selected source runtime with the application and private retention roots',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* Analysis.makeRealized({
        root: 'application',
        configuration: {
          profile: {
            target: 'aarch64-apple-darwin',
            artifact: 'static-archive',
            runtime: { kind: 'named', name: 'custom' },
            entry: { kind: 'none' },
          },
          composition: {
            defaults: [],
            runtimes: [
              { name: 'custom', module: 'runtime' },
              { name: 'unselected', module: 'missing' },
            ],
            retention: [{ module: 'capability', declaration: 'keep' }],
            requirements: [],
          },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make(
              'application',
              ascii('pub fn answer() -> i32 { return 42 } pub fn unused() -> i32 { return 9 }'),
            ),
          ]).pipe(
            Layer.provideMerge(
              SourceResolver.memory(
                new Map([
                  [
                    'runtime',
                    ascii(
                      'import Intrinsic.application\nexport "C" fn proxy() -> i32 as "proxy" { return application.answer() }',
                    ),
                  ],
                  [
                    'capability',
                    ascii('fn keep() -> i32 { return 7 } pub fn unused() -> i32 { return 0 }'),
                  ],
                ]),
              ),
            ),
          ),
        ),
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      assert.deepEqual(
        Analysis.modules(snapshot).map((module) => module.name),
        ['application', 'capability', 'runtime'],
      )
      const discovery = Analysis.instancesOf(snapshot)
      assert.deepEqual(
        discovery.instances.map((instance) => instance.key.declaration.name).sort(),
        ['answer', 'keep', 'proxy'],
      )
      const program = Analysis.loweredMir(snapshot)
      assert.deepEqual(yield* MirVerification.verify(program), [])
      assert.deepEqual(
        program.retainedRoots?.map((root) => root.declaration.name),
        ['keep'],
      )
      const artifact = yield* LlvmBackend.LlvmBackend.emit(program, {
        mode: 'release',
        verifyIr: true,
      })
      assert.match(artifact.ir, /@llvm.used = appending global \[1 x ptr\]/)
      assert.match(artifact.ir, /section "llvm.metadata"/)
      assert.deepEqual(
        artifact.foreignExports.map((entry) => entry.symbol),
        ['proxy'],
      )
      assert.notMatch(artifact.ir, /silk_main/)
    }),
)

it.effect('merges logical diamonds and reports all hard requirement origins', () =>
  Effect.gen(function* () {
    const profile = yield* CompilationProfile.decode({
      target: 'x86_64-unknown-linux-gnu',
      deployment: '12',
    })
    const a = yield* NativeRequirement.decode(
      {
        kind: 'library',
        name: 'dependency',
        minimumDeployment: '10',
        alternatives: ['first', 'second'],
      },
      { kind: 'module', module: 'a' },
      ConfigurationOrigin.literal('a'),
    )
    const b = yield* NativeRequirement.decode(
      {
        kind: 'library',
        name: 'dependency',
        maximumDeployment: '14',
        alternatives: ['second', 'third'],
      },
      { kind: 'module', module: 'b' },
      ConfigurationOrigin.literal('b'),
    )
    const merged = yield* NativeRequirement.merge([a, b, a], profile)
    assert.strictEqual(merged.length, 1)
    const requirement = merged[0] ?? unreachable('expected merged requirement')
    assert.deepEqual(requirement.alternatives, ['second'])
    assert.strictEqual(requirement.minimumDeployment, '10.0.0')
    assert.strictEqual(requirement.maximumDeployment, '14.0.0')
    assert.strictEqual(requirement.contributions.length, 2)
    const conflict = yield* Effect.flip(
      NativeRequirement.merge(
        [
          { ...a, linkage: 'static' },
          { ...b, linkage: 'dynamic' },
        ],
        profile,
      ),
    )
    assert.strictEqual(conflict.code, 'ConflictingBindings')
    assert.deepEqual(conflict.origins.map((origin) => origin.source).sort(), ['a', 'b'])
    const interval = yield* Effect.flip(
      NativeRequirement.merge([{ ...a, minimumDeployment: '15.0.0' }, b], profile),
    )
    assert.deepEqual(interval.origins.map((origin) => origin.source).sort(), ['a', 'b'])
    const rejected = yield* Effect.flip(
      NativeRequirementBinding.resolve(
        merged,
        [
          {
            kind: 'library',
            name: 'dependency',
            alternative: 'first',
            inputs: [{ _tag: 'Library', name: 'dependency', mode: 'Dynamic' }],
            origin: ConfigurationOrigin.literal('build'),
          },
        ],
        'loadable-module',
      ),
    )
    assert.deepEqual(rejected.origins.map((origin) => origin.source).sort(), ['a', 'b', 'build'])
    const unresolved = yield* NativeRequirementBinding.resolve(merged, [], 'object')
    assert.deepEqual(unresolved.inputs, [])
    const missing = yield* Effect.flip(
      NativeRequirementBinding.resolve(merged, [], 'loadable-module'),
    )
    assert.deepEqual(missing.origins.map((origin) => origin.source).sort(), ['a', 'b'])
  }),
)

it.effect('distinguishes runtime selection rules and loader policies without physical paths', () =>
  Effect.gen(function* () {
    const composition = yield* ArtifactComposition.decode({
      runtimes: [{ name: 'chosen', module: 'runtime' }],
      defaults: ['chosen'],
    })
    const base = yield* CompilationProfile.decode({
      target: 'x86_64-unknown-linux-gnu',
      artifact: 'object',
    })
    const defaultRoot = yield* ArtifactComposition.resolve(composition, 'app', base)
    const namedRoot = yield* ArtifactComposition.resolve(composition, 'app', {
      ...base,
      runtime: { kind: 'named', name: 'chosen' },
    })
    const noRoot = yield* ArtifactComposition.resolve(composition, 'app', {
      ...base,
      runtime: { kind: 'none' },
    })
    assert.strictEqual(defaultRoot.runtime?.module, namedRoot.runtime?.module)
    assert.strictEqual(new Set([defaultRoot.identity, namedRoot.identity, noRoot.identity]).size, 3)
    const identities = new Set<string>()
    for (const entry of [
      { kind: 'default' },
      { kind: 'none' },
      { kind: 'named', name: 'first' },
      { kind: 'named', name: 'second' },
    ] satisfies ReadonlyArray<CompilationProfile.Selection>) {
      identities.add(
        (yield* ArtifactComposition.resolve(composition, 'app', { ...base, entry })).identity,
      )
    }
    assert.strictEqual(identities.size, 4)
    const ambiguous = yield* ArtifactComposition.decode({
      runtimes: [
        { name: 'first', module: 'one' },
        { name: 'second', module: 'two' },
      ],
      defaults: ['first', 'second'],
    })
    assert.strictEqual(
      (yield* Effect.flip(ArtifactComposition.resolve(ambiguous, 'app', base))).code,
      'ConflictingBindings',
    )
    const conflicting = yield* ArtifactComposition.decode({ entry: { kind: 'none' } })
    assert.strictEqual(
      (yield* Effect.flip(
        ArtifactComposition.resolve(conflicting, 'app', {
          ...base,
          entry: { kind: 'named', name: 'entry' },
        }),
      )).code,
      'ConflictingBindings',
    )
  }),
)

it.effect(
  'keeps component catalogs separate from entry roots and preserves their bindings in identity',
  () =>
    Effect.gen(function* () {
      const binding = { operation: 'acquire', module: 'custom/storage', declaration: 'reserve' }
      const component = { capability: 'execution-storage', bindings: [binding] }
      const catalog = yield* ArtifactComposition.decode({ components: [component] })
      const profile = yield* CompilationProfile.decode({
        target: 'x86_64-unknown-linux-gnu',
        artifact: 'object',
        runtime: { kind: 'none' },
      })
      const selected = yield* ArtifactComposition.resolve(catalog, 'library', profile)
      assert.deepStrictEqual(selected.modules, ['library'])
      assert.deepStrictEqual(selected.components[0]?.bindings, [binding])
      const restored = yield* ArtifactComposition.resolve(
        yield* ArtifactComposition.decode(ArtifactComposition.input(catalog)),
        'library',
        profile,
      )
      assert.strictEqual(selected.identity, restored.identity)
      const changed = yield* ArtifactComposition.resolve(
        yield* ArtifactComposition.decode({
          components: [{ ...component, bindings: [{ ...binding, declaration: 'reserveBounded' }] }],
        }),
        'library',
        profile,
      )
      assert.notStrictEqual(selected.identity, changed.identity)
      for (const components of [
        [component, component],
        [{ ...component, bindings: [binding, { ...binding, declaration: 'other' }] }],
      ]) {
        const failure = yield* Effect.flip(ArtifactComposition.decode({ components }))
        assert.strictEqual(failure.code, 'ConflictingBindings')
      }
    }),
)

it.effect(
  'publishes stable artifact identity with stage, compiler and ordered supply distinctions',
  () =>
    Effect.gen(function* () {
      const analysis = yield* Analysis.makeRealized({
        root: 'identity',
        configuration: {
          profile: {
            target: 'x86_64-unknown-linux-gnu',
            artifact: 'object',
            runtime: { kind: 'none' },
          },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make('identity', ascii('export "C" fn value() -> i32 { return 42 }')),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      )
      const plan = analysis.artifactPlan ?? unreachable('expected logical plan')
      const remade = yield* ArtifactPlan.make(
        analysis,
        plan.profile,
        plan.composition,
        Analysis.loweredMir(analysis),
        plan.stage,
        plan.compiler,
      )
      assert.deepEqual(remade, plan)
      const object = yield* ArtifactPlan.make(
        analysis,
        plan.profile,
        plan.composition,
        Analysis.loweredMir(analysis),
        'object',
        plan.compiler,
      )
      const compiler = yield* ArtifactPlan.make(
        analysis,
        plan.profile,
        plan.composition,
        Analysis.loweredMir(analysis),
        plan.stage,
        'another compiler',
      )
      assert.strictEqual(new Set([plan.identity, object.identity, compiler.identity]).size, 3)
      const a = { _tag: 'Object', path: '/one.o' } as const
      const b = { _tag: 'Object', path: '/two.o' } as const
      assert.notStrictEqual(
        ArtifactPlan.physicalIdentity(plan, [a, b]),
        ArtifactPlan.physicalIdentity(plan, [b, a]),
      )
      assert.strictEqual(plan.identity, remade.identity)
    }),
)

it.effect(
  'rejects invalid retention roles and unsupported final loader entries before emission',
  () =>
    Effect.gen(function* () {
      for (const text of [
        'pub static fn selected() -> i32 { return 1 }',
        'pub fn selected<T>() -> i32 { return 1 }',
      ]) {
        const analysis = yield* Analysis.makeRealized({
          root: 'roles',
          configuration: {
            profile: {
              target: 'x86_64-unknown-linux-gnu',
              artifact: 'object',
              runtime: { kind: 'none' },
            },
            composition: {
              runtimes: [],
              defaults: [],
              requirements: [],
              retention: [{ module: 'roles', declaration: 'selected' }],
            },
          },
        }).pipe(
          Effect.provide(
            SourceResolver.overlay([SourceFile.make('roles', ascii(text))]).pipe(
              Layer.provideMerge(SourceResolver.empty),
            ),
          ),
        )
        const diagnostics = Analysis.diagnostics(analysis)
        assert.include(
          diagnostics.map((entry) => entry.code),
          'SEM0214',
        )
        assert.isTrue(diagnostics.every((entry) => entry.span.sourceId === 'roles'))
      }
      const analysis = yield* Analysis.makeRealized({
        root: 'loader',
        configuration: {
          profile: {
            target: 'x86_64-unknown-linux-gnu',
            artifact: 'object',
            runtime: { kind: 'none' },
            entry: { kind: 'named', name: 'start' },
          },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make('loader', ascii('export "C" fn value() -> i32 { return 42 }')),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      )
      assert.deepEqual(Analysis.diagnostics(analysis), [])
      const plan = analysis.artifactPlan ?? unreachable('expected intermediate plan')
      const rejected = yield* Effect.flip(
        ArtifactPlan.make(
          analysis,
          plan.profile,
          plan.composition,
          Analysis.loweredMir(analysis),
          'final',
          plan.compiler,
        ),
      )
      assert.strictEqual(rejected.code, 'UnsupportedCombination')
    }),
)

it.effect('loads and validates storage components only for specialized private frame demand', () =>
  Effect.gen(function* () {
    const plain = yield* AnalysisFixture.retainingMain(
      'component/plain',
      ascii('pub fn main() -> i32 { return 42 }'),
      'wasm32-unknown-unknown',
    )
    assert.isFalse(plain.closure.sources.has('silk/execution_storage'))
    assert.isUndefined(Analysis.loweredMir(plain).executionStorage)
    const suspended = yield* AnalysisFixture.retainingMain(
      'component/suspended',
      ascii(`
import silk.effect { Effect }
pub fn main() -> i32 { return run Effect.suspend(effect { return 42 }) }
`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(suspended), [])
    const component = Analysis.loweredMir(suspended).executionStorage
    assert.isDefined(component)
    assert.strictEqual(component?.acquire.declaration.module, 'silk/execution_storage')
    assert.isTrue(suspended.closure.sources.has('silk/execution_storage'))
    assert.isTrue(
      suspended.artifactPlan?.sources.some((source) => source.module === 'silk/execution_storage'),
    )
    assert.isTrue(
      suspended.index.modules.some((module) => module.module === 'silk/execution_storage'),
    )
    assert.isTrue(suspended.toolingModules.has('silk/execution_storage'))
    const prepared = Preparation.preparation(
      yield* Preparation.promote(suspended, 'wasm32-unknown-unknown', { emission: true }).pipe(
        Effect.provide(SourceResolver.empty),
      ),
    )
    assert.strictEqual(prepared._tag, 'Prepared')
    if (prepared._tag === 'Prepared') {
      assert.strictEqual(
        prepared.program.executionStorage?.acquire.symbol,
        component?.acquire.symbol,
      )
      assert.isTrue(prepared.frontend.closure.sources.has('silk/execution_storage'))
      assert.isTrue(
        prepared.artifactPlan?.sources.some((source) => source.module === 'silk/execution_storage'),
      )
    }
  }),
)

const storageFixture = Effect.gen(function* () {
  const profile = yield* CompilationProfile.decode({
    target: 'wasm32-unknown-unknown',
    artifact: 'object',
    runtime: { kind: 'none' },
  })
  const defaults = {
    ...ArtifactComposition.defaults(profile),
    retention: [{ module: 'component/application', declaration: 'main' }],
  }
  const component = {
    capability: 'execution-storage',
    bindings: [
      ['create', 'newState'],
      ['acquire', 'reserve'],
      ['release', 'reclaim'],
      ['destroy', 'finish'],
    ].map(([operation, declaration]) => ({
      operation: operation ?? unreachable('operation'),
      module: 'custom/storage',
      declaration: declaration ?? unreachable('declaration'),
    })),
  }
  const provider = `
export "C" fn newState() -> ?*mut u8 { return Intrinsic.pointerNull<u8>() }
export "C" fn reserve(state: ?*mut u8, size: usize, alignment: usize) -> ?*mut u8 { return Intrinsic.pointerNull<u8>() }
export "C" fn reclaim(state: ?*mut u8, frame: ?*mut u8) -> () {}
export "C" fn finish(state: ?*mut u8) -> () {}
`
  const drivenProvider =
    `import silk.effect { Effect }
import silk.execution { Execution }
import silk.allocator { Allocator, OutOfMemoryError }
struct Status { code: i32 }
fn ready(state: &()) -> () {}
fn complete(state: &mut Status, value: i32) -> () {}
fn suspended(state: &mut Status, execution: Intrinsic.Execution<i32>) -> () { drop execution }
effect fn body() -> i32 { return run Effect.suspend(effect { return 42 }) }
effect fn work() -> () ! OutOfMemoryError ? &mut Allocator {
  let execution = run Execution.make(body(), (), ready)
  let mut state = Status { code: 0 }
  run Execution.drive(move execution, &mut state, complete, suspended)
  return ()
}
effect fn failed(error: OutOfMemoryError) -> () {}
fn helper() -> () {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(work(), failed) |> Effect.provideMut<Allocator>(&mut allocator)
}
` +
    provider.replace(
      'return Intrinsic.pointerNull<u8>()',
      'helper() return Intrinsic.pointerNull<u8>()',
    )
  const observedProvider =
    `struct Guard {}
impl Drop for Guard { fn drop(self: &mut Guard) -> () { helper() } }
fn observe(state: &mut Guard, event: u8, first: usize, second: usize, identity: string<'static>, origin: string<'static>) -> usize { return 0 }
fn observing<'env, S: 'env, A, ?R, F: fn<'static>(&mut S, u8, usize, usize, string<'static>, string<'static>) -> usize + Intrinsic.NonParking>(state: S, observer: F, body: once Effect<'env; A ? R>) -> once Effect<'env; A ? R> {
  return Intrinsic.observeDiagnostics<S, A, R, F>(move state, move observer, move body)
}
` +
    drivenProvider.replace(
      'helper() return Intrinsic.pointerNull<u8>()',
      'return run observing(Guard {}, observe, effect { return Intrinsic.pointerNull<u8>() })',
    )
  const source =
    'import silk.effect { Effect }\npub fn main() -> i32 { return run Effect.suspend(effect { return 42 }) }'
  const allocatedProvider =
    `import silk.layout { Layout }
effect fn allocateSome() -> () ! OutOfMemoryError ? &mut Allocator {
  let allocation = run Allocator.allocate(Layout.of<i32>())
  drop allocation
  return ()
}
fn allocateOnly() -> () {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(allocateSome(), failed) |> Effect.provideMut<Allocator>(&mut allocator)
}
` +
    drivenProvider.replace(
      'helper() return Intrinsic.pointerNull<u8>()',
      'allocateOnly() return Intrinsic.pointerNull<u8>()',
    )
  const analyze = Effect.fnUntraced(function* (
    body: string,
    selected: boolean,
    application = source,
  ) {
    return yield* Analysis.makeRealized({
      root: 'component/application',
      configuration: {
        profile: CompilationProfile.input(profile),
        composition: { ...defaults, components: selected ? [component] : [] },
      },
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make('component/application', ascii(application))]).pipe(
          Layer.provideMerge(SourceResolver.memory(new Map([['custom/storage', ascii(body)]]))),
        ),
      ),
    )
  })
  const rejections = [
    [provider, false, 'MissingParameter'],
    [provider.replace('size: usize', 'size: i32'), true, 'InvalidInput'],
    [drivenProvider, true, 'DependencyCycle'],
    [observedProvider, true, 'DependencyCycle'],
    [
      observedProvider
        .replace(
          'fn drop(self: &mut Guard) -> () { helper() }',
          'fn drop(self: &mut Guard) -> () {}',
        )
        .replace('-> usize { return 0 }', '-> usize { helper() return 0 }'),
      true,
      'DependencyCycle',
    ],
    [
      'struct Guard {}\nimpl Drop for Guard { fn drop(self: &mut Guard) -> () { helper() } }\n' +
        drivenProvider.replace(
          'helper() return Intrinsic.pointerNull<u8>()',
          'let guard = Guard {} drop guard return Intrinsic.pointerNull<u8>()',
        ),
      true,
      'DependencyCycle',
    ],
    [
      'import silk.effect { Effect }\n' +
        provider.replace(
          'return Intrinsic.pointerNull<u8>()',
          'return run Effect.suspend(effect { return Intrinsic.pointerNull<u8>() })',
        ),
      true,
      'DependencyCycle',
    ],
    [
      allocatedProvider +
        '\nexport "C" fn malloc(bytes: usize) -> ?*mut u8 { helper() return Intrinsic.pointerNull<u8>() }',
      true,
      'DependencyCycle',
    ],
    [
      allocatedProvider + '\nexport "C" fn free(pointer: ?*mut u8) -> () { helper() }',
      true,
      'DependencyCycle',
    ],
  ] satisfies ReadonlyArray<
    readonly [string, boolean, 'MissingParameter' | 'InvalidInput' | 'DependencyCycle']
  >
  return { analyze, provider, observedProvider, rejections }
})

it.effect('binds arbitrary storage exports and keys their source content', () =>
  Effect.gen(function* () {
    const { analyze, provider } = yield* storageFixture
    const valid = yield* analyze(provider, true)
    const changed = yield* analyze(
      provider.replace(
        'fn finish(state: ?*mut u8) -> () {}',
        'fn finish(state: ?*mut u8) -> () { let changed = 1 }',
      ),
      true,
    )
    assert.deepEqual(Analysis.diagnostics(valid), [])
    assert.deepEqual(Analysis.diagnostics(changed), [])
    assert.strictEqual(Analysis.loweredMir(valid).executionStorage?.acquire.symbol, 'reserve')
    assert.notStrictEqual(valid.artifactPlan?.identity, changed.artifactPlan?.identity)
  }),
)

it.effect('admits storage bootstrap observation whose cleanup needs no storage', () =>
  Effect.gen(function* () {
    const { analyze, observedProvider } = yield* storageFixture
    const snapshot = yield* analyze(
      observedProvider.replace(
        'fn drop(self: &mut Guard) -> () { helper() }',
        'fn drop(self: &mut Guard) -> () {}',
      ),
      true,
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)

it.effect('does not execute an unstarted storage-bootstrap Effect', () =>
  Effect.gen(function* () {
    const { analyze, provider } = yield* storageFixture
    const snapshot = yield* analyze(
      'import silk.effect { Effect }\n' +
        provider.replace(
          'return Intrinsic.pointerNull<u8>()',
          'let deferred = effect { return run Effect.suspend(effect { return 42 }) } drop deferred return Intrinsic.pointerNull<u8>()',
        ),
      true,
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)

for (const [ordinal, name] of [
  'missing binding',
  'incompatible signature',
  'execution drive',
  'observation state cleanup',
  'observer callback',
  'explicit owner cleanup',
  'direct suspension',
  'implicit allocation helper',
  'implicit deallocation helper',
].entries()) {
  it.effect(`rejects storage bootstrap: ${name}`, () =>
    Effect.gen(function* () {
      const { analyze, rejections } = yield* storageFixture
      const [body, selected, code] = rejections.at(ordinal) ?? unreachable('storage rejection case')
      const rejected = yield* analyze(body, selected)
      assert.strictEqual(rejected.mir._tag, 'Unavailable')
      assert.deepEqual(
        Analysis.diagnostics(rejected).map((diagnostic) => [
          diagnostic.code,
          diagnostic.reason._tag === 'InvalidConfiguration'
            ? diagnostic.reason.error.code
            : undefined,
        ]),
        [['SEM0214', code]],
      )
    }),
  )
}

it.effect('keeps an unused storage catalog out of the source closure', () =>
  Effect.gen(function* () {
    const { analyze } = yield* storageFixture
    const unused = yield* analyze('', true, 'pub fn main() -> i32 { return 42 }')
    assert.deepEqual(Analysis.diagnostics(unused), [])
    assert.isFalse(unused.closure.sources.has('custom/storage'))
  }),
)
