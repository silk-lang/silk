---
bump: patch
---

`JsonDocument.parse` uses AVX2 when the machine has it: UTF-8 is checked 64 bytes at a time first, then strings are copied 32 bytes at a time, so twitter.json parses about 25% faster.
