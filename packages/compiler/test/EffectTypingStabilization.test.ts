import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as DeclarationFacts from '../src/DeclarationFacts.js'
import * as Lifetime from '../src/Lifetime.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Ownership from '../src/Ownership.js'
import * as SemanticContext from '../src/SemanticContext.js'
import * as AuthoredIdentity from '../src/AuthoredIdentity.js'
import * as Tir from '../src/Tir.js'
import * as Type from '../src/Type.js'
import { unreachable } from './support/raise.js'
import { nativeCorpus } from './support/corpus.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const snapshotOf = (name: string, source: string) => Analysis.ofSource(name, ascii(source))

const codesOf = (snapshot: Analysis.FrontendSnapshot): ReadonlyArray<string> =>
  Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code)

it.effect(
  'keeps a private recovery binder distinct from the primitive outer environment binder',
  () =>
    Effect.gen(function* () {
      const module = 'effect-typing/private-recovery-binder'
      const snapshot = yield* snapshotOf(
        module,
        `struct Problem {}
effect fn risky() -> i32 ! Problem { fail Problem {} }
effect fn recover(error: Problem) -> i32 { drop error return 42 }
fn inspectCatch() -> once Effect<'static; i32> {
  return Intrinsic.catchFailure<Problem>(risky(), recover)
}
pub fn main() -> i32 { return run inspectCatch() }`,
      )
      assert.deepEqual(codesOf(snapshot), [])
      const body =
        snapshot.results
          .get(module)
          ?.bodies.find(
            (candidate) =>
              candidate.declaration.name._tag === 'Present' &&
              candidate.declaration.name.spelling === 'inspectCatch',
          ) ?? unreachable('expected original static recovery factory')
      const caught =
        body.function.statements
          .flatMap(Tir.statementExpressions)
          .flatMap(Tir.expressionTree)
          .find((expression) => expression._tag === 'EffectCatch') ??
        unreachable('expected original recovery producer')
      if (caught._tag !== 'EffectCatch' || !Type.isEffect(caught.type))
        return unreachable('expected original caught Effect')
      const recipe = caught.recoveryInvocation ?? unreachable('expected private invocation recipe')
      assert.strictEqual(recipe.binder.ordinal, 0)
      assert.strictEqual(recipe.lifetime.context, `Invocation:${Lifetime.key(recipe.binder)}`)
      assert.isFalse(Lifetime.equals(recipe.lifetime, caught.type.environment))
      const expectedOwner = { _tag: 'CanonicalDeclarationId', module, name: 'inspectCatch' }
      assert.deepEqual(recipe.owner, expectedOwner)
    }),
)

it.effect(
  'infers contextual anonymous data from the original caller input without changing explicit selections',
  () =>
    Effect.gen(function* () {
      for (const prefix of ['', "<'data>"]) {
        const module = `effect-typing/anonymous-data-${prefix.length === 0 ? 'implicit' : 'explicit'}`
        const snapshot = yield* AnalysisFixture.retainingMain(
          module,
          ascii(`struct Owner { value: i32 }
struct Guard { offset: i32 }
impl Drop for Guard { fn drop(self: &mut Guard) -> () { return () } }
effect<'data> fn applyOwned<'data>(owner: &'data Owner,
  callback: for<use 'call> once fn<'static>(&'data Owner) -> once Effect<'call; i32>
) -> i32 { return run callback(owner) }
fn probe<'data>(owner: &'data Owner) -> i32 {
  let guard = Guard { offset: 2 }
  return run applyOwned${prefix}(owner, effect fn(input: &'data Owner) -> i32 {
    let consumed = move guard
    return input.value + consumed.offset
  })
}
pub fn main() -> i32 {
  let owner = Owner { value: 40 }
  return probe(&owner)
}`),
          'wasm32-unknown-unknown',
          { normalizeMir: false },
        )
        assert.deepEqual(codesOf(snapshot), [], prefix)
        assert.strictEqual(snapshot.mir._tag, 'Available')
        assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
        const body =
          snapshot.results
            .get(module)
            ?.bodies.find(
              (body) =>
                body.declaration.name._tag === 'Present' &&
                body.declaration.name.spelling === 'probe',
            ) ?? unreachable('expected original caller body')
        const owner = body.function.declaration.parameters[0]?.declaredType
        if (owner?._tag !== 'Resolved' || !Type.isReference(owner.type))
          return unreachable('expected original authored borrowed input')
        const call =
          body.function.statements
            .flatMap(Tir.statementExpressions)
            .flatMap(Tir.expressionTree)
            .find(
              (expression) =>
                expression._tag === 'EffectConstruct' && expression.target.name === 'applyOwned',
            ) ?? unreachable('expected contextual consumer')
        if (call._tag !== 'EffectConstruct') return unreachable('expected consumer Effect')
        assert.isTrue(
          Type.equalsGenericArgument(call.typeArguments[0] ?? 'never', owner.type.lifetime),
        )
      }
    }),
)

