# P-256 key agreement

`silk.crypto.p256 { P256, P256Error }` owns bounded secp256r1 arithmetic and an ephemeral scalar.
`P256.fromBytes(bytes)` admits exactly 32 big-endian bytes representing an integer in 1 through
n−1. The returned scalar has private storage and does not implement `Copy`. `publicKey()` borrows
it and returns 65 bytes: `0x04 || x || y`, with two 32-byte big-endian coordinates.

`agree(peer)` consumes the scalar on success and failure. The peer must have exactly 65 bytes,
prefix `0x04`, canonical coordinates below the field prime, and satisfy the P-256 curve equation.
Compressed, hybrid, infinity and off-curve encodings are rejected. P-256 has cofactor one, so a
validated non-infinite curve point lies in its prime-order group. Success returns exactly 32 bytes
of the shared x-coordinate, retaining leading zero bytes; failure returns no shared bytes.

Errors distinguish `InvalidLength`, `InvalidScalar`, `InvalidEncoding`, and `InvalidPoint`.
Length is checked before indexing; the prefix is checked before coordinates. Field-range checks
precede the curve equation. Failures contain no scalar, point or partial shared-secret bytes.

## Generation and availability

`P256.generate()` requires exclusive `Random`. Each attempt obtains a fresh 32-byte draw and
rejects zero and values at least n. Each call acquires fresh entropy; independent draws may still
coincide. This rejection sampling is unbiased and has probabilistic running time. A provider's
fatal failure remains fatal. There is no implicit entropy provider or insecure fallback.

All deterministic operations use fixed inline storage, with no allocator or host requirement.
Native execution is witnessed on Darwin ARM64 and portable execution through LLVM-to-Wasm wasm32.
GNU/Linux source selection is checked separately; executing those artifacts requires the matching
runner. WebAssembly production generation requires a separately admitted host entropy provider.
Other targets require explicit validation. The current native entropy contract is documented in
[Native entropy](native-entropy.md).

## Secret processing

The private field has eight 32-bit limbs. Products use 64-bit words and Montgomery reduction;
Complete projective point operations use fixed loops and mask selection. Secret multiplication scans all
256 scalar bits, performs doubling and addition each iteration, and selects the result by a mask.
Inversion uses the fixed public exponent p−2. Field operations use wrapping arithmetic where the
bounded mathematical result fits, avoiding secret-dependent overflow checks. Point admission and
scalar admission have data-dependent rejection branches; scalar admission and generation occur
before secret multiplication.

The generated-code inspection and its exact target/mode limits live in the
implementation evidence.
A fixed source schedule and passing vectors do not establish constant time, secure erasure,
production security or FIPS validation. Compiler transformations and host/JIT behavior need their
own review. Owning and consuming a scalar bounds use, not physical retention of compiler copies.
A shared secret does not authenticate a peer; key derivation and protocol authentication remain
separate operations. This actor provides no signing, certificates, trust policy or TLS handshake.

## Known-answer evidence

The shared native corpus checks RFC 5903 §8.1 in both directions, NIST ECCCDH P-256 COUNT0,
scalar1/n−1, a leading-zero x-coordinate, admission errors, and scripted rejection generation.
The RFC's IKE x||y values receive an explicit SEC1 `0x04` prefix; IKE payload framing is excluded.
The fixture manifest
pins inputs, expected bytes, archive/member checksums, exact Zig source hashes and reproduction.
These informal component vectors do not constitute CAVP validation.
