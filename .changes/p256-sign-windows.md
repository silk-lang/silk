---
bump: patch
---

ECDSA P-256 signing is about 17% faster. The base point multiplication reads 52 signed 5-bit windows with a complete mixed addition, instead of 64 unsigned 4-bit windows with a full projective addition. Scalar arithmetic modulo the curve order uses an unrolled Montgomery multiplication and squaring, which also speeds up the scalar inversion in verification.
