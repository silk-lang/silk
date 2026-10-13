// RFC5903 §8.1, NIST ECCCDH P-256 COUNT0, and independent algebraic boundaries.
// Exact provenance and expected hex bytes: implement-p256-key-agreement/fixtures.json.
export const p256AcceptanceSource = `import silk.ownership { Copy }
import silk.p256 { P256, P256Error }
import silk.result { Result }
import silk.random { Random }
import silk.effect { Effect }
import silk.usize

struct Vector {
  scalar: [u8; 32]
  publicKey: [u8; 65]
  peer: [u8; 65]
  shared: [u8; 32]
}
impl Copy for Vector {}
fn equal(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length { return false }
  let mut i: usize = 0
  while i < left.length {
    if left[i] != right[i] { return false }
    i = i + 1
  }
  return true
}
fn verify(vector: &Vector) -> bool {
  let admitted = P256.fromBytes(&vector.scalar)
  return match move admitted {
    Result<P256, P256Error>.Success { value } => {
      let key = value.publicKey()
      if !equal(&key, &vector.publicKey) { return false }
      let result = value.agree(&vector.peer)
      return match move result {
        Result<[u8; 32], P256Error>.Success { value: shared } => equal(&shared, &vector.shared)
        Result<[u8; 32], P256Error>.Failure { error } => false
      }
    }
    Result<P256, P256Error>.Failure { error } => false
  }
}
fn rejectedScalar(bytes: &[u8], expected: P256Error) -> bool {
  let admitted = P256.fromBytes(bytes)
  return match move admitted {
    Result<P256, P256Error>.Success { value } => { drop value return false }
    Result<P256, P256Error>.Failure { error } => error == expected
  }
}
fn rejectedPeer(bytes: &[u8], expected: P256Error) -> bool {
  let scalar: [u8; 32] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
  let admitted = P256.fromBytes(&scalar)
  return match move admitted {
    Result<P256, P256Error>.Success { value } => {
      let result = value.agree(bytes)
      return match move result {
        Result<[u8; 32], P256Error>.Success { value: shared } => false
        Result<[u8; 32], P256Error>.Failure { error } => error == expected
      }
    }
    Result<P256, P256Error>.Failure { error } => false
  }
}
struct ScriptedRandom { calls: usize }
effect fn fill(self: &mut ScriptedRandom, output: &mut [u8]) -> () {
  let mut i: usize = 0
  while i < output.length { output[i] = 0 i = i + 1 }
  if self.calls == 1 {
    let order: [u8; 32] = [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 188, 230, 250, 173, 167, 23, 158, 132, 243, 185, 202, 194, 252, 99, 37, 81]
    i = 0
    while i < 32 { output[i] = order[i] i = i + 1 }
  }
  if self.calls >= 2 { output[31] = usize.toU8(self.calls - 1) }
  self.calls = self.calls + 1
  return ()
}
impl Random for ScriptedRandom { fillBytes: ScriptedRandom.fill }

pub fn main() -> i32 {
  let vectors: [Vector; 6] = [
    Vector {scalar: [200, 143, 1, 245, 16, 217, 172, 63, 112, 162, 146, 218, 162, 49, 109, 229, 68, 233, 170, 184, 175, 232, 64, 73, 198, 42, 156, 87, 134, 45, 20, 51], publicKey: [4, 218, 208, 182, 83, 148, 34, 28, 249, 176, 81, 225, 254, 202, 87, 135, 208, 152, 223, 230, 55, 252, 144, 185, 239, 148, 93, 12, 55, 114, 88, 17, 128, 82, 113, 160, 70, 28, 219, 130, 82, 214, 31, 28, 69, 111, 163, 229, 154, 177, 244, 91, 51, 172, 207, 95, 88, 56, 158, 5, 119, 184, 153, 11, 179], peer: [4, 209, 45, 251, 82, 137, 200, 212, 248, 18, 8, 183, 2, 112, 57, 140, 52, 34, 150, 151, 10, 11, 204, 183, 76, 115, 111, 199, 85, 68, 148, 191, 99, 86, 251, 243, 202, 54, 108, 194, 62, 129, 87, 133, 76, 19, 197, 141, 106, 172, 35, 240, 70, 173, 163, 15, 131, 83, 231, 79, 51, 3, 152, 114, 171], shared: [214, 132, 15, 107, 66, 246, 237, 175, 209, 49, 22, 224, 225, 37, 101, 32, 47, 239, 142, 158, 206, 125, 206, 3, 129, 36, 100, 208, 75, 148, 66, 222]},
    Vector {scalar: [198, 239, 156, 93, 120, 174, 1, 42, 1, 17, 100, 172, 179, 151, 206, 32, 136, 104, 93, 143, 6, 191, 155, 224, 178, 131, 171, 70, 71, 107, 238, 83], publicKey: [4, 209, 45, 251, 82, 137, 200, 212, 248, 18, 8, 183, 2, 112, 57, 140, 52, 34, 150, 151, 10, 11, 204, 183, 76, 115, 111, 199, 85, 68, 148, 191, 99, 86, 251, 243, 202, 54, 108, 194, 62, 129, 87, 133, 76, 19, 197, 141, 106, 172, 35, 240, 70, 173, 163, 15, 131, 83, 231, 79, 51, 3, 152, 114, 171], peer: [4, 218, 208, 182, 83, 148, 34, 28, 249, 176, 81, 225, 254, 202, 87, 135, 208, 152, 223, 230, 55, 252, 144, 185, 239, 148, 93, 12, 55, 114, 88, 17, 128, 82, 113, 160, 70, 28, 219, 130, 82, 214, 31, 28, 69, 111, 163, 229, 154, 177, 244, 91, 51, 172, 207, 95, 88, 56, 158, 5, 119, 184, 153, 11, 179], shared: [214, 132, 15, 107, 66, 246, 237, 175, 209, 49, 22, 224, 225, 37, 101, 32, 47, 239, 142, 158, 206, 125, 206, 3, 129, 36, 100, 208, 75, 148, 66, 222]},
    Vector {scalar: [125, 125, 197, 247, 30, 178, 157, 218, 248, 13, 98, 20, 99, 46, 234, 224, 61, 144, 88, 175, 31, 182, 210, 46, 216, 11, 173, 182, 43, 193, 165, 52], publicKey: [4, 234, 210, 24, 89, 1, 25, 232, 135, 107, 41, 20, 111, 248, 156, 166, 23, 112, 196, 237, 187, 249, 125, 56, 206, 56, 94, 210, 129, 216, 166, 178, 48, 40, 175, 97, 40, 31, 211, 94, 47, 167, 0, 37, 35, 172, 200, 90, 66, 156, 176, 110, 230, 100, 131, 37, 56, 159, 89, 237, 252, 225, 64, 81, 65], peer: [4, 112, 12, 72, 247, 127, 86, 88, 76, 92, 198, 50, 202, 101, 100, 13, 185, 27, 107, 172, 206, 58, 77, 246, 180, 44, 231, 204, 131, 136, 51, 210, 135, 219, 113, 229, 9, 227, 253, 155, 6, 13, 219, 32, 186, 92, 81, 220, 197, 148, 141, 70, 251, 246, 64, 223, 224, 68, 23, 130, 202, 184, 95, 164, 172], shared: [70, 252, 98, 16, 100, 32, 255, 1, 46, 84, 164, 52, 251, 221, 45, 37, 204, 197, 133, 32, 96, 86, 30, 104, 4, 13, 215, 119, 137, 151, 189, 123]},
    Vector {scalar: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], publicKey: [4, 107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3, 125, 129, 45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150, 79, 227, 66, 226, 254, 26, 127, 155, 142, 231, 235, 74, 124, 15, 158, 22, 43, 206, 51, 87, 107, 49, 94, 206, 203, 182, 64, 104, 55, 191, 81, 245], peer: [4, 107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3, 125, 129, 45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150, 79, 227, 66, 226, 254, 26, 127, 155, 142, 231, 235, 74, 124, 15, 158, 22, 43, 206, 51, 87, 107, 49, 94, 206, 203, 182, 64, 104, 55, 191, 81, 245], shared: [107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3, 125, 129, 45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150]},
    Vector {scalar: [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 188, 230, 250, 173, 167, 23, 158, 132, 243, 185, 202, 194, 252, 99, 37, 80], publicKey: [4, 107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3, 125, 129, 45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150, 176, 28, 189, 28, 1, 229, 128, 101, 113, 24, 20, 181, 131, 240, 97, 233, 212, 49, 204, 169, 148, 206, 161, 49, 52, 73, 191, 151, 200, 64, 174, 10], peer: [4, 107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3, 125, 129, 45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150, 79, 227, 66, 226, 254, 26, 127, 155, 142, 231, 235, 74, 124, 15, 158, 22, 43, 206, 51, 87, 107, 49, 94, 206, 203, 182, 64, 104, 55, 191, 81, 245], shared: [107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3, 125, 129, 45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150]},
    Vector {scalar: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 123], publicKey: [4, 0, 85, 67, 137, 74, 243, 208, 14, 215, 215, 64, 171, 219, 215, 92, 150, 176, 104, 119, 183, 135, 219, 95, 112, 238, 167, 139, 144, 168, 215, 192, 10, 187, 76, 133, 163, 216, 234, 41, 239, 170, 250, 36, 64, 105, 18, 221, 132, 213, 177, 77, 195, 43, 246, 86, 239, 108, 107, 213, 138, 93, 148, 63, 146], peer: [4, 107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3, 125, 129, 45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150, 79, 227, 66, 226, 254, 26, 127, 155, 142, 231, 235, 74, 124, 15, 158, 22, 43, 206, 51, 87, 107, 49, 94, 206, 203, 182, 64, 104, 55, 191, 81, 245], shared: [0, 85, 67, 137, 74, 243, 208, 14, 215, 215, 64, 171, 219, 215, 92, 150, 176, 104, 119, 183, 135, 219, 95, 112, 238, 167, 139, 144, 168, 215, 192, 10]},
  ]
  let mut index: usize = 0
  while index < 6 {
    if !verify(&vectors[index]) { return usize.toI32(index + 1) }
    index = index + 1
  }
  let empty: [u8; 0] = []
  let zero: [u8; 32] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  let order: [u8; 32] = [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 188, 230, 250, 173, 167, 23, 158, 132, 243, 185, 202, 194, 252, 99, 37, 81]
  let maximum: [u8; 32] = [255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]
  let shortScalar: [u8; 31] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  let longScalar: [u8; 33] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  if !rejectedScalar(&shortScalar, P256Error.InvalidLength) { return 28 }
  if !rejectedScalar(&longScalar, P256Error.InvalidLength) { return 29 }
  if !rejectedScalar(&empty, P256Error.InvalidLength) { return 11 }
  if !rejectedScalar(&zero, P256Error.InvalidScalar) { return 12 }
  if !rejectedScalar(&order, P256Error.InvalidScalar) { return 13 }
  if !rejectedScalar(&maximum, P256Error.InvalidScalar) { return 14 }
  if !rejectedPeer(&empty, P256Error.InvalidLength) { return 15 }
  let infinity: [u8; 1] = [0]
  let compressed: [u8; 33] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  let long: [u8; 66] = [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  if !rejectedPeer(&infinity, P256Error.InvalidLength) { return 23 }
  if !rejectedPeer(&compressed, P256Error.InvalidLength) { return 24 }
  if !rejectedPeer(&long, P256Error.InvalidLength) { return 25 }
  let mut peer = vectors[3].publicKey
  peer[0] = 2
  if !rejectedPeer(&peer, P256Error.InvalidEncoding) { return 16 }
  peer[0] = 4
  peer[64] = 0
  if !rejectedPeer(&peer, P256Error.InvalidPoint) { return 17 }
  peer[0] = 6
  if !rejectedPeer(&peer, P256Error.InvalidEncoding) { return 26 }
  peer[0] = 4
  index = 1
  while index < 65 { peer[index] = 0 index = index + 1 }
  if !rejectedPeer(&peer, P256Error.InvalidPoint) { return 27 }
  let prime: [u8; 32] = [255, 255, 255, 255, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]
  index = 0
  while index < 32 { peer[index + 1] = prime[index] index = index + 1 }
  if !rejectedPeer(&peer, P256Error.InvalidPoint) { return 18 }
  peer = vectors[3].publicKey
  index = 0
  while index < 32 { peer[index + 33] = prime[index] index = index + 1 }
  if !rejectedPeer(&peer, P256Error.InvalidPoint) { return 19 }
  let mut random = ScriptedRandom { calls: 0 }
  let fresh = run P256.generate() |> Effect.provideMut<Random>(&mut random)
  let key = fresh.publicKey()
  if random.calls != 3 || !equal(&key, &vectors[3].publicKey) { return 20 }
  let agreement = fresh.agree(&vectors[3].publicKey)
  let sharedMatches = match move agreement {
    Result<[u8; 32], P256Error>.Success { value } => equal(&value, &vectors[3].shared)
    Result<[u8; 32], P256Error>.Failure { error } => false
  }
  if !sharedMatches { return 21 }
  let second = run P256.generate() |> Effect.provideMut<Random>(&mut random)
  let secondKey = second.publicKey()
  drop second
  if random.calls != 4 || equal(&key, &secondKey) { return 22 }
  return 0
}`

