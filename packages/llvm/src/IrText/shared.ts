import * as ByteString from '../ByteString.js'

/** @internal */
export const quoted = (value: ByteString.ByteString): string => `"${ByteString.escapeForIr(value)}"`

/** @internal */
export const identifier = (prefix: '@' | '%', value: ByteString.ByteString): string => {
  let ascii = ''
  for (const byte of value.bytes) ascii += String.fromCharCode(byte)
  return /^[-A-Za-z$._][-A-Za-z$._0-9]*$/.test(ascii) || /^\d+$/.test(ascii)
    ? `${prefix}${ascii}`
    : `${prefix}${quoted(value)}`
}

/** @internal */
export const rawBytes = (value: ByteString.ByteString): string => {
  let ascii = ''
  for (const byte of value.bytes) ascii += String.fromCharCode(byte)
  return ascii
}
