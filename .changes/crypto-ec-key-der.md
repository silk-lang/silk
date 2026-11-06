---
bump: minor
---

Add `silk.crypto.ec_key`, which reads and writes P-256 and P-384 keys as SEC1, PKCS #8 and SubjectPublicKeyInfo DER, with the same bytes as OpenSSL. The readers name the curve, so a key file can be loaded without knowing its curve first.
