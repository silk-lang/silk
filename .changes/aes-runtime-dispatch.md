---
bump: minor
---

`silk.crypto.aes` checks for AES-NI at run time on x86-64, so a default build encrypts with the AES instructions when the machine has them. CBC decryption, ECB and CTR run eight blocks at a time, and CBC encryption, CFB and OFB take whole blocks without the per-byte loop. The streaming `AesGcmEncryptor` and `AesGcmDecryptor` use AES-NI and PCLMULQDQ at run time too, with GHASH over eight blocks per reduction.

`AesGcm.seal` and `AesGcm.open` now take any nonzero nonce length (hashed into the first counter block, as the streaming types already did) and the truncated tag lengths 4, 8 and 12 to 15 bytes; `open` compares the given prefix in constant time.
