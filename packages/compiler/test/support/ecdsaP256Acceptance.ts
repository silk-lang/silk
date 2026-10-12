import { readFileSync } from 'node:fs'

// Canonical owner source allows zero-digest/private length seams without a test-only public API.
const owner = readFileSync(new URL('../../stdlib/silk/p256.silk', import.meta.url), 'utf8')
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

export const ecdsaP256AcceptanceSource = `${owner}
fn ecdsaMetadataOk(key: &[u8], message: &[u8], signature: &[u8]) -> bool {
  let ecOid: [u8; 7] = [42, 134, 72, 206, 61, 2, 1]
  let sigOid: [u8; 8] = [42, 134, 72, 206, 61, 4, 3, 2]
  let curve: [u8; 10] = [6, 8, 42, 134, 72, 206, 61, 3, 1, 7]
  let empty: [u8; 0] = []
  let keyAlg = AlgorithmView {der: &empty, oid: &ecOid, parametersDer: Option<&[u8]>.some(&curve)}
  let sigAlg = AlgorithmView {der: &empty, oid: &sigOid, parametersDer: Option<&[u8]>.none()}
  let keyBits = BitStringView {bytes: key, unusedBits: 0}
  let sigBits = BitStringView {bytes: signature, unusedBits: 0}
  return ecdsaOk(EcdsaP256Sha256.verifyCertificate(&keyAlg, &keyBits, message, &sigAlg, &sigBits))
}
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
if !ecdsaMetadataOk(&key, &message, &signature) { return 1 }
let alternate: [u8; 72] = [48, 70, 2, 33, 0, 191, 150, 185, 154, 164, 156, 112, 92, 145, 11, 227, 49, 66, 1, 124, 100, 47, 245, 64, 199, 99, 73, 185, 218, 183, 47, 152, 31, 217, 52, 127, 79, 2, 33, 0, 232, 58, 175, 105, 126, 111, 118, 62, 31, 196, 99, 43, 234, 84, 32, 237, 120, 152, 200, 125, 49, 62, 15, 83, 97, 174, 44, 179, 164, 118, 158, 53]
if !ecdsaOk(EcdsaP256Sha256.verify(&key, &message, &alternate)) { return 2 }
let badKey: [u8; 65] = [4, 135, 248, 242, 178, 24, 244, 152, 69, 246, 241, 14, 236, 56, 119, 19, 98, 105, 245, 193, 165, 71, 54, 219, 223, 105, 248, 153, 64, 202, 212, 21, 85, 225, 95, 54, 144, 54, 244, 152, 66, 250, 199, 168, 108, 138, 43, 5, 87, 96, 151, 118, 129, 68, 72, 184, 245, 232, 74, 169, 244, 57, 82, 5, 233]
let badMessage: [u8; 128] = [228, 121, 109, 181, 247, 133, 242, 7, 170, 48, 211, 17, 105, 59, 55, 2, 130, 29, 255, 17, 104, 253, 46, 4, 192, 131, 104, 37, 174, 253, 133, 13, 154, 166, 3, 38, 216, 140, 222, 26, 35, 199, 116, 83, 81, 57, 44, 162, 40, 141, 99, 44, 38, 79, 25, 125, 5, 205, 66, 74, 48, 51, 108, 25, 253, 9, 187, 34, 150, 84, 240, 34, 47, 203, 136, 26, 75, 53, 194, 144, 160, 147, 172, 21, 156, 225, 52, 9, 17, 31, 240, 53, 132, 17, 19, 60, 36, 245, 184, 226, 9, 13, 109, 182, 85, 138, 252, 54, 240, 108, 161, 246, 239, 119, 151, 133, 173, 186, 104, 219, 39, 164, 9, 133, 159, 196, 196, 160]
let badSignature: [u8; 72] = [48, 70, 2, 33, 0, 209, 159, 244, 139, 50, 73, 21, 87, 100, 22, 9, 125, 37, 68, 247, 203, 223, 135, 104, 177, 69, 74, 210, 14, 11, 170, 197, 14, 33, 31, 35, 176, 2, 33, 0, 163, 232, 30, 89, 49, 28, 223, 255, 45, 71, 132, 148, 159, 122, 44, 181, 11, 166, 195, 169, 31, 165, 71, 16, 86, 142, 97, 172, 163, 232, 71, 198]
if !ecdsaError(EcdsaP256Sha256.verify(&badKey, &badMessage, &badSignature), P256SignatureError.AuthenticationFailed) { return 3 }
let mut changedMessage = message
changedMessage[0] = 0
if !ecdsaError(EcdsaP256Sha256.verify(&key, &changedMessage, &signature), P256SignatureError.AuthenticationFailed) { return 4 }
let equationKey0: [u8; 65] = [4, 255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 188, 230, 250, 173, 167, 23, 158, 132, 243, 185, 202, 194, 252, 99, 37, 84, 72, 79, 12, 15, 218, 67, 78, 240, 168, 8, 69, 137, 20, 243, 40, 113, 93, 122, 84, 94, 25, 138, 199, 238, 227, 29, 255, 232, 97, 181, 210, 63]
let digest0: [u8; 32] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
let equationSignature0: [u8; 8] = [48, 6, 2, 1, 3, 2, 1, 3]
if !ecdsaOk(verifyPrehashed(&equationKey0, &digest0, &equationSignature0)) { return 5 }
let equationKey1: [u8; 65] = [4, 107, 23, 209, 242, 225, 44, 66, 71, 248, 188, 230, 229, 99, 164, 64, 242, 119, 3, 125, 129, 45, 235, 51, 160, 244, 161, 57, 69, 216, 152, 194, 150, 79, 227, 66, 226, 254, 26, 127, 155, 142, 231, 235, 74, 124, 15, 158, 22, 43, 206, 51, 87, 107, 49, 94, 206, 203, 182, 64, 104, 55, 191, 81, 245]
let digest1: [u8; 32] = [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 188, 230, 250, 173, 167, 23, 158, 132, 243, 185, 202, 194, 252, 99, 37, 80]
let equationSignature1: [u8; 8] = [48, 6, 2, 1, 1, 2, 1, 1]
if !ecdsaError(verifyPrehashed(&equationKey1, &digest1, &equationSignature1), P256SignatureError.AuthenticationFailed) { return 6 }
let empty: [u8; 0] = []
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &empty), P256SignatureError.InvalidEncoding) { return 10 }
let truncated: [u8; 70] = [48, 69, 2, 33, 0, 191, 150, 185, 154, 164, 156, 112, 92, 145, 11, 227, 49, 66, 1, 124, 100, 47, 245, 64, 199, 99, 73, 185, 218, 183, 47, 152, 31, 217, 52, 127, 79, 2, 32, 23, 197, 80, 149, 129, 144, 137, 194, 224, 59, 156, 212, 21, 171, 223, 18, 68, 78, 50, 48, 117, 217, 143, 49, 146, 11, 158, 15, 87, 236, 135]
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &truncated), P256SignatureError.InvalidEncoding) { return 11 }
let trailing: [u8; 72] = [48, 69, 2, 33, 0, 191, 150, 185, 154, 164, 156, 112, 92, 145, 11, 227, 49, 66, 1, 124, 100, 47, 245, 64, 199, 99, 73, 185, 218, 183, 47, 152, 31, 217, 52, 127, 79, 2, 32, 23, 197, 80, 149, 129, 144, 137, 194, 224, 59, 156, 212, 21, 171, 223, 18, 68, 78, 50, 48, 117, 217, 143, 49, 146, 11, 158, 15, 87, 236, 135, 28, 0]
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &trailing), P256SignatureError.InvalidEncoding) { return 12 }
let negative: [u8; 8] = [48, 6, 2, 1, 128, 2, 1, 1]
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &negative), P256SignatureError.InvalidEncoding) { return 13 }
let redundant: [u8; 9] = [48, 7, 2, 2, 0, 1, 2, 1, 1]
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &redundant), P256SignatureError.InvalidEncoding) { return 14 }
let indefinite: [u8; 10] = [48, 128, 2, 1, 1, 2, 1, 1, 0, 0]
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &indefinite), P256SignatureError.InvalidEncoding) { return 15 }
let overlongSequence: [u8; 9] = [48, 129, 6, 2, 1, 1, 2, 1, 1]
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &overlongSequence), P256SignatureError.InvalidEncoding) { return 16 }
let overlongInteger: [u8; 9] = [48, 7, 2, 129, 1, 1, 2, 1, 1]
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &overlongInteger), P256SignatureError.InvalidEncoding) { return 17 }
let zeroR: [u8; 8] = [48, 6, 2, 1, 0, 2, 1, 1]
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &zeroR), P256SignatureError.InvalidEncoding) { return 18 }
let zeroS: [u8; 8] = [48, 6, 2, 1, 1, 2, 1, 0]
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &zeroS), P256SignatureError.InvalidEncoding) { return 19 }
let orderR: [u8; 40] = [48, 38, 2, 33, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 188, 230, 250, 173, 167, 23, 158, 132, 243, 185, 202, 194, 252, 99, 37, 81, 2, 1, 1]
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &orderR), P256SignatureError.InvalidEncoding) { return 20 }
let orderS: [u8; 40] = [48, 38, 2, 1, 1, 2, 33, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 188, 230, 250, 173, 167, 23, 158, 132, 243, 185, 202, 194, 252, 99, 37, 81]
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &orderS), P256SignatureError.InvalidEncoding) { return 21 }
let emptyInteger: [u8; 8] = [48, 6, 2, 0, 2, 2, 0, 1]
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &emptyInteger), P256SignatureError.InvalidEncoding) { return 22 }
let extraInteger: [u8; 11] = [48, 9, 2, 1, 1, 2, 1, 1, 2, 1, 1]
if !ecdsaError(EcdsaP256Sha256.verify(&key, &message, &extraInteger), P256SignatureError.InvalidEncoding) { return 23 }
let emptyKey: [u8; 0] = []
if !ecdsaError(EcdsaP256Sha256.verify(&emptyKey, &message, &signature), P256SignatureError.InvalidKey) { return 30 }
let mut invalidKey = key
invalidKey[0] = 2
if !ecdsaError(EcdsaP256Sha256.verify(&invalidKey, &message, &signature), P256SignatureError.InvalidKey) { return 31 }
invalidKey = key
invalidKey[64] = 0
if !ecdsaError(EcdsaP256Sha256.verify(&invalidKey, &message, &signature), P256SignatureError.InvalidKey) { return 32 }
if !signatureMessageLengthAdmitted(2305843009213693951) || signatureMessageLengthAdmitted(2305843009213693952) || signatureMessageLengthAdmitted(18446744073709551615) { return 33 }
let ecOid: [u8; 7] = [42, 134, 72, 206, 61, 2, 1]
let sigOid: [u8; 8] = [42, 134, 72, 206, 61, 4, 3, 2]
let curve: [u8; 10] = [6, 8, 42, 134, 72, 206, 61, 3, 1, 7]
let null: [u8; 2] = [5, 0]
let explicit: [u8; 2] = [48, 0]
let emptyDer: [u8; 0] = []
let mut keyAlg = AlgorithmView {der: &emptyDer, oid: &ecOid, parametersDer: Option<&[u8]>.some(&curve)}
let mut sigAlg = AlgorithmView {der: &emptyDer, oid: &sigOid, parametersDer: Option<&[u8]>.none()}
let mut keyBits = BitStringView {bytes: &key, unusedBits: 0}
let mut sigBits = BitStringView {bytes: &emptyDer, unusedBits: 0}
if !ecdsaError(EcdsaP256Sha256.verifyCertificate(&keyAlg, &keyBits, &message, &sigAlg, &sigBits), P256SignatureError.InvalidEncoding) { return 40 }
sigAlg.parametersDer = Option<&[u8]>.some(&null)
if !ecdsaError(EcdsaP256Sha256.verifyCertificate(&keyAlg, &keyBits, &message, &sigAlg, &sigBits), P256SignatureError.InvalidParameters) { return 41 }
sigAlg.parametersDer = Option<&[u8]>.none()
keyAlg.parametersDer = Option<&[u8]>.none()
if !ecdsaError(EcdsaP256Sha256.verifyCertificate(&keyAlg, &keyBits, &message, &sigAlg, &sigBits), P256SignatureError.InvalidParameters) { return 43 }
keyAlg.parametersDer = Option<&[u8]>.some(&null)
if !ecdsaError(EcdsaP256Sha256.verifyCertificate(&keyAlg, &keyBits, &message, &sigAlg, &sigBits), P256SignatureError.InvalidParameters) { return 44 }
keyAlg.parametersDer = Option<&[u8]>.some(&explicit)
if !ecdsaError(EcdsaP256Sha256.verifyCertificate(&keyAlg, &keyBits, &message, &sigAlg, &sigBits), P256SignatureError.InvalidParameters) { return 45 }
let otherCurve: [u8; 10] = [6, 8, 42, 134, 72, 206, 61, 3, 1, 1]
keyAlg.parametersDer = Option<&[u8]>.some(&otherCurve)
if !ecdsaError(EcdsaP256Sha256.verifyCertificate(&keyAlg, &keyBits, &message, &sigAlg, &sigBits), P256SignatureError.InvalidParameters) { return 46 }
keyAlg.parametersDer = Option<&[u8]>.some(&curve)
keyBits.unusedBits = 1
if !ecdsaError(EcdsaP256Sha256.verifyCertificate(&keyAlg, &keyBits, &message, &sigAlg, &sigBits), P256SignatureError.InvalidParameters) { return 47 }
keyBits.unusedBits = 0
sigBits.unusedBits = 1
if !ecdsaError(EcdsaP256Sha256.verifyCertificate(&keyAlg, &keyBits, &message, &sigAlg, &sigBits), P256SignatureError.InvalidParameters) { return 48 }
sigBits.unusedBits = 0
let ecDh: [u8; 5] = [43, 129, 4, 1, 12]
let ecMqv: [u8; 5] = [43, 129, 4, 1, 13]
keyAlg.oid = &ecDh
if !ecdsaError(EcdsaP256Sha256.verifyCertificate(&keyAlg, &keyBits, &message, &sigAlg, &sigBits), P256SignatureError.UnsupportedAlgorithm) { return 49 }
keyAlg.oid = &ecMqv
if !ecdsaError(EcdsaP256Sha256.verifyCertificate(&keyAlg, &keyBits, &message, &sigAlg, &sigBits), P256SignatureError.UnsupportedAlgorithm) { return 50 }
keyAlg.oid = &ecOid
sigAlg.oid = &ecDh
if !ecdsaError(EcdsaP256Sha256.verifyCertificate(&keyAlg, &keyBits, &message, &sigAlg, &sigBits), P256SignatureError.UnsupportedAlgorithm) { return 51 }
return 42
}
`
