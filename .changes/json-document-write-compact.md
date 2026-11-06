---
bump: patch
---

`JsonDocument.write` with no indentation copies strings parsed without escapes straight to the output, and `JsonDocument.parse` reads short numbers in place, so writing twitter.json and citm_catalog.json takes about half the time.
