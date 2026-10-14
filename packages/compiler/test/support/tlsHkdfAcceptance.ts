export const tlsHkdfWasmSource = `import silk.tls_hkdf { TlsHkdfSha256, TlsHkdfSha384, LabelError }
import silk.result { Result }
fn same(a: &[u8], b: &[u8]) -> bool {
  if a.length != b.length { return false }
  let mut i: usize = 0
  while i < a.length { if a[i] != b[i] { return false } i = i + 1 }
  return true
}
fn ok(r: Result<(), LabelError>) -> bool {
  return match move r { Result<(), LabelError>.Success {value} => true Result<(), LabelError>.Failure {error} => false }
}

fn case1() -> bool {
  let secret: [u8; 32] = [182, 123, 125, 105, 12, 193, 108, 78, 117, 229, 66, 19, 203, 45, 55, 180, 233, 201, 18, 188, 222, 217, 16, 93, 66, 190, 253, 89, 211, 145, 173, 56]
  let label: [u8; 3] = [107, 101, 121]
  let context: [u8; 0] = []
  let mut output: [u8; 16] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  if !ok(TlsHkdfSha256.expandLabel(&secret, &label, &context, &mut output)) { return false }
  let expected: [u8; 16] = [63, 206, 81, 96, 9, 194, 23, 39, 208, 242, 228, 232, 110, 228, 3, 188]
  if !same(&output, &expected) { return false }
  return true
}
fn case2() -> bool {
  let secret: [u8; 48] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47]
  let label: [u8; 7] = [100, 101, 114, 105, 118, 101, 100]
  let context: [u8; 48] = [11, 157, 171, 252, 210, 196, 190, 209, 123, 87, 128, 187, 139, 162, 185, 66, 5, 218, 227, 25, 141, 254, 198, 123, 127, 172, 5, 131, 147, 43, 200, 55, 203, 31, 54, 145, 142, 36, 93, 62, 55, 205, 188, 244, 72, 249, 116, 38]
  let mut output: [u8; 48] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  if !ok(TlsHkdfSha384.expandLabel(&secret, &label, &context, &mut output)) { return false }
  let expected: [u8; 48] = [168, 86, 166, 17, 149, 241, 90, 28, 133, 99, 208, 200, 68, 33, 138, 15, 4, 64, 38, 208, 207, 73, 132, 181, 47, 47, 236, 210, 145, 167, 20, 55, 251, 129, 251, 166, 154, 105, 253, 205, 1, 38, 123, 128, 244, 184, 93, 96]
  if !same(&output, &expected) { return false }
  return true
}
pub fn main() -> i32 { if !case1() || !case2() { return 1 } return 0 }`
