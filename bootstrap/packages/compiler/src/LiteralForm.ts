import * as ByteClass from './internal/ByteClass.js'

/** The semantic category selected by a static-literal modifier and delimiter. */
export type Category = 'Text' | 'Bytes' | 'Character'

/** The number of delimiter bytes in a recognized static-literal delimiter. */
export type DelimiterWidth = 1 | 3

/** The byte that opens and closes one literal body. */
export type Delimiter = 0x22 | 0x27

/** The body-decoding policy selected independently from delimiter width. */
export type EscapePolicy = 'Escaped' | 'Raw'

/** Immutable source-form metadata shared by the compiler and editor tooling. */
export interface LiteralForm {
  readonly category: Category
  readonly modifier: '' | 'b' | 'r'
  readonly delimiter: Delimiter
  readonly delimiterWidth: DelimiterWidth
  readonly escapePolicy: EscapePolicy
  readonly tokenKind: 'TextLiteral' | 'ByteStringLiteral' | 'CharLiteral'
}

const quote = 0x22
const apostrophe = 0x27

const make = (
  category: Category,
  modifier: LiteralForm['modifier'],
  delimiter: Delimiter,
  delimiterWidth: DelimiterWidth,
  escapePolicy: EscapePolicy,
  tokenKind: LiteralForm['tokenKind'],
): LiteralForm => ({ category, modifier, delimiter, delimiterWidth, escapePolicy, tokenKind })

/**
 * Every committed form, ordered by longest introduction first. Consumers that generate matching
 * rules can retain this order without reconstructing the language's precedence contract.
 *
 * The character form is unambiguous against every other entry, because no other form opens on
 * `'`, so its position carries no precedence meaning.
 */
export const forms: ReadonlyArray<LiteralForm> = [
  make('Bytes', 'b', quote, 3, 'Escaped', 'ByteStringLiteral'),
  make('Text', 'r', quote, 3, 'Raw', 'TextLiteral'),
  make('Text', '', quote, 3, 'Escaped', 'TextLiteral'),
  make('Bytes', 'b', quote, 1, 'Escaped', 'ByteStringLiteral'),
  make('Text', 'r', quote, 1, 'Raw', 'TextLiteral'),
  make('Text', '', quote, 1, 'Escaped', 'TextLiteral'),
  make('Character', '', apostrophe, 1, 'Escaped', 'CharLiteral'),
]

/** Byte storage accepted from source files, tests, and generated tooling. */
export type ByteSequence = ReadonlyArray<number> | Uint8Array

const matches = (bytes: ByteSequence, index: number, form: LiteralForm): boolean => {
  let cursor = index
  for (let modifierIndex = 0; modifierIndex < form.modifier.length; modifierIndex += 1) {
    if (bytes[cursor] !== form.modifier.charCodeAt(modifierIndex)) return false
    cursor += 1
  }
  for (let delimiterIndex = 0; delimiterIndex < form.delimiterWidth; delimiterIndex += 1) {
    if (bytes[cursor + delimiterIndex] !== form.delimiter) return false
  }
  return true
}

/** Recognizes the longest committed literal introduction at `index`. */
export const recognize = (bytes: ByteSequence, index = 0): LiteralForm | undefined =>
  forms.find((form) => matches(bytes, index, form))

/** One identifier-like spelling reserved as an unrecognized adjacent literal modifier. */
export interface UnknownIntroduction {
  readonly modifier: string
  readonly modifierWidth: number
  readonly delimiterWidth: DelimiterWidth
}

/**
 * Recognizes a closed-vocabulary modifier failure without accepting it as a new form.
 *
 * The reserved vocabulary is the quote delimiter's alone: `b'a'` is an identifier followed by a
 * character literal, because no modifier of the character form exists to misspell.
 */
export const recognizeUnknown = (
  bytes: ByteSequence,
  index = 0,
): UnknownIntroduction | undefined => {
  if (!ByteClass.isIdentifierStart(bytes[index])) return undefined
  let cursor = index + 1
  while (cursor < bytes.length && ByteClass.isIdentifierContinue(bytes[cursor])) cursor += 1
  if (bytes[cursor] !== quote) return undefined
  const modifier = String.fromCharCode(...bytes.slice(index, cursor))
  if (forms.some((form) => form.modifier === modifier)) return undefined
  const delimiterWidth = bytes[cursor + 1] === quote && bytes[cursor + 2] === quote ? 3 : 1
  return { modifier, modifierWidth: cursor - index, delimiterWidth }
}

/** The deterministic boundary selected for a recognized or reserved introduction. */
export interface Boundary {
  readonly end: number
  readonly terminated: boolean
}

/**
 * Scans exactly one literal body after its opening delimiter. A raw body never consults a
 * backslash, so `r"path\"` closes at its own quote rather than at the next one.
 */
export const scanBoundary = (
  bytes: ByteSequence,
  contentStart: number,
  delimiterWidth: DelimiterWidth,
  escapePolicy: EscapePolicy = 'Escaped',
  delimiter: Delimiter = quote,
): Boundary => {
  let index = contentStart
  while (index < bytes.length) {
    if (delimiterWidth === 1 && (bytes[index] === 0x0a || bytes[index] === 0x0d)) {
      return { end: index, terminated: false }
    }
    if (bytes[index] === delimiter) {
      if (
        delimiterWidth === 1 ||
        (bytes[index + 1] === delimiter && bytes[index + 2] === delimiter)
      ) {
        return { end: index + delimiterWidth, terminated: true }
      }
      index += 1
      continue
    }
    if (escapePolicy === 'Escaped' && bytes[index] === 0x5c && index + 1 < bytes.length) {
      if (delimiterWidth === 1 && (bytes[index + 1] === 0x0a || bytes[index + 1] === 0x0d)) {
        index += 1
      } else {
        index += 2
      }
      continue
    }
    index += 1
  }
  return { end: bytes.length, terminated: false }
}

export { scalarCount } from './internal/Escape.js'

/** Returns the token kind selected by a valid form. */
export const tokenKind = (self: LiteralForm): LiteralForm['tokenKind'] => self.tokenKind
