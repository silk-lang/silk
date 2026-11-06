---
bump: minor
---

Add RSA-PSS keys to `silk.crypto.rsa`: `RsaPssPublicKey` and `RsaPssPrivateKey` read and write the `id-RSASSA-PSS` SubjectPublicKeyInfo and PKCS #8 forms that OpenSSL writes for an `rsa-pss` key, with the hash, MGF1 hash, and salt length of the key in `RsaPssRestrictions`.
