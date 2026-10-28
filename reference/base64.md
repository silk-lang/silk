# Standard-padded Base64

Import `Base64`, `Base64Error`, and `Base64Reason` from `silk.encoding.base64`. The actor implements one
strict RFC 4648 standard-padded byte codec. It uses the `A–Z`, `a–z`, `0–9`, `+`, `/` alphabet and
emits every required `=`. It never inserts whitespace or a NUL terminator.

```silk
import silk.encoding.base64 { Base64, Base64Error }
import silk.core.result { Result }

pub fn main() -> i32 {
  let mut output: [u8; 4] = [0, 0, 0, 0]
  let encoded = Base64.encodeInto(&mut output, b"f")
  return match move encoded {
    Result<usize, Base64Error>.Failure { error } => 1
    Result<usize, Base64Error>.Success { value: written } => {
      if written == 4
        && output[0] == 90
        && output[1] == 103
        && output[2] == 61
        && output[3] == 61 {
        return 0
      }
      return 2
    }
  }
}
```

The four public operations are:

```silk
Base64.encodedLength(inputLength: usize) -> Result<usize, Base64Error>
Base64.decodedLength(input: &[u8]) -> Result<usize, Base64Error>
Base64.encodeInto(output: &mut [u8], input: &[u8]) -> Result<usize, Base64Error>
Base64.decodeInto(output: &mut [u8], input: &[u8]) -> Result<usize, Base64Error>
```

`encodedLength` calculates the exact padded length without allocating. It divides before it
multiplies, so an unrepresentable result returns `SizeOverflow` instead of trapping. Zero returns
zero. `decodedLength` is a full validator, not a shape-only preflight: success means the complete
input is canonical and the returned decoded length is exact.

Both `Into` operations write only the returned prefix. They leave spare suffix bytes unchanged.
Encoding calculates its exact size and checks capacity before writing. Decoding performs full input
validation, calculates its exact size, and checks capacity before writing. Therefore malformed input,
size overflow, and insufficient output leave the complete destination byte-for-byte unchanged. The
input and output cannot overlap because ordinary Silk ownership rejects a shared input borrow that
aliases the mutable destination borrow.

## Strict decoding

Empty input is valid. Every nonempty input must contain complete four-byte quanta. Only the final
quantum may contain padding: `xx==` represents one byte, `xxx=` represents two bytes, and `xxxx`
represents three bytes. The unused low four bits of the second sextet in `xx==`, or low two bits of
the third sextet in `xxx=`, must be zero.

Validation rejects spaces, tabs, CR, LF, NUL, URL-safe `-` and `_`, every other nonalphabet byte,
interior or excess `=`, a missing required final `=`, and nonzero unused pad bits. For example,
`Zg==` decodes to byte `0x66`, while `Zh==` returns `NonCanonicalPadBits` at offset 1.

Failure order is deterministic:

1. A nonzero length that is not divisible by four returns `InvalidLength` at the input length.
2. A left-to-right scan returns `InvalidByte`, `InvalidPadding`, or `NonCanonicalPadBits` at the
   defined input position. A required but absent pad position uses the input length.
3. Only valid input reaches output-capacity checking and can return `OutputTooSmall`.

`Base64Error` always has `reason`, `offset`, `required`, and `available` fields. Validation errors
populate `offset`. `OutputTooSmall` populates exact `required` and `available` lengths. `SizeOverflow`
has no additional detail; fields that do not apply are `None`.

## Availability and boundaries

The implementation is ordinary target-neutral Silk source. It allocates nothing, uses at most one
linear pass for encoding and two for decoding, and requires no Effect provider, operating-system
import, network service, or host fallback. Its ordinary runtime operations are portable across the
supported native and LLVM-to-Wasm targets; the actor defines no compile-time-only API.

This actor deliberately has no URL-safe, unpadded, MIME, streaming, allocating, or platform variant.
It also does not accept PEM whitespace or certificate framing. Use the certificate APIs for PEM
input so certificate limits and diagnostics remain attached to their owning parser. HTTP Basic
authentication, proxy policy, WebSocket handshake validation, and secret handling remain the
responsibility of their protocol actors. Base64 does not provide confidentiality.

The normative encoding and independent vectors come from [RFC 4648 sections 3–5 and
10](https://www.rfc-editor.org/rfc/rfc4648.html). The implementation and acceptance evidence live in
[`base64.silk`](../stdlib/silk/encoding/base64.silk) and
`base64Acceptance.ts`.
