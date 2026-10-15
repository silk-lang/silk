import { readFileSync } from 'node:fs'
import vectors from '../fixtures/aes-gcm/vectors.json' with { type: 'json' }

const bytes = (hex: string): string => `[${Array.from(Buffer.from(hex, 'hex')).join(', ')}]`
const array = (name: string, hex: string): string =>
  `let ${name}: [u8; ${hex.length / 2}] = ${bytes(hex)}`
const filled = (length: number, value = 165): string =>
  `[${Array.from({ length }, () => value).join(', ')}]`

const imports = `import silk.aes_gcm { AesGcm, AesGcmError }
import silk.result { Result }
import silk.u8
import silk.u64
import silk.usize
`

const helpers = `
fn equal(actual: &[u8], expected: &[u8]) -> bool {
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
fn vector(key: &[u8], nonce: &[u8], aad: &[u8], input: &[u8], expected: &[u8], expectedTag: &[u8]) -> bool {
  let mut output: [u8; 40] = ${filled(40)}
  let mut tag: [u8; 16] = ${filled(16)}
  let sealed = AesGcm.seal(key, nonce, aad, input, &mut output, &mut tag)
  if let Result.Failure { error } = move sealed { return false }
  if equal(&output, expected) == false || equal(&tag, expectedTag) == false { return false }
  let mut plain: [u8; 40] = ${filled(40)}
  let opened = AesGcm.open(key, nonce, aad, expected, expectedTag, &mut plain)
  if let Result.Failure { error } = move opened { return false }
  return equal(&plain, input)
}
fn errorCode(result: Result<(), AesGcmError>) -> i32 {
  return match move result {
    Result.Success { value } => 0
    Result.Failure { error } => match move error {
      AesGcmError.InvalidKeyLength => 1
      AesGcmError.InvalidNonceLength => 2
      AesGcmError.InvalidTagLength => 3
      AesGcmError.OutputTooSmall => 4
      AesGcmError.LimitExceeded => 5
      AesGcmError.AuthenticationFailed => 6
    }
  }
}
fn rejectedOpen(code: i32, key: &[u8], nonce: &[u8], aad: &[u8], ciphertext: &[u8], tag: &[u8]) -> bool {
  let mut output: [u8; 40] = ${filled(40)}
  let empty: [u8; 0] = []
  let result = AesGcm.open(key, nonce, aad, ciphertext, tag, &mut output)
  return errorCode(move result) == code && equal(&output, &empty)
}
fn rejectedSeal(code: i32, key: &[u8], nonce: &[u8], input: &[u8]) -> bool {
  let mut output: [u8; 40] = ${filled(40)}
  let mut tag: [u8; 16] = ${filled(16)}
  let empty: [u8; 0] = []
  let result = AesGcm.seal(key, nonce, &empty, input, &mut output, &mut tag)
  return errorCode(move result) == code && equal(&output, &empty) && equal(&tag, &empty)
}
`
const caseSources = vectors.map(
  (entry, index) => `
fn case${index}() -> bool {
  ${array('key', entry.Key)}
  ${array('nonce', entry.IV)}
  ${array('aad', entry.AAD)}
  ${array('input', entry.PT)}
  ${array('expected', entry.CT)}
  ${array('tag', entry.Tag)}
  return vector(&key, &nonce, &aad, &input, &expected, &tag)
}`,
)

// One nonempty fixture gives independent authentication failures for every bound input.
const tamper = vectors.find((entry) => entry.Key.length === 32 && entry.PT.length === 34)
if (tamper === undefined) throw new Error('Missing AES-GCM boundary fixture')
// The actual private arithmetic predicate is extracted rather than publishing a test API or
// constructing invalid slices that pretend to own enormous address ranges.
const implementation = readFileSync(
  new URL('../../stdlib/silk/aes_gcm.silk', import.meta.url),
  'utf8',
)
const start = implementation.indexOf('fn lengthsAdmitted(')
const end = implementation.indexOf('fn validate(', start)
if (start < 0 || end < 0) throw new Error('Missing AES-GCM length admission predicate')
// One partial AES-256 block exercises 64-bit GHASH on wasm32, plus tag rejection before output.
export const aesGcmWasmAcceptanceSource = `${imports}${helpers}${caseSources[9]}
pub fn main() -> i32 {
  if case9() == false { return 1 }
  ${array('key', tamper.Key)}
  ${array('nonce', tamper.IV)}
  ${array('aad', tamper.AAD)}
  ${array('ciphertext', tamper.CT)}
  let tag: [u8; 16] = ${filled(16, 0)}
  if rejectedOpen(6, &key, &nonce, &aad, &ciphertext, &tag) == false { return 2 }
  return 0
}`
