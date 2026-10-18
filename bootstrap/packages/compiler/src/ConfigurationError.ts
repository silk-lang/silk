import * as Data from 'effect/Data'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import type * as Evaluation from './Evaluation.js'

export type Code =
  | 'InvalidInput'
  | 'UnsupportedCombination'
  | 'ForbiddenProvenance'
  | 'UnknownParameter'
  | 'PrivateParameter'
  | 'MissingParameter'
  | 'ConflictingBindings'
  | 'InvalidType'
  | 'InvalidDefault'
  | 'ValidationFailed'
  | 'DependencyCycle'
  | 'PackageIdentityConflict'

/** A rejected logical input, schema or binding. Messages never interpolate binding values. */
export class ConfigurationError extends Data.TaggedError('ConfigurationError')<{
  readonly operation: string
  readonly code: Code
  readonly subject: string
  readonly message: string
  readonly origins: ReadonlyArray<ConfigurationOrigin.ConfigurationOrigin>
  readonly dependencies: ReadonlyArray<string>
  readonly staticFailure?: Evaluation.StaticFailure
}> {}

/** Constructs one stable diagnostic from logical identity and current-request provenance. */
export const make = (
  operation: string,
  code: Code,
  subject: string,
  origins: ReadonlyArray<ConfigurationOrigin.ConfigurationOrigin> = [],
  dependencies: ReadonlyArray<string> = [],
  staticFailure?: Evaluation.StaticFailure,
): ConfigurationError =>
  new ConfigurationError({
    operation,
    code,
    subject,
    message: `${code}: ${subject}`,
    origins: origins.map(ConfigurationOrigin.snapshot),
    dependencies: [...dependencies],
    ...(staticFailure === undefined ? {} : { staticFailure }),
  })
