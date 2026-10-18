import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import * as Canonical from './internal/Canonical.js'

/** Serializable transport data. Declared Silk types are checked separately during bootstrap. */
export type ConfigurationValue =
  | { readonly kind: 'integer'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'enum'; readonly type: string; readonly member: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'some'; readonly value: ConfigurationValue }
  | { readonly kind: 'array'; readonly values: ReadonlyArray<ConfigurationValue> }
  | { readonly kind: 'record'; readonly fields: Readonly<Record<string, ConfigurationValue>> }

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)

const exactKeys = (input: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Object.keys(input).length === keys.length && keys.every((key) => Object.hasOwn(input, key))

/**
 * Validates finite external data before recursive type conversion. The depth bound also rejects
 * cyclic JavaScript inputs; the transport has no object identity or reference syntax.
 */
const inspect = (
  input: unknown,
  origin: ConfigurationOrigin.ConfigurationOrigin,
  depth: number,
): Result.Result<ConfigurationValue, ConfigurationError.ConfigurationError> => {
  const fail = () =>
    Result.fail(
      ConfigurationError.make('ConfigurationValue.decode', 'InvalidInput', 'configuration value', [
        origin,
      ]),
    )
  if (depth > 128 || !isRecord(input)) return fail()
  switch (input.kind) {
    case 'integer':
      if (
        !exactKeys(input, ['kind', 'value']) ||
        typeof input.value !== 'string' ||
        !/^-?(0|[1-9][0-9]*)$/.test(input.value) ||
        input.value.length > 21
      )
        return fail()
      return Result.succeed({ kind: 'integer', value: input.value === '-0' ? '0' : input.value })
    case 'boolean':
      return exactKeys(input, ['kind', 'value']) && typeof input.value === 'boolean'
        ? Result.succeed({ kind: 'boolean', value: input.value })
        : fail()
    case 'string':
      return exactKeys(input, ['kind', 'value']) &&
        typeof input.value === 'string' &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(input.value)
        ? Result.succeed({ kind: 'string', value: input.value })
        : fail()
    case 'enum':
      return exactKeys(input, ['kind', 'type', 'member']) &&
        typeof input.type === 'string' &&
        input.type.length > 0 &&
        typeof input.member === 'string' &&
        input.member.length > 0
        ? Result.succeed({ kind: 'enum', type: input.type, member: input.member })
        : fail()
    case 'none':
      return exactKeys(input, ['kind']) ? Result.succeed({ kind: 'none' }) : fail()
    case 'some': {
      if (!exactKeys(input, ['kind', 'value'])) return fail()
      const value = inspect(input.value, origin, depth + 1)
      return Result.isFailure(value)
        ? value
        : Result.succeed({ kind: 'some', value: value.success })
    }
    case 'array': {
      if (!exactKeys(input, ['kind', 'values']) || !Array.isArray(input.values)) return fail()
      const values: Array<ConfigurationValue> = []
      for (const item of input.values) {
        const value = inspect(item, origin, depth + 1)
        if (Result.isFailure(value)) return value
        values.push(value.success)
      }
      return Result.succeed({ kind: 'array', values: values })
    }
    case 'record': {
      if (!exactKeys(input, ['kind', 'fields']) || !isRecord(input.fields)) return fail()
      const fields: Array<readonly [string, ConfigurationValue]> = []
      for (const name of Object.keys(input.fields).sort()) {
        const value = inspect(input.fields[name], origin, depth + 1)
        if (Result.isFailure(value)) return value
        fields.push([name, value.success])
      }
      return Result.succeed({ kind: 'record', fields: Object.fromEntries(fields) })
    }
    default:
      return fail()
  }
}

/** Rejects non-public provenance before inspecting or retaining an input's value. */
export const decode = Effect.fn('ConfigurationValue.decode')(function* (
  input: unknown,
  origin: ConfigurationOrigin.ConfigurationOrigin,
): Effect.fn.Return<ConfigurationValue, ConfigurationError.ConfigurationError> {
  if (!ConfigurationOrigin.isPublic(origin))
    return yield* ConfigurationError.make(
      'ConfigurationValue.decode',
      'ForbiddenProvenance',
      'configuration input',
      [origin],
    )
  const result = inspect(input, origin, 0)
  return Result.isFailure(result) ? yield* result.failure : result.success
})

/** Injective value encoding; the containing parameter additionally records its declared type. */
export const encode = (self: ConfigurationValue): string => {
  switch (self.kind) {
    case 'integer':
      return Canonical.record('integer', [self.value])
    case 'boolean':
      return Canonical.record('boolean', [String(self.value)])
    case 'string':
      return Canonical.record('string', [self.value])
    case 'enum':
      return Canonical.record('enum', [self.type, self.member])
    case 'none':
      return Canonical.record('none')
    case 'some':
      return Canonical.record('some', [encode(self.value)])
    case 'array':
      return Canonical.record('array', self.values.map(encode))
    case 'record':
      return Canonical.record(
        'record',
        Object.keys(self.fields)
          .sort()
          .flatMap((key) => {
            const value = self.fields[key]
            return value === undefined ? [] : [Canonical.record(key, [encode(value)])]
          }),
      )
  }
}
