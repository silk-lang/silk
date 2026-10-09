// Committed fixtures and provenance: openspec/changes/archive/2026-09-12-implement-tls13-hkdf-labels/fixtures.json
export const tlsHkdfAcceptanceSource = `import silk.tls_hkdf { TlsHkdfSha256, TlsHkdfSha384, LabelError }
import silk.sha2 { Sha256, Sha384 }
import silk.result { Result }
import silk.bytes { Bytes }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.slice { Slice }
fn same(a: &[u8], b: &[u8]) -> bool {
  if a.length != b.length { return false }
  let mut i: usize = 0
  while i < a.length { if a[i] != b[i] { return false } i = i + 1 }
  return true
}
fn ok(r: Result<(), LabelError>) -> bool {
  return match move r { Result<(), LabelError>.Success {value} => true Result<(), LabelError>.Failure {error} => false }
}
fn sentinel(a: &[u8]) -> bool {
  let mut i: usize = 0
  while i < a.length { if a[i] != 0 { return false } i = i + 1 }
  return true
}
fn case0() -> bool {
  let secret: [u8; 32] = [51, 173, 10, 28, 96, 126, 192, 59, 9, 230, 205, 152, 147, 104, 12, 226, 16, 173, 243, 0, 170, 31, 38, 96, 225, 178, 46, 16, 241, 112, 249, 42]
  let label: [u8; 7] = [100, 101, 114, 105, 118, 101, 100]
  let context: [u8; 32] = [227, 176, 196, 66, 152, 252, 28, 20, 154, 251, 244, 200, 153, 111, 185, 36, 39, 174, 65, 228, 100, 155, 147, 76, 164, 149, 153, 27, 120, 82, 184, 85]
  let mut output: [u8; 32] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  if !ok(TlsHkdfSha256.expandLabel(&secret, &label, &context, &mut output)) { return false }
  let expected: [u8; 32] = [111, 38, 21, 161, 8, 199, 2, 197, 103, 143, 84, 252, 157, 186, 182, 151, 22, 192, 118, 24, 156, 72, 37, 12, 235, 234, 195, 87, 108, 54, 17, 186]
  if !same(&output, &expected) { return false }
  let messages: [u8; 0] = []
  let resultderiveSecret = TlsHkdfSha256.deriveSecret(&secret, &label, &messages)
  let validderiveSecret = match move resultderiveSecret {
    Result<[u8; 32], LabelError>.Failure {error} => false
    Result<[u8; 32], LabelError>.Success {value} => same(&value, &expected)
  }
  if !validderiveSecret { return false }
  let resultderiveSecretFromHash = TlsHkdfSha256.deriveSecretFromHash(&secret, &label, &context)
  let validderiveSecretFromHash = match move resultderiveSecretFromHash {
    Result<[u8; 32], LabelError>.Failure {error} => false
    Result<[u8; 32], LabelError>.Success {value} => same(&value, &expected)
  }
  if !validderiveSecretFromHash { return false }
  return true
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
  let messages: [u8; 15] = [104, 97, 110, 100, 115, 104, 97, 107, 101, 32, 98, 121, 116, 101, 115]
  let resultderiveSecret = TlsHkdfSha384.deriveSecret(&secret, &label, &messages)
  let validderiveSecret = match move resultderiveSecret {
    Result<[u8; 48], LabelError>.Failure {error} => false
    Result<[u8; 48], LabelError>.Success {value} => same(&value, &expected)
  }
  if !validderiveSecret { return false }
  let resultderiveSecretFromHash = TlsHkdfSha384.deriveSecretFromHash(&secret, &label, &context)
  let validderiveSecretFromHash = match move resultderiveSecretFromHash {
    Result<[u8; 48], LabelError>.Failure {error} => false
    Result<[u8; 48], LabelError>.Success {value} => same(&value, &expected)
  }
  if !validderiveSecretFromHash { return false }
  return true
}
fn case3() -> bool {
  let secret: [u8; 32] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]
  let label: [u8; 7] = [116, 108, 115, 49, 51, 32, 0]
  let context: [u8; 4] = [0, 99, 116, 120]
  let mut output: [u8; 33] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  if !ok(TlsHkdfSha256.expandLabel(&secret, &label, &context, &mut output)) { return false }
  let expected: [u8; 33] = [30, 80, 169, 117, 240, 200, 55, 38, 254, 23, 138, 115, 184, 2, 82, 28, 11, 71, 197, 80, 33, 155, 52, 18, 183, 185, 150, 96, 217, 112, 247, 2, 228]
  if !same(&output, &expected) { return false }
  return true
}
fn case4() -> bool {
  let secret: [u8; 48] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47]
  let label: [u8; 249] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248]
  let context: [u8; 255] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254]
  let mut output: [u8; 49] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  if !ok(TlsHkdfSha384.expandLabel(&secret, &label, &context, &mut output)) { return false }
  let expected: [u8; 49] = [11, 83, 157, 6, 216, 203, 234, 150, 27, 59, 25, 90, 200, 9, 233, 240, 32, 26, 129, 223, 209, 118, 194, 75, 112, 201, 214, 241, 41, 149, 3, 10, 175, 168, 95, 129, 107, 103, 69, 183, 239, 233, 69, 220, 71, 208, 208, 173, 31]
  if !same(&output, &expected) { return false }
  return true
}
effect fn case5() -> bool ! OutOfMemoryError {
  let secret: [u8; 32] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]
  let label: [u8; 3] = [107, 101, 121]
  let context: [u8; 0] = []
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut allocation = Bytes.zeroed(8160) |> Effect.provideMut(&mut allocator)
  let mut output = run allocation
  if !ok(TlsHkdfSha256.expandLabel(&secret, &label, &context, Bytes.asMutSlice(&mut output))) { return false }
  let digest = Sha256.hash(Bytes.asSlice(&output))
  let expected: [u8; 32] = [8, 7, 166, 111, 103, 19, 26, 223, 248, 115, 15, 207, 249, 215, 141, 113, 35, 135, 98, 16, 10, 57, 69, 109, 205, 193, 160, 40, 137, 167, 109, 56]
  if !same(&digest, &expected) { return false }
  let mut allocation2 = Bytes.zeroed(8161) |> Effect.provideMut(&mut allocator)
  let mut excessive = run allocation2
  let rejected = TlsHkdfSha256.expandLabel(&secret, &label, &context, Bytes.asMutSlice(&mut excessive))
  let valid = match move rejected {
    Result<(), LabelError>.Success {value} => false
    Result<(), LabelError>.Failure {error} => match move error {
      LabelError.OutputLength {requested, maximum} => requested == 8161 && maximum == 8160
      LabelError.LabelLength {requested, maximum} => false
      LabelError.ContextLength {requested, maximum} => false
      LabelError.MessageTooLong {requested, maximum} => false
    }
  }
  if !valid || !sentinel(Bytes.asSlice(&excessive)) { return false }
  return true
}
effect fn case6() -> bool ! OutOfMemoryError {
  let secret: [u8; 48] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47]
  let label: [u8; 3] = [107, 101, 121]
  let context: [u8; 0] = []
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut allocation = Bytes.zeroed(12240) |> Effect.provideMut(&mut allocator)
  let mut output = run allocation
  if !ok(TlsHkdfSha384.expandLabel(&secret, &label, &context, Bytes.asMutSlice(&mut output))) { return false }
  let digest = Sha256.hash(Bytes.asSlice(&output))
  let expected: [u8; 32] = [158, 123, 101, 93, 14, 249, 130, 249, 216, 52, 120, 13, 247, 169, 134, 185, 44, 247, 214, 209, 161, 211, 35, 23, 241, 185, 126, 143, 93, 26, 229, 253]
  if !same(&digest, &expected) { return false }
  let mut allocation2 = Bytes.zeroed(12241) |> Effect.provideMut(&mut allocator)
  let mut excessive = run allocation2
  let rejected = TlsHkdfSha384.expandLabel(&secret, &label, &context, Bytes.asMutSlice(&mut excessive))
  let valid = match move rejected {
    Result<(), LabelError>.Success {value} => false
    Result<(), LabelError>.Failure {error} => match move error {
      LabelError.OutputLength {requested, maximum} => requested == 12241 && maximum == 12240
      LabelError.LabelLength {requested, maximum} => false
      LabelError.ContextLength {requested, maximum} => false
      LabelError.MessageTooLong {requested, maximum} => false
    }
  }
  if !valid || !sentinel(Bytes.asSlice(&excessive)) { return false }
  return true
}
fn framingBounds() -> bool {
  let secret: [u8; 32] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  let label: [u8; 250] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  let context: [u8; 256] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  let empty: [u8; 0] = []
  let mut output: [u8; 1] = [0]
  let mut nothing: [u8; 0] = []
  if !ok(TlsHkdfSha256.expandLabel(&secret, Slice.view<u8>(&label, 0, 249), Slice.view<u8>(&context, 0, 255), &mut nothing)) { return false }
  if ok(TlsHkdfSha256.expandLabel(&secret, &label, &empty, &mut nothing)) { return false }
  if ok(TlsHkdfSha256.expandLabel(&secret, Slice.view<u8>(&label, 0, 1), &context, &mut nothing)) { return false }
  let badLabel = TlsHkdfSha256.expandLabel(&secret, &label, &empty, &mut output)
  let badEmpty = TlsHkdfSha256.expandLabel(&secret, &empty, &empty, &mut nothing)
  let badContext = TlsHkdfSha256.expandLabel(&secret, Slice.view<u8>(&label, 0, 1), &context, &mut output)
  let a = match move badLabel {
    Result<(), LabelError>.Failure {error} => match move error { LabelError.LabelLength {requested, maximum} => requested == 250 && maximum == 249
      LabelError.ContextLength {requested, maximum} => false
      LabelError.OutputLength {requested, maximum} => false
      LabelError.MessageTooLong {requested, maximum} => false }
    Result<(), LabelError>.Success {value} => false
  }
  let b = match move badEmpty {
    Result<(), LabelError>.Failure {error} => match move error { LabelError.LabelLength {requested, maximum} => requested == 0 && maximum == 249
      LabelError.ContextLength {requested, maximum} => false
      LabelError.OutputLength {requested, maximum} => false
      LabelError.MessageTooLong {requested, maximum} => false }
    Result<(), LabelError>.Success {value} => false
  }
  let c = match move badContext {
    Result<(), LabelError>.Failure {error} => match move error { LabelError.ContextLength {requested, maximum} => requested == 256 && maximum == 255
      LabelError.LabelLength {requested, maximum} => false
      LabelError.OutputLength {requested, maximum} => false
      LabelError.MessageTooLong {requested, maximum} => false }
    Result<(), LabelError>.Success {value} => false
  }
  return a && b && c && sentinel(&output)
}
effect fn verify() -> i32 ! OutOfMemoryError {
  let valid0 = case0()
  if !valid0 { return 1 }
  let valid1 = case1()
  if !valid1 { return 2 }
  let valid2 = case2()
  if !valid2 { return 3 }
  let valid3 = case3()
  if !valid3 { return 4 }
  let valid4 = case4()
  if !valid4 { return 5 }
  let valid5 = run case5()
  if !valid5 { return 6 }
  let valid6 = run case6()
  if !valid6 { return 7 }
  if !framingBounds() { return 20 }
  return 42
}
effect fn failed(error: OutOfMemoryError) -> i32 { return 99 }
pub fn main() -> i32 { return run Effect.catchAll(verify(), failed) }`

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
