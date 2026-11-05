---
bump: patch
---

JSON strings with runs of non-ASCII text and `Format.f64FromDecimal` are faster, so `Json.parse` is about 10% faster on canada.json and twitter.json. `Format.f64FromDecimal` no longer returns a subnormal for a 20-digit significand times 10^-343, which is 0.