it.effect(
  'defers original lifetime selections until a staged callable receives its missing input',
  () =>
    Effect.gen(function* () {
      const module = 'effect-typing/staged-deferred-input'
      const snapshot = yield* snapshotOf(
        module,
        `struct Owner { value: i32 }
struct Guard { offset: i32 }
impl Drop for Guard { fn drop(self: &mut Guard) -> () { return () } }
effect<'held> fn recovered<'data: 'held, 'held>(owner: &'data Owner, guard: Guard) -> i32 {
  return owner.value + guard.offset
}
fn probe<'data>(owner: &'data Owner) -> i32 {
  let base = recovered
  let selected = base(Guard { offset: 2 })
  return run selected(owner)
}
pub fn main() -> i32 {
  let owner = Owner { value: 40 }
  return probe(&owner)
}`,
      )
      assert.deepEqual(codesOf(snapshot), [])
      const body =
        snapshot.results
          .get(module)
          ?.bodies.find(
            (candidate) =>
              candidate.declaration.name._tag === 'Present' &&
              candidate.declaration.name.spelling === 'probe',
          ) ?? unreachable('expected original staged caller')
      const stage =
        body.function.statements
          .flatMap(Tir.statementExpressions)
          .flatMap(Tir.expressionTree)
          .find(
            (expression) => expression._tag === 'CallableApply' && expression.staged !== undefined,
          ) ?? unreachable('expected original staged producer')
      if (stage._tag !== 'CallableApply' || !Type.isCallable(stage.type))
        return unreachable('expected deferred original callable')
      assert.lengthOf(stage.type.lifetimeBinders, 2)
      const schema = stage.type.schema ?? unreachable('expected original source schema')
      const originalSource = { _tag: 'CanonicalDeclarationId', module, name: 'recovered' }
      assert.deepEqual(schema.source, originalSource)
      for (const binder of stage.type.lifetimeBinders)
        assert.isFalse(schema.substitution.has(Lifetime.key(binder)))
    }),
)

for (const [name, formation] of [
  ['immutable-section', 'let selected = recovered(Guard { offset: 2 })'],
  ['immutable-stage', 'let base = recovered\n  let selected = base(Guard { offset: 2 })'],
] as const) {
  it.effect(`authenticates the original producer graph before adapting ${name}`, () =>
    Effect.gen(function* () {
      const module = `effect-typing/stored-${name}`
      const snapshot = yield* AnalysisFixture.retainingMain(
        module,
        ascii(`struct Owner { value: i32 }
struct Guard { offset: i32 }
impl Drop for Guard { fn drop(self: &mut Guard) -> () { return () } }
effect<'held> fn recovered<'data: 'held, 'held>(owner: &'data Owner, guard: Guard) -> i32 {
  return owner.value + guard.offset
}
effect<'data> fn applyOwned<'data>(owner: &'data Owner,
  callback: for<use 'call> once fn<'static>(&'data Owner) -> once Effect<'call; i32>
) -> i32 { return run callback(owner) }
fn probe<'data>(owner: &'data Owner) -> i32 {
  ${formation}
  return run applyOwned<'data>(owner, move selected)
}
pub fn main() -> i32 {
  let owner = Owner { value: 40 }
  return probe(&owner)
}`),
        'x86_64-unknown-linux-gnu',
        { normalizeMir: false },
      )
      assert.deepEqual(codesOf(snapshot), [])
      const body =
        snapshot.results
          .get(module)
          ?.bodies.find(
            (candidate) =>
              candidate.declaration.name._tag === 'Present' &&
              candidate.declaration.name.spelling === 'probe',
          ) ?? unreachable('expected actual consuming caller')
      const call =
        body.function.statements
          .flatMap(Tir.statementExpressions)
          .flatMap(Tir.expressionTree)
          .find(
            (expression) =>
              expression._tag === 'EffectConstruct' && expression.target.name === 'applyOwned',
          ) ?? unreachable('expected checked consumer')
      if (call._tag !== 'EffectConstruct') return unreachable('expected original Effect producer')
      const view =
        call.inputViews?.find((view) => view.parameter.ordinal === 1) ??
        unreachable('expected immutable source admission')
      const source = view.invocationSource ?? unreachable('expected held original producer graph')
      assert.deepEqual(source.target, { _tag: 'CanonicalDeclarationId', module, name: 'recovered' })
      assert.deepEqual(source.originalInputs, [0, 1])
      assert.deepEqual(source.parameters, [0])
      assert.lengthOf(source.captures, 1)
      assert.strictEqual(source.captures[0]?.parameter, 1)
      assert.strictEqual(source.producers[0]?.kind, 'Binding')
      assert.strictEqual(
        source.producers.some((producer) => producer.kind === 'Stage'),
        name === 'immutable-stage',
      )
      const operand = call.arguments[1] ?? unreachable('expected consuming operand')
      assert.strictEqual(operand._tag, 'Move')
      if (
        operand._tag !== 'Move' ||
        !Type.isCallable(operand.type) ||
        !Type.isCallable(view.actual)
      )
        return unreachable('expected original callable')
      assert.isUndefined(operand.type.invocationUse)
      assert.isTrue(Type.equals(operand.type, view.actual))
      assert.lengthOf(operand.type.lifetimeBinders, 2)
      assert.isDefined(source.selected.invocationUse)
      assert.strictEqual(source.selected.schema?.invocationAdapter?.parameters[0], 0)
      assert.strictEqual(snapshot.mir._tag, 'Available')
      assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
    }),
  )
}

