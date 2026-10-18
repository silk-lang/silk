import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'

/** Replaceable heap telemetry used by the driver without depending on a host runtime. */
export class HeapObservation extends Context.Service<
  HeapObservation,
  { readonly heapBytes: () => number }
>()('@silklang/compiler/HeapObservation') {}

/** Explicit zero-cost browser implementation for hosts without process heap telemetry. */
export const layerBrowser = Layer.succeed(HeapObservation, { heapBytes: () => 0 })

/** Deterministic test implementation; tests provide it instead of relying on an ambient default. */
export const layerTest = Layer.succeed(HeapObservation, { heapBytes: () => 0 })
