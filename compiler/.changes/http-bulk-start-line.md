---
bump: patch
---

The HTTP head parser checks a status line prefix, a reason phrase and a request target in one pass instead of one call per byte.