it.effect(
  'retains original call and operand provenance for checked executable parameter views',
  () =>
    Effect.gen(function* () {
      const program =
        nativeCorpus.find(
          (candidate) => candidate.name === 'effect-borrowed-recovery-owned-cleanup',
        ) ?? unreachable('expected canonical borrowed recovery source')
      const module = 'effect-typing/executable-parameter-views'
      const snapshot = yield* snapshotOf(module, program.source)
      assert.deepEqual(codesOf(snapshot), [])
      const checked = snapshot.results.get(module) ?? unreachable('expected original caller module')
      const main =
        checked.bodies.find(
          (body) =>
            body.declaration.name._tag === 'Present' && body.declaration.name.spelling === 'main',
        ) ?? unreachable('expected original caller')
      const expressions = main.function.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)
      const calls = expressions.filter(
        (expression) =>
          (expression._tag === 'Call' || expression._tag === 'EffectConstruct') &&
          expression.target.module === 'silk/effect' &&
          expression.target.name === 'Effect.catchAll',
      )
      assert.lengthOf(calls, 2)
      const originalInputs: Type.Effect[] = []
      for (const call of calls) {
        if (call._tag !== 'Call' && call._tag !== 'EffectConstruct')
          return unreachable('expected original concrete call')
        const views = call.inputViews ?? unreachable('expected accepted source parameter views')
        assert.lengthOf(views, 2)
        for (const view of views) {
          assert.deepEqual(view.caller, { _tag: 'CanonicalDeclarationId', module, name: 'main' })
          assert.deepEqual(view.target, call.target)
          assert.strictEqual(
            AuthoredIdentity.anchorKey(view.call),
            call.origin._tag === 'Authored'
              ? AuthoredIdentity.anchorKey(call.origin.anchor)
              : unreachable('expected authored call'),
          )
          const operand =
            call.arguments.at(view.parameter.ordinal) ??
            unreachable('expected exact original operand')
          assert.strictEqual(view.operand.node.ordinal, operand.id?.ordinal)
          assert.isTrue(
            Type.equals(Type.substitute(view.parameter.declared, view.substitution), view.expected),
          )
          assert.strictEqual(view.premises.owner.module, module)
          assert.strictEqual(view.premises.owner.name, 'main')
        }
        const input =
          views.find((view) => view.parameter.ordinal === 0) ??
          unreachable('expected original protected Effect')
        if (!Type.isEffect(input.actual) || !Type.isEffect(input.expected))
          return unreachable('expected original Effect headers')
        assert.isFalse(Type.equals(input.actual, input.expected))
        originalInputs.push(input.actual)
      }
      assert.isFalse(
        Type.equals(
          originalInputs[0] ?? unreachable('expected first loan'),
          originalInputs[1] ?? unreachable('expected second loan'),
        ),
      )
    }),
)

// EFF-007: an `effect {}` block whose only terminal is `fail` has success type `never`, and that
// success satisfies any declared success while the failure channel is still checked.
it.effect('rejects a fail-only effect block whose failure exceeds the declared channel', () =>
  Effect.gen(function* () {
    const snapshot = yield* snapshotOf(
      'effect-typing/fail-only-undeclared',
      `struct ProblemError {}
fn f() -> Effect<'static; i32> {
  return effect { fail ProblemError {} }
}
pub fn main() -> i32 { return run f() }`,
    )
    assert.deepEqual(codesOf(snapshot), ['SEM0129'])
  }),
)

// A borrowed parameter capture anchors its loan at the body use, not the parameter declaration.
it.effect('types an inline effect block that borrows an enclosing parameter', () =>
  Effect.gen(function* () {
    const module = 'effect-typing/borrowed-parameter-capture'
    const snapshot = yield* snapshotOf(
      module,
      `fn read(value: &i32) -> i32 { return value.* }
effect fn ordered(value: i32) -> () {
  run effect { let copied = read(&value) return () }
  return ()
}
pub fn main() -> i32 { run ordered(1) return 42 }`,
    )
    assert.deepEqual(codesOf(snapshot), [])
    const body =
      snapshot.results
        .get(module)
        ?.bodies.find(
          (candidate) =>
            candidate.declaration.name._tag === 'Present' &&
            candidate.declaration.name.spelling === 'ordered',
        ) ?? unreachable('expected the effect function body')
    const run =
      body.function.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)
        .find((expression) => expression._tag === 'Run') ??
      unreachable('expected the run of the inline effect block')
    if (run._tag !== 'Run' || run.subject._tag !== 'EffectBlock')
      return unreachable('expected the inline effect block as the run subject')
    assert.isTrue(Type.isEffect(run.subject.type))
  }),
)

// SUSP-005: a suspend wrapper keeps its failure and requirement channels and composes with
// Effect.provide and Effect.catchAll in either order.
const suspendComposition = (body: string) => `import silk.effect { Effect }
struct ProblemError { code: i32 }
service Clock {
  effect fn value() -> i32 ? &Clock
}
struct FixedClock { value: i32 }
impl Clock for FixedClock {
  effect fn value(self: &Self) -> i32 { return self.value }
}
effect fn work(n: i32) -> i32 ! ProblemError ? &Clock {
  let base = run Clock.value()
  if n < 0 { fail ProblemError { code: base + n } }
  return base + n
}
effect fn protected(n: i32) -> i32 ! ProblemError ? &Clock {
  return run Effect.suspend(work(n))
}
effect fn recover(error: ProblemError) -> i32 { return error.code * 100 }
pub fn main() -> i32 {
  let clock = FixedClock { value: 40 }
${body}
  if ok != 42 { return 1 }
  if bad != 3700 { return 2 }
  return 0
}`

