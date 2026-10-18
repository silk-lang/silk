/**
 * Source-level visibility encoded in LLVM `DIFlags`.
 *
 * @category debug information
 * @since 0.0.0
 */
export type Visibility = 'zero' | 'private' | 'protected' | 'public'
/**
 * Inheritance model encoded in LLVM `DIFlags`.
 *
 * @category debug information
 * @since 0.0.0
 */
export type Inheritance = 'zero' | 'single' | 'multiple' | 'virtual'

/**
 * Immutable general-purpose debug-information flags.
 *
 * @category debug information
 * @since 0.0.0
 */
export interface DIFlags {
  readonly bits: number
}

/**
 * Named flag fields accepted by {@link make}.
 *
 * @category debug information
 * @since 0.0.0
 */
export interface Input {
  readonly visibility?: Visibility
  readonly inheritance?: Inheritance
  readonly forwardDeclaration?: boolean
  readonly appleBlock?: boolean
  readonly virtual?: boolean
  readonly artificial?: boolean
  readonly explicit?: boolean
  readonly prototyped?: boolean
  readonly objcClassComplete?: boolean
  readonly objectPointer?: boolean
  readonly vector?: boolean
  readonly staticMember?: boolean
  readonly lValueReference?: boolean
  readonly rValueReference?: boolean
  readonly exportSymbols?: boolean
  readonly introducedVirtual?: boolean
  readonly bitField?: boolean
  readonly noReturn?: boolean
  readonly typePassByValue?: boolean
  readonly typePassByReference?: boolean
  readonly enumClass?: boolean
  readonly thunk?: boolean
  readonly nonTrivial?: boolean
  readonly bigEndian?: boolean
  readonly littleEndian?: boolean
  readonly allCallsDescribed?: boolean
}

const visibilityBits: Readonly<Record<Visibility, number>> = {
  zero: 0,
  private: 1,
  protected: 2,
  public: 3,
}

const inheritanceBits: Readonly<Record<Inheritance, number>> = {
  zero: 0,
  single: 1,
  multiple: 2,
  virtual: 3,
}

const boolFields: ReadonlyArray<readonly [keyof Input, number, string]> = [
  ['forwardDeclaration', 2, 'DIFlagFwdDecl'],
  ['appleBlock', 3, 'DIFlagAppleBlock'],
  ['virtual', 5, 'DIFlagVirtual'],
  ['artificial', 6, 'DIFlagArtificial'],
  ['explicit', 7, 'DIFlagExplicit'],
  ['prototyped', 8, 'DIFlagPrototyped'],
  ['objcClassComplete', 9, 'DIFlagObjcClassComplete'],
  ['objectPointer', 10, 'DIFlagObjectPointer'],
  ['vector', 11, 'DIFlagVector'],
  ['staticMember', 12, 'DIFlagStaticMember'],
  ['lValueReference', 13, 'DIFlagLValueReference'],
  ['rValueReference', 14, 'DIFlagRValueReference'],
  ['exportSymbols', 15, 'DIFlagExportSymbols'],
  ['introducedVirtual', 18, 'DIFlagIntroducedVirtual'],
  ['bitField', 19, 'DIFlagBitField'],
  ['noReturn', 20, 'DIFlagNoReturn'],
  ['typePassByValue', 22, 'DIFlagTypePassByValue'],
  ['typePassByReference', 23, 'DIFlagTypePassByReference'],
  ['enumClass', 24, 'DIFlagEnumClass'],
  ['thunk', 25, 'DIFlagThunk'],
  ['nonTrivial', 26, 'DIFlagNonTrivial'],
  ['bigEndian', 27, 'DIFlagBigEndian'],
  ['littleEndian', 28, 'DIFlagLittleEndian'],
  ['allCallsDescribed', 29, 'DIFlagAllCallsDescribed'],
]

/**
 * An empty `DIFlags` bit set.
 *
 * @category debug information
 * @since 0.0.0
 */
export const none: DIFlags = { bits: 0 }

/**
 * Packs named debug flags into LLVM's stable bit representation.
 *
 * **Example** (Packing debug flags)
 *
 * ```ts
 * import * as DIFlags from '@silklang/llvm/DIFlags'
 *
 * const flags = DIFlags.make({ visibility: 'public', prototyped: true })
 * // DIFlags.render(flags) === 'DIFlagPublic | DIFlagPrototyped'
 * ```
 *
 * @category debug information
 * @since 0.0.0
 */
export const make = (input: Input = {}): DIFlags => {
  let bits = visibilityBits[input.visibility ?? 'zero']
  bits |= inheritanceBits[input.inheritance ?? 'zero'] << 16
  for (const [field, shift] of boolFields) if (input[field] === true) bits |= 1 << shift
  return { bits: bits >>> 0 }
}

/**
 * Unions two debug flag sets.
 *
 * @category debug information
 * @since 0.0.0
 */
export const combine = (left: DIFlags, right: DIFlags): DIFlags => ({
  bits: (left.bits | right.bits) >>> 0,
})

/**
 * Returns LLVM's unsigned 32-bit encoding.
 *
 * @category debug information
 * @since 0.0.0
 */
export const toBitcode = (self: DIFlags): number => self.bits

/**
 * Expands the bit set into canonical LLVM IR flag names.
 *
 * @category debug information
 * @since 0.0.0
 */
export const toText = (self: DIFlags): ReadonlyArray<string> => {
  const values: Array<string> = []
  const visibility = self.bits & 3
  if (visibility !== 0)
    values.push(['', 'DIFlagPrivate', 'DIFlagProtected', 'DIFlagPublic'][visibility] ?? '')
  for (const [, shift, name] of boolFields) {
    if (shift < 16 && (self.bits & (1 << shift)) !== 0) values.push(name)
  }
  const inheritance = (self.bits >>> 16) & 3
  if (inheritance !== 0) {
    values.push(
      ['', 'DIFlagSingleInheritance', 'DIFlagMultipleInheritance', 'DIFlagVirtualInheritance'][
        inheritance
      ] ?? '',
    )
  }
  for (const [, shift, name] of boolFields) {
    if (shift > 17 && (self.bits & (1 << shift)) !== 0) values.push(name)
  }
  return values.filter((value) => value !== '')
}

/**
 * Renders `0` for no flags or a ` | `-separated LLVM flag expression.
 *
 * @category debug information
 * @since 0.0.0
 */
export const render = (self: DIFlags): string => {
  const values = toText(self)
  return values.length === 0 ? '0' : values.join(' | ')
}
