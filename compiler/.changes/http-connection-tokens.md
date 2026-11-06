---
bump: patch
---

The HTTP exchange reads `Connection` options in the framing scan instead of walking the fields again, and checks `Trailer` exclusions only when a head has a `Trailer` field.
