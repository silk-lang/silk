---
bump: patch
---

`AesGcm.seal` and `AesGcm.open` use AES-NI and PCLMULQDQ when the x86-64 machine has them, even when the build does not select them.
