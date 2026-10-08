import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as ExecutableInputView from '../src/ExecutableInputView.js'
import * as Lifetime from '../src/Lifetime.js'
import * as Mir from '../src/Mir.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Tir from '../src/Tir.js'
import * as Type from '../src/Type.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { nativeCorpus } from './support/corpus.js'
import { unreachable } from './support/raise.js'

const bytes = (source: string): Uint8Array => new TextEncoder().encode(source)
const proofOf = (source: Mir.ExecutableInputViewSource): Mir.ExecutableInputView => ({
  owner: source.call.owner,
  callNode: source.call.node ?? unreachable('expected original checked call node'),
  view: source.selected,
})

/** Changes copied call metadata while preserving the independently held source lifetime flow. */
const replaceSourceView = (
  source: Mir.ExecutableInputViewSource,
  original: Tir.ExecutableInputView,
): Mir.ExecutableInputViewSource => {
  const node = source.caller.function.statements
    .flatMap(Tir.statementExpressions)
    .flatMap(Tir.expressionTree)
    .find((expression) => expression.id?.ordinal === source.call.node?.ordinal)
  if (node?._tag !== 'Call' && node?._tag !== 'EffectConstruct')
    return unreachable('expected actual checked call')
  const replaced = {
    ...node,
    inputViews: node.inputViews?.map((view) =>
      view.parameter.ordinal === original.parameter.ordinal ? original : view,
    ),
  }
  const substitute = (value: unknown): unknown => {
    if (value === node) return replaced
    if (Array.isArray(value)) return value.map(substitute)
    if (value === null || typeof value !== 'object' || value instanceof Map || value instanceof Set)
      return value
    return {
      ...value,
      ...Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)])),
    }
  }
  const caller = {
    ...source.caller,
    function: {
      ...source.caller.function,
      statements: substitute(source.caller.function.statements) as ReadonlyArray<Tir.Statement>,
    },
  }
  const selected = Tir.substituteExecutableInputView(
    original,
    caller.substitution,
    caller.specialization.compatibility,
  )
  const inputViews = source.call.inputViews ?? unreachable('expected held selected call views')
  return {
    ...source,
    caller,
    original,
    selected,
    call: {
      ...source.call,
      inputViews: inputViews.map((view) =>
        view.parameter.ordinal === selected.parameter.ordinal ? selected : view,
      ),
    },
  }
}

it.effect(
  'replays stored producer lineage and refuses copied or altered invocation selections',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'input-view/stored-producer',
        bytes(`struct Owner { value: i32 }
struct Guard { offset: i32 }
impl Drop for Guard { fn drop(self: &mut Guard) -> () { return () } }
effect<'held> fn recovered<'data: 'held, 'held>(owner: &'data Owner, guard: Guard) -> i32 {
  return owner.value + guard.offset
}
effect<'data> fn apply<'data>(owner: &'data Owner,
  callback: for<use 'call> once fn<'static>(&'data Owner) -> once Effect<'call; i32>
) -> i32 { return run callback(owner) }
fn probe<'data>(owner: &'data Owner) -> i32 {
  let other = recovered(Guard { offset: 3 })
  drop other
  let base = recovered
  let selected = base(Guard { offset: 2 })
  return run apply<'data>(owner, move selected)
}
pub fn main() -> i32 { let owner = Owner { value: 40 } return probe(&owner) }`),
        'wasm32-unknown-unknown',
        { normalizeMir: false },
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const program = Analysis.loweredMir(snapshot)
      assert.deepEqual(yield* MirVerification.verify(program), [])
      const sources = ExecutableInputView.catalog(
        snapshot.instances.instances,
        snapshot.instances.calls,
      )
      const source =
        sources.find((item) => item.selected.invocationSource !== undefined) ??
        unreachable('expected original stored admission')
      const stored = source.original.invocationSource ?? unreachable('expected original producer')
      assert.strictEqual(ExecutableInputView.authenticate(sources, proofOf(source)), source)
      const view = program.functions
        .flatMap((fn) => fn.localTypes)
        .find(
          (local) =>
            local._tag === 'CallableValue' && local.inputView?.view.invocationSource !== undefined,
        )
      if (view?._tag !== 'CallableValue') return unreachable('expected physical stored view')
      assert.isDefined(ExecutableInputView.physicalCallable(program, view))
      const refuse = (invocationSource: typeof stored): void => {
        const copied = replaceSourceView(source, { ...source.original, invocationSource })
        assert.isUndefined(ExecutableInputView.authenticate([copied], proofOf(copied)))
      }
      refuse({ ...stored, parameters: [1] })
      refuse({ ...stored, originalInputs: [0] })
      refuse({ ...stored, producers: stored.producers.slice(1) })
      refuse({
        ...stored,
        producers: stored.producers.map((producer) =>
          producer.binding === undefined
            ? producer
            : {
                ...producer,
                binding: { ...producer.binding, ordinal: producer.binding.ordinal + 1 },
              },
        ),
      })
      refuse({
        ...stored,
        captures: stored.captures.map((capture) => ({
          ...capture,
          capturePath: [{ _tag: 'Capture', site: capture.leaf, ordinal: capture.capture + 1 }],
        })),
      })
      if (!Type.isCallable(source.original.actual)) return unreachable('expected original callable')
      const rawBinder = source.original.actual.schema?.binders.at(0)
      if (rawBinder === undefined) return unreachable('expected original deferred binder')
      refuse({
        ...stored,
        originalSubstitution: new Map([[Type.key(rawBinder), Lifetime.staticLifetime]]),
      })
      const substitution = new Map(stored.selected.schema?.substitution)
      const binder = stored.selected.schema?.invocationAdapter?.lifetimes.at(0)?.parameter
      if (binder === undefined || stored.selected.schema === undefined)
        return unreachable('expected original selected deferred region')
      substitution.set(Type.key(binder), Lifetime.staticLifetime)
      refuse({
        ...stored,
        selected: { ...stored.selected, schema: { ...stored.selected.schema, substitution } },
      })
      const foreign = program.layout.callableEnvironments.find(
        (environment) =>
          environment._tag === 'CallableEnvironment' && environment !== view.environment,
      )
      if (foreign?._tag !== 'CallableEnvironment')
        return unreachable('expected real different environment')
      assert.isUndefined(
        ExecutableInputView.physicalCallable(program, { ...view, environment: foreign }),
      )
    }),
)

