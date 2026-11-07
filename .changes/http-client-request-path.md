---
bump: patch
---

The native HTTP client builds the HTTPS trust provider once per worker instead of once per request, `Path` joins copy each byte range with one append, and URI validation classifies characters with a table.
