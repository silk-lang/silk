---
bump: minor
---

`silk.crypto.rsa` reads and writes keys as DER: `RsaPublicKey.fromPkcs1Der`, `fromSpkiDer`, `writePkcs1Der` and `writeSpkiDer`, and `RsaPrivateKey.fromPkcs1Der`, `fromPkcs8Der`, `writePkcs1Der` and `writePkcs8Der`, each with a matching length function. `RsaPrivateKey.decryptPkcs1` decrypts PKCS #1 v1.5 with implicit rejection, matching OpenSSL 3.2 and later.
