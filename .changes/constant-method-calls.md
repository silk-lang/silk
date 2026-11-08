---
bump: patch
---

A method call on a constant, as in `LIMITS.span()`, calls the method on the constant's value instead of failing with SEM0075, and an unknown method reports SEM0010 on the member.
