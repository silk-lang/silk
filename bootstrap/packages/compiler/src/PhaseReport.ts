import type * as BodyQuery from './BodyQuery.js'
import type * as Instances from './Instances.js'
import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'

/** Deterministic semantic-revision counts attached to the invalidation phase. */
export interface SemanticInvalidationCounters {
  readonly _tag: 'SemanticInvalidationCounters'
  readonly reusable: number
  readonly recomputed: number
  readonly fresh: number
  readonly localChange: number
  readonly opaqueBodyChange: number
  readonly opaqueTargetChange: number
  readonly opaqueLayoutChange: number
  readonly dependencySurfaceChange: number
  readonly cyclicPeerChange: number
  readonly environmentChange: number
  readonly surfaceChange: number
}

/** Deterministic module-work counts attached to incrementally reusable semantic phases. */
export interface ModuleReuseCounters {
  readonly _tag: 'ModuleReuseCounters'
  readonly reused: number
  readonly recomputed: number
}

export type Counters =
  | SemanticInvalidationCounters
  | ModuleReuseCounters
  | BodyQuery.Counters
  | Instances.Counters

/** One compiler or artifact-production phase's operational observation. */
export interface PhaseReport {
  readonly phase: string
  readonly elapsedMs: number
  readonly inputs: number
  readonly outputs: number
  readonly diagnostics: number
  readonly heapBytes?: number
  readonly counters?: Counters
}

/** One measured value paired with the phase observation produced while computing it. */
export interface Measured<A> {
  readonly value: A
  readonly report: PhaseReport
}

export interface MeasurementOptions<A = never> {
  readonly heapBytes?: () => number
  readonly counters?: (value: A) => Counters
}

/** Constructs one immutable phase observation. */
export const make = (options: {
  readonly phase: string
  readonly elapsedMs: number
  readonly inputs: number
  readonly outputs: number
  readonly diagnostics: number
  readonly heapBytes?: number
  readonly counters?: Counters
}): PhaseReport => ({ ...options })

/** Measures one synchronous compiler phase without making its deterministic result time-dependent. */
export const measure = <A>(
  phase: string,
  inputs: number,
  run: () => A,
  outputs: (value: A) => number,
  diagnostics: (value: A) => number = () => 0,
  options: MeasurementOptions<A> = {},
): Measured<A> => {
  const startedAt = performance.now()
  const value = run()
  const observedHeap = options.heapBytes?.()
  const counters = options.counters?.(value)
  return {
    value,
    report: make({
      phase,
      elapsedMs: performance.now() - startedAt,
      inputs,
      outputs: outputs(value),
      diagnostics: diagnostics(value),
      ...(observedHeap === undefined ? {} : { heapBytes: observedHeap }),
      ...(counters === undefined ? {} : { counters }),
    }),
  }
}

/** Measures a synchronous phase and appends its observation to an accumulating report. */
export const measureInto = <A>(
  report: Array<PhaseReport>,
  phase: string,
  inputs: number,
  run: () => A,
  outputs: (value: A) => number,
  diagnostics: (value: A) => number = () => 0,
  options: MeasurementOptions<A> = {},
): A => {
  const measured = measure(phase, inputs, run, outputs, diagnostics, options)
  report.push(measured.report)
  return measured.value
}

/** Measures one Effect phase using the fiber clock. */
export const measureEffect = Effect.fnUntraced(function* <A, E, R>(
  phase: string,
  inputs: number,
  effect: Effect.Effect<A, E, R>,
  outputs: (value: A) => number,
  diagnostics: (value: A) => number = () => 0,
  options: MeasurementOptions<A> = {},
): Effect.fn.Return<Measured<A>, E, R> {
  const startedAt = yield* Clock.currentTimeNanos
  const value = yield* effect
  const finishedAt = yield* Clock.currentTimeNanos
  const observedHeap = options.heapBytes?.()
  const counters = options.counters?.(value)
  return {
    value,
    report: make({
      phase,
      elapsedMs: Duration.toMillis(Duration.nanos(finishedAt - startedAt)),
      inputs,
      outputs: outputs(value),
      diagnostics: diagnostics(value),
      ...(observedHeap === undefined ? {} : { heapBytes: observedHeap }),
      ...(counters === undefined ? {} : { counters }),
    }),
  }
})

/** Measures one Effect phase and appends its observation without duplicating timing policy. */
export const measureEffectInto = Effect.fnUntraced(function* <A, E, R>(
  report: Array<PhaseReport>,
  phase: string,
  inputs: number,
  effect: Effect.Effect<A, E, R>,
  outputs: (value: A) => number,
  diagnostics: (value: A) => number = () => 0,
  options: MeasurementOptions<A> = {},
): Effect.fn.Return<A, E, R> {
  const measured = yield* measureEffect(phase, inputs, effect, outputs, diagnostics, options)
  report.push(measured.report)
  return measured.value
})
