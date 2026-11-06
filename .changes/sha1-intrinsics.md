---
bump: minor
---

Add the x86 SHA-1 instructions as architecture operations (`Intrinsic.x86Sha1Rounds4Stage0` to `Stage3`, `x86Sha1NextE`, `x86Sha1Message1`, `x86Sha1Message2`), their `silk.simd.x86` wrappers, and a SHA-1 path that uses them. The portable SHA-1 is unrolled and hashes whole blocks straight from the input.
