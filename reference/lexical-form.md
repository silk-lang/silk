# Lexical form

Silk source is a byte sequence that the lexer divides into identifiers, keywords, literals,
punctuation, comments, whitespace, and invalid regions. This page defines the source spellings that
are meaningful before parsing begins. The syntactic meaning of those tokens belongs to the other
reference pages.

## LEXICAL-001 — Identifiers use the ASCII identifier alphabet

**Status:** Confirmed

An identifier starts with an ASCII letter or `_` and continues with ASCII letters, decimal digits,
and `_`. Matching is case-sensitive. `_` is an identifier token; it gains its wildcard meaning only
in a pattern position.

```silk
fn valid_name2(_value: i32) -> i32 {
  return _value
}
```

**Boundary:** Non-ASCII letters are not identifier characters. A source byte that begins no valid
token belongs to one maximal unsupported-byte region.

**Diagnostics:** An unsupported byte region reports `LEX0001` and covers the entire adjacent region
rather than emitting one error per byte.

**Evidence:** lexer specification,
[identifier byte classes](https://github.com/silk-lang/silk/blob/bbab200c9fb9c17c1611436cb031f45f4d0e8fb7/bootstrap/packages/compiler/src/internal/ByteClass.ts),
lexer tests.

## LEXICAL-002 — The keyword vocabulary is closed

**Status:** Confirmed

The following complete identifiers are keywords:

```text
as break const continue drop effect else enum fail false fn for if impl import
interface let match move mut once pub return role run service struct true unsafe while
```

Keyword recognition applies only to a complete identifier. `letter`, `matcher`, and `services` are
identifiers, not a keyword followed by a suffix.

Some grammar positions also give a contextual meaning to an ordinary identifier, such as `where`
in generic constraints and `place` immediately after `match`. A contextual word remains an identifier token and is not added to the
closed lexical keyword vocabulary.

**Boundary:** Keyword spelling is lowercase and case-sensitive. A reserved keyword cannot be used
as an identifier merely because the surrounding grammar would otherwise make its role clear.

**Diagnostics:** Keyword misuse is a syntax error at the position where the grammar requires a
different token. There is no separate lexical diagnostic for a correctly spelled keyword.

**Evidence:** [keyword table](https://github.com/silk-lang/silk/blob/bbab200c9fb9c17c1611436cb031f45f4d0e8fb7/bootstrap/packages/compiler/src/Lexer.ts),
[token catalog](https://github.com/silk-lang/silk/blob/bbab200c9fb9c17c1611436cb031f45f4d0e8fb7/bootstrap/packages/compiler/src/Token.ts),
complete-identifier tests.

## LEXICAL-003 — Line comments end at the physical line boundary

**Status:** Confirmed

`//` begins an ordinary comment. `///` begins a documentation comment attached to the following
declaration, and `//!` begins documentation for the containing module. Consecutive documentation
lines retain their source order.

```silk
//! Describes this module.

/// Returns the supplied value.
fn identity(value: i32) -> i32 {
  return value
}
```

A blank line or an intervening ordinary comment separates a declaration from a preceding `///`
block. Documentation attachment and which declarations may receive comments are defined by the
[doc comment style guide](documentation-style-guide.md).

**Boundary:** Silk has no block-comment token. Comment markers inside a static literal are literal
content, and quote characters inside a comment do not begin literals.

**Diagnostics:** Comments themselves do not produce a diagnostic. Documentation comments that do
not attach at a supported declaration position remain trivia and do not become API documentation.

**Evidence:** lexer specification,
documentation attachment tests,
lexer tests.

## LEXICAL-004 — Numeric literals have explicit base, separator, and sign rules

**Status:** Confirmed

An integer literal is decimal by default. Prefixes `0b`, `0o`, and `0x` select binary, octal, and
hexadecimal digits; the base letter may be uppercase. `_` may separate digits only when a valid
digit of the same run appears on both sides.

A floating literal contains a decimal point, an exponent, or both. Its exponent uses `e` or `E` and
may begin with `+` or `-`. Decimal digit separators follow the same between-digits rule.

```silk
fn values() -> f64 {
  let decimal = 1_000_000
  let binary = 0b1010_0000
  let octal = 0o777
  let hexadecimal = 0xff_ff
  let scaled = 1_000.5e-2
  return scaled
}
```

The leading `-` of a negative value is a prefix operator, not part of the literal token. Literal
type selection and range checking are defined by [values and types](values-and-types.md).

**Boundary:** A base prefix must be followed by a digit of that base. `_1`, `1_`, `1__0`, `0x_ff`,
and an exponent with no digits are invalid numeric spellings.

**Diagnostics:** A base prefix without digits reports `LEX0004`; an invalid separator reports
`LEX0005`; and an exponent without digits reports `LEX0006`.

**Evidence:** numeric lexer specification,
integer lexer tests,
floating-point tests.

## LEXICAL-005 — Duration literals use canonical fixed-unit components

**Status:** Confirmed

A duration literal is one or more adjacent decimal components. Each component is a whole decimal
amount followed immediately by one exact lowercase unit suffix:

```text
duration  = component+
component = decimal-digits ("w" | "d" | "h" | "m" | "s" | "ms" | "us" | "ns")
```

Digit separators may group an amount under the ordinary between-digits rule. Units in a compound
must appear at most once and in strictly descending order: `w`, `d`, `h`, `m`, `s`, `ms`, `us`,
then `ns`. Omitted units are valid. Zero components and leading-zero padding remain part of the
source token.

```silk
const pollInterval: u64 = 300ms
const alignedTimeout: u64 = 01h05m00s
const preciseWindow: u64 = 1s999ms999us999ns
```

The first component is limited only by the final `u64` nanosecond range. Every later component is
a canonical subordinate field:

| Unit             | Later-component range |
| ---------------- | --------------------- |
| `d`              | `0...6`               |
| `h`              | `0...23`              |
| `m`, `s`         | `0...59`              |
| `ms`, `us`, `ns` | `0...999`             |

Whitespace and punctuation end a duration token. `1h30m30s` is one literal, `1h + 30m + 30s` is
three literals joined by operators, and `1h 30m` is two adjacent expressions rather than one
compound.

**Boundary:** A numeric token immediately followed by ASCII letters commits to duration
recognition. Malformed candidates such as `1.5s`, `0x10s`, `3sec`, `1H`, `1h60m`, `1m1h`, and
`1h1h` remain one `InvalidDurationLiteral`; they do not split into a number and identifier. A
standalone exponent spelling such as `1e5` remains a floating literal because no unit follows it.

**Diagnostics:** A malformed candidate produces exactly one focused lexical diagnostic. Invalid
amounts report `LEX0008`, unknown units `LEX0009`, repeated units `LEX0010`, out-of-order units
`LEX0011`, and subordinate fields outside their range `LEX0012`. Invalid digit separators retain
`LEX0005`.

**Evidence:** duration literal specification,
[duration actor](https://github.com/silk-lang/silk/blob/bbab200c9fb9c17c1611436cb031f45f4d0e8fb7/bootstrap/packages/compiler/src/internal/DurationLiteral.ts),
lexer tests.

## LEXICAL-006 — Static text and byte literals have a closed form vocabulary

**Status:** Confirmed

Silk recognizes six quote-delimited text and byte forms. A modifier must touch its opening
delimiter.

| Form           | Value category | Body policy     |
| -------------- | -------------- | --------------- |
| `"text"`       | `string` text  | Escapes decoded |
| `"""text"""`   | `string` text  | Escapes decoded |
| `r"text"`      | `string` text  | Raw             |
| `r"""text"""`  | `string` text  | Raw             |
| `b"bytes"`     | `&[u8]` bytes  | Escapes decoded |
| `b"""bytes"""` | `&[u8]` bytes  | Escapes decoded |

The triple delimiter permits physical line endings in the body. The single delimiter ends at a
physical line ending when no closing quote appears first. Raw text treats every backslash as an
ordinary backslash; it still must contain valid UTF-8. Escaped text and byte bodies recognize
`\n`, `\r`, `\t`, `\0`, `\"`, `\\`, `\xNN`, and `\u{...}`. `\x` requires exactly two hexadecimal
digits, while `\u{...}` must denote one Unicode scalar.

```silk
fn escaped() -> string {
  return "line one\nline two"
}

fn raw() -> string {
  return r"line one\nline two"
}

fn bytes() -> &[u8] {
  return b"Silk\x00"
}
```

The literal types, text equality, ownership, and conversion rules are defined by
[values and types](values-and-types.md#text-001--string-is-immutable-utf-8-text-and-byte-strings-are-byte-views).

**Boundary:** Literal modifiers form a closed vocabulary. An identifier-like modifier adjacent to
a quote, such as `future"value"`, is reserved and invalid rather than an identifier followed by a
text literal. There is no raw byte-string form.

**Diagnostics:** An unknown modifier reports `LEX0002`; an absent closing delimiter reports
`LEX0003`; malformed escapes and invalid decoded literal data report the corresponding static-data
diagnostic without publishing a partial value.

**Evidence:** [literal-form catalog](https://github.com/silk-lang/silk/blob/bbab200c9fb9c17c1611436cb031f45f4d0e8fb7/bootstrap/packages/compiler/src/LiteralForm.ts),
literal-form tests,
raw-string acceptance tests,
static text specification.

## LEXICAL-007 — A character literal denotes exactly one Unicode scalar

**Status:** Confirmed

A character literal is delimited by `'` and uses the escaped-body policy. Its decoded body must
contain exactly one Unicode scalar, irrespective of that scalar's UTF-8 byte width.

```silk
const latinSmallE: char = 'é'
const snowman: char = '\u{2603}'
const apostrophe: char = '\''
```

Character literals default to `char`; an immediate integer context selects their Unicode scalar
number when it fits that integer type. For example, `let byte: u8 = 'A'` stores 65. This does not
change literal decoding or encode the character as UTF-8 bytes.

Character literals recognize the escaped text vocabulary plus `\'` for their delimiter. Their
value and type behavior is defined by
[CHAR-001](values-and-types.md#char-001--char-holds-exactly-one-unicode-scalar-value).

**Boundary:** `''`, `'ab'`, an invalid scalar escape, and a character body that reaches the line
ending without a closing apostrophe are invalid. `b'a'` is not a byte-character form: `b` is an
identifier followed by a character literal.

**Diagnostics:** Zero or multiple decoded scalars report `LEX0007`. An absent closing delimiter
reports `LEX0003`; malformed escapes receive their literal diagnostic.

**Evidence:** [literal-form catalog](https://github.com/silk-lang/silk/blob/bbab200c9fb9c17c1611436cb031f45f4d0e8fb7/bootstrap/packages/compiler/src/LiteralForm.ts),
character scalar tests,
literal-form tests.

## LEXICAL-008 — Tokenization is longest and lossless

**Status:** Confirmed

At each byte position, the lexer recognizes the longest committed token introduction. Compound
punctuation such as `==`, `!=`, `<=`, `>=`, `&&`, `||`, `|>`, `=>`, `->`, and `..` is therefore one
token rather than two adjacent tokens. Whitespace and comments remain explicit trivia so tools can
reconstruct the original source.

**Boundary:** Longest recognition does not invent a token outside the closed vocabulary. Invalid
bytes remain covered by explicit invalid tokens, and unknown literal modifiers remain invalid even
when their prefix resembles a supported modifier.

**Diagnostics:** Unsupported byte regions report `LEX0001`. Other malformed token introductions
use their specific lexical diagnostic.

**Evidence:** [lexer implementation](https://github.com/silk-lang/silk/blob/bbab200c9fb9c17c1611436cb031f45f4d0e8fb7/bootstrap/packages/compiler/src/Lexer.ts),
[lossless token model](https://github.com/silk-lang/silk/blob/bbab200c9fb9c17c1611436cb031f45f4d0e8fb7/bootstrap/packages/compiler/src/Token.ts),
lexer tests.

## LEXICAL-009 — An apostrophe distinguishes lifetime names from character literals

**Status:** Confirmed

An apostrophe followed by an identifier without a closing character delimiter forms a lifetime
name, such as `'data` or `'static`. A closed character spelling such as `'a'` remains a character
literal. Lifetime names use the same ASCII identifier alphabet as ordinary names.

**Boundary:** Lifetime tokens are valid only in lifetime-aware grammar positions. A malformed
closed character literal retains its character diagnostic; it does not silently become a lifetime
or consume subsequent declarations.

**Diagnostics:** Character decoding uses the existing character-literal diagnostics. Unknown or
invalid lifetime binders use the declaration diagnostics in [lifetimes](lifetimes.md).

**Evidence:** lexer tests,
lifetime syntax requirements.
