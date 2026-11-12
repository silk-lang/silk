---
bump: patch
---

Fix SEM0053 for mutually recursive types, such as `Tree` and `Branch` with `Schema`: a call back to an application still active on the path reuses it.
