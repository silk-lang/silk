/** One canonical classification of every ASCII byte the compiler's scanner and lexer consume. */

/** True for A-Z and a-z. */
export const isAsciiLetter = (byte: number | undefined): boolean =>
  byte !== undefined && ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))

/** True for 0-9. */
export const isDecimalDigit = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= 0x30 && byte <= 0x39

/** True when the byte can begin a source identifier or keyword. */
export const isIdentifierStart = (byte: number | undefined): boolean =>
  byte === 0x5f || isAsciiLetter(byte)

/** True when the byte can appear after the first byte of a source identifier or keyword. */
export const isIdentifierContinue = (byte: number | undefined): boolean =>
  isIdentifierStart(byte) || isDecimalDigit(byte)

/** The numeric value of one hex digit byte (0-9, A-F, a-f). Callers validate the byte first. */
export const hexValue = (byte: number): number => {
  if (byte <= 0x39) return byte - 0x30
  if (byte <= 0x46) return byte - 0x41 + 10
  return byte - 0x61 + 10
}

/** The numeric value of a hexadecimal byte, or undefined when it is not hexadecimal. */
export const digitValue = (byte: number | undefined): number | undefined => {
  if (byte === undefined) return undefined
  if (isDecimalDigit(byte)) return byte - 0x30
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10
  return undefined
}
