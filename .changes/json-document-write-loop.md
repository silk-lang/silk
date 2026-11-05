---
bump: patch
---

`JsonDocument.write` walks the document in one loop instead of one call for each value, and integers write 8 digits in one store, so writing citm_catalog.json is about 10% faster.
