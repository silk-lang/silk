---
bump: patch
---

Formatting an `f64` that is not a power of two uses Dragonbox, about 20% faster, JSON strings are written 8 bytes at a time, and runs of whitespace are skipped 16 bytes at a time from the first byte, so writing canada.json is about 15% faster and `JsonDocument.parse` of citm_catalog.json about 10% faster.
