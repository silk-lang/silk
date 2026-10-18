import * as Effect from 'effect/Effect'
import { invalidInput, type LlvmError } from './LlvmError.js'

/**
 * Identifies one LLVM pointer address space as an unsigned 24-bit value.
 *
 * @category address spaces
 * @since 0.0.0
 */
export interface AddrSpace {
  readonly _tag: 'AddrSpace'
  readonly value: number
}

/**
 * LLVM's generic address space, numbered zero.
 *
 * @category address spaces
 * @since 0.0.0
 */
export const defaultAddrSpace: AddrSpace = { _tag: 'AddrSpace', value: 0 }

/**
 * Validates and constructs an LLVM address-space identifier.
 *
 * **Details**
 *
 * The address-space number may range from `0` through LLVM's 24-bit maximum, `0xFF_FFFF`.
 *
 * **Gotchas**
 *
 * Values outside that range, including non-integers, fail with {@link LlvmError}.
 *
 * **Example** (Rendering an address space)
 *
 * Render a non-default pointer address space.
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as AddrSpace from '@silklang/llvm/AddrSpace'
 *
 * const rendered = await Effect.runPromise(
 *   Effect.gen(function* () {
 *     const space = yield* AddrSpace.make(1)
 *     return AddrSpace.render(space)
 *   }),
 * )
 * // rendered === 'addrspace(1)'
 * ```
 *
 * @category address spaces
 * @since 0.0.0
 */
export const make = Effect.fnUntraced(function* (
  value: number,
): Effect.fn.Return<AddrSpace, LlvmError> {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xff_ffff) {
    return yield* invalidInput({
      operation: 'AddrSpace.make',
      message: 'LLVM address spaces are unsigned 24-bit integers',
      input: value,
    })
  }
  return { _tag: 'AddrSpace', value }
})

/**
 * Tests address spaces by their numeric LLVM identity.
 *
 * @category address spaces
 * @since 0.0.0
 */
export const equals = (self: AddrSpace, other: AddrSpace): boolean => self.value === other.value

/**
 * Renders nothing for address space zero, or LLVM's `addrspace(n)` suffix otherwise.
 *
 * @category address spaces
 * @since 0.0.0
 */
export const render = (self: AddrSpace): string =>
  self.value === 0 ? '' : `addrspace(${self.value})`
