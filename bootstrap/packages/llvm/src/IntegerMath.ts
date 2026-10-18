import { dual } from 'effect/Function'

/**
 * Immutable overflow and exactness promises for integer instructions.
 *
 * @category integer math
 * @since 0.0.0
 */
export interface IntegerMath {
  readonly noSignedWrap: boolean
  readonly noUnsignedWrap: boolean
  readonly exact: boolean
}

/**
 * Optional fields accepted by {@link make}.
 *
 * @category integer math
 * @since 0.0.0
 */
export interface Input {
  readonly noSignedWrap?: boolean | undefined
  readonly noUnsignedWrap?: boolean | undefined
  readonly exact?: boolean | undefined
}

/**
 * Integer arithmetic with no overflow or exactness promises.
 *
 * @category integer math
 * @since 0.0.0
 */
export const none: IntegerMath = {
  noSignedWrap: false,
  noUnsignedWrap: false,
  exact: false,
}

/**
 * Constructs immutable integer instruction flags.
 *
 * **Gotchas**
 *
 * `nuw`, `nsw`, and `exact` let LLVM assume undefined behavior when their promise is violated.
 * Only enable a flag when the source language or prior analysis proves it.
 *
 * **Example** (Creating integer flags)
 *
 * ```ts
 * import { pipe } from 'effect/Function'
 * import * as IntegerMath from '@silklang/llvm/IntegerMath'
 *
 * const flags = pipe(
 *   IntegerMath.make(),
 *   IntegerMath.withNoUnsignedWrap(),
 *   IntegerMath.withExact(false),
 * )
 * // IntegerMath.toText(flags) equals ['nuw']
 * ```
 *
 * @category integer math
 * @since 0.0.0
 */
export const make = (input: Input = {}): IntegerMath => ({
  noSignedWrap: input.noSignedWrap ?? false,
  noUnsignedWrap: input.noUnsignedWrap ?? false,
  exact: input.exact ?? false,
})

/**
 * Returns a copy with the signed-overflow promise enabled or disabled.
 *
 * @category integer math
 * @since 0.0.0
 */
export const withNoSignedWrap: {
  (): (self: IntegerMath) => IntegerMath
  (enabled: boolean): (self: IntegerMath) => IntegerMath
  (self: IntegerMath, enabled?: boolean): IntegerMath
} = dual(
  (args) => typeof args[0] === 'object',
  (self: IntegerMath, enabled = true): IntegerMath => ({ ...self, noSignedWrap: enabled }),
)

/**
 * Returns a copy with the unsigned-overflow promise enabled or disabled.
 *
 * @category integer math
 * @since 0.0.0
 */
export const withNoUnsignedWrap: {
  (): (self: IntegerMath) => IntegerMath
  (enabled: boolean): (self: IntegerMath) => IntegerMath
  (self: IntegerMath, enabled?: boolean): IntegerMath
} = dual(
  (args) => typeof args[0] === 'object',
  (self: IntegerMath, enabled = true): IntegerMath => ({ ...self, noUnsignedWrap: enabled }),
)

/**
 * Returns a copy with the exact division or shift promise enabled or disabled.
 *
 * @category integer math
 * @since 0.0.0
 */
export const withExact: {
  (): (self: IntegerMath) => IntegerMath
  (enabled: boolean): (self: IntegerMath) => IntegerMath
  (self: IntegerMath, enabled?: boolean): IntegerMath
} = dual(
  (args) => typeof args[0] === 'object',
  (self: IntegerMath, enabled = true): IntegerMath => ({ ...self, exact: enabled }),
)

/**
 * Encodes flags for the corresponding LLVM instruction-record field.
 *
 * **Gotchas**
 *
 * `nuw` (`noUnsignedWrap`) and `exact` both occupy bit 0. This matches LLVM's optional-flag
 * encoding, where they are mutually exclusive: `nuw`/`nsw` apply only to add, sub, mul, and shl,
 * while `exact` applies only to udiv, sdiv, lshr, and ashr. {@link FunctionBody.binary} enforces the
 * same opcode split, so the shared bit is unambiguous.
 *
 * @category integer math
 * @since 0.0.0
 */
export const toBitcode = (self: IntegerMath): number =>
  (self.noUnsignedWrap ? 1 : 0) | (self.noSignedWrap ? 2 : 0) | (self.exact ? 1 : 0)

/**
 * Renders enabled flags in LLVM's canonical textual order.
 *
 * @category integer math
 * @since 0.0.0
 */
export const toText = (self: IntegerMath): ReadonlyArray<string> =>
  [
    self.noUnsignedWrap ? 'nuw' : '',
    self.noSignedWrap ? 'nsw' : '',
    self.exact ? 'exact' : '',
  ].filter((flag) => flag !== '')
