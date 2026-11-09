---
bump: patch
---

A method call on a constant, as in `LIMITS.span()`, calls the method on the constant's value instead of failing with SEM0075, also with written type arguments as in `LIMITS.echo<i32>(1)`, and an unknown method reports SEM0010 on the member. A constant named through its module, as in `limits.WINDOW()`, is still not callable.
