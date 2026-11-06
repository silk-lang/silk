---
bump: minor
---

Make `silk.crypto.scrypt` faster with a vector Salsa20/8 core and an in-place ROMix, and add `Scrypt.deriveWithScratch` and `Scrypt.scratchLength` so that repeated calls can reuse one buffer instead of allocating. `ScryptError` gains `ScratchTooSmall`.
