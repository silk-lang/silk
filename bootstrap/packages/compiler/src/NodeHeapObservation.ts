import { memoryUsage } from 'node:process'
import * as Layer from 'effect/Layer'
import * as HeapObservation from './HeapObservation.js'

/** Node implementation of compiler heap telemetry, provided at an application edge. */
export const layer = Layer.succeed(HeapObservation.HeapObservation, {
  heapBytes: () => memoryUsage().heapUsed,
})
