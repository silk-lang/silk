---
bump: minor
---

`silk.crypto.rsa` now signs, encrypts, and generates keys. `RsaPrivateKey` loads from its PKCS #1 parts or generates with `RsaPrivateKey.generate`, signs with PKCS #1 v1.5 and PSS, and decrypts OAEP and raw RSA, with CRT and a check of each result. `RsaPublicKey` verifies PKCS #1 v1.5 and PSS for any `Digest`, with a fixed or any PSS salt, and encrypts with OAEP, PKCS #1 v1.5, or raw RSA. Keys now have 512 to 8192 bits and any odd exponent from 3; `fromCertificateKey` keeps the 2048 to 4096-bit, exponent 65537 profile. `verifyPss` now takes the digest, the hash as a type argument, and the salt length. `RsaError` adds `KeyTooSmall` and `InvalidCiphertext`.