it.effect('still rejects running a suspended fallible Effect inside an ordinary function', () =>
  Effect.gen(function* () {
    const snapshot = yield* snapshotOf(
      'effect-typing/suspend-unhandled',
      suspendComposition(`  let ok = run Effect.provide(protected(2), &clock)
  let bad = run Effect.provide(Effect.catchAll(protected(-3), recover), &clock)`),
    )
    assert.deepEqual(codesOf(snapshot), ['SEM0066'])
  }),
)

// STORAGE-001: a bare Effect field has no hidden concrete identity to lay out; like a bare
// callable field it is fenced at construction instead of reaching MIR.
it.effect('fences a struct that stores a bare Effect field at its construction', () =>
  Effect.gen(function* () {
    for (const [name, source] of [
      [
        'effect-typing/bare-effect-field-once',
        `import silk.effect { Effect }
struct Payload { value: i32 }
struct Holder { e: once Effect<'static; Payload> }
fn prepare(payload: Payload) -> once Effect<'static; Payload> { return effect { return move payload } }
pub fn main() -> i32 {
  let h = Holder { e: prepare(Payload { value: 30 }) }
  return 1
}`,
      ],
      [
        'effect-typing/bare-effect-field-shared',
        `import silk.effect { Effect }
struct Holder { e: Effect<'static; i32> }
effect fn base() -> i32 { return 42 }
fn run_it(h: &Holder) -> i32 { return run h.e }
pub fn main() -> i32 {
  let h = Holder { e: base() }
  return run_it(&h)
}`,
      ],
    ] as const) {
      const snapshot = yield* AnalysisFixture.retainingMain(
        name,
        ascii(source),
        'wasm32-unknown-unknown',
      )
      assert.deepEqual(codesOf(snapshot), ['SEM0103'], name)
      assert.strictEqual(snapshot.mir._tag, 'Unavailable', name)
    }
  }),
)

// Actual stdlib composition proves the directional adapter and anonymous-body context;
// constructed metadata tests cannot prove these source paths or unrestricted failure channels.
it.effect(
  'keeps recovery payloads scoped to execution without bounding generic result errors',
  () =>
    Effect.gen(function* () {
      const source = `import silk.effect { Effect }
import silk.result { Result }
effect<'env> fn retain<E: 'env, 'env>(error: E) -> E { return move error }
fn recover<'input>(error: &'input i32) -> &'input i32 {
  return run Effect.catchAll(effect { fail error }, retain)
}
fn reify<E>(protected: once Effect<'static; i32 ! E>) -> Result<i32, E> {
  return run Effect.result(move protected)
}
effect fn again<E>(protected: mut Effect<'static; i32 ! E>) -> i32 ! E {
  return run Effect.retry(protected, 1)
}
fn anonymous<'input>(error: &'input i32) -> i32 {
  return run Effect.catchAll(effect { fail error }, fn(caught: &'input i32) -> once Effect<i32> {
    return effect { return caught.* + error.* }
  })
}
pub fn main() -> i32 {
  let value = 21
  return anonymous(&value)
}`
      const snapshot = yield* AnalysisFixture.retainingMain(
        'effect-typing/invocation-scoped-recovery',
        ascii(source),
        'wasm32-unknown-unknown',
        { normalizeMir: false },
      )
      assert.deepEqual(codesOf(snapshot), [])
      const bodies = [...snapshot.results.values()].flatMap((result) => result.bodies)
      const anonymous =
        bodies.find(
          (body) =>
            !body.hidden &&
            body.declaration.name._tag === 'Present' &&
            body.declaration.name.spelling === 'anonymous',
        ) ?? unreachable('expected the authored anonymous caller')
      const section =
        anonymous.function.statements
          .flatMap(Tir.statementExpressions)
          .flatMap(Tir.expressionTree)
          .find(
            (node) =>
              node._tag === 'CallableSection' && node.span.start === source.indexOf('fn(caught:'),
          ) ?? unreachable('expected the actual anonymous callable section')
      assert.strictEqual(section._tag, 'CallableSection')
      if (section._tag !== 'CallableSection') return unreachable()
      assert.strictEqual(section.target._tag, 'DeclarationCallableTarget')
      if (section.target._tag !== 'DeclarationCallableTarget') return unreachable()
      const target = section.target.declaration
      const hidden =
        bodies.find(
          (body) =>
            body.hidden &&
            body.declaration.canonical._tag === 'Canonical' &&
            body.declaration.canonical.id.module === target.module &&
            body.declaration.canonical.id.name === target.name,
        ) ?? unreachable('expected the actual section target body')
      const role =
        hidden.declaration.lifetimeElaboration?.invocationUse ??
        unreachable('expected retained source invocation designation')
      assert.strictEqual(hidden.declaration.canonical._tag, 'Canonical')
      if (hidden.declaration.canonical._tag !== 'Canonical') return unreachable()
      assert.deepEqual(role.lifetime.owner, hidden.declaration.canonical.id)
      assert.deepEqual(role.parameters, [0])
      assert.deepEqual(section.invocationParameters, [0])
      assert.strictEqual(section.captures.length, 1)
      assert.strictEqual(section.captures.at(0)?.parameterOrdinal, 1)
      assert.strictEqual(hidden.declaration.parameters.at(1)?.captureAccess, 'Shared')
      const contract = DeclarationFacts.callableContract(hidden.declaration)
      const contractRole =
        contract.invocationUse ?? unreachable('expected marked original source contract')
      assert.strictEqual(Lifetime.key(contractRole.lifetime), Lifetime.key(role.lifetime))
      assert.deepEqual(contractRole.parameters, [0])
      assert.strictEqual(
        contract.lifetimeBinders.filter((binder) => Lifetime.equals(binder, role.lifetime)).length,
        1,
      )
      assert.deepEqual(contract.captures, [{ parameter: 1, capture: 0 }])
      assert.deepEqual(Type.callableInputOrdinals(contract), [0])
      assert.strictEqual(
        Lifetime.key(
          section.type.invocationUse?.lifetime ?? unreachable('expected marked offered section'),
        ),
        Lifetime.key(role.lifetime),
      )
      const named =
        bodies.find(
          (body) =>
            !body.hidden &&
            body.declaration.name._tag === 'Present' &&
            body.declaration.name.spelling === 'retain',
        ) ?? unreachable('expected ordinary source helper')
      assert.strictEqual(named.declaration.lifetimeElaboration?.invocationUse, undefined)
      assert.strictEqual(
        DeclarationFacts.callableContract(named.declaration).invocationUse,
        undefined,
      )
      const program = Analysis.loweredMir(snapshot)
      const recovery =
        program.functions
          .flatMap(MirVerification.operations)
          .find(
            (operation) =>
              operation._tag === 'ApplyCallable' &&
              operation.invocationUse?.kind === 'Recovery' &&
              Lifetime.equals(operation.invocationUse.binder, role.lifetime),
          ) ?? unreachable('expected recovery to retain the actual hidden source designation')
      if (recovery._tag !== 'ApplyCallable' || recovery.invocationUse === undefined)
        return unreachable('expected the actual checked recovery invocation')
      assert.strictEqual(recovery.callableType.invocationUse?.lifetime._tag, 'LocalLifetime')
      assert.isTrue(
        Lifetime.equals(
          recovery.callableType.invocationUse?.lifetime ??
            unreachable('expected opened invocation role'),
          recovery.invocationUse.lifetime,
        ),
      )
      assert.isFalse(
        Type.freeLifetimes(recovery.callableType.result).some((lifetime) =>
          Lifetime.atoms(lifetime).some((atom) => Lifetime.equals(atom, role.lifetime)),
        ),
      )
      assert.deepEqual(yield* MirVerification.verify(program), [])
    }),
)

