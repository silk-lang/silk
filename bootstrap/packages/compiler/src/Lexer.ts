import * as Array from 'effect/Array'
import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import * as Diagnostic from './Diagnostic.js'
import * as ByteClass from './internal/ByteClass.js'
import * as DigitSeparator from './internal/DigitSeparator.js'
import * as DurationLiteral from './internal/DurationLiteral.js'
import * as IntegerLiteral from './internal/IntegerLiteral.js'
import * as LiteralForm from './LiteralForm.js'
import type * as SourceFile from './SourceFile.js'
import * as SourceSpan from './SourceSpan.js'
import * as Token from './Token.js'

/** The complete, deterministic result of lexing one immutable source snapshot. */
export interface LexicalResult {
  readonly source: SourceFile.SourceFile
  readonly tokens: ReadonlyArray<Token.Token>
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
}

const isWhitespace = (byte: number | undefined): boolean =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d

const isLineCommentStart = (bytes: Uint8Array, index: number): boolean =>
  bytes[index] === 0x2f && bytes[index + 1] === 0x2f

const isLiteralStart = (bytes: Uint8Array, index: number): boolean =>
  LiteralForm.recognize(bytes, index) !== undefined

const compoundPunctuationKind = (bytes: Uint8Array, index: number): Token.TokenKind | undefined => {
  const first = bytes[index]
  const second = bytes[index + 1]
  if (first === 0x2d && second === 0x3e) return 'Arrow'
  if (first === 0x3d && second === 0x3d) return 'EqualEqual'
  if (first === 0x3d && second === 0x3e) return 'FatArrow'
  if (first === 0x21 && second === 0x3d) return 'BangEqual'
  if (first === 0x3c && second === 0x3d) return 'LessEqual'
  if (first === 0x3e && second === 0x3d) return 'GreaterEqual'
  if (first === 0x7c && second === 0x3e) return 'PipeGreater'
  if (first === 0x7c && second === 0x7c) return 'PipePipe'
  if (first === 0x26 && second === 0x26) return 'AmpersandAmpersand'
  if (first === 0x2e && second === 0x2e) return bytes[index + 2] === 0x2e ? 'Ellipsis' : 'DotDot'
  return undefined
}

const isSupportedTokenStart = (bytes: Uint8Array, index: number): boolean => {
  const byte = bytes[index]
  return (
    isWhitespace(byte) ||
    ByteClass.isIdentifierStart(byte) ||
    ByteClass.isDecimalDigit(byte) ||
    isLiteralStart(bytes, index) ||
    punctuationKind(byte) !== 'Invalid'
  )
}

const keywordSpellings: ReadonlyArray<readonly [string, Token.TokenKind]> = [
  ['as', 'AsKeyword'],
  ['static', 'StaticKeyword'],
  ['compileError', 'CompileErrorKeyword'],
  ['fn', 'FnKeyword'],
  ['let', 'LetKeyword'],
  ['move', 'MoveKeyword'],
  ['pub', 'PubKeyword'],
  ['return', 'ReturnKeyword'],
  ['import', 'ImportKeyword'],
  ['run', 'RunKeyword'],
  ['fail', 'FailKeyword'],
  ['drop', 'DropKeyword'],
  ['unsafe', 'UnsafeKeyword'],
  ['extern', 'ExternKeyword'],
  ['export', 'ExportKeyword'],
  ['impl', 'ImplKeyword'],
  ['for', 'ForKeyword'],
  ['effect', 'EffectKeyword'],
  ['if', 'IfKeyword'],
  ['else', 'ElseKeyword'],
  ['mut', 'MutKeyword'],
  ['once', 'OnceKeyword'],
  ['match', 'MatchKeyword'],
  ['while', 'WhileKeyword'],
  ['break', 'BreakKeyword'],
  ['continue', 'ContinueKeyword'],
  ['const', 'ConstKeyword'],
  ['param', 'ParamKeyword'],
  ['struct', 'StructKeyword'],
  ['tuple', 'TupleKeyword'],
  ['enum', 'EnumKeyword'],
  ['union', 'UnionKeyword'],
  ['type', 'TypeKeyword'],
  ['service', 'ServiceKeyword'],
  ['interface', 'InterfaceKeyword'],
  ['role', 'RoleKeyword'],
  ['true', 'TrueKeyword'],
  ['false', 'FalseKeyword'],
]

