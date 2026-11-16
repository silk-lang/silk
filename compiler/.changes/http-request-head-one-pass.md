---
bump: patch
---

`silk.http.head.writeRequestWith` writes a request head from its parts in one pass, and request preparation uses it instead of building a field list and checking the `Host` field again.
