import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import * as ConformanceProof from '../src/ConformanceProof.js'
import * as Instances from '../src/Instances.js'
import * as RowAlgebra from '../src/RowAlgebra.js'
import * as SourceCallView from '../src/SourceCallView.js'
import * as Tir from '../src/Tir.js'
import * as Type from '../src/Type.js'
import { unreachable } from './support/raise.js'

const encoder = new TextEncoder()

const analyze = (source: string) => Analysis.ofSource('logging/main', encoder.encode(source))

/** Realizes the retained main without the default runtime; `silk.os_logger` needs a target. */
const realized = (source: string, target = 'aarch64-apple-darwin') =>
  AnalysisFixture.retainingMain('logging/main', encoder.encode(source), target)

it.effect('lowers logger entrypoints with dense runtime parameters after static arguments', () =>
  Effect.gen(function* () {
    const self = yield* realized(
      `import silk.effect { Effect }
import silk.logger { LogError }
import silk.os_logger { StdoutLogger }

pub effect fn main() -> () ! LogError {
  let mut logger = StdoutLogger.make()

  run Effect.log("Hello, world!", &())
    |> Effect.provideMut(&mut logger)
}`,
      'x86_64-unknown-linux-gnu',
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    const discovery = Analysis.instancesOf(self)
    const caller =
      discovery.instances.find((instance) => instance.key.declaration.name === 'Effect.log') ??
      unreachable('missing original logging caller')
    const subject = caller.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
      .find(
        (node): node is Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }> =>
          node._tag === 'ServiceEffectConstruct',
      )
    if (subject === undefined) return unreachable('missing held logging operation')
    const call = discovery.calls.find(
      (candidate) =>
        Instances.keyText(candidate.owner) === Instances.keyText(caller.key) &&
        candidate.node?.ordinal === subject.id?.ordinal,
    )
    if (call === undefined) return unreachable('missing original logging call')
    const implementation = discovery.instances.find(
      (instance) => Instances.keyText(instance.key) === Instances.keyText(call.target),
    )
    if (implementation === undefined) return unreachable('missing selected logger implementation')
    assert.deepEqual(
      implementation.function.declaration.parameters.map((parameter) => parameter.phase),
      ['Runtime', 'Runtime', 'Static', 'Runtime'],
    )
    assert.strictEqual(Instances.runtimeParameterOrdinal(implementation.function, 2), undefined)
    assert.strictEqual(Instances.runtimeParameterOrdinal(implementation.function, 3), 2)
    const layout = Analysis.loweredMir(self).layout
    const environment = layout.effectEnvironments.find(
      (candidate) =>
        candidate._tag === 'EffectEnvironment' &&
        Instances.keyText(candidate.instance) === Instances.keyText(call.target) &&
        Instances.effectIdentity(candidate.instance, candidate.site) === call.resultEffect,
    )
    if (environment?._tag !== 'EffectEnvironment')
      return unreachable('missing actual logger capture environment')
    assert.deepEqual(
      environment.fields.map((field) => field.ordinal),
      [0, 1, 3],
    )
    const receiver = implementation.specialization.parameters.at(0)
    if (receiver === undefined || !Type.isReference(receiver) || !Type.isNominal(receiver.target))
      return unreachable('missing original logger receiver')
    const capability = Type.substitute(subject.service, caller.substitution)
    if (!Type.isNominal(capability)) return unreachable('missing original logger capability')
    const witness = ConformanceProof.witness(
      Analysis.declarationIndex(self),
      receiver.target,
      capability,
    )
    if (witness?._tag !== 'SourceConformanceWitness')
      return unreachable('missing original logger witness')
    const provider = {
      capability,
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
      layout,
      semantic: (type: Type.Type) => Type.substitute(type, caller.substitution),
    }
    assert.isDefined(SourceCallView.service(held, subject, call, provider, environment.effect))
    const staticCapture = {
      ...layout,
      effectEnvironments: layout.effectEnvironments.map((candidate) =>
        candidate === environment
          ? {
              ...environment,
              fields: environment.fields.map((field) =>
                field.ordinal === 3 ? { ...field, ordinal: 2 } : field,
              ),
            }
          : candidate,
      ),
    }
    assert.isUndefined(
      SourceCallView.service(
        { ...held, layout: staticCapture },
        subject,
        call,
        provider,
        environment.effect,
      ),
    )
    // Re-label every physical identity consistently: an unchanged original call still cannot
    // authorize another static template, even when copied physical metadata agrees with itself.
    const changedKey = {
      ...call.target,
      staticArguments: [{ _tag: 'TextValue' as const, bytes: [120] }],
    }
    const changedCall = {
      ...call,
      target: changedKey,
      resultEffect: Instances.effectIdentity(changedKey, environment.site),
    }
    const changedImplementation = { ...implementation, key: changedKey }
    const changedLayout = {
      ...layout,
      effectEnvironments: layout.effectEnvironments.map((candidate) =>
        candidate === environment ? { ...environment, instance: changedKey } : candidate,
      ),
    }
    assert.isUndefined(
      SourceCallView.service(
        {
          ...held,
          instances: discovery.instances.map((candidate) =>
            candidate === implementation ? changedImplementation : candidate,
          ),
          calls: discovery.calls.map((candidate) => (candidate === call ? changedCall : candidate)),
          layout: changedLayout,
        },
        subject,
        changedCall,
        provider,
        environment.effect,
      ),
    )
    yield* Analysis.codegen(self, { mode: 'release' })
  }),
)

