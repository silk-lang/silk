---
bump: minor
---

Add dotted tuple literals: `.(a)` is a one-element tuple without a trailing comma, as in `Format.format("{}", &.(count))`, and `.(a, b)` and `.()` work too.
