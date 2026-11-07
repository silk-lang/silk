---
bump: patch
---

`HashMap` picks a key's home bucket with a mask instead of a division. Table widths are powers of two, so the bucket is the same.
