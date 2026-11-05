---
bump: patch
---

Formatting an `f64` that is not a power of two uses Dragonbox, about 20% faster, and JSON strings are written 8 bytes at a time, so writing canada.json is about 15% faster.
