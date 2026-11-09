---
bump: minor
---

`Regex.typed<T>` checks a pattern against a capture struct at compile time: every named group is a field, `Option` exactly where a group can be unset, and `Matcher.find` and `Matcher.whole` return the struct with fields borrowing the text. `Match.named` reads a group by name.
