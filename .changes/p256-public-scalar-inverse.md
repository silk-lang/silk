---
bump: patch
---

TLS handshakes spend about 16% fewer instructions on key exchange and signature checks. ECDSA P-256 verification inverts the public signature scalar with a binary extended Euclid step instead of an exponentiation. P-256 field subtraction now compiles to a `sbb` borrow chain. On x86-64 CPUs with BMI2, P-256 verification and the X25519 ladder and fixed-base multiplication run copies compiled with `mulx`, chosen at run time.
