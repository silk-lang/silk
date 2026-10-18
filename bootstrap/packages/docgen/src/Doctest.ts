import * as EffectResult from 'effect/Result'
import * as Analysis from '@silklang/compiler/Analysis'
import * as Effect from 'effect/Effect'
import * as Example from './Example.js'
import * as Model from './Model.js'
import * as Sources from './Sources.js'

/**
 * Compiles the fenced Silk examples of one documentation value.
 *
 * An example is compiled as one complete module, exactly as written. Nothing is prepended, nothing
 * wraps it, and it is never concatenated with the module that documents it — Silk has no implicit
 * prelude and no single entry shape that would make a synthesized wrapper right for both a pure
 * fragment and one that runs effects, so a fragment opts out instead of being guessed at.
 */

/** Why one example failed. */
export type Reason =
  | { readonly _tag: 'UnknownAttribute'; readonly attributes: ReadonlyArray<string> }
  | { readonly _tag: 'Diagnostics'; readonly diagnostics: ReadonlyArray<string> }

export type Outcome =
  | { readonly _tag: 'Passed' }
  | { readonly _tag: 'Skipped' }
  | { readonly _tag: 'Failed'; readonly reason: Reason }

/** One example, where it came from, and what happened to it. */
export interface Result {
  readonly example: Example.Example
  /** The one-based line of the fence, absent when the source bytes could not be supplied. */
  readonly line?: number
  readonly outcome: Outcome
}

export interface Report {
  readonly results: ReadonlyArray<Result>
  readonly collected: number
  readonly passed: number
  readonly skipped: number
  readonly failed: number
}

export interface Options {
  /** A documentation JSON value, whether freshly built or parsed from a file. */
  readonly documentation: unknown
  readonly sources?: Sources.Lookup
  readonly target?: string
}

/** The target examples compile against unless the caller names another. */
export const defaultTarget = 'wasm32-unknown-unknown'

const encoder = new TextEncoder()

const compile = Effect.fnUntraced(function* (example: Example.Example, target: string) {
  const identity = `doctest/${example.source.sourceId.replace(/[^A-Za-z0-9_-]/g, '-')}/${example.source.start}`
  const attempted = yield* Effect.result(
    Analysis.ofSourceRealized(identity, encoder.encode(example.code), target),
  )
  if (EffectResult.isFailure(attempted)) return Object.freeze([attempted.failure.message])
  const snapshot = attempted.success
  const diagnostics = Analysis.diagnostics(snapshot).map(
    (diagnostic) => `${diagnostic.code}: ${diagnostic.message}`,
  )
  const unresolved = Analysis.resolutionFailures(snapshot).map(
    (failure) => `unresolved module ${failure.module}: ${failure.message}`,
  )
  return Object.freeze([...diagnostics, ...unresolved])
})

const outcomeOf = Effect.fnUntraced(function* (example: Example.Example, target: string) {
  // An attribute the workflow does not define is checked before the opt-out, so a misspelled
  // marker cannot pass as one: the author believed the example was skipped, and only a failure
  // tells them it was not.
  if (example.unknownAttributes.length > 0)
    return Object.freeze({
      _tag: 'Failed',
      reason: Object.freeze({
        _tag: 'UnknownAttribute',
        attributes: example.unknownAttributes,
      }),
    })
  if (example.ignored) return Object.freeze({ _tag: 'Skipped' })
  const diagnostics = yield* compile(example, target)
  return diagnostics.length === 0
    ? Object.freeze({ _tag: 'Passed' })
    : Object.freeze({
        _tag: 'Failed',
        reason: Object.freeze({ _tag: 'Diagnostics', diagnostics }),
      })
})

/**
 * Collects and compiles every fenced Silk example, in the documentation value's own source order.
 *
 * A run that collects nothing reports zero collected examples rather than success. An empty run and
 * a verified run are not the same outcome, and a workflow that cannot tell them apart is a workflow
 * that might be compiling nothing.
 */
export const run = Effect.fn('Doctest.run')(function* (
  options: Options,
): Effect.fn.Return<Report, never, never> {
  const lookup = options.sources ?? Sources.empty
  const decoded = Model.decode(options.documentation)
  const profile = decoded._tag === 'Decoded' ? decoded.documentation.profile : undefined
  const target = options.target ?? profile?.target ?? defaultTarget
  const examples = Example.collect(options.documentation)
  const results: Array<Result> = []
  for (const example of examples) {
    const outcome = yield* outcomeOf(example, target)
    const line = Sources.lineOf(lookup, example.source.sourceId, example.source.start)
    results.push(Object.freeze({ example, ...(line === undefined ? {} : { line }), outcome }))
  }
  return Object.freeze({
    results: Object.freeze(results),
    collected: results.length,
    passed: results.filter((result) => result.outcome._tag === 'Passed').length,
    skipped: results.filter((result) => result.outcome._tag === 'Skipped').length,
    failed: results.filter((result) => result.outcome._tag === 'Failed').length,
  })
})

/** True when at least one example failed. Drives the command-line exit status. */
export const hasFailures = (self: Report): boolean => self.failed > 0
