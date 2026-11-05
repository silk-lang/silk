---
bump: patch
---

Add `Format.writeF64Debug`, `Format.writeI64Display` and `Format.writeU64Display`, which write a number into a byte buffer. `Json.write` uses them and copies plain strings 16 bytes at a time (canada.json write 29% faster).
