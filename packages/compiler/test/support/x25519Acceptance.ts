import vectors from '../fixtures/x25519/vectors.json' with { type: 'json' }

const bytes = (hex: string): string => `[${Array.from(Buffer.from(hex, 'hex')).join(', ')}]`
const array = (name: string, hex: string): string =>
  `let ${name}: [u8; ${hex.length / 2}] = ${bytes(hex)}`
const imports = `import silk.x25519 { X25519, X25519Error }
import silk.result { Result }
import silk.random { Random }
import silk.effect { Effect }
import silk.u8
import silk.usize
`
const helpers = `
fn equal(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length { return false }
  let mut index: usize = 0
  while index < left.length {
    if left[index] != right[index] { return false }
    index = index + 1
  }
  return true
}
fn check(scalar: &[u8], peer: &[u8], expected: &[u8], publicOnly: bool, failure: bool) -> bool {
  let imported = X25519.fromSecret(scalar)
  return match move imported {
    Result.Failure { error } => false
    Result.Success { value: key } => {
      if publicOnly {
        let actual = X25519.publicKey(&key)
        return equal(&actual, expected)
      }
      let agreed = X25519.agree(move key, peer)
      return match move agreed {
        Result.Success { value } => failure == false && equal(&value, expected)
        Result.Failure { error } => match move error {
          X25519Error.AllZeroSharedSecret => failure
          X25519Error.InvalidScalarLength => false
          X25519Error.InvalidPeerLength => false
        }
      }
    }
  }
}
`
const runtimeVectors = vectors.filter((_, index) => index < 2 || index > 5)
const cases = runtimeVectors.map(
  (entry, index) => `
fn case${index}() -> bool {
  ${array('scalar', entry.scalar)}
  ${array('peer', entry.peer)}
  ${array('expected', entry.expected ?? '')}
  return check(&scalar, &peer, &expected, ${entry.kind === 'public'}, ${entry.expected === null})
}`,
)
// One RFC multiplication covers the bounded u64 field operations and owned key on wasm32.
export const x25519WasmAcceptanceSource = `${imports}${helpers}${cases[0]}
pub fn main() -> i32 { if case0() == false { return 1 } return 0 }`
