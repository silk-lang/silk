import * as Context from 'effect/Context'
import * as LogLevel from 'effect/LogLevel'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as References from 'effect/References'
import * as Result from 'effect/Result'
import * as Tracer from 'effect/Tracer'

/** Synchronous compiler passes report bounded phases through an invocation-local observer. */
export type CompilerTrace = <A>(
  name: string,
  body: () => A,
  attributes?: Readonly<Record<string, string | number | boolean>>,
) => A

export const none: CompilerTrace = (_name, body) => body()

/**
 * Captures Effect's tracer, clock, and parent for synchronous pass/function boundaries.
 * The compiler's recursive instruction/type loops stay synchronous; no nested Effect runtime
 * or per-instruction spans are needed. The observer must not escape this invocation to a fiber.
 * Without an installed tracing backend, passes run directly instead of allocating unobserved spans.
 * Defects close their spans and are rethrown unchanged; results are never retained in spans.
 */
export const capture = Effect.fnUntraced(function* () {
  if (!(yield* References.TracerEnabled)) return none
  const tracer = yield* Tracer.Tracer
  if (tracer === Tracer.nativeTracer) return none
  const clock = yield* Clock.Clock
  const attributesFromContext = yield* References.TracerSpanAnnotations
  const links = yield* References.TracerSpanLinks
  const timing = yield* References.TracerTimingEnabled
  const level = yield* Tracer.CurrentTraceLevel
  const minimum = yield* Tracer.MinimumTraceLevel
  const now = () => (timing ? clock.currentTimeNanosUnsafe() : 0n)
  let parent = yield* Effect.serviceOption(Tracer.ParentSpan)
  const trace: CompilerTrace = (name, body, attributes) => {
    const previous = parent
    const span = tracer.span({
      name,
      parent,
      annotations: Context.empty(),
      links: [...links],
      startTime: now(),
      kind: 'internal',
      root: Option.isNone(parent),
      sampled:
        (Option.isNone(parent) || parent.value.sampled) && !LogLevel.isGreaterThan(minimum, level),
    })
    for (const [key, value] of Object.entries({ ...attributesFromContext, ...attributes }))
      span.attribute(key, value)
    parent = Option.some(span)
    const result = Result.try(body)
    parent = previous
    if (Result.isFailure(result)) {
      span.end(now(), Exit.die(result.failure))
      throw result.failure
    }
    span.end(now(), Exit.void)
    return result.success
  }
  return trace
})
