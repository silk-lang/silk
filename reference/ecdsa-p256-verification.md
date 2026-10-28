# ECDSA P-256/SHA-256 verification

Import `EcdsaP256Sha256` and `P256SignatureError` from `silk.crypto.p256`.
`EcdsaP256Sha256.verify(publicKey, message, signature)` borrows three byte slices and returns
`Result<(), P256SignatureError>`. It hashes the message exactly once with SHA-256; the input is a
message, not a precomputed digest. Message byte lengths above 2^61−1 fail before hashing.
There is no public prehashed verifier, signing operation, entropy requirement or allocation.

The public key must contain exactly 65 bytes in uncompressed SEC1 form: `0x04 || x || y`.
Coordinates must be canonical field elements and satisfy the P-256 curve equation. Compressed,
hybrid, infinity and off-curve encodings fail. Key admission shares the private validator used by
[P-256 key agreement](p256-key-agreement.md).

The signature must be exactly one DER SEQUENCE containing two minimally encoded positive INTEGERs,
r and s, each in 1 through n−1. A leading zero is admitted only when needed to keep an INTEGER
positive. Negative integers, redundant sign padding, zero, values at least n, indefinite or overlong
lengths, truncation and trailing bytes fail. Both high-s and low-s signatures are valid; verification
does not impose signature normalization.

The verification equation accepts a reduced digest of zero and zero scalar terms, rejects a final
point at infinity, and compares r against the affine x-coordinate reduced modulo n.

## Retained certificate metadata

`verifyCertificate(keyAlgorithm, publicKey, message, signatureAlgorithm, signature)` borrows
`AlgorithmView` and `BitStringView` values from `silk.tls.certificate`. It does not require a Certificate
handle or parse another ASN.1 container. The views' retained OID contents, parameter DER and bit
string contents are the metadata inputs; their `der` fields are not reparsed.

The key algorithm must be id-ecPublicKey (1.2.840.10045.2.1), with parameters containing exactly the
DER OID for named secp256r1 (1.2.840.10045.3.1.7). Absent, implicit or explicit curve parameters,
other curves, id-ecDH and id-ecMQV are rejected. The signature algorithm must be
ecdsa-with-SHA256 (1.2.840.10045.4.3.2), with absent parameters; NULL is rejected. Both key and
signature bit strings must have zero unused bits. This follows the selected parameter policy from
[RFC 5480](https://www.rfc-editor.org/rfc/rfc5480.html#section-2.1) and
[RFC 5758](https://www.rfc-editor.org/rfc/rfc5758.html#section-3.2).

The caller chooses the signed message and is responsible for certificate algorithm consistency,
trust paths, identity, validity periods and key usage. The adapter provides cryptographic
verification and parameter admission only.

## Failures and assurance

`InvalidLength` rejects an oversized message; `InvalidKey` rejects SEC1 admission;
`InvalidEncoding` rejects DER or signature scalar admission; and `AuthenticationFailed` rejects
an admitted signature that does not satisfy the equation. The metadata adapter additionally returns
`UnsupportedAlgorithm` or `InvalidParameters`. The adapter checks algorithms and parameters before
calling the message verifier; that verifier checks message length, hashes, admits the key, then
admits the signature. Errors contain no input bytes. Borrowed inputs are never consumed or modified,
and the result retains no input loan.

All arithmetic uses ordinary Silk source with bounded inline storage at the P-256 owner.
Verification works on public data and makes no fixed-work promise. Existing secret agreement
arithmetic keeps its stronger fixed-schedule requirement. Native and LLVM-to-Wasm witnesses, pinned
NIST vectors, Zig reproduction and precise generated-output inspection scope are recorded in the
implementation evidence.
Passing vectors do not establish constant time, physical erasure, production security or FIPS
validation.
