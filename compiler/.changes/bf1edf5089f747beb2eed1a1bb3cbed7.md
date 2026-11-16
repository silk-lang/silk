---
bump: patch
---

A method call's written type argument may elide lifetimes, as in `r.pick<Engine<i32>>(e)`, as a function call's already could.
