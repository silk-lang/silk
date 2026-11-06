---
bump: patch
---

`Sha256` and `Sha224` use SHA-NI when the x86-64 machine has it, even when the build does not select it.
