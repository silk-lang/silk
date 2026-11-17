---
bump: minor
---

`Schema.write` takes `&mut any SchemaWriter` so JSON, TOML, YAML and MessagePack share each encoder without a hand-written writer union.