// Two concurrently held results are separate invocation extents, even for one reusable callback.
it.effect('keeps two simultaneous invocation scopes and their actual loans independent', () =>
  Effect.gen(function* () {
    const source = `fn releasedFirst(callback: for<use 'call> fn<'static>(&'call mut [i32]) -> once Effect<'call; i32>) -> i32 {
  let mut first = [1]
  let mut second = [2]
  let firstWaiting = callback(&mut first)
  let secondWaiting = callback(&mut second)
  drop firstWaiting
  first[0] = 3
  drop secondWaiting
  second[0] = 4
  return first[0] + second[0]
}
fn secondStillLive(callback: for<use 'call> fn<'static>(&'call mut [i32]) -> once Effect<'call; i32>) -> i32 {
  let mut first = [1]
  let mut second = [2]
  let firstWaiting = callback(&mut first)
  let secondWaiting = callback(&mut second)
  drop firstWaiting
  first[0] = 3
  second[0] = 4
  drop secondWaiting
  return 0
}`
    const snapshot = yield* Analysis.ofSourceRealized(
      'effect-typing/independent-invocation-scopes',
      ascii(source),
    )
    const result =
      snapshot.results.get(snapshot.closure.rootModule) ?? unreachable('expected checked source')
    const plan = Ownership.localSharedAccessBoundaryPlan(snapshot.results)
    const context = SemanticContext.make(result.authored)
    const inputOf = (name: string): Ownership.CheckInput => {
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
    const input = inputOf('releasedFirst')
    const checked = Ownership.check(input)
    assert.deepEqual(checked.diagnostics, [])
    assert.strictEqual(checked.ownership.verdict._tag, 'Satisfied')
    assert.strictEqual(checked.ownership.invocations.length, 2)
    const first = checked.ownership.invocations.at(0) ?? unreachable('expected first actual use')
    const second = checked.ownership.invocations.at(1) ?? unreachable('expected second actual use')
    assert.isFalse(Lifetime.equals(first.obligation.lifetime, second.obligation.lifetime))
    assert.isFalse(
      AuthoredIdentity.anchorKey(first.obligation.origin) ===
        AuthoredIdentity.anchorKey(second.obligation.origin),
    )
    assert.isFalse(Tir.nodeRefEquals(first.call, second.call))
    const flow = input.lifetimes ?? unreachable('expected the real finite invocation domain')
    for (const invocation of [first, second]) {
      assert.strictEqual(invocation.obligation.lifetime._tag, 'LocalLifetime')
      assert.isTrue(
        flow.input.regions.some((entry) =>
          Lifetime.equals(entry.lifetime, invocation.obligation.lifetime),
        ),
      )
      const anchor =
        flow.anchors.get(invocation.obligation.lifetime.ordinal) ??
        unreachable('expected actual call anchor')
      assert.strictEqual(
        AuthoredIdentity.anchorKey(anchor),
        AuthoredIdentity.anchorKey(invocation.obligation.origin),
      )
      assert.strictEqual(invocation.retained, true)
      assert.deepEqual(
        invocation.inputs.map((operand) => operand.parameter),
        [0],
      )
    }
    for (const [name, invocation, dropText, writeText] of [
      ['first', first, 'drop firstWaiting', 'first[0] = 3'],
      ['second', second, 'drop secondWaiting', 'second[0] = 4'],
    ] as const) {
      const binding = input.function.statements.find(
        (statement) => statement._tag === 'Bind' && statement.name === name,
      )
      if (binding?._tag !== 'Bind')
        return unreachable('expected the actual authored referent binding')
      const operand = invocation.inputs.at(0) ?? unreachable('expected actual borrowed argument')
      assert.strictEqual(operand.transfer, 'Borrow')
      assert.strictEqual(operand.conditionalContents, false)
      assert.deepEqual(
        operand.referents.map((referent) => referent.root),
        [{ _tag: 'Let', binding: binding.binding }],
      )
      const loan =
        checked.ownership.loans.find(
          (candidate) =>
            candidate.origin === 'ReturnedView' &&
            candidate.referents.some(
              (referent) =>
                referent.root._tag === 'Let' &&
                referent.root.binding.ordinal === binding.binding.ordinal,
            ),
        ) ?? unreachable('expected retained actual loan')
      const dropped = source.indexOf(dropText)
      const written = source.indexOf(writeText)
      assert.isAtLeast(loan.endSpan.start, dropped)
      assert.isAtMost(loan.endSpan.end, dropped + dropText.length)
      assert.isAtMost(loan.endSpan.end, written)
      assert.isAtLeast(invocation.end.span.start, dropped)
      assert.isAtMost(invocation.end.span.end, dropped + dropText.length)
    }
    const firstWrite = source.indexOf('first[0] = 3')
    assert.isBelow(first.end.span.end, firstWrite)
    assert.isAbove(second.end.span.start, firstWrite)
    const blocked = Ownership.check(inputOf('secondStillLive'))
    assert.strictEqual(blocked.ownership.verdict._tag, 'Violation')
    const blockedWrite = source.indexOf('second[0] = 4', source.indexOf('fn secondStillLive'))
    assert.deepEqual(
      blocked.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.start,
        diagnostic.span.end,
      ]),
      [['OWN0011', blockedWrite, blockedWrite + 'second[0]'.length]],
    )
  }),
)

