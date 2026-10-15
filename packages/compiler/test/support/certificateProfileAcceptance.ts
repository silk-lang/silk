const literal = (base64: string): string => {
  const bytes = Buffer.from(base64, 'base64')
  return `b"${Array.from(bytes, (byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`
}

const wildcard254Name = Array.from(
  Buffer.from(`*.${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(62)}.${'d'.repeat(61)}`, 'ascii'),
)
if (wildcard254Name.length !== 254) throw new Error('Wildcard regression must be 254 octets')
/** Compact target-portability witness: unsupported certificate bytes remain storable on Wasm. */
export const certificateProfileWasmSource = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.certificate { Certificate, DecodeError, DecodeLimits }
import silk.effect { Effect }
import silk.result { Result }
import silk.trust_anchor { TrustAnchor }

effect fn allocated() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let decoded = run Certificate.decodeDer(
    ${literal('MFMwRqADAgEBAgEBMAMGASowADAeFw01MDAxMDEwMDAwMDBaFw00OTEyMzEyMzU5NTlaMAAwCzAFBgEqBQADAgOggQIHgIICAf4wBQYBKwUAAwIC/A==')},
    DecodeLimits.defaults(),
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  return match move decoded {
    Result<Certificate, DecodeError>.Failure {error} => 1
    Result<Certificate, DecodeError>.Success {value} => {
      let anchor = TrustAnchor.fromCertificate(move value)
      if TrustAnchor.encodedBytes(&anchor) == 85 { return 42 }
      return 2
    }
  }
}

effect fn allocationFailure(error: OutOfMemoryError) -> i32 { return 3 }
pub fn main() -> i32 { return run Effect.catchAll(allocated(), allocationFailure) }
`
