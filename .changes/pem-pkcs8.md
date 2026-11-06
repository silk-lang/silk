---
bump: minor
---

Add `silk.encoding.pem` to find, decode, and encode PEM blocks (RFC 7468, with RFC 1421 headers), and `silk.crypto.pkcs8` to encrypt and decrypt PKCS #8 private keys with PBES2 (PBKDF2 with HMAC-SHA-1 or SHA-2, and AES-CBC or Triple DES CBC). Add `silk.crypto.legacy_pem` for PKCS #1 and SEC1 keys encrypted with the `Proc-Type` and `DEK-Info` headers.
