---
bump: patch
---

A `match` or `if` writes the `let` binding it initializes directly, and a binding taken out of a temporary that is dead afterwards, such as the value of an unwrapped `Result`, keeps that storage instead of a copy.
