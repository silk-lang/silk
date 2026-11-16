---
bump: patch
---

Each arm of an `if` or `match` writes the value of the whole expression in place, and a large `let` binding of it, instead of copying it at every level.