it.effect('authenticates held source domains and refuses stale executable input evidence', () =>
  Effect.gen(function* () {
    const program =
      nativeCorpus.find((item) => item.name === 'effect-borrowed-recovery-owned-cleanup') ??
      unreachable('expected canonical source')
    const snapshot = yield* AnalysisFixture.retainingMain(
      'input-view/original-source',
      bytes(program.source),
      'wasm32-unknown-unknown',
      { normalizeMir: false },
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const sources = ExecutableInputView.catalog(
      snapshot.instances.instances,
      snapshot.instances.calls,
    )
    const source =
      sources.find(
        (item) =>
          item.selected.target.name === 'Effect.catchAll' &&
          Type.isCallable(item.selected.actual) &&
          item.selected.actual.schema !== undefined,
      ) ?? unreachable('expected original captured callback source')
    const proof = proofOf(source)
    assert.strictEqual(ExecutableInputView.authenticate(sources, proof), source)
    const retained: Mir.ExecutableInputViewSource = {
      ...source,
      caller: {
        ...source.caller,
        view: {
          ...source.caller.view,
          causes: [
            ...source.caller.view.causes,
            {
              _tag: 'DiagnosticIdentity',
              phase: 'semantic',
              code: 'SEM0006',
              ordinal: 0,
              span: { _tag: 'At', anchor: source.original.call },
            },
          ],
        },
      },
    }
    assert.strictEqual(ExecutableInputView.authenticate([retained], proof), retained)
    const first = source.caller.function.statements.at(0) ?? unreachable('expected held statement')
    for (const unavailable of [
      { ...first, _tag: 'UnavailableStatement' },
      {
        ...first,
        _tag: 'Evaluate',
        expression: {
          _tag: 'Unavailable',
          span: first.span,
          origin: first.origin,
          cause: { _tag: 'TirCause', ordinal: 0 },
        },
      },
    ] satisfies ReadonlyArray<Tir.Statement>) {
      const fn = {
        ...source.caller.function,
        statements: [unavailable, ...source.caller.function.statements],
      }
      const active: Mir.ExecutableInputViewSource = {
        ...retained,
        caller: {
          ...retained.caller,
          function: fn,
          view: { ...retained.caller.view, function: fn },
        },
      }
      assert.isUndefined(ExecutableInputView.authenticate([active], proof))
    }
    const refuse = (view: typeof proof.view): void => {
      assert.isUndefined(ExecutableInputView.authenticate(sources, { ...proof, view }))
    }
    refuse({ ...proof.view, call: proof.view.operandOrigin })
    refuse({
      ...proof.view,
      operand: { ...proof.view.operand, artifact: source.callee.view.artifact },
    })
    const foreign = Lifetime.local({ module: 'input-view/foreign', name: 'unheld' }, 'loan', 0)
    const offered = { longer: foreign, shorter: Lifetime.staticLifetime }
    const rejectCopiedPremises = (original: Tir.ExecutableInputView): void => {
      const copied = replaceSourceView(source, original)
      assert.isUndefined(ExecutableInputView.authenticate([copied], proofOf(copied)))
    }
    rejectCopiedPremises({
      ...source.original,
      premises: {
        ...source.original.premises,
        obligations: [...source.original.premises.obligations, offered],
      },
    })
    const domain =
      source.caller.view.lifetimes?.sourcePremises ??
      unreachable('expected original independent source domain')
    const finite =
      source.original.premises.obligations.find(
        (bound) => !Lifetime.outlives(domain.assumptions, bound.longer, bound.shorter),
      ) ??
      unreachable('expected a genuine finite obligation outside universal declaration assumptions')
    rejectCopiedPremises({
      ...source.original,
      premises: {
        ...source.original.premises,
        bounds: [...source.original.premises.bounds, finite],
      },
    })
    refuse({ ...proof.view, parameter: { ...proof.view.parameter, source: proof.view.call } })
    refuse({
      ...proof.view,
      premises: {
        ...proof.view.premises,
        bounds: [...proof.view.premises.bounds, offered],
        obligations: [...proof.view.premises.obligations, offered],
      },
    })
    const actual = proof.view.actual
    if (!Type.isCallable(actual) || actual.schema === undefined)
      return unreachable('expected real original hidden schema')
    const schema = actual.schema
    const result = schema.contract.result
    if (!Type.isEffect(result)) return unreachable('expected original deferred recovery result')
    const altered = [
      {
        ...schema.contract,
        result: { ...result, success: 'bool' as const },
      },
      { ...schema.contract, lifetimeBinders: [] },
      {
        ...schema.contract,
        captures: [{ parameter: 0, capture: 0 }],
      },
    ]
    assert.isAbove(schema.contract.lifetimeBinders.length, 0)
    assert.isAbove(schema.contract.parameters.length, 1)
    for (const contract of altered) {
      const forged = { ...actual, schema: { ...schema, contract } }
      // Keep the old cached schema key: the actual structured source blueprint must be replayed.
      assert.strictEqual(forged.schema.contractKey, schema.contractKey)
      refuse({ ...proof.view, actual: forged })
    }
  }),
)

it.effect(
  'refuses an equal-type operand and a foreign physical producer at an accepted call edge',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'input-view/physical-source',
        bytes(`effect fn first() -> i32 { return 1 }
effect fn second() -> i32 { return 2 }
effect fn consume(input: once Effect<'static; i32>) -> i32 { return 0 }
pub fn main() -> i32 {
  let firstRun = run consume(first())
  let secondRun = run consume(second())
  return firstRun + secondRun
}`),
        'wasm32-unknown-unknown',
        { normalizeMir: false },
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const mir = Analysis.loweredMir(snapshot)
      assert.deepEqual(yield* MirVerification.verify(mir), [])
      const sources =
        mir.executableInputViews ?? unreachable('expected independently held call edges')
      const calls = sources.filter((source) => source.selected.target.name === 'consume')
      assert.lengthOf(calls, 2)
      const first = calls.at(0) ?? unreachable('expected first original input')
      const second = calls.at(1) ?? unreachable('expected second original input')
      assert.isTrue(Type.equals(first.selected.actual, second.selected.actual))
      const proof = proofOf(first)
      assert.strictEqual(ExecutableInputView.authenticate(sources, proof), first)
      assert.isUndefined(
        ExecutableInputView.authenticate(sources, {
          ...proof,
          view: {
            ...proof.view,
            operand: second.selected.operand,
            operandOrigin: second.selected.operandOrigin,
          },
        }),
      )
      const viewed = mir.functions.flatMap((fn, functionOrdinal) =>
        fn.localTypes.flatMap((local, localOrdinal) =>
          local._tag === 'EffectValue' && local.inputView !== undefined
            ? [{ fn, functionOrdinal, local, localOrdinal }]
            : [],
        ),
      )
      const original =
        viewed.find(
          (item) => item.local.inputView?.callNode.ordinal === first.call.node?.ordinal,
        ) ?? unreachable('expected physical descriptor with original input view')
      const foreign =
        viewed.find(
          (item) => item.local.inputView?.callNode.ordinal === second.call.node?.ordinal,
        ) ?? unreachable('expected distinct real physical producer')
      assert.isTrue(Type.equals(original.local.type, foreign.local.type))
      const changed = {
        ...mir,
        functions: mir.functions.map((fn, ordinal) =>
          ordinal !== original.functionOrdinal
            ? fn
            : {
                ...fn,
                localTypes: fn.localTypes.map((local, localOrdinal) =>
                  localOrdinal !== original.localOrdinal
                    ? local
                    : {
                        ...original.local,
                        site: foreign.local.site,
                        environment: foreign.local.environment,
                      },
                ),
              },
        ),
      }
      const violations = yield* MirVerification.verify(changed)
      assert.isTrue(
        violations.some(
          (violation) =>
            violation.detail ===
            'executable input view lacks its original checked call edge or physical producer',
        ),
      )
    }),
)
