---
bump: patch
---

`AesGcm.seal` and `AesGcm.open` use the AES and PMULL instructions on AArch64 machines that have them, and `Sha256` and `Sha224` use the SHA2 instructions.
