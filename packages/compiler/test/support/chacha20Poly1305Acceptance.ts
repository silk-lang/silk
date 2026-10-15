import { readFileSync } from 'node:fs'

interface AeadVector {
  readonly name: string
  readonly key: string
  readonly nonce: string
  readonly aad: string
  readonly plaintext: string
  readonly ciphertext: string
  readonly tag: string
}
interface PolyVector {
  readonly name: string
  readonly key: string
  readonly message: string
  readonly tag: string
}
const vectors: {
  readonly aead: ReadonlyArray<AeadVector>
  readonly poly: ReadonlyArray<PolyVector>
  readonly block: {
    readonly key: string
    readonly nonce: string
    readonly counter: number
    readonly output: string
  }
} = JSON.parse(readFileSync(new URL('../fixtures/chacha20-poly1305.json', import.meta.url), 'utf8'))

const bytes = (hex: string): string => `[${Array.from(Buffer.from(hex, 'hex')).join(', ')}]`
const declaration = (name: string, hex: string, mutable = false): string =>
  `let ${mutable ? 'mut ' : ''}${name}: [u8; ${hex.length / 2}] = ${bytes(hex)}`
const filled = (length: number): string => `[${Array.from({ length }, () => 165).join(', ')}]`

const checks = `fn equalBytes(actual: &[u8], expected: &[u8]) -> bool {
  if actual.length < expected.length { return false }
  let mut index: usize = 0
  while index < expected.length {
    if actual[index] != expected[index] { return false }
    index = index + 1
  }
  while index < actual.length {
    if actual[index] != 165 { return false }
    index = index + 1
  }
  return true
}
fn sentinels(actual: &[u8]) -> bool {
  let empty: [u8; 0] = []
  return equalBytes(actual, &empty)
}
fn succeeded(result: Result<(), AeadError>) -> bool {
  return match move result {
    Result<(), AeadError>.Success {value} => true
    Result<(), AeadError>.Failure {error} => false
  }
}
fn errorCode(result: Result<(), AeadError>) -> i32 {
  return match move result {
    Result<(), AeadError>.Success {value} => 0
    Result<(), AeadError>.Failure {error} => match move error {
      AeadError.InvalidKey => 1
      AeadError.InvalidNonce => 2
      AeadError.InvalidTag => 3
      AeadError.OutputTooSmall => 4
      AeadError.LimitExceeded => 5
      AeadError.AuthenticationFailed => 6
    }
  }
}`
const aeadCheck = (vector: AeadVector, index: number): string => `fn aead${index}() -> bool {
  ${declaration('key', vector.key)}
  ${declaration('nonce', vector.nonce, true)}
  ${declaration('aad', vector.aad, true)}
  ${declaration('plain', vector.plaintext)}
  ${declaration('expected', vector.ciphertext)}
  ${declaration('expectedTag', vector.tag)}
  let mut cipher: [u8; ${vector.plaintext.length / 2 + 1}] = ${filled(vector.plaintext.length / 2 + 1)}
  let mut tag: [u8; 16] = ${filled(16)}
  if !succeeded(ChaCha20Poly1305.seal(&key, &nonce, &aad, &plain, &mut cipher, &mut tag)) { return false }
  if !equalBytes(&cipher, &expected) || !equalBytes(&tag, &expectedTag) { return false }
  let mut opened: [u8; ${vector.plaintext.length / 2 + 1}] = ${filled(vector.plaintext.length / 2 + 1)}
  if !succeeded(ChaCha20Poly1305.open(&key, &nonce, &aad, &expected, &tag, &mut opened)) { return false }
  return equalBytes(&opened, &plain)
}`

/** A small public-import witness crosses the stream-block boundary on wasm32. */
export const chacha20Poly1305WasmSource = `import silk.chacha20_poly1305 {ChaCha20Poly1305, AeadError}
import silk.result {Result}
${checks}
${vectors.aead.slice(4, 5).map(aeadCheck).join('\n')}
pub fn main() -> i32 {
  if !aead0() { return 1 }
  return 42
}`
