---
bump: minor
---

Add `RsaPrivateKey.signPkcs1Raw` and `RsaPublicKey.recoverPkcs1Raw` for PKCS #1 v1.5 type 1 signatures over raw bytes, as `crypto.privateEncrypt` and `crypto.publicDecrypt` use.