it.effect('specializes static logging templates without exposing formatting requirements', () =>
  Effect.gen(function* () {
    const self = yield* realized(`import silk.effect { Effect }
import silk.logger { LogError, LogLevel, Logger }

effect fn exercise(level: LogLevel) -> () ! LogError ? &mut Logger {
  let args = .{ name: "Julia", count: 2 }
  run Effect.log("literal", &())
  run Effect.logDebug("{} {}", &(1, "two"))
  run Effect.logWarning("{name} {count}", &args)
  run Effect.logAt(level, "temporary {}", &("pack",))
  return ()
}

effect fn program() -> () ! LogError {
  let mut logger = Logger.inMemoryProvider()
  let level = LogLevel.Warning
  return run exercise(level) |> Effect.provideMut(&mut logger)
}
effect fn ignore(error: LogError) -> () { return () }
pub fn main() -> i32 {
  run Effect.catchAll(program(), ignore)
  return 42
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.strictEqual(self.mir._tag, 'Available')
  }),
)

it.effect('applies Format template and Display diagnostics to logging calls', () =>
  Effect.gen(function* () {
    // Template diagnostics come from static specialization, which only realization performs.
    const self = yield* realized(`import silk.effect { Effect }
import silk.logger { LogError, Logger }
effect fn invalid() -> () ! LogError ? &mut Logger {
  run Effect.log("open {", &(1,))
  run Effect.log("{}{}", &(1,))
  run Effect.log("{missing}", &.{ name: "Julia" })
  return run Effect.log("{enabled}", &.{ enabled: true })
}
effect fn program() -> () ! LogError {
  let mut logger = Logger.inMemoryProvider()
  return run invalid() |> Effect.provideMut(&mut logger)
}
effect fn ignore(error: LogError) -> () { return () }
pub fn main() -> i32 {
  run Effect.catchAll(program(), ignore)
  return 42
}`)
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => ({
        code: diagnostic.code,
        span: [diagnostic.span.sourceId, diagnostic.span.start, diagnostic.span.end],
      })),
      [
        { code: 'SEM0177', span: ['logging/main', 146, 147] },
        { code: 'SEM0177', span: ['logging/main', 175, 179] },
        { code: 'SEM0177', span: ['logging/main', 207, 216] },
        { code: 'SEM0083', span: ['silk/format', 15516, 15537] },
      ],
    )
  }),
)

it.effect(
  'keeps missing providers and invalid logging inputs explicit',
  () =>
    Effect.gen(function* () {
      const missing = yield* analyze(`import silk.effect { Effect }
import silk.logger { LogError }
pub effect fn main() -> () ! LogError {
  return run Effect.log("missing", &())
}`)
      assert.include(
        Analysis.diagnostics(missing).map((diagnostic) => diagnostic.code),
        'SEM0071',
      )

      const invalidMessage = yield* analyze(`import silk.effect { Effect }
pub fn main() -> i32 {
  let effect = Effect.log(42, &())
  return 0
}`)
      assert.isAbove(Analysis.diagnostics(invalidMessage).length, 0)

      const invalidLevel = yield* analyze(`import silk.effect { Effect }
pub fn main() -> i32 {
  let effect = Effect.logAt(42, "message", &())
  return 0
}`)
      assert.isAbove(Analysis.diagnostics(invalidLevel).length, 0)
    }),
  { timeout: 60_000 },
)

it.effect('forwards provider-selection evidence only from an exact enclosing constraint', () =>
  Effect.gen(function* () {
    const wrapper = (constraint: string) => `import silk.os_logger { StdoutLogger }
import silk.effect { Effect }
import silk.logger { Logger, LogError }

effect fn bind<?S, A, P, E, ?R>(
  self: once Effect<A ! E ? R>,
  provider: &mut P
) -> A ! E ? Without<R, S>
${constraint} {
  return run Intrinsic.bindRequirementMut<S>(move self, provider)
}

effect fn read() -> () ! LogError ? &mut Logger {
  run Effect.log("Reading", &())
}

pub effect fn main() -> () ! LogError {
  let mut logger = StdoutLogger.make()
  return run bind(read(), &mut logger)
}`

    const constrained = yield* realized(wrapper('where &mut P provides S from R'))
    assert.deepEqual(Analysis.diagnostics(constrained), [])
    const bind = Analysis.instancesOf(constrained).instances.find(
      (instance) => instance.key.declaration.name === 'bind',
    )
    assert.isDefined(bind)
    if (bind !== undefined) {
      assert.strictEqual(
        RowAlgebra.concretize(
          Type.requirementRowPolicy(),
          bind.specialization.requirementRow ??
            RowAlgebra.concrete(Type.requirementRowPolicy(), []),
        )._tag,
        'Concrete',
      )
      assert.isTrue(bind.specialization.evidence.length > 0)
      assert.include(
        bind.specialization.evidence.map((proof) => proof._tag),
        'RequirementSelection',
      )
    }

    const unconstrained = yield* realized(wrapper(''))
    assert.isAbove(Analysis.diagnostics(unconstrained).length, 0)
  }),
)

it.effect('rejects a callable relay whose leading binding has observable work', () =>
  Effect.gen(function* () {
    const self = yield* realized(`import silk.logger { InMemoryLogger }
import silk.effect { Effect }
import silk.logger { Logger }

fn observeThenForward<F>(value: F) -> F {
  let boom = 1 / 0
  return move value
}

effect fn read() -> i32 ? &mut Logger { return 42 }

pub fn main() -> i32 {
  let mut logger = Logger.inMemoryProvider()
  let bind = observeThenForward(Effect.provideMut<Logger>(&mut logger))
  return run bind(read())
}`)
    assert.include(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      'SEM0122',
    )
    assert.strictEqual(self.mir._tag, 'Unavailable')
  }),
)

it.effect(
  'rejects constrained provider sections at aggregate generic and indirect boundaries',
  () =>
    Effect.gen(function* () {
      const cases = [
        `import silk.effect { Effect }
import silk.logger { InMemoryLogger }
import silk.logger { Logger }
fn store<F>(value: F) -> [F; 1] {
  return [move value]
}
pub fn main() -> i32 {
  let mut logger = Logger.inMemoryProvider()
  let escaped = store(Effect.provideMut<Logger>(&mut logger))
  return 42
}`,
        `import silk.effect { Effect }
import silk.logger { InMemoryLogger }
import silk.logger { Logger }
fn consume<F>(value: F) -> () { return () }
pub fn main() -> i32 {
  let mut logger = Logger.inMemoryProvider()
  let consumed = consume(Effect.provideMut<Logger>(&mut logger))
  return 42
}`,
        `import silk.effect { Effect }
import silk.logger { InMemoryLogger }
import silk.logger { Logger }
fn consume<F>(value: F) -> () { return () }
pub fn main() -> i32 {
  let mut logger = Logger.inMemoryProvider()
  let operation = Effect.provideMut<Logger>(&mut logger)
  let consumed = consume(move operation)
  return 42
}`,
        `import silk.effect { Effect }
import silk.logger { InMemoryLogger }
import silk.logger { Logger }
union Store<F> { Empty, Stored { value: F } }
pub fn main() -> i32 {
  let mut logger = Logger.inMemoryProvider()
  let escaped = Store.Stored { value: Effect.provideMut<Logger>(&mut logger) }
  return 42
}`,
      ]
      for (const [ordinal, body] of cases.entries()) {
        const self = yield* realized(`import silk.effect { Effect }
import silk.logger { Logger, LogError }
${body}`)
        assert.include(
          Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
          'SEM0122',
          `case ${ordinal}`,
        )
        assert.strictEqual(self.mir._tag, 'Unavailable')
      }
    }),
  { timeout: 60_000 },
)
