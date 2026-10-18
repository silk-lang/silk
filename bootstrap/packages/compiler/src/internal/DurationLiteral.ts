import * as ByteClass from './ByteClass.js'
import * as DigitSeparator from './DigitSeparator.js'

/** Byte storage accepted from source files and focused actor tests. */
export type ByteSequence = ReadonlyArray<number> | Uint8Array

/** The canonical fixed-duration units accepted by Silk source. */
export type Unit = 'w' | 'd' | 'h' | 'm' | 's' | 'ms' | 'us' | 'ns'

/** One source component of a valid compact duration literal. */
export interface Component {
  readonly amount: bigint
  readonly unit: Unit
  readonly start: number
  readonly amountEnd: number
  readonly end: number
}

export type InvalidReason =
  | {
      readonly _tag: 'InvalidAmount'
      readonly start: number
      readonly end: number
    }
  | {
      readonly _tag: 'InvalidDigitSeparator'
      readonly start: number
      readonly end: number
    }
  | {
      readonly _tag: 'UnknownUnit'
      readonly spelling: string
      readonly start: number
      readonly end: number
    }
  | {
      readonly _tag: 'RepeatedUnit'
      readonly unit: Unit
      readonly start: number
      readonly end: number
    }
  | {
      readonly _tag: 'OutOfOrderUnit'
      readonly unit: Unit
      readonly previous: Unit
      readonly start: number
      readonly end: number
    }
  | {
      readonly _tag: 'SubordinateOutOfRange'
      readonly unit: Unit
      readonly amount: bigint
      readonly maximum: bigint
      readonly start: number
      readonly end: number
    }

export interface Valid {
  readonly _tag: 'Valid'
  readonly components: ReadonlyArray<Component>
  readonly nanoseconds: bigint
}

export interface Invalid {
  readonly _tag: 'Invalid'
  readonly reason: InvalidReason
}

export type ParseResult = Valid | Invalid

interface UnitInfo {
  readonly unit: Unit
  readonly rank: number
  readonly nanoseconds: bigint
  readonly subordinateMaximum?: bigint
}

/** Nanoseconds one whole unit denotes; authored components carry a magnitude and this unit. */
export const unitNanoseconds: Readonly<Record<Unit, bigint>> = {
  w: 604_800_000_000_000n,
  d: 86_400_000_000_000n,
  h: 3_600_000_000_000n,
  m: 60_000_000_000n,
  s: 1_000_000_000n,
  ms: 1_000_000n,
  us: 1_000n,
  ns: 1n,
}

const unitInfo = (spelling: string): UnitInfo | undefined => {
  switch (spelling) {
    case 'w':
      return { unit: 'w', rank: 0, nanoseconds: 604_800_000_000_000n }
    case 'd':
      return { unit: 'd', rank: 1, nanoseconds: 86_400_000_000_000n, subordinateMaximum: 6n }
    case 'h':
      return { unit: 'h', rank: 2, nanoseconds: 3_600_000_000_000n, subordinateMaximum: 23n }
    case 'm':
      return { unit: 'm', rank: 3, nanoseconds: 60_000_000_000n, subordinateMaximum: 59n }
    case 's':
      return { unit: 's', rank: 4, nanoseconds: 1_000_000_000n, subordinateMaximum: 59n }
    case 'ms':
      return { unit: 'ms', rank: 5, nanoseconds: 1_000_000n, subordinateMaximum: 999n }
    case 'us':
      return { unit: 'us', rank: 6, nanoseconds: 1_000n, subordinateMaximum: 999n }
    case 'ns':
      return { unit: 'ns', rank: 7, nanoseconds: 1n, subordinateMaximum: 999n }
    default:
      return undefined
  }
}

const ascii = (bytes: ByteSequence, start: number, end: number): string => {
  let result = ''
  for (let index = start; index < end; index += 1) {
    result += String.fromCharCode(bytes[index] ?? 0)
  }
  return result
}

const invalidAmountEnd = (bytes: ByteSequence, componentStart: number, end: number): number => {
  for (const width of [2, 1]) {
    const unitStart = end - width
    if (unitStart > componentStart && unitInfo(ascii(bytes, unitStart, end)) !== undefined) {
      return unitStart
    }
  }
  let suffixStart = end
  while (suffixStart > componentStart && ByteClass.isAsciiLetter(bytes[suffixStart - 1])) {
    suffixStart -= 1
  }
  return Math.max(componentStart + 1, suffixStart)
}

/**
 * Extends a number token through one maximal identifier-like duration candidate.
 *
 * Callers first establish that `from` points at an ASCII letter. Punctuation and whitespace stop
 * the candidate, so `1h + 30m` remains three expressions while `1h30m` is one literal.
 */