// Observed authored refusals: invocation-only contents never become public Static validity.
it.effect('rejects a public invocation computation escape and a fixed Static recovery helper', () =>
  Effect.gen(function* () {
    for (const [name, source, expected, rejected] of [
      [
        'effect-typing/invocation-public-return',
        `fn escaped<T>(callback: for<use 'call> once fn<'static>(T) -> once Effect<'call; i32>, value: T) -> once Effect<'static; i32> {
  return callback(move value)
}
pub fn main() -> i32 { return 0 }
`,
        [
          ['OWN0019', 137, 157],
          ['OWN0019', 137, 157],
        ],
        'callback(move value)',
      ],
      [
        'effect-typing/invocation-fixed-static',
        `import silk.effect { Effect }
effect<'static> fn keepStatic<E: 'static>(error: E) -> E { return move error }
fn rejected<'data>(error: &'data i32) -> &'data i32 {
  return run Effect.catchAll(effect { fail error }, keepStatic)
}
pub fn main() -> i32 { return 0 }
`,
        [['SEM0213', 215, 225]],
        'keepStatic',
      ],
    ] as const) {
      const snapshot = yield* snapshotOf(name, source)
      const diagnostics = Analysis.diagnostics(snapshot)
      const observed: ReadonlyArray<ReadonlyArray<string | number>> = diagnostics.map(
        (diagnostic) => [diagnostic.code, diagnostic.span.start, diagnostic.span.end],
      )
      assert.deepEqual(observed, expected, name)
      for (const diagnostic of diagnostics)
        assert.strictEqual(source.slice(diagnostic.span.start, diagnostic.span.end), rejected, name)
    }
    // The exact observed secondary inference diagnostics remain part of each rejection.
    for (const [name, source, expected, rejected] of [
      [
        'effect-typing/invocation-public-store',
        `struct Holder<'store, F: once Effect<'store; i32>> { work: F }
pub fn stored<'data>(
  value: &'data i32,
  callback: for<use 'call> once fn<'data>(&'call i32) -> once Effect<'call & 'data; i32>
) -> i32 {
  let waiting = callback(value)
  let held = Holder<'data> { work: move waiting }
  drop held
  return 0
}
pub fn main() -> i32 { return 0 }
`,
        [
          ['SEM0099', 22, 49],
          ['SEM0025', 273, 285],
        ],
        ["F: once Effect<'store; i32>", 'move waiting'],
      ],
      [
        'effect-typing/invocation-public-execution',
        `import silk.allocator { Allocator, OutOfMemoryError }
import silk.execution { Execution }
fn ready(state: &()) -> () { return () }
pub effect<'env> fn detached<'env, 'data: 'env>(
  value: &'data i32,
  callback: for<use 'call> once fn<'env>(&'call i32) -> once Effect<'call & 'env; i32>
) -> () ! OutOfMemoryError ? &mut Allocator {
  let waiting = callback(value)
  let execution = run Execution.make<i32>(move waiting, (), ready)
  drop execution
  return ()
}
pub fn main() -> i32 { return 0 }
`,
        [
          ['SEM0212', 131, 463],
          ['SEM0212', 131, 463],
          ['SEM0099', 388, 432],
        ],
        [
          `pub effect<'env> fn detached<'env, 'data: 'env>(
  value: &'data i32,
  callback: for<use 'call> once fn<'env>(&'call i32) -> once Effect<'call & 'env; i32>
) -> () ! OutOfMemoryError ? &mut Allocator {
  let waiting = callback(value)
  let execution = run Execution.make<i32>(move waiting, (), ready)
  drop execution
  return ()
}`,
          `pub effect<'env> fn detached<'env, 'data: 'env>(
  value: &'data i32,
  callback: for<use 'call> once fn<'env>(&'call i32) -> once Effect<'call & 'env; i32>
) -> () ! OutOfMemoryError ? &mut Allocator {
  let waiting = callback(value)
  let execution = run Execution.make<i32>(move waiting, (), ready)
  drop execution
  return ()
}`,
          'Execution.make<i32>(move waiting, (), ready)',
        ],
      ],
    ] as const) {
      const snapshot = yield* snapshotOf(name, source)
      const diagnostics = Analysis.diagnostics(snapshot)
      const observed: ReadonlyArray<ReadonlyArray<string | number>> = diagnostics.map(
        (diagnostic) => [diagnostic.code, diagnostic.span.start, diagnostic.span.end],
      )
      const rejectedSources: ReadonlyArray<string> = diagnostics.map((diagnostic) =>
        source.slice(diagnostic.span.start, diagnostic.span.end),
      )
      assert.deepEqual(observed, expected, name)
      assert.deepEqual(rejectedSources, rejected, name)
      if (name === 'effect-typing/invocation-public-store') {
        const body =
          [...snapshot.results.values()]
            .flatMap((result) => result.bodies)
            .find(
              (candidate) =>
                candidate.declaration.name._tag === 'Present' &&
                candidate.declaration.name.spelling === 'stored',
            ) ?? unreachable('expected the actual rejected store body')
        const expressions = body.function.statements
          .flatMap(Tir.statementExpressions)
          .flatMap(Tir.expressionTree)
        const call =
          expressions.find(
            (node) =>
              node._tag === 'CallableApply' &&
              source.slice(node.span.start, node.span.end) === 'callback(value)',
          ) ?? unreachable('expected the actual scoped callback application')
        if (call._tag !== 'CallableApply') return unreachable()
        const use = call.invocationUse ?? unreachable('expected actual invocation-use evidence')
        const owner =
          body.declaration.lifetimeElaboration?.owner ?? unreachable('expected source body owner')
        const canonical = body.declaration.canonical
        if (canonical._tag !== 'Canonical') return unreachable('expected canonical source owner')
        assert.deepEqual(use.owner, canonical.id)
        assert.deepEqual(use.lifetime.owner, canonical.id)
        assert.strictEqual(use.owner.module, owner.module)
        assert.strictEqual(use.owner.name, owner.name)
        assert.strictEqual(use.lifetime._tag, 'LocalLifetime')
        assert.strictEqual(
          AuthoredIdentity.anchorKey(use.origin),
          AuthoredIdentity.anchorKey(call.origin.anchor),
        )
        assert.deepEqual(
          use.inputs.map((input) => input.parameter),
          [0],
        )
        const input = use.inputs.at(0) ?? unreachable('expected real borrowed input')
        const operand = call.arguments.at(0) ?? unreachable('expected actual source argument')
        assert.strictEqual(
          AuthoredIdentity.anchorKey(input.argument),
          AuthoredIdentity.anchorKey(operand.origin.anchor),
        )
        assert.isTrue(
          Type.isReference(input.type) &&
            input.type.access === 'Shared' &&
            input.type.target === 'i32',
        )
        assert.isTrue(
          Tir.expressionTree(operand).some(
            (node) => node._tag === 'ParameterReference' && node.parameter.ordinal === 0,
          ),
        )
        const parameter =
          body.declaration.parameters.at(0) ?? unreachable('expected actual value header')
        if (
          parameter.declaredType._tag !== 'Resolved' ||
          !Type.isReference(parameter.declaredType.type)
        )
          return unreachable('expected the genuine data reference')
        const data = parameter.declaredType.type.lifetime
        assert.strictEqual(data._tag, 'BoundLifetime')
        if (data._tag !== 'BoundLifetime') return unreachable('expected declared data lifetime')
        assert.deepEqual(data.owner, owner)
        assert.strictEqual(data.ordinal, 0)
        const result = Type.isRepresented(call.type) ? call.type.contract : call.type
        if (!Type.isEffect(result)) return unreachable('expected scoped Effect result')
        assert.strictEqual(result.access, 'Take')
        assert.strictEqual(result.success, 'i32')
        assert.deepEqual(
          Lifetime.atoms(result.environment).map(Lifetime.key).sort(),
          [data, use.lifetime].map(Lifetime.key).sort(),
        )
        const aggregate =
          expressions.find(
            (node) =>
              source.slice(node.span.start, node.span.end) ===
              "Holder<'data> { work: move waiting }",
          ) ?? unreachable('expected the real attempted holder producer')
        if (aggregate._tag === 'Construct') {
          assert.strictEqual(aggregate.nominal.name, 'Holder')
          assert.strictEqual(aggregate.nominal.module, snapshot.closure.rootModule)
          assert.isTrue(
            Type.equalsGenericArgument(aggregate.nominal.arguments.at(0) ?? 'never', data),
          )
          assert.strictEqual(aggregate.fields.length, 1)
          const field = aggregate.fields.at(0) ?? unreachable('expected actual work field')
          assert.strictEqual(
            DeclarationFacts.fieldDeclaration(field.field).sourceId,
            snapshot.closure.rootModule,
          )
          assert.strictEqual(field.field.ordinal, 0)
          assert.strictEqual(
            source.slice(field.value.span.start, field.value.span.end),
            'move waiting',
          )
        } else {
          // Failed field admission publishes no concrete Holder type or executable MIR producer.
          assert.strictEqual(aggregate._tag, 'Unavailable')
        }
      }
    }
  }),
)

