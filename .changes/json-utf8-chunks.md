---
bump: patch
---

JSON strings check UTF-8 16 bytes at a time, so parsing twitter.json is about 10% faster.
