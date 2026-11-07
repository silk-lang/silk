---
bump: patch
---

`AesGcm` and `AesGcmKey` on x86-64 hash the last one to eight blocks of each input with one reduction, and encrypt a partial final block with one vector XOR, which makes short TLS records cheaper.
