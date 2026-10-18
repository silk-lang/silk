/** Source storage accepted for one complete number-literal slice. */
export type Digits = ReadonlyArray<number> | Uint8Array | string

/** The `_` byte that groups the digits of one number literal without changing its value. */
export const byte = 0x5f

/** Reports whether one byte is the digit separator. */
export const isSeparator = (candidate: number | undefined): boolean => candidate === byte

/**
 * Reads one number-literal slice as text with every separator removed.
 *
 * A separator carries no value, so every conversion reading a literal as a number reads the
 * separator-free text rather than the source spelling.
 */
export const strip = (digits: Digits): string => {
  const text =
    typeof digits === 'string'
      ? digits
      : Array.from(digits, (code) => String.fromCharCode(code)).join('')
  return text.includes('_') ? text.split('_').join('') : text
}