export const candidateEnd = (bytes: ByteSequence, from: number): number => {
  let end = from
  while (end < bytes.length && ByteClass.isIdentifierContinue(bytes[end])) end += 1
  return end
}

/** Parses one complete duration-literal candidate without imposing the final `u64` range. */
export const parse = (bytes: ByteSequence, start = 0, end = bytes.length): ParseResult => {
  if (
    bytes[start] === 0x30 &&
    (bytes[start + 1] === 0x78 ||
      bytes[start + 1] === 0x58 ||
      bytes[start + 1] === 0x62 ||
      bytes[start + 1] === 0x42 ||
      bytes[start + 1] === 0x6f ||
      bytes[start + 1] === 0x4f)
  ) {
    return {
      _tag: 'Invalid',
      reason: {
        _tag: 'InvalidAmount',
        start,
        end: invalidAmountEnd(bytes, start, end),
      },
    }
  }

  const components: Array<Component> = []
  const seen = new Set<Unit>()
  let index = start
  let previous: UnitInfo | undefined
  let nanoseconds = 0n

  while (index < end) {
    const componentStart = index
    let amount = 0n
    let digits = false
    let separated = true
    let afterSeparator = false

    while (index < end) {
      const byte = bytes[index]
      if (ByteClass.isDecimalDigit(byte)) {
        digits = true
        afterSeparator = false
        amount = amount * 10n + BigInt((byte ?? 0) - 0x30)
        index += 1
        continue
      }
      if (!DigitSeparator.isSeparator(byte)) break
      if (index === componentStart || afterSeparator) separated = false
      afterSeparator = true
      index += 1
    }

    const amountEnd = index
    if (!digits || !separated || afterSeparator) {
      return {
        _tag: 'Invalid',
        reason: {
          _tag: 'InvalidDigitSeparator',
          start: componentStart,
          end: amountEnd,
        },
      }
    }

    if (!ByteClass.isAsciiLetter(bytes[index])) {
      return {
        _tag: 'Invalid',
        reason: {
          _tag: 'InvalidAmount',
          start: componentStart,
          end: invalidAmountEnd(bytes, componentStart, end),
        },
      }
    }

    const unitStart = index
    while (index < end && ByteClass.isAsciiLetter(bytes[index])) index += 1
    const unitEnd = index
    const unitSpelling = ascii(bytes, unitStart, unitEnd)
    const info = unitInfo(unitSpelling)
    if (info === undefined) {
      const exponentOrPrefix =
        unitSpelling === 'e' ||
        unitSpelling === 'E' ||
        (amount === 0n &&
          (unitSpelling === 'x' ||
            unitSpelling === 'X' ||
            unitSpelling === 'b' ||
            unitSpelling === 'B' ||
            unitSpelling === 'o' ||
            unitSpelling === 'O'))
      if (exponentOrPrefix && index < end && ByteClass.isDecimalDigit(bytes[index])) {
        return {
          _tag: 'Invalid',
          reason: {
            _tag: 'InvalidAmount',
            start: componentStart,
            end: invalidAmountEnd(bytes, componentStart, end),
          },
        }
      }
      return {
        _tag: 'Invalid',
        reason: {
          _tag: 'UnknownUnit',
          spelling: unitSpelling,
          start: unitStart,
          end: unitEnd,
        },
      }
    }

    if (seen.has(info.unit)) {
      return {
        _tag: 'Invalid',
        reason: {
          _tag: 'RepeatedUnit',
          unit: info.unit,
          start: unitStart,
          end: unitEnd,
        },
      }
    }
    if (previous !== undefined && info.rank < previous.rank) {
      return {
        _tag: 'Invalid',
        reason: {
          _tag: 'OutOfOrderUnit',
          unit: info.unit,
          previous: previous.unit,
          start: unitStart,
          end: unitEnd,
        },
      }
    }
    if (
      components.length > 0 &&
      info.subordinateMaximum !== undefined &&
      amount > info.subordinateMaximum
    ) {
      return {
        _tag: 'Invalid',
        reason: {
          _tag: 'SubordinateOutOfRange',
          unit: info.unit,
          amount,
          maximum: info.subordinateMaximum,
          start: componentStart,
          end: unitEnd,
        },
      }
    }

    const component = {
      amount,
      unit: info.unit,
      start: componentStart,
      amountEnd,
      end: unitEnd,
    }
    components.push(component)
    seen.add(info.unit)
    previous = info
    nanoseconds += amount * info.nanoseconds

    if (index < end && !ByteClass.isDecimalDigit(bytes[index])) {
      return {
        _tag: 'Invalid',
        reason: {
          _tag: 'InvalidAmount',
          start: index,
          end: invalidAmountEnd(bytes, index, end),
        },
      }
    }
  }

  return {
    _tag: 'Valid',
    components: components,
    nanoseconds,
  }
}