const matchesSpelling = (
  bytes: Uint8Array,
  start: number,
  end: number,
  spelling: string,
): boolean => {
  if (end - start !== spelling.length) return false
  for (let index = 0; index < spelling.length; index += 1) {
    if (bytes[start + index] !== spelling.charCodeAt(index)) return false
  }
  return true
}

// Length buckets avoid comparing an identifier against keywords it cannot possibly match.
const keywordsByLength = Array.groupBy(keywordSpellings, ([spelling]) => String(spelling.length))

const keywordKind = (bytes: Uint8Array, start: number, end: number): Token.TokenKind =>
  Array.findFirst(keywordsByLength[end - start] ?? [], ([spelling]) =>
    matchesSpelling(bytes, start, end, spelling),
  ).pipe(
    Option.match({
      onNone: () => 'Identifier',
      onSome: ([, kind]) => kind,
    }),
  )

const punctuationKind = (byte: number | undefined): Token.TokenKind => {
  switch (byte) {
    case 0x28:
      return 'LeftParenthesis'
    case 0x29:
      return 'RightParenthesis'
    case 0x7b:
      return 'LeftBrace'
    case 0x7d:
      return 'RightBrace'
    case 0x5b:
      return 'LeftBracket'
    case 0x5d:
      return 'RightBracket'
    case 0x3a:
      return 'Colon'
    case 0x3b:
      return 'Semicolon'
    case 0x2c:
      return 'Comma'
    case 0x3d:
      return 'Equals'
    case 0x2d:
      return 'Minus'
    case 0x2b:
      return 'Plus'
    case 0x2a:
      return 'Star'
    case 0x2f:
      return 'Slash'
    case 0x25:
      return 'Percent'
    case 0x21:
      return 'Bang'
    case 0x3f:
      return 'Question'
    case 0x40:
      return 'At'
    case 0x3c:
      return 'Less'
    case 0x3e:
      return 'Greater'
    case 0x7c:
      return 'Pipe'
    case 0x26:
      return 'Ampersand'
    case 0x5e:
      return 'Caret'
    case 0x7e:
      return 'Tilde'
    case 0x2e:
      return 'Dot'
    default:
      return 'Invalid'
  }
}

/** One maximal run of digits and digit separators, with its separator placement already judged. */
interface DigitRun {
  readonly end: number
  readonly digits: boolean
  readonly separated: boolean
}

/**
 * Consumes the longest run of base digits and `_` separators beginning at `from`.
 *
 * The run is taken greedily so that a misplaced separator stays inside the literal it belongs to
 * rather than starting an identifier, which is what lets one diagnostic carry the literal's span.
 * A separator is well placed only with a digit of the same run on each side.
 */
const scanDigitRun = (bytes: Uint8Array, base: IntegerLiteral.Base, from: number): DigitRun => {
  let at = from
  let digits = false
  let separated = true
  let afterSeparator = false
  while (at < bytes.length) {
    if (IntegerLiteral.isDigit(base, bytes[at])) {
      digits = true
      afterSeparator = false
      at += 1
      continue
    }
    if (!DigitSeparator.isSeparator(bytes[at])) break
    if (at === from || afterSeparator) separated = false
    afterSeparator = true
    at += 1
  }
  return { end: at, digits, separated: separated && !afterSeparator }
}

const spanAt = (source: SourceFile.SourceFile, start: number, end: number): SourceSpan.SourceSpan =>
  Option.getOrThrowWith(
    SourceSpan.make(source, start, end),
    () => new RangeError(`Lexer produced an invalid span [${start}, ${end})`),
  )

