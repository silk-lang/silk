---
bump: patch
---

`AesGcmEncryptor` and `AesGcmDecryptor` use AES-NI and PCLMULQDQ (x86-64) or the AES and PMULL instructions (AArch64) when the machine has them.
