export const ecdsaP256WasmSource = `import silk.p256 { EcdsaP256Sha256, P256SignatureError }
import silk.result { Result }
fn ecdsaOk(result: Result<(), P256SignatureError>) -> bool {
return match move result { Result<(), P256SignatureError>.Success {value} => true Result<(), P256SignatureError>.Failure {error} => false }
}
fn ecdsaError(result: Result<(), P256SignatureError>, expected: P256SignatureError) -> bool {
return match move result { Result<(), P256SignatureError>.Success {value} => false Result<(), P256SignatureError>.Failure {error} => error == expected }
}
pub fn main() -> i32 {
let key: [u8; 65] = [4, 228, 36, 220, 97, 212, 187, 60, 183, 239, 67, 68, 167, 248, 149, 122, 12, 81, 52, 225, 111, 122, 103, 192, 116, 248, 46, 110, 18, 244, 154, 191, 60, 151, 14, 237, 122, 162, 188, 72, 101, 21, 69, 148, 157, 225, 221, 218, 240, 18, 126, 89, 101, 172, 133, 209, 36, 61, 111, 96, 231, 223, 174, 233, 39]
let message: [u8; 128] = [225, 19, 10, 246, 163, 140, 203, 65, 42, 156, 141, 19, 225, 93, 191, 201, 230, 154, 22, 56, 90, 243, 195, 241, 229, 218, 149, 79, 213, 231, 196, 95, 215, 94, 43, 140, 54, 105, 146, 40, 233, 40, 64, 192, 86, 47, 191, 55, 114, 240, 126, 23, 241, 173, 213, 101, 136, 221, 69, 247, 69, 14, 18, 23, 173, 35, 153, 34, 221, 156, 50, 105, 93, 199, 31, 242, 66, 76, 160, 222, 193, 50, 26, 164, 112, 100, 160, 68, 183, 254, 60, 43, 151, 208, 60, 228, 112, 165, 146, 48, 76, 94, 242, 30, 237, 159, 147, 218, 86, 187, 35, 45, 30, 235, 0, 53, 249, 191, 13, 250, 253, 204, 70, 6, 39, 43, 32, 163]
let signature: [u8; 71] = [48, 69, 2, 33, 0, 191, 150, 185, 154, 164, 156, 112, 92, 145, 11, 227, 49, 66, 1, 124, 100, 47, 245, 64, 199, 99, 73, 185, 218, 183, 47, 152, 31, 217, 52, 127, 79, 2, 32, 23, 197, 80, 149, 129, 144, 137, 194, 224, 59, 156, 212, 21, 171, 223, 18, 68, 78, 50, 48, 117, 217, 143, 49, 146, 11, 158, 15, 87, 236, 135, 28]
if !ecdsaOk(EcdsaP256Sha256.verify(&key, &message, &signature)) { return 1 }
return 42
}`