/** Maps every duration rejection to its diagnostic at the rejected component's span. */
const durationDiagnostic = (
  source: SourceFile.SourceFile,
  reason: DurationLiteral.InvalidReason,
): Diagnostic.Diagnostic => {
  const span = spanAt(source, reason.start, reason.end)
  return Match.value(reason).pipe(
    Match.tagsExhaustive({
      InvalidAmount: () => Diagnostic.invalidDurationAmount(span),
      InvalidDigitSeparator: () => Diagnostic.invalidDigitSeparator(span),
      UnknownUnit: ({ spelling }) => Diagnostic.unknownDurationUnit(spelling, span),
      RepeatedUnit: ({ unit }) => Diagnostic.repeatedDurationUnit(unit, span),
      OutOfOrderUnit: ({ unit, previous }) =>
        Diagnostic.outOfOrderDurationUnit(unit, previous, span),
      SubordinateOutOfRange: ({ unit, amount, maximum }) =>
        Diagnostic.subordinateDurationOutOfRange(unit, amount, maximum, span),
    }),
  )
}

/**
 * Classifies every source byte exactly once and always appends an empty EOF token.
 *
 * This is intentionally one index-based imperative loop: a lexer is a measured per-byte hot path,
 * and the package benchmark records its throughput. Construction and results remain immutable.
 */
