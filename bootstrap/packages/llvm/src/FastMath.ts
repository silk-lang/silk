import { dual } from 'effect/Function'

/**
 * Immutable LLVM fast-math settings shared by arithmetic, comparisons, phis, selects, and calls.
 *
 * @category fast math
 * @since 0.0.0
 */
export interface FastMath {
  readonly allowReassociation: boolean
  readonly noNaNs: boolean
  readonly noInfinities: boolean
  readonly noSignedZeros: boolean
  readonly allowReciprocal: boolean
  readonly allowContract: boolean
  readonly approximateFunctions: boolean
}

/**
 * A shorthand or partial override accepted by {@link make} and {@link combine}.
 *
 * @category fast math
 * @since 0.0.0
 */
export type Input = boolean | Partial<FastMath>

/**
 * Strict IEEE-style behavior with every optional fast-math promise disabled.
 *
 * @category fast math
 * @since 0.0.0
 */
export const none: FastMath = {
  allowReassociation: false,
  noNaNs: false,
  noInfinities: false,
  noSignedZeros: false,
  allowReciprocal: false,
  allowContract: false,
  approximateFunctions: false,
}

/**
 * LLVM's aggregate `fast` setting with every fast-math promise enabled.
 *
 * @category fast math
 * @since 0.0.0
 */
export const fast: FastMath = {
  allowReassociation: true,
  noNaNs: true,
  noInfinities: true,
  noSignedZeros: true,
  allowReciprocal: true,
  allowContract: true,
  approximateFunctions: true,
}

/**
 * Normalizes a boolean shorthand or partial setting into immutable fast-math flags.
 *
 * **Details**
 *
 * `true` selects {@link fast}, `false` selects {@link none}, and an object overlays its fields on
 * the strict defaults.
 *
 * **Gotchas**
 *
 * These flags are correctness promises to LLVM, not optimization requests.
 *
 * **Example** (Creating fast-math flags)
 *
 * ```ts
 * import * as FastMath from '@silklang/llvm/FastMath'
 *
 * const flags = FastMath.make({ noNaNs: true, allowContract: true })
 * // FastMath.toText(flags) equals ['nnan', 'contract']
 * ```
 *
 * @category fast math
 * @since 0.0.0
 */
export const make = (input: Input = false): FastMath => {
  if (input === true) return fast
  if (input === false) return none
  return { ...none, ...input }
}

/**
 * Overlays normalized flags on an existing setting without mutating either input.
 *
 * **Example** (Combining flags in a pipeline)
 *
 * ```ts
 * import { pipe } from 'effect/Function'
 * import * as FastMath from '@silklang/llvm/FastMath'
 *
 * const flags = pipe(FastMath.none, FastMath.combine({ noNaNs: true }))
 * ```
 *
 * @category fast math
 * @since 0.0.0
 */
export const combine: {
  (other: Input): (self: FastMath) => FastMath
  (self: FastMath, other: Input): FastMath
} = dual(2, (self: FastMath, other: Input): FastMath => ({ ...self, ...make(other) }))

/**
 * Encodes the setting as LLVM's instruction fast-math bit mask.
 *
 * @category fast math
 * @since 0.0.0
 */
export const toBitcode = (self: FastMath): number =>
  (self.noNaNs ? 1 << 1 : 0) |
  (self.noInfinities ? 1 << 2 : 0) |
  (self.noSignedZeros ? 1 << 3 : 0) |
  (self.allowReciprocal ? 1 << 4 : 0) |
  (self.allowContract ? 1 << 5 : 0) |
  (self.approximateFunctions ? 1 << 6 : 0) |
  (self.allowReassociation ? 1 << 7 : 0)

/**
 * Renders canonical LLVM flag tokens, collapsing the complete set to `fast`.
 *
 * @category fast math
 * @since 0.0.0
 */
export const toText = (self: FastMath): ReadonlyArray<string> => {
  if (self === fast || toBitcode(self) === toBitcode(fast)) return ['fast']
  return [
    self.allowReassociation ? 'reassoc' : '',
    self.noNaNs ? 'nnan' : '',
    self.noInfinities ? 'ninf' : '',
    self.noSignedZeros ? 'nsz' : '',
    self.allowReciprocal ? 'arcp' : '',
    self.allowContract ? 'contract' : '',
    self.approximateFunctions ? 'afn' : '',
  ].filter((flag) => flag !== '')
}
