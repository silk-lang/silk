---
bump: patch
---

`sendAll` in the native HTTP client works out its trust configuration once per round, and each worker copies it once, instead of every queued request copying the trust bundle path.
