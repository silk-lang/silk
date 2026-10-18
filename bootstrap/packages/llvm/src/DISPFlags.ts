/**
 * Subprogram virtuality encoded in LLVM `DISPFlags`.
 *
 * @category debug information
 * @since 0.0.0
 */
export type Virtuality = 'zero' | 'virtual' | 'pureVirtual'

/**
 * Immutable debug-subprogram flags.
 *
 * @category debug information
 * @since 0.0.0
 */
export interface DISPFlags {
  readonly bits: number
}

/**
 * Named subprogram flag fields accepted by {@link make}.
 *
 * @category debug information
 * @since 0.0.0
 */
export interface Input {
  readonly virtuality?: Virtuality
  readonly localToUnit?: boolean
  readonly definition?: boolean
  readonly optimized?: boolean
  readonly pure?: boolean
  readonly elemental?: boolean
  readonly recursive?: boolean
  readonly mainSubprogram?: boolean
  readonly deleted?: boolean
  readonly objcDirect?: boolean
}

const virtualityBits: Readonly<Record<Virtuality, number>> = {
  zero: 0,
  virtual: 1,
  pureVirtual: 2,
}

const boolFields: ReadonlyArray<readonly [keyof Input, number, string]> = [
  ['localToUnit', 2, 'DISPFlagLocalToUnit'],
  ['definition', 3, 'DISPFlagDefinition'],
  ['optimized', 4, 'DISPFlagOptimized'],
  ['pure', 5, 'DISPFlagPure'],
  ['elemental', 6, 'DISPFlagElemental'],
  ['recursive', 7, 'DISPFlagRecursive'],
  ['mainSubprogram', 8, 'DISPFlagMainSubprogram'],
  ['deleted', 9, 'DISPFlagDeleted'],
  ['objcDirect', 11, 'DISPFlagObjCDirect'],
]

/**
 * An empty `DISPFlags` bit set.
 *
 * @category debug information
 * @since 0.0.0
 */
export const none: DISPFlags = { bits: 0 }

/**
 * Packs named subprogram flags into LLVM's stable bit representation.
 *
 * **Example** (Packing subprogram flags)
 *
 * ```ts
 * import * as DISPFlags from '@silklang/llvm/DISPFlags'
 *
 * const flags = DISPFlags.make({ definition: true, optimized: true })
 * // DISPFlags.toText(flags) equals ['DISPFlagDefinition', 'DISPFlagOptimized']
 * ```
 *
 * @category debug information
 * @since 0.0.0
 */
export const make = (input: Input = {}): DISPFlags => {
  let bits = virtualityBits[input.virtuality ?? 'zero']
  for (const [field, shift] of boolFields) if (input[field] === true) bits |= 1 << shift
  return { bits: bits >>> 0 }
}

/**
 * Unions two subprogram flag sets.
 *
 * @category debug information
 * @since 0.0.0
 */
export const combine = (left: DISPFlags, right: DISPFlags): DISPFlags => ({
  bits: (left.bits | right.bits) >>> 0,
})

/**
 * Returns LLVM's unsigned subprogram-flag encoding.
 *
 * @category debug information
 * @since 0.0.0
 */
export const toBitcode = (self: DISPFlags): number => self.bits

/**
 * Expands the bit set into canonical LLVM IR flag names.
 *
 * @category debug information
 * @since 0.0.0
 */
export const toText = (self: DISPFlags): ReadonlyArray<string> => {
  const values: Array<string> = []
  const virtuality = self.bits & 3
  if (virtuality !== 0) values.push(virtuality === 1 ? 'DISPFlagVirtual' : 'DISPFlagPureVirtual')
  for (const [, shift, name] of boolFields) if ((self.bits & (1 << shift)) !== 0) values.push(name)
  return values
}

/**
 * Renders `0` for no flags or a ` | `-separated LLVM flag expression.
 *
 * @category debug information
 * @since 0.0.0
 */
export const render = (self: DISPFlags): string => {
  const values = toText(self)
  return values.length === 0 ? '0' : values.join(' | ')
}