// Forming the primitive as a section must preserve the same selected-input recipe as a direct call.
it.effect('authenticates direct and staged primitive recovery recipes for owned inputs', () =>
  Effect.gen(function* () {
    const module = 'effect-typing/primitive-recovery-recipes'
    const snapshot = yield* AnalysisFixture.retainingMain(
      module,
      ascii(`struct Problem { value: i32 }
effect fn failed() -> never ! Problem { fail Problem { value: 21 } }
effect fn recovered(error: Problem) -> i32 { return error.value }
fn direct() -> i32 { return run Intrinsic.catchFailure<Problem>(failed(), recovered) }
fn staged() -> i32 {
  let recover = Intrinsic.catchFailure<Problem>(recovered)
  return run recover(failed())
}
pub fn main() -> i32 { return direct() + staged() }`),
      'wasm32-unknown-unknown',
      { normalizeMir: false },
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const checked = snapshot.results.get(module) ?? unreachable('expected checked authored module')
    for (const name of ['direct', 'staged']) {
      const body =
        checked.bodies.find(
          (candidate) =>
            candidate.declaration.name._tag === 'Present' &&
            candidate.declaration.name.spelling === name,
        ) ?? unreachable('expected actual primitive caller')
      const catches = body.function.statements
        .flatMap(Tir.statementExpressions)
        .flatMap(Tir.expressionTree)
        .filter((expression) => expression._tag === 'EffectCatch')
      assert.lengthOf(catches, 1, name)
      const caught = catches.at(0) ?? unreachable('expected selected primitive construction')
      const recipe =
        caught.recoveryInvocation ?? unreachable('expected authenticated conditional input')
      assert.strictEqual(recipe.owner.module, module)
      assert.strictEqual(recipe.owner.name, name)
      assert.deepEqual(recipe.binder.owner, { module: 'Intrinsic', name: 'catchFailure.handler' })
      assert.strictEqual(recipe.parameter, 0)
      assert.isTrue(Type.equals(recipe.selected, Type.nominal(module, 'Problem')))
      if (caught.origin._tag !== 'Authored') return unreachable('expected original primitive call')
      assert.deepEqual(recipe.origin, caught.origin.anchor)
    }
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
  }),
)

// CAPTURE-002 / EFFECT-OWN-002: an exclusive capture, whether written through a place or retained
// as an Effect operation operand, cannot hide behind a declared shared contract.
it.effect('rejects a shared declared contract over a retained exclusive capture', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
struct Cell { code: i32 }
interface Decoder { effect fn decode(value: &mut Self) -> i32 }
effect fn decodeCell(value: &Cell) -> i32 { return value.code }
impl Decoder for Cell { decode: Cell.decodeCell }
fn block(cell: &mut Cell) -> Effect<i32> { return effect { cell.code = 3 return 1 } }
fn callable(cell: &mut i32) -> fn() -> i32 { return fn() -> i32 { cell.* = 1 return 1 } }
fn operation<T: Decoder>(value: &mut T) -> Effect<i32> { return Decoder.decode(value) }
fn blockMut(cell: &mut Cell) -> mut Effect<i32> { return effect { cell.code = 3 return 1 } }
fn callableMut(cell: &mut i32) -> mut fn() -> i32 { return fn() -> i32 { cell.* = 1 return 1 } }
fn operationMut<T: Decoder>(value: &mut T) -> mut Effect<i32> { return Decoder.decode(value) }
pub fn main() -> i32 { return 0 }`
    const snapshot = yield* snapshotOf('effect-typing/exclusive-capture-contract', source)
    const spanOf = (text: string) => {
      const start = source.indexOf(text)
      return { start, end: start + text.length }
    }
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map(({ code, span }) => ({
        code,
        start: span.start,
        end: span.end,
      })),
      [
        { code: 'SEM0129', ...spanOf('effect { cell.code = 3 return 1 }') },
        { code: 'SEM0129', ...spanOf('fn() -> i32 { cell.* = 1 return 1 }') },
        // The rejected operand reborrow also fails to outlive the shared return contract.
        { code: 'OWN0019', ...spanOf('Decoder.decode(value)') },
        { code: 'SEM0129', ...spanOf('Decoder.decode(value)') },
      ],
    )
  }),
)
