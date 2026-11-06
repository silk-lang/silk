---
bump: patch
---

X25519 inlines its field multiply and square (about a quarter faster), and P-256 base point multiples scan each table window through one bounds check.