export const lex = (source: SourceFile.SourceFile): LexicalResult => {
  const bytes = source.bytes
  const tokens: Array<Token.Token> = []
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  let index = 0

  const pushToken = (kind: Token.TokenKind, start: number, end: number): SourceSpan.SourceSpan => {
    const span = spanAt(source, start, end)
    tokens.push(Token.make(kind, span))
    return span
  }

  const pushDurationCandidate = (start: number, numericEnd: number): boolean => {
    if (!ByteClass.isAsciiLetter(bytes[numericEnd])) return false
    index = DurationLiteral.candidateEnd(bytes, numericEnd)
    const parsed = DurationLiteral.parse(bytes, start, index)
    pushToken(parsed._tag === 'Valid' ? 'DurationLiteral' : 'InvalidDurationLiteral', start, index)
    if (parsed._tag === 'Valid') return true

    diagnostics.push(durationDiagnostic(source, parsed.reason))
    return true
  }

  while (index < bytes.length) {
    const start = index
    const byte = bytes[index]

    if (isWhitespace(byte)) {
      index += 1
      while (index < bytes.length && isWhitespace(bytes[index])) index += 1
      pushToken('Whitespace', start, index)
      continue
    }

    if (isLineCommentStart(bytes, index)) {
      let kind: Token.TokenKind = 'LineComment'
      if (bytes[index + 2] === 0x21) {
        kind = 'ModuleDocComment'
      } else if (bytes[index + 2] === 0x2f && bytes[index + 3] !== 0x2f) {
        kind = 'DocComment'
      }
      index += 2
      while (index < bytes.length && bytes[index] !== 0x0a && bytes[index] !== 0x0d) index += 1
      pushToken(kind, start, index)
      continue
    }

    // A closing quote keeps even a malformed multi-character literal on the literal path.
    // Otherwise the identifier after an apostrophe is one lifetime, bounded by its own spelling.
    if (byte === 0x27 && ByteClass.isIdentifierStart(bytes[index + 1])) {
      let lifetimeEnd = index + 2
      while (ByteClass.isIdentifierContinue(bytes[lifetimeEnd])) lifetimeEnd += 1
      if (bytes[lifetimeEnd] !== 0x27 && bytes[lifetimeEnd] !== 0x5c) {
        index = lifetimeEnd
        pushToken('Lifetime', start, index)
        continue
      }
    }

    const form = LiteralForm.recognize(bytes, index)
    const unknown = form === undefined ? LiteralForm.recognizeUnknown(bytes, index) : undefined
    if (form !== undefined || unknown !== undefined) {
      const modifierWidth = form?.modifier.length ?? unknown?.modifierWidth ?? 0
      const delimiterWidth = form?.delimiterWidth ?? unknown?.delimiterWidth ?? 1
      const boundary = LiteralForm.scanBoundary(
        bytes,
        start + modifierWidth + delimiterWidth,
        delimiterWidth,
        form?.escapePolicy ?? 'Escaped',
        form?.delimiter ?? 0x22,
      )
      index = boundary.end
      // A character literal holds exactly one Unicode scalar, which only the lexer can judge
      // while it still owns the token's extent. Every other form accepts any body length.
      const scalars =
        form?.category === 'Character' && boundary.terminated
          ? LiteralForm.scalarCount(bytes, start + delimiterWidth, index - delimiterWidth)
          : 1
      const span = pushToken(
        form !== undefined && boundary.terminated && scalars === 1
          ? LiteralForm.tokenKind(form)
          : 'InvalidStaticLiteral',
        start,
        index,
      )
      if (unknown !== undefined) {
        diagnostics.push(Diagnostic.unknownLiteralModifier(unknown.modifier, span))
      } else if (!boundary.terminated && form !== undefined) {
        diagnostics.push(
          Diagnostic.unterminatedStaticLiteral(
            form.modifier,
            form.delimiterWidth,
            span,
            form.delimiter === 0x27 ? "'" : '"',
          ),
        )
      } else if (scalars !== 1) {
        diagnostics.push(Diagnostic.characterLiteralScalarCount(scalars, span))
      }
      continue
    }

    if (ByteClass.isIdentifierStart(byte)) {
      index += 1
      while (index < bytes.length && ByteClass.isIdentifierContinue(bytes[index])) index += 1
      pushToken(keywordKind(bytes, start, index), start, index)
      continue
    }

    if (ByteClass.isDecimalDigit(byte)) {
      const base = IntegerLiteral.recognize(bytes, index)
      if (base.radix !== 10) {
        index += base.width
        const run = scanDigitRun(bytes, base, index)
        index = run.end
        if (pushDurationCandidate(start, index)) continue
        const span = pushToken(
          run.digits && run.separated ? 'DecimalInteger' : 'Invalid',
          start,
          index,
        )
        if (!run.digits) diagnostics.push(Diagnostic.missingBaseDigits(base.radix, span))
        else if (!run.separated) diagnostics.push(Diagnostic.invalidDigitSeparator(span))
        continue
      }
      const whole = scanDigitRun(bytes, base, index)
      index = whole.end
      let separated = whole.separated
      let floating = false
      if (bytes[index] === 0x2e && bytes[index + 1] !== 0x2e) {
        const fraction = scanDigitRun(bytes, base, index + 1)
        if (fraction.digits) {
          floating = true
          index = fraction.end
          separated = separated && fraction.separated
        }
      }
      let exponentDigits = true
      if (bytes[index] === 0x65 || bytes[index] === 0x45) {
        floating = true
        index += 1
        if (bytes[index] === 0x2b || bytes[index] === 0x2d) index += 1
        const exponent = scanDigitRun(bytes, base, index)
        index = exponent.end
        exponentDigits = exponent.digits
        separated = separated && exponent.separated
      }
      if (pushDurationCandidate(start, index)) continue
      let kind: Token.TokenKind = 'DecimalInteger'
      if (!separated || !exponentDigits) kind = 'Invalid'
      else if (floating) kind = 'DecimalFloat'
      const span = pushToken(kind, start, index)
      if (!separated) diagnostics.push(Diagnostic.invalidDigitSeparator(span))
      else if (!exponentDigits) diagnostics.push(Diagnostic.missingExponentDigits(span))
      continue
    }

    const compound = compoundPunctuationKind(bytes, index)
    if (compound !== undefined) {
      index += compound === 'Ellipsis' ? 3 : 2
      pushToken(compound, start, index)
      continue
    }

    const punctuation = punctuationKind(byte)
    if (punctuation !== 'Invalid') {
      index += 1
      pushToken(punctuation, start, index)
      continue
    }

    index += 1
    while (index < bytes.length && !isSupportedTokenStart(bytes, index)) index += 1
    const span = pushToken('Invalid', start, index)
    diagnostics.push(Diagnostic.unsupportedBytes(span))
  }

  pushToken('EndOfFile', bytes.length, bytes.length)
  return {
    source,
    tokens: tokens,
    diagnostics: diagnostics,
  }
}
