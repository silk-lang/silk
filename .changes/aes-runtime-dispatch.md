---
bump: minor
---

`silk.crypto.aes` checks for AES-NI at run time on x86-64, so a default build encrypts with the AES instructions when the machine has them. CBC decryption, ECB and CTR run eight blocks at a time, and CBC encryption, CFB and OFB take whole blocks without the per-byte loop. The streaming `AesGcmEncryptor` and `AesGcmDecryptor` use AES-NI and PCLMULQDQ at run time too, with GHASH over eight blocks per reduction.