// A single RFC exchange witnesses wasm32 fixed storage, wide products, and canonical encoding.
export const p256WasmAcceptanceSource =
  p256AcceptanceSource.slice(0, p256AcceptanceSource.indexOf('fn rejectedScalar')) +
  `
pub fn main() -> i32 {
  let vector = Vector {scalar: [200, 143, 1, 245, 16, 217, 172, 63, 112, 162, 146, 218, 162, 49, 109, 229, 68, 233, 170, 184, 175, 232, 64, 73, 198, 42, 156, 87, 134, 45, 20, 51], publicKey: [4, 218, 208, 182, 83, 148, 34, 28, 249, 176, 81, 225, 254, 202, 87, 135, 208, 152, 223, 230, 55, 252, 144, 185, 239, 148, 93, 12, 55, 114, 88, 17, 128, 82, 113, 160, 70, 28, 219, 130, 82, 214, 31, 28, 69, 111, 163, 229, 154, 177, 244, 91, 51, 172, 207, 95, 88, 56, 158, 5, 119, 184, 153, 11, 179], peer: [4, 209, 45, 251, 82, 137, 200, 212, 248, 18, 8, 183, 2, 112, 57, 140, 52, 34, 150, 151, 10, 11, 204, 183, 76, 115, 111, 199, 85, 68, 148, 191, 99, 86, 251, 243, 202, 54, 108, 194, 62, 129, 87, 133, 76, 19, 197, 141, 106, 172, 35, 240, 70, 173, 163, 15, 131, 83, 231, 79, 51, 3, 152, 114, 171], shared: [214, 132, 15, 107, 66, 246, 237, 175, 209, 49, 22, 224, 225, 37, 101, 32, 47, 239, 142, 158, 206, 125, 206, 3, 129, 36, 100, 208, 75, 148, 66, 222]}
  if !verify(&vector) { return 1 }
  return 0
}`
