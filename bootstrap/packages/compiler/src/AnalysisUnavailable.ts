import * as Data from 'effect/Data'

/** A valid runtime phase intentionally withheld because source specialization is invalid. */
export class AnalysisUnavailable extends Data.TaggedError('AnalysisUnavailable')<{
  readonly operation: 'Analysis.realize'
  readonly message: string
}> {}
