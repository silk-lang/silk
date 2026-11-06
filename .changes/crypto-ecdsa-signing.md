---
bump: minor
---

Sign with ECDSA in `silk.crypto.p256` and `silk.crypto.p384`. `P256.sign<H>` and `P384.sign<H>` take any `Digest` and use the deterministic nonce of RFC 6979. The new `EcdsaP256` and `EcdsaP384` verify with any hash and convert signatures between DER and the fixed `r` and `s` form. `silk.crypto.p384` gains `P384` for key agreement, and both curves can compress and decompress public keys.
